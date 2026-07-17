import { Router, type IRouter } from "express";
import { db, customersTable, branchesTable, tokensTable, loansTable, collectionsTable } from "@workspace/db";
import { committeesTable, committeeMembersTable, giftDistributionsTable, giftInventoryTable, interestAccountsTable, recoveryTasksTable } from "@workspace/db";
import { eq, and, ilike, or, sql, count } from "drizzle-orm";
import { asyncHandler } from "../middleware/errors";
import { parseIntStrict, ValidationError, NotFoundError, DatabaseError } from "../utils/errors";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// =============================================================================
// Utilities
// =============================================================================

async function getNextRef(): Promise<string> {
  try {
    const [row] = await db.select({ max: sql<number>`coalesce(max(id),0)` }).from(customersTable);
    const n = (row?.max ?? 0) + 1;
    return `REF${String(n).padStart(6, "0")}`;
  } catch (err) {
    logger.error(err, "Failed to generate next reference");
    throw new DatabaseError("Failed to generate reference number");
  }
}

// =============================================================================
// GET /customers — List with pagination and filtering
// =============================================================================
router.get(
  "/customers",
  asyncHandler(async (req, res): Promise<void> => {
    const { search, branchId, status, page = "1", limit = "20" } = req.query;

    // Parse pagination
    let pageNum = parseInt(page as string, 10);
    if (isNaN(pageNum) || pageNum <= 0) pageNum = 1;
    let limitNum = parseInt(limit as string, 10);
    if (isNaN(limitNum) || limitNum <= 0) limitNum = 20;
    limitNum = Math.min(limitNum, 100); // Cap at 100 per page

    const offset = (pageNum - 1) * limitNum;

    // Build conditions
    const conditions = [];
    if (branchId) {
      conditions.push(eq(customersTable.branchId, parseIntStrict(branchId, "branchId")));
    }
    if (status) {
      conditions.push(eq(customersTable.status, status as any));
    }
    if (search && typeof search === "string" && search.trim()) {
      const searchTerm = search.trim();
      conditions.push(
        or(
          ilike(customersTable.name, `%${searchTerm}%`),
          ilike(customersTable.mobile, `%${searchTerm}%`),
          ilike(customersTable.referenceNumber, `%${searchTerm}%`),
          ilike(customersTable.referenceName, `%${searchTerm}%`)
        )!
      );
    }

    // Build queries
    let customerQuery = db
      .select({
        id: customersTable.id,
        name: customersTable.name,
        mobile: customersTable.mobile,
        email: customersTable.email,
        status: customersTable.status,
        referenceNumber: customersTable.referenceNumber,
        referenceName: customersTable.referenceName,
        branchId: customersTable.branchId,
        branchName: branchesTable.name,
        createdAt: customersTable.createdAt,
      })
      .from(customersTable)
      .leftJoin(branchesTable, eq(customersTable.branchId, branchesTable.id))
      .$dynamic();

    let countQuery = db
      .select({ total: sql<number>`count(*)::int` })
      .from(customersTable)
      .$dynamic();

    if (conditions.length > 0) {
      const whereClause = and(...conditions);
      customerQuery = (customerQuery as any).where(whereClause);
      countQuery = (countQuery as any).where(whereClause);
    }

    // Execute queries in parallel
    const [allRows, [countResult]] = await Promise.all([
      (customerQuery as any).orderBy(customersTable.createdAt).offset(offset).limit(limitNum),
      countQuery,
    ]);

    const total = countResult?.total ?? 0;

    // Get aggregated stats
    const stats = await db
      .select({
        customerId: customersTable.id,
        tokenCount: sql<number>`count(distinct case when ${tokensTable.customerId} is not null then ${tokensTable.id} end)::int`,
        loanCount: sql<number>`count(distinct case when ${loansTable.customerId} is not null then ${loansTable.id} end)::int`,
        totalPaid: sql<string>`coalesce(sum(case when ${collectionsTable.customerId} is not null then ${collectionsTable.amount}::numeric else 0 end), 0)`,
      })
      .from(customersTable)
      .leftJoin(tokensTable, eq(customersTable.id, tokensTable.customerId))
      .leftJoin(loansTable, eq(customersTable.id, loansTable.customerId))
      .leftJoin(collectionsTable, eq(customersTable.id, collectionsTable.customerId))
      .where(and(...(conditions.length > 0 ? conditions : [sql`true`])))
      .groupBy(customersTable.id);

    const statsMap = new Map(stats.map((s) => [s.customerId, s]));

    const data = allRows.map((row: any) => {
      const stat = statsMap.get(row.id) || { tokenCount: 0, loanCount: 0, totalPaid: "0" };
      return {
        ...row,
        totalTokens: stat.tokenCount ?? 0,
        totalLoans: stat.loanCount ?? 0,
        totalPaid: parseFloat(stat.totalPaid ?? "0"),
        createdAt: row.createdAt.toISOString(),
      };
    });

    res.json({ data, total, page: pageNum, limit: limitNum });
  })
);

// =============================================================================
// POST /customers — Create new customer
// =============================================================================
router.post(
  "/customers",
  asyncHandler(async (req, res): Promise<void> => {
    const {
      name,
      mobile,
      alternateMobile,
      email,
      aadhaar,
      pan,
      address,
      city,
      nomineeName,
      nomineeRelation,
      branchId,
      status,
      photoUrl,
      referenceName,
      recoveryNotes,
      documents,
    } = req.body;

    // Validation
    if (!name?.trim() || !mobile?.trim() || !branchId) {
      throw new ValidationError("name, mobile, and branchId are required");
    }

    const parsedBranchId = parseIntStrict(branchId, "branchId");

    const referenceNumber = await getNextRef();
    const [customer] = await db
      .insert(customersTable)
      .values({
        name: name.trim(),
        mobile: mobile.trim(),
        alternateMobile: alternateMobile?.trim() || null,
        email: email?.trim() || null,
        aadhaar: aadhaar?.trim() || null,
        pan: pan?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        nomineeName: nomineeName?.trim() || null,
        nomineeRelation: nomineeRelation?.trim() || null,
        branchId: parsedBranchId,
        status: status ?? "active",
        referenceNumber,
        photoUrl: photoUrl?.trim() || null,
        referenceName: referenceName?.trim() || null,
        recoveryNotes: recoveryNotes?.trim() || null,
        documents: documents || null,
      })
      .returning();

    if (!customer) {
      throw new DatabaseError("Failed to create customer");
    }

    res.status(201).json({
      ...customer,
      totalTokens: 0,
      totalLoans: 0,
      totalPaid: 0,
      createdAt: customer.createdAt.toISOString(),
    });
  })
);

// =============================================================================
// GET /customers/:id — Get single customer with all related data
// =============================================================================
router.get(
  "/customers/:id",
  asyncHandler(async (req, res): Promise<void> => {
    const id = parseIntStrict(req.params.id, "Customer ID");

    const [row] = await db
      .select({ c: customersTable, branchName: branchesTable.name })
      .from(customersTable)
      .leftJoin(branchesTable, eq(customersTable.branchId, branchesTable.id))
      .where(eq(customersTable.id, id));

    if (!row) {
      throw new NotFoundError("Customer");
    }

    // Fetch all related data in parallel
    const [tokCount, lnCount, paid, giftCount, interestAcc, recoveryCount, memberships] = await Promise.all([
      db.select({ c: sql<number>`count(*)::int` }).from(tokensTable).where(eq(tokensTable.customerId, id)),
      db.select({ c: sql<number>`count(*)::int` }).from(loansTable).where(eq(loansTable.customerId, id)),
      db.select({ sum: sql<string>`coalesce(sum(amount),0)` }).from(collectionsTable).where(eq(collectionsTable.customerId, id)),
      db.select({ c: sql<number>`count(*)::int` }).from(giftDistributionsTable).where(eq(giftDistributionsTable.customerId, id)),
      db.select().from(interestAccountsTable).where(eq(interestAccountsTable.customerId, id)).limit(1),
      db.select({ c: sql<number>`count(*)::int` }).from(recoveryTasksTable).where(and(eq(recoveryTasksTable.customerId, id), eq(recoveryTasksTable.status, "pending"))),
      db
        .select({ cm: committeeMembersTable, commName: committeesTable.name, commType: committeesTable.type })
        .from(committeeMembersTable)
        .leftJoin(committeesTable, eq(committeeMembersTable.committeeId, committeesTable.id))
        .where(eq(committeeMembersTable.customerId, id)),
    ]);

    // Group memberships by committee
    const committeeSummary = Object.values(
      memberships.reduce((acc, m) => {
        const key = m.cm.committeeId;
        if (!acc[key]) {
          acc[key] = { committeeId: key, committeeName: m.commName ?? "", type: m.commType ?? "", tokens: [] };
        }
        acc[key].tokens.push(m.cm.tokenNumber);
        return acc;
      }, {} as Record<number, { committeeId: number; committeeName: string; type: string; tokens: string[] }>)
    );

    res.json({
      ...row.c,
      branchName: row.branchName,
      totalTokens: tokCount[0]?.c ?? 0,
      totalLoans: lnCount[0]?.c ?? 0,
      totalPaid: parseFloat(paid[0]?.sum ?? "0"),
      totalGifts: giftCount[0]?.c ?? 0,
      pendingRecovery: recoveryCount[0]?.c ?? 0,
      hasInterestAccount: interestAcc.length > 0,
      interestMonthly: interestAcc[0] ? parseFloat(interestAcc[0].monthlyInterest ?? "0") : 0,
      committeeMemberships: committeeSummary,
      createdAt: row.c.createdAt.toISOString(),
    });
  })
);

// =============================================================================
// PATCH /customers/:id — Update customer
// =============================================================================
router.patch(
  "/customers/:id",
  asyncHandler(async (req, res): Promise<void> => {
    const id = parseIntStrict(req.params.id, "Customer ID");
    const {
      name,
      mobile,
      alternateMobile,
      email,
      aadhaar,
      pan,
      address,
      city,
      nomineeName,
      nomineeRelation,
      branchId,
      status,
      photoUrl,
      referenceName,
      recoveryNotes,
      documents,
    } = req.body;

    // Validation
    if (!name?.trim() || !mobile?.trim()) {
      throw new ValidationError("name and mobile are required");
    }

    const [customer] = await db
      .update(customersTable)
      .set({
        name: name.trim(),
        mobile: mobile.trim(),
        alternateMobile: alternateMobile?.trim() || null,
        email: email?.trim() || null,
        aadhaar: aadhaar?.trim() || null,
        pan: pan?.trim() || null,
        address: address?.trim() || null,
        city: city?.trim() || null,
        nomineeName: nomineeName?.trim() || null,
        nomineeRelation: nomineeRelation?.trim() || null,
        branchId: branchId ? parseIntStrict(branchId, "branchId") : undefined,
        status,
        photoUrl: photoUrl?.trim() || null,
        referenceName: referenceName?.trim() || null,
        recoveryNotes: recoveryNotes?.trim() || null,
        documents,
      })
      .where(eq(customersTable.id, id))
      .returning();

    if (!customer) {
      throw new NotFoundError("Customer");
    }

    res.json({
      ...customer,
      totalTokens: 0,
      totalLoans: 0,
      totalPaid: 0,
      createdAt: customer.createdAt.toISOString(),
    });
  })
);

// =============================================================================
// DELETE /customers/:id — Delete customer
// =============================================================================
router.delete(
  "/customers/:id",
  asyncHandler(async (req, res): Promise<void> => {
    const id = parseIntStrict(req.params.id, "Customer ID");
    await db.delete(customersTable).where(eq(customersTable.id, id));
    res.sendStatus(204);
  })
);

// =============================================================================
// GET /customers/:id/history — Full customer history with all related data
// =============================================================================
router.get(
  "/customers/:id/history",
  asyncHandler(async (req, res): Promise<void> => {
    const id = parseIntStrict(req.params.id, "Customer ID");

    // Get customer
    const [row] = await db
      .select({ c: customersTable, branchName: branchesTable.name })
      .from(customersTable)
      .leftJoin(branchesTable, eq(customersTable.branchId, branchesTable.id))
      .where(eq(customersTable.id, id));

    if (!row) {
      throw new NotFoundError("Customer");
    }

    // Fetch all related data in parallel
    const [membershipRows, tokenRows, collectionRows, loanRows, giftRows, interestRows, recoveryRows] = await Promise.all([
      db
        .select({ cm: committeeMembersTable, commName: committeesTable.name, commType: committeesTable.type, installment: committeesTable.installmentAmount })
        .from(committeeMembersTable)
        .leftJoin(committeesTable, eq(committeeMembersTable.committeeId, committeesTable.id))
        .where(eq(committeeMembersTable.customerId, id)),
      db
        .select({ t: tokensTable, commName: committeesTable.name })
        .from(tokensTable)
        .leftJoin(committeesTable, eq(tokensTable.committeeId, committeesTable.id))
        .where(eq(tokensTable.customerId, id)),
      db
        .select()
        .from(collectionsTable)
        .where(eq(collectionsTable.customerId, id))
        .orderBy(sql`collected_at DESC`)
        .limit(200),
      db.select().from(loansTable).where(eq(loansTable.customerId, id)),
      db
        .select({ gd: giftDistributionsTable, giftName: giftInventoryTable.name })
        .from(giftDistributionsTable)
        .leftJoin(giftInventoryTable, eq(giftDistributionsTable.giftId, giftInventoryTable.id))
        .where(eq(giftDistributionsTable.customerId, id))
        .orderBy(sql`distribution_date DESC`),
      db.select().from(interestAccountsTable).where(eq(interestAccountsTable.customerId, id)),
      db.select().from(recoveryTasksTable).where(eq(recoveryTasksTable.customerId, id)),
    ]);

    // Process memberships
    const memberships = Object.values(
      membershipRows.reduce((acc, m) => {
        const key = m.cm.committeeId;
        if (!acc[key])
          acc[key] = {
            committeeId: key,
            committeeName: m.commName ?? "",
            type: m.commType ?? "",
            installment: m.installment ? parseFloat(m.installment) : 0,
            tokens: [],
          };
        acc[key].tokens.push(m.cm.tokenNumber);
        return acc;
      }, {} as Record<number, any>)
    );

    // Process tokens
    const tokens = tokenRows.map((t) => ({
      id: t.t.id,
      tokenNumber: t.t.tokenNumber,
      committeeName: t.commName ?? "",
      status: t.t.status,
    }));

    // Process collections
    const collections = collectionRows.map((c) => ({
      id: c.id,
      amount: parseFloat(c.amount),
      paymentMode: c.paymentMode,
      date: c.collectedAt.toISOString(),
      notes: c.notes,
      committeeId: c.committeeId,
    }));

    // Summary stats
    const totalPaid = collectionRows.reduce((s, c) => s + parseFloat(c.amount), 0);
    const totalLoanAmount = loanRows.reduce((s, l) => s + parseFloat(l.principalAmount), 0);
    const totalLoanPaid = loanRows.reduce((s, l) => s + parseFloat(l.paidAmount), 0);

    res.json({
      customer: {
        ...row.c,
        branchName: row.branchName,
        createdAt: row.c.createdAt.toISOString(),
      },
      summary: {
        totalPaid,
        totalCollections: collectionRows.length,
        totalTokens: tokenRows.length,
        totalLoans: loanRows.length,
        totalLoanAmount,
        totalLoanPaid,
        totalGifts: giftRows.length,
        totalInterestAccounts: interestRows.length,
        totalRecoveryTasks: recoveryRows.length,
        committeesJoined: memberships.length,
      },
      memberships,
      tokens,
      collections,
      loans: loanRows.map((l) => ({
        ...l,
        principalAmount: parseFloat(l.principalAmount),
        interestRate: parseFloat(l.interestRate),
        paidAmount: parseFloat(l.paidAmount),
        emiAmount: l.emiAmount ? parseFloat(l.emiAmount) : null,
        totalAmount: l.totalAmount ? parseFloat(l.totalAmount) : null,
        createdAt: l.createdAt.toISOString(),
      })),
      gifts: giftRows.map((g) => ({
        id: g.gd.id,
        giftName: g.giftName ?? "Item",
        quantity: g.gd.quantity,
        date: g.gd.distributionDate,
        status: g.gd.status,
      })),
      interestAccounts: interestRows.map((a) => ({
        ...a,
        principalAmount: parseFloat(a.principalAmount),
        interestRate: parseFloat(a.interestRate),
        monthlyInterest: parseFloat(a.monthlyInterest ?? "0"),
        totalInterestPaid: parseFloat(a.totalInterestPaid),
        pendingInterest: parseFloat(a.pendingInterest),
        createdAt: a.createdAt.toISOString(),
      })),
      recoveryTasks: recoveryRows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  })
);

export default router;
