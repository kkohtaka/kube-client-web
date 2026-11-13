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
