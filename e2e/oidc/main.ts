import {
  createClient,
  createOidcAuth,
  defineResource,
  type KubeObject,
  type OidcConfig,
} from "../../src/index.ts";

// Filled in by vite.config.ts.
declare const __API_SERVER__: string;
declare const __ISSUER__: string;

interface SelfSubjectReview extends KubeObject {
  status?: { userInfo?: { username?: string } };
}

const config: OidcConfig = {
  issuer: __ISSUER__,
  clientId: "kube-client-web",
  scopes: ["email", "offline_access"],
};
const auth = createOidcAuth(config);
const client = createClient({ baseUrl: __API_SERVER__, token: auth.token });
const reviews = client.resource(
  defineResource<SelfSubjectReview>({
    group: "authentication.k8s.io",
    version: "v1",
    resource: "selfsubjectreviews",
    namespaced: false,
  }),
);
const configMaps = client.resource(
  defineResource({ version: "v1", resource: "configmaps", namespaced: true }),
);

function element(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function show(state: string, error?: unknown): void {
  element("state").dataset.state = state;
  element("state").textContent = state;
  element("error").textContent = error === undefined ? "" : String(error);
}

/** Asks the API server who it takes the user for, and reads something as that user. */
async function callApiServer(): Promise<void> {
  show("loading");
  element("user").textContent = String(auth.claims?.email ?? "");
  try {
    const review = await reviews.create({
      apiVersion: "authentication.k8s.io/v1",
      kind: "SelfSubjectReview",
    });
    element("whoami").textContent = review.status?.userInfo?.username ?? "";
    const list = await configMaps.list({ namespace: "kube-client-web-e2e" });
    element("configmaps").textContent = String(list.items.length);
    show("signed-in");
  } catch (error) {
    show("error", error);
  }
}

element("sign-in").addEventListener("click", () => {
  auth.signIn().catch((error: unknown) => show("error", error));
});
element("sign-out").addEventListener("click", () => {
  auth.signOut();
  location.reload();
});
element("call").addEventListener("click", () => void callApiServer());
element("renew").addEventListener("click", () => {
  // The same session, seen by an object that finds every token too old.
  const impatient = createOidcAuth({ ...config, renewBeforeMs: 24 * 60 * 60 * 1000 });
  const before = sessionStorage.getItem("test:last-token") ?? "";
  impatient.token().then(
    (token) => {
      if (token !== before) {
        sessionStorage.setItem("test:last-token", token);
        element("renewals").textContent = String(Number(element("renewals").textContent) + 1);
      }
      return callApiServer();
    },
    (error: unknown) => show("error", error),
  );
});

element("follow").addEventListener("click", () => {
  // Dex issues tokens that live ten minutes. This object takes one for too
  // old three seconds after it was issued, so to the informer below the token
  // runs out every three seconds.
  const hasty = createOidcAuth({ ...config, renewBeforeMs: 10 * 60 * 1000 - 3000 });
  let last = "";
  const informer = createClient({
    baseUrl: __API_SERVER__,
    token: async () => {
      const token = await hasty.token();
      if (token !== last) {
        last = token;
        element("follow-tokens").textContent = String(
          Number(element("follow-tokens").textContent) + 1,
        );
      }
      return token;
    },
  })
    .resource(defineResource({ version: "v1", resource: "configmaps", namespaced: true }))
    .informer({
      namespace: "kube-client-web-e2e",
      labelSelector: "e2e-oidc=follow",
      // Short-lived connections, so the informer soon needs the token again.
      watchTimeoutSeconds: 2,
    });
  const render = (): void => {
    element("followed").textContent = informer
      .list()
      .map((object) => object.metadata?.name)
      .join(" ");
  };
  informer.on("add", render);
  informer.on("delete", render);
  informer.on("error", (error) => {
    element("follow-errors").textContent += `${String(error)}; `;
  });
  informer.start().then(
    () => {
      element("followed").dataset.synced = "true";
    },
    (error: unknown) => show("error", error),
  );
});

try {
  await auth.completeSignIn();
  if (auth.signedIn) {
    sessionStorage.setItem("test:last-token", await auth.token());
    await callApiServer();
  } else {
    show("signed-out");
  }
} catch (error) {
  show("error", error);
}
