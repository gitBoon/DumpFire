/**
 * The public request form — the one part of DumpFire reachable without an account.
 *
 * Four things used to be true and must not be:
 *   - one unauthenticated call listed every user, team and board;
 *   - every submission emailed the team, so the form was an open relay to them;
 *   - a requester's email address opened their request thread;
 *   - a requester's replies were not limited, and each one mailed the team.
 *
 * And a requester whose link no longer works asks for the current one to be
 * mailed to the address the request was made with (card 2158), or, for one
 * made signed in, the account's email as it is now (card 2171), without the
 * answer telling anyone whether a request exists or whose it is.
 *
 * No email is sent by these tests. `trySendEmail`, which every notification
 * is sent through (card 2196), is replaced with a recorder, and "is SMTP
 * configured" is a switch the test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mail = vi.hoisted(() => ({
	configured: true,
	/** True for a server with no address to make a link from (card 2158). */
	noAddress: false,
	sent: [] as { to: string; subject: string; html: string }[]
}));

vi.mock('$lib/server/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/email')>();
	return {
		...actual,
		isSmtpConfigured: () => mail.configured,
		linkBaseUrl: (...args: Parameters<typeof actual.linkBaseUrl>) => (mail.noAddress ? null : actual.linkBaseUrl(...args)),
		trySendEmail: async (to: string, subject: string, html: string) => {
			mail.sent.push({ to, subject, html });
			return { sent: true } as const;
		}
	};
});

import { db, sqlite } from '$lib/server/db';
import { requestMessages, taskRequests, users } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken, verifyFormToken } from '$lib/server/request-tokens';
import { canHandleRequest, canReadRequest, hasLapsed, unconfirmedCutoff, UNVERIFIED_LIFETIME_DAYS } from '$lib/server/request-access';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { makeBoard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

let staff: SessionUser;
let other: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	mail.configured = true;
	mail.noAddress = false;
	mail.sent.length = 0;
	staff = makeUser({ username: 'staff' });
	other = makeUser({ username: 'other' });
	A = makeBoard({ owner: staff, name: 'A' });
});

const REQUESTER = 'pat@example.test';

/** A submission as the public form makes it. */
const submission = (overrides: Record<string, unknown> = {}) => ({
	targetType: 'user',
	targetId: staff.id,
	desiredBoardId: A.board.id,
	title: 'Please add an export',
	description: 'CSV would do',
	priority: 'medium',
	requesterName: 'Pat',
	requesterEmail: REQUESTER,
	...overrides
});

const submitAnonymously = (
	overrides: Record<string, unknown> = {},
	opts: { ip?: string; token?: string | null } = {}
) =>
	api('POST', '/api/requests', {
		body: submission(overrides),
		ip: opts.ip,
		headers: opts.token === null ? {} : { 'x-form-token': opts.token ?? issueFormToken() }
	});

const requestRow = (id: number) => db.select().from(taskRequests).where(eq(taskRequests.id, id)).get()!;
const mailTo = (address: string) => mail.sent.filter((m) => m.to === address);

describe('form tokens', () => {
	it('accepts a token it issued and refuses anything else', () => {
		const token = issueFormToken();
		expect(verifyFormToken(token)).toBe(true);

		const [expiry, nonce, signature] = token.split('.');
		expect(verifyFormToken(`${Number(expiry) + 60_000}.${nonce}.${signature}`)).toBe(false);
		expect(verifyFormToken(`${expiry}.${nonce}.${'0'.repeat(signature.length)}`)).toBe(false);
		expect(verifyFormToken('not-a-token')).toBe(false);
		expect(verifyFormToken('')).toBe(false);
		expect(verifyFormToken(null)).toBe(false);
	});

	it('refuses a token once it has expired', () => {
		const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
		expect(verifyFormToken(issueFormToken(threeHoursAgo))).toBe(false);
	});
});

describe('who a request can be sent to', () => {
	it('is not listed to an anonymous caller without a form token', async () => {
		const bare = await api('GET', '/api/requests/targets');
		const forged = await api('GET', '/api/requests/targets', { headers: { 'x-form-token': '1.2.3' } });

		expect(bare.status).toBe(401);
		expect(forged.status).toBe(401);
		expect(JSON.stringify([bare.body, forged.body])).not.toContain(staff.username);
	});

	it('is listed to someone who loaded the form, and to a signed-in user', async () => {
		const withToken = await api('GET', '/api/requests/targets', {
			headers: { 'x-form-token': issueFormToken() }
		});
		const signedIn = await api('GET', '/api/requests/targets', { user: other });

		for (const res of [withToken, signedIn]) {
			expect(res.status).toBe(200);
			expect(res.body.targets.map((t: { name: string }) => t.name)).toContain(staff.username);
		}
	});

	// Whoever accepts a request picks the board its card goes on, so a board
	// is not needed to send one (card 2128). Every board's name went to anyone
	// who loaded the form.
	it('lists the boards a signed-in user can open, and none to someone without an account', async () => {
		const withToken = await api('GET', '/api/requests/targets', {
			headers: { 'x-form-token': issueFormToken() }
		});
		const ofStaff = await api('GET', '/api/requests/targets', { user: staff });
		const ofOther = await api('GET', '/api/requests/targets', { user: other });

		expect(withToken.body.boards).toEqual([]);
		expect(ofStaff.body.boards.map((b: { name: string }) => b.name)).toEqual(['A']);
		// `other` cannot open board A.
		expect(ofOther.body.boards).toEqual([]);
	});

	it('is rate limited per address for anonymous callers', async () => {
		const headers = { 'x-form-token': issueFormToken() };
		for (let i = 0; i < 30; i++) {
			expect((await api('GET', '/api/requests/targets', { headers, ip: '10.0.0.9' })).status).toBe(200);
		}
		expect((await api('GET', '/api/requests/targets', { headers, ip: '10.0.0.9' })).status).toBe(429);
		// Somebody else is unaffected.
		expect((await api('GET', '/api/requests/targets', { headers, ip: '10.0.0.10' })).status).toBe(200);
	});
});

describe('submitting without an account', () => {
	it('is refused without a form token, creating nothing and emailing nobody', async () => {
		const res = await submitAnonymously({}, { token: null });

		expect(res.status).toBe(403);
		expect(db.select().from(taskRequests).all()).toHaveLength(0);
		expect(mail.sent).toHaveLength(0);
	});

	it('holds the request unverified and emails only the requester', async () => {
		const res = await submitAnonymously();

		expect(res.status).toBe(201);
		expect(res.body.verificationRequired).toBe(true);
		expect(res.body.status).toBe('unverified');
		// The token is the key to the thread. It travels in the email and nowhere else.
		expect(res.body).not.toHaveProperty('accessToken');

		const row = requestRow(res.body.id);
		expect(row.status).toBe('unverified');
		expect(row.accessToken).toMatch(/^[0-9a-f]{64}$/);

		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0].to).toBe(REQUESTER);
		expect(mail.sent[0].html).toContain(`/request/${row.id}/confirm?token=${row.accessToken}`);
		expect(mailTo(staff.email)).toHaveLength(0);
	});

	it('says in the confirmation mail that its link lasts seven days (card 2243)', async () => {
		const res = await submitAnonymously();

		expect(res.status).toBe(201);
		expect(mail.sent).toHaveLength(1);
		// The mail says it in words; the number it stands for is the one the routes keep to.
		expect(UNVERIFIED_LIFETIME_DAYS).toBe(7);
		expect(mail.sent[0].html).toContain(
			'This link lasts seven days: a request not confirmed by then is no longer kept, and can be made again.'
		);
	});

	it('keeps an unverified request out of the inbox', async () => {
		await submitAnonymously();

		const inbox = await api('GET', '/api/requests', { user: staff });

		expect(inbox.status).toBe(200);
		expect(inbox.body).toHaveLength(0);
	});

	it('needs a real email address', async () => {
		for (const requesterEmail of [undefined, '', 'not-an-address', 'a@b']) {
			const res = await submitAnonymously({ requesterEmail });
			expect(res.status).toBe(400);
		}
		expect(db.select().from(taskRequests).all()).toHaveLength(0);
	});

	it('limits how many requests one email address can raise', async () => {
		for (let i = 0; i < 3; i++) {
			expect((await submitAnonymously({}, { ip: `10.1.0.${i}` })).status).toBe(201);
		}
		// A fourth, from yet another address, is still the same inbox being filled.
		expect((await submitAnonymously({}, { ip: '10.1.0.99' })).status).toBe(429);
		expect(mailTo(REQUESTER)).toHaveLength(3);
	});

	it('limits how many requests one address can submit', async () => {
		for (let i = 0; i < 5; i++) {
			const res = await submitAnonymously({ requesterEmail: `person${i}@example.test` }, { ip: '10.2.0.1' });
			expect(res.status).toBe(201);
		}
		const sixth = await submitAnonymously({ requesterEmail: 'person6@example.test' }, { ip: '10.2.0.1' });
		expect(sixth.status).toBe(429);
	});

	it('clears away requests that were never confirmed', async () => {
		const stale = db
			.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: staff.id,
				title: 'Never confirmed',
				status: 'unverified',
				createdAt: '2020-01-01 00:00:00'
			})
			.returning()
			.get();

		await submitAnonymously();

		expect(db.select().from(taskRequests).where(eq(taskRequests.id, stale.id)).get()).toBeUndefined();
	});

	it('is accepted as pending when there is no email to confirm by', async () => {
		mail.configured = false;

		const res = await submitAnonymously();

		expect(res.status).toBe(201);
		expect(res.body.verificationRequired).toBe(false);
		expect(requestRow(res.body.id).status).toBe('pending');
	});
});

describe('confirming a request', () => {
	it('is refused with the wrong token and tells the team nothing', async () => {
		const { body } = await submitAnonymously();
		mail.sent.length = 0;

		const wrong = await api('POST', `/api/requests/${body.id}/confirm`, { body: { token: 'f'.repeat(64) } });
		const none = await api('POST', `/api/requests/${body.id}/confirm`, { body: {} });
		const noSuch = await api('POST', '/api/requests/99999/confirm', { body: { token: 'f'.repeat(64) } });

		// A request that exists and one that does not answer alike.
		expect([wrong.status, none.status, noSuch.status]).toEqual([404, 404, 404]);
		expect(requestRow(body.id).status).toBe('unverified');
		expect(mail.sent).toHaveLength(0);
	});

	it('passes the request to the team, once', async () => {
		const { body } = await submitAnonymously();
		const token = requestRow(body.id).accessToken;
		mail.sent.length = 0;

		const first = await api('POST', `/api/requests/${body.id}/confirm`, { body: { token } });
		const second = await api('POST', `/api/requests/${body.id}/confirm`, { body: { token } });

		expect(first.status).toBe(200);
		expect(first.body).toMatchObject({ confirmed: true, alreadyConfirmed: false });
		expect(second.body).toMatchObject({ confirmed: true, alreadyConfirmed: true });
		expect(requestRow(body.id).status).toBe('pending');
		// Following the link twice must not email the team twice.
		expect(mailTo(staff.email)).toHaveLength(1);

		const inbox = await api('GET', '/api/requests', { user: staff });
		expect(inbox.body).toHaveLength(1);
		expect(inbox.body[0]).not.toHaveProperty('accessToken');
	});

	// ─── A request nobody confirmed for seven days has lapsed (card 2243) ────
	//
	// The confirmation link confirmed a request however old it was, in the
	// window before the next anonymous request cleared the row: the team was
	// mailed and it entered the inbox. The link route already treated such a
	// request as not there (card 2158).

	const MINUTE_MS = 60 * 1000;
	const DAY_MS = 24 * 60 * MINUTE_MS;

	/** A request submitted without an account, made `ageMs` ago, and its token. */
	async function submittedAgo(ageMs: number) {
		const { body } = await submitAnonymously();
		db.update(taskRequests).set({ createdAt: stamp(new Date(Date.now() - ageMs)) }).where(eq(taskRequests.id, body.id)).run();
		mail.sent.length = 0;
		return { id: body.id as number, token: requestRow(body.id).accessToken! };
	}

	it('is refused for a request made more than seven days ago, as a link that is not valid, and tells the team nothing', async () => {
		const { id, token } = await submittedAgo(7 * DAY_MS + MINUTE_MS);

		const res = await api('POST', `/api/requests/${id}/confirm`, { body: { token } });

		expect({ status: res.status, body: res.body }).toEqual({ status: 404, body: { message: 'This confirmation link is not valid.' } });
		// Left for the form's clean-up, which is the one place requests are deleted.
		expect(requestRow(id).status).toBe('unverified');
		expect(mail.sent).toEqual([]);
		expect((await api('GET', '/api/requests', { user: staff })).body).toEqual([]);
	});

	it('passes a request made a minute inside the seven days to the team, once', async () => {
		const { id, token } = await submittedAgo(7 * DAY_MS - MINUTE_MS);

		const res = await api('POST', `/api/requests/${id}/confirm`, { body: { token } });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ confirmed: true, alreadyConfirmed: false });
		expect(requestRow(id).status).toBe('pending');
		expect(mailTo(staff.email)).toHaveLength(1);
	});

	it('still answers a request confirmed long ago as already confirmed: only an unconfirmed request lapses', async () => {
		const { id, token } = await submittedAgo(30 * DAY_MS);
		db.update(taskRequests).set({ status: 'pending' }).where(eq(taskRequests.id, id)).run();

		const res = await api('POST', `/api/requests/${id}/confirm`, { body: { token } });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ confirmed: true, alreadyConfirmed: true });
		expect(mail.sent).toEqual([]);
	});

	it('hasLapsed counts strictly older than seven days, in the stored form, for an unconfirmed request alone', () => {
		const now = Date.UTC(2026, 9, 19, 12, 0, 0);
		expect(unconfirmedCutoff(now)).toBe('2026-10-12 12:00:00');
		expect(hasLapsed({ status: 'unverified', createdAt: '2026-10-12 11:59:59' }, now)).toBe(true);
		expect(hasLapsed({ status: 'unverified', createdAt: '2026-10-12 12:00:00' }, now)).toBe(false);
		expect(hasLapsed({ status: 'pending', createdAt: '2020-01-01 00:00:00' }, now)).toBe(false);
		expect(hasLapsed({ status: 'rejected', createdAt: '2020-01-01 00:00:00' }, now)).toBe(false);
	});

	it("does not open a lapsed request's thread, so the page shows the link as gone and offers no Confirm it", async () => {
		// In this order: each submission clears the requests that have lapsed before it.
		const recent = await submittedAgo(6 * DAY_MS);
		const lapsed = await submittedAgo(7 * DAY_MS + MINUTE_MS);
		expect(requestRow(lapsed.id).status).toBe('unverified');
		const NOT_FOUND = { status: 404, body: { message: 'Request not found' } };
		const opened = async ({ id, token }: { id: number; token: string }) =>
			[
				await api('GET', `/api/requests/${id}?token=${token}`),
				await api('GET', `/api/requests/${id}/messages?token=${token}`),
				await api('POST', `/api/requests/${id}/messages`, { body: { message: 'Hello?', senderType: 'requester', token } })
			].map(({ status, body }) => ({ status, body }));

		// The same answers as for a request that is not there, on every route the link opens.
		expect(await opened(lapsed)).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
		// Within the seven days the thread opens, waiting for confirmation, and a reply is refused as before.
		const [read, thread, reply] = await opened(recent);
		expect(read.status).toBe(200);
		expect(read.body.status).toBe('unverified');
		expect(thread.status).toBe(200);
		expect(reply).toEqual({ status: 400, body: { message: 'Request is already resolved' } });
		expect(db.select().from(requestMessages).all()).toHaveLength(0);
		expect(mail.sent).toEqual([]);
	});
});

/**
 * Card 2260. A request made without an account waits for its requester to
 * confirm it, and until then it is not the team's. The inbox never listed one,
 * but the person it was addressed to, a member of the team it was addressed to
 * and every administrator could read it by its id, with the requester's
 * address, before the requester had stood behind it. Every caller without its
 * link is now answered as for a request that is not there, on every route.
 */
describe("a request nobody has confirmed is not the team's to read (card 2260)", () => {
	const NOT_FOUND = { status: 404, body: { message: 'Request not found' } };
	const MINUTE_MS = 60 * 1000;
	const DAY_MS = 24 * 60 * MINUTE_MS;
	let admin: SessionUser;

	beforeEach(() => {
		admin = makeUser({ role: 'admin', username: 'admin' });
	});

	/** A request made without an account, addressed to `staff`, not confirmed, made `ageMs` ago, and its link. */
	async function unconfirmed(ageMs = 0) {
		const { body } = await submitAnonymously();
		if (ageMs > 0) {
			db.update(taskRequests).set({ createdAt: stamp(new Date(Date.now() - ageMs)) }).where(eq(taskRequests.id, body.id)).run();
		}
		mail.sent.length = 0;
		expect(requestRow(body.id).status).toBe('unverified');
		return { id: body.id as number, token: requestRow(body.id).accessToken! };
	}

	/** What `user` is answered for the request and its thread. */
	const reads = async (id: number, user: SessionUser) =>
		[await api('GET', `/api/requests/${id}`, { user }), await api('GET', `/api/requests/${id}/messages`, { user })].map(
			({ status, body }) => ({ status, body })
		);

	it('answers the request and its thread 404 to the person it is addressed to and to an administrator', async () => {
		const { id } = await unconfirmed();

		expect(await reads(id, staff)).toEqual([NOT_FOUND, NOT_FOUND]);
		expect(await reads(id, admin)).toEqual([NOT_FOUND, NOT_FOUND]);
	});

	it('answers an accept, a reject and a reply from the team 404, writing nothing and mailing nobody', async () => {
		const { id } = await unconfirmed();
		const before = snapshotDb();

		for (const user of [staff, admin]) {
			const accept = await api('PATCH', `/api/requests/${id}`, {
				user,
				body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
			});
			const reject = await api('PATCH', `/api/requests/${id}`, { user, body: { action: 'reject', rejectReason: 'No' } });
			const reply = await api('POST', `/api/requests/${id}/messages`, { user, body: { message: 'On it' } });
			expect([accept, reject, reply].map(({ status, body }) => ({ status, body }))).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND]);
		}

		expectUnchanged(before);
		expect(mail.sent).toEqual([]);
	});

	it('answers someone signed in it is not addressed to 404 too, where it was 403', async () => {
		const { id } = await unconfirmed();

		expect(await reads(id, other)).toEqual([NOT_FOUND, NOT_FOUND]);
		const accept = await api('PATCH', `/api/requests/${id}`, { user: other, body: { action: 'reject' } });
		const reply = await api('POST', `/api/requests/${id}/messages`, { user: other, body: { message: 'Hello' } });
		expect([accept, reply].map(({ status, body }) => ({ status, body }))).toEqual([NOT_FOUND, NOT_FOUND]);
	});

	it('answers a lapsed one 404 to the person it is addressed to, and to a signed-in caller holding its link', async () => {
		const { id, token } = await unconfirmed(7 * DAY_MS + MINUTE_MS);

		expect(await reads(id, staff)).toEqual([NOT_FOUND, NOT_FOUND]);
		const withLink = await api('GET', `/api/requests/${id}?token=${token}`, { user: other });
		expect({ status: withLink.status, body: withLink.body }).toEqual(NOT_FOUND);
	});

	it("still opens by the requester's own link, with no session and signed in, without the address", async () => {
		const { id, token } = await unconfirmed();

		for (const user of [undefined, staff]) {
			const read = await api('GET', `/api/requests/${id}?token=${token}`, { user });
			const thread = await api('GET', `/api/requests/${id}/messages?token=${token}`, { user });
			expect(read.status).toBe(200);
			expect(read.body.status).toBe('unverified');
			expect(read.body.requesterEmail).toBeNull();
			expect(thread.status).toBe(200);
			expect(thread.body).toEqual([]);
		}
	});

	it("is the team's once confirmed: read with the address, and accepted", async () => {
		const { id, token } = await unconfirmed();
		expect((await api('POST', `/api/requests/${id}/confirm`, { body: { token } })).status).toBe(200);

		const read = await api('GET', `/api/requests/${id}`, { user: staff });
		expect(read.status).toBe(200);
		expect(read.body.requesterEmail).toBe(REQUESTER);
		const accept = await api('PATCH', `/api/requests/${id}`, {
			user: staff,
			body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
		});
		expect(accept.status).toBe(200);
		expect(requestRow(id).status).toBe('accepted');
	});

	it('leaves a pending request as it was: read by the person it is addressed to, 403 to someone else', async () => {
		const res = await api('POST', '/api/requests', { user: other, body: submission({ desiredBoardId: null }) });
		expect(requestRow(res.body.id).status).toBe('pending');

		expect((await api('GET', `/api/requests/${res.body.id}`, { user: staff })).status).toBe(200);
		expect((await api('GET', `/api/requests/${res.body.id}`, { user: admin })).status).toBe(200);
		const outsider = makeUser({ username: 'outsider' });
		expect((await api('GET', `/api/requests/${res.body.id}`, { user: outsider })).status).toBe(403);
	});

	it('canHandleRequest and canReadRequest are false for an unconfirmed request, an administrator included', async () => {
		const { id } = await unconfirmed();
		const row = requestRow(id);

		for (const user of [staff, admin]) {
			expect(canHandleRequest(user, row)).toBe(false);
			expect(canReadRequest(user, row)).toBe(false);
		}
		// The author rule cannot let one in either: an unconfirmed request made signed in is not one there is, but the rule refuses it itself.
		expect(canReadRequest(staff, { ...row, requesterUserId: staff.id, targetId: other.id })).toBe(false);
		// Confirmed, the same rules let them in.
		const pending = { ...row, status: 'pending' };
		expect([canHandleRequest(staff, pending), canReadRequest(admin, pending)]).toEqual([true, true]);
	});
});

describe('submitting while signed in', () => {
	it('goes straight to the team with no confirmation step and no form token', async () => {
		// `other` cannot open board A, and names no board: the board is optional.
		const res = await api('POST', '/api/requests', { user: other, body: submission({ desiredBoardId: null }) });

		expect(res.status).toBe(201);
		expect(res.body.verificationRequired).toBe(false);
		expect(res.body).not.toHaveProperty('accessToken');
		expect(requestRow(res.body.id).status).toBe('pending');
		expect(mailTo(staff.email)).toHaveLength(1);
		expect(mailTo(other.email)).toHaveLength(0);
	});
});

describe('the board a request names (card 2128)', () => {
	const stored = (id: number) => requestRow(id).desiredBoardId;

	it('is not read from someone without an account: none is stored, and none is looked up', async () => {
		// From four people: one address may send three an hour.
		const from = (n: number, desiredBoardId: unknown) =>
			submitAnonymously({ desiredBoardId, requesterEmail: `pat${n}@example.test` }, { ip: `10.0.1.${n}` });
		const named = await from(1, A.board.id);
		const none = await from(2, undefined);
		// A board that is not there was 404, so the form told which ids are boards.
		const missing = await from(3, 99999);
		const notAnId = await from(4, 'board A');

		for (const res of [named, none, missing, notAnId]) {
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			expect(stored(res.body.id)).toBeNull();
		}
	});

	it('is optional from a signed-in user, and is one they can open', async () => {
		const none = await api('POST', '/api/requests', { user: other, body: submission({ desiredBoardId: undefined }) });
		expect(none.status).toBe(201);
		expect(stored(none.body.id)).toBeNull();

		const theirs = await api('POST', '/api/requests', { user: staff, body: submission() });
		expect(theirs.status).toBe(201);
		expect(stored(theirs.body.id)).toBe(A.board.id);

		mail.sent.length = 0;
		const before = snapshotDb();
		const notTheirs = await api('POST', '/api/requests', { user: other, body: submission() });
		const missing = await api('POST', '/api/requests', { user: other, body: submission({ desiredBoardId: 99999 }) });
		expect([notTheirs.status, notTheirs.body]).toEqual([403, { message: 'No access to this board' }]);
		expect([missing.status, missing.body]).toEqual([404, { message: 'Board not found' }]);
		expectUnchanged(before);
		expect(mail.sent).toHaveLength(0);
	});
});

describe("a requester's thread", () => {
	/** A confirmed request from someone without an account, and its token. */
	async function confirmedRequest() {
		const { body } = await submitAnonymously();
		const token = requestRow(body.id).accessToken!;
		await api('POST', `/api/requests/${body.id}/confirm`, { body: { token } });
		mail.sent.length = 0;
		return { id: body.id as number, token };
	}

	it("is not opened by the requester's email address", async () => {
		const { id } = await confirmedRequest();
		const byEmail = `email=${encodeURIComponent(REQUESTER)}`;

		const request = await api('GET', `/api/requests/${id}?${byEmail}`);
		const thread = await api('GET', `/api/requests/${id}/messages?${byEmail}`);
		const reply = await api('POST', `/api/requests/${id}/messages`, {
			body: { message: 'Posting as Pat', senderType: 'requester', email: REQUESTER }
		});

		// 404, as for a request that is not there (card 2132): it was 403.
		expect([request.status, thread.status, reply.status]).toEqual([404, 404, 404]);
		expect(db.select().from(requestMessages).all()).toHaveLength(0);
	});

	it('is not opened by a guessed or missing token', async () => {
		const { id } = await confirmedRequest();

		expect((await api('GET', `/api/requests/${id}`)).status).toBe(404);
		expect((await api('GET', `/api/requests/${id}?token=${'a'.repeat(64)}`)).status).toBe(404);
		expect((await api('GET', `/api/requests/${id}/messages?token=`)).status).toBe(404);
	});

	it('is opened by its own token, for reading and replying', async () => {
		const { id, token } = await confirmedRequest();

		const request = await api('GET', `/api/requests/${id}?token=${token}`);
		const reply = await api('POST', `/api/requests/${id}/messages`, {
			body: { message: 'Any news?', senderType: 'requester', token }
		});
		const thread = await api('GET', `/api/requests/${id}/messages?token=${token}`);

		expect(request.status).toBe(200);
		expect(request.body.title).toBe('Please add an export');
		expect(request.body).not.toHaveProperty('accessToken');
		expect(reply.status).toBe(200);
		expect(thread.body.map((m: { message: string }) => m.message)).toEqual(['Any news?']);
	});

	it("does not open another request with one request's token", async () => {
		const first = await confirmedRequest();
		const second = await confirmedRequest();

		expect((await api('GET', `/api/requests/${second.id}?token=${first.token}`)).status).toBe(404);
	});

	it('puts the token, not the address, in the link emailed to the requester', async () => {
		const { id, token } = await confirmedRequest();

		const res = await api('POST', `/api/requests/${id}/messages`, {
			user: staff,
			body: { message: 'Looking at it now' }
		});

		expect(res.status).toBe(200);
		const [email] = mailTo(REQUESTER);
		expect(email.html).toContain(`/request/${id}/reply?token=${token}`);
		expect(email.html).not.toContain('email=');
	});

	/**
	 * Card 2156. Each reply as the requester mails every member the request is
	 * addressed to, and 40 replies made 40 mails to each: whoever held the link
	 * could fill the team's inboxes from the server's own sender. Twenty an
	 * hour, for one request, and a reply from the team starts the count again.
	 */
	describe('twenty replies an hour from the requester', () => {
		const LIMIT_MESSAGE = /^Too many replies to this request in the last hour\. Try again in \d+ minute\(s\)\.$/;

		const reply = (id: number, token: string, message: string) =>
			api('POST', `/api/requests/${id}/messages`, { body: { message, senderType: 'requester', token } });
		const fromTheTeam = (id: number, message: string) =>
			api('POST', `/api/requests/${id}/messages`, { user: staff, body: { message } });
		const saved = (id: number) =>
			db.select().from(requestMessages).where(eq(requestMessages.requestId, id)).all().map((m) => m.message);

		/** Twenty replies from the requester, "Reply 1" to "Reply 20", each answered 200. */
		async function twentyReplies(id: number, token: string) {
			for (let n = 1; n <= 20; n++) {
				expect((await reply(id, token, `Reply ${n}`)).status).toBe(200);
			}
		}

		it('saves and mails twenty, and refuses the 21st with nothing saved and nothing mailed', async () => {
			const { id, token } = await confirmedRequest();

			await twentyReplies(id, token);
			expect(saved(id)).toHaveLength(20);
			expect(mailTo(staff.email)).toHaveLength(20);

			const refused = await reply(id, token, 'Reply 21');

			expect(refused.status).toBe(429);
			expect(refused.body.message).toBe('Too many replies to this request in the last hour. Try again in 60 minute(s).');
			expect(saved(id)).toHaveLength(20);
			expect(saved(id)).not.toContain('Reply 21');
			expect(mailTo(staff.email)).toHaveLength(20);
		});

		it('counts nothing for a wrong link, an empty message or one too long', async () => {
			const { id, token } = await confirmedRequest();

			for (let n = 0; n < 10; n++) {
				expect((await reply(id, 'f'.repeat(64), 'Not mine')).status).toBe(404);
				expect((await reply(id, token, '   ')).status).toBe(400);
				expect((await reply(id, token, 'x'.repeat(5001))).status).toBe(400);
			}
			// Thirty refused, and still the whole twenty: had one been counted,
			// the twentieth would be refused.
			await twentyReplies(id, token);

			expect(saved(id)).toHaveLength(20);
			expect((await reply(id, token, 'Reply 21')).status).toBe(429);
		});

		it('starts the count again when the team replies, and does not count the team', async () => {
			const { id, token } = await confirmedRequest();

			await twentyReplies(id, token);
			for (let n = 1; n <= 3; n++) {
				expect((await fromTheTeam(id, `Answer ${n}`)).status).toBe(200);
			}
			// The requester's 21st, after an answer: saved and mailed.
			expect((await reply(id, token, 'Reply 21')).status).toBe(200);

			expect(saved(id)).toContain('Answer 3');
			expect(saved(id)).toContain('Reply 21');
			expect(mailTo(staff.email)).toHaveLength(21);
			expect(mailTo(REQUESTER)).toHaveLength(3);

			// Twenty again from the answer on, Reply 21 the first of them, then the limit.
			for (let n = 22; n <= 40; n++) {
				expect((await reply(id, token, `Reply ${n}`)).status).toBe(200);
			}
			const refused = await reply(id, token, 'Reply 41');
			expect(refused.status).toBe(429);
			expect(refused.body.message).toMatch(LIMIT_MESSAGE);
			expect(saved(id)).toHaveLength(43);
		});

		it('counts each request apart', async () => {
			const first = await confirmedRequest();
			const second = await confirmedRequest();

			await twentyReplies(first.id, first.token);

			expect((await reply(second.id, second.token, 'On the other one')).status).toBe(200);
			expect((await reply(first.id, first.token, 'Reply 21')).status).toBe(429);
			expect(saved(second.id)).toEqual(['On the other one']);
		});

		it('lets the requester reply again an hour after the first reply', async () => {
			vi.useFakeTimers({ toFake: ['Date'] });
			try {
				const start = new Date('2026-10-14T10:00:00.000Z').getTime();
				vi.setSystemTime(start);
				const { id, token } = await confirmedRequest();

				await twentyReplies(id, token);
				vi.setSystemTime(start + 59 * 60 * 1000);
				const refused = await reply(id, token, 'Reply 21');
				expect(refused.status).toBe(429);
				expect(refused.body.message).toBe('Too many replies to this request in the last hour. Try again in 1 minute(s).');

				vi.setSystemTime(start + 60 * 60 * 1000 + 1);
				expect((await reply(id, token, 'Reply 22')).status).toBe(200);
				expect(saved(id)).toContain('Reply 22');
				expect(saved(id)).not.toContain('Reply 21');
			} finally {
				vi.useRealTimers();
			}
		});

		it('writes one WARN line, at the first refusal in the hour, naming the request and not the message', async () => {
			const { id, token } = await confirmedRequest();
			const level = process.env.LOG_LEVEL;
			process.env.LOG_LEVEL = 'WARN';
			try {
				await twentyReplies(id, token);
				for (let n = 21; n <= 24; n++) {
					expect((await reply(id, token, `Secret reply ${n}`)).status).toBe(429);
				}
			} finally {
				if (level === undefined) delete process.env.LOG_LEVEL;
				else process.env.LOG_LEVEL = level;
			}

			const lines = sqlite
				.prepare("SELECT level, context, message, meta FROM system_logs WHERE context = 'REQUESTS'")
				.all() as { level: string; context: string; message: string; meta: string }[];
			expect(lines).toHaveLength(1);
			expect(lines[0].level).toBe('WARN');
			expect(lines[0].message).toContain(`Request ${id} reached its limit of 20 replies`);
			expect(JSON.stringify(lines)).not.toContain('Secret reply');
			expect(JSON.stringify(lines)).not.toContain(token);
		});
	});
});

/**
 * Card 2132. Request ids are consecutive, and a caller with no session was
 * answered 403 for a request that is there and 404 for one that is not, and
 * on a reply 400 for one resolved or unconfirmed: anyone on the internet could
 * count the requests and see when each was dealt with. Without a session and
 * without the link, every request is one that is not there.
 */
describe('a request that cannot be opened', () => {
	const NOT_FOUND = { status: 404, body: { message: 'Request not found' } };
	const NO_SUCH_REQUEST = 99999;
	const linkOf = (n: number) => String(n).repeat(64).slice(0, 64);

	/** One request in each state, each with a link of its own. */
	function requests() {
		const asked = (status: string, n: number) =>
			db
				.insert(taskRequests)
				.values({
					targetType: 'user',
					targetId: staff.id,
					requesterName: 'Pat',
					requesterEmail: REQUESTER,
					title: `A ${status} request`,
					status,
					accessToken: linkOf(n)
				})
				.returning()
				.get();
		return [asked('pending', 1), asked('accepted', 2), asked('rejected', 3), asked('unverified', 4)];
	}

	/** What a caller with no session is answered on the three routes the link opens, holding `token`. */
	async function answers(id: number, token: string | undefined) {
		const query = token === undefined ? '' : `?token=${token}`;
		const asked = [
			await api('GET', `/api/requests/${id}${query}`),
			await api('GET', `/api/requests/${id}/messages${query}`),
			await api('POST', `/api/requests/${id}/messages`, {
				body: { message: 'Is anyone there?', senderType: 'requester', ...(token === undefined ? {} : { token }) }
			})
		];
		return asked.map(({ status, body }) => ({ status, body }));
	}

	it('answers alike, 404, whatever the state, and as for one that is not there, with nothing saved or mailed', async () => {
		const made = requests();
		const before = snapshotDb();

		for (const id of [...made.map((r) => r.id), NO_SUCH_REQUEST]) {
			// No link, a guessed one, and another request's.
			for (const token of [undefined, 'f'.repeat(64), linkOf(id === made[0].id ? 2 : 1)]) {
				expect({ id, token, answers: await answers(id, token) }).toEqual({ id, token, answers: [NOT_FOUND, NOT_FOUND, NOT_FOUND] });
			}
		}

		expectUnchanged(before);
		expect(mail.sent).toEqual([]);
	});

	it('answers a reply from the team with no session 401, before the request is looked for', async () => {
		const made = requests();
		const before = snapshotDb();

		for (const id of [...made.map((r) => r.id), NO_SUCH_REQUEST]) {
			const res = await api('POST', `/api/requests/${id}/messages`, { body: { message: 'On it' } });
			expect({ id, status: res.status, body: res.body }).toEqual({ id, status: 401, body: { message: 'Not authenticated' } });
		}

		expectUnchanged(before);
		expect(mail.sent).toEqual([]);
	});

	it('tells the holder of the link the state: a request that is not waiting is read, and a reply to it is 400', async () => {
		const [, accepted, rejected, unverified] = requests();

		for (const [request, n] of [[accepted, 2], [rejected, 3], [unverified, 4]] as const) {
			const read = await api('GET', `/api/requests/${request.id}?token=${linkOf(n)}`);
			const thread = await api('GET', `/api/requests/${request.id}/messages?token=${linkOf(n)}`);
			const reply = await api('POST', `/api/requests/${request.id}/messages`, {
				body: { message: 'Is anyone there?', senderType: 'requester', token: linkOf(n) }
			});

			expect(read.status).toBe(200);
			expect(read.body.status).toBe(request.status);
			expect(thread.status).toBe(200);
			expect({ status: reply.status, body: reply.body }).toEqual({ status: 400, body: { message: 'Request is already resolved' } });
		}
		expect(db.select().from(requestMessages).all()).toHaveLength(0);
		expect(mail.sent).toEqual([]);
	});

	it('still answers a signed-in caller as every guard does: 403 for one not theirs, 404 for one not there', async () => {
		const [pending] = requests();

		expect((await api('GET', `/api/requests/${pending.id}`, { user: other })).status).toBe(403);
		expect((await api('GET', `/api/requests/${pending.id}/messages`, { user: other })).status).toBe(403);
		expect((await api('GET', `/api/requests/${NO_SUCH_REQUEST}`, { user: other })).status).toBe(404);
		const asRequester = { message: 'x', senderType: 'requester', token: 'f'.repeat(64) };
		expect((await api('POST', `/api/requests/${pending.id}/messages`, { user: other, body: asRequester })).status).toBe(403);
		expect((await api('POST', `/api/requests/${NO_SUCH_REQUEST}/messages`, { user: other, body: asRequester })).status).toBe(404);
	});
});

// ─── Asking for a new link (card 2158) ───────────────────────────────────────

describe('asking for a new link', () => {
	/** The one answer to every ask that is read, word for word. */
	const ANSWERED = {
		status: 202,
		body: { message: 'If that is the address the request was made with, a new link has been sent to it.' }
	};
	const linkOf = (n: number) => String(n).repeat(64).slice(0, 64);

	/** A request made with `email` (Pat's address unless given), in `status`, with a link of its own. */
	const made = (status: string, n: number, email: string | null = REQUESTER) =>
		db
			.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: staff.id,
				requesterName: 'Pat',
				requesterEmail: email,
				title: `A ${status} request`,
				status,
				accessToken: linkOf(n)
			})
			.returning()
			.get();

	/** The work a match leads to is done after the answer (S3): one turn of the event loop. */
	const afterTheAnswer = () => new Promise((done) => setImmediate(done));
	/** Ask, and wait for what the ask leads to after its answer. */
	const ask = async (id: number | string, body: unknown, ip?: string) => {
		const res = await api('POST', `/api/requests/${id}/link`, { body, ip });
		await afterTheAnswer();
		return res;
	};
	/** What a requester is told when no link can be sent (O7). */
	const CANNOT_SEND = {
		status: 503,
		body: { message: 'New links cannot be sent just now. Please contact the team that sent you the link.' }
	};
	const answerOf = ({ status, body }: { status: number; body: unknown }) => ({ status, body });
	/** Every address in a mail's links. */
	const linksIn = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

	it('mails the current link to the address on the request, for the right address in another case with spaces', async () => {
		const requests = [made('pending', 1), made('accepted', 2), made('rejected', 3), made('unverified', 4)];
		const before = snapshotDb();

		for (const [i, request] of requests.entries()) {
			mail.sent.length = 0;
			// Four mails to one address: past the three an hour, tested below.
			resetAllRateLimits();
			const res = await ask(request.id, { email: '  PAT@Example.TEST ' }, `10.0.2.${i}`);

			expect(answerOf(res)).toEqual(ANSWERED);
			expect(mail.sent.map((m) => m.to)).toEqual([REQUESTER]);
			const [link] = linksIn(mail.sent[0].html);
			// The confirmation link for one not yet confirmed, the thread's otherwise, with the token it holds now.
			const page = request.status === 'unverified' ? 'confirm' : 'reply';
			expect(link).toMatch(new RegExp(`/request/${request.id}/${page}\\?token=${linkOf(i + 1)}$`));
			expect(mail.sent[0].subject).toBe(`A new link to your request: ${request.title}`);
			expect(mail.sent[0].html).toContain(request.status === 'unverified' ? 'Confirm my request' : 'View the conversation');
		}
		// Nothing is written.
		expectUnchanged(before);
	});

	it('answers a wrong address, a request that is not there and an id that is not a number word for word alike, and mails nothing', async () => {
		const request = made('pending', 1);
		const noAddress = made('pending', 2, null);
		const before = snapshotDb();

		const answers = [
			await ask(request.id, { email: 'someone.else@example.test' }, '10.0.3.1'),
			await ask(request.id, { email: '' }, '10.0.3.2'),
			await ask(99999, { email: REQUESTER }, '10.0.3.3'),
			await ask('not-a-number', { email: REQUESTER }, '10.0.3.4'),
			await ask('1.5', { email: REQUESTER }, '10.0.3.5'),
			await ask(noAddress.id, { email: REQUESTER }, '10.0.3.6')
		].map(answerOf);

		expect(answers).toEqual(answers.map(() => ANSWERED));
		expect(mail.sent).toEqual([]);
		expectUnchanged(before);
	});

	it('refuses a body with no email text, 400, and mails nothing', async () => {
		const request = made('pending', 1);

		for (const [i, body] of [{}, { email: 42 }, { email: null }, { email: [REQUESTER] }].entries()) {
			const res = await ask(request.id, body, `10.0.4.${i}`);
			expect({ body, status: res.status, message: res.body.message }).toEqual({
				body,
				status: 400,
				message: 'Enter the email address you made the request with'
			});
		}
		expect(mail.sent).toEqual([]);
	});

	it('answers 503 in plain words when mail is not set up, has a user and no password, or there is no address to make a link from, before anything is looked up', async () => {
		const request = made('pending', 1);
		// Mail settings are read now, and the log written: no request is looked up.
		const read = vi.spyOn(sqlite, 'prepare');
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});

		mail.configured = false;
		const noMail = await ask(request.id, { email: REQUESTER }, '10.0.5.1');
		mail.configured = true;
		// A mail user and no password, as a restore leaves them (card 2169): every mail would fail (O6).
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('smtp_user', 'dumpfire')").run();
		const noPassword = await ask(request.id, { email: REQUESTER }, '10.0.5.2');
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('smtp_pass', 'entered-again')").run();
		mail.noAddress = true;
		const noLinkAddress = await ask(request.id, { email: REQUESTER }, '10.0.5.3');
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;

		// The same plain words to a requester each time; why is the superadmin's, in the log alone (O7).
		expect([noMail, noPassword, noLinkAddress].map(answerOf)).toEqual([CANNOT_SEND, CANNOT_SEND, CANNOT_SEND]);
		const why = sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'REQUESTS' ORDER BY id").all() as {
			level: string;
			message: string;
		}[];
		expect(why.map((line) => line.level)).toEqual(['WARN', 'WARN', 'WARN']);
		expect(why[0].message).toBe('A new link to a request was asked for, and none can be sent: mail is not set up on this server (Admin, 📧 Email / SMTP).');
		expect(why[1].message).toContain('the mail settings name a user and hold no password');
		expect(why[2].message).toMatch(/none can be sent: This server has no address configured to make the link from/);
		expect(read.mock.calls.filter(([sql]) => /task_requests/.test(String(sql)))).toEqual([]);
		expect(mail.sent).toEqual([]);
		read.mockRestore();
	});

	it('does all a match leads to after the answer, so the answer is the same work either way (S3)', async () => {
		const request = made('pending', 1);

		const right = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER }, ip: '10.0.5.9' });

		expect(answerOf(right)).toEqual(ANSWERED);
		// Answered, and nothing counted, made or sent yet.
		expect(mail.sent).toEqual([]);
		await afterTheAnswer();
		expect(mail.sent.map((m) => m.to)).toEqual([REQUESTER]);
	});

	it('counts a new link to a request not yet confirmed among the form’s three confirmation mails an hour to the address (S2)', async () => {
		const unconfirmed = made('unverified', 1);
		const pending = made('pending', 2);
		// Three requests made on the form with the address: its three confirmation mails this hour.
		for (let i = 0; i < 3; i++) expect((await submitAnonymously({}, { ip: `10.0.12.${i}` })).status).toBe(201);
		mail.sent.length = 0;

		expect(answerOf(await ask(unconfirmed.id, { email: REQUESTER }, '10.0.12.10'))).toEqual(ANSWERED);
		expect(mail.sent).toEqual([]);
		// A request already confirmed is not a confirmation mail: its link is sent.
		expect(answerOf(await ask(pending.id, { email: REQUESTER }, '10.0.12.11'))).toEqual(ANSWERED);
		expect(mailTo(REQUESTER)).toHaveLength(1);

		// And the other way: new links to a request not yet confirmed use up the form's three.
		resetAllRateLimits();
		for (let i = 0; i < 3; i++) await ask(unconfirmed.id, { email: REQUESTER }, `10.0.12.${20 + i}`);
		expect((await submitAnonymously({}, { ip: '10.0.12.30' })).status).toBe(429);
	});

	it('sends at most 30 new-link mails an hour in all, whatever the addresses, and answers the rest the same (S2)', async () => {
		// Each with an address and a link of its own.
		const requests = Array.from({ length: 31 }, (_, i) => {
			const request = made('pending', 1, `requester${i}@example.test`);
			db.update(taskRequests).set({ accessToken: `${i}`.padStart(64, 'e') }).where(eq(taskRequests.id, request.id)).run();
			return request;
		});

		const answers = [];
		for (const [i, request] of requests.entries()) {
			answers.push(answerOf(await ask(request.id, { email: `requester${i}@example.test` }, `10.0.13.${i}`)));
		}

		expect(answers).toEqual(requests.map(() => ANSWERED));
		expect(mail.sent).toHaveLength(30);
		expect(mailTo('requester30@example.test')).toEqual([]);
	});

	it('refuses the sixth ask in 15 minutes from one address, 429, whatever was asked', async () => {
		const request = made('pending', 1);

		const answers: number[] = [];
		for (let i = 0; i < 6; i++) answers.push((await ask(request.id, { email: `wrong${i}@example.test` }, '10.0.6.1')).status);

		expect(answers).toEqual([202, 202, 202, 202, 202, 429]);
		// Another address is not held up by it.
		expect((await ask(request.id, { email: REQUESTER }, '10.0.6.2')).status).toBe(202);
		expect(mailTo(REQUESTER)).toHaveLength(1);
	});

	it('mails one address at most three times an hour, across its requests, and answers the fourth the same with nothing sent', async () => {
		// R3: a limit per request would let whoever made many requests with
		// somebody else's address have the server mail that person three times
		// an hour for each.
		const first = made('pending', 1);
		const second = made('unverified', 2);

		const answers = [];
		for (const [i, request] of [first, second, first, second].entries()) {
			answers.push(answerOf(await ask(request.id, { email: REQUESTER }, `10.0.7.${i}`)));
		}

		expect(answers).toEqual([ANSWERED, ANSWERED, ANSWERED, ANSWERED]);
		expect(mailTo(REQUESTER)).toHaveLength(3);
	});

	it('counts only the mails sent: wrong addresses use up none of the requester’s three', async () => {
		const request = made('pending', 1);

		for (let i = 0; i < 3; i++) await ask(request.id, { email: 'someone.else@example.test' }, `10.0.8.${i}`);
		for (let i = 0; i < 3; i++) await ask(request.id, { email: REQUESTER }, `10.0.8.${10 + i}`);

		expect(mailTo(REQUESTER)).toHaveLength(3);
		expect(mail.sent).toHaveLength(3);
	});

	it('treats an unconfirmed request older than seven days as not there: the same answer, nothing sent', async () => {
		const daysAgo = (days: number) => stamp(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
		const madeAt = (status: string, n: number, days: number) => {
			const request = made(status, n);
			db.update(taskRequests).set({ createdAt: daysAgo(days) }).where(eq(taskRequests.id, request.id)).run();
			return request;
		};
		const old = madeAt('unverified', 1, 8);
		const recent = madeAt('unverified', 2, 6);
		const settledOld = madeAt('rejected', 3, 30);

		expect(answerOf(await ask(old.id, { email: REQUESTER }, '10.0.9.1'))).toEqual(ANSWERED);
		expect(mail.sent).toEqual([]);
		// Six days is within the form's seven, and the age is the rule for an
		// unconfirmed request alone: a settled one keeps its link for good.
		expect(answerOf(await ask(recent.id, { email: REQUESTER }, '10.0.9.2'))).toEqual(ANSWERED);
		expect(answerOf(await ask(settledOld.id, { email: REQUESTER }, '10.0.9.3'))).toEqual(ANSWERED);
		expect(mailTo(REQUESTER)).toHaveLength(2);
	});

	// A request made signed in is mailed at the account's email as it is now
	// (card 2171), and so is its new link: whoever holds the mailbox of the
	// address the account had when it made the request is mailed nothing.
	describe('for a request made signed in', () => {
		const MADE_WITH = 'other@example.test';
		const NOW = 'other.now@example.test';

		/** A request `other` made signed in, stored with the address the account had then. */
		const madeSignedIn = () => {
			const request = made('pending', 1, MADE_WITH);
			db.update(taskRequests).set({ requesterUserId: other.id }).where(eq(taskRequests.id, request.id)).run();
			// The account's email changed since, as PUT /api/users/:id changes it.
			db.update(users).set({ email: NOW }).where(eq(users.id, other.id)).run();
			return request;
		};

		it("mails the account's email as it is now, and answers the address it was made with alike with nothing sent", async () => {
			const request = madeSignedIn();
			const before = snapshotDb();

			const old = await ask(request.id, { email: MADE_WITH }, '10.0.10.1');
			expect(answerOf(old)).toEqual(ANSWERED);
			expect(mail.sent).toEqual([]);

			const now = await ask(request.id, { email: '  OTHER.Now@Example.TEST ' }, '10.0.10.2');
			expect(answerOf(now)).toEqual(ANSWERED);
			expect(mail.sent.map((m) => m.to)).toEqual([NOW]);
			expect(linksIn(mail.sent[0].html)[0]).toMatch(new RegExp(`/request/${request.id}/reply\\?token=${linkOf(1)}$`));
			expectUnchanged(before);
		});

		it("counts its three mails an hour against the account's email now: asks with the old address use none of them", async () => {
			const request = madeSignedIn();

			for (let i = 0; i < 3; i++) await ask(request.id, { email: MADE_WITH }, `10.0.11.${i}`);
			const answers = [];
			for (let i = 0; i < 4; i++) answers.push(answerOf(await ask(request.id, { email: NOW }, `10.0.11.${10 + i}`)));

			expect(answers).toEqual([ANSWERED, ANSWERED, ANSWERED, ANSWERED]);
			expect(mailTo(NOW)).toHaveLength(3);
			expect(mail.sent).toHaveLength(3);
		});
	});
});
