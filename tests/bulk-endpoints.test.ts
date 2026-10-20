/**
 * The endpoints that write to many rows in one request are all or nothing.
 *
 * Each of these wrote its rows one statement at a time with nothing around
 * them, or checked the request outside the transaction that then wrote it. A
 * failure part of the way left the columns of a board half reordered, or a
 * milestone half attached under a contract that says nothing was written.
 *
 * Every test here uses `eachWriteInTurn`, which makes the request once to
 * count its writes and then once more for each of them, with that write
 * failing, and checks every time that not one row changed and nothing was
 * sent. It also checks, on the run that succeeds, that nothing was sent while
 * the transaction was still open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	activityLog,
	cards,
	categories,
	columns,
	tokenUsage,
	userXp,
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
	makeDependency,
	makeMilestone,
	makeSmtp,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
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

/** Every activity entry, in the order written. */
const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			action: activityLog.action,
			source: activityLog.source,
			detail: activityLog.detail
		})
		.from(activityLog)
		.all();

const milestoneOf = (card: Card) =>
	db.select({ milestoneId: cards.milestoneId }).from(cards).where(eq(cards.id, card.id)).get()!.milestoneId;

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
	outsider: SessionUser;
	A: BoardFixture;
	/** Nobody but `outsider` may edit it. */
	B: BoardFixture;
	/** Four cards on A, and one on B. */
	a: Card[];
	b: Card;
};

function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const outsider = makeUser({ username: 'outsider' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner: outsider, name: 'B' });
	makeWebhook(A.board);
	const a = [0, 1, 2, 3].map((i) => makeCard(A.cols['To Do'], { title: `A${i + 1}`, position: i }));
	const b = makeCard(B.cols['To Do'], { title: 'B1' });
	return { owner, admin, outsider, A, B, a, b };
}

// ─── Columns ────────────────────────────────────────────────────────────────

describe('PUT /api/columns/reorder', () => {
	const TITLES = ['To Do', 'On Hold', 'In Progress', 'Complete'];

	/** Turn the board round: the last column first. */
	const reversed = (s: Scene) =>
		TITLES.map((title, i) => ({ id: s.A.cols[title].id, position: TITLES.length - 1 - i }));

	const positions = (board: BoardFixture) =>
		Object.fromEntries(
			db
				.select({ title: columns.title, position: columns.position })
				.from(columns)
				.where(eq(columns.boardId, board.board.id))
				.all()
				.map((c) => [c.title, c.position])
		);

	it('gives every column its new position, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => api('PUT', '/api/columns/reorder', { user: s.owner, body: { updates: reversed(s) } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(positions(s.A)).toEqual({ 'To Do': 3, 'On Hold': 2, 'In Progress': 1, Complete: 0 });
			}
		});

		// One write for each column. A failure at the third used to leave the
		// first two moved and the board in an order nobody had asked for.
		expect(shape(run.writes)).toEqual(Array(4).fill('update columns set'));
		// The board is told once, after the last of them.
		expect(run.effects.map(name)).toEqual(['event update (column) on board 1']);
	});

	it('refuses the whole reorder for one column the caller may not edit, from inside the transaction', async () => {
		const s = scene();
		const updates = [...reversed(s), { id: s.B.cols['To Do'].id, position: 9 }];

		await expectRefused(() => api('PUT', '/api/columns/reorder', { user: s.owner, body: { updates } }), 403);
		expect(positions(s.A)).toEqual({ 'To Do': 0, 'On Hold': 1, 'In Progress': 2, Complete: 3 });
	});

	it('refuses the whole reorder for one column that is not there', async () => {
		const s = scene();
		const updates = [...reversed(s), { id: 99999, position: 9 }];

		await expectRefused(() => api('PUT', '/api/columns/reorder', { user: s.owner, body: { updates } }), 404);
	});
});

// ─── Milestones ─────────────────────────────────────────────────────────────

describe('POST /api/v1/milestones/:milestoneId/cards/bulk', () => {
	/** An empty goal on board A, and another that already holds the third card. */
	const withGoals = () => {
		const s = scene();
		makeSmtp();
		const goal = makeMilestone({ board: s.A.board, name: 'Goal', createdBy: s.owner });
		const other = makeMilestone({ board: s.A.board, name: 'Other goal', cards: [s.a[2]] });
		return { ...s, goal, other };
	};

	it('attaches every card, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: withGoals,
			request: (s) =>
				api('POST', `/api/v1/milestones/${s.goal.id}/cards/bulk`, {
					user: s.owner,
					body: { cardIds: s.a.slice(0, 3).map((c) => c.id) }
				}),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					milestoneId: s.goal.id,
					attached: 3,
					skippedAlreadyIn: 0,
					movedFromOtherGoal: [{ cardId: s.a[2].id, title: 'A3', fromMilestoneId: s.other.id }],
					boardsTouched: [s.A.board.id]
				});
				expect(s.a.map(milestoneOf)).toEqual([s.goal.id, s.goal.id, s.goal.id, null]);
			}
		});

		// One write for each card. The contract says a batch that is rejected
		// wrote nothing; a batch that failed part of the way had written some.
		expect(shape(run.writes)).toEqual(Array(3).fill('update cards set'));
		// The goal was empty, so this is when the plan came to be. The mail is
		// worked out and sent once the cards are committed.
		expect(run.effects.map(name)).toEqual([
			'event update (card) on board 1',
			'email to admin@example.test: Plan created: Goal'
		]);
	});

	it('rejects the whole batch for one card that cannot be attached, and says which', async () => {
		const s = withGoals();
		const cardIds = [s.a[0].id, s.b.id, 99999];

		const res = await expectRefused(
			() => api('POST', `/api/v1/milestones/${s.goal.id}/cards/bulk`, { user: s.owner, body: { cardIds } }),
			409
		);

		expect(res.body).toEqual({
			message: 'Batch rejected — nothing was written',
			attached: 0,
			problems: [
				{ cardId: s.b.id, reason: `No edit access to the board holding card #${s.b.id}` },
				{ cardId: 99999, reason: 'Card does not exist or is archived' }
			],
			wouldAttach: 1,
			wouldSkipAlreadyIn: 0
		});
	});

	it("names the card of a step on the critical path in the plan's mail: by its title where the attacher can open it, and as on a board they cannot where not", async () => {
		// `A1` waits on a step of `B1`, on board B, and `A2` on `A1`. The
		// critical path is the step, `A1` and `A2`, and its ids put `B1` in the
		// step's place. `B1` is not in the plan, so it had no title to give,
		// and was mailed as "#<id>" with nothing after it.
		const s = withGoals();
		const step = makeSubtask(s.b, { title: 'A step of B1' });
		makeDependency({ blocked: s.a[0], blocker: step });
		makeDependency({ blocked: s.a[1], blocker: s.a[0] });

		const mailed = async (goalName: string) => {
			const goal = makeMilestone({ board: s.A.board, name: goalName, createdBy: s.owner });
			const sent = effects();
			try {
				const res = await api('POST', `/api/v1/milestones/${goal.id}/cards/bulk`, {
					user: s.owner,
					body: { cardIds: [s.a[0].id, s.a[1].id] }
				});
				await sent.settle();
				expect(res.status).toBe(200);
				const to = (who: string) => sent.emails.find((e) => e.to === `${who}@example.test`)?.html ?? '';
				return { reader: to('reader'), admin: to('admin') };
			} finally {
				sent.restore();
			}
		};

		// Each recipient is mailed the plan as they would see it (card 2152): an
		// assignee who cannot open board B is mailed the step withheld, and so is
		// its card; the administrator, who can open B, its title.
		const reader = makeUser({ username: 'reader' });
		addBoardMember(s.A.board, reader, 'viewer');
		assignCard(s.a[0], reader);
		const hidden = await mailed('Hidden');
		expect(hidden.reader).toContain(`<li>#${s.b.id} A card on a board you cannot open</li>`);
		expect(hidden.reader).not.toContain('B1');
		expect(hidden.admin).toContain(`<li>#${s.b.id} B1</li>`);

		// Given board B, the assignee is mailed its title too.
		addBoardMember(s.B.board, reader, 'viewer');
		db.update(cards).set({ milestoneId: null }).run();
		expect((await mailed('Shown')).reader).toContain(`<li>#${s.b.id} B1</li>`);
	});

	it("mails each recipient the plan as they would see it, and nobody who cannot open it (card 2152)", async () => {
		// `c1` waits on `X`, on board B, and `c2` on `c1`: the chain is X, c1, c2.
		// `editsA` (an editor of A, assigned to c1) cannot open B. `former`,
		// assigned to c2, cannot open A, as someone taken off it cannot: they
		// stay assigned.
		const s = withGoals();
		const [c1, c2] = s.a;
		const X = makeCard(s.B.cols['To Do'], { title: 'XSECRET2152' });
		makeDependency({ blocked: c1, blocker: X });
		makeDependency({ blocked: c2, blocker: c1 });
		const editsA = makeUser({ username: 'editsa' });
		const former = makeUser({ username: 'former' });
		addBoardMember(s.A.board, editsA, 'editor');
		assignCard(c1, editsA);
		assignCard(c2, former);

		const sent = effects();
		try {
			const res = await api('POST', `/api/v1/milestones/${s.goal.id}/cards/bulk`, {
				user: s.owner,
				body: { cardIds: [c1.id, c2.id] }
			});
			await sent.settle();
			expect(res.status).toBe(200);

			const mails = sent.emails.filter((e) => e.subject === 'Plan created: Goal');
			expect(mails.map((e) => e.to).sort()).toEqual(['admin@example.test', 'editsa@example.test']);
			const to = (who: string) => mails.find((e) => e.to === `${who}@example.test`)!.html;
			expect(to('editsa')).toContain(`<li>#${X.id} A card on a board you cannot open</li>`);
			expect(to('editsa')).not.toContain('XSECRET2152');
			expect(to('editsa')).toContain(`<li>#${c1.id} A1</li>`);
			expect(to('admin')).toContain(`<li>#${X.id} XSECRET2152</li>`);
		} finally {
			sent.restore();
		}
	});

	it('answers as it did for a milestone that is not there, one the caller cannot edit, and a bad list', async () => {
		const s = withGoals();
		const post = (id: number, user: SessionUser, body: unknown) => () =>
			api('POST', `/api/v1/milestones/${id}/cards/bulk`, { user, body });

		// The milestone is looked for before the list is read, as it was.
		expect((await expectRefused(post(99999, s.owner, { cardIds: 'no' }), 404)).body.message).toBe(
			'Milestone not found'
		);
		expect((await expectRefused(post(s.goal.id, s.outsider, { cardIds: [s.a[0].id] }), 403)).body.message).toBe(
			'No access to this milestone'
		);
		expect((await expectRefused(post(s.goal.id, s.owner, { cardIds: [] }), 400)).body.message).toBe(
			'cardIds is empty'
		);
	});
});

describe('DELETE /api/v1/milestones/:milestoneId/cards/bulk', () => {
	/** A goal that holds the first three cards of A. */
	const withGoal = () => {
		const s = scene();
		const goal = makeMilestone({ board: s.A.board, name: 'Goal', cards: s.a.slice(0, 3) });
		return { ...s, goal };
	};

	it('takes every card out, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: withGoal,
			request: (s) =>
				api('DELETE', `/api/v1/milestones/${s.goal.id}/cards/bulk`, {
					user: s.owner,
					body: { cardIds: s.a.map((c) => c.id) }
				}),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					milestoneId: s.goal.id,
					detached: 3,
					skippedNotInMilestone: 1,
					boardsTouched: [s.A.board.id]
				});
				expect(s.a.map(milestoneOf)).toEqual([null, null, null, null]);
				// The cards themselves are untouched.
				expect(db.select().from(cards).all()).toHaveLength(5);
			}
		});

		expect(shape(run.writes)).toEqual(Array(3).fill('update cards set'));
		expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
	});

	it('rejects the whole batch for one card the caller may not edit', async () => {
		const s = withGoal();
		const cardIds = [s.a[0].id, s.a[1].id, s.b.id];

		const res = await expectRefused(
			() => api('DELETE', `/api/v1/milestones/${s.goal.id}/cards/bulk`, { user: s.owner, body: { cardIds } }),
			409
		);

		expect(res.body).toEqual({
			message: 'Batch rejected — nothing was written',
			detached: 0,
			problems: [{ cardId: s.b.id, reason: `No edit access to the board holding card #${s.b.id}` }]
		});
		expect(s.a.map(milestoneOf)).toEqual([s.goal.id, s.goal.id, s.goal.id, null]);
	});
});

// ─── Dependencies ───────────────────────────────────────────────────────────

describe('POST /api/v1/dependencies/bulk', () => {
	/** Board B is the owner's to edit too, so that a chain can cross to it. */
	const twoBoards = () => {
		const s = scene();
		const B = makeBoard({ owner: s.owner, name: 'Second' });
		const onB = makeCard(B.cols['To Do'], { title: 'On the second board' });
		return { ...s, B, onB };
	};

	it('records every link of a chain with its activity entry, or nothing', async () => {
		const run = await eachWriteInTurn({
			build: twoBoards,
			request: (s) =>
				api('POST', '/api/v1/dependencies/bulk', {
					user: s.owner,
					body: { chain: [s.a[0].id, s.a[1].id, s.a[2].id, s.onB.id] }
				}),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toMatchObject({
					created: 3,
					skippedAsDuplicate: 0,
					boardsTouched: [s.A.board.id, s.B.board.id]
				});
				expect(res.body.links).toHaveLength(3);

				// Each waits on the one before it, and each says who recorded it.
				expect(
					db
						.select({
							blocked: workDependencies.blockedId,
							blocker: workDependencies.blockerId,
							by: workDependencies.createdByUserId
						})
						.from(workDependencies)
						.all()
				).toEqual([
					{ blocked: s.a[1].id, blocker: s.a[0].id, by: s.owner.id },
					{ blocked: s.a[2].id, blocker: s.a[1].id, by: s.owner.id },
					{ blocked: s.onB.id, blocker: s.a[2].id, by: s.owner.id }
				]);
				// One entry per link, on the board of the card that waits, with that
				// card's id and the single add's words (card 2291). It was one
				// `api:dependencies_bulk_added` with no card, on the first board alone.
				expect(entries()).toEqual([
					{ boardId: s.A.board.id, cardId: s.a[1].id, action: 'api:dependency_added', source: 'api', detail: `#${s.a[1].id} now waits on #${s.a[0].id}` },
					{ boardId: s.A.board.id, cardId: s.a[2].id, action: 'api:dependency_added', source: 'api', detail: `#${s.a[2].id} now waits on #${s.a[1].id}` },
					{ boardId: s.B.board.id, cardId: s.onB.id, action: 'api:dependency_added', source: 'api', detail: `#${s.onB.id} now waits on #${s.a[2].id}` }
				]);
			}
		});

		// The links, and the entries that say they were recorded: the entry used
		// to be written after the links were committed, so a failure there left
		// links nobody was recorded as having made.
		expect(shape(run.writes)).toEqual([
			'insert or ignore',
			'insert or ignore',
			'insert or ignore',
			'insert into activity_log',
			'insert into activity_log',
			'insert into activity_log'
		]);
		expect(run.effects.map(name)).toEqual([
			'event update (card) on board 1',
			`event update (card) on board 3`
		]);
	});

	// Card 2291: the entries and the live updates are made from one list, the
	// links the batch created, so a link already stored has neither.
	it('records only the link it created, and tells only that link\'s boards, once each', async () => {
		const s = twoBoards();
		makeDependency({ blocked: s.a[1], blocker: s.a[0] });
		const sent = effects();
		try {
			const res = await api('POST', '/api/v1/dependencies/bulk', {
				user: s.owner,
				body: { chain: [s.a[0].id, s.a[1].id, s.onB.id] }
			});
			await sent.settle();

			expect(res.status).toBe(201);
			expect(res.body).toMatchObject({ created: 1, skippedAsDuplicate: 1, boardsTouched: [s.B.board.id, s.A.board.id] });
			expect(entries()).toEqual([
				{ boardId: s.B.board.id, cardId: s.onB.id, action: 'api:dependency_added', source: 'api', detail: `#${s.onB.id} now waits on #${s.a[1].id}` }
			]);
			expect(sent.all.map(name)).toEqual([
				`event update (card) on board ${s.B.board.id}`,
				`event update (card) on board ${s.A.board.id}`
			]);
		} finally {
			sent.restore();
		}
	});

	// A contract, which held before card 2291 (its third part is not
	// reproduced): a batch of links already stored writes and tells nothing.
	it('writes no entry and tells nobody for a batch of links already stored', async () => {
		const s = twoBoards();
		makeDependency({ blocked: s.a[1], blocker: s.a[0] });
		makeDependency({ blocked: s.onB, blocker: s.a[1] });
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('POST', '/api/v1/dependencies/bulk', {
				user: s.owner,
				body: { chain: [s.a[0].id, s.a[1].id, s.onB.id] }
			});
			await sent.settle();

			expect(res.status).toBe(201);
			expect(res.body).toMatchObject({ created: 0, skippedAsDuplicate: 2, boardsTouched: [] });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('rejects the whole batch for one link that would close a loop, having written nothing', async () => {
		const s = twoBoards();
		makeDependency({ blocked: s.a[1], blocker: s.a[0] });

		const res = await expectRefused(
			() =>
				api('POST', '/api/v1/dependencies/bulk', {
					user: s.owner,
					body: {
						links: [
							{ blocked: s.a[2].id, blocker: s.a[1].id },
							{ blocked: s.a[0].id, blocker: s.a[2].id }
						]
					}
				}),
			409
		);

		expect(res.body).toMatchObject({ message: 'Batch rejected — nothing was written', written: 0, wouldCreate: 1 });
		expect(res.body.rejected).toHaveLength(1);
		expect(res.body.rejected[0].reason).toBe('cycle');
	});

	it('rejects the whole batch for one link to a board the caller may not edit', async () => {
		const s = scene();

		const res = await expectRefused(
			() =>
				api('POST', '/api/v1/dependencies/bulk', {
					user: s.owner,
					body: {
						links: [
							{ blocked: s.a[1].id, blocker: s.a[0].id },
							{ blocked: s.a[2].id, blocker: s.b.id }
						]
					}
				}),
			409
		);

		expect(res.body.forbidden).toHaveLength(1);
		expect(res.body.forbidden[0].message).toBe(`No edit access to the board holding the blocker card:${s.b.id}`);
	});
});

// ─── Tokens ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/tokens/bulk', () => {
	const withSubtask = () => {
		const s = scene();
		const subtask = makeSubtask(s.a[0]);
		return { ...s, subtask };
	};

	it('records every entry, or none of them', async () => {
		const run = await eachWriteInTurn({
			build: withSubtask,
			request: (s) =>
				api('POST', '/api/v1/tokens/bulk', {
					user: s.owner,
					body: {
						entries: [
							{ cardId: s.a[0].id, tokens: 1000, model: 'claude-opus-5', note: 'planning' },
							{ subtaskId: s.subtask.id, tokens: 500, model: 'claude-sonnet-5' },
							{ cardId: s.a[1].id, tokens: 250 }
						]
					}
				}),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(res.body).toEqual({
					written: 3,
					boardsTouched: [s.A.board.id],
					cardTotals: [
						{ cardId: s.a[0].id, total: 1500, entries: 2 },
						{ cardId: s.a[1].id, total: 250, entries: 1 }
					]
				});
				expect(
					db
						.select({
							cardId: tokenUsage.cardId,
							subtaskId: tokenUsage.subtaskId,
							tokens: tokenUsage.tokens,
							by: tokenUsage.reportedByUserId
						})
						.from(tokenUsage)
						.all()
				).toEqual([
					{ cardId: s.a[0].id, subtaskId: null, tokens: 1000, by: s.owner.id },
					{ cardId: null, subtaskId: s.subtask.id, tokens: 500, by: s.owner.id },
					{ cardId: s.a[1].id, subtaskId: null, tokens: 250, by: s.owner.id }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(Array(3).fill('insert into token_usage'));
		expect(run.effects.map(name)).toEqual(['event update (card) on board 1']);
	});

	it('rejects the whole batch for one entry that is wrong, and says which', async () => {
		const s = withSubtask();

		const res = await expectRefused(
			() =>
				api('POST', '/api/v1/tokens/bulk', {
					user: s.owner,
					body: {
						entries: [
							{ cardId: s.a[0].id, tokens: 1000 },
							{ cardId: s.b.id, tokens: 10 },
							{ cardId: s.a[1].id, tokens: 0 }
						]
					}
				}),
			409
		);

		expect(res.body).toMatchObject({ message: 'Batch rejected — nothing was written', written: 0 });
		expect(res.body.problems.map((p: { index: number }) => p.index)).toEqual([1, 2]);
	});

	it('answers 400 for a body with no list in it, as it did', async () => {
		const s = withSubtask();

		const res = await expectRefused(() => api('POST', '/api/v1/tokens/bulk', { user: s.owner, body: {} }), 400);

		expect(res.body.message).toBe('entries must be an array');
	});
});

// ─── The admin panel ────────────────────────────────────────────────────────

describe('POST /api/admin/boards/:id/clear-categories', () => {
	/** Two categories on A, each on a card, and one on B, on a card. */
	const withCategories = () => {
		const s = scene();
		const category = (board: BoardFixture, title: string) =>
			db.insert(categories).values({ boardId: board.board.id, name: title }).returning().get();
		const bug = category(s.A, 'Bug');
		const feature = category(s.A, 'Feature');
		const ofB = category(s.B, 'Of B');
		db.update(cards).set({ categoryId: bug.id }).where(eq(cards.id, s.a[0].id)).run();
		db.update(cards).set({ categoryId: feature.id }).where(eq(cards.id, s.a[1].id)).run();
		db.update(cards).set({ categoryId: ofB.id }).where(eq(cards.id, s.b.id)).run();
		return { ...s, ofB };
	};

	const categoryOf = (card: Card) =>
		db.select({ categoryId: cards.categoryId }).from(cards).where(eq(cards.id, card.id)).get()!.categoryId;

	it('removes every category of the board and takes each off its cards, or does neither', async () => {
		const run = await eachWriteInTurn({
			build: withCategories,
			request: (s) => api('POST', `/api/admin/boards/${s.A.board.id}/clear-categories`, { user: s.admin }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				// The other board's category is left, and its card still has it.
				expect(db.select({ name: categories.name }).from(categories).all()).toEqual([{ name: 'Of B' }]);
				expect(s.a.map(categoryOf)).toEqual([null, null, null, null]);
				expect(categoryOf(s.b)).toBe(s.ofB.id);
				expect(db.select().from(cards).all()).toHaveLength(5);
			}
		});

		expect(shape(run.writes)).toEqual(['delete from categories']);
		expect(run.effects).toEqual([]);
	});

	it('refuses a caller who is not an administrator', async () => {
		const s = withCategories();

		await expectRefused(
			() => api('POST', `/api/admin/boards/${s.A.board.id}/clear-categories`, { user: s.owner }),
			403
		);
		// For a board that is not there too: refused before anything is read.
		await expectRefused(() => api('POST', '/api/admin/boards/99999/clear-categories', { user: s.owner }), 403);
	});

	it('answers 404 for a board that is not there, and clears nothing', async () => {
		const s = withCategories();

		// It was 200 { success: true }, for clearing nothing (card 2211).
		const res = await expectRefused(
			() => api('POST', '/api/admin/boards/99999/clear-categories', { user: s.admin }),
			404
		);
		expect(res.body).toEqual({ message: 'Board not found' });
	});
});

describe('POST /api/admin/reset-xp', () => {
	const withXp = () => {
		const s = scene();
		db.insert(userXp)
			.values([
				{ name: 'owner', xp: 300, emoji: '🦊' },
				{ name: 'outsider', xp: 50 },
				{ name: 'someone who left', xp: 900 }
			])
			.run();
		return s;
	};

	it('sets everybody\'s XP to nothing and keeps the rows, or changes nobody\'s', async () => {
		const run = await eachWriteInTurn({
			build: withXp,
			request: (s) => api('POST', '/api/admin/reset-xp', { user: s.admin }),
			afterSuccess: (_s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({ success: true });
				expect(db.select().from(userXp).all()).toEqual([
					{ name: 'owner', xp: 0, emoji: '🦊' },
					{ name: 'outsider', xp: 0, emoji: '👤' },
					{ name: 'someone who left', xp: 0, emoji: '👤' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['update user_xp set']);
		expect(run.effects).toEqual([]);
	});

	it('refuses a caller who is not an administrator', async () => {
		const s = withXp();

		await expectRefused(() => api('POST', '/api/admin/reset-xp', { user: s.owner }), 403);
	});
});
