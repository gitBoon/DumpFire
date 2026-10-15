/**
 * api-errors.ts — what the gate in hooks.server.ts uses so that a failure
 * under /api/ can be read by the caller: the right status, and JSON with a
 * `message`.
 *
 * A handler refuses with `error(status, text)`, which SvelteKit sends as
 * `{ message }`. Three kinds of failure never got that far:
 *
 *   - A body that is missing or is not JSON made `request.json()` throw, and
 *     a body that is JSON and not an object made the handler's first read of
 *     a field throw. Either was answered 500, as if the server had failed,
 *     where it is the caller's mistake and a 400. So was a body read as a
 *     form that was not sent as one. `guardBody` is the one place that says
 *     so, for every handler.
 *   - A body over the size limit made the read throw the node adapter's 413,
 *     which SvelteKit does not know for one of its own and answered 500.
 *     `guardBody` throws it again as SvelteKit's, and throws the gate's own
 *     count of a body (`BodyOverLimit`) as a 413 with the limit.
 *   - An answer SvelteKit makes without asking a handler, a wrong method
 *     above all, is plain text. `failureAsJson` answers it again as JSON.
 *
 * Each function works on the one request or the one answer it is given and
 * keeps nothing. Which requests they apply to is the gate's to say.
 */
import { STATUS_CODES } from 'node:http';
import { error, json } from '@sveltejs/kit';
import { BodyOverLimit } from './body-limits';

/** The longest text of an answer that is kept as the `message` of the JSON put in its place. */
const LONGEST_KEPT_TEXT = 200;

/**
 * What a read of the body threw, as it is to be thrown on.
 *
 * A body that passes its route's limit as it is read is the gate's to refuse
 * (`heldToLimit` in body-limits.ts): the read fails with `BodyOverLimit`,
 * which is thrown again as SvelteKit's 413 with the limit, in the words and
 * the shape of the 413 for a declared length: `{ message, limitBytes }`.
 *
 * A body that runs past the length it declared is the node adapter's to
 * refuse: it fails the body's stream with a 413, and the read throws that.
 * The adapter is built with a copy of SvelteKit's error class of its own, and
 * SvelteKit takes an error's status only from one it knows by `instanceof`,
 * so the adapter's 413 was answered 500. It is known here by its `status`,
 * whatever class it is, and thrown again as SvelteKit's own, which is
 * answered 413 `{ message }`.
 *
 * Anything else is handed back as it was.
 */
function tooLargeAs413(thrown: unknown): unknown {
	if (thrown instanceof BodyOverLimit) {
		throw error(413, { message: thrown.message, limitBytes: thrown.limitBytes });
	}
	if (typeof thrown === 'object' && thrown !== null && (thrown as { status?: unknown }).status === 413) {
		throw error(413, 'Payload Too Large');
	}
	return thrown;
}

/** The ways a handler can read a body that `guardBody` puts its own in place of. */
type Reader = 'json' | 'formData' | 'arrayBuffer' | 'text' | 'blob' | 'bytes';

/** The two types a body read as a form may be sent as: the two undici's `formData()` reads. */
const FORM_TYPES = ['multipart/form-data', 'application/x-www-form-urlencoded'];

const NOT_A_FORM = 'The request body is not a form';

/**
 * How undici's `formData()` begins the TypeError it throws when it reads the
 * `Content-Type` as neither form type. It reads the whole header, and
 * `application/x-www-form-urlencoded;a=b, text/plain` is a form to
 * `sentAsForm`, which reads up to the first `;`, and not to undici.
 */
const UNDICI_NOT_A_FORM = 'Content-Type was not one of';

/** Does the request say its body is a form? Its `Content-Type`, without its parameters, in any case. */
function sentAsForm(request: Request): boolean {
	const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	return FORM_TYPES.includes(type);
}

/** Put `read` in place of the reader called `name` on this one request object. */
function replaceReader(request: Request, name: Reader, read: () => Promise<unknown>): void {
	Object.defineProperty(request, name, { configurable: true, writable: true, value: read });
}

/**
 * Make reading this request's body answer 400 or 413 when the body is the
 * caller's mistake.
 *
 * `json`, `formData` and `arrayBuffer` are replaced on this one request
 * object: the three ways a handler reads a body. The object is not replaced
 * or wrapped here: SvelteKit hands the handler the same object the gate
 * handed on, so a handler's `await request.json()` meets the replacement and
 * no handler has to change.
 *
 * Read as JSON:
 *
 *   - Nothing to parse, or not JSON: the read throws a SyntaxError, and that
 *     is answered 400. A request with no body at all is the same case.
 *   - JSON that is `null`, a number, a string or a boolean: 400. Every
 *     handler goes on to read a field of its body, which is a fault on `null`
 *     and finds nothing on the others.
 *   - An array: 400, in the same words. No handler takes one. It used to be
 *     passed on, and a handler that gave every field a default made a board
 *     out of `[]`.
 *
 * Read as a form, the request is asked first whether it says its body is
 * one: `multipart/form-data` or `application/x-www-form-urlencoded`, in its
 * `Content-Type`. If not, the answer is 400 `The request body is not a form`,
 * and nothing is read. The read used to throw a TypeError for it, which was a
 * 500, on the attachment upload and on the three form actions (`/login`,
 * `/setup`, `/invite/[token]`) alike. A type that is a form up to its first
 * `;` and not to undici, which reads the whole header
 * (`application/x-www-form-urlencoded;a=b, text/plain`), is read, and undici's
 * TypeError for it is the same 400. A body that says it is a form and is not
 * one, or is cut off as it arrives, still fails in the read, and that is
 * passed on as it was: only a hand-made request sends the first, and the
 * second is no mistake of the caller's.
 *
 * Read in any of the three ways, or with `text()`, `blob()` or `bytes()`, a
 * body over the size limit is answered 413: see `tooLargeAs413`. It is looked
 * for before the SyntaxError, and is never turned into a 400. No route reads
 * its body with the last three; they are here so that a body counted to its
 * limit (`heldToLimit`) is a 413 however it is read.
 *
 * Nothing else is caught: a body that has already been read stays a fault.
 * What the other five read is passed on as it is.
 *
 * A `clone()` of the request is a new object, and is not guarded: no route
 * reads a body from one. The count `heldToLimit` puts on a body is on the
 * body, and holds a clone to the limit all the same.
 */
export function guardBody(request: Request): void {
	const readJson = request.json;

	replaceReader(request, 'json', async (): Promise<unknown> => {
		let body: unknown;
		try {
			body = await readJson.call(request);
		} catch (thrown) {
			if (tooLargeAs413(thrown) instanceof SyntaxError) {
				throw error(400, 'The request body is missing or is not valid JSON');
			}
			throw thrown;
		}
		if (body === null || typeof body !== 'object' || Array.isArray(body)) {
			throw error(400, 'The request body must be a JSON object');
		}
		return body;
	});

	const readForm = request.formData;

	replaceReader(request, 'formData', async (): Promise<unknown> => {
		if (!sentAsForm(request)) throw error(400, NOT_A_FORM);
		try {
			return await readForm.call(request);
		} catch (thrown) {
			const fault = tooLargeAs413(thrown);
			if (fault instanceof TypeError && fault.message.startsWith(UNDICI_NOT_A_FORM)) throw error(400, NOT_A_FORM);
			throw fault;
		}
	});

	for (const name of ['arrayBuffer', 'text', 'blob', 'bytes'] as const) {
		const read: () => Promise<unknown> = request[name];

		replaceReader(request, name, async (): Promise<unknown> => {
			try {
				return await read.call(request);
			} catch (thrown) {
				throw tooLargeAs413(thrown);
			}
		});
	}
}

/** Does this answer say that its body is JSON? */
export function isJsonAnswer(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('json');
}

/**
 * What an answer said, if it said it as a short plain text, and otherwise
 * null. SvelteKit's own text answers carry no content type at all, so an
 * answer without one is read as text. A page of HTML is not read.
 *
 * Nor is a body whose length is not known to be short. It is read only when
 * the answer says how long it is, in `content-length`, and that is no more
 * than the longest text kept: a body of any length is not read through to
 * find that it was too long to keep. SvelteKit's own text answers say their
 * length. One that does not is given the standard phrase for its status.
 */
async function shortPlainText(response: Response): Promise<string | null> {
	const type = (response.headers.get('content-type') ?? '').toLowerCase();
	if (type !== '' && !type.startsWith('text/plain')) return null;
	const length = response.headers.get('content-length');
	if (length === null || !/^\d+$/.test(length.trim()) || Number(length) > LONGEST_KEPT_TEXT) return null;
	try {
		const said = (await response.text()).trim();
		return said !== '' && said.length <= LONGEST_KEPT_TEXT ? said : null;
	} catch {
		// A body that cannot be read says nothing worth keeping.
		return null;
	}
}

/**
 * A new answer with the status of `response`, saying as `{ message }` what it
 * said.
 *
 * It is made from nothing and not from the old answer's headers. Those carry
 * the old body's `content-length` and `content-type`, and an answer sent with
 * them is cut short and read as text. Only `Allow` is copied, which a 405
 * must carry.
 *
 * For a wrong method the text is SvelteKit's own, "<METHOD> method not
 * allowed". For anything else it is what the old answer said, if that was a
 * short plain text, and otherwise the standard phrase for its status.
 */
export async function jsonInPlaceOf(response: Response, method: string): Promise<Response> {
	const message =
		response.status === 405
			? `${method} method not allowed`
			: ((await shortPlainText(response)) ?? STATUS_CODES[response.status] ?? 'Error');

	const headers = new Headers();
	const allow = response.headers.get('allow');
	if (allow !== null) headers.set('allow', allow);

	// The status is the old answer's, so it is not written here as a number,
	// and tests/error-shape.test.ts lists this line as the one answer it
	// cannot read. Move the line and that list has to follow.
	return json({ message }, { status: response.status, headers });
}

/**
 * `response` as it is, unless it is a failure that is not JSON: then a JSON
 * answer in its place, with the same status. A success is never touched,
 * whatever its type: a PDF and the OpenAPI document pass through.
 */
export async function failureAsJson(response: Response, method: string): Promise<Response> {
	if (response.status < 400 || isJsonAnswer(response)) return response;
	return await jsonInPlaceOf(response, method);
}
