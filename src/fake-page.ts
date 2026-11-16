/** Test support; not part of the package. */

import { vi } from "vitest";

export interface FakePage {
  /** Puts the page in the background. */
  hide(): void;
  /** Brings the page back into view. */
  show(): void;
  /** How many `visibilitychange` listeners are registered. */
  readonly listeners: number;
}

/**
 * Stands in for `document` as far as visibility goes. Undo with
 * `vi.unstubAllGlobals()`.
 */
export function fakePage(visibilityState: "visible" | "hidden" = "visible"): FakePage {
  const target = new EventTarget();
  const listeners = new Set<unknown>();
  const page = {
    visibilityState,
    addEventListener(type: string, listener: EventListener): void {
      listeners.add(listener);
      target.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.delete(listener);
      target.removeEventListener(type, listener);
    },
  };
  vi.stubGlobal("document", page);

  function change(to: "visible" | "hidden"): void {
    page.visibilityState = to;
    target.dispatchEvent(new Event("visibilitychange"));
  }
  return {
    hide: () => change("hidden"),
    show: () => change("visible"),
    get listeners() {
      return listeners.size;
    },
  };
}
