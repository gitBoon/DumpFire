/**
 * same-origin.ts — a JSON route that takes JSON from DumpFire's own pages
 * alone (card 2677, decision 24, R1).
 *
 * SvelteKit refuses a cross-site POST only when its `Content-Type` is a form's
 * (urlencoded, multipart, text/plain: `is_form_content_type` in
 * @sveltejs/kit/src/utils/http.js), and `readBody` reads JSON whatever the
 * type. So a cross-site `no-cors` POST with no `Content-Type`, or with
 * `text/plain`, reached a JSON handler. `SameSite=Lax` on the session cookie
 * does not stop a same-site page on a sibling subdomain, and a personal link's
 * routes have no cookie to lean on at all.
 *
 * `requireSameOriginJson` is the first thing each of the participant's four
 * POSTs does, before the address it counts, `requireUser` or the body: a
 * refused request reads no body, no row and no bucket, so a cross-site request
 * is never counted as a wrong link. It reads the request's headers and its
 * address alone, takes no caller and reads no row, so it is no service. The
 * gate's own check for every JSON route is its own card (plan section 7); this
 * is written so that the gate can adopt it.
 */
import { error, type RequestEvent } from '@sveltejs/kit';

/**
 * 415 unless the request says its body is JSON (`application/json`, its
 * parameters aside); then 403 unless the browser says it comes from this
 * origin: `Sec-Fetch-Site: same-origin`, or, where a browser sends no
 * `Sec-Fetch-Site`, an `Origin` that is this server's own. A request with
 * neither header is refused.
 */
export function requireSameOriginJson(event: Pick<RequestEvent, 'request' | 'url'>): void {
	const type = (event.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (type !== 'application/json') error(415, 'This route takes JSON only');

	const site = event.request.headers.get('sec-fetch-site');
	const sameOrigin = site !== null ? site === 'same-origin' : event.request.headers.get('origin') === event.url.origin;
	if (!sameOrigin) error(403, 'Cross-site requests are refused');
}
