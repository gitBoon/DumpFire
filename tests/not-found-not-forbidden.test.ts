/**
 * Card 2719: an id on a board the caller cannot open is answered exactly as an
 * id that is not there.
 *
 * Board and card numbers are counted up one at a time. A `403` for a thing that
 * exists on a board the caller cannot open, beside a `404` for one that does
 * not, let anyone with an account or a key walk the numbers and learn what
 * exists on boards they will never see. So every route answers both alike: the
 * same status, 404, and the same body, byte for byte.
 *
 * Each row asks twice as a signed-in caller with no access to board A, and no
 * administrator role: once naming the thing on A, once naming an id that is no
 * row (`max(id) + 1000` of its table). One row per place a not-found sentence
 * is chosen; `access-every-route` proves the status for every route, and
 * cannot compare words with a missing id. Nothing is written by either ask.
 *
 * The rows are numbered as the plan numbers them
 * (`docs/planning/card-2719-not-found-not-forbidden.md`, 5.1).
 *
 * Card 2911 does the same for a milestone the caller cannot see: of a board
 * they cannot open, or across boards with a card on one. Its rows are numbered
 * as its plan numbers them (`docs/planning/card-2911-hidden-milestone-not-found.md`,
 * 5.1), and ask as the rows above do, naming the hidden goal and an id that is
 * no row of `milestones`.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import {
	activityLog,
	boardCategories,
	boards,
	cards,
	cardTemplates,
	categories,
	tokenUsage,
	type Board,
	type BoardCategory,
	type Card,
	type CardComment,
	type Category,
	type Column,
	type Label,
	type Milestone,
	type Subtask
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { eq } from 'drizzle-orm';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { gateRoutes } from './helpers/gate';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

// The first request through the harness starts SvelteKit's server for this file.
beforeAll(async () => {
	await gateRoutes();
}, 30_000);

/** What is on board A, which the outsider cannot open, and the outsider's own board. */
type World = {
	owner: SessionUser;
	outsider: SessionUser;
	board: Board;
	column: Column;
	card: Card;
	label: Label;
	subtask: Subtask;
	comment: CardComment;
	category: Category;
	grouping: BoardCategory;
	webhookId: number;
	templateId: number;
	tokenEntryId: number;
	ownColumn: Column;
	/** A card on the outsider's own board. */
	ownCard: Card;
	/** A goal of the outsider's, on no board. */
	ownMilestoneId: number;
	/** A label of a board the outsider can open, as a viewer, and which is not their card's. */
	viewableLabel: Label;
	/** Card 2911: a goal of board A. */
	goalOfA: Milestone;
	/**
	 * Card 2911: a goal across boards, made by the owner, holding a card of A and
	 * `inAcross`: the outsider opens one of its boards, not both.
	 */
	acrossA: Milestone;
	/** A card of the outsider's own board, in `acrossA`. */
	inAcross: Card;
	/** Card 2911: a goal across boards, made by the owner, holding only `inSeen`: the outsider sees it and did not make it. */
	seenGoal: Milestone;
	/** A card of the outsider's own board, in `seenGoal`. */
	inSeen: Card;
};

let w: World;

beforeEach(() => {
	resetDb();
	const owner = makeUser({ username: 'owner' });
	const outsider = makeUser({ username: 'outsider' });
	const { board, cols } = makeBoard({ owner, name: 'A' });
	const card = makeCard(cols['To Do'], { title: 'On A' });
	const grouping = db.insert(boardCategories).values({ name: 'Holds only A' }).returning().get();
	db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, board.id)).run();
	const ownColumn = makeBoard({ owner: outsider, name: 'Outsider' }).cols['To Do'];
	const viewable = makeBoard({ owner, name: 'Shown to the outsider' }).board;
	addBoardMember(viewable, outsider, 'viewer');
	// Card 2911's goals. `card` and `ownCard` stay in none, so card 2719's rows are as they were.
	const inAcross = makeCard(ownColumn, { title: 'The outsider’s, in a goal across boards' });
	const inSeen = makeCard(ownColumn, { title: 'The outsider’s, in a goal they see' });
	const acrossA = makeMilestone({
		createdBy: owner,
		name: 'Across A and the outsider’s board',
		cards: [makeCard(cols['To Do'], { title: 'On A, in a goal across boards' }), inAcross]
	});
	const seenGoal = makeMilestone({ createdBy: owner, name: 'Seen by the outsider', cards: [inSeen] });
	w = {
		owner,
		outsider,
		board,
		column: cols['To Do'],
		card,
		label: makeLabel(board),
		subtask: makeSubtask(card),
		comment: makeComment(card, owner),
		category: db.insert(categories).values({ boardId: board.id, name: 'A category' }).returning().get(),
		grouping,
		webhookId: makeWebhook(board).id,
		templateId: db.insert(cardTemplates).values({ boardId: board.id, name: 'On A', createdBy: owner.id }).returning().get().id,
		tokenEntryId: db.insert(tokenUsage).values({ cardId: card.id, tokens: 100, model: 'claude-opus-5-5' }).returning().get().id,
		ownColumn,
		ownCard: makeCard(ownColumn, { title: 'The outsider’s' }),
		ownMilestoneId: makeMilestone({ createdBy: outsider, name: 'The outsider’s goal' }).id,
		viewableLabel: makeLabel(viewable),
		goalOfA: makeMilestone({ board, createdBy: owner, name: 'A goal of A' }),
		acrossA,
		inAcross,
		seenGoal,
		inSeen
	};
});

/** An id that is no row of `table`. */
const missingIn = (table: string): number =>
	((sqlite.prepare(`SELECT max(id) AS m FROM ${table}`).get() as { m: number | null }).m ?? 0) + 1000;

type Answer = { status: number; body: unknown };

type Row = {
	/** The plan's row and the request. */
	name: string;
	/** The table the thing named is a row of. */
	table: string;
	/** The id of the thing on board A; in card 2911's rows, of the goal the outsider cannot see. */
	onA: (w: World) => number;
	/** The request, as the outsider, naming `id`. */
	ask: (w: World, id: number) => Promise<Answer>;
	/** Where the answer says the id it was asked about, the id taken out. */
	numbered?: true;
	/** The status both are answered: 404, unless a batch reports its entries in a 409. */
	status?: number;
};

const ROWS: Row[] = [
	{
		name: 'R1 GET /api/v1/boards/:boardId (requireBoard)',
		table: 'boards',
		onA: (w) => w.board.id,
		ask: (w, id) => api('GET', `/api/v1/boards/${id}`, { user: w.outsider })
	},
	{
		name: 'R2 GET /api/cards/:id/comments (requireCard, never Board not found)',
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('GET', `/api/cards/${id}/comments`, { user: w.outsider })
	},
	{
		name: 'R3 PUT /api/v1/columns/:columnId (requireColumn)',
		table: 'columns',
		onA: (w) => w.column.id,
		ask: (w, id) => api('PUT', `/api/v1/columns/${id}`, { user: w.outsider, body: { title: 'Renamed' } })
	},
	{
		name: 'R4 PUT /api/v1/labels/:labelId (requireLabel)',
		table: 'labels',
		onA: (w) => w.label.id,
		ask: (w, id) => api('PUT', `/api/v1/labels/${id}`, { user: w.outsider, body: { name: 'Renamed' } })
	},
	{
		name: 'R5 PUT /api/v1/subtasks/:subtaskId (requireSubtask)',
		table: 'subtasks',
		onA: (w) => w.subtask.id,
		ask: (w, id) => api('PUT', `/api/v1/subtasks/${id}`, { user: w.outsider, body: { title: 'Renamed' } })
	},
	{
		name: 'R6 GET /api/v1/categories/:categoryId, a card category of A (requireCategory)',
		table: 'categories',
		onA: (w) => w.category.id,
		ask: (w, id) => api('GET', `/api/v1/categories/${id}`, { user: w.outsider })
	},
	{
		name: 'R7 PUT /api/v1/categories/:categoryId (requireCategoryEdit)',
		table: 'categories',
		onA: (w) => w.category.id,
		ask: (w, id) => api('PUT', `/api/v1/categories/${id}`, { user: w.outsider, body: { name: 'Renamed' } })
	},
	{
		name: 'R8 POST /api/boards with parentCardId a card of A (requireParentCard)',
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('POST', '/api/boards', { user: w.outsider, body: { name: 'Under a card', parentCardId: id } })
	},
	{
		name: 'R9 POST /api/boards/:id/share (requireBoardOwner)',
		table: 'boards',
		onA: (w) => w.board.id,
		ask: (w, id) =>
			api('POST', `/api/boards/${id}/share`, { user: w.outsider, body: { type: 'user', targetId: w.outsider.id, role: 'editor' } })
	},
	{
		name: 'R10 GET /api/v1/comments/:commentId (the v1 comment GET)',
		table: 'card_comments',
		onA: (w) => w.comment.id,
		ask: (w, id) => api('GET', `/api/v1/comments/${id}`, { user: w.outsider })
	},
	{
		name: 'R11 PUT /api/v1/comments/:commentId (requireOwnComment without a card)',
		table: 'card_comments',
		onA: (w) => w.comment.id,
		ask: (w, id) => api('PUT', `/api/v1/comments/${id}`, { user: w.outsider, body: { content: 'Changed' } })
	},
	{
		name: "R12 GET /api/v1/webhooks/:webhookId (the webhook's missing words)",
		table: 'webhooks',
		onA: (w) => w.webhookId,
		ask: (w, id) => api('GET', `/api/v1/webhooks/${id}`, { user: w.outsider })
	},
	{
		name: 'R13 DELETE /api/templates/:id, saved on A (templates/[id])',
		table: 'card_templates',
		onA: (w) => w.templateId,
		ask: (w, id) => api('DELETE', `/api/templates/${id}`, { user: w.outsider })
	},
	{
		name: 'R14 DELETE /api/v1/tokens/:entryId (deleteTokenEntry)',
		table: 'token_usage',
		onA: (w) => w.tokenEntryId,
		ask: (w, id) => api('DELETE', `/api/v1/tokens/${id}`, { user: w.outsider }),
		numbered: true
	},
	{
		name: 'R15 POST /api/v1/cards/:cardId/tokens (resolveTarget)',
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('POST', `/api/v1/cards/${id}/tokens`, { user: w.outsider, body: { tokens: 100, model: 'claude-opus-5-5' } }),
		numbered: true
	},
	{
		name: 'R16 GET /api/v1/subtasks/:subtaskId/dependencies (requireWork, a subtask)',
		table: 'subtasks',
		onA: (w) => w.subtask.id,
		ask: (w, id) => api('GET', `/api/v1/subtasks/${id}/dependencies`, { user: w.outsider })
	},
	{
		name: "R17 POST /api/v1/cards/:cardId/dependencies on the caller's card, naming a card of A (the other end)",
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('POST', `/api/v1/cards/${w.ownCard.id}/dependencies`, { user: w.outsider, body: { dependsOnCardId: id } }),
		numbered: true
	},
	{
		name: 'R18 GET /api/burndown?boardIds=<A> (burndown, a board)',
		table: 'boards',
		onA: (w) => w.board.id,
		ask: (w, id) => api('GET', `/api/burndown?boardIds=${id}`, { user: w.outsider }),
		numbered: true
	},
	{
		name: 'R19 GET /api/v1/reports/activity?boardIds=<A> (activity-report)',
		table: 'boards',
		onA: (w) => w.board.id,
		ask: (w, id) => api('GET', `/api/v1/reports/activity?boardIds=${id}`, { user: w.outsider }),
		numbered: true
	},
	{
		name: 'R20 POST /api/v1/milestones with boardId A (requireMilestoneBoard)',
		table: 'boards',
		onA: (w) => w.board.id,
		ask: (w, id) => api('POST', '/api/v1/milestones', { user: w.outsider, body: { name: 'A goal', boardId: id } })
	},
	{
		name: "R21 POST /api/v1/milestones/:id/cards, the caller's goal, with a card of A (editableCard)",
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('POST', `/api/v1/milestones/${w.ownMilestoneId}/cards`, { user: w.outsider, body: { cardId: id } })
	},
	{
		name: "R22 the board page's load for board A, called directly (readBoardContents)",
		table: 'boards',
		onA: (w) => w.board.id,
		ask: async (w, id) => {
			const loaded = await pageLoad(`/board/${id}`, { user: w.outsider });
			return loaded.type === 'error' ? { status: loaded.status, body: loaded.body } : { status: 200, body: loaded };
		}
	},
	{
		name: "R23 POST /api/v1/milestones/:id/cards/bulk with a card of A: its problem reads as a missing card's (the milestone bulk)",
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) => api('POST', `/api/v1/milestones/${w.ownMilestoneId}/cards/bulk`, { user: w.outsider, body: { cardIds: [id] } }),
		numbered: true,
		status: 409
	},
	{
		name: 'R24 POST /api/v1/dependencies/bulk, a link to a card of A that is already recorded: missing-blocker, and no duplicate counted (D12)',
		table: 'cards',
		// The link the batch names is stored already: told apart, it would be counted a duplicate.
		onA: (w) => (makeDependency({ blocked: w.ownCard, blocker: w.card }), w.card.id),
		ask: (w, id) => api('POST', '/api/v1/dependencies/bulk', { user: w.outsider, body: { links: [{ blocked: w.ownCard.id, blocker: id }] } }),
		numbered: true,
		status: 409
	},
	{
		name: 'R25 POST /api/v1/cards/:cardId/labels with a label of A (addCardLabel)',
		table: 'labels',
		onA: (w) => w.label.id,
		ask: (w, id) => api('POST', `/api/v1/cards/${w.ownCard.id}/labels`, { user: w.outsider, body: { labelId: id } })
	},
	{
		name: 'R25 POST /api/v1/cards/:cardId/labels with a label of another board the caller can open (addCardLabel)',
		table: 'labels',
		onA: (w) => w.viewableLabel.id,
		ask: (w, id) => api('POST', `/api/v1/cards/${w.ownCard.id}/labels`, { user: w.outsider, body: { labelId: id } })
	},
	{
		name: "R26 PUT /api/cards/reorder naming a card of A (the reorder's present column)",
		table: 'cards',
		onA: (w) => w.card.id,
		ask: (w, id) =>
			api('PUT', '/api/cards/reorder', { user: w.outsider, body: { updates: [{ id, columnId: w.ownColumn.id, position: 0 }] } }),
		numbered: true
	},
	{
		name: 'R28 GET /api/v1/board-categories/:categoryId, a grouping holding only board A (requireBoardCategory)',
		table: 'board_categories',
		onA: (w) => w.grouping.id,
		ask: (w, id) => api('GET', `/api/v1/board-categories/${id}`, { user: w.outsider })
	},
	{
		name: 'R29 PUT /api/v1/board-categories/:categoryId, the same grouping (requireBoardCategoryEdit)',
		table: 'board_categories',
		onA: (w) => w.grouping.id,
		ask: (w, id) => api('PUT', `/api/v1/board-categories/${id}`, { user: w.outsider, body: { name: 'Renamed' } })
	},
	{
		name: 'R30 GET /api/burndown?boardCategoryId=<the grouping> (burndown, a grouping)',
		table: 'board_categories',
		onA: (w) => w.grouping.id,
		ask: (w, id) => api('GET', `/api/burndown?boardCategoryId=${id}`, { user: w.outsider }),
		numbered: true
	},
	{
		name: "R31 POST /api/report-schedules with scope 'category' and the grouping (report-schedules)",
		table: 'board_categories',
		onA: (w) => w.grouping.id,
		ask: (w, id) =>
			api('POST', '/api/report-schedules', { user: w.outsider, body: { name: 'Weekly', scope: 'category', scopeId: id, frequency: 'weekly' } })
	}
];

/** A row asked twice, naming what the outsider cannot open and an id that is no row: the same answer, and nothing written. */
async function answeredAsMissing(row: Row): Promise<void> {
	const onA = row.onA(w);
	const missing = missingIn(row.table);
	const before = snapshotDb();

	const there = await row.ask(w, onA);
	const notThere = await row.ask(w, missing);

	// Byte for byte, the same keys in the same order; the id each was asked about, where the
	// answer names it, taken out to compare the rest.
	const said = (answer: Answer, id: number) => {
		const text = JSON.stringify(answer.body);
		return row.numbered ? text.replace(new RegExp(`\\b${id}\\b`, 'g'), '<id>') : text;
	};

	expect(notThere.status).toBe(row.status ?? 404);
	expect(there.status).toBe(row.status ?? 404);
	expect(said(there, onA)).toBe(said(notThere, missing));
	expectUnchanged(before);
}

describe('card 2719: an id on a board the caller cannot open', () => {
	it.each(ROWS.map((row) => [row.name, row] as const))('is answered exactly as an id that is not there: %s', async (_name, row) => {
		await answeredAsMissing(row);
	});

	// The code review's CS2: a card's board history gives a stay on a board the caller cannot open by its dates
	// alone, as a loop's hidden node is given, and not by the board's id.
	it('CS2 a card\'s board history gives a stay on a board the caller cannot open with no id: boardId null, withheld true', async () => {
		// The outsider's card was made on board A, and moved to their own board.
		db.insert(activityLog).values({ boardId: w.board.id, cardId: w.ownCard.id, action: 'card_created', createdAt: '2026-11-01 09:00:00' }).run();
		db.insert(activityLog).values({ boardId: w.board.id, cardId: w.ownCard.id, action: 'card_moved_away', createdAt: '2026-11-02 09:00:00' }).run();
		db.insert(activityLog).values({ boardId: w.ownColumn.boardId, cardId: w.ownCard.id, action: 'card_moved_in', createdAt: '2026-11-02 09:00:00' }).run();
		const before = snapshotDb();

		const res = await api('GET', `/api/v1/cards/${w.ownCard.id}/board-history`, { user: w.outsider });

		expect(res.status).toBe(200);
		expect(res.body.history).toEqual([
			{ boardId: null, boardName: 'Board not visible to you', from: '2026-11-01T09:00:00.000Z', to: '2026-11-02T09:00:00.000Z', current: false, withheld: true },
			{ boardId: w.ownColumn.boardId, boardName: 'Outsider', from: '2026-11-02T09:00:00.000Z', to: null, current: true }
		]);
		expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`"boardId":${w.board.id}\\b`));
		expectUnchanged(before);
	});

	// R27 (D12, step 5): a loop through work the caller cannot open names it as withheld, by the
	// single add and by the batch alike, and gives no id of it.
	it('R27 a link on the caller\'s board that would close a loop through a card of A withholds that card, by the single add and the batch', async () => {
		// X and Y are the outsider's; A's card waits on X, and Y waits on A's card. X waiting on Y closes the loop X → A → Y.
		const x = w.ownCard;
		const y = makeCard(w.ownColumn, { title: 'The outsider’s other' });
		makeDependency({ blocked: w.card, blocker: x });
		makeDependency({ blocked: y, blocker: w.card });
		const before = snapshotDb();
		const withheld = { kind: 'card', id: null, withheld: true };
		const loopSaid = `#${x.id} waiting on #${y.id} would create a cycle: #${x.id} → A card on a board you cannot open → #${y.id} → #${x.id}`;

		const single = await api('POST', `/api/v1/cards/${x.id}/dependencies`, { user: w.outsider, body: { dependsOnCardId: y.id } });
		expect(single.status).toBe(409);
		expect(single.body).toEqual({ message: loopSaid, cycle: [{ kind: 'card', id: x.id }, withheld, { kind: 'card', id: y.id }] });

		const batch = await api('POST', '/api/v1/dependencies/bulk', { user: w.outsider, body: { links: [{ blocked: x.id, blocker: y.id }] } });
		expect(batch.status).toBe(409);
		expect(batch.body.rejected).toEqual([
			{
				link: { blocked: x.id, blockedType: 'card', blocker: y.id, blockerType: 'card' },
				reason: 'cycle',
				cycle: [{ kind: 'card', id: x.id }, withheld, { kind: 'card', id: y.id }],
				message: loopSaid
			}
		]);

		// No id of A's card anywhere in either answer.
		for (const body of [single.body, batch.body]) {
			expect(JSON.stringify(body)).not.toMatch(new RegExp(`(#|"id":)${w.card.id}\\b`));
		}
		expectUnchanged(before);
	});
});

/** A page's load as an answer: its error, or its data. */
const loaded = async (path: string, user: SessionUser): Promise<Answer> => {
	const res = await pageLoad(path, { user });
	return res.type === 'error' ? { status: res.status, body: res.body } : { status: 200, body: res };
};

/** The milestone a card is in, as the table holds it. */
const goalOf = (cardId: number) => db.select({ milestoneId: cards.milestoneId }).from(cards).where(eq(cards.id, cardId)).get()?.milestoneId;

/** Card 2911's rows: a goal the outsider cannot see, named by its id, answered as one that is not there. */
const GOAL_ROWS: Row[] = [
	{
		name: 'G1 GET /api/v1/milestones/:id, a goal of A (requireMilestone, through the service)',
		table: 'milestones',
		onA: (w) => w.goalOfA.id,
		ask: (w, id) => api('GET', `/api/v1/milestones/${id}`, { user: w.outsider })
	},
	{
		name: 'G2 GET /api/v1/milestones/:id, a goal across boards the outsider sees part of (canViewMilestone across boards)',
		table: 'milestones',
		onA: (w) => w.acrossA.id,
		ask: (w, id) => api('GET', `/api/v1/milestones/${id}`, { user: w.outsider })
	},
	{
		name: 'G5 GET /api/burndown?milestoneId=<a goal of A> (burndown, a milestone)',
		table: 'milestones',
		onA: (w) => w.goalOfA.id,
		ask: (w, id) => api('GET', `/api/burndown?milestoneId=${id}`, { user: w.outsider })
	},
	{
		name: "G6 the plan page's load for a goal of A, called directly",
		table: 'milestones',
		onA: (w) => w.goalOfA.id,
		ask: (w, id) => loaded(`/plan/${id}`, w.outsider)
	},
	{
		name: "G7 POST /api/v1/milestones/:id/cards/bulk, a goal of A, with the outsider's card (the milestone bulk)",
		table: 'milestones',
		onA: (w) => w.goalOfA.id,
		ask: (w, id) => api('POST', `/api/v1/milestones/${id}/cards/bulk`, { user: w.outsider, body: { cardIds: [w.ownCard.id] } })
	},
	{
		name: "G8 PUT /api/v1/cards/:cardId, the outsider's card, with milestoneId a goal of A (setCardMilestone)",
		table: 'milestones',
		onA: (w) => w.goalOfA.id,
		ask: (w, id) => api('PUT', `/api/v1/cards/${w.ownCard.id}`, { user: w.outsider, body: { milestoneId: id } })
	}
];

describe('card 2911: a milestone the caller cannot see', () => {
	it.each(GOAL_ROWS.map((row) => [row.name, row] as const))('is answered exactly as a milestone that is not there: %s', async (_name, row) => {
		await answeredAsMissing(row);
	});

	it("G5b the burndown page's load gives a goal of A the problem it gives a milestone that is not there", async () => {
		const before = snapshotDb();
		const problem = async (id: number) => {
			const res = await pageLoad(`/burndown?milestoneId=${id}`, { user: w.outsider });
			expect(res.type).toBe('data');
			return res.type === 'data' ? res.data.problem : undefined;
		};

		const there = await problem(w.goalOfA.id);
		const notThere = await problem(missingIn('milestones'));

		expect(there).toEqual({ status: 404, message: 'Milestone not found' });
		expect(JSON.stringify(there)).toBe(JSON.stringify(notThere));
		expectUnchanged(before);
	});

	it('G9 a goal the outsider can see and may not change is still 403 No edit access to this milestone', async () => {
		const before = snapshotDb();

		const res = await api('PATCH', `/api/v1/milestones/${w.seenGoal.id}`, { user: w.outsider, body: { name: 'Renamed' } });

		expect([res.status, res.body]).toEqual([403, { message: 'No edit access to this milestone' }]);
		expectUnchanged(before);
	});

	it("G10 putting the outsider's card in their own goal, out of a goal they cannot see, is refused in that goal's own words", async () => {
		const before = snapshotDb();

		const res = await api('PUT', `/api/v1/cards/${w.inAcross.id}`, { user: w.outsider, body: { milestoneId: w.ownMilestoneId } });

		expect([res.status, res.body]).toEqual([403, { message: 'No access to the milestone this card is in' }]);
		expect(goalOf(w.inAcross.id)).toBe(w.acrossA.id);
		expectUnchanged(before);
	});

	it("G10b taking the outsider's card out of a goal they cannot see is refused in that goal's own words", async () => {
		const before = snapshotDb();

		const res = await api('PUT', `/api/v1/cards/${w.inAcross.id}`, { user: w.outsider, body: { milestoneId: null } });

		expect([res.status, res.body]).toEqual([403, { message: 'No access to the milestone this card is in' }]);
		expect(goalOf(w.inAcross.id)).toBe(w.acrossA.id);
		expectUnchanged(before);
	});
});
