/**
 * Resolve the WebSocket URL for the current runtime.
 *
 * `NEXT_PUBLIC_WS_URL` is baked into the client bundle at build time and can be
 * missing or empty in self-hosted deployments. In that case derive the URL from
 * the page origin and route through the Next.js `/ws` rewrite, so realtime works
 * on localhost, LAN addresses and custom domains without extra configuration.
 */
export function deriveWsUrl(
  location?: { protocol: string; host: string },
): string | undefined {
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  const pageLocation =
    location ?? (typeof window === "undefined" ? undefined : window.location);
  if (!pageLocation) {
    return undefined;
  }
  const protocol = pageLocation.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${pageLocation.host}/ws`;
}
