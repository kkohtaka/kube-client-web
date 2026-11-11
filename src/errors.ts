import type { Status } from "./types.ts";

/**
 * Thrown when the API server answers with a non-2xx status.
 *
 * Failures before a response arrives (network errors, a blocked cross-origin
 * request, an aborted request) are not wrapped; `fetch` rejects with its own
 * error for those.
 */
export class ApiError extends Error {
  override readonly name: string = "ApiError";
  /** HTTP status code. */
  readonly status: number;
  /** The `Status` object from the response body, when the server sent one. */
  readonly body: Status | undefined;

  constructor(status: number, body: Status | undefined, fallbackMessage: string) {
    super(body?.message ?? fallbackMessage);
    this.status = status;
    this.body = body;
  }

  /** Machine-readable cause from the `Status` body, for example `NotFound`. */
  get reason(): string | undefined {
    return this.body?.reason;
  }
}
