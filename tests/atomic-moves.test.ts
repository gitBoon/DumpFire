/**
 * Card and subtask moves and completion are all or nothing, and nobody is told
 * of one until it is committed.
 *
 * Each route here makes several writes for one request: the card, the XP, the
 * activity entry, the "Unblocked" notice on whatever was waiting. Most tests
 * use `eachWriteInTurn`, which makes the request once to count its writes and
 * then once more for each of them, with that write failing, and checks every
 * time that not one row changed and nothing was sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import {
	activityLog,
	boardMembers,
	cardComments,
	cardLabels,
	cards,
	subtasks,
	taskRequests,
	teamMembers,
	tokenUsage,
	userXp,
	workDependencies,
	type Card,
	type Subtask
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { createDependencyBatch, recordUnblocked } from '$lib/server/planning';
import { listMilestones } from '$lib/server/milestones';
import { recordTokenUsageBatch } from '$lib/server/tokens';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { effects, type Effects, type RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSmtp,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

beforeEach(resetDb);

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const notices = () => db.select().from(cardComments).all();
const actions = () => db.select().from(activityLog).all().map((e) => e.action);

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event}${effect.data?.action ? ` (${effect.data.action})` : ''}`;
}

/** Someone outside asked for this card's work, and is told how it goes. */
function makeRequestFor(card: Card, owner: SessionUser): void {
	db.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: owner.id,
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			title: 'Please build this',
			status: 'accepted',
			accessToken: 'a'.repeat(64),
			resolvedBy: owner.id,
			resolvedCardId: card.id
		})
		.run();
}

type Scene = {
	owner: SessionUser;
	/** Assigned to both cards, and a viewer of A. */
	assignee: SessionUser;
	A: BoardFixture;
	/** The card the request moves. */
	first: Card;
	/** A card waiting on `first` and on nothing else. */
	waiting: Card;
};

/**
 * Board A with a webhook, mail switched on, a card to move and a card waiting
 * on it. Both have an assignee, so both a "moved" and an "unblocked" mail have
 * somebody to go to. The assignee can open A: an assignee who cannot is not
 * mailed about its cards (card 2180).
 */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const assignee = makeUser({ username: 'assignee' });
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, assignee, 'viewer');
	makeSmtp();
	makeWebhook(A.board);
	const first = makeCard(A.cols['To Do'], { title: 'First', priority: 'high' });
	const waiting = makeCard(A.cols['To Do'], { title: 'Waiting' });
	assignCard(first, assignee);
	assignCard(waiting, assignee);
	makeDependency({ blocked: waiting, blocker: first });
	return { owner, assignee, A, first, waiting };
}

describe('PUT /api/cards/:id', () => {
	it('with a move and another field, failed at each write, leaves the card unmoved and unedited', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, A, first }) =>
				api('PUT', `/api/cards/${first.id}`, {
					user: owner,
					body: { columnId: A.cols['Complete'].id, title: 'Renamed' }
				}),
			afterSuccess: ({ A, first, waiting }, res) => {
				expect(res.status).toBe(200);
				expect(cardRow(first.id)).toMatchObject({ columnId: A.cols['Complete'].id, title: 'Renamed' });
				expect(res.body).toMatchObject({ columnId: A.cols['Complete'].id, title: 'Renamed' });
				expect(actions()).toEqual(['card_completed', 'card_updated']);
				expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
			}
		});

		// The move, the XP and its entry; the edit and its entry; the notice. The
		// move used to be committed before the fourth of these was attempted.
		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "cards" set',
			'insert into "user_xp"',
			'insert into "activity_log"',
			'update "cards" set',
			'insert into "activity_log"',
			'insert into "card_comments"'
		]);
		expect(run.effects.map(name)).toEqual([
			'webhook card.completed',
			'webhook card.updated',
			'email to assignee@example.test: Card moved: First → Complete',
			'email to assignee@example.test: Unblocked: Waiting',
			'event update',
			'event update',
			'event update (moved)',
			'event xp-update',
			'event celebrate'
		]);
		// The waiting card's board is told of the card and of its new "Unblocked"
		// comment, so a card window open on the waiting card shows it (card 2282).
		// Waiting is the scene's second card.
		expect(run.effects.filter((e) => e.kind === 'event' && e.event === 'update').slice(0, 2).map((e) => (e as { data: unknown }).data)).toEqual([
			{ type: 'card' },
			{ type: 'comment', cardId: 2 }
		]);
	});

	it('with an edit alone, saves the edit and its activity entry together', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: ({ owner, first }) =>
				api('PUT', `/api/cards/${first.id}`, { user: owner, body: { title: 'Renamed', priority: 'low' } }),
			afterSuccess: ({ first }) => {
				expect(cardRow(first.id)).toMatchObject({ title: 'Renamed', priority: 'low' });
				expect(actions()).toEqual(['card_updated']);
			}
		});

		expect(run.writes).toHaveLength(2);
		expect(run.effects.map(name)).toEqual(['webhook card.updated', 'event update']);
	});

	it('refused as a move, saves nothing of the edit sent with it and announces nothing', async () => {
		const { owner, A, first } = scene();
		makeSubtask(first, { completed: false });
		const before = snapshotDb();
		const sent = effects();

		try {
			const res = await api('PUT', `/api/cards/${first.id}`, {
				user: owner,
				body: { columnId: A.cols['Complete'].id, title: 'Renamed' }
			});
			await sent.settle();

			// The refusal reaches the caller as the 409 it always was.
			expect(res.status).toBe(409);
			expect(res.body.message).toMatch(/1 incomplete subtask/);
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('answers 403 from inside the transaction, having written nothing', async () => {
		const { A, first } = scene();
		const outsider = makeUser({ username: 'outsider' });
		const before = snapshotDb();

		const res = await api('PUT', `/api/cards/${first.id}`, {
			user: outsider,
			body: { columnId: A.cols['Complete'].id, title: 'Hijacked' }
		});

		expect(res.status).toBe(403);
		expectUnchanged(before);
	});
});

describe('PUT /api/cards/reorder', () => {
	/** A drop that completes two cards and shifts a third within its column. */
	const drop = ({ owner, A, first }: Scene, second: Card, third: Card) =>
		api('PUT', '/api/cards/reorder', {
			user: owner,
			body: {
				updates: [
					{ id: first.id, columnId: A.cols['Complete'].id, position: 0 },
					{ id: second.id, columnId: A.cols['Complete'].id, position: 1 },
					{ id: third.id, columnId: A.cols['To Do'].id, position: 0 }
				]
			}
		});

	const withTwoMore = () => {
		const s = scene();
		const second = makeCard(s.A.cols['To Do'], { title: 'Second', priority: 'low' });
		const third = makeCard(s.A.cols['To Do'], { title: 'Third', position: 4 });
		return { ...s, second, third };
	};

	it('moves every card of a drop or none, whichever write fails', async () => {
		const run = await eachWriteInTurn({
			build: withTwoMore,
			request: (s) => drop(s, s.second, s.third),
			afterSuccess: ({ A, first, second, third, waiting, owner }, res) => {
				expect(res.status).toBe(200);
				expect(cardRow(first.id).columnId).toBe(A.cols['Complete'].id);
				expect(cardRow(second.id).columnId).toBe(A.cols['Complete'].id);
				expect(cardRow(third.id).position).toBe(0);
				expect(db.select().from(userXp).all()).toMatchObject([{ name: owner.username, xp: 200 }]);
				expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
			}
		});

		// Two completions (card, XP, entry each), one change of position, one notice.
		expect(run.writes).toHaveLength(8);
		expect(run.writes.at(-1)).toMatch(/^insert into "card_comments"/);
		expect(run.effects.map(name)).toEqual([
			'webhook card.completed',
			'webhook card.completed',
			'email to assignee@example.test: Card moved: First → Complete',
			'email to assignee@example.test: Unblocked: Waiting',
			'event update',
			// The notice's comment event (card 2282).
			'event update',
			'event update (moved)',
			'event xp-update',
			'event celebrate'
		]);
	});

	it('has announced nothing when a later card of the drop is refused', async () => {
		const s = withTwoMore();
		// The first card completes cleanly. The second cannot be completed.
		makeSubtask(s.second, { completed: false });
		const before = snapshotDb();
		const sent = effects();

		try {
			const res = await drop(s, s.second, s.third);
			await sent.settle();

			expect(res.status).toBe(409);
			expectUnchanged(before);
			// The first card's webhook used to have gone out by now.
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('writes no notice on a card that the same drop unblocked and then completed', async () => {
		const { owner, A, first, waiting } = scene();
		// `waiting` waits on `first` and is completed after it in the same drop.
		// A third card waits on `first` too and stays where it is.
		const bystander = makeCard(A.cols['To Do'], { title: 'Bystander' });
		makeDependency({ blocked: bystander, blocker: first });
		// The drop has a webhook to deliver and a mail to send: recorded, not sent.
		const sent = effects();

		try {
			const res = await api('PUT', '/api/cards/reorder', {
				user: owner,
				body: {
					updates: [
						{ id: first.id, columnId: A.cols['Complete'].id, position: 0 },
						{ id: waiting.id, columnId: A.cols['Complete'].id, position: 1 }
					]
				}
			});
			await sent.settle();

			expect(res.status).toBe(200);
			expect(cardRow(waiting.id).completedAt).not.toBeNull();
			expect(notices().map((n) => n.cardId)).toEqual([bystander.id]);
			expect(notices()[0].content).toBe(
				`Unblocked: #${first.id} "First" completed — nothing is blocking this card now.`
			);
		} finally {
			sent.restore();
		}
	});

	it('writes one notice, and mails each assignee once, when a drop completes two cards that block the same card', async () => {
		const { owner, A, first, waiting } = scene();
		// `waiting` waits on `first` and on `second`, and one drop completes both.
		const second = makeCard(A.cols['To Do'], { title: 'Second' });
		makeDependency({ blocked: waiting, blocker: second });
		const another = makeUser({ username: 'another' });
		addBoardMember(A.board, another, 'viewer');
		assignCard(waiting, another);
		const sent = effects();

		try {
			const res = await api('PUT', '/api/cards/reorder', {
				user: owner,
				body: {
					updates: [
						{ id: first.id, columnId: A.cols['Complete'].id, position: 0 },
						{ id: second.id, columnId: A.cols['Complete'].id, position: 1 }
					]
				}
			});
			await sent.settle();

			expect(res.status).toBe(200);
			// Each of the two used to write one, both finding nothing left open.
			// It names the second: with only the first done, the card was blocked.
			expect(notices().map((n) => ({ cardId: n.cardId, content: n.content }))).toEqual([
				{
					cardId: waiting.id,
					content: `Unblocked: #${second.id} "Second" completed — nothing is blocking this card now.`
				}
			]);
			expect(
				sent.emails
					.filter((e) => e.subject === 'Unblocked: Waiting')
					.map((e) => e.to)
					.sort()
			).toEqual(['another@example.test', 'assignee@example.test']);
		} finally {
			sent.restore();
		}
	});

	it('starts every effect of a drop after its transaction has closed', async () => {
		const s = withTwoMore();
		const sent = effects();
		try {
			await drop(s, s.second, s.third);
			await sent.settle();

			expect(sent.all.length).toBeGreaterThan(0);
			expect(sent.duringTransaction).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	describe('holds one request to 5,000 cards named and 100 moved to another column (card 2209)', () => {
		// A drop sends every card of the board, so the first cap sits above the
		// largest board. A card moved to another column is an entry, a delivery
		// to every webhook and mail, so the second bounds that burst. Nothing but
		// the body's size bounded either.
		let sent: Effects;
		beforeEach(() => {
			sent = effects();
		});
		afterEach(() => {
			sent.restore();
		});

		/** A board with `count` cards in To Do, and ten webhooks. */
		function crowded(count: number) {
			const owner = makeUser({ username: 'owner' });
			const B = makeBoard({ owner, name: 'Crowded' });
			for (let i = 0; i < 10; i++) makeWebhook(B.board);
			const all = Array.from({ length: count }, (_, i) => makeCard(B.cols['To Do'], { title: `Card ${i}`, position: i }));
			return { owner, B, all };
		}
		const reorder = (user: SessionUser, updates: object[]) => api('PUT', '/api/cards/reorder', { user, body: { updates } });
		const moves = (all: Card[], columnId: number) => all.map((card, i) => ({ id: card.id, columnId, position: i }));

		it('refuses more than 5,000 entries before any card is read: 400, nothing moved, nothing sent', async () => {
			const { owner } = crowded(1);
			const before = snapshotDb();

			const res = await reorder(owner, Array.from({ length: 5001 }, (_, i) => ({ id: 900000 + i, columnId: 1, position: i })));
			await sent.settle();

			// It was 404 for its first card, which nothing counted.
			expect(res.status).toBe(400);
			expect(res.body).toEqual({ message: 'A reorder can name at most 5,000 cards, and this names 5,001. Nothing was moved.' });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);

			// 5,000 pass the cap: the first card is then looked for.
			const five = await reorder(owner, Array.from({ length: 5000 }, (_, i) => ({ id: 900000 + i, columnId: 1, position: i })));
			expect(five.status).toBe(404);
			expect(five.body).toEqual({ message: 'Card 900000 not found' });
		});

		it('refuses more than 100 cards moved to another column: 400, nothing moved, nothing sent; 100 move, with 1,000 deliveries', async () => {
			const { owner, B, all } = crowded(101);
			const before = snapshotDb();

			const res = await reorder(owner, moves(all, B.cols['In Progress'].id));
			await sent.settle();

			expect(res.status).toBe(400);
			expect(res.body).toEqual({
				message: 'At most 100 cards can be moved to another column at once, and this moves 101. Nothing was moved: move them in groups of 100 or fewer.'
			});
			expectUnchanged(before);
			expect(sent.all).toEqual([]);

			const hundred = await reorder(owner, moves(all.slice(0, 100), B.cols['In Progress'].id));
			await sent.settle();

			expect(hundred.status, JSON.stringify(hundred.body)).toBe(200);
			expect(actions().filter((action) => action === 'card_moved')).toHaveLength(100);
			// Each card moved goes to each of the board's ten webhooks.
			expect(sent.webhooks).toHaveLength(1000);
		});

		it('lets a drop on a board of 300 cards through: every card named, one moved, one entry', async () => {
			const { owner, B, all } = crowded(300);
			// As the board page sends a drop: every card of the board, the dragged
			// one in its new column and the rest where they are, renumbered.
			const updates = all.map((card, i) => ({ id: card.id, columnId: i === 0 ? B.cols['In Progress'].id : B.cols['To Do'].id, position: i === 0 ? 0 : i - 1 }));

			const res = await reorder(owner, updates);

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(actions()).toEqual(['card_moved']);
			expect(cardRow(all[0].id).columnId).toBe(B.cols['In Progress'].id);
		});

		// One card named over and over, to and fro between two columns, was
		// counted once for each entry to another column than the one it was in
		// before the drop, so 200 entries were 100 counted and 200 real moves
		// (review S5).
		it('refuses a card named twice, before any card is read: 400, nothing moved, nothing sent', async () => {
			const { owner, B, all } = crowded(1);
			const [card] = all;
			const before = snapshotDb();

			const toAndFro = Array.from({ length: 200 }, (_, i) => ({
				id: card.id,
				columnId: i % 2 === 0 ? B.cols['In Progress'].id : B.cols['To Do'].id,
				position: 0
			}));
			const res = await reorder(owner, toAndFro);
			await sent.settle();

			expect(res.status).toBe(400);
			expect(res.body).toEqual({ message: `updates names card ${card.id} more than once` });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);

			// A card that is not there, named twice, is not looked for: 400, not 404.
			const missing = await reorder(owner, [
				{ id: 900000, columnId: B.cols['To Do'].id, position: 0 },
				{ id: '900000', columnId: B.cols['To Do'].id, position: 1 }
			]);
			expect(missing.status).toBe(400);
			expect(missing.body).toEqual({ message: 'updates names card 900000 more than once' });
		});

		it('asks who may edit the board first, and reads every entry, before it counts the cards moved', async () => {
			const { owner, B, all } = crowded(101);
			const viewer = makeUser({ username: 'viewer' });
			addBoardMember(B.board, viewer, 'viewer');
			const before = snapshotDb();

			const looked = await reorder(viewer, moves(all, B.cols['In Progress'].id));
			expect(looked.status).toBe(403);

			const bad = moves(all, B.cols['In Progress'].id);
			bad[50] = { ...bad[50], id: 'a card' } as unknown as (typeof bad)[number];
			const refused = await reorder(owner, bad);
			expect(refused.status).toBe(400);
			expect(refused.body).toEqual({ message: 'updates[50].id must be an id' });
			expectUnchanged(before);
		});
	});
});

describe('PUT /api/v1/cards/:id/move', () => {
	/**
	 * `first` carries a label of board A and is moved to board B's Complete
	 * column. Its assignee can open B too, so is mailed that it moved there.
	 */
	const acrossBoards = () => {
		const s = scene();
		const B = makeBoard({ owner: s.owner, name: 'B' });
		addBoardMember(B.board, s.assignee, 'viewer');
		makeWebhook(B.board, { url: 'https://hooks.example.test/b' });
		const label = makeLabel(s.A.board);
		db.insert(cardLabels).values({ cardId: s.first.id, labelId: label.id }).run();
		return { ...s, B };
	};

	it('moves a card to another board with everything that follows, or not at all', async () => {
		const run = await eachWriteInTurn({
			build: acrossBoards,
			request: ({ owner, first, B }) =>
				api('PUT', `/api/v1/cards/${first.id}/move`, { user: owner, body: { columnId: B.cols['Complete'].id } }),
			afterSuccess: ({ first, waiting, B }, res) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: first.id, boardId: B.board.id, columnTitle: 'Complete' });
				expect(db.select().from(cardLabels).all()).toEqual([]);
				expect(actions()).toEqual(['api:card_moved_away', 'api:card_moved_in', 'api:card_completed']);
				expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
			}
		});

		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'delete from "card_labels"',
			'update "cards" set',
			'insert into "user_xp"',
			'insert into "activity_log"',
			'insert into "activity_log"',
			'insert into "activity_log"',
			'insert into "card_comments"'
		]);
		// Board A's webhook hears the card leave, board B's that it arrived and
		// was completed (card 2278), and the assignee is mailed that the card
		// moved: a completion is mailed whichever route made it (card 2134). A
		// plain move through the API mails nobody.
		expect(run.effects.map(name)).toEqual([
			'webhook card.moved',
			'webhook card.moved',
			'webhook card.completed',
			'email to assignee@example.test: Card moved: First → Complete',
			'email to assignee@example.test: Unblocked: Waiting',
			'event update',
			// The notice's comment event (card 2282).
			'event update',
			'event update (moved_away)',
			'event update (moved_in)',
			'event xp-update',
			'event celebrate'
		]);
		expect(run.effects.slice(0, 3).map((e) => (e.kind === 'webhook' ? [e.url === 'https://hooks.example.test/b', e.body.data.action] : e.kind))).toEqual([
			[false, 'card_moved_away'],
			[true, 'card_moved_in'],
			[true, 'card_completed']
		]);
	});

	it('refused, leaves the card where it was and announces nothing', async () => {
		const { owner, A, first } = scene();
		makeSubtask(first, { completed: false });
		const before = snapshotDb();
		const sent = effects();

		try {
			const res = await api('PUT', `/api/v1/cards/${first.id}/move`, {
				user: owner,
				body: { columnId: A.cols['Complete'].id }
			});
			await sent.settle();

			expect(res.status).toBe(409);
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	/**
	 * Card 2181. A move between boards wrote the other board's name into each
	 * board's activity, and into the live event each board's listeners hear: a
	 * reader of one board who could not open the other read its name. Boards
	 * ALPHA-SECRET and BRAVO-SECRET, both the owner's, so that either name can be
	 * looked for; `viewerA` views A only, `viewerB` B only, and `both` both.
	 */
	const twoBoards = () => {
		const owner = makeUser({ username: 'owner' });
		const viewerA = makeUser({ username: 'viewera' });
		const viewerB = makeUser({ username: 'viewerb' });
		const both = makeUser({ username: 'both' });
		const A = makeBoard({ owner, name: 'ALPHA-SECRET' });
		const B = makeBoard({ owner, name: 'BRAVO-SECRET' });
		addBoardMember(A.board, viewerA, 'viewer');
		addBoardMember(B.board, viewerB, 'viewer');
		addBoardMember(A.board, both, 'viewer');
		addBoardMember(B.board, both, 'viewer');
		const first = makeCard(A.cols['To Do'], { title: 'First' });
		return { owner, viewerA, viewerB, both, A, B, first };
	};
	const moveAcross = (w: ReturnType<typeof twoBoards>) =>
		api('PUT', `/api/v1/cards/${w.first.id}/move`, { user: w.owner, body: { columnId: w.B.cols['In Progress'].id } });

	it('names the other board in neither board\'s activity, and each entry is listed under its own board (card 2181)', async () => {
		const w = twoBoards();

		expect((await moveAcross(w)).status).toBe(200);

		const ofA = await api('GET', `/api/activity?boardId=${w.A.board.id}`, { user: w.viewerA });
		expect(ofA.body.map((e: { detail: string }) => e.detail)).toEqual(['"First" moved to another board (To Do → In Progress)']);
		expect(JSON.stringify(ofA.body)).not.toContain('BRAVO-SECRET');
		const ofB = await api('GET', `/api/activity?boardId=${w.B.board.id}`, { user: w.viewerB });
		expect(ofB.body.map((e: { detail: string }) => e.detail)).toEqual(['"First" moved from another board (To Do → In Progress)']);
		expect(JSON.stringify(ofB.body)).not.toContain('ALPHA-SECRET');
		// The feed across boards (All Tasks) too.
		expect(JSON.stringify((await api('GET', '/api/activity', { user: w.viewerA })).body)).not.toContain('BRAVO-SECRET');
		expect(JSON.stringify((await api('GET', '/api/activity', { user: w.viewerB })).body)).not.toContain('ALPHA-SECRET');

		// Someone who can open both still reads where the card went: each entry
		// under its own board's name.
		const all = await api('GET', '/api/activity', { user: w.both });
		expect(all.body.map((e: { boardName: string; detail: string }) => [e.boardName, e.detail]).sort()).toEqual([
			['ALPHA-SECRET', '"First" moved to another board (To Do → In Progress)'],
			['BRAVO-SECRET', '"First" moved from another board (To Do → In Progress)']
		]);
	});

	it('names neither board in the live events of the move (card 2181)', async () => {
		const w = twoBoards();
		const sent = effects();

		try {
			expect((await moveAcross(w)).status).toBe(200);
			await sent.settle();

			const moves = sent.events.filter((e) => e.data?.action === 'moved_away' || e.data?.action === 'moved_in');
			expect(moves.map((e) => [e.boardId, e.data.action])).toEqual([
				[w.A.board.id, 'moved_away'],
				[w.B.board.id, 'moved_in']
			]);
			for (const event of moves) {
				expect(Object.keys(event.data).sort()).toEqual(
					['action', 'cardTitle', 'fromColumn', 'toColumn', 'type', 'userEmoji', 'userName']
				);
			}
			const heard = JSON.stringify(sent.events.map((e) => e.data));
			expect(heard).not.toContain('ALPHA-SECRET');
			expect(heard).not.toContain('BRAVO-SECRET');
		} finally {
			sent.restore();
		}
	});
});

/**
 * Card 2208. An on-hold note is the reason a card is paused. Only the board
 * page's drop cleared it, with a second request of its own; every route
 * kept it, and the activity report went on counting the card as on hold in
 * whatever column it was. `applyCardMove` clears it now, in the move's own
 * write, so every route does, and nothing else is recorded for it.
 */
describe('a move out of an On Hold column clears the on-hold note (card 2208)', () => {
	const NOTE = 'waiting on X';

	/** Board A (the four standard columns) with a card held in On Hold, and board B. */
	const held = () => {
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		const card = makeCard(A.cols['On Hold'], { title: 'Paused', onHoldNote: NOTE });
		return { owner, A, B, card };
	};
	type Held = ReturnType<typeof held>;

	/** Each route that moves a card, to a column of `to`. */
	const routes: [string, (s: Held, columnId: number) => Promise<ApiResult>][] = [
		[
			'PUT /api/cards/reorder',
			({ owner, card }, columnId) =>
				api('PUT', '/api/cards/reorder', { user: owner, body: { updates: [{ id: card.id, columnId, position: 0 }] } })
		],
		['PUT /api/cards/:id with columnId', ({ owner, card }, columnId) => api('PUT', `/api/cards/${card.id}`, { user: owner, body: { columnId } })],
		['PUT /api/v1/cards/:id/move', ({ owner, card }, columnId) => api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId } })]
	];

	it.each([
		...routes.map(([route, move]) => [`${route}, to In Progress`, move, (s: Held) => s.A.cols['In Progress'].id] as const),
		...routes.slice(1).map(([route, move]) => [`${route}, to another board's To Do`, move, (s: Held) => s.B.cols['To Do'].id] as const)
	])('%s: the note is cleared in the row and in the answer', async (_, move, to) => {
		const s = held();

		const res = await move(s, to(s));

		expect(res.status).toBe(200);
		expect(cardRow(s.card.id)).toMatchObject({ columnId: to(s), onHoldNote: '' });
		if ('id' in res.body) expect(res.body).toMatchObject({ id: s.card.id, onHoldNote: '' });
	});

	it('keeps the note on a move between two hold columns, into one, within one, and between two that are not', async () => {
		const owner = makeUser({ username: 'owner' });
		const { cols } = makeBoard({ owner, columns: ['To Do', 'On Hold', 'Waiting', 'In Progress', 'Complete'] });
		const holdToHold = makeCard(cols['On Hold'], { title: 'On Hold to Waiting', onHoldNote: NOTE });
		const intoHold = makeCard(cols['To Do'], { title: 'To Do to On Hold', onHoldNote: NOTE });
		const withinHold = makeCard(cols['On Hold'], { title: 'Within On Hold', onHoldNote: NOTE, position: 3 });
		const working = makeCard(cols['In Progress'], { title: 'In Progress to Complete', onHoldNote: NOTE });
		const drop = (id: number, columnId: number, position: number) =>
			api('PUT', '/api/cards/reorder', { user: owner, body: { updates: [{ id, columnId, position }] } });

		expect((await drop(holdToHold.id, cols['Waiting'].id, 0)).status).toBe(200);
		expect((await drop(intoHold.id, cols['On Hold'].id, 0)).status).toBe(200);
		expect((await drop(withinHold.id, cols['On Hold'].id, 1)).status).toBe(200);
		expect((await drop(working.id, cols['Complete'].id, 0)).status).toBe(200);

		expect(cardRow(holdToHold.id)).toMatchObject({ columnId: cols['Waiting'].id, onHoldNote: NOTE });
		expect(cardRow(intoHold.id)).toMatchObject({ columnId: cols['On Hold'].id, onHoldNote: NOTE });
		expect(cardRow(withinHold.id)).toMatchObject({ position: 1, onHoldNote: NOTE });
		expect(cardRow(working.id)).toMatchObject({ columnId: cols['Complete'].id, onHoldNote: NOTE });
	});

	it.each(routes)('%s, refused as a completion with an open subtask, keeps the note with everything else', async (_, move) => {
		const s = held();
		makeSubtask(s.card, { completed: false });
		const before = snapshotDb();

		const res = await move(s, s.A.cols['Complete'].id);

		expect(res.status).toBe(409);
		expectUnchanged(before);
	});

	it('records the move and nothing else: no card_updated, no card.updated, one update event', async () => {
		const s = held();
		makeWebhook(s.A.board);
		const sent = effects();

		try {
			const res = await routes[0][1](s, s.A.cols['In Progress'].id);
			await sent.settle();

			expect(res.status).toBe(200);
			expect(actions()).toEqual(['card_moved']);
			expect(sent.webhooks.map((w) => w.event)).toEqual(['card.moved']);
			expect(sent.events.map((e) => e.event)).toEqual(['update']);
		} finally {
			sent.restore();
		}
	});

	it('on PUT /api/cards/:id, does not write back the note the card held, sent with the move, and writes a new one', async () => {
		const s = held();
		const other = makeCard(s.A.cols['On Hold'], { title: 'Paused too', onHoldNote: NOTE });
		const inProgress = s.A.cols['In Progress'].id;

		const echoed = await api('PUT', `/api/cards/${s.card.id}`, { user: s.owner, body: { columnId: inProgress, onHoldNote: NOTE } });
		const renewed = await api('PUT', `/api/cards/${other.id}`, { user: s.owner, body: { columnId: inProgress, onHoldNote: 'new reason' } });

		expect([echoed.status, renewed.status]).toEqual([200, 200]);
		expect(cardRow(s.card.id).onHoldNote).toBe('');
		expect(echoed.body.onHoldNote).toBe('');
		expect(cardRow(other.id)).toMatchObject({ columnId: inProgress, onHoldNote: 'new reason' });
	});

	it('leaves the card out of the activity report’s on hold bucket once it has moved on', async () => {
		const s = held();

		expect((await routes[2][1](s, s.A.cols['In Progress'].id)).status).toBe(200);
		const res = await api('GET', `/api/v1/reports/activity?boardIds=${s.A.board.id}`, { user: s.owner });

		expect(res.status).toBe(200);
		const reported = res.body.boards.flatMap((b: { cards: { id: number; bucket: string }[] }) => b.cards);
		expect(reported.map((c: { id: number }) => c.id)).toContain(s.card.id);
		expect(reported.find((c: { id: number }) => c.id === s.card.id).bucket).not.toBe('on hold');
	});
});

describe('the requester of a card', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	it('is mailed that it moved, after the commit', async () => {
		const { owner, A, first } = scene();
		makeRequestFor(first, owner);

		await api('PUT', `/api/v1/cards/${first.id}/move`, { user: owner, body: { columnId: A.cols['In Progress'].id } });
		await sent.settle();

		expect(sent.emails.map((e) => `${e.to}: ${e.subject}`)).toEqual([
			'rita@example.test: Your request moved: Please build this → In Progress'
		]);
		expect(sent.duringTransaction).toEqual([]);
	});

	it('is mailed the report when it is completed, which is built after the commit', async () => {
		const { owner, A, first } = scene();
		makeRequestFor(first, owner);

		await api('PUT', `/api/v1/cards/${first.id}/move`, { user: owner, body: { columnId: A.cols['Complete'].id } });

		// The PDF takes a moment; the move has long since been answered.
		const report = await vi.waitFor(
			() => {
				const mail = sent.emails.find((e) => e.to === 'rita@example.test');
				expect(mail).toBeDefined();
				return mail!;
			},
			{ timeout: 10_000 }
		);
		expect(report.subject).toBe('Your request is complete: Please build this ✅');
		expect(report.attachments).toHaveLength(1);
		expect(report.attachments[0]).toMatch(/^dumpfire-task-report-.*\.pdf$/);
		expect(sent.duringTransaction).toEqual([]);
	});
});

/**
 * Who is mailed that a card moved (card 2180). Taking someone off a board, or
 * out of the team it is shared with, leaves them assigned to its cards, and
 * the "Card moved" mail told them the card's title, who moved it and the
 * board's name. An assignee is now mailed only when they can open the board
 * the card is on after the move. Preferences decide after that, as before.
 */
describe('who is mailed that a card moved (card 2180)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	/** The usernames mailed "Card moved", in the order mailed. */
	const mailedMoved = () =>
		sent.emails.filter((e) => e.subject.startsWith('Card moved: ')).map((e) => e.to.replace('@example.test', ''));

	/**
	 * A card on A assigned to `gone` (an editor of A whose membership is then
	 * deleted), `member` (a viewer of A), `teamMate` (in a team A is shared
	 * with) and `boss` (an administrator who is not on A).
	 */
	function world() {
		makeSmtp();
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'A' });
		const gone = makeUser({ username: 'gone' });
		const member = makeUser({ username: 'member' });
		const teamMate = makeUser({ username: 'teammate' });
		const boss = makeUser({ username: 'boss', role: 'admin' });
		addBoardMember(A.board, gone, 'editor');
		addBoardMember(A.board, member, 'viewer');
		const team = makeTeam([teamMate]);
		shareBoardWithTeam(A.board, team, 'viewer');
		const card = makeCard(A.cols['To Do'], { title: 'Secret' });
		for (const user of [gone, member, teamMate, boss]) assignCard(card, user);
		db.delete(boardMembers).where(eq(boardMembers.userId, gone.id)).run();
		return { owner, A, teamMate, card };
	}

	it('mails the assignees who can open the board, and not one taken off it, on both page routes', async () => {
		const { owner, A, card } = world();

		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { columnId: A.cols['In Progress'].id } })).status).toBe(200);
		await sent.settle();
		expect(mailedMoved().sort()).toEqual(['boss', 'member', 'teammate']);

		sent.clear();
		const drag = { updates: [{ id: card.id, columnId: A.cols['On Hold'].id, position: 0 }] };
		expect((await api('PUT', '/api/cards/reorder', { user: owner, body: drag })).status).toBe(200);
		await sent.settle();
		expect(mailedMoved().sort()).toEqual(['boss', 'member', 'teammate']);
	});

	it('does not mail an assignee taken out of the team the board is shared with', async () => {
		const { owner, A, teamMate, card } = world();
		db.delete(teamMembers).where(eq(teamMembers.userId, teamMate.id)).run();

		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { columnId: A.cols['In Progress'].id } })).status).toBe(200);
		await sent.settle();

		expect(mailedMoved().sort()).toEqual(['boss', 'member']);
	});

	/**
	 * A card on A assigned to `onlyA` (an editor of A) and `both` (an editor of
	 * A and of BRAVO), moved to BRAVO. The mail names the board the card is on
	 * now, so it goes only to whoever can open that one.
	 */
	function acrossBoards() {
		makeSmtp();
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'BRAVO' });
		const onlyA = makeUser({ username: 'onlya' });
		const both = makeUser({ username: 'both' });
		addBoardMember(A.board, onlyA, 'editor');
		addBoardMember(A.board, both, 'editor');
		addBoardMember(B.board, both, 'editor');
		const card = makeCard(A.cols['To Do'], { title: 'Travels' });
		assignCard(card, onlyA);
		assignCard(card, both);
		return { owner, B, card };
	}

	it('mails, of a card moved to another board, only the assignees who can open that board', async () => {
		const { owner, B, card } = acrossBoards();

		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { columnId: B.cols['In Progress'].id } })).status).toBe(200);
		await sent.settle();

		expect(mailedMoved()).toEqual(['both']);
		expect(sent.emails[0].html).toContain('Board: BRAVO');
	});

	it('mails the same for a completion on another board through the API', async () => {
		const { owner, B, card } = acrossBoards();

		const res = await api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: B.cols['Complete'].id } });
		expect(res.status).toBe(200);
		await sent.settle();

		expect(mailedMoved()).toEqual(['both']);
	});
});

/**
 * Card 2152. The "Unblocked" comment is stored once and read by everyone who
 * can open the waiting card's board, so it names the finished work only when
 * that work is on the same board (decision 6). The mail is one person's, so
 * each assignee is told the title when they can open the finished work's
 * board, and P1's words when not (decision 7); only an assignee who can open
 * the waiting card's board is mailed at all (R4, card 2180).
 */
describe('the "Unblocked" notice of work on another board (card 2152)', () => {
	let sent: Effects;
	beforeEach(() => {
		sent = effects();
	});
	afterEach(() => sent.restore());

	/**
	 * W on board A waits on X on board BRAVO. W is assigned to `editsA` (an
	 * editor of A only), `both` (an editor of A and BRAVO) and `gone` (assigned,
	 * then taken off A).
	 */
	function world() {
		makeSmtp();
		const owner = makeUser({ username: 'owner' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'BRAVO' });
		const editsA = makeUser({ username: 'editsa' });
		const both = makeUser({ username: 'both' });
		const gone = makeUser({ username: 'gone' });
		addBoardMember(A.board, editsA, 'editor');
		addBoardMember(A.board, both, 'editor');
		addBoardMember(B.board, both, 'editor');
		const W = makeCard(A.cols['To Do'], { title: 'Waiting work' });
		const X = makeCard(B.cols['To Do'], { title: 'XSECRET2152' });
		for (const user of [editsA, both, gone]) assignCard(W, user);
		return { owner, A, B, editsA, both, W, X };
	}

	const mailTo = (username: string) => sent.emails.find((e) => e.to === `${username}@example.test`);

	it('names a card on another board by its number in the comment, and by its title only to an assignee who can open that board', async () => {
		const { owner, B, W, X } = world();
		makeDependency({ blocked: W, blocker: X });

		const res = await api('PUT', `/api/v1/cards/${X.id}/move`, { user: owner, body: { columnId: B.cols['Complete'].id } });
		expect(res.status).toBe(200);
		await sent.settle();

		expect(notices().map((n) => ({ cardId: n.cardId, content: n.content }))).toEqual([
			{ cardId: W.id, content: `Unblocked: #${X.id}, a card on another board, completed — nothing is blocking this card now.` }
		]);
		expect(notices().filter((n) => n.content.includes('XSECRET2152'))).toEqual([]);

		const unblocked = sent.emails.filter((e) => e.subject === 'Unblocked: Waiting work');
		expect(unblocked.map((e) => e.to).sort()).toEqual(['both@example.test', 'editsa@example.test']);
		expect(mailTo('editsa')!.html).toContain(`#${X.id} <strong>A card on a board you cannot open</strong>`);
		expect(mailTo('editsa')!.html).not.toContain('XSECRET2152');
		expect(mailTo('both')!.html).toContain(`#${X.id} <strong>XSECRET2152</strong>`);
	});

	it('names a subtask on another board as a subtask, never by its id, in the comment and the mail', async () => {
		const { owner, W, X } = world();
		const step = makeSubtask(X, { title: 'STEPSECRET2152', completed: false });
		makeDependency({ blocked: W, blocker: step });

		const res = await api('PUT', `/api/v1/subtasks/${step.id}`, { user: owner, body: { completed: true } });
		expect(res.status).toBe(200);
		await sent.settle();

		expect(notices().map((n) => n.content)).toEqual([
			'Unblocked: a subtask on another board completed — nothing is blocking this card now.'
		]);

		const subtaskId = new RegExp(`#${step.id}(?![0-9a-f])`);
		expect(mailTo('editsa')!.html).toContain('<strong>A subtask on a board you cannot open</strong>');
		expect(mailTo('editsa')!.html).not.toContain('STEPSECRET2152');
		expect(mailTo('both')!.html).toContain('the subtask <strong>STEPSECRET2152</strong>');
		for (const mail of sent.emails) expect(mail.html).not.toMatch(subtaskId);
		expect(mailTo('gone')).toBeUndefined();
	});

	it('names work on the same board by its title, in the comment and the mail, as before', async () => {
		const { owner, A, W, editsA } = world();
		const Y = makeCard(A.cols['To Do'], { title: 'Same board blocker' });
		makeDependency({ blocked: W, blocker: Y });

		expect((await api('PUT', `/api/v1/cards/${Y.id}/move`, { user: owner, body: { columnId: A.cols['Complete'].id } })).status).toBe(200);
		await sent.settle();

		expect(notices().map((n) => n.content)).toEqual([
			`Unblocked: #${Y.id} "Same board blocker" completed — nothing is blocking this card now.`
		]);
		expect(mailTo(editsA.username)!.html).toContain(`#${Y.id} <strong>Same board blocker</strong>`);
	});
});

/**
 * Card 2256. A notice names the finished work by its title only when that
 * work is on the waiting card's board (card 2152), but the comment went with
 * the card to another board, where it went on naming the work to people who
 * cannot open the board it is on. A move to another board rewrites the card's
 * named notices to the withheld form, in the move's transaction, and leaves
 * `updatedAt` alone, so the card window shows no "(edited)".
 */
describe('a move to another board withholds the names in the card\'s "Unblocked" notices (card 2256)', () => {
	/** Boards A and BRAVO, both the owner's; `readsB` is a viewer of BRAVO alone. W, on A, waits. */
	function world() {
		const owner = makeUser({ username: 'owner' });
		const readsB = makeUser({ username: 'readsb' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'BRAVO' });
		addBoardMember(B.board, readsB, 'viewer');
		const W = makeCard(A.cols['To Do'], { title: 'Waiting work' });
		return { owner, readsB, A, B, W };
	}

	const move = (card: Card, columnId: number, user: SessionUser) =>
		api('PUT', `/api/v1/cards/${card.id}/move`, { user, body: { columnId } });
	const contents = (cardId: number) =>
		notices()
			.filter((n) => n.cardId === cardId)
			.map((n) => n.content);

	/** Both comment routes, as `user`: each answers 200. The API writes the times in ISO form. */
	async function commentsAs(user: SessionUser, card: Card) {
		const web = await api('GET', `/api/cards/${card.id}/comments`, { user });
		const v1 = await api('GET', `/api/v1/cards/${card.id}/comments`, { user });
		expect(web.status).toBe(200);
		expect(v1.status).toBe(200);
		return [web.body, v1.body] as { content: string; createdAt: string; updatedAt: string }[][];
	}

	it('names a card of the board it left by its number alone, to a reader of the board it arrived on, without marking the comment edited', async () => {
		const { owner, readsB, A, B, W } = world();
		const Y = makeCard(A.cols['To Do'], { title: 'YSECRET2256' });
		makeDependency({ blocked: W, blocker: Y });
		expect((await move(Y, A.cols['Complete'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([`Unblocked: #${Y.id} "YSECRET2256" completed — nothing is blocking this card now.`]);
		// Written a while ago, so a rewrite that stamped the comment could not pass by landing in the same second.
		db.update(cardComments).set({ createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00' }).run();

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(notices().map((n) => [n.createdAt, n.updatedAt])).toEqual([['2026-10-01 09:00:00', '2026-10-01 09:00:00']]);
		for (const read of await commentsAs(readsB, W)) {
			expect(read.map((c) => c.content)).toEqual([
				`Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`
			]);
			expect(JSON.stringify(read)).not.toContain('YSECRET2256');
			expect(read[0].updatedAt).toBe(read[0].createdAt);
		}
	});

	it('names a subtask of the board it left as a subtask, keeping the rest of the sentence', async () => {
		const { owner, A, B, W } = world();
		const Q = makeCard(A.cols['To Do'], { title: 'Holds the step' });
		const step = makeSubtask(Q, { title: 'STEPSECRET2256', completed: false });
		const review = makeSubtask(W, { title: 'Review it', completed: false });
		makeDependency({ blocked: review, blocker: step });
		expect((await api('PUT', `/api/v1/subtasks/${step.id}`, { user: owner, body: { completed: true } })).status).toBe(200);
		expect(contents(W.id)).toEqual(['Unblocked: subtask "STEPSECRET2256" completed — nothing is blocking subtask "Review it" now.']);

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual(['Unblocked: a subtask on another board completed — nothing is blocking subtask "Review it" now.']);
	});

	it("keeps a notice named when every subtask it names is one of the card's own, which travel with it", async () => {
		const { owner, A, B, W } = world();
		const first = makeSubtask(W, { title: 'First step', completed: false });
		const second = makeSubtask(W, { title: 'Second step', completed: false });
		makeDependency({ blocked: second, blocker: first });
		const Q = makeCard(A.cols['To Do'], { title: 'Holds the step' });
		const elsewhere = makeSubtask(Q, { title: 'ELSEWHERE2256', completed: false });
		const third = makeSubtask(W, { title: 'Third step', completed: false });
		makeDependency({ blocked: third, blocker: elsewhere });
		for (const done of [first, elsewhere]) {
			expect((await api('PUT', `/api/v1/subtasks/${done.id}`, { user: owner, body: { completed: true } })).status).toBe(200);
		}
		const own = 'Unblocked: subtask "First step" completed — nothing is blocking subtask "Second step" now.';
		expect(contents(W.id)).toEqual([own, 'Unblocked: subtask "ELSEWHERE2256" completed — nothing is blocking subtask "Third step" now.']);
		// The card form of the tail, and a tail naming a subtask that is not the card's.
		const ownWholeCard = makeComment(W, owner, 'Unblocked: subtask "First step" completed — nothing is blocking this card now.');
		makeComment(W, owner, 'Unblocked: subtask "First step" completed — nothing is blocking subtask "NOTHERE2256" now.');

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([
			own,
			'Unblocked: a subtask on another board completed — nothing is blocking subtask "Third step" now.',
			ownWholeCard.content,
			'Unblocked: a subtask on another board completed — nothing is blocking subtask "NOTHERE2256" now.'
		]);
	});

	it('leaves a notice already withheld as it is, and a card named on the board the card arrives on named', async () => {
		const { owner, A, B, W } = world();
		const X = makeCard(B.cols['To Do'], { title: 'On BRAVO' });
		makeDependency({ blocked: W, blocker: X });
		expect((await move(X, B.cols['Complete'].id, owner)).status).toBe(200);
		const withheld = `Unblocked: #${X.id}, a card on another board, completed — nothing is blocking this card now.`;
		expect(contents(W.id)).toEqual([withheld]);

		// Named on A, then the work named moved to BRAVO itself (decision 2).
		// That move withholds the name on V since card 2261; a notice left named
		// by a move made before card 2261 was deployed is made here as it stands.
		const V = makeCard(A.cols['To Do'], { title: 'Waiting too' });
		const Z = makeCard(A.cols['To Do'], { title: 'Goes ahead' });
		makeDependency({ blocked: V, blocker: Z });
		expect((await move(Z, A.cols['Complete'].id, owner)).status).toBe(200);
		expect((await move(Z, B.cols['Complete'].id, owner)).status).toBe(200);
		const zWithheld = `Unblocked: #${Z.id}, a card on another board, completed — nothing is blocking this card now.`;
		expect(contents(V.id)).toEqual([zWithheld]);
		const leftNamed = makeComment(V, owner, `Unblocked: #${Z.id} "Goes ahead" completed — nothing is blocking this card now.`);

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);
		expect((await move(V, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([withheld]);
		expect(contents(V.id)).toEqual([zWithheld, leftNamed.content]);
	});

	it('does not name the work again when the card comes back to its board', async () => {
		const { owner, A, B, W } = world();
		const Z = makeCard(A.cols['To Do'], { title: 'ZSECRET2256' });
		makeDependency({ blocked: W, blocker: Z });
		expect((await move(Z, A.cols['Complete'].id, owner)).status).toBe(200);

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);
		expect((await move(W, A.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([`Unblocked: #${Z.id}, a card on another board, completed — nothing is blocking this card now.`]);
	});

	it('leaves a move within one board, and every comment that is not exactly a named notice, as they were', async () => {
		const { owner, A, B, W } = world();
		const Y = makeCard(A.cols['To Do'], { title: 'Same board' });
		const named = makeComment(W, owner, `Unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now.`);
		const others = [
			'Unblocked: the supplier rang back',
			`Unblocked: #${Y.id} "Same board" completed`,
			`unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now.`,
			`Note — Unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now.`,
			`Unblocked: see below. Unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now.`,
			`Unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now. Thanks!`,
			'Unblocked: subtask "Step" completed — nothing is blocking this card now. It was blocked again later.'
		].map((content) => makeComment(W, owner, content));

		expect((await move(W, A.cols['In Progress'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([named.content, ...others.map((c) => c.content)]);

		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([
			`Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`,
			...others.map((c) => c.content)
		]);
		expect(cardRow(W.id).columnId).toBe(B.cols['To Do'].id);
	});

	it('rewrites nothing for a move that is refused', async () => {
		const blocked = world();
		const Y = makeCard(blocked.A.cols['To Do'], { title: 'Same board' });
		makeComment(blocked.W, blocked.owner, `Unblocked: #${Y.id} "Same board" completed — nothing is blocking this card now.`);
		makeSubtask(blocked.W, { title: 'Still open', completed: false });
		const before = contents(blocked.W.id);
		expect((await move(blocked.W, blocked.B.cols['Complete'].id, blocked.owner)).status).toBe(409);
		expect(contents(blocked.W.id)).toEqual(before);
	});

	it("is part of the move: a move failing at any one of its writes, the rewrite's own included, leaves every comment as it was", async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const w = world();
				const Y = makeCard(w.A.cols['To Do'], { title: 'YSECRET2256' });
				makeComment(w.W, w.owner, `Unblocked: #${Y.id} "YSECRET2256" completed — nothing is blocking this card now.`);
				return w;
			},
			request: ({ owner, W, B }) => move(W, B.cols['To Do'].id, owner),
			afterSuccess: (w, res) => {
				expect(res.status).toBe(200);
				expect(contents(w.W.id).join()).not.toContain('YSECRET2256');
			}
		});
		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "card_comments" set',
			'update "cards" set',
			'insert into "activity_log"',
			'insert into "activity_log"'
		]);
	});
});

/**
 * Card 2261. Card 2256 took the names out of the moving card's own notices;
 * the other direction was left. A notice on W naming Y, or one of Y's
 * subtasks, by title was written because Y was on W's board, and when Y moved
 * to another board it went on naming Y to W's readers, some of whom cannot open
 * the board Y is on now. A move to another board rewrites those notices too,
 * on every card not on the board Y arrives on, in the move's transaction, and
 * leaves `updatedAt` alone.
 */
describe('a move to another board withholds the card\'s name in other cards\' "Unblocked" notices (card 2261)', () => {
	/** Boards A and BRAVO, both the owner's; `readsA` is a viewer of A alone. W, on A, waits on Y, on A. */
	function world() {
		const owner = makeUser({ username: 'owner' });
		const readsA = makeUser({ username: 'readsa' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'BRAVO' });
		addBoardMember(A.board, readsA, 'viewer');
		const W = makeCard(A.cols['To Do'], { title: 'Waiting work' });
		const Y = makeCard(A.cols['To Do'], { title: 'YSECRET2261' });
		return { owner, readsA, A, B, W, Y };
	}

	const move = (card: Card, columnId: number, user: SessionUser) =>
		api('PUT', `/api/v1/cards/${card.id}/move`, { user, body: { columnId } });
	const contents = (cardId: number) =>
		notices()
			.filter((n) => n.cardId === cardId)
			.map((n) => n.content);
	const completeSubtask = async (subtask: Subtask, user: SessionUser) =>
		expect((await api('PUT', `/api/v1/subtasks/${subtask.id}`, { user, body: { completed: true } })).status).toBe(200);

	/** Both comment routes, as `user`: each answers 200. */
	async function commentsAs(user: SessionUser, card: Card) {
		const web = await api('GET', `/api/cards/${card.id}/comments`, { user });
		const v1 = await api('GET', `/api/v1/cards/${card.id}/comments`, { user });
		expect(web.status).toBe(200);
		expect(v1.status).toBe(200);
		return [web.body, v1.body] as { content: string; createdAt: string; updatedAt: string }[][];
	}

	it('names the moved card by its number alone on a card it left behind, to a reader of that board, without marking the comment edited', async () => {
		const { owner, readsA, A, B, W, Y } = world();
		makeDependency({ blocked: W, blocker: Y });
		expect((await move(Y, A.cols['Complete'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([`Unblocked: #${Y.id} "YSECRET2261" completed — nothing is blocking this card now.`]);
		// Written a while ago, so a rewrite that stamped the comment could not pass by landing in the same second.
		db.update(cardComments).set({ createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00' }).run();

		expect((await move(Y, B.cols['Complete'].id, owner)).status).toBe(200);

		expect(notices().map((n) => [n.cardId, n.createdAt, n.updatedAt])).toEqual([[W.id, '2026-10-01 09:00:00', '2026-10-01 09:00:00']]);
		for (const read of await commentsAs(readsA, W)) {
			expect(read.map((c) => c.content)).toEqual([
				`Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`
			]);
			expect(JSON.stringify(read)).not.toContain('YSECRET2261');
			expect(read[0].updatedAt).toBe(read[0].createdAt);
		}
	});

	it("names a subtask of the moved card as a subtask on the cards that waited on it, through the dependency rows, keeping the rest of the sentence", async () => {
		const { owner, A, B, W, Y } = world();
		const S = makeSubtask(Y, { title: 'SSECRET2261', completed: false });
		const V = makeCard(A.cols['To Do'], { title: 'Waiting by a step' });
		const review = makeSubtask(V, { title: 'Review it', completed: false });
		makeDependency({ blocked: W, blocker: S });
		makeDependency({ blocked: review, blocker: S });
		await completeSubtask(S, owner);
		expect(contents(W.id)).toEqual(['Unblocked: subtask "SSECRET2261" completed — nothing is blocking this card now.']);
		expect(contents(V.id)).toEqual(['Unblocked: subtask "SSECRET2261" completed — nothing is blocking subtask "Review it" now.']);

		expect((await move(Y, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual(['Unblocked: a subtask on another board completed — nothing is blocking this card now.']);
		expect(contents(V.id)).toEqual(['Unblocked: a subtask on another board completed — nothing is blocking subtask "Review it" now.']);
		expect(JSON.stringify(notices())).not.toContain('SSECRET2261');
	});

	it("leaves a notice naming a subtask of the same title on a card that waited on none of the moved card's subtasks", async () => {
		const { owner, A, B, W, Y } = world();
		const S = makeSubtask(Y, { title: 'Tests and documents', completed: false });
		makeDependency({ blocked: W, blocker: S });
		await completeSubtask(S, owner);
		// Another card of A, and its own wait on a subtask of the same title on a third card.
		const U = makeCard(A.cols['To Do'], { title: 'Unrelated' });
		const Q = makeCard(A.cols['To Do'], { title: 'Has the same step' });
		const sameTitle = makeSubtask(Q, { title: 'Tests and documents', completed: false });
		makeDependency({ blocked: U, blocker: sameTitle });
		await completeSubtask(sameTitle, owner);
		const unrelated = 'Unblocked: subtask "Tests and documents" completed — nothing is blocking this card now.';
		expect(contents(U.id)).toEqual([unrelated]);
		// And on W, a notice naming a subtask that is not one W waited on of the moved card's.
		const otherStep = makeComment(W, owner, 'Unblocked: subtask "Some other step" completed — nothing is blocking this card now.');

		expect((await move(Y, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([
			'Unblocked: a subtask on another board completed — nothing is blocking this card now.',
			otherStep.content
		]);
		expect(contents(U.id)).toEqual([unrelated]);
	});

	it("leaves a subtask notice named when the card also waited on a subtask of the same title that is not the moved card's, which may have written it (the review)", async () => {
		const { owner, A, B, W, Y } = world();
		const Q = makeCard(A.cols['To Do'], { title: 'Stays on A' });
		const ofY = makeSubtask(Y, { title: 'Tests', completed: false });
		const ofQ = makeSubtask(Q, { title: 'Tests', completed: false });
		makeDependency({ blocked: W, blocker: ofY });
		makeDependency({ blocked: W, blocker: ofQ });
		await completeSubtask(ofY, owner);
		expect(contents(W.id)).toEqual([]);
		// Q's "Tests", the last of W's blockers, writes the notice: it names Q's subtask, not Y's.
		await completeSubtask(ofQ, owner);
		const named = 'Unblocked: subtask "Tests" completed — nothing is blocking this card now.';
		expect(contents(W.id)).toEqual([named]);

		expect((await move(Y, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([named]);
	});

	it('leaves a notice on a card of the board the moved card arrives on as it is: named there, withheld or not', async () => {
		const { owner, A, B, Y } = world();
		// On BRAVO, waiting on Y while Y was on A: written withheld (card 2152).
		const onB = makeCard(B.cols['To Do'], { title: 'On BRAVO' });
		makeDependency({ blocked: onB, blocker: Y });
		expect((await move(Y, A.cols['Complete'].id, owner)).status).toBe(200);
		const withheld = `Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`;
		expect(contents(onB.id)).toEqual([withheld]);
		// And on BRAVO, notices naming Y and a subtask of Y one waited on, as notices written had Y been there would.
		const named = makeComment(onB, owner, `Unblocked: #${Y.id} "YSECRET2261" completed — nothing is blocking this card now.`);
		const S = makeSubtask(Y, { title: 'Step of Y', completed: true });
		const stepOnB = makeCard(B.cols['To Do'], { title: 'Waited on the step' });
		makeDependency({ blocked: stepOnB, blocker: S });
		const namedStep = makeComment(stepOnB, owner, 'Unblocked: subtask "Step of Y" completed — nothing is blocking this card now.');

		expect((await move(Y, B.cols['Complete'].id, owner)).status).toBe(200);

		expect(contents(onB.id)).toEqual([withheld, named.content]);
		expect(contents(stepOnB.id)).toEqual([namedStep.content]);
	});

	it('keeps the notice withheld when the card it is on follows the moved card to its board', async () => {
		const { owner, A, B, W, Y } = world();
		makeDependency({ blocked: W, blocker: Y });
		expect((await move(Y, A.cols['Complete'].id, owner)).status).toBe(200);

		expect((await move(Y, B.cols['Complete'].id, owner)).status).toBe(200);
		expect((await move(W, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([`Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`]);
	});

	it("leaves a notice naming another card whose number begins with the moved card's", async () => {
		const { owner, B, W, Y } = world();
		const longer = makeComment(W, owner, `Unblocked: #${Y.id}7 "Another card" completed — nothing is blocking this card now.`);

		expect((await move(Y, B.cols['To Do'].id, owner)).status).toBe(200);

		expect(contents(W.id)).toEqual([longer.content]);
	});

	it("leaves a move within one board, and a person's comment that mentions the card, as they were", async () => {
		const { owner, A, B, W, Y } = world();
		const named = makeComment(W, owner, `Unblocked: #${Y.id} "YSECRET2261" completed — nothing is blocking this card now.`);
		const others = [
			`Waiting on #${Y.id} "YSECRET2261" still`,
			`Unblocked: #${Y.id} "YSECRET2261" completed`,
			`Unblocked: #${Y.id} "YSECRET2261" completed — nothing is blocking this card now. Thanks!`
		].map((content) => makeComment(W, owner, content));

		expect((await move(Y, A.cols['In Progress'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([named.content, ...others.map((c) => c.content)]);

		expect((await move(Y, B.cols['To Do'].id, owner)).status).toBe(200);
		expect(contents(W.id)).toEqual([
			`Unblocked: #${Y.id}, a card on another board, completed — nothing is blocking this card now.`,
			...others.map((c) => c.content)
		]);
	});

	it('rewrites nothing for a move that is refused', async () => {
		const { owner, B, W, Y } = world();
		makeComment(W, owner, `Unblocked: #${Y.id} "YSECRET2261" completed — nothing is blocking this card now.`);
		makeSubtask(Y, { title: 'Still open', completed: false });
		const before = contents(W.id);

		expect((await move(Y, B.cols['Complete'].id, owner)).status).toBe(409);

		expect(contents(W.id)).toEqual(before);
	});

	it("is part of the move: a move failing at any one of its writes, the rewrite's own included, leaves the other card's notice named", async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const w = world();
				makeComment(w.W, w.owner, `Unblocked: #${w.Y.id} "YSECRET2261" completed — nothing is blocking this card now.`);
				return w;
			},
			request: ({ owner, Y, B }) => move(Y, B.cols['To Do'].id, owner),
			afterSuccess: (w, res) => {
				expect(res.status).toBe(200);
				expect(contents(w.W.id).join()).not.toContain('YSECRET2261');
			}
		});
		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "card_comments" set',
			'update "cards" set',
			'insert into "activity_log"',
			'insert into "activity_log"'
		]);
	});
});

/**
 * Card 2155. A milestone of a board holds only that board's cards: putting a
 * card of another board in one is refused (`setCardMilestone`, the bulk
 * attach), and a move to another board takes the card out of one, in the
 * move's own write of the card, for every route (decision 10). A goal across
 * boards keeps its cards. The source board's `card_moved_away` entry says so
 * (decision 11).
 */
describe('a move to another board takes the card out of a milestone of another board (card 2155)', () => {
	/**
	 * Boards A and BRAVO, both the owner's; `reader` is a viewer of A only. The
	 * card is on A, in A's milestone "Goal M", with a neighbour that stays.
	 */
	function world() {
		const owner = makeUser({ username: 'owner' });
		const reader = makeUser({ username: 'reader' });
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'BRAVO' });
		addBoardMember(A.board, reader, 'viewer');
		const card = makeCard(A.cols['To Do'], { title: 'MOVEDSECRET2155' });
		const stays = makeCard(A.cols['To Do'], { title: 'Stays' });
		const M = makeMilestone({ board: A.board, name: 'Goal M', cards: [card, stays] });
		return { owner, reader, A, B, card, stays, M };
	}

	const movedAway = (boardId: number, cardId: number) =>
		db
			.select()
			.from(activityLog)
			.all()
			.filter((e) => e.boardId === boardId && e.cardId === cardId && e.action.endsWith('card_moved_away'))
			.map((e) => e.detail);

	/** What a viewer of A reads of M afterwards: no title of the card, and a count of the one left. */
	async function readerSeesOnly(w: ReturnType<typeof world>) {
		const res = await api('GET', `/api/v1/milestones/${w.M.id}`, { user: w.reader });
		expect(res.status).toBe(200);
		expect(res.body.cards.map((c: { id: number }) => c.id)).toEqual([w.stays.id]);
		expect(JSON.stringify(res.body)).not.toContain('MOVEDSECRET2155');
		const listed = listMilestones(w.reader).find((m) => m.id === w.M.id)!;
		expect(listed).toMatchObject({ cardCount: 1, boardIds: [w.A.board.id] });
	}

	it('through the API, in the move itself, all or nothing, and says so on the board it left', async () => {
		const run = await eachWriteInTurn({
			build: world,
			request: ({ owner, card, B }) =>
				api('PUT', `/api/v1/cards/${card.id}/move`, { user: owner, body: { columnId: B.cols['In Progress'].id } }),
			afterSuccess: async (w, res) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: w.card.id, boardId: w.B.board.id, milestoneId: null });
				// Whoever moved it is told which goal it left (the review's O3).
				expect(res.body.leftMilestone).toEqual({ id: w.M.id, name: 'Goal M' });
				expect(cardRow(w.card.id).milestoneId).toBeNull();
				expect(cardRow(w.stays.id).milestoneId).toBe(w.M.id);
				expect(movedAway(w.A.board.id, w.card.id)).toEqual([
					'"MOVEDSECRET2155" moved to another board (To Do → In Progress) and out of milestone "Goal M"'
				]);
				await readerSeesOnly(w);
			}
		});

		// The milestone goes in the same write of the card: nothing more is written.
		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "cards" set',
			'insert into "activity_log"',
			'insert into "activity_log"'
		]);
	});

	it('from the card window and All Tasks, by the same rule', async () => {
		const w = world();

		const res = await api('PUT', `/api/cards/${w.card.id}`, { user: w.owner, body: { columnId: w.B.cols['To Do'].id } });

		expect(res.status).toBe(200);
		expect(res.body.milestoneId).toBeNull();
		// All Tasks says so in a toast, from this (the review's O3).
		expect(res.body.leftMilestone).toEqual({ id: w.M.id, name: 'Goal M' });
		expect(cardRow(w.card.id).milestoneId).toBeNull();
		expect(movedAway(w.A.board.id, w.card.id)).toEqual([
			'"MOVEDSECRET2155" moved to another board (To Do → To Do) and out of milestone "Goal M"'
		]);
		await readerSeesOnly(w);
	});

	it('takes a card out of a milestone of a third board too, without naming it', async () => {
		const w = world();
		const C = makeBoard({ owner: w.owner, name: 'CHARLIE' });
		const third = makeMilestone({ board: C.board, name: 'THIRDSECRET', cards: [w.card] });

		const res = await api('PUT', `/api/v1/cards/${w.card.id}/move`, { user: w.owner, body: { columnId: w.B.cols['To Do'].id } });
		expect(res.status).toBe(200);
		// Not named to the mover either: a third board's goal is not theirs to read.
		expect(res.body.leftMilestone).toBeNull();
		expect(JSON.stringify(res.body)).not.toContain('THIRDSECRET');

		expect(cardRow(w.card.id).milestoneId).toBeNull();
		expect(third.id).not.toBe(w.M.id);
		expect(movedAway(w.A.board.id, w.card.id)).toEqual([
			'"MOVEDSECRET2155" moved to another board (To Do → To Do) and out of a milestone of another board'
		]);
	});

	it('leaves the milestone of a card in a goal across boards, of one moved within its board, and of one arriving on its milestone\'s board', async () => {
		const w = world();
		const across = makeCard(w.A.cols['To Do'], { title: 'Across' });
		const goal = makeMilestone({ name: 'Across boards', cards: [across] });
		const arriving = makeCard(w.A.cols['To Do'], { title: 'Arriving' });
		// Written by hand: nothing puts a card of A in a milestone of BRAVO.
		const ofB = makeMilestone({ board: w.B.board, name: 'Goal of BRAVO', cards: [arriving] });

		const move = (card: Card, columnId: number) => api('PUT', `/api/v1/cards/${card.id}/move`, { user: w.owner, body: { columnId } });
		const answers = [
			await move(across, w.B.cols['To Do'].id),
			await move(w.card, w.A.cols['In Progress'].id),
			await move(arriving, w.B.cols['To Do'].id),
			// A save of the card window that moves nothing.
			await api('PUT', `/api/cards/${w.card.id}`, { user: w.owner, body: { title: 'MOVEDSECRET2155 renamed' } })
		];
		for (const res of answers) {
			expect(res.status).toBe(200);
			expect(res.body.leftMilestone).toBeNull();
		}

		expect(cardRow(across.id).milestoneId).toBe(goal.id);
		expect(cardRow(w.card.id).milestoneId).toBe(w.M.id);
		expect(cardRow(arriving.id).milestoneId).toBe(ofB.id);
		for (const card of [across, arriving]) {
			expect(movedAway(w.A.board.id, card.id)).toEqual([
				`"${card.title}" moved to another board (To Do → To Do)`
			]);
		}
	});
});

describe('PUT /api/subtasks/:id', () => {
	/** `first` has one open subtask, and `waiting` waits on that subtask alone. */
	const withStep = () => {
		const s = scene();
		db.delete(workDependencies).run();
		const step = makeSubtask(s.first, { title: 'Write it', completed: false });
		makeDependency({ blocked: s.waiting, blocker: step });
		makeRequestFor(s.first, s.owner);
		return { ...s, step };
	};

	it('ticks a subtask with its activity entry and its notice, or not at all', async () => {
		const run = await eachWriteInTurn({
			build: withStep,
			request: ({ owner, step }) => api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { completed: true } }),
			afterSuccess: ({ step, waiting, owner, first }, res) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: step.id, completed: true });
				expect(db.select().from(activityLog).all()).toMatchObject([
					{ action: 'subtask_completed', cardId: first.id, userId: owner.id }
				]);
				expect(notices()).toMatchObject([
					{
						cardId: waiting.id,
						userId: owner.id,
						content: 'Unblocked: subtask "Write it" completed — nothing is blocking this card now.'
					}
				]);
			}
		});

		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "subtasks" set',
			'insert into "activity_log"',
			'insert into "card_comments"'
		]);
		expect(run.effects.map(name)).toEqual([
			'event update',
			'email to assignee@example.test: Unblocked: Waiting',
			'event update',
			// The notice's comment event (card 2282).
			'event update',
			'email to rita@example.test: Subtask completed on your request: Please build this'
		]);
	});

	it('writes one notice when the same subtask is ticked twice at once', async () => {
		const { owner, step, waiting } = withStep();
		// The tick has mail to send: recorded, not sent.
		const sent = effects();

		try {
			// Both requests are past their access check and waiting for their body
			// before either writes. Each used to have read the subtask as open by
			// then, and each wrote a notice.
			const [a, b] = await Promise.all([
				api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { completed: true } }),
				api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { completed: true } })
			]);
			await sent.settle();

			expect([a.status, b.status]).toEqual([200, 200]);
			expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
			expect(actions()).toEqual(['subtask_completed']);
		} finally {
			sent.restore();
		}
	});

	it('writes nothing more when a subtask already ticked is ticked again', async () => {
		const { owner, step } = withStep();
		const sent = effects();

		try {
			// The first tick has mail to send. It is recorded, not sent, and then forgotten.
			await api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { completed: true } });
			await sent.settle();
			sent.clear();

			const again = await api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { completed: true } });
			await sent.settle();

			expect(again.status).toBe(200);
			expect(notices()).toHaveLength(1);
			expect(actions()).toEqual(['subtask_completed']);
			// Nobody is mailed a second time, and since card 2299 the page is not
			// told either: the second tick changes nothing, so it writes nothing.
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	it('answers 400 for a body with nothing to change, having written nothing', async () => {
		const { owner, step } = withStep();
		const before = snapshotDb();

		const res = await api('PUT', `/api/subtasks/${step.id}`, { user: owner, body: { cardId: 99 } });

		expect(res.status).toBe(400);
		expectUnchanged(before);
	});
});

describe('PUT /api/v1/subtasks/:id', () => {
	const withStep = () => {
		const s = scene();
		db.delete(workDependencies).run();
		const step = makeSubtask(s.first, { title: 'Write it', completed: false });
		// A subtask of another card waits on it this time.
		const blockedStep = makeSubtask(s.waiting, { title: 'Review it', completed: false });
		makeDependency({ blocked: blockedStep, blocker: step });
		return { ...s, step, blockedStep };
	};

	it('ticks a subtask with its entry and its notice, or not at all', async () => {
		const run = await eachWriteInTurn({
			build: withStep,
			request: ({ owner, step }) =>
				api('PUT', `/api/v1/subtasks/${step.id}`, { user: owner, body: { completed: true, title: 'Written' } }),
			afterSuccess: ({ step, waiting }, res) => {
				expect(res.status).toBe(200);
				expect(db.select().from(subtasks).where(eq(subtasks.id, step.id)).get()).toMatchObject({
					completed: true,
					title: 'Written'
				});
				// The notice goes on the card the unblocked subtask belongs to.
				expect(notices()).toMatchObject([
					{
						cardId: waiting.id,
						content: 'Unblocked: subtask "Written" completed — nothing is blocking subtask "Review it" now.'
					}
				]);
				// The rename has its own entry since card 2299, after the tick's.
				expect(actions()).toEqual(['api:subtask_completed', 'api:subtask_updated']);
			}
		});

		// The tick, its entry (card 2108: there was none), the rename's entry
		// (card 2299), then the notice, as `PUT /api/subtasks/:id` writes them.
		expect(run.writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' '))).toEqual([
			'update "subtasks" set',
			'insert into "activity_log"',
			'insert into "activity_log"',
			'insert into "card_comments"'
		]);
		expect(run.effects.map(name)).toEqual([
			'email to assignee@example.test: Unblocked: Review it (subtask)',
			'event update',
			// The notice's comment event (card 2282).
			'event update',
			'event update'
		]);
	});

	it('writes one notice when the same subtask is ticked twice at once', async () => {
		const { owner, step } = withStep();
		// The tick has mail to send: recorded, not sent.
		const sent = effects();

		try {
			const [a, b] = await Promise.all([
				api('PUT', `/api/v1/subtasks/${step.id}`, { user: owner, body: { completed: true } }),
				api('PUT', `/api/v1/subtasks/${step.id}`, { user: owner, body: { completed: true } })
			]);
			await sent.settle();

			expect([a.status, b.status]).toEqual([200, 200]);
			expect(notices()).toHaveLength(1);
		} finally {
			sent.restore();
		}
	});

	it('answers 403 from inside the transaction, having written nothing', async () => {
		const { step } = withStep();
		const outsider = makeUser({ username: 'outsider' });
		const before = snapshotDb();

		const res = await api('PUT', `/api/v1/subtasks/${step.id}`, { user: outsider, body: { completed: true } });

		expect(res.status).toBe(403);
		expectUnchanged(before);
	});
});

describe('the "Unblocked" notice is part of the completion', () => {
	it('cannot be written outside a transaction', () => {
		const { owner, first } = scene();

		expect(() => recordUnblocked([first.id], owner.id)).toThrow(/inside the transaction/);
		expect(notices()).toEqual([]);
	});

	it('is written for each thing that was waiting, only when nothing else blocks it, and only once', () => {
		const { owner, A, first, waiting } = scene();
		const second = makeCard(A.cols['To Do'], { title: 'Second' });
		const other = makeCard(A.cols['To Do'], { title: 'Other blocker' });
		const stillBlocked = makeCard(A.cols['To Do'], { title: 'Still blocked' });
		// `waiting` waits on two cards, and both are completed. `stillBlocked`
		// waits on both of them too, and on one that is not.
		makeDependency({ blocked: waiting, blocker: second });
		makeDependency({ blocked: stillBlocked, blocker: first });
		makeDependency({ blocked: stillBlocked, blocker: second });
		makeDependency({ blocked: stillBlocked, blocker: other });
		db.update(cards)
			.set({ columnId: A.cols['Complete'].id })
			.where(inArray(cards.id, [first.id, second.id]))
			.run();

		const written = inTransaction(() => recordUnblocked([first.id, second.id], owner.id));

		// One notice for two completions, put down to the later of them.
		expect(written).toEqual([
			{
				kind: 'card',
				id: waiting.id,
				cardId: waiting.id,
				title: 'Waiting',
				boardId: A.board.id,
				completed: { kind: 'card', id: second.id, title: 'Second', boardId: A.board.id }
			}
		]);
		expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
	});

	it('names the last of its blockers to be completed, whichever kind it is and whatever its id', () => {
		const { owner, A, first, waiting } = scene();
		const step = makeSubtask(first, { title: 'Write it', completed: true });
		const later = makeCard(A.cols['Complete'], { title: 'Made later' });
		makeDependency({ blocked: waiting, blocker: step });
		makeDependency({ blocked: waiting, blocker: later });
		db.update(cards).set({ columnId: A.cols['Complete'].id }).where(eq(cards.id, first.id)).run();

		// The order they were completed in is the order given, and it is not the
		// order of their ids or of the links.
		const written = inTransaction(() =>
			recordUnblocked([later.id, first.id, { kind: 'subtask', id: step.id }], owner.id)
		);

		expect(written.map((w) => w.completed)).toEqual([{ kind: 'subtask', id: step.id, title: 'Write it', boardId: A.board.id }]);
		expect(notices().map((n) => n.content)).toEqual([
			'Unblocked: subtask "Write it" completed — nothing is blocking this card now.'
		]);
	});

	it('writes one notice when the same completion is given twice', () => {
		const { owner, A, first, waiting } = scene();
		db.update(cards).set({ columnId: A.cols['Complete'].id }).where(eq(cards.id, first.id)).run();

		inTransaction(() => recordUnblocked([first.id, first.id], owner.id));

		expect(notices().map((n) => n.cardId)).toEqual([waiting.id]);
	});
});

describe('the batch writers that already had a transaction', () => {
	it('createDependencyBatch records every link or none', async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const owner = makeUser();
				const { cols } = makeBoard({ owner });
				const [a, b, c, d] = [1, 2, 3, 4].map(() => makeCard(cols['To Do']));
				return { owner, a, b, c, d };
			},
			request: ({ owner, a, b, c, d }) =>
				createDependencyBatch(
					[
						{ blocked: b.id, blocker: a.id },
						{ blocked: c.id, blocker: b.id },
						{ blocked: d.id, blocker: c.id }
					],
					owner.id
				),
			afterSuccess: (_, written) => {
				expect(written).toBe(3);
				expect(db.select().from(workDependencies).all()).toHaveLength(3);
			}
		});

		expect(run.writes).toHaveLength(3);
	});

	it('recordTokenUsageBatch records every entry or none', async () => {
		const run = await eachWriteInTurn({
			build: () => {
				const owner = makeUser();
				const { cols } = makeBoard({ owner });
				const card = makeCard(cols['To Do']);
				return { owner, card, step: makeSubtask(card) };
			},
			request: ({ owner, card, step }) =>
				recordTokenUsageBatch(owner, [
					{ cardId: card.id, tokens: 1200, model: 'claude-opus-5-5' },
					{ subtaskId: step.id, tokens: 800, model: 'claude-opus-5-5' }
				]),
			afterSuccess: (_, result) => {
				expect(result).toMatchObject({ written: 2, problems: [] });
				expect(db.select().from(tokenUsage).all()).toHaveLength(2);
			}
		});

		expect(run.writes).toHaveLength(2);
	});
});
