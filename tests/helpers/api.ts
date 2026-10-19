/**
 * Call an API route handler directly, by method and path.
 *
 *     const res = await api('PUT', `/api/cards/${card.id}`, { user, body: { title: 'x' } });
 *     expect(res.status).toBe(403);
 *
 * The path is matched against the real route tree under `src/routes/api`, so a
 * test names the URL a client would use and a renamed or deleted route fails
 * the test instead of silently testing nothing. No server is started and
 * `hooks.server.ts` does not run: the handler receives exactly the caller the
 * test gives it. That is the caller the handler must defend against — the hook
 * turns an anonymous request away from most paths before it gets here, but it
 * does not know which board a card is on.
 *
 * One thing the hook does is done here as well. It guards the reading of a
 * request's body (`guardBody`), so that a body which is missing,
 * is not JSON or is not an object is a 400 the handler never sees. Every
 * request built here is guarded the same way, and so a handler is given what
 * it is given on the wire. What the hook does with a request as a whole is
 * tested through `gate()` in ./gate.ts.
 *
 * `user: null` is an anonymous caller reaching the handler, which is what
 * happens for real on the public paths (`/api/requests/...`).
 *
 * The cookies a handler reads are the ones in the request's `cookie` header,
 * as SvelteKit reads them, and none when it has none. The routes that ask for
 * a current password count wrong ones against the session cookie, so a test
 * of one sends it:
 *
 *     api('PUT', '/api/account/email', { user, body, headers: { cookie: `${SESSION_COOKIE_NAME}=my-laptop` } });
 *
 * The cookie is not looked up: the handler is given `user` as its caller, as
 * the gate would give it the session's account.
 *
 * Nor is a credential set: `locals.credential` is left undefined, as for a
 * request no gate let in, unless the test gives one. A handler that tells two
 * sessions of one account apart is given each in turn (card 2251):
 *
 *     api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user, credential: { kind: 'session', token: 'laptop' } });
 */
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import type { Credential, SessionUser } from '$lib/server/auth';
import { guardBody } from '$lib/server/api-errors';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type RouteModule = Partial<Record<Method, (event: RequestEvent) => Response | Promise<Response>>>;

/**
 * What a `+server.ts` may export that SvelteKit answers a request with. The
 * five of `Method` are the ones `api()` calls. No route has one of the other
 * three, and `routeMethods()` reports one if a route is given it, so that it
 * is not a handler nobody has looked at.
 */
const EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'fallback'] as const;
export type RouteExport = (typeof EXPORTS)[number];

/**
 * Every `+server` file under `src/routes`, as a path from the repository root
 * with forward slashes: `src/routes/api/cards/[id]/+server.ts`.
 *
 * The folder is read when a test file starts, every time. It was once listed
 * with `import.meta.glob`, which Vite expands when it transforms this file;
 * vitest keeps what it transformed, and so a route added afterwards was not
 * seen until this file was next edited. A build, which starts with nothing
 * kept, saw it; a workstation did not.
 */
function serverFiles(): string[] {
	const root = join(process.cwd(), 'src', 'routes');
	return (readdirSync(root, { recursive: true }) as string[])
		.map((file) => `src/routes/${file.split(sep).join('/')}`)
		.filter((file) => file.split('/').at(-1)!.startsWith('+server.'))
		.sort();
}

/** The files `api()` serves: a `+server.ts` under `src/routes/api`. */
const isApiRoute = (file: string) => file.startsWith('src/routes/api/') && file.endsWith('/+server.ts');

type Route = {
	/** URL pattern as SvelteKit writes it, e.g. `/api/cards/[id]`. */
	pattern: string;
	segments: string[];
	load: () => Promise<RouteModule>;
};

const routes: Route[] = serverFiles()
	.filter(isApiRoute)
	.map((file) => {
		const pattern = file.slice('src/routes'.length, -'/+server.ts'.length);
		return {
			pattern,
			segments: pattern.split('/').filter(Boolean),
			// Loaded through Vite when a request first needs it, as the gate loads it.
			load: () => import(/* @vite-ignore */ `/${file}`) as Promise<RouteModule>
		};
	});

const isParam = (segment: string) => segment.startsWith('[') && segment.endsWith(']');

/** Every API route pattern in the codebase, sorted. */
export function routePatterns(): string[] {
	return routes.map((r) => r.pattern).sort();
}

/**
 * The `+server` files that are not among `routePatterns()`: one outside
 * `src/routes/api`, and one that is not a `.ts` file. SvelteKit serves them
 * all the same, and `api()` cannot reach them. There are none.
 */
export function serverFilesNotServed(): string[] {
	return serverFiles().filter((file) => !isApiRoute(file));
}

/**
 * What a route exports that answers a request: the HTTP methods, and
 * `fallback`, which answers every method the route has no export for.
 */
export async function routeMethods(pattern: string): Promise<RouteExport[]> {
	const route = routes.find((r) => r.pattern === pattern);
	if (!route) throw new Error(`No route ${pattern}`);
	const mod = await route.load();
	return EXPORTS.filter((m) => m in mod);
}

function match(pathname: string): { route: Route; params: Record<string, string> } | null {
	const parts = pathname.split('/').filter(Boolean);
	let best: { route: Route; params: Record<string, string>; staticCount: number } | null = null;

	for (const route of routes) {
		if (route.segments.length !== parts.length) continue;
		const params: Record<string, string> = {};
		let staticCount = 0;
		let ok = true;
		for (let i = 0; i < parts.length; i++) {
			const seg = route.segments[i];
			if (isParam(seg)) {
				params[seg.slice(1, -1)] = decodeURIComponent(parts[i]);
			} else if (seg === parts[i]) {
				staticCount++;
			} else {
				ok = false;
				break;
			}
		}
		// SvelteKit prefers the more specific route: /cards/reorder over /cards/[id].
		if (ok && (!best || staticCount > best.staticCount)) best = { route, params, staticCount };
	}
	return best;
}

export type ApiOptions = {
	/** Who is calling. `null` (the default) is an anonymous caller. */
	user?: SessionUser | null;
	/**
	 * Sent as JSON. A `FormData` is sent as multipart, and bytes (a `Buffer` or
	 * other `Uint8Array`) are sent as they are, for a route that takes an upload
	 * as its body; say what they are with a `content-type` header.
	 */
	body?: unknown;
	headers?: Record<string, string>;
	/** The address the request appears to come from. Rate limits are keyed on it. */
	ip?: string;
	/**
	 * What the gate let the request in with, set as `locals.credential`: a
	 * session's token, an API key's row id, or null for neither. Left out, it is
	 * undefined, as for a request no gate let in.
	 */
	credential?: Credential | null;
};

export type ApiResult = {
	status: number;
	/** Parsed JSON where the response was JSON, otherwise the text. */
	body: any;
	headers: Headers;
};

export async function api(method: Method, path: string, opts: ApiOptions = {}): Promise<ApiResult> {
	const url = new URL(path, 'http://localhost');
	const found = match(url.pathname);
	if (!found) throw new Error(`No route matches ${method} ${url.pathname}`);

	const mod = await found.route.load();
	const handler = mod[method];
	if (!handler) throw new Error(`${found.route.pattern} does not export ${method}`);

	const headers = new Headers(opts.headers);
	let body: BodyInit | undefined;
	if (opts.body instanceof FormData) {
		body = opts.body;
	} else if (opts.body instanceof Uint8Array) {
		body = opts.body as BodyInit;
	} else if (opts.body !== undefined) {
		body = JSON.stringify(opts.body);
		if (!headers.has('content-type')) headers.set('content-type', 'application/json');
	}
	const request = new Request(url, { method, headers, body });
	// As the hook does for every request under /api/, and every route here is.
	guardBody(request);

	// What the request's Cookie header holds, by name.
	const cookieJar = new Map<string, string>();
	for (const pair of (headers.get('cookie') ?? '').split(';')) {
		const at = pair.indexOf('=');
		if (at > 0) cookieJar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
	}
	const event = {
		request,
		url,
		params: found.params,
		locals: 'credential' in opts ? { user: opts.user ?? null, credential: opts.credential } : { user: opts.user ?? null },
		route: { id: found.route.pattern },
		cookies: {
			get: (name: string) => cookieJar.get(name),
			getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
			set: (name: string, value: string) => void cookieJar.set(name, value),
			delete: (name: string) => void cookieJar.delete(name),
			serialize: () => ''
		},
		getClientAddress: () => opts.ip ?? '127.0.0.1',
		setHeaders: () => {},
		fetch: () => {
			throw new Error('A route handler tried to fetch() during a test');
		},
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;

	let response: Response;
	try {
		response = await handler(event);
	} catch (thrown) {
		// `throw error(403, ...)` and `throw redirect(...)` are how a handler
		// answers; anything else is a genuine crash and should fail the test.
		if (isHttpError(thrown)) {
			return { status: thrown.status, body: thrown.body, headers: new Headers() };
		}
		if (isRedirect(thrown)) {
			return {
				status: thrown.status,
				body: null,
				headers: new Headers({ location: thrown.location })
			};
		}
		throw thrown;
	}

	const text = await response.text();
	let parsed: unknown = text;
	if ((response.headers.get('content-type') ?? '').includes('json')) {
		try {
			parsed = JSON.parse(text);
		} catch {
			// Leave as text: a handler that claims JSON and sends something else
			// is worth seeing verbatim in the failure.
		}
	}
	return { status: response.status, body: parsed, headers: response.headers };
}
