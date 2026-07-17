import { Request, Response, NextFunction } from "express";
import { ValidationError } from "../utils/errors";

/**
 * Require authentication middleware
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    throw new ValidationError("Missing authorization token");
  }
  (req as any).user = { token }; // Placeholder — replace with real token validation
  next();
}

/**
 * Require specific roles middleware
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userRole = (req as any).user?.role;
    if (!userRole || !allowedRoles.includes(userRole)) {
      throw new ValidationError(`User role '${userRole}' is not allowed for this resource`);
    }
    next();
  };
}
