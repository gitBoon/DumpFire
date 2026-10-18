/**
 * Send a request through the gate: SvelteKit's own `Server`, over the real
 * route tree, with the real `handle` from `src/hooks.server.ts` in front.
 *
 *     const res = await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } });
 *     expect(res.status).toBe(200);
 *
 * `api()` in ./api.ts calls a handler directly and so never meets the gate,
 * nor anything SvelteKit does around a handler: the choice between JSON and an
 * HTML page for an `error()`, the answer to a method the route does not have,
 * the page for a path that is no route. This does. It is what a request meets
 * on the wire, from the moment the adapter has made a `Request` of it.
 *
 * No build, no dev server and no port. The server is the class a built
 * application runs, given a manifest made the way `vite dev` makes one
 * (`update_manifest` in @sveltejs/kit/src/exports/vite/dev/index.js): the
 * route list comes from SvelteKit's own reading of `src/routes`, and every
 * module is loaded through Vite when a request first needs it. So a handler
 * reached this way shares its database connection, and every other module,
 * with the test that sent the request.
 *
 * Loading `src/hooks.server.ts` runs what it runs at start-up: the migrations
 * (already applied by tests/setup.ts, so nothing happens), the session and log
 * clean-up, and `startSchedulers()`, which vitest.config.ts switches off with
 * SCHEDULERS=off.
 *
 * It leans on SvelteKit's internals, which no version promises to keep:
 * three modules imported by path below and the shape of the manifest. The
 * first test in tests/gate.test.ts is of this file, so that an upgrade which
 * breaks it fails there, by name, and not as forty failures that look like
 * the gate's.
 */
import type { Server, SSRManifest } from '@sveltejs/kit';

/** SvelteKit's source, as a path Vite resolves from the repository root. */
const KIT = '/node_modules/@sveltejs/kit/src';

/** What is read from SvelteKit's account of `src/routes`. */
type ManifestData = {
	assets: { file: string }[];
	nodes: { component?: string; universal?: string; server?: string }[];
	routes: {
		id: string;
		pattern: RegExp;
		params: unknown[];
		page: unknown;
		endpoint: { file: string } | null;
	}[];
};

/** A module by its path from the repository root, loaded through Vite as the dev server loads it. */
const load = (file: string) => import(/* @vite-ignore */ `/${file.replace(/\\/g, '/')}`);

/** A route the harness serves: its id, and whether it is a page, an endpoint (a `+server.ts`) or both. */
export type GateRoute = { id: string; page: boolean; endpoint: boolean };

type Started = {
	server: Server;
	/** The id of every route with a `+server.ts`, e.g. `/api/cards/[id]`. */
	endpoints: string[];
	/** Every route, page or endpoint. */
	routes: GateRoute[];
};

let started: Promise<Started> | undefined;

async function start(): Promise<Started> {
	const { Server: KitServer } = (await import(/* @vite-ignore */ `${KIT}/runtime/server/index.js`)) as {
		Server: new (manifest: SSRManifest) => Server;
	};
	const { load_config } = await import(/* @vite-ignore */ `${KIT}/core/config/index.js`);
	const { default: create_manifest_data } = await import(
		/* @vite-ignore */ `${KIT}/core/sync/create_manifest_data/index.js`
	);

	const config = await load_config();
	const data: ManifestData = create_manifest_data({ config });

	const manifest = {
		appDir: config.kit.appDir,
		appPath: config.kit.appDir,
		assets: new Set(data.assets.map((asset) => asset.file)),
		mimeTypes: {},
		_: {
			// Nothing here runs in a browser, so a page is rendered with no
			// script to start it.
			client: { start: '', app: '', imports: [], stylesheets: [], fonts: [], uses_env_dynamic_public: true },
			server_assets: {},
			nodes: data.nodes.map((node, index) => async () => {
				const loaded: Record<string, unknown> = {
					index,
					imports: [],
					stylesheets: [],
					fonts: [],
					universal_id: node.universal,
					server_id: node.server,
					inline_styles: async () => ({})
				};
				const component = node.component;
				if (component) loaded.component = async () => (await load(component)).default;
				if (node.universal) loaded.universal = await load(node.universal);
				if (node.server) loaded.server = await load(node.server);
				return loaded;
			}),
			prerendered_routes: new Set<string>(),
			remotes: {},
			routes: data.routes
				.filter((route) => route.page || route.endpoint)
				.map((route) => {
					const endpoint = route.endpoint;
					return {
						id: route.id,
						pattern: route.pattern,
						params: route.params,
						page: route.page,
						endpoint: endpoint ? () => load(endpoint.file) : null,
						endpoint_id: endpoint?.file
					};
				}),
			matchers: async () => ({})
		}
	};

	const server = new KitServer(manifest as unknown as SSRManifest);
	await server.init({
		env: process.env as Record<string, string>,
		read: () => {
			throw new Error('The gate harness serves no files: read() was called');
		}
	});

	return {
		server,
		endpoints: data.routes.filter((route) => route.endpoint).map((route) => route.id),
		routes: data.routes
			.filter((route) => route.page || route.endpoint)
			.map((route) => ({ id: route.id, page: Boolean(route.page), endpoint: Boolean(route.endpoint) }))
	};
}

/** The one server of this test file, started by the first request. */
function theServer(): Promise<Started> {
	return (started ??= start());
}

/**
 * The pattern of every API route the harness serves, sorted: what
 * `routePatterns()` in ./api.ts lists by reading the same folder for itself.
 */
export async function gateApiRoutes(): Promise<string[]> {
	const { endpoints } = await theServer();
	return endpoints.filter((id) => id.startsWith('/api/')).sort();
}

/** Every route the harness serves, pages and endpoints alike, sorted by id. */
export async function gateRoutes(): Promise<GateRoute[]> {
	const { routes } = await theServer();
	return [...routes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type GateOptions = {
	headers?: Record<string, string>;
	/**
	 * A string, bytes or a stream is sent as it is: say what it is with a
	 * `content-type` header, as a client must, or it is not sent at all. A
	 * `FormData` is sent as it is and says what it is itself. Anything else
	 * is sent as JSON, with that header.
	 *
	 * Each is sent with its length in `Content-Length`, as a client sends it,
	 * but a stream: that is a body sent in chunks, with no length declared.
	 * Set the header to declare one, for a stream or in place of the real one.
	 */
	body?: unknown;
	/**
	 * The address the request appears to come from. `null` is a request whose
	 * address cannot be had: `getClientAddress()` throws, as the node adapter's
	 * does when it is started with `ADDRESS_HEADER` and the request arrives
	 * without that header.
	 */
	ip?: string | null;
	/**
	 * What the node adapter hands a request as `event.platform`: its `req`.
	 * None by default, as under `vite dev`. A test passes
	 * `{ req: { socket: { destroyed: true } } }` for a caller who has gone.
	 */
	platform?: unknown;
};

/**
 * Send one request and return SvelteKit's answer, untouched: read it with
 * `text()` or `json()`. A redirect is returned, not followed.
 */
export async function gate(method: string, path: string, opts: GateOptions = {}): Promise<Response> {
	const { server } = await theServer();

	const headers = new Headers(opts.headers);
	let body = opts.body;
	const sentAsItIs =
		typeof body === 'string' ||
		body instanceof Uint8Array ||
		body instanceof FormData ||
		body instanceof ReadableStream;
	if (body !== undefined && !sentAsItIs) {
		body = JSON.stringify(body);
		if (!headers.has('content-type')) headers.set('content-type', 'application/json');
	}

	// A body sent with no Content-Type never reaches a handler. `getRequest`
	// in @sveltejs/kit/src/exports/node/index.js, which makes the `Request`
	// under `vite dev` and in the node adapter alike, passes no body when the
	// header is not there (`get_raw_body`). Left in, `new Request` would also
	// give a string a Content-Type of its own, text/plain, which nobody sent.
	// A `FormData` is the exception: its header is written with it, boundary
	// and all, so a client that sends one always sends the header.
	if (!(body instanceof FormData) && !headers.has('content-type')) body = undefined;

	// A client that knows how long its body is says so, in Content-Length, and
	// a browser, nginx and the API wrapper all do. The node adapter copies the
	// header on to the `Request` it makes, and the gate reads it there: a body
	// that declares more than its route accepts is refused before it is read.
	// `new Request` writes no such header itself, so it is written here, as it
	// would be on the wire: the length of a string in bytes, the length of
	// bytes, and for a form the length of the form written out, with the
	// header that goes with it.
	//
	// A stream is the one body sent without it, as a chunked request is on the
	// wire (what `cloudflared` passes on unless it is told not to), unless the
	// test declares a length itself. The gate counts such a body as it is read.
	// A header the test set is never replaced: that is how a test declares
	// more than it sends.
	if (body instanceof FormData) {
		const written = new Response(body);
		headers.set('content-type', written.headers.get('content-type') ?? 'multipart/form-data');
		body = new Uint8Array(await written.arrayBuffer());
	}
	if (!headers.has('content-length')) {
		if (typeof body === 'string') headers.set('content-length', String(Buffer.byteLength(body)));
		else if (body instanceof Uint8Array) headers.set('content-length', String(body.byteLength));
	}

	// `duplex` is what Node asks for when a body is a stream, and is how the
	// node adapter makes every request that has one.
	const request = new Request(new URL(path, 'http://localhost'), {
		method,
		headers,
		body,
		duplex: 'half'
	} as RequestInit);

	const ip = opts.ip;
	return server.respond(request, {
		platform: opts.platform as App.Platform | undefined,
		getClientAddress: () => {
			if (ip === null) {
				// The adapter's own words (`get_client_address` in its handler.js).
				throw new Error('Address header was specified with ADDRESS_HEADER=x-forwarded-for but is absent from request');
			}
			return ip ?? '127.0.0.1';
		}
	});
}

/**
 * The error the node adapter fails an oversized body with: the fields of
 * SvelteKit's `SvelteKitError` (@sveltejs/kit/src/exports/internal/index.js),
 * in a class that is not SvelteKit's.
 *
 * It is a class of its own on purpose. Up to adapter-node 5.5.4 a built
 * server had two copies of SvelteKit's class: one bundled into the adapter's
 * handler, which was the one the body's stream failed with, and one in the
 * server, which is the one SvelteKit tests an error against with `instanceof`
 * to find its status. The adapter's was not an instance of the server's, so
 * the server did not know it for a 413. Thrown here as SvelteKit's own class,
 * as it once was, it was answered 413 in the tests and 500 in production.
 * Since 5.5.5 the build has one copy (card 2227), and the adapter's error is
 * SvelteKit's own. A class that is not SvelteKit's is kept as the stricter
 * case: the gate must know a 413 by its `status` whatever class it is, which
 * still holds the one-copy build.
 */
class AdapterError extends Error {
	status: number;
	text: string;

	constructor(status: number, text: string, message: string) {
		super(message);
		this.status = status;
		this.text = text;
	}
}

/**
 * A request body over the size limit, as the node adapter presents one: a
 * stream that fails, when it is read, with the adapter's 413. The limit
 * itself is the adapter's, which is not running here.
 *
 * The adapter fails a body in two cases: one that declares more than
 * `BODY_SIZE_LIMIT`, and one that runs past the length it declared. The gate
 * now refuses the first before the body is read, so what this stands for is
 * the second, and a test sends it with a `content-length` the route accepts.
 */
export function bodyOverTheLimit(): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.error(new AdapterError(413, 'Payload Too Large', 'request body size exceeded BODY_SIZE_LIMIT of 524288'));
		}
	});
}
