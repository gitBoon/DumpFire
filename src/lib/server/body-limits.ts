/**
 * body-limits.ts — how large a request's body may be, by route, and how the
 * gate in hooks.server.ts holds a body to it.
 *
 * The node adapter has one limit for every route, `BODY_SIZE_LIMIT`, and
 * 512 KB of it unless it is told otherwise. The image tells it 512M, so that
 * a backup can be imported, and that alone would let anybody post half a
 * gigabyte to the login form. So the gate narrows it again, route by route:
 * see `LARGER` below. It does so twice:
 *
 *   - On the length a request declares in `Content-Length`, before the body
 *     is read: more than the limit is refused at once, 413 (`refuseBody`).
 *     A declared length can be trusted as far as it goes. The adapter fails a
 *     body that runs past what its request declared (`get_raw_body` in the
 *     adapter's handler.js), and `guardBody` in api-errors.ts answers that 413.
 *   - On the bytes themselves, as the body is read (`heldToLimit`). A body
 *     with no declared length, one sent in chunks, is held to nothing by the
 *     adapter: it compares what it has read with `Content-Length`, and against
 *     no number at all that comparison is never true, so with a limit of 512K
 *     a chunked body of 64 MB was read in full. The gate counts it instead,
 *     and the read is refused, 413, once the route's limit is passed.
 *
 * A chunked body is read, then, and held to the same limit as a body that
 * says how long it is, on every route. A browser says how long what it posts
 * is, but a body can still arrive in chunks: from a client that sends it so,
 * or through a proxy that passes it on so, as `cloudflared` does unless it is
 * told not to (docs/deployment.md).
 *
 * Each function here works on the one request it is given and keeps nothing.
 * Where they are asked is the gate's to say.
 */
import { json } from '@sveltejs/kit';
import { dev } from '$app/environment';

const K = 1024;
const M = 1024 * K;

/** The most any route accepts unless it is in `LARGER`: the adapter's own default. */
export const DEFAULT_BODY_LIMIT = 512 * K;

/**
 * `BODY_SIZE_LIMIT` as the `Dockerfile` sets it, which is the limit of a
 * server made from the image. tests/body-limits.test.ts fails if the two
 * differ.
 */
export const IMAGE_BODY_SIZE_LIMIT = '512M';

/**
 * The routes that accept more than `DEFAULT_BODY_LIMIT`, by method and route
 * id, and how much. Every other request on every other route, a page and a
 * form action as much as an API route, gets the default.
 *
 * `bytes` is that many bytes, or `'the server'`: as much as the server accepts
 * at all (`serverBodyLimit`). `to` is who is given it (`bodyLimit`).
 *
 *   the attachment upload   26M, to anybody signed in: the handler refuses a
 *                           file over 25 MB, and the form it arrives in is a
 *                           little larger than the file
 *   the import              a whole database, so as much as there is, to the
 *                           superadmin alone
 *
 * Each handler asks the same before it reads a byte of the body: one needs
 * edit access to the card's board, and the other is the superadmin's. The
 * import was given its limit for any signed-in caller, so that a user who
 * could not import anything could still have the server read half a gigabyte
 * before the handler said so.
 */
const LARGER: Record<string, { bytes: number | 'the server'; to: 'signed in' | 'the superadmin' }> = {
	'POST /api/cards/[id]/attachments': { bytes: 26 * M, to: 'signed in' },
	'POST /api/admin/import': { bytes: 'the server', to: 'the superadmin' }
};

/**
 * A size in bytes from text, exactly as the node adapter reads
 * `BODY_SIZE_LIMIT` (`parse_as_bytes` in its handler.js): a number of bytes,
 * or a number followed by K, M or G. Anything else is NaN, `512MB` included:
 * its last letter is no unit, and the whole of it is no number. `Infinity`
 * is no limit.
 */
export function parseAsBytes(value: string): number {
	const units: Record<string, number> = { K: 1024, M: 1024 * 1024, G: 1024 * 1024 * 1024 };
	const multiplier = units[value[value.length - 1]?.toUpperCase() ?? ''] ?? 1;
	return Number(multiplier !== 1 ? value.substring(0, value.length - 1) : value) * multiplier;
}

/**
 * The most this server accepts on any route.
 *
 * In a built server that is the adapter's limit, read as the adapter reads
 * it: `BODY_SIZE_LIMIT`, or 512K when it is not set. A value that is no number
 * never gets this far in one, because the adapter refuses to start on it; it
 * is read here as the default.
 *
 * `vite dev` has no adapter and enforces no limit of its own, so there an
 * unset `BODY_SIZE_LIMIT` is read as the image's, and a backup can be
 * imported into a dev server as it can into the image.
 */
export function serverBodyLimit(value: string | undefined = process.env.BODY_SIZE_LIMIT, isDev: boolean = dev): number {
	const limit = parseAsBytes(value ?? (isDev ? IMAGE_BODY_SIZE_LIMIT : '512K'));
	return Number.isNaN(limit) ? DEFAULT_BODY_LIMIT : limit;
}

/**
 * Who a request is from, as far as the gate has got: not yet asked, nobody,
 * somebody signed in, or the superadmin (who is signed in too).
 */
export type Caller = 'not yet known' | 'nobody' | 'signed in' | 'the superadmin';

/**
 * The most a `method` request to the route `routeId` may send, from this
 * caller.
 *
 * `routeId` is the path as the gate decides everything on it (`routedPath` in
 * hooks.server.ts): a route's id, so `/api/cards/[id]/attachments` whatever
 * the address was.
 *
 * A route of `LARGER` gives its larger limit to the callers it names, and the
 * default to everybody else: nobody, on both, and anybody signed in who is
 * not the superadmin, on the import. A caller who is not yet known gets the
 * most the route gives anybody, which for the two larger routes is the most
 * they would ever accept: enough to refuse at once what nobody may send.
 *
 * In a built server no route is given more than the server accepts, so that a
 * request the adapter would fail half way through is refused here with the
 * limit in the answer.
 */
export function bodyLimit(
	routeId: string,
	method: string,
	caller: Caller,
	server: { limit?: string; isDev?: boolean } = {}
): number {
	const isDev = server.isDev ?? dev;
	const most = serverBodyLimit(server.limit ?? process.env.BODY_SIZE_LIMIT, isDev);

	const larger = LARGER[`${method.toUpperCase()} ${routeId}`];
	const given =
		larger !== undefined &&
		(caller === 'not yet known' || caller === 'the superadmin' || (caller === 'signed in' && larger.to === 'signed in'));
	const limit = !given ? DEFAULT_BODY_LIMIT : larger.bytes === 'the server' ? most : larger.bytes;
	return isDev ? limit : Math.min(limit, most);
}

/** A number of bytes as a person reads it: `512 KB`, `26 MB`, `1.5 GB`. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return 'any size';
	const shown = (value: number, unit: string) => `${Number.isInteger(value) ? value : value.toFixed(1)} ${unit}`;
	if (bytes >= M * K) return shown(bytes / (M * K), 'GB');
	if (bytes >= M) return shown(bytes / M, 'MB');
	if (bytes >= K) return shown(bytes / K, 'KB');
	return `${bytes} bytes`;
}

/**
 * The length this request declares, or null if it declares none that can be
 * read: `Content-Length` as a whole number of bytes.
 */
export function declaredLength(request: Request): number | null {
	const declared = request.headers.get('content-length')?.trim();
	return declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
}

/**
 * What a 413 says, for a body over `limit`: the limit in words and as
 * `limitBytes`, for a page to show. `declared` is the length the request
 * declared, where it declared one; a body that declared none was counted as it
 * was read, and stopped there, so how large it was is not known.
 */
export function tooLargeBody(limit: number, declared: number | null = null): { message: string; limitBytes: number } {
	const size = declared === null ? '' : `it is ${formatBytes(declared)}, and `;
	return {
		message: `The request is larger than this server accepts here: ${size}the limit is ${formatBytes(limit)}`,
		limitBytes: limit
	};
}

/**
 * The answer to a request whose body will not be read, or null if it may be:
 * 413, when it declares a length and that is more than `limit`.
 *
 * "Has a body" is what the node adapter decides before the gate is called,
 * and is read here from what it made: `request.body` is null for a GET or a
 * HEAD, for any request with no `Content-Type`, for one with a
 * `Content-Length` of 0, and for one that has neither a `Content-Length` nor
 * a `Transfer-Encoding`. None of those is ever refused. What is left is a
 * request the adapter will read a body from: one that declares a length,
 * which is held to the limit here, and one that is sent in chunks with none
 * declared, which is let through to be counted as it is read (`heldToLimit`).
 *
 * It is an answer and not an error thrown: the gate returns it.
 */
export function refuseBody(request: Request, limit: number): Response | null {
	if (request.body === null) return null;

	const declared = declaredLength(request);
	if (declared !== null && declared > limit) {
		// Written out, so that tests/error-shape.test.ts can read its keys.
		const { message, limitBytes } = tooLargeBody(limit, declared);
		return json({ message, limitBytes }, { status: 413 });
	}
	return null;
}

/**
 * What the read of a body fails with once it has passed its limit: the 413,
 * with the limit, that `guardBody` in api-errors.ts throws again as
 * SvelteKit's own.
 */
export class BodyOverLimit extends Error {
	readonly status = 413;
	readonly limitBytes: number;

	constructor(limit: number) {
		super(tooLargeBody(limit).message);
		this.name = 'BodyOverLimit';
		this.limitBytes = limit;
	}
}

/**
 * `request`, with its body counted as it is read and held to `limit`: a read
 * that passes the limit fails with `BodyOverLimit`, and no more of the body is
 * read. A request with no body, or a limit of Infinity, is handed back as it
 * was.
 *
 * It is a new request, made from the old one: the same method, address,
 * headers and signal, with the old body passed through a count. So whatever
 * reads it, and however (`json()`, `formData()`, `arrayBuffer()`, `text()`,
 * the stream itself, a `clone()`), reads it through the count. The gate hands
 * this one on to SvelteKit in place of the old one (`handOn` in
 * hooks.server.ts), which SvelteKit itself does with the event it is handed.
 *
 * The old body is not cancelled when the limit is passed, only left unread.
 * The adapter answers a cancel by destroying the connection (`req.destroy` in
 * its handler.js), and the 413 would never reach the caller. Left unread, the
 * rest of the body waits on the connection while the 413 is sent, exactly as
 * the body of a request refused on its declared length does, which is never
 * read at all.
 */
export function heldToLimit(request: Request, limit: number): Request {
	if (request.body === null || limit === Infinity) return request;

	let read = 0;
	const counting = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			read += chunk.byteLength;
			if (read > limit) controller.error(new BodyOverLimit(limit));
			else controller.enqueue(chunk);
		}
	});
	// `duplex` is what Node asks for when a body is a stream, and is how the
	// adapter makes every request that has one.
	return new Request(request, {
		body: request.body.pipeThrough(counting, { preventCancel: true }),
		duplex: 'half'
	} as RequestInit);
}
