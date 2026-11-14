import type { KubeClient, QueryValue } from "./client.ts";
import { Informer, type InformerOptions } from "./informer.ts";
import { followLog, type LogOptions, readLog } from "./log.ts";
import { type ResourceDescriptor, resourcePath } from "./resource.ts";
import type { KubeList, KubeObject, Scale, Status } from "./types.ts";
import {
  type ReconnectingWatchOptions,
  type WatchEvent,
  type WatchOptions,
  watchOnce,
  watchWithReconnect,
} from "./watch.ts";

interface Cancellable {
  signal?: AbortSignal | undefined;
}

interface Namespaced {
  /** Namespace of the object. Required for namespaced resources unless stated otherwise. */
  namespace?: string | undefined;
}

interface WriteOptions extends Cancellable {
  /** Pass `"All"` to validate the request without persisting it. */
  dryRun?: "All" | undefined;
  /** Name recorded as the owner of the changed fields. */
  fieldManager?: string | undefined;
  /** How the server treats unknown or duplicate fields. */
  fieldValidation?: "Ignore" | "Warn" | "Strict" | undefined;
}

export interface GetOptions extends Cancellable, Namespaced {
  /** Read a subresource such as `status` instead of the object itself. */
  subresource?: string | undefined;
}

export interface ListOptions extends Cancellable {
  /** Namespace to list. Omit to list a namespaced resource across all namespaces. */
  namespace?: string | undefined;
  labelSelector?: string | undefined;
  fieldSelector?: string | undefined;
  /** Maximum number of items per page. */
  limit?: number | undefined;
  /** Token from a previous page's `metadata.continue`. */
  continue?: string | undefined;
  resourceVersion?: string | undefined;
  resourceVersionMatch?: "Exact" | "NotOlderThan" | undefined;
  timeoutSeconds?: number | undefined;
}

export interface CreateOptions extends WriteOptions {
  /** Defaults to `metadata.namespace` of the object. */
  namespace?: string | undefined;
}

export interface UpdateOptions extends WriteOptions {
  /** Defaults to `metadata.namespace` of the object. */
  namespace?: string | undefined;
  /** Replace a subresource such as `status` instead of the object itself. */
  subresource?: string | undefined;
}

export type PatchType = "merge" | "strategic" | "json";

export interface PatchOptions extends WriteOptions, Namespaced {
  /**
   * Patch format. `merge` (the default) is a JSON merge patch and works for
   * every resource; `strategic` is only supported by built-in resources;
   * `json` is a JSON Patch operation array.
   */
  type?: PatchType | undefined;
  subresource?: string | undefined;
}

export interface ApplyOptions extends Cancellable {
  /** Name recorded as the owner of the applied fields. Required by the server. */
  fieldManager: string;
  /** Take ownership of fields that another manager currently owns. */
  force?: boolean | undefined;
  /** Defaults to `metadata.namespace` of the object. */
  namespace?: string | undefined;
  subresource?: string | undefined;
  dryRun?: "All" | undefined;
  fieldValidation?: "Ignore" | "Warn" | "Strict" | undefined;
}

export interface DeleteOptions extends Cancellable, Namespaced {
  dryRun?: "All" | undefined;
  gracePeriodSeconds?: number | undefined;
  propagationPolicy?: "Orphan" | "Background" | "Foreground" | undefined;
  /** Delete only if the object still has this UID and/or resource version. */
  preconditions?: { uid?: string; resourceVersion?: string } | undefined;
}

export interface ScaleOptions extends WriteOptions, Namespaced {}

export interface SubresourceOptions extends Namespaced {}

export interface SubresourcePatchOptions extends WriteOptions {
  /** Patch format. Defaults to `merge`. */
  type?: PatchType | undefined;
}

const patchContentTypes: Record<PatchType, string> = {
  merge: "application/merge-patch+json",
  strategic: "application/strategic-merge-patch+json",
  json: "application/json-patch+json",
};

/** Typed operations on one resource. Obtain one from {@link KubeClient.resource}. */
export class ResourceClient<T extends KubeObject> {
  readonly #client: KubeClient;
  readonly descriptor: ResourceDescriptor<T>;

  constructor(client: KubeClient, descriptor: ResourceDescriptor<T>) {
    this.#client = client;
    this.descriptor = descriptor;
  }

  get(name: string, options: GetOptions = {}): Promise<T> {
    return this.#client.request<T>({
      path: this.#path({ name, namespace: options.namespace, subresource: options.subresource }),
      signal: options.signal,
    });
  }

  /** Fetches one page. Use {@link listPages} to follow `continue` tokens automatically. */
  list(options: ListOptions = {}): Promise<KubeList<T>> {
    const { namespace, signal, ...query } = options;
    return this.#client.request<KubeList<T>>({
      path: this.#path({ namespace }),
      query,
      signal,
    });
  }

  /**
   * Iterates over all pages of a list, requesting the next one only when the
   * consumer asks for it. Set `limit` to control the page size.
   *
   * If the server can no longer serve the snapshot the first page came from,
   * the next request fails with an `ApiError` whose reason is `Expired`; start
   * the listing again in that case.
   */
  async *listPages(options: ListOptions = {}): AsyncGenerator<KubeList<T>, void, undefined> {
    let token = options.continue;
    do {
      const page = await this.list({ ...options, continue: token });
      yield page;
      token = page.metadata?.continue || undefined;
    } while (token !== undefined);
  }

  create(object: T, options: CreateOptions = {}): Promise<T> {
    const { namespace, signal, ...query } = options;
    return this.#client.request<T>({
      method: "POST",
      path: this.#path({ namespace: namespace ?? object.metadata?.namespace }),
      query,
      body: object,
      signal,
    });
  }

  /**
   * Replaces the object. The server rejects the request with a `Conflict` if
   * `metadata.resourceVersion` is set and no longer current.
   */
  update(object: T, options: UpdateOptions = {}): Promise<T> {
    const { namespace, subresource, signal, ...query } = options;
    return this.#client.request<T>({
      method: "PUT",
      path: this.#path({
        name: requireName(object),
        namespace: namespace ?? object.metadata?.namespace,
        subresource,
      }),
      query,
      body: object,
      signal,
    });
  }

  patch(name: string, patch: unknown, options: PatchOptions = {}): Promise<T> {
    const { namespace, subresource, type = "merge", signal, ...query } = options;
    return this.#client.request<T>({
      method: "PATCH",
      path: this.#path({ name, namespace, subresource }),
      query,
      body: patch,
      contentType: patchContentTypes[type],
      signal,
    });
  }

  /**
   * Server-side apply: declares the desired state of the fields this field
   * manager owns, creating the object if it does not exist. The object must
   * carry `apiVersion`, `kind` and `metadata.name`.
   */
  apply(object: T, options: ApplyOptions): Promise<T> {
    const { namespace, subresource, signal, ...query } = options;
    return this.#client.request<T>({
      method: "PATCH",
      path: this.#path({
        name: requireName(object),
        namespace: namespace ?? object.metadata?.namespace,
        subresource,
      }),
      query,
      body: object,
      // JSON is valid YAML, which is the only media type the server accepts for apply.
      contentType: "application/apply-patch+yaml",
      signal,
    });
  }

  /**
   * Deletes the object. Resolves with the object when deletion is still in
   * progress (finalizers, graceful termination) and with a `Status` otherwise.
   */
  delete(name: string, options: DeleteOptions = {}): Promise<T | Status> {
    const { namespace, signal, dryRun, ...body } = options;
    const query: Record<string, QueryValue> = { dryRun };
    const hasBody = Object.values(body).some((value) => value !== undefined);
    return this.#client.request<T | Status>({
      method: "DELETE",
      path: this.#path({ name, namespace }),
      query,
      body: hasBody ? { apiVersion: "v1", kind: "DeleteOptions", ...body } : undefined,
      signal,
    });
  }

  /**
   * Reads how many replicas the object has and is meant to have. Works for
   * everything that can be scaled: deployments, stateful sets, replica sets
   * and custom resources that declare a `scale` subresource.
   */
  getScale(name: string, options: Cancellable & Namespaced = {}): Promise<Scale> {
    const { signal, ...rest } = options;
    return this.subresource<Scale>(name, "scale", rest).get({ signal });
  }

  /**
   * Sets the number of replicas, and nothing else: unlike a patch of the
   * object, it needs no permission to change the object itself.
   */
  scale(name: string, replicas: number, options: ScaleOptions = {}): Promise<Scale> {
    const { namespace, ...rest } = options;
    return this.subresource<Scale>(name, "scale", { namespace }).patch(
      { spec: { replicas } },
      rest,
    );
  }

  /**
   * Reads the log of a pod's container as it is now. Only pods have a log.
   * A pod with several containers needs `container`.
   */
  log(name: string, options: LogOptions = {}): Promise<string> {
    const { namespace, ...rest } = options;
    return readLog(this.#client, this.#path({ name, namespace, subresource: "log" }), rest);
  }

  /**
   * Reads the log of a pod's container and keeps reading as it grows,
   * yielding one line at a time, without its line break.
   *
   * The iteration ends when the container stops. It throws when the
   * connection is lost; to carry on from there, ask for `timestamps` and
   * start again with `sinceTime` set to the time of the last line seen,
   * expecting to see the lines of that moment again. Stop following by
   * leaving the loop or aborting `signal`.
   */
  followLog(name: string, options: LogOptions = {}): AsyncGenerator<string, void, undefined> {
    const { namespace, ...rest } = options;
    return followLog(this.#client, this.#path({ name, namespace, subresource: "log" }), rest);
  }

  /**
   * Addresses a subresource of one object, for those that have no method of
   * their own here, such as `eviction` or `ephemeralcontainers`. `S` is
   * the type the subresource is read and written as.
   *
   * `status` needs none of this: `get`, `update`, `patch` and `apply`
   * take `subresource: "status"` and keep the object's own type.
   */
  subresource<S = unknown>(
    name: string,
    subresource: string,
    options: SubresourceOptions = {},
  ): SubresourceClient<S> {
    return new SubresourceClient<S>(
      this.#client,
      this.#path({ name, namespace: options.namespace, subresource }),
    );
  }

  /**
   * Opens a single watch connection and yields changes as they arrive. The
   * iteration ends when the server closes the connection, which it does
   * regularly; use {@link watchWithReconnect} to keep watching.
   *
   * A watch the server cannot serve throws an `ApiError`. Status 410 means
   * `resourceVersion` is too old: list again and watch from the new version.
   * Stop watching by leaving the loop or aborting `signal`.
   */
  watch(options: WatchOptions = {}): AsyncGenerator<WatchEvent<T>, void, undefined> {
    const { namespace, ...rest } = options;
    return watchOnce<T>(this.#client, this.#path({ namespace }), rest);
  }

  /**
   * Watches without end: when a connection closes or fails, connects again
   * from the last version seen, waiting longer after repeated failures.
   *
   * The iteration only ends by throwing: when `signal` aborts, or with the
   * `ApiError` of an answer that retrying cannot change. That includes status
   * 410 (see {@link isGone}), after which the caller has to list again.
   */
  watchWithReconnect(
    options: ReconnectingWatchOptions = {},
  ): AsyncGenerator<WatchEvent<T>, void, undefined> {
    const { namespace, ...rest } = options;
    return watchWithReconnect<T>(this.#client, this.#path({ namespace }), rest);
  }

  /**
   * Creates an informer: a local copy of the matching objects that is kept up
   * to date, with events for every change. It does nothing until started.
   */
  informer(options: InformerOptions = {}): Informer<T> {
    return new Informer<T>(this, options);
  }

  #path(options: {
    namespace?: string | undefined;
    name?: string;
    subresource?: string | undefined;
  }): string {
    return resourcePath(this.descriptor, options);
  }
}

/** Operations on one subresource of one object. Obtain one from {@link ResourceClient.subresource}. */
export class SubresourceClient<S> {
  readonly #client: KubeClient;
  readonly #path: string;

  constructor(client: KubeClient, path: string) {
    this.#client = client;
    this.#path = path;
  }

  get(options: Cancellable = {}): Promise<S> {
    return this.#client.request<S>({ path: this.#path, signal: options.signal });
  }

  /** Posts to the subresource, which is how `eviction`, `binding` and `token` are used. */
  create<R = S>(body: unknown, options: WriteOptions = {}): Promise<R> {
    const { signal, ...query } = options;
    return this.#client.request<R>({ method: "POST", path: this.#path, query, body, signal });
  }

  update(body: S, options: WriteOptions = {}): Promise<S> {
    const { signal, ...query } = options;
    return this.#client.request<S>({ method: "PUT", path: this.#path, query, body, signal });
  }

  patch(patch: unknown, options: SubresourcePatchOptions = {}): Promise<S> {
    const { type = "merge", signal, ...query } = options;
    return this.#client.request<S>({
      method: "PATCH",
      path: this.#path,
      query,
      body: patch,
      contentType: patchContentTypes[type],
      signal,
    });
  }
}

function requireName(object: KubeObject): string {
  const name = object.metadata?.name;
  if (!name) {
    throw new Error("metadata.name is required");
  }
  return name;
}
