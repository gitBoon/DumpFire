/**
 * gate-answers.ts — what the gate in hooks.server.ts reads a request to be,
 * the answers it gives of its own when it sends a request away, and the
 * headers it puts on every answer it gives.
 *
 * The gate used to throw its redirects. SvelteKit turns a thrown redirect
 * into an answer after `handle` has returned, so the gate never held that
 * answer: it could put no header on it and logged it from a catch. The gate
 * now makes the answer itself, here, and returns it like any other, so that
 * every answer it gives goes through the one place that heads it and the one
 * place that logs it.
 *
 * Made here, the answer has to be the one SvelteKit would have made. That is
 * not always a 303: a page's own script that asks for a page's data, or posts
 * one of its forms, is told where to go in JSON, and follows that itself. So
 * `sendTo` makes each of the three as SvelteKit does, and
 * tests/gate.test.ts holds each against SvelteKit's own, so that an upgrade
 * which changes one fails there by name.
 *
 * Each function works on the one request it is given and keeps nothing but a
 * note of where an answer it made sends the caller, for the log.
 */
import { json, type RequestEvent } from '@sveltejs/kit';

/**
 * Which of `types` an Accept header asks for first, or undefined if it asks
 * for none of them.
 *
 * SvelteKit's own choice, copied line for line: `negotiate` in
 * @sveltejs/kit/src/utils/http.js, which it does not export. SvelteKit makes
 * this choice between JSON and a page for an error, and between JSON and a
 * redirect for a form a page posts. The gate asks the same question and must
 * get the same answer, so it asks it the same way. tests/gate.test.ts runs
 * both on the same headers.
 */
export function preferredType(accept: string, types: string[]): string | undefined {
	const parts: { type: string; subtype: string; q: number; i: number }[] = [];

	accept.split(',').forEach((str, i) => {
		const match = /([^/ \t]+)\/([^; \t]+)[ \t]*(?:;[ \t]*q=([0-9.]+))?/.exec(str);

		// A part that is no type at all is ignored, as SvelteKit ignores it.
		if (match) {
			const [, type, subtype, q = '1'] = match;
			parts.push({ type, subtype, q: +q, i });
		}
	});

	parts.sort((a, b) => {
		if (a.q !== b.q) return b.q - a.q;
		if ((a.subtype === '*') !== (b.subtype === '*')) return a.subtype === '*' ? 1 : -1;
		if ((a.type === '*') !== (b.type === '*')) return a.type === '*' ? 1 : -1;
		return a.i - b.i;
	});

	let accepted: string | undefined;
	let minPriority = Infinity;

	for (const mimetype of types) {
		const [type, subtype] = mimetype.split('/');
		const priority = parts.findIndex(
			(part) => (part.type === type || part.type === '*') && (part.subtype === subtype || part.subtype === '*')
		);

		if (priority !== -1 && priority < minPriority) {
			accepted = mimetype;
			minPriority = priority;
		}
	}

	return accepted;
}

/**
 * Whether this request is a browser going to an address, as opposed to a
 * page's script, or any other program, asking it for something.
 *
 * The browser says so in `Sec-Fetch-Mode: navigate`, which every current
 * browser sends with a navigation and with nothing else. One that does not
 * send it is known by what it asks for: a navigation asks for a page, and
 * prefers `text/html` to JSON, as SvelteKit reads the header. A page's
 * `fetch` asks for `*` (anything), which SvelteKit reads as JSON; an
 * `EventSource` asks for an event stream and an `<img>` for an image, which
 * are neither. A request that sends no Accept header at all is not a
 * navigation.
 *
 * It decides whether a request to an internal API route that has no session
 * is answered 401, which a script can act on, or sent to the login page,
 * which a person can: an attachment opened in a new tab, the milestone PDF,
 * an export's download.
 */
export function isNavigation(request: Request): boolean {
	if (request.headers.get('sec-fetch-mode') === 'navigate') return true;
	return preferredType(request.headers.get('accept') ?? '*/*', ['application/json', 'text/html']) === 'text/html';
}

/**
 * Whether this is a page's own script posting one of the page's forms
 * (`use:enhance`), which is answered in JSON: SvelteKit's
 * `is_action_json_request`, in @sveltejs/kit/src/runtime/server/page/actions.js.
 */
function isFormPostedByScript(request: Request): boolean {
	return (
		request.method === 'POST' &&
		preferredType(request.headers.get('accept') ?? '*/*', ['application/json', 'text/html']) === 'application/json'
	);
}

/** Where each answer `sendTo` made sends the caller. Read by the log, with `whereSent`. */
const sentElsewhere = new WeakMap<Response, string>();

/**
 * The answer that sends this request on to `location`: what SvelteKit
 * would have made of `redirect(303, location)` thrown out of `handle`
 * (the catch at the end of `respond` in
 * @sveltejs/kit/src/runtime/server/respond.js).
 *
 *   - A page's script asking for the page's data (`/admin/__data.json`) is
 *     answered 200 with `{ type: 'redirect', location }`, and goes there
 *     itself: `redirect_json_response` in runtime/server/data/index.js.
 *     SvelteKit would remake a 303 the gate returned into this by itself,
 *     but after the gate, with none of the security headers on it.
 *   - A page's script posting one of the page's forms is answered 200 with
 *     `{ type: 'redirect', status: 303, location }`: `action_json_redirect`
 *     in runtime/server/page/actions.js. A 303 followed by `fetch` would
 *     hand it the next page's HTML where it expects JSON. Every route outside
 *     /api/ is a page: tests/access-every-route.test.ts fails on a
 *     `+server.ts` anywhere else.
 *   - Anything else is a 303 with `Location`, and no body.
 *
 * The gate sends nobody anywhere with a cookie set, so there are none to
 * carry over, as SvelteKit's catch carries them.
 */
export function sendTo(event: RequestEvent, location: string): Response {
	let answer: Response;
	if (event.isDataRequest) {
		answer = json({ type: 'redirect', location }, { headers: { 'cache-control': 'private, no-store' } });
	} else if (event.route.id !== null && !event.route.id.startsWith('/api/') && isFormPostedByScript(event.request)) {
		answer = json({ type: 'redirect', status: 303, location });
	} else {
		answer = new Response(null, { status: 303, headers: { location } });
	}
	sentElsewhere.set(answer, location);
	return answer;
}

/** Where the gate sent the caller with this answer, if it was made by `sendTo`; otherwise null. */
export function whereSent(response: Response): string | null {
	return sentElsewhere.get(response) ?? null;
}

/**
 * The answer to a page's script that asks an internal API route for
 * something with no session: 401, in JSON, in the words the routes'
 * own guards use. It was a 303 to the login page, which `fetch` followed:
 * the script was handed the login page's HTML with a 200, and a page whose
 * session had ended went on as if the request had worked. A 401 is a failure
 * it can see, and `src/hooks.client.ts` sends a signed-in page to the login
 * page on it.
 */
export function notSignedIn(): Response {
	return json({ message: 'Not authenticated' }, { status: 401 });
}

/**
 * The headers every answer the gate gives carries, unless the answer has the
 * header already: an attachment is served with its own
 * `X-Content-Type-Options` and `Content-Security-Policy: sandbox`
 * ($lib/server/uploads.ts), and a header a handler set is never replaced.
 * They are put on by `secured`, at the end of `handle`, on the gate's own
 * answers (its 401s, 404s, 413s and 429s and its redirects) as on a
 * handler's and a page's, whoever is calling. They were on the answers to a
 * signed-in caller only, and under /api/v1/ there was `nosniff` alone: the
 * login page, set-up, the invite page, every redirect and the gate's own
 * refusals carried none.
 *
 * `X-XSS-Protection: 0` switches off the filter that old browsers ran over a
 * page, which is what current advice is: the filter itself could be used to
 * make a page leak, and every current browser has dropped it. It was
 * `1; mode=block`.
 */
export const SECURITY_HEADERS: readonly [name: string, value: string][] = [
	['X-Content-Type-Options', 'nosniff'],
	['X-Frame-Options', 'DENY'],
	['Referrer-Policy', 'strict-origin-when-cross-origin'],
	['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
	['X-XSS-Protection', '0']
];

/**
 * The pages another site may show in a frame, by route id, exactly: the
 * public request form and the two pages its mails link to, in case the form
 * is embedded in an intranet page. They carry every header but
 * `X-Frame-Options`. Every other page, the login page included, refuses to be
 * framed. No `Content-Security-Policy: frame-ancestors` is sent: there is no
 * policy for the application to add it to.
 */
export const FRAMEABLE_ROUTES: ReadonlySet<string> = new Set(['/request', '/request/[id]/confirm', '/request/[id]/reply']);

/**
 * `response`, with each of `SECURITY_HEADERS` it does not already carry, but
 * `X-Frame-Options` on a route of `FRAMEABLE_ROUTES`. The one place they are
 * set.
 *
 * What never passes through `handle` cannot be headed here, and is the
 * reverse proxy's to head (docs/deployment.md): in a built server every
 * static file, which the adapter serves before the gate is called; and what
 * SvelteKit answers before it calls the gate or after the gate has failed,
 * which is the refusal of a form posted from another site, the 400 for an
 * address that cannot be decoded, the redirect that adds or removes a
 * trailing slash, the 404 for any other path that begins `/_app` (but a call
 * to a remote function, which the gate answers 404 itself), and the 500 for
 * a fault in the gate itself.
 */
export function secured(response: Response, routeId: string | null): Response {
	const frameable = routeId !== null && FRAMEABLE_ROUTES.has(routeId);
	for (const [name, value] of SECURITY_HEADERS) {
		if (name === 'X-Frame-Options' && frameable) continue;
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
}
