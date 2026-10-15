/**
 * The public request form — the one part of DumpFire reachable without an account.
 *
 * Four things used to be true and must not be:
 *   - one unauthenticated call listed every user, team and board;
 *   - every submission emailed the team, so the form was an open relay to them;
 *   - a requester's email address opened their request thread;
 *   - a requester's replies were not limited, and each one mailed the team.
 *
 * No email is sent by these tests. `sendEmail` is replaced with a recorder, and
 * "is SMTP configured" is a switch the test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mail = vi.hoisted(() => ({
	configured: true,
	sent: [] as { to: string; subject: string; html: string }[]
}));

vi.mock('$lib/server/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/email')>();
	return {
		...actual,
		isSmtpConfigured: () => mail.configured,
		sendEmail: async (to: string, subject: string, html: string) => {
			mail.sent.push({ to, subject, html });
			return true;
		}
	};
});

import { db, sqlite } from '$lib/server/db';
import { requestMessages, taskRequests } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken, verifyFormToken } from '$lib/server/request-tokens';
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
