/**
 * Joins an API server base URL and a resource path into a request URL.
 *
 * A base URL may carry a path prefix (for example when the API server is
 * reached through a reverse proxy), so the prefix is preserved.
 */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
