import { Router, type IRouter } from "express";
import { asyncHandler } from "../middleware/errors";

const router: IRouter = Router();

router.get(
  "/healthz",
  asyncHandler(async (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  })
);

export default router;
