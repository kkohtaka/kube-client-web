import { ApiError } from "./errors.ts";
import type { ResourceDescriptor } from "./resource.ts";
import { ResourceClient } from "./resource-client.ts";
import type { KubeObject, Status } from "./types.ts";
import { joinUrl } from "./url.ts";

/** A bearer token, or a function that returns the current one. */
export type TokenSource = string | (() => string | Promise<string>);

export type QueryValue = string | number | boolean | undefined;

export interface ClientConfig {
  /**
   * Address of the API server, for example `https://127.0.0.1:6443`. May carry
   * a path prefix when the server is reached through a reverse proxy.
   */
  baseUrl: string;
  /**
   * Bearer token sent with every request. Pass a function to supply a token
   * that changes over time; it is called once per request.
   */
  token?: TokenSource | undefined;
  /** `fetch` implementation to use. Defaults to the global one. */
  fetch?: typeof globalThis.fetch | undefined;
}

export interface RequestOptions {
  /** HTTP method. Defaults to `GET`. */
  method?: string | undefined;
  /** Path relative to the API server root, for example `/api/v1/pods`. */
  path: string;
  /** Query parameters. Entries whose value is `undefined` are omitted. */
  query?: Record<string, QueryValue> | undefined;
  /** Request body. Serialized as JSON. */
  body?: unknown;
  /** `Content-Type` of the body. Defaults to `application/json`. */
  contentType?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class KubeClient {
  readonly #baseUrl: string;
  readonly #token: TokenSource | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ClientConfig) {
    this.#baseUrl = config.baseUrl;
    this.#token = config.token;
    // Calling a detached `window.fetch` throws in browsers, so keep it bound.
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Returns a typed client for one resource. */
  resource<T extends KubeObject>(descriptor: ResourceDescriptor<T>): ResourceClient<T> {
    return new ResourceClient<T>(this, descriptor);
  }

  /** Sends a request and returns the parsed JSON body. Throws {@link ApiError} on a non-2xx status. */
  async request<T>(options: RequestOptions): Promise<T> {
    const response = await this.fetchResponse(options);
    return (await response.json()) as T;
  }

  /**
   * Sends a request and returns the raw response once the status is known to
   * be 2xx, without reading the body. Throws {@link ApiError} otherwise.
   */
  async fetchResponse(options: RequestOptions): Promise<Response> {
    const headers = new Headers({ Accept: "application/json" });
    const token = typeof this.#token === "function" ? await this.#token() : this.#token;
    if (token !== undefined) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const init: RequestInit = { method: options.method ?? "GET", headers };
    if (options.body !== undefined) {
      headers.set("Content-Type", options.contentType ?? "application/json");
      init.body = JSON.stringify(options.body);
    }
    if (options.signal !== undefined) {
      init.signal = options.signal;
    }

    const response = await this.#fetch(this.#url(options), init);
    if (!response.ok) {
      throw await toApiError(response);
    }
    return response;
  }

  #url(options: RequestOptions): string {
    const url = joinUrl(this.#baseUrl, options.path);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    const query = params.toString();
    return query ? `${url}?${query}` : url;
  }
}

export function createClient(config: ClientConfig): KubeClient {
  return new KubeClient(config);
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  let body: Status | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "kind" in parsed) {
      if (parsed.kind === "Status") {
        body = parsed as Status;
      }
    }
  } catch {
    // Not JSON: a proxy or load balancer answered instead of the API server.
  }
  const fallback = text.trim() || response.statusText || `HTTP ${response.status}`;
  return new ApiError(response.status, body, fallback);
}
