import { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";
import { ApiError } from "../utils/errors";

/**
 * Async error wrapper — catches Promise rejections and passes to error handler
 */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handler — must be registered last in middleware chain
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const isApiError = err instanceof ApiError;
  const status = isApiError ? err.status : 500;
  const message = isApiError ? err.message : "Internal server error";

  // Log full error in development, summary in production
  if (process.env.NODE_ENV !== "production") {
    logger.error(err, `[${status}] ${message}`);
  } else {
    logger.error({ status, message, type: err instanceof Error ? err.name : typeof err }, "Error occurred");
  }

  // Never send stack traces to clients
  if (res.headersSent) return;
  res.status(status).json({ error: message });
}
