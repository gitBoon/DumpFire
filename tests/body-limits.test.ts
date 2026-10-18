/**
 * How large a request's body may be: what the gate answers a body it will
 * not have read, on every route, and what it lets through.
 *
 * The node adapter has one limit for every route, 512 KB unless
 * `BODY_SIZE_LIMIT` says otherwise, and the image did not say: an attachment
 * or a backup over half a megabyte could not be uploaded. The image sets 512M
 * now, and the gate narrows that again route by route
 * (`src/lib/server/body-limits.ts`):
 *
 *   512K   every request on every route, a page's form action included
 *   26M    POST /api/cards/[id]/attachments, for anybody signed in
 *   all    POST /api/admin/import, for the superadmin
 *
 * A declared length over the limit is refused before the body is read. A
 * body with no declared length, which the adapter holds to no limit at all,
 * is counted as it is read and refused, 413, once it passes the limit. A
 * handler that reads its body inside a catch of its own passes that 413 on.
 *
 * What is held here goes through `gate()`, so it is the real `handle` over
 * the real routes. What `gate()` cannot show is the wire. It hands the gate a
 * `Request` it built itself, and what the node adapter makes of a request
 * that has no body, an empty one, or one sent in chunks is decided before the
 * gate is called. Those rules are read from the adapter's own source below,
 * so that an upgrade which changes one fails here, by name. And the image's
 * setting is the image's: a test reads the `Dockerfile`, and only a container
 * shows that the variable is in it (`docker exec <container> printenv
 * BODY_SIZE_LIMIT`, in docs/deployment.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import {
	BodyOverLimit,
	DEFAULT_BODY_LIMIT,
	IMAGE_BODY_SIZE_LIMIT,
	bodyLimit,
	declaredLength,
	formatBytes,
	heldToLimit,
	parseAsBytes,
	refuseBody,
	serverBodyLimit
} from '$lib/server/body-limits';
import { sqlite } from '$lib/server/db';
import { subscribeToLogs, type LogEntry } from '$lib/server/logger';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import type { Card } from '$lib/server/db/schema';
import { addBoardMember, makeApiKey, makeBoard, makeCard, makeSession, makeUser, resetDb } from './helpers/fixtures';
import { bodyOverTheLimit, gate, gateApiRoutes, type GateOptions } from './helpers/gate';

const K = 1024;
const M = 1024 * K;

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

/** The headers a browser sends with a form it posts to a page. */
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' };
const JSON_BODY = { 'content-type': 'application/json' };

/** A body that is sent in chunks, with no length declared: the one the adapter holds to no limit. */
const inChunks = (text: string | Uint8Array = '{"title":"x"}') =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text);
			controller.close();
		}
	});

/**
 * A body sent in chunks of 64 KB that never ends, and what was done to it:
 * how many chunks were asked of it, and whether it was cancelled. What a
 * caller who means harm sends, with no length declared.
 */
function endless(): { body: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
	let pulled = 0;
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			controller.enqueue(new Uint8Array(64 * K));
		},
		cancel() {
			cancelled = true;
		}
	});
	return { body, pulled: () => pulled, cancelled: () => cancelled };
}

type Answer = { status: number; type: string | null; body: any; location: string | null };

async function send(method: string, path: string, opts: GateOptions = {}): Promise<Answer> {
	const res = await gate(method, path, opts);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		// Not JSON: a page, or nothing.
	}
	return { status: res.status, type: res.headers.get('content-type'), body, location: res.headers.get('location') };
}

/** The gate's own refusal of a declared length: 413, JSON, with the limit in words and as a number. */
function expectTooLarge(res: Answer, limit: number): void {
	expect(res.status).toBe(413);
	expect(res.type).toBe('application/json');
	expect(Object.keys(res.body).sort()).toEqual(['limitBytes', 'message']);
	expect(res.body.limitBytes).toBe(limit);
	expect(res.body.message).toMatch(/^The request is larger than this server accepts here: it is .+, and the limit is .+$/);
	expect(res.body.message.endsWith(`the limit is ${formatBytes(limit)}`)).toBe(true);
}

/**
 * The gate's refusal of a body that declared no length and passed the limit
 * as it was read: 413, JSON, in the same shape as the refusal of a declared
 * length, and with the limit. How large the body was is not said: it was not
 * read to its end.
 */
function expectTooLargeAsRead(res: Answer, limit: number): void {
	expect(res.status).toBe(413);
	expect(res.type).toBe('application/json');
	expect(res.body).toEqual({
		message: `The request is larger than this server accepts here: the limit is ${formatBytes(limit)}`,
		limitBytes: limit
	});
}

let user: SessionUser;
let viewer: SessionUser;
let admin: SessionUser;
let chief: SessionUser;
let card: Card;
let withKey: Record<string, string>;
let asUser: Record<string, string>;
let asViewer: Record<string, string>;
let asAdmin: Record<string, string>;
let asChief: Record<string, string>;

const limitAtStart = process.env.BODY_SIZE_LIMIT;

// The first request of a test file starts the server and loads the gate, and
// that takes seconds while every other file is starting too. Done here, with
// time to do it in, and not inside whichever test happens to be first.
beforeAll(async () => {
	await gateApiRoutes();
	await gate('GET', '/login', { headers: { accept: 'text/html' } });
}, 120_000);

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	// Not set, whatever the shell that started the tests has.
	delete process.env.BODY_SIZE_LIMIT;
	user = makeUser({ username: 'user' });
	viewer = makeUser({ username: 'viewer' });
	admin = makeUser({ username: 'administrator', role: 'admin' });
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	const { board, cols } = makeBoard({ owner: user });
	addBoardMember(board, viewer, 'viewer');
	card = makeCard(cols['To Do']);
	// What a page's script sends: the session, and the page's origin, which a
	// browser puts on every POST. A form (the attachment upload's) posted with
	// none is refused 403 by SvelteKit before the gate, as from another site.
	const cookie = (who: SessionUser) => ({ cookie: `${SESSION_COOKIE_NAME}=${makeSession(who)}`, accept: '*/*', origin: 'http://localhost' });
	withKey = { authorization: `Bearer ${makeApiKey(user)}` };
	asUser = cookie(user);
	asViewer = cookie(viewer);
	asAdmin = cookie(admin);
	asChief = cookie(chief);
});

afterEach(() => {
	vi.restoreAllMocks();
	resetAllRateLimits();
	if (limitAtStart === undefined) delete process.env.BODY_SIZE_LIMIT;
	else process.env.BODY_SIZE_LIMIT = limitAtStart;
});

// ─── A declared length over the limit ────────────────────────────────────────

describe('a request that declares a body larger than its route accepts', () => {
	/** A request of each kind, with the body it would be answered for if it were let through. */
	const ROUTES = [
		{
			name: "a page's form action, POST /login, from nobody",
			path: '/login',
			headers: () => FORM,
			body: 'identity=user&password=wrong'
		},
		{
			name: 'an internal route, POST /api/cards',
			path: '/api/cards',
			headers: () => ({ ...asUser, ...JSON_BODY }),
			body: '{"title":"x"}'
		},
		{
			name: 'a v1 route, POST /api/v1/boards',
			path: '/api/v1/boards',
			headers: () => ({ ...withKey, ...JSON_BODY }),
			body: '{"name":"A board"}'
		},
		{
			name: 'a path that is no route',
			path: '/no-such-page',
			headers: () => ({ ...asUser, ...JSON_BODY }),
			body: '{}'
		},
		{
			name: 'a path the gate passes through without a look, /favicon.ico',
			path: '/favicon.ico',
			headers: () => JSON_BODY,
			body: '{}'
		}
	];

	it.each(ROUTES)('is answered 413 on $name, before anything reads the body', async ({ path, headers, body }) => {
		const read = ['json', 'formData', 'arrayBuffer', 'text'].map((reader) =>
			vi.spyOn(Request.prototype, reader as 'json' | 'formData' | 'arrayBuffer' | 'text')
		);
		const before = { boards: count('boards'), cards: count('cards') };

		const res = await gate('POST', path, {
			headers: { ...headers(), 'content-length': String(DEFAULT_BODY_LIMIT + 1) },
			body
		});
		const called = read.map((reader) => reader.mock.calls.length);
		const answer = { status: res.status, type: res.headers.get('content-type'), body: await res.json(), location: null };

		expectTooLarge(answer, DEFAULT_BODY_LIMIT);
		expect(answer.body.message).toBe(
			'The request is larger than this server accepts here: it is 512.0 KB, and the limit is 512 KB'
		);
		// Nothing of the request was read to give that answer, and nothing was made.
		expect(called).toEqual([0, 0, 0, 0]);
		expect({ boards: count('boards'), cards: count('cards') }).toEqual(before);
	});

	it.each(ROUTES.slice(0, 3))('lets a body of exactly the limit through to $name', async ({ path, headers, body }) => {
		const res = await send('POST', path, {
			headers: { ...headers(), 'content-length': String(DEFAULT_BODY_LIMIT) },
			body
		});

		// Whatever the handler made of it, it was the handler that answered.
		expect(res.status).not.toBe(413);
		expect(res.status).toBeLessThan(500);
	});

	it('is refused whoever sends it, signed in or not, and before a key or a session is looked at', async () => {
		const declared = { 'content-length': String(2 * M) };

		// No session on an internal route: a small body is answered 401, and one
		// over the limit is refused for its size first.
		expect((await send('POST', '/api/cards', { headers: JSON_BODY, body: '{}' })).status).toBe(401);
		expectTooLarge(await send('POST', '/api/cards', { headers: { ...JSON_BODY, ...declared }, body: '{}' }), DEFAULT_BODY_LIMIT);
		// No key on a v1 route.
		expectTooLarge(await send('POST', '/api/v1/boards', { headers: { ...JSON_BODY, ...declared }, body: '{}' }), DEFAULT_BODY_LIMIT);
	});

	it('is written to the system log as the 413 it was answered', async () => {
		const lines: LogEntry[] = [];
		const level = process.env.LOG_LEVEL;
		const unsubscribe = subscribeToLogs((entry) => {
			if (entry.context === 'HTTP') lines.push(entry);
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.LOG_LEVEL = 'INFO';
		try {
			await gate('POST', '/api/cards', {
				headers: { ...asUser, ...JSON_BODY, 'content-length': String(DEFAULT_BODY_LIMIT + 1) },
				body: '{}'
			});
			// And one with no length, refused as it was read.
			await gate('POST', '/api/cards', { headers: { ...asUser, ...JSON_BODY, accept: '*/*' }, body: endless().body });
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			unsubscribe();
		}

		expect(lines.map((line) => [line.level, line.message.replace(/ \(\d+ms\)$/, '')])).toEqual([
			['WARN', 'POST /api/cards → 413'],
			['WARN', 'POST /api/cards → 413']
		]);
	});
});

// ─── The two routes that accept more ─────────────────────────────────────────

describe('the attachment upload, POST /api/cards/[id]/attachments', () => {
	const upload = (): FormData => {
		const form = new FormData();
		form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
		return form;
	};
	const to = () => `/api/cards/${card.id}/attachments`;

	it('lets a body declared as 5 MB through the gate, and the file is attached', async () => {
		const res = await send('POST', to(), { headers: { ...asUser, 'content-length': String(5 * M) }, body: upload() });

		expect(res.status).toBe(200);
		expect(res.body.originalName).toBe('hello.txt');
		expect(count('card_attachments')).toBe(1);
	});

	it('lets one of exactly 26 MB through, and refuses one of 27 MB with the limit', async () => {
		const at = await send('POST', to(), { headers: { ...asUser, 'content-length': String(26 * M) }, body: upload() });
		expect(at.status).toBe(200);

		const over = await send('POST', to(), { headers: { ...asUser, 'content-length': String(27 * M) }, body: upload() });
		expectTooLarge(over, 26 * M);
		expect(over.body.message).toBe('The request is larger than this server accepts here: it is 27 MB, and the limit is 26 MB');
		expect(count('card_attachments')).toBe(1);
	});

	it('gives the larger limit to nobody who is not signed in: they are answered 401 with the body unread', async () => {
		const read = vi.spyOn(Request.prototype, 'formData');

		const res = await send('POST', to(), { headers: { origin: 'http://localhost', 'content-length': String(5 * M) }, body: upload() });

		expect({ status: res.status, location: res.location }).toEqual({ status: 401, location: null });
		expect(read).not.toHaveBeenCalled();
		expect(count('card_attachments')).toBe(0);
	});

	it('is refused to a caller who cannot edit the card before the 5 MB is read', async () => {
		const read = vi.spyOn(Request.prototype, 'formData');

		const res = await send('POST', to(), { headers: { ...asViewer, 'content-length': String(5 * M) }, body: upload() });

		expect(res.status).toBe(403);
		expect(read).not.toHaveBeenCalled();
		expect(count('card_attachments')).toBe(0);
	});

	it('is the only method of the route that is given it', async () => {
		// A GET has no body to hold to anything, and no other route under the card is given more.
		const comment = await send('POST', `/api/cards/${card.id}/comments`, {
			headers: { ...asUser, ...JSON_BODY, 'content-length': String(5 * M) },
			body: '{"content":"x"}'
		});

		expectTooLarge(comment, DEFAULT_BODY_LIMIT);
	});
});

describe('the import, POST /api/admin/import', () => {
	const BACKUP = { 'content-type': 'application/octet-stream' };
	/** Not a backup: let through the gate, the handler says so and changes nothing. */
	const NOT_A_BACKUP = { status: 400, message: 'Invalid file — not a SQLite database' };
	const importing = async (headers: Record<string, string>, declared: number) => {
		const res = await send('POST', '/api/admin/import', {
			headers: { ...headers, ...BACKUP, 'content-length': String(declared) },
			body: new TextEncoder().encode('not a database')
		});
		return { status: res.status, message: res.body?.message, limitBytes: res.body?.limitBytes, location: res.location };
	};

	it('accepts up to the limit the server was started with, and no more', async () => {
		process.env.BODY_SIZE_LIMIT = '2M';

		expect(await importing(asChief, 2 * M)).toMatchObject(NOT_A_BACKUP);
		const over = await importing(asChief, 2 * M + 1);
		expect({ status: over.status, limitBytes: over.limitBytes }).toEqual({ status: 413, limitBytes: 2 * M });
		expect(over.message).toBe('The request is larger than this server accepts here: it is 2.0 MB, and the limit is 2 MB');
	});

	it("accepts what the image sets, 512M, where the dev server was given no limit of its own", async () => {
		expect(await importing(asChief, 512 * M)).toMatchObject(NOT_A_BACKUP);
		expect((await importing(asChief, 512 * M + 1)).status).toBe(413);
	});

	it('accepts any length where the limit is Infinity, which is how the adapter is told to have none', async () => {
		process.env.BODY_SIZE_LIMIT = 'Infinity';

		expect(await importing(asChief, 64 * 1024 * M)).toMatchObject(NOT_A_BACKUP);
	});

	it('is the superadmin’s: an administrator and a user are refused before a byte of it is read, and nobody is told to sign in', async () => {
		process.env.BODY_SIZE_LIMIT = '2M';
		const read = vi.spyOn(Request.prototype, 'arrayBuffer');

		for (const refused of [asAdmin, asUser]) {
			const res = await importing(refused, 512 * K);
			expect(res.status).toBe(403);
			expect(res.message).toContain('belongs to the superadmin');
		}
		expect(await importing({}, 2 * M)).toMatchObject({ status: 401, message: 'Not authenticated', location: null });
		expect(read).not.toHaveBeenCalled();

		// Over the limit, it is the size that is refused, whoever sends it.
		for (const anyone of [asAdmin, asUser, {}]) expect((await importing(anyone, 2 * M + 1)).status).toBe(413);
	});

	it('gives the whole of the server’s limit to the superadmin alone: anybody else signed in is held to 512K', async () => {
		process.env.BODY_SIZE_LIMIT = '2M';
		const read = vi.spyOn(Request.prototype, 'arrayBuffer');

		// An administrator and a user who declare a whole backup are refused for
		// its size, before the handler refuses them for who they are, and none
		// of it is read.
		for (const refused of [asAdmin, asUser]) {
			const res = await importing(refused, 2 * M);
			expect({ status: res.status, limitBytes: res.limitBytes }).toEqual({ status: 413, limitBytes: DEFAULT_BODY_LIMIT });
			expect(res.message).toBe('The request is larger than this server accepts here: it is 2 MB, and the limit is 512 KB');
		}
		expect(read).not.toHaveBeenCalled();

		// The superadmin is given all of it.
		expect(await importing(asChief, 2 * M)).toMatchObject(NOT_A_BACKUP);
	});

	it('holds a backup sent in chunks, with no length, to the same limits as it is read', async () => {
		process.env.BODY_SIZE_LIMIT = '2M';
		const send_ = (headers: Record<string, string>) => {
			const sent = endless();
			return send('POST', '/api/admin/import', { headers: { ...headers, ...BACKUP, accept: '*/*' }, body: sent.body }).then(
				(res) => ({ res, pulled: sent.pulled() })
			);
		};

		const chief_ = await send_(asChief);
		expectTooLargeAsRead(chief_.res, 2 * M);
		// Read to just past the limit, and no further.
		expect(chief_.pulled * 64 * K).toBeLessThanOrEqual(2 * M + 4 * 64 * K);

		// An administrator is refused by the handler before any of it is read.
		// A stream is asked for a chunk or two as soon as it is handed on, to
		// have them ready, and for no more.
		const admin_ = await send_(asAdmin);
		expect(admin_.res.status).toBe(403);
		expect(admin_.pulled).toBeLessThanOrEqual(2);
		expect(count('users')).toBe(4);
	});
});

// ─── A body with no declared length ──────────────────────────────────────────

describe('a request that has a body and does not say how long it is', () => {
	// A client may send a body in chunks, and a proxy may pass one on so. The
	// last two read their body inside a catch of their own, which swallowed
	// the 413: Run Backup Now ran a backup, and a confirmation was answered
	// 404 as a link that is not valid.
	it.each([
		{ name: 'an internal route', path: '/api/cards', headers: () => ({ ...asUser, ...JSON_BODY, accept: '*/*' }), limit: DEFAULT_BODY_LIMIT },
		{ name: 'a v1 route', path: '/api/v1/boards', headers: () => ({ ...withKey, ...JSON_BODY }), limit: DEFAULT_BODY_LIMIT },
		{
			name: 'the attachment upload',
			path: '',
			headers: () => ({ ...asUser, 'content-type': 'multipart/form-data; boundary=x' }),
			limit: 26 * M
		},
		{
			name: 'the import, sent by the superadmin',
			path: '/api/admin/import',
			headers: () => ({ ...asChief, 'content-type': 'application/octet-stream' }),
			limit: 2 * M
		},
		{ name: 'the public request form', path: '/api/requests', headers: () => ({ ...asUser, ...JSON_BODY, accept: '*/*' }), limit: DEFAULT_BODY_LIMIT },
		{ name: 'Run Backup Now', path: '/api/admin/backup', headers: () => ({ ...asChief, ...JSON_BODY, accept: '*/*' }), limit: DEFAULT_BODY_LIMIT },
		{
			name: 'the confirmation of a public request',
			path: '/api/requests/1/confirm',
			headers: () => ({ ...JSON_BODY, accept: '*/*' }),
			limit: DEFAULT_BODY_LIMIT
		}
	])('is read on $name until it passes the route’s limit, and answered 413 there, with the limit', async ({ path, headers, limit }) => {
		process.env.BODY_SIZE_LIMIT = '2M';
		const sent = endless();
		const before = { boards: count('boards'), cards: count('cards'), users: count('users'), attachments: count('card_attachments') };

		const res = await send('POST', path || `/api/cards/${card.id}/attachments`, { headers: headers(), body: sent.body });

		expectTooLargeAsRead(res, limit);
		// Read to just past the limit, and no further.
		expect(sent.pulled() * 64 * K).toBeGreaterThan(limit);
		expect(sent.pulled() * 64 * K).toBeLessThanOrEqual(limit + 4 * 64 * K);
		// And left unread, not cancelled: the adapter answers a cancel by
		// closing the connection, and the 413 would never reach the caller.
		expect(sent.cancelled()).toBe(false);
		expect({ boards: count('boards'), cards: count('cards'), users: count('users'), attachments: count('card_attachments') }).toEqual(
			before
		);
	});

	it('is answered 413 with the limit on a page’s form action, as a page and as the JSON a page’s script reads', async () => {
		const asPage = await gate('POST', '/login', { headers: { ...FORM, accept: 'text/html' }, body: endless().body });
		expect(asPage.status).toBe(413);
		expect(await asPage.text()).toContain('The request is larger than this server accepts here: the limit is 512 KB');

		const asScript = await send('POST', '/login', { headers: { ...FORM, accept: 'application/json' }, body: endless().body });
		expect({ status: asScript.status, body: asScript.body }).toEqual({
			status: 413,
			body: {
				type: 'error',
				error: { message: 'The request is larger than this server accepts here: the limit is 512 KB', limitBytes: DEFAULT_BODY_LIMIT }
			}
		});
	});

	it('is let through, and read as any other body, when it is within the limit', async () => {
		// Each answered by its handler, as a body that says its length is.
		expect(
			await send('POST', '/api/cards', { headers: { ...asUser, ...JSON_BODY, accept: '*/*' }, body: inChunks() })
		).toMatchObject({ status: 400, body: { message: 'Invalid column ID' } });
		expect(
			await send('POST', '/api/v1/boards', { headers: { ...withKey, ...JSON_BODY }, body: inChunks('{"name":"Sent in chunks"}') })
		).toMatchObject({ status: 201, body: { name: 'Sent in chunks' } });
		// The sign-in form, as a browser posts it through a proxy that passes it on in chunks.
		const login = await send('POST', '/login', { headers: { ...FORM, accept: 'text/html' }, body: inChunks('identity=user&password=wrong') });
		expect(login.status).toBe(400);
		expect(login.body).toContain('Invalid username/email or password');

		const form = new FormData();
		form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
		const written = new Response(form);
		const upload = await send('POST', `/api/cards/${card.id}/attachments`, {
			headers: { ...asUser, 'content-type': written.headers.get('content-type') as string },
			body: inChunks(new Uint8Array(await written.arrayBuffer()))
		});
		expect({ status: upload.status, name: upload.body.originalName }).toEqual({ status: 200, name: 'hello.txt' });
	});

	it('is held to the limit to the byte: exactly the limit is read, and one byte more is refused', async () => {
		const at = await send('POST', '/api/cards', {
			headers: { ...asUser, ...JSON_BODY, accept: '*/*' },
			body: inChunks(new Uint8Array(DEFAULT_BODY_LIMIT).fill(0x20))
		});
		// Spaces are no JSON: the handler read all of it, and said so.
		expect(at).toMatchObject({ status: 400, body: { message: 'The request body is missing or is not valid JSON' } });

		const over = await send('POST', '/api/cards', {
			headers: { ...asUser, ...JSON_BODY, accept: '*/*' },
			body: inChunks(new Uint8Array(DEFAULT_BODY_LIMIT + 1).fill(0x20))
		});
		expectTooLargeAsRead(over, DEFAULT_BODY_LIMIT);
	});

	it('is counted as one with no length when its Content-Length is no number', async () => {
		for (const said of ['', 'many', '-5', '1e3', '12 bytes']) {
			const res = await send('POST', '/api/cards', {
				headers: { ...asUser, ...JSON_BODY, accept: '*/*', 'content-length': said },
				body: endless().body
			});
			expectTooLargeAsRead(res, DEFAULT_BODY_LIMIT);
		}
		// And one that says its length is let through and held to it.
		const declared = await send('POST', '/api/cards', {
			headers: { ...asUser, ...JSON_BODY, 'content-length': '13' },
			body: inChunks()
		});
		expect(declared.body).toEqual({ message: 'Invalid column ID' });
	});
});

describe('a request with no body, or an empty one', () => {
	it('is not asked for a length: a GET, a DELETE with nothing in it, and a POST with nothing in it', async () => {
		expect((await send('GET', '/api/boards', { headers: asUser })).status).toBe(200);
		expect((await send('GET', '/login', { headers: { accept: 'text/html' } })).status).toBe(200);

		// No body, with and without a Content-Type: the card is looked for.
		expect(await send('DELETE', '/api/cards/999999', { headers: asUser })).toMatchObject({
			status: 404,
			body: { message: 'Card not found' }
		});
		expect((await send('DELETE', '/api/cards/999999', { headers: { ...asUser, ...JSON_BODY } })).status).toBe(404);
		expect((await send('DELETE', '/api/v1/cards/999999', { headers: withKey })).status).toBe(404);

		// A POST with no body at all, as a button that sends nothing does.
		expect((await send('POST', '/api/admin/vacuum', { headers: asAdmin })).status).toBe(200);
		// And one whose body is empty: it is the handler that says it is not JSON.
		expect(await send('POST', '/api/cards', { headers: { ...asUser, ...JSON_BODY }, body: '' })).toMatchObject({
			status: 400,
			body: { message: 'The request body is missing or is not valid JSON' }
		});
	});

	it('is not refused for a length it declares and does not send: a GET has no body to be that long', async () => {
		const res = await send('GET', '/api/boards', { headers: { ...asUser, 'content-length': String(64 * M) } });

		expect(res.status).toBe(200);
	});

	it('is sent with its length by gate(), as a browser sends a form and a page sends JSON', async () => {
		const form = new FormData();
		form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));

		// Neither test declares a length: the harness does, as the client would.
		expect((await send('POST', `/api/cards/${card.id}/attachments`, { headers: asUser, body: form })).status).toBe(200);
		expect((await send('POST', '/api/boards', { headers: asUser, body: { name: 'A board' } })).status).toBe(201);
		// A form posted by a browser, which asks for a page: the action reads it and says the password is wrong.
		const login = await send('POST', '/login', { headers: { ...FORM, accept: 'text/html' }, body: 'identity=user&password=wrong' });
		expect(login.status).toBe(400);
	});
});

// ─── The three form actions ──────────────────────────────────────────────────

describe('a form posted to a page with a body that runs past the length it declared', () => {
	// The adapter fails such a body when it is read, with a 413 of a class
	// SvelteKit does not know for one: a 500, wherever the read was not
	// guarded. It was guarded under /api/ only.
	const overrun = () => ({ headers: { ...FORM, 'content-length': '100', accept: 'text/html' }, body: bodyOverTheLimit() });

	it.each(['/login', '/invite/no-such-invite'])('is answered 413 and not 500 on %s', async (path) => {
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await gate('POST', path, overrun());

		expect(res.status).toBe(413);
		expect(await res.text()).toContain('Payload Too Large');
		expect(reported).not.toHaveBeenCalled();
	});

	it('is answered 413 and not 500 on /setup, which is open while there are no users', async () => {
		resetDb();
		const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await gate('POST', '/setup', overrun());

		expect(res.status).toBe(413);
		expect(reported).not.toHaveBeenCalled();
		expect(count('users')).toBe(0);
	});

	it('is answered 413 to a form sent by script as well, in the shape a form action answers in', async () => {
		const res = await gate('POST', '/login', {
			headers: { ...FORM, 'content-length': '100', accept: 'application/json' },
			body: bodyOverTheLimit()
		});

		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ type: 'error', error: { message: 'Payload Too Large' } });
	});
});

// ─── The functions ───────────────────────────────────────────────────────────

/** The node adapter's handler, as it is installed: what a built server runs in front of the gate. */
const ADAPTER = readFileSync(join(process.cwd(), 'node_modules/@sveltejs/adapter-node/files/handler.js'), 'utf8');
/** SvelteKit's `@sveltejs/kit/node`, whose `getRequest` the handler builds every request with. */
const KIT_NODE = readFileSync(join(process.cwd(), 'node_modules/@sveltejs/kit/src/exports/node/index.js'), 'utf8');
/** Its helpers, which the handler imports: `parse_as_bytes` is here, not in handler.js, in adapter-node 5.5.7 (card 2227). */
const ADAPTER_UTILS = readFileSync(join(process.cwd(), 'node_modules/@sveltejs/adapter-node/files/utils.js'), 'utf8');

describe('the limit, read as the node adapter reads it', () => {
	/** The adapter's own `parse_as_bytes`, taken out of its source and run. */
	const theirs = (() => {
		const source = /\nfunction parse_as_bytes\(value\) \{\n[\s\S]*?\n\}\n/.exec(ADAPTER_UTILS);
		if (!source) throw new Error('The adapter has no parse_as_bytes: read how it parses BODY_SIZE_LIMIT now');
		return new Function(`${source[0]}; return parse_as_bytes;`)() as (value: string) => number;
	})();

	it.each([
		['512M', 512 * M],
		['512K', 512 * K],
		['1G', 1024 * M],
		['1048576', 1048576],
		['512m', 512 * M],
		['12.5K', 12800],
		['Infinity', Infinity],
		['0', 0],
		// What the adapter makes of these is not what a person would: it is what it does.
		['', 0],
		['M', 0],
		['512 M', 512 * M]
	])('reads %j as %d bytes, as the adapter does', (value, bytes) => {
		expect(theirs(value)).toBe(bytes);
		expect(parseAsBytes(value)).toBe(bytes);
	});

	it.each(['512MB', '512 MB', 'half a gig', '1T', 'M512'])('reads %j as no number at all, as the adapter does', (value) => {
		// "512MB" above all: its last letter is no unit, and the adapter refuses to start on it.
		expect(theirs(value)).toBeNaN();
		expect(parseAsBytes(value)).toBeNaN();
	});

	it('is 512K where the server was given none, as the adapter has it, and is what is set where one was', () => {
		expect(ADAPTER).toContain("const body_size_limit = parse_as_bytes(env('BODY_SIZE_LIMIT', '512K'));");
		// And the parse_as_bytes it calls is the one read above.
		expect(ADAPTER).toMatch(/^import \{[^}]*\bparse_as_bytes\b[^}]*\} from '\.\/utils\.js';$/m);

		expect(serverBodyLimit(undefined, false)).toBe(512 * K);
		expect(serverBodyLimit('512M', false)).toBe(512 * M);
		expect(serverBodyLimit('Infinity', false)).toBe(Infinity);
		// No number: the adapter does not start. Read here as its default.
		expect(serverBodyLimit('512MB', false)).toBe(512 * K);
		// The dev server has no adapter and no limit: it is given the image's.
		expect(serverBodyLimit(undefined, true)).toBe(512 * M);
		expect(serverBodyLimit('1M', true)).toBe(M);
	});

	it('is what the Dockerfile sets, written as the adapter can read it', () => {
		const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
		const set = /^ENV BODY_SIZE_LIMIT=(\S+)$/m.exec(dockerfile);

		expect(set?.[1]).toBe(IMAGE_BODY_SIZE_LIMIT);
		expect(theirs(IMAGE_BODY_SIZE_LIMIT)).toBe(512 * M);
		// Set once, and after the line that names the production stage.
		expect(dockerfile.match(/^ENV BODY_SIZE_LIMIT=/gm)).toHaveLength(1);
		expect(dockerfile.indexOf('ENV BODY_SIZE_LIMIT=')).toBeGreaterThan(dockerfile.indexOf('AS production'));
	});
});

describe('the limit of a route', () => {
	const built = { isDev: false, limit: '512M' };
	const ATTACHMENTS = '/api/cards/[id]/attachments';
	const IMPORT = '/api/admin/import';

	it('is 512K on every route but two, whoever is asking', () => {
		for (const caller of ['not yet known', 'nobody', 'signed in', 'the superadmin'] as const) {
			for (const [method, route] of [
				['POST', '/login'],
				['POST', '/api/cards'],
				['POST', '/api/v1/cards/[cardId]/attachments'],
				['PUT', ATTACHMENTS],
				['GET', IMPORT],
				['POST', '/api/admin/export'],
				['POST', '/no-such-page']
			]) {
				expect(bodyLimit(route, method, caller, built), `${method} ${route}`).toBe(DEFAULT_BODY_LIMIT);
			}
		}
	});

	it('is 26M for an attachment, for a caller who is signed in, and the whole of the server’s for an import, for the superadmin', () => {
		expect(bodyLimit(ATTACHMENTS, 'POST', 'signed in', built)).toBe(26 * M);
		expect(bodyLimit(ATTACHMENTS, 'POST', 'the superadmin', built)).toBe(26 * M);
		expect(bodyLimit(IMPORT, 'POST', 'the superadmin', built)).toBe(512 * M);
		// The import is the superadmin's: anybody else signed in gets the default.
		expect(bodyLimit(IMPORT, 'POST', 'signed in', built)).toBe(DEFAULT_BODY_LIMIT);
		// And for one the gate has not yet asked: the most it would give anybody.
		expect(bodyLimit(ATTACHMENTS, 'POST', 'not yet known', built)).toBe(26 * M);
		expect(bodyLimit(IMPORT, 'POST', 'not yet known', built)).toBe(512 * M);
		expect(bodyLimit(ATTACHMENTS, 'post', 'signed in', built)).toBe(26 * M);
	});

	it('is 512K on those two as well for a caller who is known to be nobody', () => {
		// What the gate asks when it hands a request on with no session. Both
		// routes turn such a caller away before that, so `gate()` cannot reach
		// this: it is what keeps it so if one of them is ever made public.
		expect(bodyLimit(ATTACHMENTS, 'POST', 'nobody', built)).toBe(DEFAULT_BODY_LIMIT);
		expect(bodyLimit(IMPORT, 'POST', 'nobody', built)).toBe(DEFAULT_BODY_LIMIT);
	});

	it('is never more, in a built server, than the server accepts at all', () => {
		// Started with no BODY_SIZE_LIMIT, the adapter fails a body over 512K
		// half way through: refused here instead, with the limit in the answer.
		expect(bodyLimit(ATTACHMENTS, 'POST', 'signed in', { isDev: false, limit: '512K' })).toBe(512 * K);
		expect(bodyLimit(IMPORT, 'POST', 'the superadmin', { isDev: false, limit: '512K' })).toBe(512 * K);
		expect(bodyLimit('/api/cards', 'POST', 'signed in', { isDev: false, limit: '100K' })).toBe(100 * K);
		expect(bodyLimit(ATTACHMENTS, 'POST', 'signed in', { isDev: false, limit: '1G' })).toBe(26 * M);
		// The dev server enforces none, so a route's own limit stands.
		expect(bodyLimit(ATTACHMENTS, 'POST', 'signed in', { isDev: true, limit: '512K' })).toBe(26 * M);
	});
});

describe('refuseBody, on one request', () => {
	const request = (init: RequestInit & { duplex?: 'half' }) => new Request('http://localhost/api/cards', init);

	it('refuses nothing that has no body, whatever length it declares', () => {
		expect(refuseBody(request({ method: 'GET' }), 0)).toBeNull();
		expect(refuseBody(request({ method: 'DELETE', headers: { 'content-length': '999999999' } }), 0)).toBeNull();
		expect(refuseBody(request({ method: 'POST' }), 0)).toBeNull();
	});

	it('lets a body with no length through to be counted, and answers 413 for one declared over the limit, as JSON with a message', async () => {
		// No length: held to the limit as it is read, by heldToLimit.
		expect(refuseBody(request({ method: 'POST', body: inChunks(), duplex: 'half' }), 100)).toBeNull();

		const over = refuseBody(request({ method: 'POST', body: 'x', headers: { 'content-length': '101' } }), 100);
		expect(over?.status).toBe(413);
		expect(await over?.json()).toEqual({
			message: 'The request is larger than this server accepts here: it is 101 bytes, and the limit is 100 bytes',
			limitBytes: 100
		});

		expect(refuseBody(request({ method: 'POST', body: 'x', headers: { 'content-length': '100' } }), 100)).toBeNull();
		expect(refuseBody(request({ method: 'POST', body: 'x', headers: { 'content-length': '1' } }), Infinity)).toBeNull();
	});

	it('reads a declared length as a whole number of bytes, and anything else as none', () => {
		const declaring = (value: string) => declaredLength(request({ method: 'POST', body: 'x', headers: { 'content-length': value } }));

		expect(declaring('0')).toBe(0);
		expect(declaring(' 27262976 ')).toBe(27262976);
		for (const none of ['', 'x', '-1', '1.5', '0x10', '1e3']) expect(declaring(none), none).toBeNull();
		expect(declaredLength(request({ method: 'POST', body: 'x' }))).toBeNull();
	});

	it('says a size as a person reads it', () => {
		expect([512 * K, 26 * M, 512 * M, 1024 * M, 600000, 100, 1536 * M].map(formatBytes)).toEqual([
			'512 KB',
			'26 MB',
			'512 MB',
			'1 GB',
			'585.9 KB',
			'100 bytes',
			'1.5 GB'
		]);
	});
});

describe('heldToLimit, on one request', () => {
	const sending = (body: BodyInit | ReadableStream<Uint8Array>, type = 'text/plain') =>
		new Request('http://localhost/api/cards', { method: 'POST', headers: { 'content-type': type }, body, duplex: 'half' } as RequestInit);
	const over = (reading: Promise<unknown>) => reading.then(() => null, (thrown: unknown) => thrown);

	it('fails a read that passes the limit with BodyOverLimit, however the body is read', async () => {
		const readers: [string, (request: Request) => Promise<unknown>][] = [
			['json', (r) => r.json()],
			['formData', (r) => r.formData()],
			['arrayBuffer', (r) => r.arrayBuffer()],
			['text', (r) => r.text()],
			['blob', (r) => r.blob()],
			['bytes', (r) => r.bytes()],
			['a clone', (r) => r.clone().text()],
			['the stream itself', (r) => new Response(r.body).text()]
		];

		for (const [how, read] of readers) {
			const thrown = await over(read(heldToLimit(sending(inChunks('a=1&b=22'), 'application/x-www-form-urlencoded'), 7)));
			expect(thrown, how).toBeInstanceOf(BodyOverLimit);
			expect(thrown, how).toMatchObject({ status: 413, limitBytes: 7 });
		}
	});

	it('passes on a body of up to the limit as it was sent, with the method, the address and the headers', async () => {
		const original = sending(inChunks('a=1&b=22'), 'application/x-www-form-urlencoded');
		const held = heldToLimit(original, 8);

		expect(held).not.toBe(original);
		expect({ method: held.method, url: held.url, type: held.headers.get('content-type') }).toEqual({
			method: 'POST',
			url: 'http://localhost/api/cards',
			type: 'application/x-www-form-urlencoded'
		});
		expect([...(await held.formData()).entries()]).toEqual([
			['a', '1'],
			['b', '22']
		]);
	});

	it('hands back a request with no body, or with no limit, as it was', () => {
		const empty = new Request('http://localhost/api/cards', { method: 'POST' });
		expect(heldToLimit(empty, 0)).toBe(empty);
		const unlimited = sending('x');
		expect(heldToLimit(unlimited, Infinity)).toBe(unlimited);
	});

	it('passes on the adapter’s own failure of a body as it was', async () => {
		const adapters = Object.assign(new Error('request body size exceeded content-length of 100'), { status: 413 });
		const failing = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(adapters) });

		expect(await over(heldToLimit(sending(failing), 1000).json())).toBe(adapters);
	});
});

describe('what the node adapter makes of a request before the gate is called', () => {
	// `gate()` builds its own `Request`, so none of this can be shown through
	// it. These are the lines of the adapter that body-limits.ts goes by: a
	// request it gives no body to is one the gate never refuses, a body with
	// no declared length is one the adapter holds to `BODY_SIZE_LIMIT` alone
	// and never to its route's limit, and a body that is cancelled is a
	// connection that is closed. If an upgrade changes one of them, this is the
	// test that fails.
	//
	// Since adapter-node 5.5.5 the handler builds its request with SvelteKit's
	// own `getRequest` (`@sveltejs/kit/node`), bundled into the built server
	// from the SvelteKit that is installed, and no longer with a copy of its
	// own; so the rules are read from there (card 2227).
	const rule = /\nfunction get_raw_body\(req, body_size_limit\) \{\n[\s\S]*?\n\}\n/.exec(KIT_NODE)?.[0] ?? '';

	it('builds its request with SvelteKit’s getRequest, given the server’s limit', () => {
		expect(ADAPTER).toMatch(/^import \{[^}]*\bgetRequest\b[^}]*\} from '@sveltejs\/kit\/node';$/m);
		expect(ADAPTER).toContain('bodySizeLimit: body_size_limit');
	});

	it('gives a request no body when it has no Content-Type, a Content-Length of 0, or neither a length nor an encoding', () => {
		expect(rule).toContain("if (!h['content-type']) {\n\t\treturn null;\n\t}");
		expect(rule).toContain("const content_length = Number(h['content-length']);");
		expect(rule).toContain('const has_content_length = Number.isFinite(content_length);');
		expect(rule).toContain(
			"(req.httpVersionMajor === 1 && !has_content_length && h['transfer-encoding'] == null) ||\n\t\tcontent_length === 0\n\t) {\n\t\treturn null;"
		);
		// And never to a GET or a HEAD, whatever it carries.
		expect(KIT_NODE).toContain(
			"request.method === 'GET' || request.method === 'HEAD'\n\t\t\t\t? undefined\n\t\t\t\t: get_raw_body(request, bodySizeLimit)"
		);
	});

	it('holds a body to the length it declared, and one that declared none to the server’s limit alone', () => {
		// Refused at the start if it declares more than the server's limit.
		expect(rule).toContain('if (body_size_limit !== undefined && has_content_length && content_length > body_size_limit) {');
		// And failed as it is read if it runs past what it declared, or past
		// the server's limit, `BODY_SIZE_LIMIT`, 512M in the image. That is
		// the largest any route accepts, and nothing smaller: the gate's count
		// is still what holds a body in chunks to its route's limit.
		expect(rule).toContain('if (has_content_length && size > content_length) {');
		expect(rule).toContain('if (body_size_limit !== undefined && size > body_size_limit) {');
	});

	it('closes the connection when a body is cancelled, which is why the gate leaves one it has refused unread', () => {
		// `heldToLimit` stops reading at the limit and never cancels the body:
		// a cancel would destroy the request, and its socket with it, before
		// the 413 could be sent.
		expect(rule).toContain('cancel(reason) {\n\t\t\tcancelled = true;\n\t\t\treq.destroy(reason);\n\t\t}');
	});
});
