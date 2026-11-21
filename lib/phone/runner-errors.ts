/** The phone runner did not answer in time. The phone is often slow just after boot,
    so the caller can retry after retryAfter seconds. */
export class RunnerTimeoutError extends Error {
  readonly retryAfter: number;
  constructor(message: string, retryAfter = 5) {
    super(message);
    this.name = "RunnerTimeoutError";
    this.retryAfter = retryAfter;
  }
}
