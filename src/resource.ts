import type { KubeObject } from "./types.ts";

declare const objectType: unique symbol;

/** Identifies a resource collection on the API server and carries its object type. */
export interface ResourceDescriptor<T extends KubeObject = KubeObject> {
  /** API group. Omit or leave empty for the core group (`/api/v1`). */
  readonly group?: string | undefined;
  readonly version: string;
  /** Plural, lowercase resource name as it appears in URLs, for example `pods`. */
  readonly resource: string;
  readonly namespaced: boolean;
  /** Type-level only; never present at runtime. */
  readonly [objectType]?: T;
}

/**
 * Declares a resource and the type of its objects.
 *
 * ```ts
 * const pods = defineResource<Pod>({ version: "v1", resource: "pods", namespaced: true });
 * ```
 */
export function defineResource<T extends KubeObject = KubeObject>(descriptor: {
  group?: string | undefined;
  version: string;
  resource: string;
  namespaced: boolean;
}): ResourceDescriptor<T> {
  return descriptor;
}

export interface ResourcePathOptions {
  namespace?: string | undefined;
  name?: string | undefined;
  subresource?: string | undefined;
}

/**
 * Builds the URL path for a resource collection, a single object, or a subresource.
 *
 * For a namespaced resource, omitting `namespace` addresses the collection
 * across all namespaces, which is only valid without a `name`.
 */
export function resourcePath(
  descriptor: ResourceDescriptor,
  options: ResourcePathOptions = {},
): string {
  const { namespace, name, subresource } = options;
  const { group, version, resource, namespaced } = descriptor;

  if (!namespaced && namespace !== undefined) {
    throw new Error(`${resource} is cluster-scoped; a namespace cannot be given`);
  }
  if (namespaced && namespace === undefined && name !== undefined) {
    throw new Error(`${resource} is namespaced; a namespace is required to address "${name}"`);
  }
  if (subresource !== undefined && name === undefined) {
    throw new Error(`a name is required to address the ${subresource} subresource`);
  }

  const segments = group ? ["apis", group, version] : ["api", version];
  if (namespace !== undefined) {
    segments.push("namespaces", namespace);
  }
  segments.push(resource);
  if (name !== undefined) {
    segments.push(name);
  }
  if (subresource !== undefined) {
    segments.push(subresource);
  }
  return `/${segments.map(encodeURIComponent).join("/")}`;
}
