import { inject } from "vitest";
import {
  createClient,
  defineResource,
  type KubeClient,
  type KubeObject,
  type ObjectMeta,
} from "../src/index.ts";

/** Namespace the test identity may write to. */
export const namespace = "kube-client-web-e2e";

export function client(): KubeClient {
  return createClient({ baseUrl: inject("apiServer"), token: inject("token") });
}

/** A name that does not collide with leftovers from earlier runs. */
export function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface Pod extends KubeObject {
  metadata?: ObjectMeta;
}

export interface ConfigMap extends KubeObject {
  metadata?: ObjectMeta;
  data?: Record<string, string>;
}

export interface Deployment extends KubeObject {
  metadata?: ObjectMeta;
}

export interface Widget extends KubeObject {
  metadata?: ObjectMeta;
  spec?: { size?: number };
  status?: { ready?: boolean };
}

export const pods = defineResource<Pod>({ version: "v1", resource: "pods", namespaced: true });
export const namespaces = defineResource({
  version: "v1",
  resource: "namespaces",
  namespaced: false,
});
export const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});
export const deployments = defineResource<Deployment>({
  group: "apps",
  version: "v1",
  resource: "deployments",
  namespaced: true,
});
export const widgets = defineResource<Widget>({
  group: "e2e.kube-client-web.test",
  version: "v1",
  resource: "widgets",
  namespaced: true,
});
