export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retrySafe = false,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
