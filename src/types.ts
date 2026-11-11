/**
 * The part of a Kubernetes object this library reads.
 *
 * Resource types are supplied by the caller, so this is deliberately loose:
 * any object type whose `metadata` carries these optional string fields
 * satisfies it, whichever type package it comes from.
 */
export interface KubeObject {
  apiVersion?: string | undefined;
  kind?: string | undefined;
  metadata?:
    | {
        name?: string | undefined;
        namespace?: string | undefined;
        resourceVersion?: string | undefined;
      }
    | undefined;
}

/** Metadata common to all persisted objects. A convenience for callers that define their own resource types. */
export interface ObjectMeta {
  name?: string;
  generateName?: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  generation?: number;
  creationTimestamp?: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  finalizers?: string[];
  ownerReferences?: OwnerReference[];
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export interface ListMeta {
  resourceVersion?: string;
  /** Opaque token for fetching the next page. Absent or empty on the last page. */
  continue?: string;
  remainingItemCount?: number;
}

export interface KubeList<T> {
  apiVersion?: string;
  kind?: string;
  metadata?: ListMeta;
  items: T[];
}

/** The error (or delete confirmation) object returned by the API server. */
export interface Status {
  apiVersion?: string;
  kind?: string;
  status?: "Success" | "Failure";
  message?: string;
  /** Machine-readable cause, for example `NotFound`, `AlreadyExists`, `Conflict` or `Expired`. */
  reason?: string;
  code?: number;
  details?: StatusDetails;
}

export interface StatusDetails {
  name?: string;
  group?: string;
  kind?: string;
  uid?: string;
  retryAfterSeconds?: number;
  causes?: StatusCause[];
}

export interface StatusCause {
  reason?: string;
  message?: string;
  field?: string;
}
