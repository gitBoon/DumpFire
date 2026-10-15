/**
 * Call a form action in a `+page.server.ts` directly, by the page's path.
 *
 *     const res = await action('/invite/abc123', {
 *         form: { password: 'correct horse', confirmPassword: 'correct horse' }
 *     });
 *     expect(res).toMatchObject({ type: 'redirect', location: '/' });
 *     expect(res.cookies.dumpfire_session).toBeDefined();
 *
 * `api()` reaches the handlers under `src/routes/api`. A form action is not
 * one of those: it lives in a page's `actions` export, takes form data, and
 * answers by returning data, returning `fail(...)` or throwing a redirect.
 * The path is matched against the real route tree, as `api()` does, and
 * `hooks.server.ts` does not run.
 *
 * `name` picks a named action (`?/name` in the browser); without it the
 * `default` action is called.
 *
 * A page's `load` is called by `pageLoad()`, below.
 */
import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isActionFailure, isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from '$lib/server/auth';

type ActionModule = {
	actions?: Record<string, (event: RequestEvent) => unknown>;
};

const modules = import.meta.glob<ActionModule>('/src/routes/**/+page.server.ts');

type Page = {
	/** The page's path as SvelteKit writes it, e.g. `/invite/[token]`. */
	pattern: string;
	segments: string[];
	load: () => Promise<ActionModule>;
};

const pages: Page[] = Object.entries(modules).map(([file, load]) => {
	const pattern = file.replace(/^\/src\/routes/, '').replace(/\/\+page\.server\.ts$/, '') || '/';
	// A group, `(name)`, is a folder and not part of the path.
	const segments = pattern.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
	return { pattern, segments, load };
});

const isParam = (segment: string) => segment.startsWith('[') && segment.endsWith(']');

/** The page of `list` the path reaches, preferring the more specific, as SvelteKit does. */
function match<P extends { segments: string[] }>(list: P[], pathname: string): { page: P; params: Record<string, string> } | null {
	const parts = pathname.split('/').filter(Boolean);
	let best: { page: P; params: Record<string, string>; staticCount: number } | null = null;

	for (const page of list) {
		if (page.segments.length !== parts.length) continue;
		const params: Record<string, string> = {};
		let staticCount = 0;
		let ok = true;
		for (let i = 0; i < parts.length; i++) {
			const seg = page.segments[i];
			if (isParam(seg)) {
				params[seg.slice(1, -1)] = decodeURIComponent(parts[i]);
			} else if (seg === parts[i]) {
				staticCount++;
			} else {
				ok = false;
				break;
			}
		}
		if (ok && (!best || staticCount > best.staticCount)) best = { page, params, staticCount };
	}
	return best;
}

/** The path of every page that has a `+page.server.ts`, sorted. */
export function pagePatterns(): string[] {
	return pages.map((p) => p.pattern).sort();
}

export type ActionOptions = {
	/** A named action. The `default` action when left out. */
	name?: string;
	/** The form's fields. */
	form?: Record<string, string> | FormData;
	/** Who is calling. `null` (the default) is an anonymous caller. */
	user?: SessionUser | null;
	/** Cookies the browser sends with the form. */
	cookies?: Record<string, string>;
	headers?: Record<string, string>;
	/** The address the request appears to come from. */
	ip?: string;
};

export type CookieChange = { value: string; options: Record<string, unknown> };

export type ActionResult = (
	| { type: 'success'; status: 200; data: any }
	/** The action returned `fail(status, data)`. */
	| { type: 'failure'; status: number; data: any }
	/** The action threw `redirect(status, location)`. */
	| { type: 'redirect'; status: number; location: string }
	/** The action threw `error(status, ...)`. */
	| { type: 'error'; status: number; body: any }
) & {
	/** Cookies the action set, by name. */
	cookies: Record<string, CookieChange>;
	/** Names of the cookies the action deleted. */
	deletedCookies: string[];
};

export async function action(path: string, opts: ActionOptions = {}): Promise<ActionResult> {
	const url = new URL(path, 'http://localhost');
	const found = match(pages, url.pathname);
	if (!found) throw new Error(`No page with a +page.server.ts matches ${url.pathname}`);

	const mod = await found.page.load();
	const name = opts.name ?? 'default';
	const handler = mod.actions?.[name];
	if (!handler) throw new Error(`${found.page.pattern} has no "${name}" action`);

	let form: FormData;
	if (opts.form instanceof FormData) {
		form = opts.form;
	} else {
		form = new FormData();
		for (const [key, value] of Object.entries(opts.form ?? {})) form.set(key, value);
	}
	const request = new Request(url, { method: 'POST', headers: opts.headers, body: form });

	const jar = new Map<string, string>(Object.entries(opts.cookies ?? {}));
	const set: Record<string, CookieChange> = {};
	const deleted: string[] = [];
	const event = {
		request,
		url,
		params: found.params,
		locals: { user: opts.user ?? null },
		route: { id: found.page.pattern },
		cookies: {
			get: (cookie: string) => jar.get(cookie),
			getAll: () => [...jar].map(([cookie, value]) => ({ name: cookie, value })),
			set: (cookie: string, value: string, options: Record<string, unknown> = {}) => {
				jar.set(cookie, value);
				set[cookie] = { value, options };
			},
			delete: (cookie: string) => {
				jar.delete(cookie);
				delete set[cookie];
				deleted.push(cookie);
			},
			serialize: () => ''
		},
		getClientAddress: () => opts.ip ?? '127.0.0.1',
		setHeaders: () => {},
		fetch: () => {
			throw new Error('A form action tried to fetch() during a test');
		},
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false
	} as unknown as RequestEvent;

	const cookies = { cookies: set, deletedCookies: deleted };
	try {
		const returned = await handler(event);
		if (isActionFailure(returned)) {
			return { type: 'failure', status: returned.status, data: returned.data, ...cookies };
		}
		return { type: 'success', status: 200, data: returned ?? null, ...cookies };
	} catch (thrown) {
		// A redirect and `error(...)` are how an action answers; anything else is
		// a genuine crash and should fail the test.
		if (isRedirect(thrown)) {
			return { type: 'redirect', status: thrown.status, location: thrown.location, ...cookies };
		}
		if (isHttpError(thrown)) {
			return { type: 'error', status: thrown.status, body: thrown.body, ...cookies };
		}
		throw thrown;
	}
}

// ─── Page loads ────────────────────────────────────────────────────────────

/**
 * Call the `load` of a page, or of a layout, by the page's path, as SvelteKit
 * calls it.
 *
 *     const res = await pageLoad(`/board/${board.id}`, { user });
 *     expect(res.type).toBe('data');
 *     expect(JSON.stringify(res)).not.toContain('a name they may not read');
 *
 * A load answers by returning data, throwing a redirect or throwing
 * `error(...)`, and each is returned here; anything else it throws is a crash
 * and fails the test. As with `api()`, `hooks.server.ts` does not run: the
 * load is given exactly the caller the test gives it. A load that asks for its
 * parent's data or fetches fails the test: none does today.
 *
 * The files are read from the disk when a test file starts, as `api()` reads
 * its routes, and not listed with `import.meta.glob` as `action()`'s are:
 * vitest keeps what it transformed, and a page added afterwards would not be
 * seen until this file was next edited. A test that asks every page
 * (`loadKeys()`) would pass without it.
 */
type LoadModule = { load?: (event: never) => unknown };

/** A `+page.server.ts` or a `+layout.server.ts`. */
type ServerLoad = {
	kind: 'page' | 'layout';
	/** The page's path as SvelteKit writes it, e.g. `/board/[id]`. */
	pattern: string;
	segments: string[];
	/** From the repository root, with forward slashes. */
	file: string;
};

const serverLoads: ServerLoad[] = (readdirSync(join(process.cwd(), 'src', 'routes'), { recursive: true }) as string[])
	.map((file) => `src/routes/${file.split(sep).join('/')}`)
	.filter((file) => /\/\+(page|layout)\.server\.ts$/.test(file))
	.sort()
	.map((file) => {
		const pattern = file.slice('src/routes'.length).replace(/\/\+(page|layout)\.server\.ts$/, '') || '/';
		return {
			kind: file.endsWith('/+layout.server.ts') ? 'layout' : 'page',
			pattern,
			// A group, `(name)`, is a folder and not part of the path.
			segments: pattern.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')'))),
			file
		};
	});

/** Every server load, as `page <path>` or `layout <path>`, sorted: `layout /`, `page /board/[id]`. */
export function loadKeys(): string[] {
	return serverLoads.map((l) => `${l.kind} ${l.pattern}`).sort();
}

export type LoadOptions = {
	/** Who is calling. `null` (the default) is an anonymous caller. */
	user?: SessionUser | null;
	/** The load of the layout at this path, rather than the page's. */
	layout?: boolean;
	headers?: Record<string, string>;
};

export type LoadResult =
	| { type: 'data'; data: any }
	/** The load threw `redirect(status, location)`. */
	| { type: 'redirect'; status: number; location: string }
	/** The load threw `error(status, ...)`. */
	| { type: 'error'; status: number; body: any };

export async function pageLoad(path: string, opts: LoadOptions = {}): Promise<LoadResult> {
	const url = new URL(path, 'http://localhost');
	const kind = opts.layout ? 'layout' : 'page';
	const found = match(
		serverLoads.filter((l) => l.kind === kind),
		url.pathname
	);
	if (!found) throw new Error(`No ${kind} with a +${kind}.server.ts matches ${url.pathname}`);

	// Loaded through Vite, as `api()` loads a route.
	const mod = (await import(/* @vite-ignore */ `/${found.page.file}`)) as LoadModule;
	if (!mod.load) throw new Error(`${found.page.file} has no load`);

	const event = {
		url,
		params: found.params,
		locals: { user: opts.user ?? null },
		route: { id: found.page.pattern },
		request: new Request(url, { headers: opts.headers }),
		cookies: {
			get: () => undefined,
			getAll: () => [],
			set: () => {},
			delete: () => {},
			serialize: () => ''
		},
		getClientAddress: () => '127.0.0.1',
		setHeaders: () => {},
		depends: () => {},
		untrack: <T>(fn: () => T) => fn(),
		parent: () => {
			throw new Error('A load asked for parent() during a test');
		},
		fetch: () => {
			throw new Error('A load tried to fetch() during a test');
		},
		platform: undefined,
		isDataRequest: false,
		isSubRequest: false
	};

	try {
		return { type: 'data', data: (await mod.load(event as never)) ?? null };
	} catch (thrown) {
		if (isRedirect(thrown)) return { type: 'redirect', status: thrown.status, location: thrown.location };
		if (isHttpError(thrown)) return { type: 'error', status: thrown.status, body: thrown.body };
		throw thrown;
	}
}
