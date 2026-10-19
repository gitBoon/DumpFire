/**
 * A request sent through the gate whose body the test holds back, so that
 * something can happen between the gate letting the request in and the body
 * arriving: a password reset, a key deleted, a session ended, a role lowered.
 *
 *     const res = await sendAround('POST', '/api/report-schedules', { session }, body, async () => {
 *         db.delete(sessions).where(eq(sessions.id, session)).run();
 *     });
 *     expect(res).toEqual({ status: 401, body: { message: 'Not authenticated' } });
 *
 * The gate decides who is calling before it hands the body on, so once the
 * body is first asked for, the request has been let in with the caller it had
 * then. What happens meanwhile is what a second request would commit while a
 * slow body was still arriving; the handler meets it when the body comes. A
 * handler that asks again at the write (`writeAs` and `stillCallerNow` in
 * src/lib/server/write-as.ts, card 2253) refuses; one that decides on what the
 * gate read goes through.
 *
 * Moved here from tests/atomic-accounts.test.ts, where the webhook group's
 * tests of the same window were written (the review of card 2168, S1).
 */
import { SESSION_COOKIE_NAME } from '$lib/server/auth';
import { gate } from './gate';

/**
 * A body the test lets go of: bytes as they are, anything else as JSON.
 * `wasAsked` settles when the body is first read, which is after the gate has
 * let the request in; `release` then sends the body, and ends it.
 */
export function heldBody(value: unknown) {
	let asked!: () => void;
	const wasAsked = new Promise<void>((resolve) => (asked = resolve));
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>(
		{
			start: (c) => void (controller = c),
			pull: () => asked()
		},
		{ highWaterMark: 0 }
	);
	const release = () => {
		controller.enqueue(value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value)));
		controller.close();
	};
	return { body, wasAsked, release };
}

/** How the request is let in: an API key, sent as a Bearer header, or a session's token, sent as its cookie. */
export type HeldCredential = { key: string } | { session: string };

/**
 * Sends the request through the gate, lets `meanwhile` happen once the gate
 * has let it in, then sends the body, and answers the status and the answer:
 * parsed when it is JSON, its text when it is not.
 *
 * A request the gate refuses before anything reads its body (a key it does
 * not know, an address it cannot decode) is answered with that refusal, and
 * `meanwhile` is not run: the body is never asked for, and waiting for it
 * would hang the test.
 *
 * The body is JSON unless it is one of two others. A `FormData` is sent as
 * the card modal's upload sends one: written out as multipart, with its
 * boundary in the header, and with the page's own `Origin`, without which
 * SvelteKit refuses a form before the gate. Bytes (a `Uint8Array`) are sent
 * as they are, for a route that takes an upload as its body (the import):
 * say what they are with a `content-type` in `headers`. `headers` are added
 * to the request's own, and may replace its `content-type`, never its key or
 * session.
 */
export async function sendAround(
	method: string,
	path: string,
	credential: HeldCredential,
	value: unknown,
	meanwhile: () => unknown,
	extra: { headers?: Record<string, string> } = {}
): Promise<{ status: number; body: any }> {
	let content = value;
	let contentType = 'application/json';
	const asForm: Record<string, string> = {};
	if (value instanceof FormData) {
		const written = new Response(value);
		contentType = written.headers.get('content-type') ?? 'multipart/form-data';
		content = new Uint8Array(await written.arrayBuffer());
		asForm.origin = 'http://localhost';
	}
	const held = heldBody(content);
	// Asked for as a page's script asks: SvelteKit answers a refusal to a
	// request that asks for nothing in particular with its error page.
	const headers: Record<string, string> = { 'content-type': contentType, accept: 'application/json', ...asForm, ...extra.headers };
	if ('key' in credential) headers.authorization = `Bearer ${credential.key}`;
	else headers.cookie = `${SESSION_COOKIE_NAME}=${credential.session}`;
	const sent = gate(method, path, { headers, body: held.body });
	const first = await Promise.race([held.wasAsked.then(() => 'asked' as const), sent.then(() => 'answered' as const)]);
	if (first === 'asked') {
		await meanwhile();
		held.release();
	}
	const res = await sent;
	const text = await res.text();
	let body: unknown = text;
	if ((res.headers.get('content-type') ?? '').includes('json')) {
		try {
			body = JSON.parse(text);
		} catch {
			// Said to be JSON and not: left as its text, to be seen as it was.
		}
	}
	return { status: res.status, body };
}
