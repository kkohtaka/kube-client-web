import {
  createClient,
  defineResource,
  type Informer,
  type KubeObject,
  type ObjectMeta,
  type ResourceDescriptor,
} from "kube-client-web";

// --- Connecting ------------------------------------------------------------

/**
 * Hands the client its token. The client asks before every request, so all
 * this has to do is keep a token that is not about to expire.
 */
let cached: { token: string; expiresAt: number } | undefined;
async function currentToken(): Promise<string> {
  if (!cached || Date.now() > cached.expiresAt - 60_000) {
    const response = await fetch("/token");
    if (!response.ok) {
      throw new Error(`could not get a token: ${await response.text()}`);
    }
    cached = (await response.json()) as { token: string; expiresAt: number };
  }
  return cached.token;
}

const client = createClient({
  // The dev server forwards /k8s to the API server. See vite.config.ts.
  baseUrl: `${location.origin}/k8s`,
  token: currentToken,
});

// --- Resources -------------------------------------------------------------

interface ConfigMap extends KubeObject {
  metadata?: ObjectMeta;
  data?: Record<string, string>;
}

interface Pod extends KubeObject {
  metadata?: ObjectMeta;
  status?: { phase?: string };
}

type Resource = KubeObject & { metadata?: ObjectMeta };

/** Namespace the demo's identity may write to. */
const demoNamespace = "kube-client-web-e2e";

const configMaps = defineResource<ConfigMap>({
  version: "v1",
  resource: "configmaps",
  namespaced: true,
});
const pods = defineResource<Pod>({ version: "v1", resource: "pods", namespaced: true });

interface View<T extends Resource> {
  label: string;
  descriptor: ResourceDescriptor<T>;
  /** Omit to follow all namespaces. */
  namespace?: string;
  detailHeading: string;
  detail(object: T): string;
  /** Builds an object to create. Views without it are read-only. */
  create?: (name: string) => T;
}

const views: { configmaps: View<ConfigMap>; pods: View<Pod> } = {
  configmaps: {
    label: "ConfigMaps",
    descriptor: configMaps,
    namespace: demoNamespace,
    detailHeading: "Keys",
    detail: (object) => Object.keys(object.data ?? {}).join(", "),
    create: (name) => ({
      metadata: { name, namespace: demoNamespace },
      data: { createdBy: "kube-client-web demo" },
    }),
  },
  pods: {
    label: "Pods",
    descriptor: pods,
    detailHeading: "Phase",
    detail: (object) => object.status?.phase ?? "",
  },
};

// --- Page ------------------------------------------------------------------

function element<E extends HTMLElement>(id: string): E {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`#${id} is missing from the page`);
  }
  return found as E;
}

const viewsElement = element("views");
const statusElement = element("status");
const countElement = element("count");
const createButton = element<HTMLButtonElement>("create");
const detailHeading = element("detail-heading");
const rowsElement = element("rows");
const emptyElement = element("empty");
const logElement = element("log");

function setStatus(state: "connecting" | "synced" | "error", text: string): void {
  statusElement.dataset.state = state;
  statusElement.textContent = text;
}

function log(kind: string, text: string): void {
  const item = document.createElement("li");
  item.dataset.kind = kind;
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  item.append(time, `${kind} ${text}`);
  logElement.prepend(item);
  // Short enough to stay on the page without a scrolling box of its own.
  while (logElement.children.length > 30) {
    logElement.lastElementChild?.remove();
  }
}

function keyOf(object: Resource): string {
  return `${object.metadata?.namespace ?? ""}/${object.metadata?.name ?? ""}`;
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  return td;
}

// --- Following a resource ----------------------------------------------------

/** Stops following the current view. */
let stop: () => void = () => undefined;

function show<T extends Resource>(view: View<T>): void {
  stop();
  rowsElement.replaceChildren();
  setStatus("connecting", "Connecting");
  countElement.textContent = "";
  detailHeading.textContent = view.detailHeading;
  const { create } = view;
  createButton.hidden = create === undefined;

  const resource = client.resource(view.descriptor);
  const informer: Informer<T> = resource.informer({ namespace: view.namespace });
  const changed = new Set<string>();

  // The informer's local copy is the model: after any change, draw it again.
  // Changes that arrive together are drawn together.
  let scheduled = false;
  function render(): void {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const objects = informer.list().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
      rowsElement.replaceChildren(...objects.map(row));
      changed.clear();
      emptyElement.hidden = objects.length > 0;
      countElement.textContent = `${objects.length} object${objects.length === 1 ? "" : "s"}`;
    });
  }

  function row(object: T): HTMLTableRowElement {
    const tr = document.createElement("tr");
    tr.dataset.key = keyOf(object);
    if (changed.has(keyOf(object))) {
      tr.className = "flash";
    }
    const created = object.metadata?.creationTimestamp;
    const actions = cell("", "actions");
    if (create) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Delete";
      remove.dataset.testid = "delete";
      remove.addEventListener("click", () => {
        const { name, namespace } = object.metadata ?? {};
        if (name) {
          resource.delete(name, { namespace }).catch(report);
        }
      });
      actions.append(remove);
    }
    tr.append(
      cell(object.metadata?.namespace ?? ""),
      cell(object.metadata?.name ?? "", "name"),
      cell(view.detail(object)),
      cell(created ? new Date(created).toLocaleString() : ""),
      cell(object.metadata?.resourceVersion ?? "", "mono"),
      actions,
    );
    return tr;
  }

  function report(error: unknown): void {
    log("error", error instanceof Error ? error.message : String(error));
  }

  function onChange(kind: string, object: T): void {
    changed.add(keyOf(object));
    log(kind, keyOf(object));
    render();
  }

  informer.on("add", (object) => onChange("add", object));
  informer.on("update", (object) => onChange("update", object));
  informer.on("delete", (object) => onChange("delete", object));
  informer.on("error", (error) => {
    // The informer keeps trying by itself; this only tells the user.
    setStatus("error", "Reconnecting");
    report(error);
  });
  // Every change means the informer is connected again.
  for (const event of ["add", "update", "delete"] as const) {
    informer.on(event, () => {
      if (informer.hasSynced) {
        setStatus("synced", "Synced");
      }
    });
  }

  informer.start().then(
    () => {
      setStatus("synced", "Synced");
      render();
    },
    () => undefined, // stopped before the first list arrived
  );

  createButton.onclick = () => {
    if (create) {
      const name = `demo-${crypto.randomUUID().slice(0, 8)}`;
      resource.create(create(name)).catch(report);
    }
  };

  stop = () => informer.stop();
}

// --- View switcher -----------------------------------------------------------

function select(name: keyof typeof views): void {
  for (const button of viewsElement.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === name));
  }
  if (name === "configmaps") {
    show(views.configmaps);
  } else {
    show(views.pods);
  }
}

for (const name of Object.keys(views) as (keyof typeof views)[]) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.view = name;
  button.dataset.testid = `view-${name}`;
  button.textContent = views[name].label;
  button.addEventListener("click", () => select(name));
  viewsElement.append(button);
}

select("configmaps");
