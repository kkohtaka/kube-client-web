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

/**
 * Whether the error says the requested resource version is no longer
 * available (HTTP 410). A list continuation or a watch that fails this way
 * has to start over from a fresh list.
 */
export function isGone(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 410;
}
