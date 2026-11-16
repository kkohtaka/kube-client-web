import { afterEach, describe, expect, it, vi } from "vitest";
import { fakePage } from "./fake-page.ts";
import { pageReturns } from "./visibility.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pageReturns", () => {
  it("does nothing where there is no document", () => {
    expect(globalThis.document).toBeUndefined();
    const returns = pageReturns(0);
    expect(returns.signal.aborted).toBe(false);
    returns.stop();
  });

  it("aborts its signal when the page comes back, and has a new one for the next time", () => {
    vi.useFakeTimers();
    const page = fakePage();
    const returns = pageReturns(1000);
    const first = returns.signal;

    page.hide();
    expect(first.aborted).toBe(false);
    vi.advanceTimersByTime(1000);
    page.show();
    expect(first.aborted).toBe(true);
    expect(first.reason).toMatchObject({ name: "PageReturnedError" });

    const second = returns.signal;
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
    page.hide();
    vi.advanceTimersByTime(1000);
    page.show();
    expect(second.aborted).toBe(true);
  });

  it("ignores a page that was hidden only briefly", () => {
    vi.useFakeTimers();
    const page = fakePage();
    const returns = pageReturns(1000);

    page.hide();
    vi.advanceTimersByTime(999);
    page.show();
    // The time before does not count towards the next absence.
    page.hide();
    vi.advanceTimersByTime(999);
    page.show();
    expect(returns.signal.aborted).toBe(false);
  });

  it("counts from the start for a page that was hidden all along", () => {
    vi.useFakeTimers();
    const page = fakePage("hidden");
    const returns = pageReturns(1000);
    const { signal } = returns;

    vi.advanceTimersByTime(1000);
    page.show();
    expect(signal.aborted).toBe(true);
  });

  it("ignores a page that becomes visible without having been hidden", () => {
    const page = fakePage();
    const returns = pageReturns(0);

    page.show();
    expect(returns.signal.aborted).toBe(false);
  });

  it("does not listen when switched off", () => {
    const page = fakePage();
    const returns = pageReturns(Number.POSITIVE_INFINITY);

    expect(page.listeners).toBe(0);
    page.hide();
    page.show();
    expect(returns.signal.aborted).toBe(false);
  });

  it("stops listening when stopped", () => {
    const page = fakePage();
    const returns = pageReturns(0);
    expect(page.listeners).toBe(1);

    returns.stop();
    expect(page.listeners).toBe(0);
    page.hide();
    page.show();
    expect(returns.signal.aborted).toBe(false);
  });
});
