import { afterEach, describe, expect, it, vi } from "vitest";
import { Backoff, sleep } from "./backoff.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Backoff", () => {
  it("grows exponentially up to the maximum and starts over after a reset", () => {
    const backoff = new Backoff({ initialDelayMs: 100, maxDelayMs: 500, factor: 2, jitter: 0 });
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([
      100, 200, 400, 500,
    ]);
    backoff.reset();
    expect(backoff.next()).toBe(100);
  });

  it("shortens each delay by a random share of at most the jitter", () => {
    const random = vi.spyOn(Math, "random");
    const backoff = new Backoff({ initialDelayMs: 100, factor: 1, jitter: 0.5 });
    random.mockReturnValue(0);
    expect(backoff.next()).toBe(100);
    random.mockReturnValue(1);
    expect(backoff.next()).toBe(50);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = sleep(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it("rejects with the abort reason, immediately if already aborted", async () => {
    const reason = new Error("stop");
    await expect(sleep(10_000, AbortSignal.abort(reason))).rejects.toBe(reason);

    const abort = new AbortController();
    const sleeping = sleep(10_000, abort.signal);
    abort.abort(reason);
    await expect(sleeping).rejects.toBe(reason);
  });
});
