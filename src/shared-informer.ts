import type { KubeClient } from "./client.ts";
import type { Informer, InformerEvents, InformerOptions } from "./informer.ts";
import type { ResourceDescriptor } from "./resource.ts";
import type { KubeObject } from "./types.ts";

/** What a shared informer follows. Informers that agree on all of it share one list and watch. */
export interface SharedInformerSelection {
  /** Namespace to follow. Omit to follow a namespaced resource across all namespaces. */
  namespace?: string | undefined;
  labelSelector?: string | undefined;
  fieldSelector?: string | undefined;
}

/** Settings for every informer of a factory. See {@link InformerOptions}. */
export type SharedInformerFactoryOptions = Omit<InformerOptions, keyof SharedInformerSelection>;

type Emit<T> = <E extends keyof InformerEvents<T>>(
  event: E,
  ...args: Parameters<InformerEvents<T>[E]>
) => void;

/** One user's share of an informer, from `start()` to `stop()`. */
interface Lease<T extends KubeObject> {
  readonly informer: Informer<T>;
  /** Resolves once the informer has its first list. */
  readonly synced: Promise<void>;
  /** Starts passing the informer's events to `emit`. */
  join(emit: Emit<T>): void;
  /** Gives the share back. The informer stops with its last share. */
  release(): void;
}

interface Shared<T extends KubeObject> {
  readonly informer: Informer<T>;
  readonly members: Set<Emit<T>>;
  /** One per share, to stop its user. */
  readonly stops: Set<() => void>;
}

type Listeners<T> = { [E in keyof InformerEvents<T>]: Set<InformerEvents<T>[E]> };

/**
 * Lets many users follow the same objects with one list and watch.
 *
 * {@link SharedInformerFactory.informer} hands out a {@link SharedInformer}
 * on every call. Those for the same resource, namespace and selectors are
 * served by a single list and watch, which runs while at least one of them is
 * started. Obtain a factory from {@link KubeClient.sharedInformers}.
 */
export class SharedInformerFactory {
  readonly #client: KubeClient;
  readonly #options: SharedInformerFactoryOptions;
  readonly #shared: Map<string, Shared<KubeObject>> = new Map();

  constructor(client: KubeClient, options: SharedInformerFactoryOptions = {}) {
    this.#client = client;
    this.#options = options;
  }

  /**
   * Returns an informer for the matching objects. It does nothing until
   * started, and each caller gets one of its own to start and stop.
   *
   * Selectors are compared as written: `a=1,b=2` and `b=2,a=1` select the same
   * objects but do not share a watch.
   */
  informer<T extends KubeObject>(
    descriptor: ResourceDescriptor<T>,
    selection: SharedInformerSelection = {},
  ): SharedInformer<T> {
    const key = JSON.stringify([
      descriptor.group || "",
      descriptor.version,
      descriptor.resource,
      selection.namespace ?? null,
      selection.labelSelector || "",
      selection.fieldSelector || "",
    ]);
    return new SharedInformer<T>((stop) => this.#lease(key, descriptor, selection, stop));
  }

  /** Stops every informer of this factory and ends the watches. */
  stop(): void {
    const stops = [...this.#shared.values()].flatMap((shared) => [...shared.stops]);
    for (const stop of stops) {
      stop();
    }
  }

  #lease<T extends KubeObject>(
    key: string,
    descriptor: ResourceDescriptor<T>,
    selection: SharedInformerSelection,
    stop: () => void,
  ): Lease<T> {
    // Informers under one key follow the same objects, so the object type a
    // caller declared for them is as good as the one of the first caller.
    const shared =
      (this.#shared.get(key) as Shared<T> | undefined) ?? this.#create(key, descriptor, selection);
    const { informer, members, stops } = shared;
    stops.add(stop);
    let joined: Emit<T> | undefined;
    return {
      informer,
      synced: informer.start(),
      join: (emit) => {
        joined = emit;
        members.add(emit);
      },
      release: () => {
        if (joined) {
          members.delete(joined);
        }
        stops.delete(stop);
        if (stops.size === 0) {
          // A stopped informer keeps its objects, which are out of date by the
          // time it is needed again. The next user gets a fresh one.
          informer.stop();
          if (this.#shared.get(key) === (shared as unknown)) {
            this.#shared.delete(key);
          }
        }
      },
    };
  }

  #create<T extends KubeObject>(
    key: string,
    descriptor: ResourceDescriptor<T>,
    selection: SharedInformerSelection,
  ): Shared<T> {
    const informer = this.#client.resource(descriptor).informer({
      ...this.#options,
      namespace: selection.namespace,
      labelSelector: selection.labelSelector || undefined,
      fieldSelector: selection.fieldSelector || undefined,
    });
    const members = new Set<Emit<T>>();
    const forward: Emit<T> = (event, ...args) => {
      for (const emit of [...members]) {
        emit(event, ...args);
      }
    };
    informer.on("add", (object) => forward("add", object));
    informer.on("update", (object, previous) => forward("update", object, previous));
    informer.on("delete", (object) => forward("delete", object));
    informer.on("error", (error) => forward("error", error));

    const shared: Shared<T> = { informer, members, stops: new Set() };
    this.#shared.set(key, shared as unknown as Shared<KubeObject>);
    return shared;
  }
}

interface Active<T extends KubeObject> {
  readonly lease: Lease<T>;
  readonly synced: Promise<void>;
  readonly reject: (reason: unknown) => void;
}

/**
 * One user's view of an informer that others may be using too. It reads like
 * an {@link Informer}: listeners, `start()`, `stop()` and a local copy.
 *
 * The objects it returns are the same ones every other user gets, so treat
 * them as read-only. Obtain one from {@link SharedInformerFactory.informer}.
 */
export class SharedInformer<T extends KubeObject> {
  readonly #acquire: (stop: () => void) => Lease<T>;
  readonly #listeners: Listeners<T> = {
    add: new Set(),
    update: new Set(),
    delete: new Set(),
    error: new Set(),
  };
  /** The informer of the latest `start()`, kept after `stop()` for reading. */
  #informer: Informer<T> | undefined;
  #active: Active<T> | undefined;

  /** @internal */
  constructor(acquire: (stop: () => void) => Lease<T>) {
    this.#acquire = acquire;
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
   * Starts following the objects. Register listeners first: every object
   * known at that point is reported as `add`, whether it comes from a first
   * list or from the copy that other users already keep up to date.
   *
   * The promise resolves once the local copy has been filled by a list, which
   * is right away when others are already following the same objects. It
   * stays pending while the list keeps failing (see the `error` event) and
   * rejects if `stop()` is called before. Calling `start()` again while
   * started returns the same promise.
   */
  start(): Promise<void> {
    if (this.#active) {
      return this.#active.synced;
    }
    const lease = this.#acquire(() => this.stop());
    this.#informer = lease.informer;

    // Joining is put off to a microtask so that it cannot happen while the
    // informer is in the middle of reporting a list, when a listener starts
    // another shared informer: that one would hear of some objects twice.
    queueMicrotask(() => {
      for (const object of lease.informer.list()) {
        if (this.#active !== active) {
          return;
        }
        this.#emit("add", object);
      }
      if (this.#active === active) {
        lease.join(this.#emit);
      }
    });

    let reject!: (reason: unknown) => void;
    const synced = new Promise<void>((resolve, rej) => {
      reject = rej;
      lease.synced.then(resolve, rej);
    });
    // Callers that do not wait for the first list must not get an unhandled rejection.
    synced.catch(() => undefined);
    const active: Active<T> = { lease, synced, reject };
    this.#active = active;
    return synced;
  }

  /**
   * Stops reporting changes to this informer's listeners. The watch ends
   * when no other user needs it. The local copy stays readable; it is
   * still kept up to date for as long as others follow the same objects.
   * After `start()` is called again, every object is reported as `add` again.
   */
  stop(): void {
    const active = this.#active;
    if (!active) {
      return;
    }
    this.#active = undefined;
    active.lease.release();
    active.reject(new DOMException("the informer was stopped", "AbortError"));
  }

  /** Whether this informer is started and the local copy has been filled by a list. */
  get hasSynced(): boolean {
    return this.#active?.lease.informer.hasSynced ?? false;
  }

  /** Looks an object up in the local copy. `namespace` is required for namespaced resources. */
  get(name: string, namespace?: string): T | undefined {
    return this.#informer?.get(name, namespace);
  }

  /** Returns the objects in the local copy. */
  list(): T[] {
    return this.#informer?.list() ?? [];
  }

  readonly #emit: Emit<T> = (event, ...args) => {
    for (const listener of [...this.#listeners[event]]) {
      try {
        (listener as (...values: unknown[]) => void)(...args);
      } catch (error) {
        // A broken listener must not disturb the other users of the informer.
        if (event !== "error") {
          this.#emit("error", error);
        }
      }
    }
  };
}
