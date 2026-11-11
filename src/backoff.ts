export interface BackoffOptions {
  /** Delay before the first retry, in milliseconds. Defaults to 500. */
  initialDelayMs?: number | undefined;
  /** Upper bound for the delay, in milliseconds. Defaults to 30000. */
  maxDelayMs?: number | undefined;
  /** Multiplier applied after each consecutive failure. Defaults to 2. */
  factor?: number | undefined;
  /**
   * Fraction of each delay that is randomized, from 0 (none) to 1. Spreads out
   * clients that lost their connection at the same moment. Defaults to 0.5.
   */
  jitter?: number | undefined;
}

/** Exponential backoff with jitter. */
export class Backoff {
  readonly #initialDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #factor: number;
  readonly #jitter: number;
  #attempt = 0;

  constructor(options: BackoffOptions = {}) {
    this.#initialDelayMs = options.initialDelayMs ?? 500;
    this.#maxDelayMs = options.maxDelayMs ?? 30_000;
    this.#factor = options.factor ?? 2;
    this.#jitter = Math.min(Math.max(options.jitter ?? 0.5, 0), 1);
  }

  /** Returns the next delay and lengthens the one after it. */
  next(): number {
    const base = Math.min(this.#initialDelayMs * this.#factor ** this.#attempt, this.#maxDelayMs);
    this.#attempt += 1;
    return base * (1 - this.#jitter * Math.random());
  }

  reset(): void {
    this.#attempt = 0;
  }
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
