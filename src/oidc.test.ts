import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClient,
  createOidcAuth,
  type OidcAuth,
  type OidcConfig,
  OidcError,
  type OidcStorage,
  SignInRequiredError,
} from "./index.ts";

const issuer = "https://idp.example.test/realm";
const clientId = "web";
const redirectUri = "https://app.example.test/callback";
const now = Date.parse("2026-01-01T00:00:00Z");

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

/** An ID token as the provider would issue it for the pending sign-in. */
function idToken(overrides: Record<string, unknown> = {}): string {
  return jwt({
    iss: issuer,
    aud: clientId,
    sub: "jane",
    email: "jane@example.test",
    exp: now / 1000 + 600,
    ...overrides,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function memoryStorage(): OidcStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

interface TokenRequest {
  params: Record<string, string>;
  headers: Headers;
}

function setup(config: Partial<OidcConfig> = {}): {
  auth: OidcAuth;
  storage: ReturnType<typeof memoryStorage>;
  /** Where `signIn()` sent the browser. */
  visited: URL[];
  /** Answers of the token endpoint, in order: a body, or a function of the request. */
  answers: (Response | Error | ((request: TokenRequest) => Response))[];
  tokenRequests: TokenRequest[];
  discoveries: () => number;
  metadata: Record<string, unknown>;
  /** Goes to the provider and comes back with a code, as a browser would. */
  signIn(claims?: Record<string, unknown>, extra?: Record<string, unknown>): Promise<boolean>;
} {
  const storage = memoryStorage();
  const visited: URL[] = [];
  const answers: (Response | Error | ((request: TokenRequest) => Response))[] = [];
  const tokenRequests: TokenRequest[] = [];
  const metadata: Record<string, unknown> = {
    issuer,
    authorization_endpoint: `${issuer}/auth`,
    token_endpoint: `${issuer}/token`,
    code_challenge_methods_supported: ["plain", "S256"],
  };
  let discoveries = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      discoveries++;
      return json(metadata);
    }
    if (url === `${issuer}/token`) {
      const request = {
        params: Object.fromEntries(init?.body as URLSearchParams),
        headers: new Headers(init?.headers),
      };
      expect(init?.method).toBe("POST");
      tokenRequests.push(request);
      const answer = answers.shift();
      if (answer === undefined) {
        throw new Error("unexpected token request");
      }
      if (answer instanceof Error) {
        throw answer;
      }
      return typeof answer === "function" ? answer(request) : answer;
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const auth = createOidcAuth({
    issuer,
    clientId,
    redirectUri,
    storage,
    fetch,
    navigate: (url) => visited.push(new URL(url)),
    ...config,
  });

  async function signIn(
    claims: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    await auth.signIn();
    const request = visited.at(-1)?.searchParams;
    answers.push(
      json({
        id_token: idToken({ nonce: request?.get("nonce"), ...claims }),
        access_token: "access",
        token_type: "Bearer",
        ...extra,
      }),
    );
    return auth.completeSignIn(`${redirectUri}?code=the-code&state=${request?.get("state")}`);
  }

  return {
    auth,
    storage,
    visited,
    answers,
    tokenRequests,
    discoveries: () => discoveries,
    metadata,
    signIn,
  };
}

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

vi.useFakeTimers({ toFake: ["Date"], now });

afterEach(() => {
  vi.setSystemTime(now);
});

describe("OidcAuth", () => {
  describe("signIn", () => {
    it("sends the browser to the provider with a PKCE challenge", async () => {
      const { auth, visited } = setup({ scopes: ["email", "offline_access", "openid"] });

      await auth.signIn({ params: { prompt: "login", client_id: "ignored" } });

      expect(visited).toHaveLength(1);
      const url = visited[0] as URL;
      expect(url.origin + url.pathname).toBe(`${issuer}/auth`);
      const params = Object.fromEntries(url.searchParams);
      expect(params).toMatchObject({
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: "openid email offline_access",
        code_challenge_method: "S256",
        prompt: "login",
      });
      expect(params.state).toMatch(/^[\w-]{43}$/);
      expect(params.nonce).toMatch(/^[\w-]{43}$/);
      expect(params.code_challenge).toMatch(/^[\w-]{43}$/);
      expect(new Set([params.state, params.nonce, params.code_challenge]).size).toBe(3);
    });

    it("asks for the openid scope alone by default", async () => {
      const { auth, visited } = setup();
      await auth.signIn();
      expect(visited[0]?.searchParams.get("scope")).toBe("openid");
    });

    it("refuses a provider that cannot do PKCE with S256", async () => {
      const { auth, metadata, visited } = setup();
      metadata.code_challenge_methods_supported = ["plain"];

      await expect(auth.signIn()).rejects.toThrow(OidcError);
      expect(visited).toEqual([]);
    });

    it("refuses a provider that calls itself something else", async () => {
      const { auth, metadata } = setup();
      metadata.issuer = "https://elsewhere.example.test";

      await expect(auth.signIn()).rejects.toThrow(/calls itself https:\/\/elsewhere/);
    });

    it("reads the provider's configuration once, and again after a failure", async () => {
      const { auth, metadata, discoveries } = setup();
      const endpoint = metadata.token_endpoint;
      delete metadata.token_endpoint;
      await expect(auth.signIn()).rejects.toThrow(OidcError);
      metadata.token_endpoint = endpoint;

      await auth.signIn();
      await auth.signIn();

      expect(discoveries()).toBe(2);
    });
  });

  describe("completeSignIn", () => {
    it("exchanges the code for a token, proving it started the sign-in", async () => {
      const { auth, visited, tokenRequests, signIn } = setup();
      expect(auth.signedIn).toBe(false);

      expect(await signIn()).toBe(true);

      expect(auth.signedIn).toBe(true);
      expect(tokenRequests).toHaveLength(1);
      const { params, headers } = tokenRequests[0] as TokenRequest;
      expect(params).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: redirectUri,
        client_id: clientId,
      });
      expect(await challengeOf(params.code_verifier ?? "")).toBe(
        visited[0]?.searchParams.get("code_challenge"),
      );
      expect(headers.has("Authorization")).toBe(false);
      expect(await auth.token()).toBe(idToken({ nonce: visited[0]?.searchParams.get("nonce") }));
      expect(auth.claims).toMatchObject({ sub: "jane", email: "jane@example.test" });
    });

    it("leaves other URLs alone", async () => {
      const { auth, tokenRequests } = setup();
      expect(await auth.completeSignIn(redirectUri)).toBe(false);
      expect(await auth.completeSignIn(`${redirectUri}?code=x&state=y`)).toBe(false);

      await auth.signIn();
      expect(await auth.completeSignIn(`${redirectUri}?code=x&state=not-ours`)).toBe(false);
      expect(await auth.completeSignIn(`${redirectUri}?code=x`)).toBe(false);
      expect(tokenRequests).toEqual([]);
    });

    it("uses an answer only once", async () => {
      const { auth, visited, answers, tokenRequests } = setup();
      await auth.signIn();
      const request = visited[0]?.searchParams;
      answers.push(json({ id_token: idToken({ nonce: request?.get("nonce") }) }));
      const url = `${redirectUri}?code=the-code&state=${request?.get("state")}`;

      const results = await Promise.all([auth.completeSignIn(url), auth.completeSignIn(url)]);

      expect(results).toEqual([true, false]);
      expect(tokenRequests).toHaveLength(1);
    });

    it("reports the provider's refusal to sign in", async () => {
      const { auth, visited } = setup();
      await auth.signIn();
      const state = visited[0]?.searchParams.get("state");

      const failed = auth.completeSignIn(
        `${redirectUri}?error=access_denied&error_description=No+thanks&state=${state}`,
      );

      await expect(failed).rejects.toMatchObject({
        name: "OidcError",
        error: "access_denied",
        message: "No thanks",
      });
      expect(auth.signedIn).toBe(false);
    });

    it("reports the token endpoint's refusal", async () => {
      const { auth, visited, answers } = setup();
      await auth.signIn();
      answers.push(json({ error: "invalid_grant", error_description: "code expired" }, 400));

      const failed = auth.completeSignIn(
        `${redirectUri}?code=x&state=${visited[0]?.searchParams.get("state")}`,
      );

      await expect(failed).rejects.toMatchObject({
        error: "invalid_grant",
        message: "code expired",
      });
      expect(auth.signedIn).toBe(false);
    });

    it.each([
      ["from another issuer", { iss: "https://elsewhere.example.test" }, /another issuer/],
      ["for another client", { aud: "other" }, /another client/],
      ["for another sign-in", { nonce: "other" }, /does not belong/],
      ["without an expiry", { exp: undefined }, /when it expires/],
    ])("rejects an ID token %s", async (_name, claims, message) => {
      const { auth, signIn } = setup();
      await expect(signIn(claims)).rejects.toThrow(message);
      expect(auth.signedIn).toBe(false);
    });

    it("rejects an answer without a readable ID token", async () => {
      const { auth, visited, answers } = setup();
      for (const body of [{ access_token: "access" }, { id_token: "not-a-jwt" }]) {
        await auth.signIn();
        answers.push(json(body));
        const state = visited.at(-1)?.searchParams.get("state");
        await expect(auth.completeSignIn(`${redirectUri}?code=x&state=${state}`)).rejects.toThrow(
          OidcError,
        );
      }
    });

    it("accepts a token for several audiences that include the client", async () => {
      const { signIn } = setup();
      expect(await signIn({ aud: ["other", clientId] })).toBe(true);
    });
  });

  describe("token", () => {
    it("fails with SignInRequiredError when nobody has signed in", async () => {
      const { auth } = setup();
      await expect(auth.token()).rejects.toThrow(SignInRequiredError);
      expect(auth.claims).toBeUndefined();
    });

    it("hands out the same token until it is about to expire", async () => {
      const { auth, tokenRequests, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });
      const first = await auth.token();

      vi.setSystemTime(now + 539_000);
      expect(await auth.token()).toBe(first);
      expect(tokenRequests).toHaveLength(1);
    });

    it("renews a token that is about to expire, once for all who ask", async () => {
      const { auth, answers, tokenRequests, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });
      const renewed = idToken({ exp: now / 1000 + 1200 });
      answers.push(json({ id_token: renewed, refresh_token: "refresh-2" }));

      vi.setSystemTime(now + 541_000);
      const tokens = await Promise.all([auth.token(), auth.token(), auth.token()]);

      expect(tokens).toEqual([renewed, renewed, renewed]);
      expect(tokenRequests).toHaveLength(2);
      expect(tokenRequests[1]?.params).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
        client_id: clientId,
      });

      // The next renewal uses the refresh token that came with this one.
      answers.push(json({ id_token: idToken({ exp: now / 1000 + 2400 }) }));
      vi.setSystemTime(now + 1_150_000);
      await auth.token();
      expect(tokenRequests[2]?.params.refresh_token).toBe("refresh-2");

      // And keeps it when the provider does not hand out a new one.
      answers.push(json({ id_token: idToken({ exp: now / 1000 + 3600 }) }));
      vi.setSystemTime(now + 2_350_000);
      await auth.token();
      expect(tokenRequests[3]?.params.refresh_token).toBe("refresh-2");
    });

    it("honors renewBeforeMs", async () => {
      const { auth, answers, tokenRequests, signIn } = setup({ renewBeforeMs: 300_000 });
      await signIn({}, { refresh_token: "refresh-1" });
      answers.push(json({ id_token: idToken({ exp: now / 1000 + 1200 }) }));

      vi.setSystemTime(now + 301_000);
      await auth.token();

      expect(tokenRequests).toHaveLength(2);
    });

    it("asks to sign in again when the provider no longer renews the session", async () => {
      const { auth, answers, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });
      answers.push(json({ error: "invalid_grant" }, 400));

      vi.setSystemTime(now + 541_000);
      await expect(auth.token()).rejects.toThrow(SignInRequiredError);

      expect(auth.signedIn).toBe(false);
      await expect(auth.token()).rejects.toThrow(SignInRequiredError);
    });

    it("keeps the session when a renewal fails for another reason", async () => {
      const { auth, answers, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });
      const renewed = idToken({ exp: now / 1000 + 1200 });
      answers.push(new TypeError("Failed to fetch"), json({ error: "server_error" }, 500));
      answers.push(json({ id_token: renewed }));

      vi.setSystemTime(now + 541_000);
      await expect(auth.token()).rejects.toThrow(TypeError);
      await expect(auth.token()).rejects.toMatchObject({ error: "server_error" });

      expect(auth.signedIn).toBe(true);
      expect(await auth.token()).toBe(renewed);
    });

    it("without a refresh token, uses the token until it expires", async () => {
      const { auth, tokenRequests, signIn } = setup();
      await signIn();
      const token = await auth.token();

      vi.setSystemTime(now + 599_000);
      expect(await auth.token()).toBe(token);
      expect(auth.signedIn).toBe(true);

      vi.setSystemTime(now + 601_000);
      expect(auth.signedIn).toBe(false);
      await expect(auth.token()).rejects.toThrow(SignInRequiredError);
      expect(tokenRequests).toHaveLength(1);
    });

    it("can be handed to a client as it is", async () => {
      const { auth, signIn } = setup();
      await signIn();
      const requests: Headers[] = [];
      const client = createClient({
        baseUrl: "https://k8s.example.test",
        token: auth.token,
        fetch: async (_input, init) => {
          requests.push(new Headers(init?.headers));
          return json({ items: [] });
        },
      });

      await client.request({ path: "/api/v1/namespaces" });

      expect(requests[0]?.get("Authorization")).toBe(`Bearer ${await auth.token()}`);
    });
  });

  describe("the session", () => {
    it("is found again by another object over the same storage", async () => {
      const { auth, storage, signIn } = setup();
      await signIn();

      const reloaded = createOidcAuth({ issuer, clientId, storage });

      expect(reloaded.signedIn).toBe(true);
      expect(await reloaded.token()).toBe(await auth.token());
    });

    it("is kept apart from those of other issuers and clients", async () => {
      const { storage, signIn } = setup();
      await signIn();

      expect(createOidcAuth({ issuer, clientId: "other", storage }).signedIn).toBe(false);
      expect(
        createOidcAuth({ issuer: "https://other.example.test", clientId, storage }).signedIn,
      ).toBe(false);
    });

    it("is forgotten by signOut", async () => {
      const { auth, storage, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });

      auth.signOut();

      expect(auth.signedIn).toBe(false);
      expect(storage.values.size).toBe(0);
      await expect(auth.token()).rejects.toThrow(SignInRequiredError);
    });

    it("stays forgotten when signOut happens during a renewal", async () => {
      const { auth, answers, signIn } = setup();
      await signIn({}, { refresh_token: "refresh-1" });
      answers.push(() => {
        auth.signOut();
        return json({ id_token: idToken({ exp: now / 1000 + 1200 }) });
      });

      vi.setSystemTime(now + 541_000);
      await auth.token();

      expect(auth.signedIn).toBe(false);
    });
  });
});
