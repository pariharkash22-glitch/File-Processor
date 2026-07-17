/**
 * Centralized error handling utilities
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(400, message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string = "Resource") {
    super(404, `${resource} not found`);
    this.name = "NotFoundError";
  }
}

export class DatabaseError extends ApiError {
  constructor(message: string = "Database operation failed") {
    super(500, message);
    this.name = "DatabaseError";
  }
}

export function parseIntStrict(value: any, fieldName: string, min = 1): number {
  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`);
  }
  const num = parseInt(Array.isArray(value) ? value[0] : String(value), 10);
  if (isNaN(num) || num < min) {
    throw new ValidationError(`${fieldName} must be a valid number >= ${min}`);
  }
  return num;
}

export function parseStringArray(value: any): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
