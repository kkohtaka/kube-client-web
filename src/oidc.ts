/**
 * Thrown when the OpenID provider refuses a request, or answers with
 * something that cannot be used.
 */
export class OidcError extends Error {
  override readonly name: string = "OidcError";
  /** Error code from the provider, for example `access_denied`, when it sent one. */
  readonly error: string | undefined;

  constructor(message: string, error?: string, options?: ErrorOptions) {
    super(message, options);
    this.error = error;
  }
}

/**
 * Thrown by {@link OidcAuth.token} when there is no usable session: nobody
 * has signed in, or the session ended and cannot be renewed. Call
 * {@link OidcAuth.signIn} to get a new one.
 */
export class SignInRequiredError extends Error {
  override readonly name: string = "SignInRequiredError";
}

/** Where {@link OidcAuth} keeps its state. `sessionStorage` and `localStorage` fit. */
export interface OidcStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OidcConfig {
  /**
   * The provider's issuer URL, exactly as the API server has it in
   * `--oidc-issuer-url`. Its configuration is read from
   * `/.well-known/openid-configuration` below this URL.
   */
  issuer: string;
  /** The client the API server expects tokens for (`--oidc-client-id`). */
  clientId: string;
  /**
   * Where the provider sends the browser back to after signing in. It must be
   * registered with the provider. Defaults to the current page without query
   * and fragment.
   */
  redirectUri?: string | undefined;
  /**
   * Scopes to ask for. `openid` is always included. Add `offline_access` for
   * a session that can be renewed without sending the user to the provider
   * again. Defaults to `["openid"]`.
   */
  scopes?: readonly string[] | undefined;
  /**
   * Renew the token when it has less than this long to live. Defaults to
   * 60 seconds.
   */
  renewBeforeMs?: number | undefined;
  /**
   * Where the session is kept. It has to outlive the trip to the provider and
   * back. Defaults to `sessionStorage`: the session ends with the tab.
   */
  storage?: OidcStorage | undefined;
  /** `fetch` implementation to use. Defaults to the global one. */
  fetch?: typeof globalThis.fetch | undefined;
  /** How to send the browser to the provider. Defaults to `location.assign`. */
  navigate?: ((url: string) => void) | undefined;
}

export interface SignInOptions {
  /**
   * Further parameters for the provider's sign-in page, for example
   * `{ prompt: "login" }` or `{ login_hint: "jane@example.com" }`.
   */
  params?: Readonly<Record<string, string>> | undefined;
}

interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported?: string[];
}

/** What is remembered while the user is at the provider. */
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
}

interface Session {
  idToken: string;
  refreshToken?: string | undefined;
  /** When the ID token expires, in milliseconds since the epoch on this browser's clock. */
  expiresAt: number;
}

/**
 * Signs a user in with an OpenID Connect provider and supplies the ID token
 * that a Kubernetes API server configured for that provider accepts.
 *
 * It uses the authorization code flow with PKCE, as a public client: there is
 * no client secret, and the tokens only ever reach this page.
 *
 * ```ts
 * const auth = createOidcAuth({ issuer, clientId, scopes: ["offline_access"] });
 * await auth.completeSignIn(); // on every page load
 * if (!auth.signedIn) {
 *   await auth.signIn(); // leaves the page
 * }
 * const client = createClient({ baseUrl, token: auth.token });
 * ```
 */
export class OidcAuth {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #redirectUri: string | undefined;
  readonly #scopes: readonly string[];
  readonly #renewBeforeMs: number;
  readonly #storage: OidcStorage;
  readonly #fetch: typeof globalThis.fetch;
  readonly #navigate: (url: string) => void;
  readonly #key: string;
  #metadata: Promise<ProviderMetadata> | undefined;
  #renewal: Promise<string> | undefined;

  constructor(config: OidcConfig) {
    this.#issuer = config.issuer;
    this.#clientId = config.clientId;
    this.#redirectUri = config.redirectUri;
    this.#scopes = [...new Set(["openid", ...(config.scopes ?? [])])];
    this.#renewBeforeMs = config.renewBeforeMs ?? 60_000;
    this.#storage = config.storage ?? globalThis.sessionStorage;
    // Calling a detached `window.fetch` throws in browsers, so keep it bound.
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#navigate = config.navigate ?? ((url) => globalThis.location.assign(url));
    // Several providers or clients on one origin must not see each other's state.
    this.#key = `kube-client-web.oidc:${config.issuer}:${config.clientId}`;
  }

  /**
   * Sends the browser to the provider to sign in. The page is left; the
   * provider sends the browser back to `redirectUri`, where
   * {@link completeSignIn} takes over.
   */
  async signIn(options: SignInOptions = {}): Promise<void> {
    const metadata = await this.#discover();
    const supported = metadata.code_challenge_methods_supported;
    if (supported && !supported.includes("S256")) {
      throw new OidcError("the provider does not support PKCE with S256");
    }

    const pending: Pending = {
      state: randomString(),
      nonce: randomString(),
      verifier: randomString(),
      redirectUri: this.#redirectUri ?? currentPage(),
    };
    this.#write("pending", pending);

    const url = new URL(metadata.authorization_endpoint);
    for (const [name, value] of Object.entries({
      ...options.params,
      response_type: "code",
      client_id: this.#clientId,
      redirect_uri: pending.redirectUri,
      scope: this.#scopes.join(" "),
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await sha256(pending.verifier),
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(name, value);
    }
    this.#navigate(url.href);
  }

  /**
   * Finishes a sign-in if the browser has just come back from the provider.
   * Call it on every load of the page at `redirectUri`, before anything else
   * reads the URL: it takes the provider's answer out of the address bar.
   *
   * Resolves with `true` when a session was started and `false` when the URL
   * holds no answer to a sign-in started here. Throws an {@link OidcError}
   * when the provider reports that signing in failed.
   *
   * @param url The address the provider sent the browser to. Defaults to the
   *   current one.
   */
  async completeSignIn(url: string = globalThis.location.href): Promise<boolean> {
    const answer = new URL(url);
    const params = answer.searchParams;
    const pending = this.#read<Pending>("pending");
    const state = params.get("state");
    if (!pending || state === null || state !== pending.state) {
      return false;
    }
    // A code can be used once. Forget the request first, so that a second
    // call for the same URL does nothing.
    this.#remove("pending");
    removeAnswer(answer);

    const error = params.get("error");
    if (error !== null) {
      throw new OidcError(params.get("error_description") ?? error, error);
    }
    const code = params.get("code");
    if (code === null) {
      throw new OidcError("the provider's answer has neither a code nor an error");
    }

    const session = await this.#requestTokens(
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      },
      pending.nonce,
    );
    this.#write("session", session);
    return true;
  }

  /**
   * Resolves with a valid ID token, renewing it first when it is about to
   * expire and the provider issued a refresh token. Throws a
   * {@link SignInRequiredError} when there is no session, or it has ended
   * and cannot be renewed.
   *
   * It is bound to its object, so it can be passed on as it is:
   * `createClient({ baseUrl, token: auth.token })`.
   */
  readonly token = (): Promise<string> => {
    const session = this.#read<Session>("session");
    if (!session) {
      return Promise.reject(new SignInRequiredError("not signed in"));
    }
    if (session.expiresAt - Date.now() > this.#renewBeforeMs) {
      return Promise.resolve(session.idToken);
    }
    // Requests that find the token expired at the same time share one
    // renewal: a provider may accept a refresh token only once.
    this.#renewal ??= this.#renew().finally(() => {
      this.#renewal = undefined;
    });
    return this.#renewal;
  };

  /**
   * Whether there is a session whose token is valid or can be renewed. A
   * renewal can still fail, for example when the provider has ended the
   * session; {@link token} then throws a {@link SignInRequiredError}.
   */
  get signedIn(): boolean {
    const session = this.#read<Session>("session");
    return (
      session !== undefined &&
      (session.refreshToken !== undefined || session.expiresAt > Date.now())
    );
  }

  /**
   * The claims of the current ID token, such as `sub`, `email` or `groups`,
   * for display. The API server decides by its own reading of the token.
   */
  get claims(): Record<string, unknown> | undefined {
    const session = this.#read<Session>("session");
    return session && decodeClaims(session.idToken);
  }

  /**
   * Forgets the session in this browser. The user stays signed in at the
   * provider, and a token already handed out stays valid until it expires.
   */
  signOut(): void {
    this.#remove("session");
    this.#remove("pending");
  }

  /**
   * Renews the session, one tab at a time: tabs that share their storage
   * share the refresh token, and a provider may accept it only once.
   */
  #renew(): Promise<string> {
    return exclusively(`${this.#key}:renew`, async () => {
      // Read again: another tab may have renewed the session in the meantime.
      const session = this.#read<Session>("session");
      if (!session) {
        throw new SignInRequiredError("not signed in");
      }
      if (session.expiresAt - Date.now() > this.#renewBeforeMs) {
        return session.idToken;
      }
      return this.#renewWith(session);
    });
  }

  async #renewWith(session: Session): Promise<string> {
    if (session.refreshToken === undefined) {
      if (session.expiresAt > Date.now()) {
        // Nothing to renew it with, but still good for a moment.
        return session.idToken;
      }
      this.#remove("session");
      throw new SignInRequiredError("the session has expired");
    }
    let renewed: Session;
    try {
      renewed = await this.#requestTokens({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });
    } catch (error) {
      if (error instanceof OidcError && error.error === "invalid_grant") {
        // The provider no longer honors the refresh token. Where tabs cannot
        // take turns, that may be because another one has just used it.
        const current = this.#read<Session>("session");
        if (current && current.refreshToken !== session.refreshToken) {
          if (current.expiresAt > Date.now()) {
            return current.idToken;
          }
        } else {
          this.#remove("session");
        }
        throw new SignInRequiredError("the session has ended", { cause: error });
      }
      throw error;
    }
    // A provider that does not hand out a new refresh token lets the old one be used again.
    renewed.refreshToken ??= session.refreshToken;
    // Unless the user signed out in the meantime.
    if (this.#read<Session>("session")) {
      this.#write("session", renewed);
    }
    return renewed.idToken;
  }

  /** Asks the token endpoint for tokens and checks the ID token it returns. */
  async #requestTokens(grant: Record<string, string>, nonce?: string): Promise<Session> {
    const metadata = await this.#discover();
    const response = await this.#fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { Accept: "application/json" },
      body: new URLSearchParams({ ...grant, client_id: this.#clientId }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      const error = typeof body?.error === "string" ? body.error : undefined;
      const description =
        typeof body?.error_description === "string" ? body.error_description : undefined;
      throw new OidcError(
        description ?? error ?? `the token request failed with status ${response.status}`,
        error,
      );
    }
    const idToken = body?.id_token;
    if (typeof idToken !== "string") {
      throw new OidcError("the provider's answer has no ID token");
    }

    // The token came straight from the provider over TLS, which vouches for
    // it as well as its signature would; the API server checks the signature.
    // What remains to check is that it is meant for this client and request.
    const claims = decodeClaims(idToken);
    if (claims.iss !== metadata.issuer) {
      throw new OidcError("the ID token is from another issuer");
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.#clientId)) {
      throw new OidcError("the ID token is for another client");
    }
    if (nonce !== undefined && claims.nonce !== nonce) {
      throw new OidcError("the ID token does not belong to this sign-in");
    }
    if (typeof claims.exp !== "number") {
      throw new OidcError("the ID token does not say when it expires");
    }
    // The provider's clock and this browser's may disagree by more than the
    // token lives. The token has just been issued, so count its lifetime
    // from now instead of comparing its expiry with the local clock.
    const lifetime = typeof claims.iat === "number" ? claims.exp - claims.iat : 0;
    const refreshToken = body?.refresh_token;
    return {
      idToken,
      refreshToken: typeof refreshToken === "string" ? refreshToken : undefined,
      expiresAt: lifetime > 0 ? Date.now() + lifetime * 1000 : claims.exp * 1000,
    };
  }

  #discover(): Promise<ProviderMetadata> {
    this.#metadata ??= this.#fetchMetadata().catch((error: unknown) => {
      // Try again next time instead of remembering the failure.
      this.#metadata = undefined;
      throw error;
    });
    return this.#metadata;
  }

  async #fetchMetadata(): Promise<ProviderMetadata> {
    const url = `${this.#issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const response = await this.#fetch(url, { headers: { Accept: "application/json" } });
    const body = await readJson(response);
    if (!response.ok || !body) {
      throw new OidcError(
        `could not read the provider's configuration: status ${response.status} from ${url}`,
      );
    }
    if (body.issuer !== this.#issuer) {
      throw new OidcError(
        `the provider at ${this.#issuer} calls itself ${String(body.issuer)}; use that as the issuer`,
      );
    }
    if (
      typeof body.authorization_endpoint !== "string" ||
      typeof body.token_endpoint !== "string"
    ) {
      throw new OidcError("the provider's configuration lacks an endpoint");
    }
    return body as unknown as ProviderMetadata;
  }

  #read<T>(name: string): T | undefined {
    const value = this.#storage.getItem(`${this.#key}:${name}`);
    if (value === null) {
      return undefined;
    }
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  #write(name: string, value: unknown): void {
    this.#storage.setItem(`${this.#key}:${name}`, JSON.stringify(value));
  }

  #remove(name: string): void {
    this.#storage.removeItem(`${this.#key}:${name}`);
  }
}

export function createOidcAuth(config: OidcConfig): OidcAuth {
  return new OidcAuth(config);
}

/**
 * Runs one caller at a time among the pages of this origin, where the browser
 * offers locks for that. It does on HTTPS and on localhost.
 */
function exclusively<R>(name: string, run: () => Promise<R>): Promise<R> {
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(name, run) : run();
}

function currentPage(): string {
  const { origin, pathname } = globalThis.location;
  return origin + pathname;
}

/** Takes the provider's answer out of the address bar, when the URL is the page's own. */
function removeAnswer(answer: URL): void {
  const { history, location } = globalThis;
  if (!history || !location || location.href !== answer.href) {
    return;
  }
  const cleaned = new URL(answer);
  for (const name of [
    "code",
    "state",
    "iss",
    "session_state",
    "error",
    "error_description",
    "error_uri",
  ]) {
    cleaned.searchParams.delete(name);
  }
  history.replaceState(history.state, "", cleaned);
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function decodeClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split(".")[1] ?? "";
    const bytes = Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims === "object" && claims !== null) {
      return claims as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new OidcError("the ID token cannot be read");
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 256 random bits, in the characters allowed for a PKCE verifier. */
function randomString(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text: string): Promise<string> {
  return base64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  );
}
