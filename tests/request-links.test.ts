/**
 * A requester's links kept only as hashes (card 2870).
 *
 * Every mail to a requester that carries a link issues a token of its own,
 * and only the token's SHA-256 is kept, in `request_links`: the confirmation,
 * the team's reply and each progress mail as `mail` links (the newest 20 kept),
 * and each new link asked for as an `ask` link (the newest 3 kept, trimmed only
 * among themselves). A token is looked up by its hash before the request is
 * read. The retired `task_requests.access_token` stays NULL, and a start after
 * an older image wrote into it empties it and ends every link.
 *
 * Tokens are taken from the mail, never from a row. No email is sent:
 * `trySendEmail` is replaced with a recorder, and "is SMTP configured" and
 * "is there an address to make a link from" are switches the test sets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mail = vi.hoisted(() => ({
	configured: true,
	/** True for a server with no address to make a link from. */
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

/** How many card reports were made (card 3020, (b)): the completion mail makes one for its PDF. */
const reports = vi.hoisted(() => ({ cardReports: 0 }));

vi.mock('$lib/server/reports', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/reports')>();
	return {
		...actual,
		generateCardReport: (...args: Parameters<typeof actual.generateCardReport>) => {
			reports.cardReports++;
			return actual.generateCardReport(...args);
		}
	};
});

import { db, sqlite } from '$lib/server/db';
import { requestLinks, requestMessages, taskRequests, type TaskRequest } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import type { SessionUser } from '$lib/server/auth';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { END_PLAIN_REQUEST_LINKS, MAIL_HELD, REQUEST_MAIL_LINKS_KEPT, issueFormToken, issueRequestLink } from '$lib/server/request-tokens';
import { mailPlaceOf } from '$lib/server/setting-holds';
import { notifyRequesterProgress } from '$lib/server/notifications';
import { requesterMailAddress } from '$lib/server/request-access';
import { HELD_FROM_UNSEALED_BACKUP } from '$lib/settings-held';
import { endPlainRequestLinks } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { gate } from './helpers/gate';
import { makeBoard, makeCard, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

let staff: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	mail.configured = true;
	mail.noAddress = false;
	mail.sent.length = 0;
	reports.cardReports = 0;
	staff = makeUser({ username: 'staff' });
	A = makeBoard({ owner: staff, name: 'A' });
});

const REQUESTER = 'pat@example.test';

/** A request from the public form, as someone with no account sends it. */
const submitAnonymously = (ip?: string) =>
	api('POST', '/api/requests', {
		body: { targetType: 'user', targetId: staff.id, title: 'Please add an export', requesterName: 'Pat', requesterEmail: REQUESTER },
		ip,
		headers: { 'x-form-token': issueFormToken() }
	});

/** Every token in the mails sent, for request `id`, oldest first. */
const mailedTokens = (id: number): string[] =>
	mail.sent.flatMap((m) => [...m.html.matchAll(new RegExp(`/request/${id}/(?:confirm|reply)\\?token=([0-9a-f]{64})`, 'g'))].map((found) => found[1]));
/** The token in the newest mail for request `id`. */
const newestToken = (id: number): string => {
	const tokens = mailedTokens(id);
	if (tokens.length === 0) throw new Error(`No mail links to request ${id}`);
	return tokens[tokens.length - 1];
};

const linkRows = (id: number) =>
	db.select().from(requestLinks).where(eq(requestLinks.requestId, id)).orderBy(requestLinks.id).all();
const requestRow = (id: number) => db.select().from(taskRequests).where(eq(taskRequests.id, id)).get()!;
/** What a caller with no session is answered reading request `id` with `token`. */
const opens = async (id: number, token: string) => (await api('GET', `/api/requests/${id}?token=${token}`)).status;

/** A request from outside, waiting for an answer, addressed to `staff`. */
const pendingRequest = (status = 'pending', resolvedCardId: number | null = null): TaskRequest =>
	db
		.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: staff.id,
			requesterName: 'Pat',
			requesterEmail: REQUESTER,
			title: 'Please add an export',
			status,
			resolvedCardId
		})
		.returning()
		.get();

/** The team's reply to request `id`, mailed to its requester. */
const teamReply = (id: number, message = 'Looking at it now') =>
	api('POST', `/api/requests/${id}/messages`, { user: staff, body: { message } });

/** The work a new-link ask leads to is done after the answer: one turn of the event loop. */
const afterTheAnswer = () => new Promise((done) => setImmediate(done));

describe('a link issued at the form, and used', () => {
	it('T1: keeps only the hash of the confirmation mail’s token, which confirms and opens the request, and is no key itself', async () => {
		const made = await submitAnonymously();
		expect(made.status).toBe(201);
		const id = made.body.id as number;
		const t = newestToken(id);

		// One row, a mail link, holding the token's hash and never the token.
		expect(linkRows(id).map(({ tokenHash, source }) => ({ tokenHash, source }))).toEqual([{ tokenHash: sha256Hex(t), source: 'mail' }]);
		expect(requestRow(id).retiredAccessToken).toBeNull();
		expect(JSON.stringify(requestRow(id))).not.toContain(t);
		expect(JSON.stringify(db.select().from(requestLinks).all())).not.toContain(t);

		// It confirms, and the answer's link carries it: the confirm issues nothing.
		const confirmed = await api('POST', `/api/requests/${id}/confirm`, { body: { token: t } });
		expect(confirmed.status).toBe(200);
		expect(confirmed.body.replyUrl).toBe(`/request/${id}/reply?token=${t}`);
		expect(linkRows(id)).toHaveLength(1);
		expect(await opens(id, t)).toBe(200);

		// The stored value is no key, and one request's link opens no other (S2).
		expect(await opens(id, sha256Hex(t))).toBe(404);
		const other = (await submitAnonymously('10.0.0.2')).body.id as number;
		expect(await opens(other, t)).toBe(404);
	});
});

describe('a link in each mail', () => {
	it('T2: gives the team’s reply a link of its own, the earlier one kept; and none where no mail can go, nor a request to confirm', async () => {
		const made = await submitAnonymously();
		const id = made.body.id as number;
		const t = newestToken(id);
		await api('POST', `/api/requests/${id}/confirm`, { body: { token: t } });

		expect((await teamReply(id)).status).toBe(200);
		const t2 = newestToken(id);
		expect(t2).not.toBe(t);
		expect([await opens(id, t), await opens(id, t2)]).toEqual([200, 200]);
		expect(linkRows(id)).toHaveLength(2);

		// A mail user and no password, as a restore leaves them (S5): every mail would fail.
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('smtp_user', 'dumpfire')").run();
		const sentBefore = mail.sent.length;
		expect((await teamReply(id, 'A second answer')).status).toBe(200);
		expect(db.select().from(requestMessages).where(eq(requestMessages.requestId, id)).all().map((m) => m.message)).toContain('A second answer');
		expect(linkRows(id)).toHaveLength(2);
		expect(mail.sent).toHaveLength(sentBefore);

		// And a request that must be confirmed is refused, with nothing saved.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const requests = db.select().from(taskRequests).all().length;
		const refused = await submitAnonymously('10.0.0.3');
		expect({ status: refused.status, body: refused.body }).toEqual({
			status: 503,
			body: { message: 'New links cannot be sent just now. Please contact the team that sent you the link.' }
		});
		expect(db.select().from(taskRequests).all()).toHaveLength(requests);
		expect(db.select().from(requestLinks).all()).toHaveLength(2);
		vi.restoreAllMocks();
	});

	it('T3: issues the progress mail’s link in the transaction of the write it reports, and none with no address to make it from', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Please add an export' });
		const request = pendingRequest('accepted', card.id);

		const commented = await api('POST', `/api/cards/${card.id}/comments`, { user: staff, body: { content: 'Started on it' } });

		expect(commented.status).toBe(201);
		// There as soon as the comment is committed, before the mail is built.
		expect(linkRows(request.id).map((row) => row.source)).toEqual(['mail']);
		await vi.waitFor(() => expect(mailedTokens(request.id)).toHaveLength(1));
		const token = newestToken(request.id);
		expect(linkRows(request.id)[0].tokenHash).toBe(sha256Hex(token));
		expect(await opens(request.id, token)).toBe(200);

		// The same event with no address to make the link from: no mail, and no link.
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mail.noAddress = true;
		expect((await api('POST', `/api/cards/${card.id}/comments`, { user: staff, body: { content: 'Still on it' } })).status).toBe(201);
		await afterTheAnswer();
		expect(linkRows(request.id)).toHaveLength(1);
		expect(mailedTokens(request.id)).toHaveLength(1);
		vi.restoreAllMocks();
	});
});

describe('how many links a request keeps', () => {
	it('T4: keeps the newest 20 mail links, the first ended, and issues none outside a transaction', async () => {
		const request = pendingRequest();

		const tokens = inTransaction(() => Array.from({ length: REQUEST_MAIL_LINKS_KEPT + 1 }, () => issueRequestLink(request.id, 'mail')));

		expect(REQUEST_MAIL_LINKS_KEPT).toBe(20);
		expect(linkRows(request.id)).toHaveLength(20);
		expect(await opens(request.id, tokens[0])).toBe(404);
		expect(await opens(request.id, tokens[1])).toBe(200);
		expect(await opens(request.id, tokens[20])).toBe(200);

		// Outside a transaction it throws, and writes nothing.
		expect(() => issueRequestLink(request.id, 'mail')).toThrow(/none is open/);
		expect(linkRows(request.id)).toHaveLength(20);
	});

	it('T5: keeps at most 3 asked-for links, and asks never push out a mail’s link (S1)', async () => {
		const request = pendingRequest();
		expect((await teamReply(request.id)).status).toBe(200);
		const m = newestToken(request.id);

		for (let i = 0; i < 10; i++) {
			resetAllRateLimits();
			const asked = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER }, ip: `10.0.1.${i}` });
			expect(asked.status).toBe(202);
			await afterTheAnswer();
		}

		expect(mailedTokens(request.id)).toHaveLength(11);
		expect(linkRows(request.id).map((row) => row.source)).toEqual(['mail', 'ask', 'ask', 'ask']);
		expect(await opens(request.id, m)).toBe(200);
		expect(await opens(request.id, newestToken(request.id))).toBe(200);
	});
});

describe('a new link asked for', () => {
	it('T10: is issued only to the request as it is when the link is written: an address changed after the answer gets no link and no mail (CS1)', async () => {
		const request = pendingRequest();
		// The work after the answer, held until the request has changed.
		const held: (() => void)[] = [];
		const later = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((run: () => void) => {
			held.push(run);
			return {} as NodeJS.Immediate;
		}) as unknown as typeof setImmediate);
		let asked;
		try {
			asked = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER } });
		} finally {
			later.mockRestore();
		}
		expect(asked.status).toBe(202);
		expect(held.length).toBeGreaterThan(0);

		// Between the answer and the mail, the request's address becomes another
		// one: as a restore that put somebody else's request at this id would.
		sqlite.prepare('UPDATE task_requests SET requester_email = ? WHERE id = ?').run('sam@example.test', request.id);
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'INFO';
		vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			for (const run of held) run();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			vi.restoreAllMocks();
		}

		expect(linkRows(request.id)).toEqual([]);
		expect(mail.sent).toEqual([]);
		const said = sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'REQUESTS'").all();
		expect(said).toContainEqual({
			level: 'INFO',
			message: `A new link to request ${request.id} was not mailed: the request changed after the link was asked for`
		});
	});

	it('T10b: while the mail settings are held for the superadmin’s review (card 2922, R12): 503 in plain words, the WARN says why, and no link', async () => {
		const request = pendingRequest();
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('smtp_host', 'smtp.example.test')").run();
		sqlite
			.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at) VALUES ('mail', ?, 'setter access ended', ?)")
			.run(mailPlaceOf({ host: 'smtp.example.test', port: 587, user: '', allowInsecure: false }), stamp());
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let asked;
		try {
			asked = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER } });
			await afterTheAnswer();
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			vi.restoreAllMocks();
		}

		expect({ status: asked.status, body: asked.body }).toEqual({
			status: 503,
			body: { message: 'New links cannot be sent just now. Please contact the team that sent you the link.' }
		});
		expect(linkRows(request.id)).toEqual([]);
		expect(mail.sent).toEqual([]);
		const said = sqlite.prepare("SELECT message FROM system_logs WHERE context = 'REQUESTS' AND level = 'WARN'").all() as { message: string }[];
		expect(said.map((line) => line.message)).toEqual([`A new link to a request was asked for, and none can be sent: ${MAIL_HELD}.`]);
	});
});

describe('a settled request’s links end 90 days after it was settled (card 2902)', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const daysAgo = (days: number) => stamp(new Date(Date.now() - days * DAY));
	/** A link of request `id`'s own, issued as a mail's is. */
	const linkOf = (id: number) => inTransaction(() => issueRequestLink(id, 'mail'));
	const settle = (id: number, days: number) => sqlite.prepare('UPDATE task_requests SET resolved_at = ? WHERE id = ?').run(daysAgo(days), id);
	const complete = (cardId: number, at: string | null) => sqlite.prepare('UPDATE cards SET completed_at = ? WHERE id = ?').run(at, cardId);

	it('opens a declined request up to 90 days after the decline, and not after', async () => {
		const request = pendingRequest('rejected');
		const t = linkOf(request.id);

		settle(request.id, 89);
		expect(await opens(request.id, t)).toBe(200);
		settle(request.id, 91);
		expect(await opens(request.id, t)).toBe(404);
	});

	it('opens an accepted request while its card is open, however old; not 90 days after the card is completed; and again once it is reopened', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Please add an export' });
		const request = pendingRequest('accepted', card.id);
		const t = linkOf(request.id);
		settle(request.id, 400);

		expect(await opens(request.id, t)).toBe(200);
		complete(card.id, daysAgo(91));
		expect(await opens(request.id, t)).toBe(404);
		complete(card.id, null);
		expect(await opens(request.id, t)).toBe(200);
	});

	it('closes an accepted request whose card was deleted 90 days after it was accepted', async () => {
		const request = pendingRequest('accepted', null);
		const t = linkOf(request.id);
		settle(request.id, 91);

		expect(await opens(request.id, t)).toBe(404);
	});

	it('mails no new link for a closed request, and answers the one sentence', async () => {
		const request = pendingRequest('rejected');
		settle(request.id, 91);

		const asked = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER } });
		await afterTheAnswer();

		expect({ status: asked.status, body: asked.body }).toEqual({
			status: 202,
			body: { message: 'If that is the address the request was made with, a new link has been sent to it.' }
		});
		expect(mail.sent).toEqual([]);
		expect(linkRows(request.id)).toEqual([]);
	});
});

describe('the logs', () => {
	it('T6: hold no token from any mail, after the form, a confirm, a team reply, a progress mail and an ask, each link opened through the gate', async () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'DEBUG';
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		let tokens: string[];
		let id = 0;
		try {
			id = (await submitAnonymously()).body.id as number;
			await api('POST', `/api/requests/${id}/confirm`, { body: { token: newestToken(id) } });
			await teamReply(id);
			const accepted = await api('PATCH', `/api/requests/${id}`, {
				user: staff,
				body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
			});
			expect(accepted.status).toBe(200);
			await api('POST', `/api/cards/${accepted.body.resolvedCardId}/comments`, { user: staff, body: { content: 'Started on it' } });
			await vi.waitFor(() => expect(mailedTokens(id)).toHaveLength(3));
			await api('POST', `/api/requests/${id}/link`, { body: { email: REQUESTER } });
			await afterTheAnswer();

			tokens = mailedTokens(id);
			expect(tokens).toHaveLength(4);
			expect(new Set(tokens).size).toBe(4);
			for (const token of tokens) {
				expect((await gate('GET', `/api/requests/${id}?token=${token}`, { headers: { accept: '*/*' } })).status).toBe(200);
				await gate('GET', `/api/requests/${id}/messages?token=${token}`, { headers: { accept: '*/*' } });
			}
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			vi.restoreAllMocks();
		}

		const logged = JSON.stringify(sqlite.prepare('SELECT message, meta FROM system_logs').all());
		const activity = JSON.stringify(sqlite.prepare('SELECT * FROM activity_log').all());
		// The gate wrote each read down, by its path alone.
		expect(logged).toContain(`GET /api/requests/${id}/messages`);
		for (const token of tokens) {
			expect(logged).not.toContain(token);
			expect(activity).not.toContain(token);
		}
	});
});

describe('the sweep at start after an older image (endPlainRequestLinks)', () => {
	it('T7: empties the retired column, ends every link with one WARN, then finds nothing; and leaves the links where nothing is plain', () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// As an older image's backfill leaves them: two in plain, one not yet filled.
			const [first, second, third] = [pendingRequest(), pendingRequest(), pendingRequest()];
			const plain = sqlite.prepare('UPDATE task_requests SET access_token = ? WHERE id = ?');
			plain.run('1'.repeat(64), first.id);
			plain.run('2'.repeat(64), second.id);
			inTransaction(() => {
				for (const id of [first.id, first.id, second.id, third.id]) issueRequestLink(id, 'mail');
			});

			expect(endPlainRequestLinks()).toBe(6);

			expect(sqlite.prepare('SELECT access_token FROM task_requests ORDER BY id').pluck().all()).toEqual([null, null, null]);
			expect(db.select().from(requestLinks).all()).toEqual([]);
			const warned = sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'REQUESTS'").all() as { level: string; message: string }[];
			expect(warned).toHaveLength(1);
			expect(warned[0].level).toBe('WARN');
			expect(warned[0].message).toMatch(/^Ended the links of 2 request\(s\) held in plain by an older image, and 4 link\(s\) kept as hashes: /);

			// Again: nothing to do, and nothing said.
			expect(endPlainRequestLinks()).toBe(0);
			expect(sqlite.prepare("SELECT COUNT(*) FROM system_logs WHERE context = 'REQUESTS'").pluck().get()).toBe(1);

			// With no plain value, the links are left as they are.
			const kept = inTransaction(() => [issueRequestLink(first.id, 'mail'), issueRequestLink(third.id, 'ask')]);
			expect(endPlainRequestLinks()).toBe(0);
			expect(db.select().from(requestLinks).all().map((row) => row.tokenHash)).toEqual(kept.map(sha256Hex));
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			vi.restoreAllMocks();
		}
	});

	it('T8: ends every link when it cannot look, says so at WARN, and the server starts; and throws when it cannot end them either (CS3)', () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const request = pendingRequest();
		inTransaction(() => [issueRequestLink(request.id, 'mail'), issueRequestLink(request.id, 'ask')]);
		const prepare = sqlite.prepare.bind(sqlite);
		/** `sqlite.prepare`, failing for each statement named. */
		const failing = (...statements: string[]) =>
			vi.spyOn(sqlite, 'prepare').mockImplementation(((sql: string) => {
				if (statements.includes(sql)) throw new Error('the database is not to be had');
				return prepare(sql);
			}) as typeof sqlite.prepare);

		try {
			// The sweep fails: every link is ended on its own, and it does not throw.
			failing(END_PLAIN_REQUEST_LINKS);
			expect(endPlainRequestLinks()).toBeNull();
			vi.mocked(sqlite.prepare).mockRestore();
			expect(linkRows(request.id)).toEqual([]);
			expect(said.mock.calls.map(([line]) => String(line))).toEqual([
				expect.stringMatching(
					/\[WARN\] \[REQUESTS\] Request links held in plain by an older image could not be looked for: the database is not to be had\. Every link kept as a hash was ended instead \(2\)/
				)
			]);

			// Both fail: it throws, and the server stops before it listens.
			inTransaction(() => issueRequestLink(request.id, 'mail'));
			failing(END_PLAIN_REQUEST_LINKS, 'DELETE FROM request_links');
			expect(() => endPlainRequestLinks()).toThrow(/could not be ended either .*The server does not start/);
			vi.mocked(sqlite.prepare).mockRestore();
			expect(linkRows(request.id)).toHaveLength(1);
		} finally {
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
			vi.restoreAllMocks();
		}
	});
});

// ─── Card 3020: a request whose requester mail is held ───────────────────────

describe('a request whose requester mail is held (card 3020, slice 1)', () => {
	/** Hold request `id`'s mail, as a restore of a backup whose seal did not verify does. */
	const hold = (id: number) => sqlite.prepare('UPDATE task_requests SET mail_held_because = ? WHERE id = ?').run(HELD_FROM_UNSEALED_BACKUP, id);
	/** An accepted request on `cardId` from outside, at `address`. */
	const acceptedOn = (cardId: number, address: string) =>
		db
			.insert(taskRequests)
			.values({ targetType: 'user', targetId: staff.id, requesterName: 'Pat', requesterEmail: address, title: 'Please add an export', status: 'accepted', resolvedCardId: cardId })
			.returning()
			.get();
	/** Long enough for a mail started after the answer to be built and handed on. */
	const settled = () => new Promise((done) => setTimeout(done, 50));

	it('(a) card 3020: a comment on the card of a held accepted anonymous request sends no mail and writes no link', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Please add an export' });
		const request = pendingRequest('accepted', card.id);
		hold(request.id);

		const commented = await api('POST', `/api/cards/${card.id}/comments`, { user: staff, body: { content: 'Started on it' } });
		await settled();

		expect(commented.status).toBe(201);
		expect(linkRows(request.id)).toEqual([]);
		expect(mail.sent).toEqual([]);
	});

	it('(a2) card 3020, R10: a planted held request and a genuine one on the same card: the genuine requester is mailed with a link of their own, the held one gets nothing', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Please add an export' });
		// The planted one first, with the lower id, as a restore would leave it.
		const planted = acceptedOn(card.id, 'eve@example.test');
		hold(planted.id);
		const genuine = acceptedOn(card.id, REQUESTER);

		expect((await api('POST', `/api/cards/${card.id}/comments`, { user: staff, body: { content: 'Started on it' } })).status).toBe(201);
		await vi.waitFor(() => expect(mailedTokens(genuine.id)).toHaveLength(1));
		await settled();

		expect(mail.sent.map((sent) => sent.to)).toEqual([REQUESTER]);
		expect(linkRows(genuine.id).map((row) => ({ tokenHash: row.tokenHash, source: row.source }))).toEqual([
			{ tokenHash: sha256Hex(newestToken(genuine.id)), source: 'mail' }
		]);
		expect(linkRows(planted.id)).toEqual([]);
		expect(mailedTokens(planted.id)).toEqual([]);
	});

	it('(b) card 3020: the held request’s card completed: no mail, and no card report made for its PDF', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Please add an export' });
		const request = pendingRequest('accepted', card.id);
		hold(request.id);

		notifyRequesterProgress({ cardId: card.id, action: 'completed', summary: '', actorName: 'staff', baseUrl: 'https://dumpfire.example.test', actorUserId: staff.id });
		await settled();

		expect(reports.cardReports).toBe(0);
		expect(mail.sent).toEqual([]);
		expect(linkRows(request.id)).toEqual([]);
	});

	it('(c) card 3020, R11: a new link asked for a held unconfirmed request with its exact address answers 202 in the usual words, and mails no confirmation and writes no link', async () => {
		const usual = pendingRequest('unverified');
		const request = pendingRequest('unverified');
		hold(request.id);

		const control = await api('POST', `/api/requests/${usual.id}/link`, { body: { email: REQUESTER }, ip: '10.0.2.1' });
		await afterTheAnswer();
		const asked = await api('POST', `/api/requests/${request.id}/link`, { body: { email: REQUESTER }, ip: '10.0.2.2' });
		await afterTheAnswer();
		await settled();

		expect(control.status).toBe(202);
		expect(mailedTokens(usual.id)).toHaveLength(1);
		expect({ status: asked.status, body: asked.body }).toEqual({ status: 202, body: control.body });
		expect(mailedTokens(request.id)).toEqual([]);
		expect(linkRows(request.id)).toEqual([]);
		expect(mail.sent).toHaveLength(1);
	});

	it('(d) card 3020, R12: an administrator’s reply on a held request is saved and answers mailed false, with no link issued and no mail sent; one on a request not held answers mailed true', async () => {
		const request = pendingRequest();
		const mailed = await teamReply(request.id, 'Before the hold');
		expect({ status: mailed.status, mailed: mailed.body.mailed }).toEqual({ status: 200, mailed: true });
		await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
		hold(request.id);
		const links = linkRows(request.id).length;

		const replied = await teamReply(request.id, 'After the hold');
		await settled();

		expect(replied.status).toBe(200);
		expect(replied.body).toMatchObject({ requestId: request.id, senderType: 'admin', message: 'After the hold', mailed: false });
		expect(db.select().from(requestMessages).where(eq(requestMessages.requestId, request.id)).all().map((m) => m.message)).toContain('After the hold');
		expect(linkRows(request.id)).toHaveLength(links);
		expect(mail.sent).toHaveLength(1);
	});

	it('(e) card 3020: accepting a held pending request makes the card and mails nothing', async () => {
		const request = pendingRequest();
		hold(request.id);

		const accepted = await api('PATCH', `/api/requests/${request.id}`, {
			user: staff,
			body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
		});
		await settled();

		expect(accepted.status).toBe(200);
		expect(requestRow(request.id)).toMatchObject({ status: 'accepted', resolvedCardId: expect.any(Number), mailHeldBecause: HELD_FROM_UNSEALED_BACKUP });
		expect(mail.sent).toEqual([]);
		expect(linkRows(request.id)).toEqual([]);
	});

	it('(f) card 3020: a held request made by an account has no mail address, though its account has one: the hold is asked before the account', () => {
		const requester = makeUser({ username: 'asker' });
		const request = db
			.insert(taskRequests)
			.values({ targetType: 'user', targetId: staff.id, requesterName: 'asker', requesterUserId: requester.id, title: 'Please add an export', status: 'pending' })
			.returning()
			.get();
		expect(requesterMailAddress(requestRow(request.id))).toBe(requester.email);

		hold(request.id);

		expect(requesterMailAddress(requestRow(request.id))).toBeNull();
	});
});
