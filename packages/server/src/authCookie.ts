/**
 * The dashboard session cookie's NAME, per listening port.
 *
 * Browsers scope cookies by host, not port, so two instances on one machine
 * (:3100 and a QA :3189) used to share ONE `autonomos_token` cookie — logging
 * into one silently logged the other out. The name now carries the port, and
 * the legacy name is still READ so an upgrade never logs anyone out (it is
 * just no longer written).
 */
export const LEGACY_AUTH_COOKIE = "autonomos_token";

/** `autonomos_token_<port>`, or the legacy name when the port isn't known. */
export function authCookieName(port: number | null | undefined): string {
  return port ? `${LEGACY_AUTH_COOKIE}_${port}` : LEGACY_AUTH_COOKIE;
}

/** The link that signs a browser in: the token rides in the FRAGMENT, which
 *  browsers never send to the server, a proxy, or a Referer header. */
export function signInLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/#token=${encodeURIComponent(token)}`;
}
