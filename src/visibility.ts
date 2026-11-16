/** Follows the page going out of sight and coming back. */
export interface PageReturns {
  /**
   * Aborts the next time the page becomes visible after it was hidden for
   * long enough. Each return uses up one signal; read the property again for
   * the next one.
   */
  readonly signal: AbortSignal;
  /** Stops listening to the page. */
  stop(): void;
}

/** What the signal of {@link PageReturns} aborts with. */
export class PageReturnedError extends Error {
  override readonly name: string = "PageReturnedError";
}

/**
 * Watches for the page becoming visible again after it was hidden for at
 * least `minHiddenMs`: the user came back to its tab, restored the window or
 * woke the machine. Where there is no page, as in a worker or outside a
 * browser, and with `minHiddenMs` set to `Infinity`, the signal never aborts.
 */
export function pageReturns(minHiddenMs: number): PageReturns {
  let controller = new AbortController();
  const handle: PageReturns = {
    get signal() {
      return controller.signal;
    },
    stop: () => undefined,
  };

  const page: Document | undefined = globalThis.document;
  if (
    minHiddenMs === Number.POSITIVE_INFINITY ||
    typeof page?.addEventListener !== "function" ||
    typeof page.visibilityState !== "string"
  ) {
    return handle;
  }

  // The clock keeps running while the page is frozen or the machine sleeps,
  // which a timer would not.
  let hiddenAt = page.visibilityState === "hidden" ? Date.now() : undefined;
  const onChange = (): void => {
    if (page.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const hiddenFor = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    const wasHidden = hiddenAt !== undefined;
    hiddenAt = undefined;
    if (wasHidden && hiddenFor >= minHiddenMs) {
      const returned = controller;
      controller = new AbortController();
      returned.abort(new PageReturnedError("the page became visible again"));
    }
  };
  page.addEventListener("visibilitychange", onChange);
  handle.stop = () => page.removeEventListener("visibilitychange", onChange);
  return handle;
}
