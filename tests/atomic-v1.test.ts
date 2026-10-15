/**
 * The documented API, `/api/v1/`: every request that makes more than one write
 * is all or nothing.
 *
 * Nearly all of these are one row and the activity entry that says who wrote
 * it: a card, a subtask, a comment, an assignee, a dependency, a milestone, a
 * change to a board. A new board is four writes. Each was written one
 * statement after another with nothing around them, so a failure part of the
 * way left the row with nothing to say who made it. The card update was worse:
 * it wrote the milestone before it had finished checking the body, so a title
 * that was too long answered 400 and left the card in its new milestone.
 *
 * Each of them also looked the card or the board up, and checked the caller
 * against it, before it awaited the body. Those checks are now made inside the
 * transaction that writes: the last block of tests shows it for every path.
 *
 * Every test of a success uses `eachWriteInTurn`, which makes the request once
 * to count its writes and then once more for each of them, with that write
 * failing, and checks every time that not one row changed and nothing was
 * sent. It also checks, on the run that succeeds, that nothing was sent while
 * the transaction was still open.
 *
 * The moves, the deletes and the bulk endpoints of this tree are in
 * `atomic-moves.test.ts`, `deletes.test.ts` and `bulk-endpoints.test.ts`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	activityLog,
	boardMembers,
	boards,
	cardAssignees,
	cardComments,
	cards,
	columns,
	milestones,
	subtasks,
	taskRequests,
	workDependencies,
	type Card
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeMilestone,
	makeSmtp,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} (${effect.data?.type}) on board ${effect.boardId}`;
}

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			userId: activityLog.userId,
			action: activityLog.action,
			detail: activityLog.detail,
			source: activityLog.source
		})
		.from(activityLog)
		.all();

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;

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

type Scene = {
	owner: SessionUser;
	admin: SessionUser;
	/** May look at board A and change nothing on it. */
	viewer: SessionUser;
	/** Has a board of their own, and nothing to do with A. */
	outsider: SessionUser;
	A: BoardFixture;
	B: BoardFixture;
	/** Two cards on A. */
	first: Card;
	second: Card;
	/** A card on B. */
	far: Card;
};

/** Board A with a webhook and two cards, mail switched on, and board B, which is somebody else's. */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const viewer = makeUser({ username: 'viewer' });
	const outsider = makeUser({ username: 'outsider' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner: outsider, name: 'B' });
	addBoardMember(A.board, viewer, 'viewer');
	makeSmtp();
	makeWebhook(A.board);
	const first = makeCard(A.cols['To Do'], { title: 'First' });
	const second = makeCard(A.cols['To Do'], { title: 'Second', position: 1 });
	const far = makeCard(B.cols['To Do'], { title: 'Far' });
	return { owner, admin, viewer, outsider, A, B, first, second, far };
}

// ─── Updating a card ────────────────────────────────────────────────────────

describe('PUT /api/v1/cards/:cardId', () => {
	/**
	 * The first card is already in a milestone, so that "as it was" is a
	 * milestone and not the absence of one. `goal` is another on the same
	 * board; `hidden` is on a board the owner of A cannot open.
	 */
	const withGoals = () => {
		const s = scene();
		const current = makeMilestone({ board: s.A.board, name: 'Current', createdBy: s.owner, cards: [s.first] });
		const goal = makeMilestone({ board: s.A.board, name: 'Goal', createdBy: s.owner });
		const hidden = makeMilestone({ board: s.B.board, name: 'Hidden', createdBy: s.outsider });
		return { ...s, current, goal, hidden };
	};

	const put = (user: SessionUser | null, card: number | string, body: unknown) => () =>
		api('PUT', `/api/v1/cards/${card}`, { user, body });

	it('changes the milestone, the other fields and the activity entry together, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: withGoals,
			// A column is sent as well. This route has never moved a card, and
			// does not now: `PUT /api/v1/cards/:cardId/move` is the move.
			request: ({ owner, A, first, goal }) =>
				put(owner, first.id, {
					columnId: A.cols['In Progress'].id,
					title: 'Renamed',
					priority: 'high',
					milestoneId: goal.id
				})(),
			afterSuccess: ({ owner, A, first, goal }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({
					id: first.id,
					title: 'Renamed',
					priority: 'high',
					milestoneId: goal.id,
					columnId: A.cols['To Do'].id
				});

				expect(cardRow(first.id)).toMatchObject({
					title: 'Renamed',
					priority: 'high',
					milestoneId: goal.id,
					columnId: A.cols['To Do'].id
				});
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'api:card_updated',
						detail: 'Updated fields: title, priority, milestoneId on "Renamed"',
						source: 'api'
					}
				]);
			}
		});

		// The milestone, then the other fields, then the entry. A failure at the
		// second or third used to leave the card in its new milestone with its
		// other changes lost, or changed with nothing to say who changed it.
		expect(shape(run.writes)).toEqual(['update cards set', 'update cards set', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update (card) on board 1', 'webhook card.updated']);
	});

	it('answers 400 for a title that is too long and leaves the milestone as it was', async () => {
		const s = withGoals();

		const res = await expectRefused(put(s.owner, s.first.id, { milestoneId: s.goal.id, title: 'x'.repeat(501) }), 400);

		expect(res.body.message).toBe('Title too long (max 500 chars)');
		// It used to be `goal`: the milestone was written before the title was looked at.
		expect(cardRow(s.first.id).milestoneId).toBe(s.current.id);
		expect(cardRow(s.first.id).title).toBe('First');
	});

	it('answers 400 for a description that is too long and leaves the card in its milestone', async () => {
		const s = withGoals();

		const res = await expectRefused(
			put(s.owner, s.first.id, { milestoneId: null, description: 'x'.repeat(50001) }),
			400
		);

		expect(res.body.message).toBe('Description too long (max 50000 chars)');
		expect(cardRow(s.first.id).milestoneId).toBe(s.current.id);
	});

	it('looks at the lengths before it looks for the milestone', async () => {
		const s = withGoals();

		// Both are wrong. The milestone's refusal used to be the answer, because
		// the milestone was dealt with first; now nothing is, until the body is
		// known to be sound.
		const res = await expectRefused(
			put(s.owner, s.first.id, { milestoneId: s.hidden.id, title: 'x'.repeat(501) }),
			400
		);

		expect(res.body.message).toBe('Title too long (max 500 chars)');
	});

	it('refuses a milestone the caller may not use, and writes none of the other fields', async () => {
		const s = withGoals();

		expect(
			(await expectRefused(put(s.owner, s.first.id, { title: 'Renamed', milestoneId: s.hidden.id }), 403)).body.message
		).toBe('No access to this milestone');
		expect(
			(await expectRefused(put(s.owner, s.first.id, { title: 'Renamed', milestoneId: 99999 }), 404)).body.message
		).toBe('Milestone not found');
		// The administrator may use it, but it is one board's and the card is on another.
		expect(
			(await expectRefused(put(s.admin, s.first.id, { title: 'Renamed', milestoneId: s.hidden.id }), 400)).body.message
		).toBe('That milestone belongs to a single board. Make it cross-board first, or move the card.');
		expect(cardRow(s.first.id)).toMatchObject({ title: 'First', milestoneId: s.current.id });
	});

	it('takes a card out of its milestone, and changes fields with no milestone sent', async () => {
		const s = withGoals();
		// Each change has a webhook to deliver: recorded, not sent.
		const sent = effects();

		try {
			const out = await put(s.owner, s.first.id, { milestoneId: null })();
			expect(out.status).toBe(200);
			expect(cardRow(s.first.id).milestoneId).toBeNull();

			const plain = await put(s.owner, s.second.id, { priority: 'critical' })();
			await sent.settle();
			expect(plain.status).toBe(200);
			expect(cardRow(s.second.id)).toMatchObject({ priority: 'critical', milestoneId: null });
		} finally {
			sent.restore();
		}
	});

	describe('restoring a card with archivedAt: null (card 2108, R2)', () => {
		const ARCHIVED_AT = '2026-10-01T09:00:00.000Z';
		const withArchived = () => {
			const s = scene();
			db.update(cards).set({ archivedAt: ARCHIVED_AT }).where(eq(cards.id, s.first.id)).run();
			return s;
		};

		it('records a restore as api:card_restored, and nothing else when nothing else changed', async () => {
			const run = await eachWriteInTurn({
				build: withArchived,
				request: ({ owner, first }) => put(owner, first.id, { archivedAt: null })(),
				afterSuccess: ({ owner, A, first }, res: ApiResult) => {
					expect(res.status).toBe(200);
					expect(res.body).toMatchObject({ id: first.id, archivedAt: null });
					expect(cardRow(first.id).archivedAt).toBeNull();
					// It was `api:card_updated`, "Updated fields: archivedAt".
					expect(entries()).toEqual([
						{
							boardId: A.board.id,
							cardId: first.id,
							userId: owner.id,
							action: 'api:card_restored',
							detail: '"First"',
							source: 'api'
						}
					]);
				}
			});

			// The restore and its entry, then the route's own write of the card.
			expect(shape(run.writes)).toEqual(['update cards set', 'insert into activity_log', 'update cards set']);
			// A restore has no webhook, by any route: no `card.updated` now.
			expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
		});

		it('records a restore with a new title as the restore and then the update', async () => {
			const run = await eachWriteInTurn({
				build: withArchived,
				request: ({ owner, first }) => put(owner, first.id, { archivedAt: null, title: 'Renamed' })(),
				afterSuccess: ({ owner, A, first }, res: ApiResult) => {
					expect(res.status).toBe(200);
					expect(cardRow(first.id)).toMatchObject({ archivedAt: null, title: 'Renamed' });
					const entry = { boardId: A.board.id, cardId: first.id, userId: owner.id, source: 'api' };
					expect(entries()).toEqual([
						{ ...entry, action: 'api:card_restored', detail: '"First"' },
						{ ...entry, action: 'api:card_updated', detail: 'Updated fields: title on "Renamed"' }
					]);
				}
			});

			expect(shape(run.writes)).toEqual([
				'update cards set',
				'insert into activity_log',
				'update cards set',
				'insert into activity_log'
			]);
			expect(run.effects.map(name)).toEqual(['event update (card) on board 1', 'webhook card.updated']);
		});

		it('names an archivedAt that changes nothing in the update, as before, and writes no restore', async () => {
			const s = withArchived();
			const sent = effects();

			try {
				// The stamp the card holds, sent back, with a title.
				const kept = await put(s.owner, s.first.id, { archivedAt: ARCHIVED_AT, title: 'Renamed' })();
				// `null` on a card that is not archived.
				const open = await put(s.owner, s.second.id, { archivedAt: null })();
				await sent.settle();

				expect([kept.status, open.status]).toEqual([200, 200]);
				expect(cardRow(s.first.id).archivedAt).toBe(ARCHIVED_AT);
				expect(entries().map((e) => `${e.cardId} ${e.action}: ${e.detail}`)).toEqual([
					`${s.first.id} api:card_updated: Updated fields: title, archivedAt on "Renamed"`,
					`${s.second.id} api:card_updated: Updated fields: archivedAt on "Second"`
				]);
			} finally {
				sent.restore();
			}
		});

		it('refuses to archive a card by a date, with nothing written (card 2117: archive with DELETE)', async () => {
			const s = scene();

			const res = await expectRefused(put(s.owner, s.first.id, { archivedAt: ARCHIVED_AT }), 400);

			expect(res.body.message).toBe(
				'archivedAt may only be null, which restores the card. Archive a card with DELETE /cards/{cardId}'
			);
		});
	});

	it('answers as it did for a caller who may not edit, a card that is not there and a body with nothing in it', async () => {
		const s = withGoals();
		const body = { title: 'Not mine to rename', milestoneId: s.goal.id };

		await expectRefused(put(null, s.first.id, body), 401);
		expect((await expectRefused(put(s.owner, 'abc', body), 400)).body.message).toBe('Invalid card ID');
		expect((await expectRefused(put(s.owner, 99999, body), 404)).body.message).toBe('Card not found');
		expect((await expectRefused(put(s.outsider, s.first.id, body), 403)).body.message).toBe(
			"No edit access to this card's board"
		);
		expect((await expectRefused(put(s.viewer, s.first.id, body), 403)).body.message).toBe(
			"No edit access to this card's board"
		);
		expect((await expectRefused(put(s.owner, s.first.id, {}), 400)).body.message).toBe('No valid fields to update');
		// Who may edit is settled before what was sent is looked at, as it was.
		await expectRefused(put(s.viewer, s.first.id, { title: 'x'.repeat(501) }), 403);
		await expectRefused(put(s.viewer, s.first.id, {}), 403);
	});
});

// ─── Boards ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/boards', () => {
	const post = (user: SessionUser | null, body: unknown) => () => api('POST', '/api/v1/boards', { user, body });

	it('makes the board, its four columns, its owner and its activity entry, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, first }) => post(owner, { name: '  Roadmap ', emoji: '🗺️', parentCardId: first.id })(),
			afterSuccess: ({ owner, first }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					name: 'Roadmap',
					emoji: '🗺️',
					parentCardId: first.id,
					createdBy: owner.id
				});
				const id = res.body.id;

				const titles = [
					{ boardId: id, title: 'To Do', position: 0 },
					{ boardId: id, title: 'On Hold', position: 1 },
					{ boardId: id, title: 'In Progress', position: 2 },
					{ boardId: id, title: 'Complete', position: 3 }
				];
				// The answer carries the columns, read in the transaction that made them.
				expect(
					res.body.columns.map((c: { boardId: number; title: string; position: number }) => ({
						boardId: c.boardId,
						title: c.title,
						position: c.position
					}))
				).toEqual(titles);
				expect(
					db
						.select({ boardId: columns.boardId, title: columns.title, position: columns.position })
						.from(columns)
						.where(eq(columns.boardId, id))
						.all()
				).toEqual(titles);
				expect(db.select({ name: boards.name }).from(boards).where(eq(boards.id, id)).all()).toEqual([
					{ name: 'Roadmap' }
				]);
				expect(
					db
						.select({ userId: boardMembers.userId, role: boardMembers.role })
						.from(boardMembers)
						.where(eq(boardMembers.boardId, id))
						.all()
				).toEqual([{ userId: owner.id, role: 'owner' }]);
				expect(entries()).toEqual([
					{
						boardId: id,
						cardId: null,
						userId: owner.id,
						action: 'api:board_created',
						detail: 'Created board "Roadmap"',
						source: 'api'
					}
				]);
			}
		});

		// A failure at the second of these used to leave a board with no columns,
		// at the third a board with no member who owned it, and at the fourth a
		// board nobody was recorded as having made.
		expect(shape(run.writes)).toEqual([
			'insert into boards',
			'insert into columns',
			'insert into board_members',
			'insert into activity_log'
		]);
		expect(run.effects).toEqual([]);
	});

	it('refuses a board with no name, and a parent card the caller may not edit, from inside the transaction', async () => {
		const s = scene();

		await expectRefused(post(null, { name: 'Roadmap' }), 401);
		expect((await expectRefused(post(s.owner, { name: '   ' }), 400)).body.message).toBe('name is required');
		expect((await expectRefused(post(s.owner, { name: 'x'.repeat(201) }), 400)).body.message).toBe(
			'Board name too long (max 200 chars)'
		);
		// The name is looked at before the parent card is looked for, as it was.
		expect((await expectRefused(post(s.owner, { name: '', parentCardId: 99999 }), 400)).body.message).toBe(
			'name is required'
		);
		expect((await expectRefused(post(s.owner, { name: 'Roadmap', parentCardId: 99999 }), 404)).body.message).toBe(
			'Parent card not found'
		);
		expect(
			(await expectRefused(post(s.outsider, { name: 'Roadmap', parentCardId: s.first.id }), 403)).body.message
		).toBe("No edit access to the parent card's board");
		await expectRefused(post(s.viewer, { name: 'Roadmap', parentCardId: s.first.id }), 403);
	});
});

describe('PUT /api/v1/boards/:boardId', () => {
	const put = (user: SessionUser | null, board: number | string, body: unknown) => () =>
		api('PUT', `/api/v1/boards/${board}`, { user, body });

	it('changes the board and writes its activity entry, or neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, A }) => put(owner, A.board.id, { name: '  Renamed ', emoji: '🚀' })(),
			afterSuccess: ({ owner, A }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: A.board.id, name: 'Renamed', emoji: '🚀' });
				expect(db.select().from(boards).where(eq(boards.id, A.board.id)).get()).toMatchObject({
					name: 'Renamed',
					emoji: '🚀'
				});
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: null,
						userId: owner.id,
						action: 'api:board_updated',
						detail: 'Updated board "Renamed" (fields: name, emoji)',
						source: 'api'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['update boards set', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update (board) on board 1']);
	});

	it('answers as it did for a caller who may not edit, a board that is not there and a body with nothing in it', async () => {
		const s = scene();

		await expectRefused(put(null, s.A.board.id, { name: 'Renamed' }), 401);
		expect((await expectRefused(put(s.owner, 'abc', { name: 'Renamed' }), 400)).body.message).toBe(
			'Invalid board ID'
		);
		expect((await expectRefused(put(s.viewer, s.A.board.id, { name: 'Renamed' }), 403)).body.message).toBe(
			'No edit access to this board'
		);
		await expectRefused(put(s.outsider, s.A.board.id, { name: 'Renamed' }), 403);
		// A board that is not there is 404 to everyone (card 2117, decision 10).
		// Only an administrator was told so: anyone else was answered 403.
		expect((await expectRefused(put(s.owner, 99999, { name: 'Renamed' }), 404)).body.message).toBe(
			'Board not found'
		);
		expect((await expectRefused(put(s.admin, 99999, { name: 'Renamed' }), 404)).body.message).toBe(
			'Board not found'
		);
		expect((await expectRefused(put(s.owner, s.A.board.id, { name: '  ' }), 400)).body.message).toBe(
			'name cannot be empty'
		);
		expect((await expectRefused(put(s.owner, s.A.board.id, {}), 400)).body.message).toBe(
			'No valid fields to update'
		);
		// Who may edit is settled before what was sent is looked at, as it was.
		await expectRefused(put(s.viewer, s.A.board.id, { name: '  ' }), 403);
	});
});

// ─── Cards ──────────────────────────────────────────────────────────────────

describe('POST /api/v1/boards/:boardId/cards', () => {
	const post = (user: SessionUser | null, board: number | string, body: unknown) => () =>
		api('POST', `/api/v1/boards/${board}/cards`, { user, body });

	it('makes the card and the entry that says who raised it, or neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, A }) =>
				post(owner, A.board.id, { columnId: A.cols['To Do'].id, title: '  Raised here ', priority: 'high' })(),
			afterSuccess: ({ owner, A }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ title: 'Raised here', priority: 'high', createdBy: owner.id });

				expect(cardRow(res.body.id)).toMatchObject({ columnId: A.cols['To Do'].id, title: 'Raised here' });
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: res.body.id,
						userId: owner.id,
						action: 'api:card_created',
						detail: 'Raised here',
						source: 'api'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into cards', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['webhook card.created', 'event update (card) on board 1']);
	});

	it('answers as it did for a caller who may not edit, a column on another board and a card with no title', async () => {
		const s = scene();
		const column = s.A.cols['To Do'].id;

		await expectRefused(post(null, s.A.board.id, { columnId: column, title: 'Not mine to raise' }), 401);
		expect(
			(await expectRefused(post(s.owner, 'abc', { columnId: column, title: 'Raised' }), 400)).body.message
		).toBe('Invalid board ID');
		expect(
			(await expectRefused(post(s.viewer, s.A.board.id, { columnId: column, title: 'Raised' }), 403)).body.message
		).toBe('No edit access to this board');
		await expectRefused(post(s.outsider, s.A.board.id, { columnId: column, title: 'Raised' }), 403);
		expect((await expectRefused(post(s.owner, s.A.board.id, { title: 'Raised' }), 400)).body.message).toBe(
			'columnId is required'
		);
		expect((await expectRefused(post(s.owner, s.A.board.id, { columnId: column }), 400)).body.message).toBe(
			'title is required'
		);
		expect(
			(await expectRefused(post(s.owner, s.A.board.id, { columnId: column, title: 'x'.repeat(501) }), 400)).body
				.message
		).toBe('Title too long (max 500 chars)');
		// The administrator may edit both boards, so this is refused for the column alone.
		expect(
			(
				await expectRefused(
					post(s.admin, s.A.board.id, { columnId: s.B.cols['To Do'].id, title: 'Raised' }),
					400
				)
			).body.message
		).toBe('Column does not belong to this board');
		// Who may edit is settled before what was sent is looked at, as it was.
		await expectRefused(post(s.viewer, s.A.board.id, {}), 403);
	});
});

// ─── Subtasks ───────────────────────────────────────────────────────────────

describe('POST /api/v1/cards/:cardId/subtasks', () => {
	const post = (user: SessionUser | null, card: number | string, body: unknown) => () =>
		api('POST', `/api/v1/cards/${card}/subtasks`, { user, body });

	it('makes the subtask and its activity entry, or neither', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, first }) => post(owner, first.id, { title: '  Write the tests ', priority: 'high' })(),
			afterSuccess: ({ owner, A, first }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({ cardId: first.id, title: 'Write the tests', priority: 'high', position: 0 });
				expect(db.select({ cardId: subtasks.cardId, title: subtasks.title }).from(subtasks).all()).toEqual([
					{ cardId: first.id, title: 'Write the tests' }
				]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'api:subtask_created',
						detail: 'Created subtask "Write the tests" on "First"',
						source: 'api'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into subtasks', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
	});

	it('answers as it did for a caller who may not edit, a card that is not there and a subtask with no title', async () => {
		const s = scene();

		await expectRefused(post(null, s.first.id, { title: 'Not mine to add' }), 401);
		expect((await expectRefused(post(s.owner, 'abc', { title: 'A step' }), 400)).body.message).toBe(
			'Invalid card ID'
		);
		expect((await expectRefused(post(s.owner, 99999, { title: 'A step' }), 404)).body.message).toBe(
			'Card not found'
		);
		expect((await expectRefused(post(s.viewer, s.first.id, { title: 'A step' }), 403)).body.message).toBe(
			"No edit access to this card's board"
		);
		await expectRefused(post(s.outsider, s.first.id, { title: 'A step' }), 403);
		expect((await expectRefused(post(s.owner, s.first.id, { title: '  ' }), 400)).body.message).toBe(
			'title is required'
		);
		expect((await expectRefused(post(s.owner, s.first.id, { title: 'x'.repeat(501) }), 400)).body.message).toBe(
			'Title too long (max 500 chars)'
		);
		// Who may edit is settled before what was sent is looked at, as it was.
		await expectRefused(post(s.viewer, s.first.id, {}), 403);
	});
});

// ─── Assignees ──────────────────────────────────────────────────────────────

describe('/api/v1/cards/:cardId/assignees', () => {
	const assigned = () =>
		db.select({ cardId: cardAssignees.cardId, userId: cardAssignees.userId }).from(cardAssignees).all();

	describe('POST', () => {
		const post = (user: SessionUser | null, card: number | string, body: unknown) => () =>
			api('POST', `/api/v1/cards/${card}/assignees`, { user, body });

		it('assigns the user and writes the activity entry, or neither, and tells nobody until it is saved', async () => {
			const run = await eachWriteInTurn({
				build: scene,
				request: ({ owner, viewer, first }) => post(owner, first.id, { userId: viewer.id })(),
				afterSuccess: ({ owner, viewer, A, first }, res: ApiResult) => {
					expect(res.status).toBe(200);
					expect(res.body).toEqual({ success: true, message: 'User assigned' });
					expect(assigned()).toEqual([{ cardId: first.id, userId: viewer.id }]);
					expect(entries()).toEqual([
						{
							boardId: A.board.id,
							cardId: first.id,
							userId: owner.id,
							action: 'api:assignee_added',
							detail: 'Assigned viewer to "First"',
							source: 'api'
						}
					]);
				}
			});

			expect(shape(run.writes)).toEqual(['insert into card_assignees', 'insert into activity_log']);
			// The mail used to be sent as soon as the assignee was written, before
			// the entry was.
			expect(run.effects.map(name)).toEqual([
				'email to viewer@example.test: Assigned: First',
				'event update (card) on board 1'
			]);
		});

		it('writes nothing for a user who is already assigned, and says so', async () => {
			const s = scene();
			assignCard(s.first, s.viewer);
			const before = snapshotDb();
			const sent = effects();

			try {
				const res = await post(s.owner, s.first.id, { userId: s.viewer.id })();
				await sent.settle();

				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true, message: 'User already assigned' });
				expectUnchanged(before);
				// The board is still told to refresh, as it was. Nobody is mailed.
				expect(sent.all.map(name)).toEqual(['event update (card) on board 1']);
			} finally {
				sent.restore();
			}
		});

		it('answers as it did for a caller who may not edit, a user who is not there and one with no access to the board', async () => {
			const s = scene();

			await expectRefused(post(null, s.first.id, { userId: s.viewer.id }), 401);
			expect((await expectRefused(post(s.owner, 'abc', { userId: s.viewer.id }), 400)).body.message).toBe(
				'Invalid card ID'
			);
			expect((await expectRefused(post(s.owner, 99999, { userId: s.viewer.id }), 404)).body.message).toBe(
				'Card not found'
			);
			expect((await expectRefused(post(s.viewer, s.first.id, { userId: s.viewer.id }), 403)).body.message).toBe(
				"No edit access to this card's board"
			);
			await expectRefused(post(s.outsider, s.first.id, { userId: s.outsider.id }), 403);
			expect((await expectRefused(post(s.owner, s.first.id, {}), 400)).body.message).toBe('userId is required');
			expect((await expectRefused(post(s.owner, s.first.id, { userId: 99999 }), 404)).body.message).toBe(
				'User not found'
			);
			expect((await expectRefused(post(s.owner, s.first.id, { userId: s.outsider.id }), 400)).body.message).toBe(
				'User does not have access to this board'
			);
			// Who may edit is settled before what was sent is looked at, as it was.
			await expectRefused(post(s.viewer, s.first.id, {}), 403);
		});
	});

	describe('DELETE', () => {
		const withAssignee = () => {
			const s = scene();
			assignCard(s.first, s.viewer);
			return s;
		};

		const del = (user: SessionUser | null, card: number | string, body: unknown) => () =>
			api('DELETE', `/api/v1/cards/${card}/assignees`, { user, body });

		it('removes the assignee and writes the activity entry, or neither', async () => {
			const run = await eachWriteInTurn({
				build: withAssignee,
				request: ({ owner, viewer, first }) => del(owner, first.id, { userId: viewer.id })(),
				afterSuccess: ({ owner, A, first }, res: ApiResult) => {
					expect(res.status).toBe(200);
					expect(res.body).toEqual({ success: true });
					expect(assigned()).toEqual([]);
					expect(entries()).toEqual([
						{
							boardId: A.board.id,
							cardId: first.id,
							userId: owner.id,
							action: 'api:assignee_removed',
							detail: 'Removed viewer from "First"',
							source: 'api'
						}
					]);
				}
			});

			expect(shape(run.writes)).toEqual(['delete from card_assignees', 'insert into activity_log']);
			expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
		});

		it('answers as it did for a caller who may not edit, a card that is not there and no user named', async () => {
			const s = withAssignee();

			await expectRefused(del(null, s.first.id, { userId: s.viewer.id }), 401);
			expect((await expectRefused(del(s.owner, 'abc', { userId: s.viewer.id }), 400)).body.message).toBe(
				'Invalid card ID'
			);
			expect((await expectRefused(del(s.owner, 99999, { userId: s.viewer.id }), 404)).body.message).toBe(
				'Card not found'
			);
			expect((await expectRefused(del(s.viewer, s.first.id, { userId: s.viewer.id }), 403)).body.message).toBe(
				'No edit access'
			);
			await expectRefused(del(s.outsider, s.first.id, { userId: s.viewer.id }), 403);
			expect((await expectRefused(del(s.owner, s.first.id, {}), 400)).body.message).toBe('userId is required');
			expect(assigned()).toEqual([{ cardId: s.first.id, userId: s.viewer.id }]);
		});

		it('records nothing and tells nobody when the user named is not assigned', async () => {
			const s = withAssignee();

			// It wrote `api:assignee_removed` and told the board, for a removal
			// that removed nobody (card 2108, decision 8). Answered 404 by card 2117.
			const res = await expectRefused(del(s.owner, s.first.id, { userId: s.owner.id }), 404);

			expect(res.body.message).toBe('User is not assigned to this card');
			expect(entries()).toEqual([]);
		});
	});
});

// ─── Dependencies ───────────────────────────────────────────────────────────

describe('/api/v1/cards/:cardId/dependencies', () => {
	const links = () =>
		db
			.select({
				blockedType: workDependencies.blockedType,
				blockedId: workDependencies.blockedId,
				blockerType: workDependencies.blockerType,
				blockerId: workDependencies.blockerId,
				createdByUserId: workDependencies.createdByUserId
			})
			.from(workDependencies)
			.all();

	describe('POST', () => {
		const post = (user: SessionUser | null, card: number | string, body: unknown) => () =>
			api('POST', `/api/v1/cards/${card}/dependencies`, { user, body });

		it('records the dependency and its activity entry, or neither', async () => {
			const run = await eachWriteInTurn({
				build: scene,
				request: ({ owner, first, second }) => post(owner, first.id, { dependsOnCardId: second.id })(),
				afterSuccess: ({ owner, A, first, second }, res: ApiResult) => {
					expect(res.status).toBe(201);
					expect(res.body).toEqual({
						blocked: { kind: 'card', id: first.id },
						blocker: { kind: 'card', id: second.id },
						// Read in the transaction that wrote the link.
						isBlocked: true
					});
					expect(links()).toEqual([
						{
							blockedType: 'card',
							blockedId: first.id,
							blockerType: 'card',
							blockerId: second.id,
							createdByUserId: owner.id
						}
					]);
					expect(entries()).toEqual([
						{
							boardId: A.board.id,
							cardId: first.id,
							userId: owner.id,
							action: 'api:dependency_added',
							detail: `#${first.id} now waits on #${second.id}`,
							source: 'api'
						}
					]);
				}
			});

			// A failure at the second used to leave a dependency nobody was
			// recorded as having added.
			expect(shape(run.writes)).toEqual(['insert or ignore', 'insert into activity_log']);
			expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
		});

		it('tells both boards when the dependency crosses from one to the other', async () => {
			const s = scene();
			const sent = effects();

			try {
				const res = await post(s.admin, s.first.id, { blocksCardId: s.far.id })();
				await sent.settle();

				expect(res.status).toBe(201);
				expect(res.body).toEqual({
					blocked: { kind: 'card', id: s.far.id },
					blocker: { kind: 'card', id: s.first.id },
					isBlocked: false
				});
				expect(sent.duringTransaction).toEqual([]);
				expect(sent.all.map(name)).toEqual([
					'event update (card) on board 1',
					'event update (card) on board 2'
				]);
			} finally {
				sent.restore();
			}
		});

		it('answers 409 for a dependency that would close a loop, with the loop, and writes nothing', async () => {
			const s = scene();
			makeDependency({ blocked: s.first, blocker: s.second });

			// `second` would wait on `first`, which already waits on `second`.
			const res = await expectRefused(post(s.owner, s.first.id, { blocksCardId: s.second.id }), 409);

			expect(res.body.message).toBe(
				`#${s.second.id} waiting on #${s.first.id} would create a cycle: #${s.second.id} → #${s.first.id} → #${s.second.id}`
			);
			expect(res.body.cycle).toBeDefined();
			expect(typeof res.body.message).toBe('string');
			expect(links()).toHaveLength(1);
		});

		it('answers as it did for a caller who may not edit either end, an end that is not there and a link already made', async () => {
			const s = scene();
			makeDependency({ blocked: s.first, blocker: s.second });

			await expectRefused(post(null, s.first.id, { dependsOnCardId: s.second.id }), 401);
			expect((await expectRefused(post(s.owner, 'abc', { dependsOnCardId: s.second.id }), 400)).body.message).toBe(
				'Invalid card ID'
			);
			expect((await expectRefused(post(s.owner, 99999, { dependsOnCardId: s.second.id }), 404)).body.message).toBe(
				'Card not found'
			);
			expect(
				(await expectRefused(post(s.viewer, s.first.id, { dependsOnCardId: s.second.id }), 403)).body.message
			).toBe("No edit access to this card's board");
			await expectRefused(post(s.outsider, s.first.id, { dependsOnCardId: s.far.id }), 403);
			expect((await expectRefused(post(s.owner, s.first.id, {}), 400)).body.message).toBe(
				'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)'
			);
			expect(
				(
					await expectRefused(
						post(s.owner, s.first.id, { dependsOnCardId: s.second.id, blocksCardId: s.second.id }),
						400
					)
				).body.message
			).toBe('Provide only one of the dependsOn*/blocks* fields');
			expect((await expectRefused(post(s.owner, s.first.id, { dependsOnCardId: 99999 }), 404)).body.message).toBe(
				'#99999 not found'
			);
			expect(
				(await expectRefused(post(s.owner, s.first.id, { dependsOnCardId: s.far.id }), 403)).body.message
			).toBe(`No edit access to the board holding #${s.far.id}`);
			expect(
				(await expectRefused(post(s.owner, s.first.id, { dependsOnCardId: s.second.id }), 409)).body.message
			).toBe('That dependency already exists');
			// Who may edit is settled before what was sent is looked at, as it was.
			await expectRefused(post(s.viewer, s.first.id, {}), 403);
		});
	});

	describe('DELETE', () => {
		const withLink = () => {
			const s = scene();
			makeDependency({ blocked: s.first, blocker: s.second, createdBy: s.owner });
			return s;
		};

		const del = (user: SessionUser | null, card: number | string, body: unknown) => () =>
			api('DELETE', `/api/v1/cards/${card}/dependencies`, { user, body });

		it('removes the dependency and writes the activity entry, or neither', async () => {
			const run = await eachWriteInTurn({
				build: withLink,
				// Named from the other end: `first` waits on `second`.
				request: ({ owner, first, second }) => del(owner, second.id, { blocksCardId: first.id })(),
				afterSuccess: ({ owner, A, first, second }, res: ApiResult) => {
					expect(res.status).toBe(200);
					expect(res.body).toEqual({ success: true, removed: 1 });
					expect(links()).toEqual([]);
					expect(entries()).toEqual([
						{
							boardId: A.board.id,
							cardId: second.id,
							userId: owner.id,
							action: 'api:dependency_removed',
							detail: `#${first.id} no longer waits on #${second.id}`,
							source: 'api'
						}
					]);
				}
			});

			// A failure at the second used to leave the link gone with nothing to
			// say who removed it.
			expect(shape(run.writes)).toEqual(['delete from work_dependencies', 'insert into activity_log']);
			expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
		});

		it('answers as it did for a caller who may not edit, a card that is not there and a link that is not there', async () => {
			const s = withLink();

			await expectRefused(del(null, s.first.id, { dependsOnCardId: s.second.id }), 401);
			expect((await expectRefused(del(s.owner, 'abc', { dependsOnCardId: s.second.id }), 400)).body.message).toBe(
				'Invalid card ID'
			);
			expect((await expectRefused(del(s.owner, 99999, { dependsOnCardId: s.second.id }), 404)).body.message).toBe(
				'Card not found'
			);
			// The one answer that is not as it was: who may remove a link is now
			// asked of the board of the end that waits, by one rule for all four
			// routes, and the refusal names that end. Here it is the card in the path.
			expect(
				(await expectRefused(del(s.viewer, s.first.id, { dependsOnCardId: s.second.id }), 403)).body.message
			).toBe(`No edit access to the board holding #${s.first.id}, the end that waits`);
			await expectRefused(del(s.outsider, s.first.id, { dependsOnCardId: s.second.id }), 403);
			expect((await expectRefused(del(s.owner, s.first.id, {}), 400)).body.message).toBe(
				'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)'
			);
			// The link the other way round is not there.
			expect((await expectRefused(del(s.owner, s.first.id, { blocksCardId: s.second.id }), 404)).body.message).toBe(
				'Dependency not found'
			);
			expect(links()).toHaveLength(1);
		});
	});
});

// ─── Comments ───────────────────────────────────────────────────────────────

describe('POST /api/v1/cards/:cardId/comments', () => {
	/**
	 * Somebody to tell about each thing a comment tells people about: a member
	 * of the board, a user mentioned in it, and the person outside who asked
	 * for the card's work.
	 */
	const withReaders = () => {
		const s = scene();
		const member = makeUser({ username: 'member' });
		const mentioned = makeUser({ username: 'mentioned' });
		addBoardMember(s.A.board, member, 'editor');
		db.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: s.owner.id,
				requesterName: 'Rita',
				requesterEmail: 'rita@example.test',
				title: 'Please build this',
				status: 'accepted',
				accessToken: 'a'.repeat(64),
				resolvedBy: s.owner.id,
				resolvedCardId: s.first.id
			})
			.run();
		return { ...s, member, mentioned };
	};

	const post = (user: SessionUser | null, card: number | string, content: unknown) => () =>
		api('POST', `/api/v1/cards/${card}/comments`, { user, body: { content } });

	it('writes the comment and its activity entry, or neither, and tells nobody until it is saved', async () => {
		const run = await eachWriteInTurn({
			build: withReaders,
			request: ({ owner, first }) => post(owner, first.id, '  Over to you, @mentioned  ')(),
			afterSuccess: ({ owner, A, first }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					cardId: first.id,
					userId: owner.id,
					content: 'Over to you, @mentioned',
					username: 'owner',
					userEmoji: '👤'
				});
				expect(
					db
						.select({ cardId: cardComments.cardId, userId: cardComments.userId, content: cardComments.content })
						.from(cardComments)
						.all()
				).toEqual([{ cardId: first.id, userId: owner.id, content: 'Over to you, @mentioned' }]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'api:comment_added',
						detail: 'Commented on "First"',
						source: 'api'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into card_comments', 'insert into activity_log']);
		// The board's other members, the viewer among them; the user mentioned;
		// the requester; and the webhook. The mail used to be sent as soon as the
		// comment was written, before its entry was.
		expect(run.effects.map(name)).toEqual([
			'email to viewer@example.test: New comment on: First',
			'email to member@example.test: New comment on: First',
			'email to mentioned@example.test: owner mentioned you: First',
			'email to rita@example.test: New comment on your request: Please build this',
			'webhook comment.added'
		]);
	});

	it('answers an empty comment, a card that is not there and a caller who may only look, the card first', async () => {
		const s = withReaders();

		// The card is looked for, and the caller checked, before what was sent
		// is looked at (card 2117, R1). Nothing to say was refused first, with
		// 400, for a card that was not there and to a caller who may only look.
		expect((await expectRefused(post(s.owner, 99999, '   '), 404)).body.message).toBe('Card not found');
		expect((await expectRefused(post(s.viewer, s.first.id, '   '), 403)).body.message).toBe('No edit access');
		expect((await expectRefused(post(s.owner, s.first.id, '   '), 400)).body.message).toBe('Comment cannot be empty');
		expect((await expectRefused(post(s.owner, 99999, 'Hello'), 404)).body.message).toBe('Card not found');
		expect((await expectRefused(post(s.viewer, s.first.id, 'Hello'), 403)).body.message).toBe('No edit access');
		expect((await expectRefused(post(s.outsider, s.first.id, 'Hello'), 403)).body.message).toBe('No edit access');
		await expectRefused(post(null, s.first.id, 'Hello'), 401);
	});
});

describe('PUT /api/v1/comments/:commentId', () => {
	const withComment = () => {
		const s = scene();
		const comment = makeComment(s.first, s.owner, 'Original');
		return { ...s, comment };
	};

	const put = (user: SessionUser | null, comment: number | string, content: unknown) => () =>
		api('PUT', `/api/v1/comments/${comment}`, { user, body: { content } });

	const stored = () => db.select({ id: cardComments.id, content: cardComments.content }).from(cardComments).all();

	it('changes the comment and writes its activity entry, or neither', async () => {
		const run = await eachWriteInTurn({
			build: withComment,
			request: ({ owner, comment }) => put(owner, comment.id, '  Edited  ')(),
			afterSuccess: ({ owner, A, first, comment }, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({
					id: comment.id,
					cardId: first.id,
					userId: owner.id,
					content: 'Edited',
					username: 'owner',
					userEmoji: '👤'
				});
				expect(stored()).toEqual([{ id: comment.id, content: 'Edited' }]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: first.id,
						userId: owner.id,
						action: 'api:comment_edited',
						detail: 'Edited a comment on "First"',
						source: 'api'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['update card_comments set', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
	});

	it('lets an administrator edit a comment somebody else wrote', async () => {
		const s = withComment();

		const res = await put(s.admin, s.comment.id, 'Tidied')();

		expect(res.status).toBe(200);
		// Still shown as its author's.
		expect(res.body).toMatchObject({ content: 'Tidied', userId: s.owner.id, username: 'owner' });
	});

	it('answers as it did for an empty comment, a comment that is not there and one somebody else wrote', async () => {
		const s = withComment();

		await expectRefused(put(null, s.comment.id, 'Edited'), 401);
		expect((await expectRefused(put(s.owner, 'abc', 'Edited'), 400)).body.message).toBe('Invalid comment ID');
		// The comment is looked for before what was sent is looked at (card 2117,
		// R1): what was sent was looked at first, and this was 400.
		expect((await expectRefused(put(s.owner, 99999, '   '), 404)).body.message).toBe('Comment not found');
		expect((await expectRefused(put(s.owner, s.comment.id, '   '), 400)).body.message).toBe('Comment cannot be empty');
		expect((await expectRefused(put(s.owner, s.comment.id, 'x'.repeat(50001)), 400)).body.message).toBe(
			'Comment too long (max 50000 chars)'
		);
		expect((await expectRefused(put(s.owner, 99999, 'Edited'), 404)).body.message).toBe('Comment not found');
		// One answer that is not as it was: changing a comment asks for edit
		// access to its board, as posting one does, and asks it before whose
		// comment it is. A viewer used to be told that it was not theirs.
		expect((await expectRefused(put(s.viewer, s.comment.id, 'Edited'), 403)).body.message).toBe(
			'No edit access to this board'
		);
		const editor = makeUser({ username: 'editor' });
		addBoardMember(s.A.board, editor, 'editor');
		expect((await expectRefused(put(editor, s.comment.id, 'Edited'), 403)).body.message).toBe(
			'You can only edit your own comments'
		);
		await expectRefused(put(s.outsider, s.comment.id, 'Edited'), 403);
		expect(stored()).toEqual([{ id: s.comment.id, content: 'Original' }]);
	});
});

// ─── Milestones ─────────────────────────────────────────────────────────────

describe('POST /api/v1/milestones', () => {
	const post = (user: SessionUser | null, body: unknown) => () => api('POST', '/api/v1/milestones', { user, body });

	const goals = () =>
		db
			.select({ name: milestones.name, boardId: milestones.boardId, createdBy: milestones.createdBy })
			.from(milestones)
			.all();

	it("makes a board's milestone and its activity entry, or neither", async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, A }) =>
				post(owner, { name: '  Ship it ', boardId: A.board.id, description: 'The release', targetDate: '2026-12-01' })(),
			afterSuccess: ({ owner, A }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					name: 'Ship it',
					boardId: A.board.id,
					description: 'The release',
					targetDate: '2026-12-01',
					createdBy: owner.id
				});
				expect(goals()).toEqual([{ name: 'Ship it', boardId: A.board.id, createdBy: owner.id }]);
				expect(entries()).toEqual([
					{
						boardId: A.board.id,
						cardId: null,
						userId: owner.id,
						action: 'api:milestone_created',
						detail: 'Created milestone "Ship it"',
						source: 'api'
					}
				]);
			}
		});

		// A failure at the second used to leave a milestone nobody was recorded
		// as having made.
		expect(shape(run.writes)).toEqual(['insert into milestones', 'insert into activity_log']);
		expect(run.effects).toEqual([]);
	});

	it('makes a milestone that belongs to no board with one write, and no entry: there is no board to file it under', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner }) => post(owner, { name: 'Everything' })(),
			afterSuccess: ({ owner }, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(goals()).toEqual([{ name: 'Everything', boardId: null, createdBy: owner.id }]);
				expect(entries()).toEqual([]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into milestones']);
		expect(run.effects).toEqual([]);
	});

	it('answers as it did for a milestone with no name, a board that is not there and a caller who may not edit it', async () => {
		const s = scene();

		await expectRefused(post(null, { name: 'Ship it' }), 401);
		expect((await expectRefused(post(s.owner, { name: '  ', boardId: s.A.board.id }), 400)).body.message).toBe(
			'name is required'
		);
		expect((await expectRefused(post(s.owner, { name: 'Ship it', boardId: 99999 }), 404)).body.message).toBe(
			'Board not found'
		);
		expect((await expectRefused(post(s.viewer, { name: 'Ship it', boardId: s.A.board.id }), 403)).body.message).toBe(
			'No edit access to that board'
		);
		await expectRefused(post(s.outsider, { name: 'Ship it', boardId: s.A.board.id }), 403);
	});
});

// ─── Where the checks are made ──────────────────────────────────────────────

describe('each of these reads what it checks inside the transaction that writes', () => {
	/**
	 * Every path here used to look its card, board or comment up, and check
	 * the caller against it, and only then await the body: by the time it
	 * wrote, another request could have moved or deleted what it had checked.
	 *
	 * For each, the table its check reads, and a request that succeeds. Every
	 * read of that table the request makes must be inside a transaction, and
	 * there must be at least one.
	 */
	type Case = {
		route: string;
		table: string;
		status: number;
		/** Rows the request needs that the scene does not have. */
		prepare?: (s: Scene) => void;
		request: (s: Scene) => Promise<ApiResult>;
	};

	const cases: Case[] = [
		{
			route: 'PUT /api/v1/cards/:cardId',
			table: 'cards',
			status: 200,
			request: (s) => api('PUT', `/api/v1/cards/${s.first.id}`, { user: s.owner, body: { title: 'Renamed' } })
		},
		{
			route: 'POST /api/v1/boards',
			table: 'cards',
			status: 201,
			request: (s) =>
				api('POST', '/api/v1/boards', { user: s.owner, body: { name: 'Roadmap', parentCardId: s.first.id } })
		},
		{
			route: 'PUT /api/v1/boards/:boardId',
			table: 'boards',
			status: 200,
			request: (s) => api('PUT', `/api/v1/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed' } })
		},
		{
			route: 'POST /api/v1/boards/:boardId/cards',
			table: 'boards',
			status: 201,
			request: (s) =>
				api('POST', `/api/v1/boards/${s.A.board.id}/cards`, {
					user: s.owner,
					body: { columnId: s.A.cols['To Do'].id, title: 'Raised here' }
				})
		},
		{
			route: 'POST /api/v1/cards/:cardId/subtasks',
			table: 'cards',
			status: 201,
			request: (s) => api('POST', `/api/v1/cards/${s.first.id}/subtasks`, { user: s.owner, body: { title: 'A step' } })
		},
		{
			route: 'POST /api/v1/cards/:cardId/assignees',
			table: 'cards',
			status: 200,
			request: (s) =>
				api('POST', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.viewer.id } })
		},
		{
			route: 'DELETE /api/v1/cards/:cardId/assignees',
			table: 'cards',
			status: 200,
			prepare: (s) => assignCard(s.first, s.viewer),
			request: (s) =>
				api('DELETE', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.viewer.id } })
		},
		{
			route: 'POST /api/v1/cards/:cardId/dependencies',
			table: 'cards',
			status: 201,
			request: (s) =>
				api('POST', `/api/v1/cards/${s.first.id}/dependencies`, {
					user: s.owner,
					body: { dependsOnCardId: s.second.id }
				})
		},
		{
			route: 'DELETE /api/v1/cards/:cardId/dependencies',
			table: 'cards',
			status: 200,
			prepare: (s) => void makeDependency({ blocked: s.first, blocker: s.second }),
			request: (s) =>
				api('DELETE', `/api/v1/cards/${s.first.id}/dependencies`, {
					user: s.owner,
					body: { dependsOnCardId: s.second.id }
				})
		},
		{
			route: 'POST /api/v1/cards/:cardId/comments',
			table: 'cards',
			status: 201,
			request: (s) => api('POST', `/api/v1/cards/${s.first.id}/comments`, { user: s.owner, body: { content: 'Hello' } })
		},
		{
			route: 'PUT /api/v1/comments/:commentId',
			table: 'card_comments',
			status: 200,
			prepare: (s) => void makeComment(s.first, s.owner, 'Original'),
			// The only comment there is, so it is comment 1.
			request: (s) => api('PUT', '/api/v1/comments/1', { user: s.owner, body: { content: 'Edited' } })
		},
		{
			route: 'POST /api/v1/milestones',
			table: 'boards',
			status: 201,
			request: (s) => api('POST', '/api/v1/milestones', { user: s.owner, body: { name: 'Ship it', boardId: s.A.board.id } })
		}
	];

	for (const c of cases) {
		it(`${c.route} (${c.table})`, async () => {
			const s = scene();
			c.prepare?.(s);
			const sent = effects();
			// Installed last: it counts every read of the table from here on.
			const reads = watchReads(c.table);

			let res: ApiResult;
			try {
				res = await c.request(s);
			} finally {
				reads.restore();
				sent.restore();
			}

			expect(res.status).toBe(c.status);
			expect(reads.inTransaction.length).toBeGreaterThan(0);
			expect(reads.inTransaction).toEqual(reads.inTransaction.map(() => true));
		});
	}
});
