/**
 * A task request is created, accepted and rejected all or nothing, and it is
 * resolved once.
 *
 * Accepting a request makes a card, copies the discussion onto it as comments,
 * assigns it and marks the request accepted: five kinds of row, written one
 * statement after another with nothing around them. A failure part of the way
 * left a card on the board for a request still waiting in the inbox, which
 * could then be accepted again into a second card. A request from the public
 * form clears away the old unconfirmed ones as it is created.
 *
 * Every test of a success uses `eachWriteInTurn`, which makes the request once
 * to count its writes and then once more for each of them, with that write
 * failing, and checks every time that not one row changed and nothing was
 * sent. It also checks, on the run that succeeds, that nothing was sent while
 * the transaction was still open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	activityLog,
	cardAssignees,
	cardComments,
	cards,
	requestMessages,
	taskRequests,
	type Card,
	type TaskRequest
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { issueFormToken, resetFormSecretCache } from '$lib/server/request-tokens';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects, type RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeSmtp,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(() => {
	resetDb();
	resetAllRateLimits();
	resetFormSecretCache();
});

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} (${effect.data?.type}) on board ${effect.boardId}`;
}

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

const requestRow = (id: number) => db.select().from(taskRequests).where(eq(taskRequests.id, id)).get()!;

/**
 * Make `request` with nothing failed, and check that it was answered `status`
 * with not a row changed and nothing sent.
 */
async function expectRefused(request: () => Promise<ApiResult>, status: number): Promise<ApiResult> {
	const before = snapshotDb();
	const sent = effects();
	try {
		const res = await request();
		await sent.settle();
		expect(res.status).toBe(status);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
		return res;
	} finally {
		sent.restore();
	}
}

/**
 * Run `body` with whatever it would send recorded and nothing sent. Mail is
 * switched on in every scene here, so a request made outside this, or outside
 * `eachWriteInTurn` and `expectRefused`, would try to reach a mail server.
 */
async function recording<T>(body: (sent: Effects) => Promise<T>): Promise<T> {
	const sent = effects();
	try {
		const result = await body(sent);
		await sent.settle();
		return result;
	} finally {
		sent.restore();
	}
}

type Scene = {
	/** Owns board A, and is who the request is addressed to. */
	owner: SessionUser;
	/** May edit board A. The card is given to them. */
	helper: SessionUser;
	/** Nothing to do with board A or with the request. */
	outsider: SessionUser;
	A: BoardFixture;
	/** Already in the column the request is accepted into. */
	there: Card;
	/** Waiting, from Rita, with two messages in its discussion. */
	request: TaskRequest;
};

function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const helper = makeUser({ username: 'helper' });
	const outsider = makeUser({ username: 'outsider' });
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, helper, 'editor');
	makeSmtp();
	makeWebhook(A.board);
	const there = makeCard(A.cols['To Do'], { title: 'Already there', position: 0 });

	const request = db
		.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: owner.id,
			desiredBoardId: A.board.id,
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			title: 'Please add an export',
			description: 'CSV would do',
			businessValue: 'Saves an hour a week',
			priority: 'high',
			accessToken: 'a'.repeat(64)
		})
		.returning()
		.get();
	db.insert(requestMessages)
		.values([
			{ requestId: request.id, senderType: 'admin', senderName: 'owner', message: 'Which columns?', createdAt: '2026-10-01 09:00:00' },
			{ requestId: request.id, senderType: 'requester', senderName: 'Rita', message: 'All of them', createdAt: '2026-10-01 10:00:00' }
		])
		.run();
	return { owner, helper, outsider, A, there, request };
}

// ─── Accepting ──────────────────────────────────────────────────────────────

describe('PATCH /api/requests/:id, accept', () => {
	const accept = (s: Scene, user: SessionUser | null = s.owner, body: Record<string, unknown> = {}) =>
		api('PATCH', `/api/requests/${s.request.id}`, {
			user,
			body: {
				action: 'accept',
				boardId: s.A.board.id,
				columnId: s.A.cols['To Do'].id,
				assigneeId: s.helper.id,
				...body
			}
		});

	it('makes the card, its comments and its assignee and marks the request accepted, or does none of it', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => accept(s),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: s.request.id, status: 'accepted', title: 'Please add an export' });
				// The requester's key to the thread is never sent to whoever handles it.
				expect(res.body).not.toHaveProperty('accessToken');

				const made = db.select().from(cards).where(eq(cards.id, res.body.resolvedCardId)).get()!;
				expect(made).toMatchObject({
					columnId: s.A.cols['To Do'].id,
					title: 'Please add an export',
					description: 'CSV would do',
					businessValue: 'Saves an hour a week',
					priority: 'high',
					// After the card that was already in the column.
					position: 1,
					// Raised by whoever accepted it, as the other ways of creating a card record.
					createdBy: s.owner.id,
					completedAt: null
				});
				// Its creation is recorded as any card's is: by the accepter, from the page.
				expect(
					db
						.select({ action: activityLog.action, userId: activityLog.userId, detail: activityLog.detail, source: activityLog.source })
						.from(activityLog)
						.all()
				).toEqual([{ action: 'card_created', userId: s.owner.id, detail: 'Please add an export', source: 'ui' }]);
				expect(db.select().from(cards).all()).toHaveLength(2);

				expect(requestRow(s.request.id)).toMatchObject({
					status: 'accepted',
					resolvedBy: s.owner.id,
					resolvedCardId: made.id
				});
				expect(requestRow(s.request.id).resolvedAt).not.toBeNull();

				expect(
					db
						.select({ cardId: cardComments.cardId, userId: cardComments.userId, content: cardComments.content })
						.from(cardComments)
						.all()
				).toEqual([
					{ cardId: made.id, userId: s.owner.id, content: '**🛡️ owner (from request discussion):**\nWhich columns?' },
					{ cardId: made.id, userId: s.owner.id, content: '**👤 Rita (from request discussion):**\nAll of them' }
				]);
				expect(
					db.select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId }).from(cardAssignees).all()
				).toEqual([{ cardId: made.id, userId: s.helper.id }]);
			}
		});

		// A failure at the second of these used to leave the card on the board
		// and the request still waiting, to be accepted again into another card.
		// A failure after it left a card with half its discussion, or nobody
		// assigned and nobody told.
		// The card's `card_created` entry is written with it (card 2134): this
		// route wrote none, and the board's webhook and open pages were not told.
		expect(shape(run.writes)).toEqual([
			'insert into cards',
			'insert into activity_log',
			'update task_requests set',
			'insert into card_comments',
			'insert into card_comments',
			'insert into card_assignees'
		]);
		expect(run.effects.map(name)).toEqual([
			'webhook card.created',
			'email to helper@example.test: Assigned: Please add an export',
			'email to rita@example.test: Request accepted: Please add an export',
			'event update (card) on board 1'
		]);
	});

	it('reads the request, and checks it is still waiting, inside the transaction that accepts it', async () => {
		const s = scene();
		const reads = watchReads('task_requests');

		try {
			expect((await recording(() => accept(s))).status).toBe(200);
		} finally {
			reads.restore();
		}

		// One read, with the transaction already open: nothing can resolve the
		// request between that read and the writes that follow from it.
		expect(reads.inTransaction).toEqual([true]);
	});

	it('accepts a request once when it is accepted twice at the same moment', async () => {
		const s = scene();

		await recording(async (sent) => {
			// Both are started before either is awaited, as two people pressing
			// Accept on the same request are.
			const both = await Promise.all([accept(s), accept(s)]);
			await sent.settle();

			expect(both.map((res) => res.status).sort()).toEqual([200, 400]);
			expect(both.find((res) => res.status === 400)!.body.message).toBe('Request already resolved');

			// One card beside the one that was there, one copy of the discussion,
			// one assignment, and one of each mail.
			const accepted = both.find((res) => res.status === 200)!.body;
			expect(db.select().from(cards).all()).toHaveLength(2);
			expect(db.select().from(cardComments).all()).toHaveLength(2);
			expect(db.select().from(cardAssignees).all()).toHaveLength(1);
			expect(requestRow(s.request.id).resolvedCardId).toBe(accepted.resolvedCardId);
			expect(sent.all.map(name)).toEqual([
				'webhook card.created',
				'email to helper@example.test: Assigned: Please add an export',
				'email to rita@example.test: Request accepted: Please add an export',
				'event update (card) on board 1'
			]);
		});
	});

	it('refuses a second accept, and a reject, of a request that is already accepted', async () => {
		const s = scene();
		expect((await recording(() => accept(s))).status).toBe(200);

		expect((await expectRefused(() => accept(s), 400)).body.message).toBe('Request already resolved');
		expect(
			(
				await expectRefused(
					() => api('PATCH', `/api/requests/${s.request.id}`, { user: s.owner, body: { action: 'reject' } }),
					400
				)
			).body.message
		).toBe('Request already resolved');
		expect(db.select().from(cards).all()).toHaveLength(2);
	});

	it('answers as it did for each thing that stops an accept, having written nothing', async () => {
		const s = scene();
		const B = makeBoard({ owner: s.outsider, name: 'B' });
		const patch = (id: number, user: SessionUser | null, body: Record<string, unknown>) => () =>
			api('PATCH', `/api/requests/${id}`, { user, body });
		const into = (board: BoardFixture, more: Record<string, unknown> = {}) => ({
			action: 'accept',
			boardId: board.board.id,
			columnId: board.cols['To Do'].id,
			...more
		});
		const message = async (request: () => Promise<ApiResult>, status: number) =>
			(await expectRefused(request, status)).body.message;

		await expectRefused(patch(s.request.id, null, into(s.A)), 401);
		expect(await message(patch(99999, s.owner, into(s.A)), 404)).toBe('Request not found');
		// Whose request it is comes before what was asked of it.
		expect(await message(patch(s.request.id, s.outsider, { action: 'no such thing' }), 403)).toBe(
			'This request is not addressed to you'
		);
		expect(await message(patch(s.request.id, s.owner, { action: 'accept' }), 400)).toBe(
			'Board and column are required to accept'
		);
		expect(await message(patch(s.request.id, s.owner, into(B)), 403)).toBe('No edit access to this board');
		expect(
			await message(patch(s.request.id, s.owner, { ...into(s.A), boardId: B.board.id }), 400)
		).toBe('That column is not on that board');
		expect(await message(patch(s.request.id, s.owner, into(s.A, { assigneeId: 99999 })), 404)).toBe(
			'User not found'
		);
		expect(await message(patch(s.request.id, s.owner, into(s.A, { assigneeId: s.outsider.id })), 400)).toBe(
			'User does not have access to this board'
		);
		expect(await message(patch(s.request.id, s.owner, { action: 'no such thing' }), 400)).toBe(
			'Invalid action — must be "accept" or "reject"'
		);

		expect(requestRow(s.request.id).status).toBe('pending');
	});
});

// ─── Rejecting ──────────────────────────────────────────────────────────────

describe('PATCH /api/requests/:id, reject', () => {
	const reject = (s: Scene, user: SessionUser | null = s.owner) =>
		api('PATCH', `/api/requests/${s.request.id}`, {
			user,
			body: { action: 'reject', rejectReason: 'Not this quarter' }
		});

	it('marks the request rejected and tells the requester once it is saved', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => reject(s),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: s.request.id, status: 'rejected' });
				expect(res.body).not.toHaveProperty('accessToken');
				expect(requestRow(s.request.id)).toMatchObject({
					status: 'rejected',
					resolvedBy: s.owner.id,
					rejectReason: 'Not this quarter',
					resolvedCardId: null
				});
				expect(db.select().from(cards).all()).toHaveLength(1);
			}
		});

		expect(shape(run.writes)).toEqual(['update task_requests set']);
		expect(run.effects.map(name)).toEqual(['email to rita@example.test: Request declined: Please add an export']);
	});

	it('resolves a request once when it is accepted and rejected at the same moment', async () => {
		const s = scene();

		const both = await recording(() =>
			Promise.all([
				reject(s),
				api('PATCH', `/api/requests/${s.request.id}`, {
					user: s.owner,
					body: { action: 'accept', boardId: s.A.board.id, columnId: s.A.cols['To Do'].id }
				})
			])
		);

		expect(both.map((res) => res.status).sort()).toEqual([200, 400]);
		// Whichever came first is what the request says, and there is a card only
		// if that was the accept.
		const won = both.find((res) => res.status === 200)!.body.status;
		expect(requestRow(s.request.id).status).toBe(won);
		expect(db.select().from(cards).all()).toHaveLength(won === 'accepted' ? 2 : 1);
	});

	it('refuses a caller the request is not addressed to', async () => {
		const s = scene();

		expect((await expectRefused(() => reject(s, s.outsider), 403)).body.message).toBe(
			'This request is not addressed to you'
		);
		await expectRefused(() => reject(s, null), 401);
	});
});

// ─── Creating ───────────────────────────────────────────────────────────────

describe('POST /api/requests', () => {
	type Form = Scene & {
		/** As the public form holds it once the page has been rendered. */
		token: string;
		/** Never confirmed, and old enough to be cleared away. */
		stale: TaskRequest;
		/** Never confirmed, from yesterday: its requester may still follow the link. */
		recent: TaskRequest;
	};

	const daysAgo = (days: number) =>
		new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

	const withForm = (): Form => {
		// A request counts against its sender whether or not it is saved, and
		// this fixture is built once for each write that is made to fail.
		resetAllRateLimits();
		resetFormSecretCache();
		const s = scene();
		const unconfirmed = (title: string, createdAt: string, accessToken: string) =>
			db
				.insert(taskRequests)
				.values({
					targetType: 'user',
					targetId: s.owner.id,
					desiredBoardId: s.A.board.id,
					requesterEmail: 'nobody@example.test',
					title,
					status: 'unverified',
					accessToken,
					createdAt
				})
				.returning()
				.get();
		const stale = unconfirmed('Never confirmed', daysAgo(8), 'b'.repeat(64));
		const recent = unconfirmed('Not confirmed yet', daysAgo(1), 'c'.repeat(64));
		// Issuing the first token stores the key it is signed with.
		const token = issueFormToken();
		return { ...s, token, stale, recent };
	};

	const submission = (s: Scene, overrides: Record<string, unknown> = {}) => ({
		targetType: 'user',
		targetId: s.owner.id,
		desiredBoardId: s.A.board.id,
		title: '  A dark theme  ',
		description: 'For the night shift',
		priority: 'low',
		requesterName: 'Pat',
		requesterEmail: 'pat@example.test',
		...overrides
	});

	/** `ip` is the address it comes from: one address may make five requests in a quarter of an hour. */
	const submit = (s: Form, overrides: Record<string, unknown> = {}, ip?: string) =>
		api('POST', '/api/requests', { headers: { 'x-form-token': s.token }, ip, body: submission(s, overrides) });

	const titles = () =>
		db
			.select({ title: taskRequests.title, status: taskRequests.status })
			.from(taskRequests)
			.all();

	it('from the public form, clears the old unconfirmed requests and holds the new one, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: withForm,
			request: (s) => submit(s),
			afterSuccess: (_s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ title: 'A dark theme', status: 'unverified', verificationRequired: true });
				expect(res.body).not.toHaveProperty('accessToken');
				expect(titles()).toEqual([
					{ title: 'Please add an export', status: 'pending' },
					{ title: 'Not confirmed yet', status: 'unverified' },
					{ title: 'A dark theme', status: 'unverified' }
				]);
				expect(requestRow(res.body.id)).toMatchObject({
					requesterName: 'Pat',
					requesterEmail: 'pat@example.test',
					requesterUserId: null,
					priority: 'low'
				});
				expect(requestRow(res.body.id).accessToken).toMatch(/^[0-9a-f]{64}$/);
			}
		});

		expect(shape(run.writes)).toEqual(['delete from task_requests', 'insert into task_requests']);
		// The requester is asked to confirm. The team hears nothing yet.
		expect(run.effects.map(name)).toEqual(['email to pat@example.test: Confirm your request: A dark theme']);
	});

	it('from somebody signed in, goes straight to whoever it is for', async () => {
		const run = await eachWriteInTurn({
			build: withForm,
			request: (s) => api('POST', '/api/requests', { user: s.helper, body: submission(s) }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ title: 'A dark theme', status: 'pending', verificationRequired: false });
				// Their own name and address, whatever the form said.
				expect(requestRow(res.body.id)).toMatchObject({
					requesterName: 'helper',
					requesterEmail: 'helper@example.test',
					requesterUserId: s.helper.id
				});
				// Clearing old requests is the public form's housekeeping, not theirs.
				expect(titles().map((row) => row.title)).toContain('Never confirmed');
			}
		});

		expect(shape(run.writes)).toEqual(['insert into task_requests']);
		expect(run.effects.map(name)).toEqual(['email to owner@example.test: New request: A dark theme']);
	});

	it('to a team, tells each of its members once it is saved', async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const s = withForm();
				const team = makeTeam([s.owner, s.helper], 'Platform');
				return { ...s, team };
			},
			request: (s) =>
				api('POST', '/api/requests', {
					user: s.outsider,
					// They cannot open board A, and name no board (card 2128).
					body: submission(s, { targetType: 'team', targetId: s.team.id, desiredBoardId: null })
				}),
			afterSuccess: (_s, res: ApiResult) => {
				expect(res.status).toBe(201);
			}
		});

		expect(run.effects.map(name)).toEqual([
			'email to owner@example.test: New request: A dark theme',
			'email to helper@example.test: New request: A dark theme'
		]);
	});

	it('answers as it did for each thing that stops a request, having written nothing', async () => {
		const s = withForm();
		const message = async (request: () => Promise<ApiResult>, status: number) =>
			(await expectRefused(request, status)).body.message;

		expect(
			await message(() => api('POST', '/api/requests', { body: submission(s) }), 403)
		).toBe('This form has expired. Reload the page and try again.');
		expect(await message(() => submit(s, { title: '   ' }, '10.0.0.1'), 400)).toBe('Title is required');
		// A board is optional (card 2128). Signed in, one named is one the caller can open.
		expect(await message(() => api('POST', '/api/requests', { user: s.outsider, body: submission(s) }), 403)).toBe(
			'No access to this board'
		);
		expect(
			await message(() => api('POST', '/api/requests', { user: s.helper, body: submission(s, { desiredBoardId: 99999 }) }), 404)
		).toBe('Board not found');
		// Who it is for and where it goes are looked up before the address is read.
		expect(
			await message(() => submit(s, { targetId: 99999, requesterEmail: 'not an address' }, '10.0.0.3'), 404)
		).toBe('User not found');
		expect(await message(() => submit(s, { targetType: 'team', targetId: 99999 }, '10.0.0.4'), 404)).toBe(
			'Team not found'
		);
		// Without an account the board is not read at all: a board that is not
		// there is not looked for, and the address is what is refused.
		expect(
			await message(() => submit(s, { desiredBoardId: 99999, requesterEmail: 'not an address' }, '10.0.0.5'), 400)
		).toBe('A valid email address is required');
		expect(await message(() => submit(s, { requesterEmail: 'not an address' }, '10.0.0.6'), 400)).toBe(
			'A valid email address is required'
		);

		// The old unconfirmed request is cleared only by a request that is saved.
		expect(titles().map((row) => row.title)).toContain('Never confirmed');
	});

	it('limits one address to three requests an hour, and the fourth clears nothing', async () => {
		const s = withForm();
		// From a different caller each time, so that only the address is limited.
		const from = (n: number) => submit(s, {}, `10.0.0.${n}`);

		const first = await recording(async () => [await from(1), await from(2), await from(3)]);
		expect(first.map((res) => res.status)).toEqual([201, 201, 201]);
		// Something for the fourth to clear away, were it to get that far.
		db.update(taskRequests).set({ createdAt: daysAgo(8) }).where(eq(taskRequests.id, s.recent.id)).run();

		const res = await expectRefused(() => from(4), 429);

		expect(res.body.message).toMatch(/^Too many requests/);
		expect(titles().map((row) => row.title)).toContain('Not confirmed yet');
	});
});
