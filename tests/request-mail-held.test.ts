/**
 * The requests whose mail to their requester is held, and their release (card
 * 3020, slice 3: the plan's cases (aa) to (ad)).
 *
 * A restore of a backup whose seal did not verify holds the mail of each
 * request it brought in with an address this server did not hold as it is
 * (`mail_held_because`). Every administrator lists them at
 * `GET /api/requests/held`, whatever they were addressed to (R2), and
 * releases one with a password and a code, sending back the address reviewed
 * (R4): a different one is 409, as is a request not held or not yet confirmed
 * (R11). A release is recorded in the row's own columns, writes one INFO line
 * with no address, and mails nothing. The request lists give `mailHeld`, and
 * the answers a requester or an anonymous caller reads give nothing of the
 * hold (R18).
 *
 * No email is sent: `trySendEmail` is replaced with a recorder, as in
 * request-links.test.ts. The plan is
 * docs/planning/card-3020-unsealed-request-addresses.md, sections 3.2 and 5.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const mail = vi.hoisted(() => ({ sent: [] as { to: string; subject: string; html: string }[] }));

vi.mock('$lib/server/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/email')>();
	return {
		...actual,
		isSmtpConfigured: () => true,
		trySendEmail: async (to: string, subject: string, html: string) => {
			mail.sent.push({ to, subject, html });
			return { sent: true } as const;
		}
	};
});

import { db, sqlite } from '$lib/server/db';
import { cards, taskRequests, users, type TaskRequest } from '$lib/server/db/schema';
import { flushPendingLogs } from '$lib/server/logger';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken } from '$lib/server/request-tokens';
import type { SessionUser } from '$lib/server/auth';
import { HELD_FROM_UNSEALED_BACKUP } from '$lib/settings-held';
import { api } from './helpers/api';
import { makeBoard, makeCard, makeUser, resetDb, stepUp, type BoardFixture } from './helpers/fixtures';

const REQUESTER = 'pat@example.test';

let staff: SessionUser;
let chief: SessionUser;
let A: BoardFixture;
let level: string | undefined;

beforeEach(() => {
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	resetDb();
	resetAllRateLimits();
	mail.sent.length = 0;
	// `staff` is the member the requests are addressed to; `chief` an administrator they are not.
	staff = makeUser({ username: 'staff' });
	chief = makeUser({ username: 'chief', role: 'admin' });
	A = makeBoard({ owner: staff, name: 'Board A' });
});

afterEach(() => {
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
});

/** A request from outside, addressed to `staff`. */
const requestOf = (values: Partial<typeof taskRequests.$inferInsert> = {}): TaskRequest =>
	db
		.insert(taskRequests)
		.values({ targetType: 'user', targetId: staff.id, requesterName: 'Pat', requesterEmail: REQUESTER, title: 'Please add an export', status: 'pending', ...values })
		.returning()
		.get();
/** Hold request `id`'s mail, as a restore of a backup whose seal did not verify does. */
const hold = (id: number) => sqlite.prepare('UPDATE task_requests SET mail_held_because = ? WHERE id = ?').run(HELD_FROM_UNSEALED_BACKUP, id);
const requestRow = (id: number) => db.select().from(taskRequests).where(eq(taskRequests.id, id)).get()!;
/** The REQUESTS lines in the system log, as the server wrote them. */
const requestLines = () => {
	flushPendingLogs();
	return sqlite.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'REQUESTS' ORDER BY id").all() as {
		level: string;
		message: string;
		userId: number | null;
	}[];
};
/** The card a release sends back, as the GET gave it: none where it gave none. */
type Reviewed = { id: number; title: string; board: string } | null;
/** The release of request `id`, by `who` with their password and a code, of the address and the card reviewed. */
const release = (who: SessionUser, id: number, address: string | null, card: Reviewed = null) =>
	api('POST', '/api/requests/held', stepUp(who, { requestId: id, address, cardId: card?.id ?? null, cardTitle: card?.title ?? null, cardBoard: card?.board ?? null }));
/** What a release whose address or card is not the one reviewed is told. */
const MOVED = "That request's address or card has changed since the list was read: read it again and review it as it is now. Nothing was changed.";
/** Long enough for a mail started after the answer to be built and handed on. */
const settled = () => new Promise((done) => setTimeout(done, 50));

describe('the held list and the release (card 3020, slice 3)', () => {
	it('(aa) card 3020, R2, R4: an administrator it is not addressed to lists a held request with its card and board, releases it with its address, password and code; the release is recorded, logged without the address, mails nothing, and the next comment mails the requester', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Export to CSV' });
		const request = requestOf({ status: 'accepted', resolvedCardId: card.id });
		hold(request.id);

		const listed = await api('GET', '/api/requests/held', { user: chief });
		expect(listed.status).toBe(200);
		expect(listed.headers.get('cache-control')).toBe('no-store');
		expect(listed.body).toEqual({
			held: [
				{
					id: request.id,
					title: 'Please add an export',
					status: 'accepted',
					unconfirmed: false,
					releasable: true,
					requesterName: 'Pat',
					address: REQUESTER,
					card: { id: card.id, title: 'Export to CSV', board: 'Board A' },
					heldBecause: HELD_FROM_UNSEALED_BACKUP,
					createdAt: request.createdAt
				}
			],
			mayRelease: true
		});

		const released = await release(chief, request.id, REQUESTER, { id: card.id, title: 'Export to CSV', board: 'Board A' });
		await settled();

		expect({ status: released.status, body: released.body }).toEqual({ status: 200, body: { success: true, released: request.id } });
		expect(requestRow(request.id)).toMatchObject({
			mailHeldBecause: null,
			mailReleasedAt: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
			mailReleasedBy: chief.id,
			mailReleasedByName: 'chief'
		});
		const lines = requestLines();
		expect(lines.map(({ level, userId }) => ({ level, userId }))).toEqual([{ level: 'INFO', userId: chief.id }]);
		expect(lines[0].message).toContain(`request ${request.id}`);
		expect(lines[0].message).toContain('chief');
		expect(lines[0].message).not.toContain(REQUESTER);
		expect(mail.sent).toEqual([]);
		expect((await api('GET', '/api/requests/held', { user: chief })).body).toEqual({ held: [], mayRelease: true });

		// Released: the next progress mail goes to the requester.
		expect((await api('POST', `/api/cards/${card.id}/comments`, { user: staff, body: { content: 'Started on it' } })).status).toBe(201);
		await vi.waitFor(() => expect(mail.sent.map((sent) => sent.to)).toEqual([REQUESTER]));
	});

	it('(ab1) card 3020, R2: a member the held request is addressed to is refused the list, 403', async () => {
		const request = requestOf();
		hold(request.id);

		const listed = await api('GET', '/api/requests/held', { user: staff });

		expect(listed.status).toBe(403);
		expect(listed.body).not.toHaveProperty('held');
	});

	it('(ab2) card 3020, R2: a member the held request is addressed to is refused the release, 403, and it stays held', async () => {
		const request = requestOf();
		hold(request.id);

		const released = await release(staff, request.id, REQUESTER);

		expect(released.status).toBe(403);
		expect(requestRow(request.id)).toMatchObject({ mailHeldBecause: HELD_FROM_UNSEALED_BACKUP, mailReleasedAt: null, mailReleasedBy: null });
		expect(requestLines()).toEqual([]);
	});

	it('(ac) card 3020: a request whose mail is not held is refused, 409 NOT_HELD, and nothing is written', async () => {
		const request = requestOf();

		const released = await release(chief, request.id, REQUESTER);

		expect(released.status).toBe(409);
		expect(released.body.message).toBe("That request's mail is not held now: it was released since the list was read. Nothing was changed.");
		expect(requestRow(request.id)).toEqual(request);
		expect(requestLines()).toEqual([]);
	});

	it("(ac2) card 3020, R4: the requester's account address changed after the list was read: 409 MOVED, and it stays held", async () => {
		const asker = makeUser({ username: 'asker' });
		const request = requestOf({ requesterName: 'asker', requesterEmail: null, requesterUserId: asker.id });
		hold(request.id);
		const listed = await api('GET', '/api/requests/held', { user: chief });
		const reviewed = listed.body.held[0].address as string;
		expect(reviewed).toBe(asker.email);

		db.update(users).set({ email: 'eve@elsewhere.test' }).where(eq(users.id, asker.id)).run();
		const released = await release(chief, request.id, reviewed);

		expect(released.status).toBe(409);
		expect(released.body.message).toBe(MOVED);
		expect(requestRow(request.id)).toMatchObject({ mailHeldBecause: HELD_FROM_UNSEALED_BACKUP, mailReleasedAt: null });
		expect(requestLines()).toEqual([]);
	});

	it("(ac4) card 3020's code review, FP3: a held request with no address is listed as not releasable, and its release is refused, 409, whatever address is sent; it stays held", async () => {
		const gone = makeUser({ username: 'gone' });
		const byAccount = requestOf({ requesterName: 'gone', requesterEmail: null, requesterUserId: gone.id });
		const blank = requestOf({ requesterEmail: '' });
		for (const request of [byAccount, blank]) hold(request.id);
		// The account goes after the request is held: the request has no address now.
		sqlite.prepare('UPDATE task_requests SET requester_user_id = NULL WHERE id = ?').run(byAccount.id);

		const listed = await api('GET', '/api/requests/held', { user: chief });
		expect(listed.body.held).toEqual([byAccount, blank].map((request) => expect.objectContaining({ id: request.id, address: null, releasable: false })));

		for (const request of [byAccount, blank]) {
			for (const sent of [null, REQUESTER]) {
				const released = await release(chief, request.id, sent);
				expect(released.status, `${request.id} ${sent}`).toBe(409);
				expect(released.body.message).toBe('A request with no address cannot be released: it stays held. Nothing was changed.');
			}
			expect(requestRow(request.id)).toMatchObject({ mailHeldBecause: HELD_FROM_UNSEALED_BACKUP, mailReleasedAt: null, mailReleasedBy: null });
		}
		expect(requestLines()).toEqual([]);
	});

	it("(ac5) card 3020's code review, FP4: the card renamed, moved to another board, or not the one sent, after the list was read: 409 MOVED, and it stays held; as reviewed, it is released", async () => {
		const B = makeBoard({ owner: staff, name: 'Board B' });
		const card = makeCard(A.cols['To Do'], { title: 'Export to CSV' });
		const other = makeCard(A.cols['To Do'], { title: 'Export to CSV' });
		const request = requestOf({ status: 'accepted', resolvedCardId: card.id });
		hold(request.id);
		const reviewed = (await api('GET', '/api/requests/held', { user: chief })).body.held[0].card as Reviewed;
		expect(reviewed).toEqual({ id: card.id, title: 'Export to CSV', board: 'Board A' });

		const changes: [string, () => void, () => void, Reviewed][] = [
			['renamed', () => db.update(cards).set({ title: 'Export to CSV now' }).where(eq(cards.id, card.id)).run(), () => db.update(cards).set({ title: 'Export to CSV' }).where(eq(cards.id, card.id)).run(), reviewed],
			['moved', () => db.update(cards).set({ columnId: B.cols['To Do'].id }).where(eq(cards.id, card.id)).run(), () => db.update(cards).set({ columnId: A.cols['To Do'].id }).where(eq(cards.id, card.id)).run(), reviewed],
			['a twin card sent', () => {}, () => {}, { ...reviewed!, id: other.id }],
			['no card sent', () => {}, () => {}, null]
		];
		for (const [what, change, undo, sent] of changes) {
			change();
			const released = await release(chief, request.id, REQUESTER, sent);
			undo();
			expect(released.status, what).toBe(409);
			expect(released.body.message, what).toBe(MOVED);
			expect(requestRow(request.id), what).toMatchObject({ mailHeldBecause: HELD_FROM_UNSEALED_BACKUP, mailReleasedAt: null });
		}
		// And a request with no card, sent one.
		const cardless = requestOf({ title: 'No card' });
		hold(cardless.id);
		expect((await release(chief, cardless.id, REQUESTER, reviewed)).status).toBe(409);

		expect((await release(chief, request.id, REQUESTER, reviewed)).status).toBe(200);
		expect(requestRow(request.id)).toMatchObject({ mailHeldBecause: null, mailReleasedBy: chief.id });
	});

	it('(ac3) card 3020, R11: an unconfirmed held request is listed as not releasable, and its release is refused, 409 UNCONFIRMED', async () => {
		const request = requestOf({ status: 'unverified' });
		hold(request.id);

		const listed = await api('GET', '/api/requests/held', { user: chief });
		const released = await release(chief, request.id, REQUESTER);

		expect(listed.body.held).toEqual([expect.objectContaining({ id: request.id, status: 'unverified', unconfirmed: true, releasable: false })]);
		expect(released.status).toBe(409);
		expect(released.body.message).toBe('An unconfirmed request cannot be released: it lapses 7 days after it was made. Nothing was changed.');
		expect(requestRow(request.id)).toMatchObject({ mailHeldBecause: HELD_FROM_UNSEALED_BACKUP, mailReleasedAt: null });
	});

	it('(ad) card 3020, R18: the inbox list and the signed-in read give mailHeld; the anonymous form’s answer and the accept’s carry nothing of the hold or a release', async () => {
		const held = requestOf();
		hold(held.id);
		const free = requestOf({ title: 'Another' });

		const inbox = await api('GET', '/api/requests', { user: staff });
		const read = await api('GET', `/api/requests/${held.id}`, { user: staff });

		expect(inbox.status).toBe(200);
		expect(inbox.body.map((row: { id: number; mailHeld: boolean }) => ({ id: row.id, mailHeld: row.mailHeld })).sort((a: { id: number }, b: { id: number }) => a.id - b.id)).toEqual([
			{ id: held.id, mailHeld: true },
			{ id: free.id, mailHeld: false }
		]);
		expect(read.status).toBe(200);
		expect(read.body.mailHeld).toBe(true);

		const UNSENT = ['mailHeldBecause', 'mailReleasedAt', 'mailReleasedBy', 'mailReleasedByName'];
		for (const row of inbox.body) for (const key of UNSENT) expect(row, key).not.toHaveProperty(key);

		const submitted = await api('POST', '/api/requests', {
			body: { targetType: 'user', targetId: staff.id, title: 'From the form', requesterName: 'Pat', requesterEmail: REQUESTER },
			headers: { 'x-form-token': issueFormToken() }
		});
		const accepted = await api('PATCH', `/api/requests/${held.id}`, {
			user: staff,
			body: { action: 'accept', boardId: A.board.id, columnId: A.cols['To Do'].id }
		});

		expect(submitted.status).toBe(201);
		expect(accepted.status).toBe(200);
		for (const key of UNSENT) {
			expect(submitted.body, key).not.toHaveProperty(key);
			expect(accepted.body, key).not.toHaveProperty(key);
		}
	});
});
