import { Backoff, type BackoffOptions, sleep } from "./backoff.ts";
import { isGone } from "./errors.ts";
import type { ResourceClient } from "./resource-client.ts";
import type { KubeObject } from "./types.ts";
import type { WatchEvent } from "./watch.ts";

export interface InformerOptions {
  /** Namespace to follow. Omit to follow a namespaced resource across all namespaces. */
  namespace?: string | undefined;
  labelSelector?: string | undefined;
  fieldSelector?: string | undefined;
  /** Number of objects requested per page when listing. Defaults to 500. */
  pageSize?: number | undefined;
  /**
   * Ask the server to end each watch connection after this many seconds. The
   * informer then connects again, with the token current at that moment.
   * Defaults to a random value between 300 and 600.
   */
  watchTimeoutSeconds?: number | undefined;
  /**
   * Reconnect when a watch connection stays silent for this long. Off by
   * default; a dead connection is then noticed when the server fails to end
   * the watch on time, 30 seconds after `watchTimeoutSeconds`.
   */
  idleTimeoutMs?: number | undefined;
  /** Delays between attempts after a failure. */
  backoff?: BackoffOptions | undefined;
}

export interface InformerEvents<T> {
  /** An object appeared: at the first list, or later. */
  add: (object: T) => void;
  /** An object changed. `previous` is the state the informer held before. */
  update: (object: T, previous: T) => void;
  /** An object is gone. `object` is its last known state. */
  delete: (object: T) => void;
  /**
   * Something failed. The informer keeps going and tries again by itself, so
   * this is for reporting; call `stop()` to give up. Exceptions thrown by
   * other listeners are reported here as well.
   */
  error: (error: unknown) => void;
}

type Listeners<T> = { [E in keyof InformerEvents<T>]: Set<InformerEvents<T>[E]> };

interface Run {
  readonly abort: AbortController;
  readonly synced: Promise<void>;
  hasSynced: boolean;
}

/**
 * Keeps a local copy of a set of objects up to date and reports changes.
 *
 * It lists the objects, then watches for changes from the version of that
 * list. When the watch can no longer be resumed it lists again and reports
 * the differences, so listeners never miss a change, though several changes to
 * one object may be reported as one. Obtain one from
 * {@link ResourceClient.informer}.
 */
export class Informer<T extends KubeObject> {
  readonly #resource: ResourceClient<T>;
  readonly #options: InformerOptions;
  readonly #listeners: Listeners<T> = {
    add: new Set(),
    update: new Set(),
    delete: new Set(),
    error: new Set(),
  };
  #store: Map<string, T> = new Map();
  #run: Run | undefined;

  constructor(resource: ResourceClient<T>, options: InformerOptions = {}) {
    this.#resource = resource;
    this.#options = options;
  }

  /** Registers a listener and returns a function that removes it again. */
  on<E extends keyof InformerEvents<T>>(event: E, listener: InformerEvents<T>[E]): () => void {
    const listeners: Set<InformerEvents<T>[E]> = this.#listeners[event];
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Starts following the resource. Register listeners first: every object of
   * the first list is reported as `add`.
   *
   * The promise resolves once that first list is in the local copy. It stays
   * pending while the list keeps failing (see the `error` event) and rejects
   * if the informer is stopped before. Calling `start()` on a running
   * informer returns the same promise.
   */
  start(): Promise<void> {
    if (this.#run) {
      return this.#run.synced;
    }
    const abort = new AbortController();
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const synced = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that do not wait for the first list must not get an unhandled rejection.
    synced.catch(() => undefined);

    const run: Run = { abort, synced, hasSynced: false };
    this.#run = run;
    void this.#loop(run, resolve).then(() => reject(abort.signal.reason));
    return synced;
  }

  /**
   * Stops following the resource and closes the connection. The local copy
   * stays readable but is no longer updated. After `start()` is called again,
   * the changes made in the meantime are reported.
   */
  stop(): void {
    const run = this.#run;
    this.#run = undefined;
    run?.abort.abort(new DOMException("the informer was stopped", "AbortError"));
  }

  /** Whether the local copy has been filled by a list since the last `start()`. */
  get hasSynced(): boolean {
    return this.#run?.hasSynced ?? false;
  }

  /** Looks an object up in the local copy. `namespace` is required for namespaced resources. */
  get(name: string, namespace?: string): T | undefined {
    return this.#store.get(namespace === undefined ? name : `${namespace}/${name}`);
  }

  /** Returns the objects in the local copy. */
  list(): T[] {
    return [...this.#store.values()];
  }

  /** Runs until the informer is stopped. Never rejects. */
  async #loop(run: Run, onSynced: () => void): Promise<void> {
    const { signal } = run.abort;
    const { namespace, labelSelector, fieldSelector, idleTimeoutMs } = this.#options;
    const backoff = new Backoff(this.#options.backoff);

    while (!signal.aborted) {
      let watched = false;
      try {
        const resourceVersion = await this.#relist(signal);
        run.hasSynced = true;
        onSynced();

        const events = this.#resource.watchWithReconnect({
          namespace,
          labelSelector,
          fieldSelector,
          resourceVersion,
          timeoutSeconds:
            this.#options.watchTimeoutSeconds ?? Math.round(300 + Math.random() * 300),
          idleTimeoutMs,
          backoff: this.#options.backoff,
          signal,
          onReconnect: ({ error }) => {
            if (error !== undefined) {
              this.#emit("error", error);
            }
          },
        });
        for await (const event of events) {
          watched = true;
          backoff.reset();
          this.#apply(event);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (isGone(error)) {
          // Expected now and then: the version to resume from has expired, so
          // list again. Right away if the watch had been working.
          if (watched) {
            continue;
          }
        } else {
          this.#emit("error", error);
        }
      }
      try {
        await sleep(backoff.next(), signal);
      } catch {
        return;
      }
    }
  }

  /** Replaces the local copy with a fresh list and reports what changed. */
  async #relist(signal: AbortSignal): Promise<string | undefined> {
    const { namespace, labelSelector, fieldSelector, pageSize = 500 } = this.#options;
    const next = new Map<string, T>();
    let resourceVersion: string | undefined;
    const pages = this.#resource.listPages({
      namespace,
      labelSelector,
      fieldSelector,
      limit: pageSize,
      signal,
    });
    for await (const page of pages) {
      // Every page of one list reports the version of the same snapshot.
      resourceVersion ??= page.metadata?.resourceVersion;
      for (const object of page.items) {
        const key = keyOf(object);
        if (key !== undefined) {
          next.set(key, object);
        }
      }
    }

    const previous = this.#store;
    this.#store = next;
    for (const [key, object] of next) {
      const old = previous.get(key);
      if (old === undefined) {
        this.#emit("add", object);
      } else if (old.metadata?.resourceVersion !== object.metadata?.resourceVersion) {
        this.#emit("update", object, old);
      }
    }
    for (const [key, old] of previous) {
      if (!next.has(key)) {
        this.#emit("delete", old);
      }
    }
    return resourceVersion;
  }

  #apply(event: WatchEvent<T>): void {
    if (event.type === "BOOKMARK") {
      return;
    }
    const key = keyOf(event.object);
    if (key === undefined) {
      return;
    }
    const old = this.#store.get(key);
    if (event.type === "DELETED") {
      if (this.#store.delete(key)) {
        this.#emit("delete", event.object);
      }
      return;
    }
    this.#store.set(key, event.object);
    if (old === undefined) {
      this.#emit("add", event.object);
    } else {
      this.#emit("update", event.object, old);
    }
  }

  #emit<E extends keyof InformerEvents<T>>(
    event: E,
    ...args: Parameters<InformerEvents<T>[E]>
  ): void {
    for (const listener of [...this.#listeners[event]]) {
      try {
        (listener as (...values: unknown[]) => void)(...args);
      } catch (error) {
        // A broken listener must not stop the informer or starve the others.
        if (event !== "error") {
          this.#emit("error", error);
        }
      }
    }
  }
}

function keyOf(object: KubeObject): string | undefined {
  const name = object.metadata?.name;
  if (!name) {
    return undefined;
  }
  const namespace = object.metadata?.namespace;
  return namespace ? `${namespace}/${name}` : name;
}
