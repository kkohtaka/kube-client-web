import {
  createClient,
  createOidcAuth,
  defineResource,
  type KubeObject,
  type ObjectMeta,
  type SharedInformer,
  SignInRequiredError,
} from "kube-client-web";

// --- Signing in --------------------------------------------------------------

/** The OpenID Connect provider of the demo cluster. See e2e/dex.yaml. */
const issuer = "https://127.0.0.1:5556/dex";

const auth = createOidcAuth({
  issuer,
  clientId: "kube-client-web",
  // "email" is the claim the API server names the user by; "offline_access"
  // gets a refresh token, so the session outlives the first ID token.
  scopes: ["email", "offline_access"],
  // The dev server forwards /idp to the provider. See vite.config.ts.
  fetch: (input, init) => fetch(String(input).replace(new URL(issuer).origin, "/idp"), init),
});

const client = createClient({
  // The dev server forwards /k8s to the API server. See vite.config.ts.
  baseUrl: `${location.origin}/k8s`,
  // Asked before every request. It renews the token when it is about to expire.
  token: auth.token,
});

// --- Resources ---------------------------------------------------------------

interface Namespace extends KubeObject {
  metadata?: ObjectMeta;
  status?: { phase?: string };
}

interface Deployment extends KubeObject {
  metadata?: ObjectMeta;
  spec?: { replicas?: number; selector?: unknown; template?: unknown };
  status?: { readyReplicas?: number };
}

interface Pod extends KubeObject {
  metadata?: ObjectMeta;
  status?: { phase?: string; conditions?: { type: string; status: string }[] };
}

const namespaces = defineResource<Namespace>({
  version: "v1",
  resource: "namespaces",
  namespaced: false,
});
const deployments = defineResource<Deployment>({
  group: "apps",
  version: "v1",
  resource: "deployments",
  namespaced: true,
});
const pods = defineResource<Pod>({ version: "v1", resource: "pods", namespaced: true });

/** Marks what this page created. Only that gets buttons that change it. */
const ownLabel = "app.kubernetes.io/managed-by";
const ownValue = "kube-client-web-demo";

function isOwn(object: { metadata?: ObjectMeta }): boolean {
  return object.metadata?.labels?.[ownLabel] === ownValue;
}

type PodState = "Pending" | "Starting" | "Running" | "Terminating" | "Failed" | "Succeeded";

function stateOf(pod: Pod): PodState {
  if (pod.metadata?.deletionTimestamp) {
    return "Terminating";
  }
  switch (pod.status?.phase) {
    case "Running": {
      const ready = pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True");
      return ready ? "Running" : "Starting";
    }
    case "Succeeded":
      return "Succeeded";
    case "Failed":
      return "Failed";
    default:
      return "Pending";
  }
}

/**
 * The deployment a pod belongs to, if any. A deployment's pods are owned by a
 * ReplicaSet named after the deployment and the hash of the pod template, so
 * the name can be worked out without following ReplicaSets as well.
 */
function deploymentOf(pod: Pod): string | undefined {
  const owner = pod.metadata?.ownerReferences?.find((o) => o.controller && o.kind === "ReplicaSet");
  const hash = pod.metadata?.labels?.["pod-template-hash"];
  if (owner && hash && owner.name.endsWith(`-${hash}`)) {
    return owner.name.slice(0, -hash.length - 1);
  }
  return undefined;
}

// --- Page --------------------------------------------------------------------

function element<E extends HTMLElement>(id: string): E {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`#${id} is missing from the page`);
  }
  return found as E;
}

const signedOutElement = element("signed-out");
const noticeElement = element("notice");
const sessionElement = element("session");
const clusterElement = element("cluster");
const statusElement = element("status");
const countElement = element("count");
const mapElement = element("map");
const logElement = element("log");

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  if (className) {
    made.className = className;
  }
  if (text !== undefined) {
    made.textContent = text;
  }
  return made;
}

function button(
  text: string,
  label: string,
  testId: string,
  onClick: () => void,
): HTMLButtonElement {
  const made = make("button", undefined, text);
  made.type = "button";
  made.setAttribute("aria-label", label);
  made.dataset.testid = testId;
  made.addEventListener("click", onClick);
  return made;
}

function setStatus(state: "connecting" | "synced" | "error", text: string): void {
  statusElement.dataset.state = state;
  statusElement.textContent = text;
}

function log(kind: string, text: string): void {
  const item = make("li");
  item.dataset.kind = kind;
  item.append(make("time", undefined, new Date().toLocaleTimeString()), `${kind} ${text}`);
  logElement.prepend(item);
  // Short enough to stay on the page without a scrolling box of its own.
  while (logElement.children.length > 10) {
    logElement.lastElementChild?.remove();
  }
}

/**
 * Makes the children of `parent` match `items`, in order. Elements of items
 * that stay are kept and updated, so that only what is new appears and only
 * what is gone leaves: both are animated in style.css.
 */
function sync<T>(
  parent: HTMLElement,
  items: T[],
  keyOf: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (made: HTMLElement, item: T) => void,
): void {
  const present = new Map<string, HTMLElement>();
  for (const child of parent.children) {
    if (child instanceof HTMLElement && !child.classList.contains("leaving")) {
      present.set(child.dataset.key ?? "", child);
    }
  }
  let previous: Element | null = null;
  for (const item of items) {
    const key = keyOf(item);
    let child = present.get(key);
    present.delete(key);
    if (!child) {
      child = create(item);
      child.dataset.key = key;
    }
    update(child, item);
    const place: Element | null = previous ? previous.nextElementSibling : parent.firstElementChild;
    if (place !== child) {
      parent.insertBefore(child, place);
    }
    previous = child;
  }
  for (const gone of present.values()) {
    gone.classList.add("leaving");
    gone.addEventListener("animationend", () => gone.remove(), { once: true });
    // In case the animation never runs, as in a tab in the background.
    setTimeout(() => gone.remove(), 1000);
  }
}

// --- The map -------------------------------------------------------------------

interface Followed {
  namespaces: SharedInformer<Namespace>;
  deployments: SharedInformer<Deployment>;
  pods: SharedInformer<Pod>;
  stop(): void;
}

let followed: Followed | undefined;

/** Reports a failed request. A session that has ended sends the user back to signing in. */
function report(error: unknown): void {
  if (error instanceof SignInRequiredError) {
    showSignedOut("Your session has ended. Sign in again to continue.");
    return;
  }
  log("error", error instanceof Error ? error.message : String(error));
}

const byName = (a: KubeObject, b: KubeObject): number =>
  (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "");

const byAge = (a: Pod, b: Pod): number =>
  (a.metadata?.creationTimestamp ?? "").localeCompare(b.metadata?.creationTimestamp ?? "") ||
  byName(a, b);

/** One group of pods inside a namespace: a deployment's, or those without one. */
interface Group {
  name: string;
  deployment?: Deployment;
  pods: Pod[];
}

function groupsOf(namespace: string, model: Followed): Group[] {
  const groups = new Map<string, Group>();
  for (const deployment of model.deployments.list().sort(byName)) {
    if (deployment.metadata?.namespace === namespace) {
      const name = deployment.metadata.name ?? "";
      groups.set(name, { name, deployment, pods: [] });
    }
  }
  const loose: Pod[] = [];
  for (const pod of model.pods.list().sort(byAge)) {
    if (pod.metadata?.namespace === namespace) {
      (groups.get(deploymentOf(pod) ?? "")?.pods ?? loose).push(pod);
    }
  }
  const all = [...groups.values()];
  if (loose.length > 0) {
    all.push({ name: "", pods: loose });
  }
  return all;
}

function createNamespaceCard(namespace: Namespace): HTMLElement {
  const name = namespace.metadata?.name ?? "";
  const card = make("li", "namespace");
  card.dataset.namespace = name;
  const header = make("header");
  header.append(make("h3", undefined, name), make("span", "phase"));
  if (isOwn(namespace)) {
    card.dataset.own = "true";
    const actions = make("span", "actions");
    actions.append(
      button("Add deployment", `Add deployment to ${name}`, "add-deployment", () =>
        addDeployment(name),
      ),
      button("Delete", `Delete namespace ${name}`, "delete-namespace", () => {
        client.resource(namespaces).delete(name).catch(report);
      }),
    );
    header.append(actions);
  }
  card.append(header, make("ul", "groups"), make("p", "empty", "No pods"));
  return card;
}

function updateNamespaceCard(card: HTMLElement, namespace: Namespace, model: Followed): void {
  const name = namespace.metadata?.name ?? "";
  const terminating = namespace.status?.phase === "Terminating";
  card.dataset.phase = terminating ? "Terminating" : "Active";
  (card.querySelector(".phase") as HTMLElement).textContent = terminating ? "Terminating" : "";
  for (const control of card.querySelectorAll("button")) {
    control.disabled = terminating;
  }
  const groups = groupsOf(name, model);
  (card.querySelector(".empty") as HTMLElement).hidden = groups.length > 0;
  sync(
    card.querySelector(".groups") as HTMLElement,
    groups,
    (group) => group.name,
    (group) => createGroup(name, group, isOwn(namespace)),
    updateGroup,
  );
}

function createGroup(namespace: string, group: Group, own: boolean): HTMLElement {
  const made = make("li", "group");
  const header = make("header");
  if (group.deployment) {
    const { name } = group;
    made.dataset.deployment = name;
    header.append(make("h4", undefined, name), make("span", "replicas"));
    if (own) {
      const resource = client.resource(deployments);
      const scale = (by: number) => {
        const key = `${namespace}/${name}`;
        const ask = asked.get(key) ?? { replicas: undefined, requests: 0 };
        // Count on from what was asked for last, so that a second click
        // before the first has come back through the informer is not lost.
        const current =
          ask.replicas ?? followed?.deployments.get(name, namespace)?.spec?.replicas ?? 0;
        const replicas = Math.max(0, current + by);
        asked.set(key, ask);
        ask.replicas = replicas;
        ask.requests++;
        resource
          .patch(name, { spec: { replicas } }, { namespace })
          .catch((error: unknown) => {
            // What was asked for will not come; go by the informer again.
            ask.replicas = undefined;
            report(error);
          })
          .finally(() => {
            ask.requests--;
            settle(followed?.deployments.get(name, namespace));
          });
      };
      const actions = make("span", "actions");
      actions.append(
        button("−", `Scale ${name} down`, "scale-down", () => scale(-1)),
        button("+", `Scale ${name} up`, "scale-up", () => scale(1)),
        button("Delete", `Delete deployment ${name}`, "delete-deployment", () => {
          resource.delete(name, { namespace }).catch(report);
        }),
      );
      header.append(actions);
    }
  } else {
    header.append(make("h4", "loose", "Without a deployment"));
  }
  made.append(header, make("ul", "pods"));
  return made;
}

function updateGroup(made: HTMLElement, group: Group): void {
  const replicas = made.querySelector(".replicas");
  if (replicas && group.deployment) {
    const wanted = group.deployment.spec?.replicas ?? 0;
    replicas.textContent = `${group.deployment.status?.readyReplicas ?? 0} of ${wanted} ready`;
  }
  sync(
    made.querySelector(".pods") as HTMLElement,
    group.pods,
    (pod) => pod.metadata?.uid ?? pod.metadata?.name ?? "",
    (pod) => {
      const shape = make("li", "pod");
      shape.dataset.pod = pod.metadata?.name ?? "";
      shape.append(make("span", "visually-hidden"));
      return shape;
    },
    (shape, pod) => {
      const state = stateOf(pod);
      shape.dataset.state = state;
      shape.title = `${pod.metadata?.name}: ${state}`;
      (shape.firstElementChild as HTMLElement).textContent = shape.title;
    },
  );
}

/**
 * Replica counts this page has asked for and the informer has not shown yet,
 * by namespace and name of the deployment.
 */
const asked = new Map<string, { replicas: number | undefined; requests: number }>();

/** Forgets what was asked for a deployment once the informer shows it, or it failed. */
function settle(deployment: Deployment | undefined): void {
  const key = `${deployment?.metadata?.namespace}/${deployment?.metadata?.name}`;
  const ask = asked.get(key);
  if (
    ask?.requests === 0 &&
    (ask.replicas ?? deployment?.spec?.replicas) === deployment?.spec?.replicas
  ) {
    asked.delete(key);
  }
}

/** Draws the informers' local copies. They are the model; the page keeps none of its own. */
function render(model: Followed): void {
  const all = model.namespaces.list().sort(
    // What was made here comes first, where it is seen without scrolling.
    (a, b) => Number(isOwn(b)) - Number(isOwn(a)) || byName(a, b),
  );
  sync(
    mapElement,
    all,
    (namespace) => namespace.metadata?.uid ?? namespace.metadata?.name ?? "",
    createNamespaceCard,
    (card, namespace) => updateNamespaceCard(card, namespace, model),
  );
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  countElement.textContent = [
    count(all.length, "namespace"),
    count(model.deployments.list().length, "deployment"),
    count(model.pods.list().length, "pod"),
  ].join(" · ");
}

function follow(): Followed {
  // One factory for the page. Its informers share their lists and watches,
  // so another part of the page could follow pods too at no extra cost.
  const informers = client.sharedInformers();
  const model: Followed = {
    namespaces: informers.informer(namespaces),
    deployments: informers.informer(deployments),
    pods: informers.informer(pods),
    stop: () => informers.stop(),
  };

  // Changes that arrive together are drawn together.
  let scheduled = false;
  const draw = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (followed === model) {
        render(model);
      }
    });
  };

  const all = [
    ["namespace", model.namespaces],
    ["deployment", model.deployments],
    ["pod", model.pods],
  ] as const;
  const live = () => all.every(([, informer]) => informer.hasSynced);
  for (const [noun, informer] of all) {
    const changed = (kind: string) => (object: KubeObject) => {
      const { namespace, name } = object.metadata ?? {};
      log(kind, `${noun} ${namespace ? `${namespace}/` : ""}${name}`);
      // Every change means the informer is connected again.
      if (live()) {
        setStatus("synced", "Live");
      }
      draw();
    };
    informer.on("add", changed("add"));
    informer.on("update", changed("update"));
    informer.on("delete", changed("delete"));
    informer.on("error", (error) => {
      // The informer keeps trying by itself; this only tells the user.
      setStatus("error", "Reconnecting");
      report(error);
    });
  }

  model.deployments.on("update", settle);
  model.deployments.on("delete", (deployment) => {
    asked.delete(`${deployment.metadata?.namespace}/${deployment.metadata?.name}`);
  });

  Promise.all(all.map(([, informer]) => informer.start())).then(
    () => {
      setStatus("synced", "Live");
      draw();
    },
    () => undefined, // stopped before the first lists arrived
  );
  return model;
}

// --- Changing the cluster ------------------------------------------------------

function shortId(): string {
  return crypto.randomUUID().slice(0, 5);
}

element("create-namespace").addEventListener("click", () => {
  client
    .resource(namespaces)
    .create({ metadata: { name: `demo-${shortId()}`, labels: { [ownLabel]: ownValue } } })
    .catch(report);
});

function addDeployment(namespace: string): void {
  const name = `web-${shortId()}`;
  const labels = { app: name };
  client
    .resource(deployments)
    .create({
      metadata: { name, namespace, labels: { ...labels, [ownLabel]: ownValue } },
      spec: {
        replicas: 3,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            // Does nothing, which is all the demo needs of a container.
            containers: [{ name: "pause", image: "registry.k8s.io/pause:3.10" }],
            terminationGracePeriodSeconds: 2,
          },
        },
      },
    })
    .catch(report);
}

// --- Signed in or not ----------------------------------------------------------

function showSignedOut(notice?: string): void {
  followed?.stop();
  followed = undefined;
  asked.clear();
  mapElement.replaceChildren();
  logElement.replaceChildren();
  clusterElement.hidden = true;
  sessionElement.hidden = true;
  signedOutElement.hidden = false;
  noticeElement.hidden = notice === undefined;
  noticeElement.textContent = notice ?? "";
}

function showCluster(): void {
  signedOutElement.hidden = true;
  sessionElement.hidden = false;
  clusterElement.hidden = false;
  element("user").textContent = String(auth.claims?.email ?? auth.claims?.sub ?? "");
  setStatus("connecting", "Connecting");
  followed = follow();
}

element("sign-in").addEventListener("click", () => {
  // Leaves the page. The provider sends the browser back here.
  auth.signIn().catch((error: unknown) => showSignedOut(`Could not sign in: ${String(error)}`));
});

element("sign-out").addEventListener("click", () => {
  auth.signOut();
  showSignedOut();
});

try {
  // Finishes a sign-in if the browser has just come back from the provider.
  await auth.completeSignIn();
  if (auth.signedIn) {
    showCluster();
  } else {
    showSignedOut();
  }
} catch (error) {
  showSignedOut(`Could not sign in: ${String(error)}`);
}
