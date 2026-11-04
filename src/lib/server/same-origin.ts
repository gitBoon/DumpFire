/**
 * same-origin.ts — writes from DumpFire's own pages alone: the gate's rule for
 * every write outside /api/v1/ (card 2700), and the local guard of a
 * participant's four POSTs (card 2677, decision 24, R1), over the same two
 * predicates, the same three messages and in one order.
 *
 * SvelteKit refuses a cross-site POST only when its `Content-Type` is a form's
 * (urlencoded, multipart, text/plain: `is_form_content_type` in
 * @sveltejs/kit/src/utils/http.js), and not at all under `vite dev`; and
 * `readBody` reads JSON whatever the type. So a cross-site `no-cors` POST with
 * no `Content-Type` ran every handler that reads no body, the superadmin's
 * database reset among them. `SameSite=Lax` on the session cookie does not
 * stop a same-site page on a sibling subdomain, and a personal link's routes
 * have no cookie to lean on at all.
 *
 * The gate (`refuseCrossSiteWrite`, in `handleRequest`, after the v1 branch and
 * before the session cookie is read) asks, of every method but GET and HEAD:
 *
 *   1. outside /api/v1/, pages and form actions included, a request the
 *      server makes of itself is refused, 403: a load's `fetch` carries the
 *      server's own `Origin` and the caller's cookie, so it would pass the
 *      next rule;
 *   2. outside /api/v1/, pages and form actions included, a request the
 *      browser does not say comes from this origin is refused, 403;
 *   3. under /api/ (not /api/v1/), but for the two uploads, a request that does
 *      not say it is JSON, body or not, is refused, 415.
 *
 * `requireSameOriginJson` stays the first thing each of the participant's four
 * POSTs does, before the address it counts, `requireUser` or the body, in the
 * gate's order: 403, then 415. Through the gate it never fires; it is kept on
 * the routes where a personal link is the only credential. Nothing here reads
 * more than the request's headers, its address and whether it is a
 * sub-request, takes a caller or reads a row, so it is no service.
 */
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { printable } from './logger';

export const CROSS_SITE_REFUSED = 'Cross-site requests are refused';
export const SUB_REQUEST_REFUSED = 'A write may not be made by the server of itself';
export const JSON_ONLY = 'This route takes JSON only';

/**
 * The writes under /api/ that take a body other than JSON, by
 * `METHOD /route-id` as `body-limits.ts` keys its table, with why. Each is
 * still held to rules 1 and 2; each handler's own type check, before it reads
 * the body, is the only type check on it.
 */
export const UPLOADS: Readonly<Record<string, string>> = {
	'POST /api/cards/[id]/attachments':
		'A card attachment, sent as multipart/form-data; the handler refuses any other type, 400 (The request body is not a form)',
	'POST /api/admin/import':
		'A .db backup, sent as application/octet-stream or application/x-sqlite3; the handler refuses any other type, 400'
};

/**
 * Whether the browser says the request comes from this origin:
 * `Sec-Fetch-Site: same-origin` when the header is sent, which then decides
 * alone (`same-site`, `cross-site`, `none` and anything else are refused);
 * where it is not sent, an `Origin` that is exactly this server's own
 * (`url.origin`, which is `ORIGIN` behind the proxy). With neither, no.
 */
export function fromThisOrigin(request: Request, url: URL): boolean {
	const site = request.headers.get('sec-fetch-site');
	if (site !== null) return site === 'same-origin';
	return request.headers.get('origin') === url.origin;
}

/** Whether the request says its body is JSON: `application/json`, its parameters aside. */
export function saysJson(request: Request): boolean {
	return (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/** What a refusal's log line carries: each header as it was sent, cut and made printable, or null. */
type Seen = { secFetchSite: string | null; origin: string | null };

/** The two headers of each answer `refuseCrossSiteWrite` made, for `refusalSeen`. */
const seenOf = new WeakMap<Response, Seen>();

/** A header's value for the log: its first 100 characters, made printable; null when it is absent. */
function forTheLog(value: string | null): string | null {
	return value === null ? null : printable(value.slice(0, 100));
}

/**
 * The answer, recorded with the request's two headers for the log line. Each
 * answer is made where it is given, its status written as a number, so that
 * tests/error-shape.test.ts reads all three.
 */
function recorded(request: Request, response: Response): Response {
	seenOf.set(response, {
		secFetchSite: forTheLog(request.headers.get('sec-fetch-site')),
		origin: forTheLog(request.headers.get('origin'))
	});
	return response;
}

/**
 * The gate's: null to let the request on, or its 403 or 415, in the order of
 * the module's header. `path` is the routed path (`routedPath` in
 * hooks.server.ts): a route's id, or the decoded address of a path that is no
 * route. Answered whatever the `Accept` header, as JSON.
 */
export function refuseCrossSiteWrite(event: Pick<RequestEvent, 'request' | 'url' | 'isSubRequest'>, path: string): Response | null {
	const { request } = event;
	const method = request.method;
	if (method === 'GET' || method === 'HEAD') return null;
	if (path.startsWith('/api/v1/')) return null;

	if (event.isSubRequest) return recorded(request, json({ message: SUB_REQUEST_REFUSED }, { status: 403 }));
	const internal = path.startsWith('/api/');
	if (!fromThisOrigin(request, event.url)) return recorded(request, json({ message: CROSS_SITE_REFUSED }, { status: 403 }));
	if (!internal) return null;
	if (Object.hasOwn(UPLOADS, `${method} ${path}`)) return null;
	if (!saysJson(request)) return recorded(request, json({ message: JSON_ONLY }, { status: 415 }));
	return null;
}

/** What the log line carries for an answer of `refuseCrossSiteWrite`, or undefined for any other. */
export function refusalSeen(response: Response): Seen | undefined {
	return seenOf.get(response);
}

/**
 * Card 2677's: 403 unless the browser says the request comes from this origin
 * (`fromThisOrigin`); then 415 unless it says its body is JSON (`saysJson`).
 * The gate's order, so a request that fails both is 403 from either.
 */
export function requireSameOriginJson(event: Pick<RequestEvent, 'request' | 'url'>): void {
	if (!fromThisOrigin(event.request, event.url)) error(403, CROSS_SITE_REFUSED);
	if (!saysJson(event.request)) error(415, JSON_ONLY);
}
