/**
 * The internal routes record what their v1 twins record (card 2143).
 *
 * Six things can be done both in the web application, through a route under
 * `/api/`, and through the documented API, through its twin under `/api/v1/`:
 * assigning someone to a card, taking them off it, editing a comment, making
 * a board under a card, changing a board, and making a milestone on a board.
 * The v1 twin wrote an activity entry for each, and sent a live update for
 * most; the internal route wrote none and sent none. So the Audit page, a
 * board's Activity Log and `GET /api/v1/audit-log` did not show these actions
 * when they were done on screen, and other open pages did not refresh.
 *
 * The two trees were held together by nothing, which is how they came apart.
 * The first test here makes each pair's request on the same fixture, built
 * twice, and compares the entry each writes and the live updates each sends,
 * so the twins cannot drift again without a failing test. The others hold
 * what each internal route writes to all or nothing, what it records when
 * nothing changed, and the details of a board's entry and its updates.
 *
 * The last describe holds the words the pages show for these entries and
 * every other (card 2212): one table, `$lib/utils/activity-labels`, with a
 * label for every action the log is written with, read from the source.
 *
 * The plan is `docs/planning/cards-2143-2146-2147-2148-2163-2164-2167-pages.md`
 * (decisions 1 to 3, and 22 and 23 of its section 8).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import {
	activityLog,
	boardCategories,
	boards,
	cardComments,
	cardLabels,
	cards,
	categories,
	milestones,
	taskRequests,
	tokenUsage,
	users,
	type Card,
	type CardComment
} from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { ACTIONS, canonicalAction } from '$lib/server/logActivity';
import { ACTIVITY_LABELS, activityLabel } from '$lib/utils/activity-labels';
import { boardEvent, commentsChanged } from '$lib/board/sse';
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
	makeLabel,
	makeMilestone,
	makeSmtp,
	makeSubtask,
	makeUser,
	makeWebhook,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb, type DbSnapshot } from './helpers/snapshot';

beforeEach(resetDb);

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

/** A recorded effect in a few words, so that a whole request reads as a list. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} ${JSON.stringify(effect.data)} on board ${effect.boardId}`;
}

const entries = () =>
	db
		.select({
			boardId: activityLog.boardId,
			cardId: activityLog.cardId,
			userId: activityLog.userId,
			action: activityLog.action,
			detail: activityLog.detail,
			userName: activityLog.userName,
			userEmoji: activityLog.userEmoji,
			source: activityLog.source
		})
		.from(activityLog)
		.all();

type Scene = {
	/** Owns board A, and makes every request. */
	owner: SessionUser;
	/** May edit board A. Who is assigned and unassigned. */
	helper: SessionUser;
	/** May look at board A and change nothing on it. */
	viewer: SessionUser;
	A: BoardFixture;
	/** A card on A, with the owner's comment on it. */
	first: Card;
	comment: CardComment;
	/** A board of the owner's that is under no card. */
	S: BoardFixture;
};

/** Board A with a card and a comment on it, board S, and mail switched on. */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const helper = makeUser({ username: 'helper' });
	const viewer = makeUser({ username: 'viewer' });
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, helper, 'editor');
	addBoardMember(A.board, viewer, 'viewer');
	const first = makeCard(A.cols['To Do'], { title: 'First' });
	const comment = makeComment(first, owner, 'As it was');
	const S = makeBoard({ owner, name: 'S' });
	makeSmtp();
	return { owner, helper, viewer, A, first, comment, S };
}

/** As `scene`, with the helper already assigned to the card. */
function assigned(): Scene {
	const s = scene();
	assignCard(s.first, s.helper);
	return s;
}

type Twin = {
	/** What it is, for the test's name. */
	what: string;
	build: () => Scene;
	/** The request to the route the web application calls. */
	internal: (s: Scene) => Promise<ApiResult>;
	/** The same request to its twin in the documented API. */
	v1: (s: Scene) => Promise<ApiResult>;
	/** The canonical action each writes. */
	action: string;
};

const TWINS: Twin[] = [
	{
		what: 'assigning someone to a card',
		build: scene,
		internal: (s) => api('POST', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		action: 'assignee_added'
	},
	{
		what: 'taking someone off a card',
		build: assigned,
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		action: 'assignee_removed'
	},
	{
		what: 'editing a comment',
		build: scene,
		internal: (s) =>
			api('PUT', `/api/cards/${s.first.id}/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it is now' } }),
		v1: (s) => api('PUT', `/api/v1/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it is now' } }),
		action: 'comment_edited'
	},
	{
		what: 'making a board under a card',
		build: scene,
		internal: (s) => api('POST', '/api/boards', { user: s.owner, body: { name: 'Roadmap', parentCardId: s.first.id } }),
		v1: (s) => api('POST', '/api/v1/boards', { user: s.owner, body: { name: 'Roadmap', parentCardId: s.first.id } }),
		action: 'board_created'
	},
	{
		what: 'renaming a board',
		build: scene,
		internal: (s) => api('PUT', `/api/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed', emoji: '🚀' } }),
		v1: (s) => api('PUT', `/api/v1/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed', emoji: '🚀' } }),
		action: 'board_updated'
	},
	{
		what: 'making a milestone on a board',
		build: scene,
		internal: (s) => api('POST', '/api/milestones', { user: s.owner, body: { name: 'Launch', boardId: s.A.board.id } }),
		v1: (s) => api('POST', '/api/v1/milestones', { user: s.owner, body: { name: 'Launch', boardId: s.A.board.id } }),
		action: 'milestone_created'
	}
];

/** Build the fixture afresh, make one request with its effects recorded, and say what it wrote and sent. */
async function made(build: () => Scene, request: (s: Scene) => Promise<ApiResult>) {
	resetDb();
	const s = build();
	const sent = effects();
	try {
		const res = await request(s);
		await sent.settle();
		expect(res.status).toBeLessThan(300);
		expect(sent.duringTransaction).toEqual([]);
		return {
			entries: entries(),
			// The live updates whole: the board, the event and its payload.
			events: sent.events.map((e) => ({ boardId: e.boardId, event: e.event, data: e.data })),
			emails: sent.emails.map((e) => `${e.to}: ${e.subject}`),
			webhooks: sent.webhooks.map((e) => e.event)
		};
	} finally {
		sent.restore();
	}
}

describe('the internal routes and their v1 twins, side by side', () => {
	it.each(TWINS.map((twin) => [twin.what, twin] as const))(
		'%s writes the same entry and sends the same live updates through either',
		async (_what, twin) => {
			const internal = await made(twin.build, twin.internal);
			const v1 = await made(twin.build, twin.v1);

			// One entry each, of the same action, on the same board and card, by
			// the same person, in the same words. Only where it came from differs:
			// stored bare from the page, and with `api:` through the API.
			expect(internal.entries).toHaveLength(1);
			expect(v1.entries).toHaveLength(1);
			const [ui, viaApi] = [internal.entries[0], v1.entries[0]];
			expect(ui).toMatchObject({ action: twin.action, source: 'ui' });
			expect(viaApi).toMatchObject({ action: `api:${twin.action}`, source: 'api' });
			expect({ ...ui, action: canonicalAction(ui.action), source: null }).toEqual({
				...viaApi,
				action: canonicalAction(viaApi.action),
				source: null
			});

			// The same live updates, to the same boards, with the same payloads;
			// the same mail, and no webhook from either.
			expect(internal.events).toEqual(v1.events);
			expect(internal.emails).toEqual(v1.emails);
			expect(internal.webhooks).toEqual([]);
			expect(v1.webhooks).toEqual([]);
		}
	);

	it('each pair is what the plan names: six pairs, six actions', () => {
		expect(TWINS.map((t) => t.action)).toEqual([
			'assignee_added',
			'assignee_removed',
			'comment_edited',
			'board_created',
			'board_updated',
			'milestone_created'
		]);
	});
});

// ─── The pairs that share one service (card 2012) ───────────────────────────
//
// Card 2012 moves each pair's handlers onto one function in `src/lib/server/`
// that both trees call, and changes nothing either tree answers, records or
// sends (`docs/planning/card-2012-service-layer-and-pages.md`, R2 and R3).
// Each case here was written, and passed, before its pair moved: the same
// fixture built twice, the internal request and the v1 request, and for each
// tree the status, the rows written, every activity entry, and everything
// told (live events, mail and webhooks) in the order it started. Each tree's
// raw action and source are written in for each entry and each webhook, as
// are any other differences the two trees have today; the rest is compared
// whole, the one tree against the other.

/** A stored timestamp or an ISO one: two runs never write the same moment. */
const STAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

/** A row with its timestamps masked. */
const masked = (row: Record<string, unknown> | undefined) =>
	row && Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === 'string' && STAMP.test(value) ? '<stamp>' : value]));

/**
 * Every row a request added, removed or changed, by table and row, whole and
 * with its timestamps masked. The activity log is left out, and its id
 * counter: its entries are compared on their own, where each tree's spelling
 * of the action is known.
 */
function changes(before: DbSnapshot, after: DbSnapshot) {
	const found: { table: string; row: string; was?: Record<string, unknown>; is?: Record<string, unknown> }[] = [];
	for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		if (table === 'activity_log') continue;
		const was = before[table] ?? {};
		const is = after[table] ?? {};
		for (const row of [...new Set([...Object.keys(was), ...Object.keys(is)])]) {
			if (table === 'sqlite_sequence' && row === 'activity_log') continue;
			if (JSON.stringify(was[row]) === JSON.stringify(is[row])) continue;
			found.push({ table, row, was: masked(was[row]), is: masked(is[row]) });
		}
	}
	return found;
}

/** What one tree did with one request, as `served` records it. */
type Served = {
	status: number;
	/** Each entry's raw action and source, then each webhook's event and source: what differs by tree on purpose. */
	sources: string[];
	rows: ReturnType<typeof changes>;
	/** The entries with the action canonical and the source left out. */
	entries: Record<string, unknown>[];
	/** Everything told, in the order it started, each webhook with its source left out. */
	told: unknown[];
};

/** Build the fixture afresh, make one request with its effects recorded, and say what it did. */
async function served(build: () => Scene, request: (s: Scene) => Promise<ApiResult>): Promise<Served> {
	resetDb();
	const s = build();
	const before = snapshotDb();
	const sent = effects();
	try {
		const res = await request(s);
		await sent.settle();
		expect(sent.duringTransaction).toEqual([]);
		const written = entries();
		return {
			status: res.status,
			sources: [
				...written.map((e) => `${e.action} ${e.source}`),
				...sent.webhooks.map((w) => `${w.event} ${w.body.data.source}`)
			],
			rows: changes(before, snapshotDb()),
			entries: written.map((e) => ({ ...e, action: canonicalAction(e.action), source: undefined })),
			told: sent.all.map((e) =>
				e.kind === 'webhook'
					? { webhook: e.event, boardId: e.body.boardId, data: { ...e.body.data, source: undefined } }
					: e.kind === 'email'
						? { email: e.to, subject: e.subject }
						: { event: e.event, boardId: e.boardId, data: e.data }
			)
		};
	} finally {
		sent.restore();
	}
}

/** As `scene`, with the helper assigned to the card and a webhook on board A that takes every event. */
function cardScene(): Scene {
	const s = assigned();
	makeWebhook(s.A.board);
	return s;
}

/** The id of the milestone called Launch. */
const launch = () => db.select().from(milestones).all().find((m) => m.name === 'Launch')!.id;

/** As `cardScene`, with the card archived. */
function archivedScene(): Scene {
	const s = cardScene();
	db.update(cards).set({ archivedAt: '2026-10-01 09:00:00' }).where(eq(cards.id, s.first.id)).run();
	return s;
}

/** As `scene`, with a webhook on board A that takes every event, and nobody assigned. */
function openScene(): Scene {
	const s = scene();
	makeWebhook(s.A.board);
	return s;
}

/** As `cardScene`, with a label of board A, on the card when `on`. */
function labelScene(on: boolean): Scene {
	const s = cardScene();
	const label = makeLabel(s.A.board, 'Urgent');
	if (on) db.insert(cardLabels).values({ cardId: s.first.id, labelId: label.id }).run();
	return s;
}

/**
 * As `cardScene`, with an open subtask on the card that a second card waits
 * on, and the card made from an accepted request: ticking the subtask reaches
 * the "Unblocked" notice and the requester's mail.
 */
function subtaskScene(): Scene {
	const s = cardScene();
	const subtask = makeSubtask(s.first, { title: 'Draft it' });
	const waiting = makeCard(s.A.cols['To Do'], { title: 'Waiting' });
	assignCard(waiting, s.helper);
	makeDependency({ blocked: waiting, blocker: subtask, createdBy: s.owner });
	db.insert(taskRequests)
		.values({
			targetType: 'user',
			targetId: s.owner.id,
			requesterName: 'Rita',
			requesterEmail: 'rita@example.test',
			title: 'First',
			status: 'accepted',
			resolvedCardId: s.first.id,
			accessToken: 'b'.repeat(64)
		})
		.run();
	return s;
}

/**
 * As `cardScene`, with a second card on board A and a subtask on the first
 * card; when `linked`, the first card and its subtask each wait on the second.
 */
function linkScene(linked: boolean): Scene {
	const s = cardScene();
	const second = makeCard(s.A.cols['To Do'], { title: 'Second' });
	const subtask = makeSubtask(s.first, { title: 'Draft it' });
	if (linked) {
		makeDependency({ blocked: s.first, blocker: second, createdBy: s.owner });
		makeDependency({ blocked: subtask, blocker: second, createdBy: s.owner });
	}
	return s;
}

/** As `cardScene`, with board A's milestone Launch, which holds the card when `holding`. */
function goalScene(holding: boolean): Scene {
	const s = cardScene();
	makeMilestone({ board: s.A.board, name: 'Launch', createdBy: s.owner, cards: holding ? [s.first] : [] });
	return s;
}

/**
 * As `cardScene`, with the dashboard grouping Clients (id 1) that board A is
 * filed under, and board A's card category Bug (id 1) and label Urgent (id 1).
 */
function boardScene(): Scene {
	const s = cardScene();
	const grouping = db.insert(boardCategories).values({ name: 'Clients', color: '#6366f1' }).returning().get();
	db.update(boards).set({ categoryId: grouping.id }).where(eq(boards.id, s.A.board.id)).run();
	db.insert(categories).values({ boardId: s.A.board.id, name: 'Bug', color: '#ef4444' }).run();
	makeLabel(s.A.board, 'Urgent');
	return s;
}

type ServiceTwin = {
	/** The pair's row in section 3.1 of the plan. */
	row: number;
	what: string;
	build: () => Scene;
	internal: (s: Scene) => Promise<ApiResult>;
	v1: (s: Scene) => Promise<ApiResult>;
	/** Each tree's status. */
	status: { internal: number; v1: number };
	/** Each tree's `sources`, written in: the stored action and source of each entry, then each webhook's event and source. */
	sources: { internal: string[]; v1: string[] };
	/** Where the trees tell differently today: what each tells, written in. Otherwise the two are compared with each other. */
	told?: { internal: unknown[]; v1: unknown[] };
	/** Where the trees record differently today: each tree's entries, written in. */
	entries?: { internal: unknown[]; v1: unknown[] };
	/** Where the trees write differently today: each tree's rows, written in. None does, of the pairs so far. */
	rows?: { internal: unknown[]; v1: unknown[] };
};

/** The live update most changes to a card send. */
const CARD_UPDATE = { event: 'update', boardId: 1, data: { type: 'card' } };

/** The live update a comment added, edited or deleted sends: the card's, so its open window re-reads (card 2282). */
const COMMENT_UPDATE = { event: 'update', boardId: 1, data: { type: 'comment', cardId: 1 } };

const SERVICE_TWINS: ServiceTwin[] = [
	{
		row: 1,
		what: 'creating a card',
		build: cardScene,
		internal: (s) => api('POST', '/api/cards', { user: s.owner, body: { columnId: s.A.cols['To Do'].id, title: 'Second', priority: 'high' } }),
		v1: (s) =>
			api('POST', `/api/v1/boards/${s.A.board.id}/cards`, {
				user: s.owner,
				body: { columnId: s.A.cols['To Do'].id, title: 'Second', priority: 'high' }
			}),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['card_created ui', 'card.created ui'], v1: ['api:card_created api', 'card.created api'] }
	},
	{
		row: 1,
		what: 'creating a card in a Complete column, which completes it',
		build: cardScene,
		internal: (s) => api('POST', '/api/cards', { user: s.owner, body: { columnId: s.A.cols['Complete'].id, title: 'Done already' } }),
		v1: (s) =>
			api('POST', `/api/v1/boards/${s.A.board.id}/cards`, {
				user: s.owner,
				body: { columnId: s.A.cols['Complete'].id, title: 'Done already' }
			}),
		status: { internal: 201, v1: 201 },
		sources: {
			internal: ['card_created ui', 'card_completed ui', 'card.created ui', 'card.completed ui'],
			v1: ['api:card_created api', 'api:card_completed api', 'card.created api', 'card.completed api']
		}
	},
	{
		row: 2,
		what: "changing a card's fields",
		build: cardScene,
		internal: (s) => api('PUT', `/api/cards/${s.first.id}`, { user: s.owner, body: { title: 'First, renamed', priority: 'high' } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}`, { user: s.owner, body: { title: 'First, renamed', priority: 'high' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_updated ui', 'card.updated ui'], v1: ['api:card_updated api', 'card.updated api'] },
		// The same two, in the order each tree queued them: the internal route
		// writes its entry (and queues its webhook) before it tells the board, v1
		// tells the board first.
		told: (() => {
			const webhook = {
				webhook: 'card.updated',
				boardId: 1,
				data: { cardId: 1, action: 'card_updated', detail: 'Updated fields: title, priority on "First, renamed"', source: undefined, user: 'owner' }
			};
			return { internal: [webhook, CARD_UPDATE], v1: [CARD_UPDATE, webhook] };
		})()
	},
	{
		row: 3,
		what: 'archiving a card',
		build: cardScene,
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_archived ui'], v1: ['api:card_archived api'] }
	},
	{
		row: 3,
		what: 'deleting a card for good',
		build: cardScene,
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}?permanent=true`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}?permanent=true`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_deleted ui', 'card.deleted ui'], v1: ['api:card_deleted api', 'card.deleted api'] }
	},
	{
		row: 4,
		what: 'moving a card to another column',
		build: cardScene,
		internal: (s) =>
			api('PUT', '/api/cards/reorder', { user: s.owner, body: { updates: [{ id: s.first.id, columnId: s.A.cols['In Progress'].id, position: 0 }] } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}/move`, { user: s.owner, body: { columnId: s.A.cols['In Progress'].id, position: 0 } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_moved ui', 'card.moved ui'], v1: ['api:card_moved api', 'card.moved api'] },
		// A move made on the page mails the card's assignees; one made through the
		// API does not, unless it completes the card (announceCardMoves).
		told: (() => {
			const webhook = {
				webhook: 'card.moved',
				boardId: 1,
				data: { cardId: 1, action: 'card_moved', detail: '"First": To Do → In Progress', source: undefined, user: 'owner' }
			};
			const update = {
				event: 'update',
				boardId: 1,
				data: { type: 'card', action: 'moved', cardTitle: 'First', fromColumn: 'To Do', toColumn: 'In Progress', userName: 'owner', userEmoji: '👤' }
			};
			return {
				internal: [webhook, { email: 'helper@example.test', subject: 'Card moved: First → In Progress' }, update],
				v1: [webhook, update]
			};
		})()
	},
	{
		row: 4,
		what: 'moving a card into Complete, which completes it',
		build: cardScene,
		internal: (s) =>
			api('PUT', '/api/cards/reorder', { user: s.owner, body: { updates: [{ id: s.first.id, columnId: s.A.cols['Complete'].id, position: 0 }] } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}/move`, { user: s.owner, body: { columnId: s.A.cols['Complete'].id, position: 0 } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_completed ui', 'card.completed ui'], v1: ['api:card_completed api', 'card.completed api'] }
	},
	{
		row: 4,
		what: "moving a card through the internal card update's columnId (the move inside row 2), against the v1 move",
		build: cardScene,
		internal: (s) => api('PUT', `/api/cards/${s.first.id}`, { user: s.owner, body: { columnId: s.A.cols['In Progress'].id } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}/move`, { user: s.owner, body: { columnId: s.A.cols['In Progress'].id } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_moved ui', 'card.moved ui'], v1: ['api:card_moved api', 'card.moved api'] },
		// As the reorder against the v1 move: a move made on the page mails the assignees.
		told: (() => {
			const webhook = {
				webhook: 'card.moved',
				boardId: 1,
				data: { cardId: 1, action: 'card_moved', detail: '"First": To Do → In Progress', source: undefined, user: 'owner' }
			};
			const update = {
				event: 'update',
				boardId: 1,
				data: { type: 'card', action: 'moved', cardTitle: 'First', fromColumn: 'To Do', toColumn: 'In Progress', userName: 'owner', userEmoji: '👤' }
			};
			return {
				internal: [webhook, { email: 'helper@example.test', subject: 'Card moved: First → In Progress' }, update],
				v1: [webhook, update]
			};
		})()
	},
	{
		row: 2,
		what: "putting a card in a milestone through v1's card update (milestoneId), against the internal milestone's cardId",
		build: () => {
			const s = cardScene();
			makeMilestone({ board: s.A.board, name: 'Launch', createdBy: s.owner });
			return s;
		},
		internal: (s) => api('PATCH', `/api/milestones/${launch()}`, { user: s.owner, body: { cardId: s.first.id } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}`, { user: s.owner, body: { milestoneId: launch() } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: ['api:card_updated api', 'card.updated api'] },
		// The same card put in the same milestone (the rows are compared whole).
		// v1 records it and fires `card.updated`, telling the board first; the
		// internal route records nothing (found nearby F8, its own card).
		entries: {
			internal: [],
			v1: [
				{
					boardId: 1,
					cardId: 1,
					userId: 1,
					action: 'card_updated',
					detail: 'Updated fields: milestoneId on "First"',
					userName: 'owner',
					userEmoji: '👤',
					source: undefined
				}
			]
		},
		told: {
			internal: [CARD_UPDATE],
			v1: [
				CARD_UPDATE,
				{
					webhook: 'card.updated',
					boardId: 1,
					data: { cardId: 1, action: 'card_updated', detail: 'Updated fields: milestoneId on "First"', source: undefined, user: 'owner' }
				}
			]
		}
	},
	{
		row: 5,
		what: 'restoring an archived card',
		build: archivedScene,
		internal: (s) => api('POST', `/api/cards/${s.first.id}/restore`, { user: s.owner }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}`, { user: s.owner, body: { archivedAt: null } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_restored ui'], v1: ['api:card_restored api'] }
	},
	{
		row: 5,
		what: "restoring an archived card from the board's archive",
		build: archivedScene,
		internal: (s) => api('POST', `/api/boards/${s.A.board.id}/archive`, { user: s.owner, body: { cardId: s.first.id } }),
		v1: (s) => api('PUT', `/api/v1/cards/${s.first.id}`, { user: s.owner, body: { archivedAt: null } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['card_restored ui'], v1: ['api:card_restored api'] }
	},
	// Slice A2: what is on a card.
	{
		row: 6,
		what: 'assigning someone to a card',
		build: openScene,
		internal: (s) => api('POST', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['assignee_added ui'], v1: ['api:assignee_added api'] }
	},
	{
		row: 7,
		what: 'taking someone off a card',
		build: cardScene,
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['assignee_removed ui'], v1: ['api:assignee_removed api'] }
	},
	{
		row: 9,
		what: 'adding a comment',
		build: cardScene,
		internal: (s) => api('POST', `/api/cards/${s.first.id}/comments`, { user: s.owner, body: { content: 'Looks right' } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/comments`, { user: s.owner, body: { content: 'Looks right' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['comment_added ui', 'comment.added ui'], v1: ['api:comment_added api', 'comment.added api'] },
		// Each tree's words for the entry (R2), and its order: the page's route
		// writes the entry (queueing its webhook) before the mail, v1 after it.
		entries: (() => {
			const entry = (detail: string) => ({
				boardId: 1,
				cardId: 1,
				userId: 1,
				action: 'comment_added',
				detail,
				userName: 'owner',
				userEmoji: '👤',
				source: undefined
			});
			return { internal: [entry('on "First"')], v1: [entry('Commented on "First"')] };
		})(),
		told: (() => {
			const webhook = (detail: string) => ({
				webhook: 'comment.added',
				boardId: 1,
				data: { cardId: 1, action: 'comment_added', detail, source: undefined, user: 'owner' }
			});
			const mail = [
				{ email: 'helper@example.test', subject: 'New comment on: First' },
				{ email: 'viewer@example.test', subject: 'New comment on: First' }
			];
			// Then the open pages, last in both trees (card 2282, decision 3).
			return {
				internal: [webhook('on "First"'), ...mail, COMMENT_UPDATE],
				v1: [...mail, webhook('Commented on "First"'), COMMENT_UPDATE]
			};
		})()
	},
	{
		row: 10,
		what: 'editing a comment',
		build: cardScene,
		internal: (s) =>
			api('PUT', `/api/cards/${s.first.id}/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it is now' } }),
		v1: (s) => api('PUT', `/api/v1/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it is now' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['comment_edited ui'], v1: ['api:comment_edited api'] },
		// The comment event, naming the card, where it was `{ type: 'card' }`
		// (card 2282, decision 1): the open card window re-reads its comments.
		told: { internal: [COMMENT_UPDATE], v1: [COMMENT_UPDATE] }
	},
	{
		row: 11,
		what: 'deleting a comment',
		build: cardScene,
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}/comments/${s.comment.id}`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/comments/${s.comment.id}`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		// Recorded, in the same words in both trees, and the open card window
		// told; no webhook, though the scene's takes every event: there is no
		// `comment.deleted` (card 2283, decisions 6 to 8). Neither was done.
		sources: { internal: ['comment_deleted ui'], v1: ['api:comment_deleted api'] },
		entries: (() => {
			const entry = {
				boardId: 1,
				cardId: 1,
				userId: 1,
				action: 'comment_deleted',
				detail: 'Deleted a comment on "First"',
				userName: 'owner',
				userEmoji: '👤',
				source: undefined
			};
			return { internal: [entry], v1: [entry] };
		})(),
		told: { internal: [COMMENT_UPDATE], v1: [COMMENT_UPDATE] }
	},
	{
		row: 12,
		what: "putting a label on a card (the page's toggle, against v1's add)",
		build: () => labelScene(false),
		internal: (s) => api('PUT', '/api/labels', { user: s.owner, body: { cardId: s.first.id, labelId: 1 } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/labels`, { user: s.owner, body: { labelId: 1 } }),
		status: { internal: 200, v1: 201 },
		sources: { internal: [], v1: [] },
		// No label write records an entry, in either tree.
		entries: { internal: [], v1: [] }
	},
	{
		row: 12,
		what: "taking a label off a card (the page's toggle, against v1's remove)",
		build: () => labelScene(true),
		internal: (s) => api('PUT', '/api/labels', { user: s.owner, body: { cardId: s.first.id, labelId: 1 } }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}/labels`, { user: s.owner, body: { labelId: 1 } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 14,
		what: 'adding a subtask',
		build: cardScene,
		internal: (s) => api('POST', '/api/subtasks', { user: s.owner, body: { cardId: s.first.id, title: 'Write it', priority: 'high' } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/subtasks`, { user: s.owner, body: { title: 'Write it', priority: 'high' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['subtask_created ui'], v1: ['api:subtask_created api'] },
		// Each tree's words for the entry and type for the event (R2): the
		// subtask's title and `subtask` from the page, more words and `card`
		// through v1, which tells the board before it writes the entry.
		entries: (() => {
			const entry = (detail: string) => ({
				boardId: 1,
				cardId: 1,
				userId: 1,
				action: 'subtask_created',
				detail,
				userName: 'owner',
				userEmoji: '👤',
				source: undefined
			});
			return { internal: [entry('Write it')], v1: [entry('Created subtask "Write it" on "First"')] };
		})(),
		told: { internal: [{ event: 'update', boardId: 1, data: { type: 'subtask' } }], v1: [CARD_UPDATE] }
	},
	{
		row: 15,
		what: 'ticking a subtask off, which unblocks a card and mails the requester',
		build: subtaskScene,
		internal: (s) => api('PUT', '/api/subtasks/1', { user: s.owner, body: { completed: true } }),
		v1: (s) => api('PUT', '/api/v1/subtasks/1', { user: s.owner, body: { completed: true } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['subtask_completed ui'], v1: ['api:subtask_completed api'] },
		// The same notices (the "Unblocked" mail and its update, then the
		// requester's mail); the page's route tells the board first, as
		// `subtask`, v1 last, as `card` (R2).
		told: (() => {
			const notices = [
				{ email: 'helper@example.test', subject: 'Unblocked: Waiting' },
				CARD_UPDATE,
				// The notice is a comment on Waiting, card 2 (card 2282).
				{ event: 'update', boardId: 1, data: { type: 'comment', cardId: 2 } },
				{ email: 'rita@example.test', subject: 'Subtask completed on your request: First' }
			];
			return {
				internal: [{ event: 'update', boardId: 1, data: { type: 'subtask' } }, ...notices],
				v1: [...notices, CARD_UPDATE]
			};
		})()
	},
	{
		row: 16,
		what: 'deleting a subtask',
		build: subtaskScene,
		internal: (s) => api('DELETE', '/api/subtasks/1', { user: s.owner }),
		v1: (s) => api('DELETE', '/api/v1/subtasks/1', { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['subtask_deleted ui'], v1: ['api:subtask_deleted api'] },
		// The event's type per tree (R2).
		told: { internal: [{ event: 'update', boardId: 1, data: { type: 'subtask' } }], v1: [CARD_UPDATE] }
	},
	// Slice A3: dependencies and milestones. Neither tree records an entry for
	// a milestone changed, deleted, or given or relieved of a card (found
	// nearby F8), and none tells anyone of a milestone made, changed or deleted.
	{
		row: 17,
		what: 'making a card wait on another',
		build: () => linkScene(false),
		internal: (s) => api('POST', `/api/cards/${s.first.id}/dependencies`, { user: s.owner, body: { dependsOnCardId: 2 } }),
		v1: (s) => api('POST', `/api/v1/cards/${s.first.id}/dependencies`, { user: s.owner, body: { dependsOnCardId: 2 } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['dependency_added ui'], v1: ['api:dependency_added api'] }
	},
	{
		row: 17,
		what: 'a card no longer waiting on another',
		build: () => linkScene(true),
		internal: (s) => api('DELETE', `/api/cards/${s.first.id}/dependencies`, { user: s.owner, body: { dependsOnCardId: 2 } }),
		v1: (s) => api('DELETE', `/api/v1/cards/${s.first.id}/dependencies`, { user: s.owner, body: { dependsOnCardId: 2 } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['dependency_removed ui'], v1: ['api:dependency_removed api'] }
	},
	{
		row: 18,
		what: 'making a subtask wait on a card',
		build: () => linkScene(false),
		internal: (s) => api('POST', '/api/subtasks/1/dependencies', { user: s.owner, body: { dependsOnCardId: 2 } }),
		v1: (s) => api('POST', '/api/v1/subtasks/1/dependencies', { user: s.owner, body: { dependsOnCardId: 2 } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['dependency_added ui'], v1: ['api:dependency_added api'] }
	},
	{
		row: 18,
		what: 'a subtask no longer waiting on a card',
		build: () => linkScene(true),
		internal: (s) => api('DELETE', '/api/subtasks/1/dependencies', { user: s.owner, body: { dependsOnCardId: 2 } }),
		v1: (s) => api('DELETE', '/api/v1/subtasks/1/dependencies', { user: s.owner, body: { dependsOnCardId: 2 } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['dependency_removed ui'], v1: ['api:dependency_removed api'] }
	},
	{
		row: 21,
		what: 'making a milestone on a board',
		build: openScene,
		internal: (s) => api('POST', '/api/milestones', { user: s.owner, body: { name: 'Launch', boardId: s.A.board.id, targetDate: '2026-12-01' } }),
		v1: (s) => api('POST', '/api/v1/milestones', { user: s.owner, body: { name: 'Launch', boardId: s.A.board.id, targetDate: '2026-12-01' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['milestone_created ui'], v1: ['api:milestone_created api'] },
		told: { internal: [], v1: [] }
	},
	{
		row: 22,
		what: 'renaming and closing a milestone',
		build: () => goalScene(false),
		internal: (s) => api('PATCH', `/api/milestones/${launch()}`, { user: s.owner, body: { name: 'Launched', status: 'closed' } }),
		v1: (s) => api('PATCH', `/api/v1/milestones/${launch()}`, { user: s.owner, body: { name: 'Launched', status: 'closed' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		told: { internal: [], v1: [] }
	},
	{
		row: 22,
		what: 'deleting a milestone, which releases its card',
		build: () => goalScene(true),
		internal: (s) => api('DELETE', `/api/milestones/${launch()}`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/milestones/${launch()}`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		told: { internal: [], v1: [] }
	},
	{
		row: 22,
		what: "putting a card in a milestone (the page's PATCH with cardId, against v1's cards POST)",
		build: () => goalScene(false),
		internal: (s) => api('PATCH', `/api/milestones/${launch()}`, { user: s.owner, body: { cardId: s.first.id } }),
		v1: (s) => api('POST', `/api/v1/milestones/${launch()}/cards`, { user: s.owner, body: { cardId: s.first.id } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 22,
		what: "taking a card out of a milestone (the page's PATCH with attach: false, against v1's cards DELETE)",
		build: () => goalScene(true),
		internal: (s) => api('PATCH', `/api/milestones/${launch()}`, { user: s.owner, body: { cardId: s.first.id, attach: false } }),
		v1: (s) => api('DELETE', `/api/v1/milestones/${launch()}/cards`, { user: s.owner, body: { cardId: s.first.id } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	// Slice A4: boards, dashboard groupings, columns, card categories and
	// labels. No grouping, column change, category or label write records an
	// entry, and no grouping write tells anyone. Each tree places a new column
	// sent with no position where it did (R2): first from the page, after the
	// last through v1.
	{
		row: 24,
		what: 'making a board under a card',
		build: boardScene,
		internal: (s) => api('POST', '/api/boards', { user: s.owner, body: { name: 'Roadmap', emoji: '🗺️', parentCardId: s.first.id } }),
		v1: (s) => api('POST', '/api/v1/boards', { user: s.owner, body: { name: 'Roadmap', emoji: '🗺️', parentCardId: s.first.id } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['board_created ui'], v1: ['api:board_created api'] }
	},
	{
		row: 24,
		what: 'making a board on the dashboard',
		build: boardScene,
		internal: (s) => api('POST', '/api/boards', { user: s.owner, body: { name: 'Roadmap' } }),
		v1: (s) => api('POST', '/api/v1/boards', { user: s.owner, body: { name: 'Roadmap' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: ['board_created ui'], v1: ['api:board_created api'] },
		told: { internal: [], v1: [] }
	},
	{
		row: 25,
		what: 'renaming a board, with its emoji and its grouping',
		build: boardScene,
		internal: (s) => api('PUT', `/api/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed', emoji: '🚀', categoryId: null } }),
		v1: (s) => api('PUT', `/api/v1/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed', emoji: '🚀', categoryId: null } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['board_updated ui'], v1: ['api:board_updated api'] }
	},
	{
		row: 25,
		what: 'deleting a board',
		build: boardScene,
		internal: (s) => api('DELETE', `/api/boards/${s.S.board.id}`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/boards/${s.S.board.id}`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 26,
		what: 'making a dashboard grouping',
		build: boardScene,
		internal: (s) => api('POST', '/api/board-categories', { user: s.owner, body: { name: 'Partners', color: '#123456' } }),
		v1: (s) => api('POST', '/api/v1/board-categories', { user: s.owner, body: { name: 'Partners', color: '#123456' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		told: { internal: [], v1: [] }
	},
	{
		row: 26,
		what: 'renaming and recolouring a dashboard grouping',
		build: boardScene,
		internal: (s) => api('PUT', '/api/board-categories/1', { user: s.owner, body: { name: 'Customers', color: '#654321' } }),
		v1: (s) => api('PUT', '/api/v1/board-categories/1', { user: s.owner, body: { name: 'Customers', color: '#654321' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		told: { internal: [], v1: [] }
	},
	{
		row: 26,
		what: 'deleting a dashboard grouping',
		build: boardScene,
		internal: (s) => api('DELETE', '/api/board-categories/1', { user: s.owner }),
		v1: (s) => api('DELETE', '/api/v1/board-categories/1', { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		told: { internal: [], v1: [] }
	},
	{
		row: 27,
		what: 'adding a column where it is asked for',
		build: boardScene,
		internal: (s) => api('POST', '/api/columns', { user: s.owner, body: { boardId: s.A.board.id, title: 'Review', position: 2.5, color: '#123456' } }),
		v1: (s) => api('POST', `/api/v1/boards/${s.A.board.id}/columns`, { user: s.owner, body: { title: 'Review', position: 2.5, color: '#123456' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 27,
		what: 'adding a column with no position',
		build: boardScene,
		internal: (s) => api('POST', '/api/columns', { user: s.owner, body: { boardId: s.A.board.id, title: 'Review' } }),
		v1: (s) => api('POST', `/api/v1/boards/${s.A.board.id}/columns`, { user: s.owner, body: { title: 'Review' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] },
		// Each tree's place for it (R2): first from the page, after board A's last (3) through v1.
		rows: (() => {
			const added = (position: number) => [
				{ table: 'columns', row: '9', was: undefined, is: { id: 9, board_id: 1, title: 'Review', position, color: '#6366f1', wip_limit: 0, show_add_card: 0 } },
				{ table: 'sqlite_sequence', row: 'columns', was: { name: 'columns', seq: 8 }, is: { name: 'columns', seq: 9 } }
			];
			return { internal: added(0), v1: added(4) };
		})()
	},
	{
		row: 27,
		what: 'changing a column',
		build: boardScene,
		internal: (s) => api('PUT', `/api/columns/${s.A.cols['On Hold'].id}`, { user: s.owner, body: { title: 'Waiting', wipLimit: '3', showAddCard: true } }),
		v1: (s) => api('PUT', `/api/v1/columns/${s.A.cols['On Hold'].id}`, { user: s.owner, body: { title: 'Waiting', wipLimit: '3', showAddCard: true } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 27,
		what: 'deleting a column, and the card in it',
		build: boardScene,
		internal: (s) => api('DELETE', `/api/columns/${s.A.cols['To Do'].id}`, { user: s.owner }),
		v1: (s) => api('DELETE', `/api/v1/columns/${s.A.cols['To Do'].id}`, { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: ['column_deleted ui'], v1: ['api:column_deleted api'] }
	},
	{
		row: 29,
		what: 'making a card category on a board',
		build: boardScene,
		internal: (s) => api('POST', '/api/categories', { user: s.owner, body: { boardId: s.A.board.id, name: 'Feature', color: '#123456' } }),
		v1: (s) => api('POST', `/api/v1/boards/${s.A.board.id}/categories`, { user: s.owner, body: { name: 'Feature', color: '#123456' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 29,
		what: 'renaming and recolouring a card category',
		build: boardScene,
		internal: (s) => api('PUT', '/api/categories/1', { user: s.owner, body: { name: 'Defect', color: '#654321' } }),
		v1: (s) => api('PUT', '/api/v1/categories/1', { user: s.owner, body: { name: 'Defect', color: '#654321' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 29,
		what: 'deleting a card category',
		build: boardScene,
		internal: (s) => api('DELETE', '/api/categories/1', { user: s.owner }),
		v1: (s) => api('DELETE', '/api/v1/categories/1', { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 30,
		what: 'making a label',
		build: boardScene,
		internal: (s) => api('POST', '/api/labels', { user: s.owner, body: { boardId: s.A.board.id, name: 'Later', color: '#123456' } }),
		v1: (s) => api('POST', `/api/v1/boards/${s.A.board.id}/labels`, { user: s.owner, body: { name: 'Later', color: '#123456' } }),
		status: { internal: 201, v1: 201 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 30,
		what: "renaming and recolouring a label (the page's PATCH, against v1's PUT)",
		build: boardScene,
		internal: (s) => api('PATCH', '/api/labels', { user: s.owner, body: { id: 1, name: 'Hot', color: '#654321' } }),
		v1: (s) => api('PUT', '/api/v1/labels/1', { user: s.owner, body: { name: 'Hot', color: '#654321' } }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	},
	{
		row: 30,
		what: 'deleting a label',
		build: boardScene,
		internal: (s) => api('DELETE', '/api/labels', { user: s.owner, body: { id: 1 } }),
		v1: (s) => api('DELETE', '/api/v1/labels/1', { user: s.owner }),
		status: { internal: 200, v1: 200 },
		sources: { internal: [], v1: [] },
		entries: { internal: [], v1: [] }
	}
];

describe('the pairs that share one service, side by side (card 2012)', () => {
	it.each(SERVICE_TWINS.map((twin) => [`row ${twin.row}, ${twin.what}`, twin] as const))(
		'%s: each tree as it was, and the two alike but where written in',
		async (_what, twin) => {
			const internal = await served(twin.build, twin.internal);
			const v1 = await served(twin.build, twin.v1);

			expect({ internal: internal.status, v1: v1.status }).toEqual(twin.status);
			expect({ internal: internal.sources, v1: v1.sources }).toEqual(twin.sources);
			// Something was written and told, so that the comparison below compares something;
			// entries too, unless the pair records none and says so (a label on a card), and told
			// unless the pair tells nobody and says so (a milestone changed).
			expect(internal.rows.length).toBeGreaterThan(0);
			if (!twin.entries) expect(internal.entries.length + v1.entries.length).toBeGreaterThan(0);
			if (!twin.told) expect(internal.told.length).toBeGreaterThan(0);
			for (const part of ['rows', 'entries', 'told'] as const) {
				const writtenIn = twin[part];
				if (writtenIn) expect({ internal: internal[part], v1: v1[part] }, part).toEqual(writtenIn);
				else expect(internal[part], part).toEqual(v1[part]);
			}
		}
	);

	it("refuses a viewer in each tree's own words, rows 1 to 5, and writes and tells nothing", async () => {
		const s = archivedScene();
		const other = makeCard(s.A.cols['To Do'], { title: 'Other' });
		const as = { user: s.viewer };
		const before = snapshotDb();
		const sent = effects();
		const refusals: Record<string, unknown> = {};
		try {
			const ask = async (what: string, res: Promise<ApiResult>) => {
				const { status, body } = await res;
				refusals[what] = `${status} ${body?.message}`;
			};
			const to = { columnId: s.A.cols['In Progress'].id, position: 0 };
			await ask('internal create', api('POST', '/api/cards', { ...as, body: { columnId: s.A.cols['To Do'].id, title: 'No' } }));
			await ask('v1 create', api('POST', `/api/v1/boards/${s.A.board.id}/cards`, { ...as, body: { columnId: s.A.cols['To Do'].id, title: 'No' } }));
			await ask('internal update', api('PUT', `/api/cards/${other.id}`, { ...as, body: { title: 'No' } }));
			await ask('v1 update', api('PUT', `/api/v1/cards/${other.id}`, { ...as, body: { title: 'No' } }));
			await ask('internal delete', api('DELETE', `/api/cards/${other.id}`, as));
			await ask('v1 delete', api('DELETE', `/api/v1/cards/${other.id}`, as));
			await ask('internal move', api('PUT', '/api/cards/reorder', { ...as, body: { updates: [{ id: other.id, ...to }] } }));
			await ask('v1 move', api('PUT', `/api/v1/cards/${other.id}/move`, { ...as, body: to }));
			await ask('internal restore', api('POST', `/api/cards/${s.first.id}/restore`, as));
			await ask('internal restore from the archive', api('POST', `/api/boards/${s.A.board.id}/archive`, { ...as, body: { cardId: s.first.id } }));
			await ask('v1 restore', api('PUT', `/api/v1/cards/${s.first.id}`, { ...as, body: { archivedAt: null } }));
			await sent.settle();
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}

		expect(refusals).toEqual({
			'internal create': '403 No edit access to this board',
			'v1 create': '403 No edit access to this board',
			'internal update': '403 No edit access to this board',
			'v1 update': "403 No edit access to this card's board",
			'internal delete': '403 No edit access to this board',
			'v1 delete': "403 No edit access to this card's board",
			'internal move': '403 No edit access to this board',
			'v1 move': '403 No edit access to this board',
			'internal restore': '403 No edit access to this board',
			'internal restore from the archive': '403 No edit access to this board',
			'v1 restore': "403 No edit access to this card's board"
		});
		expectUnchanged(before);
	});

	it("answers a card or a column that is not there in each tree's own words, rows 1 to 5", async () => {
		const s = cardScene();
		const as = { user: s.owner };
		const refusals: Record<string, unknown> = {};
		const ask = async (what: string, res: Promise<ApiResult>) => {
			const { status, body } = await res;
			refusals[what] = `${status} ${body?.message}`;
		};
		await ask('internal create, no column', api('POST', '/api/cards', { ...as, body: { columnId: 999, title: 'No' } }));
		await ask('internal create, no columnId', api('POST', '/api/cards', { ...as, body: { title: 'No' } }));
		await ask('v1 create, no column', api('POST', `/api/v1/boards/${s.A.board.id}/cards`, { ...as, body: { columnId: 999, title: 'No' } }));
		await ask('v1 create, no columnId', api('POST', `/api/v1/boards/${s.A.board.id}/cards`, { ...as, body: { title: 'No' } }));
		await ask('internal update', api('PUT', '/api/cards/999', { ...as, body: { title: 'No' } }));
		await ask('v1 update', api('PUT', '/api/v1/cards/999', { ...as, body: { title: 'No' } }));
		await ask('internal update, nothing sent', api('PUT', `/api/cards/${s.first.id}`, { ...as, body: {} }));
		await ask('v1 update, nothing sent', api('PUT', `/api/v1/cards/${s.first.id}`, { ...as, body: {} }));
		await ask('internal delete', api('DELETE', '/api/cards/999', as));
		await ask('v1 delete', api('DELETE', '/api/v1/cards/999', as));
		await ask('internal move', api('PUT', '/api/cards/reorder', { ...as, body: { updates: [{ id: 999, columnId: s.A.cols['To Do'].id }] } }));
		await ask('internal move, no column', api('PUT', '/api/cards/reorder', { ...as, body: { updates: [{ id: s.first.id, columnId: 999 }] } }));
		await ask('v1 move', api('PUT', '/api/v1/cards/999/move', { ...as, body: { columnId: s.A.cols['To Do'].id } }));
		await ask('v1 move, no column', api('PUT', `/api/v1/cards/${s.first.id}/move`, { ...as, body: { columnId: 999 } }));
		await ask('v1 move, no columnId', api('PUT', `/api/v1/cards/${s.first.id}/move`, { ...as, body: {} }));
		await ask('internal restore', api('POST', '/api/cards/999/restore', as));
		await ask('internal restore from the archive', api('POST', `/api/boards/${s.A.board.id}/archive`, { ...as, body: { cardId: 999 } }));
		await ask('internal restore from another board', api('POST', `/api/boards/${s.S.board.id}/archive`, { ...as, body: { cardId: s.first.id } }));

		expect(refusals).toEqual({
			'internal create, no column': '404 Column not found',
			'internal create, no columnId': '400 Invalid column ID',
			'v1 create, no column': '400 Column does not belong to this board',
			'v1 create, no columnId': '400 columnId is required',
			'internal update': '404 Card not found',
			'v1 update': '404 Card not found',
			// R2: the internal route answers an empty change as it did, v1 refuses it.
			'internal update, nothing sent': '200 undefined',
			'v1 update, nothing sent': '400 No valid fields to update',
			'internal delete': '404 Card not found',
			'v1 delete': '404 Card not found',
			'internal move': '404 Card 999 not found',
			'internal move, no column': '404 Column not found',
			'v1 move': '404 Card not found',
			'v1 move, no column': '404 Column not found',
			'v1 move, no columnId': '400 columnId is required',
			'internal restore': '404 Card not found',
			'internal restore from the archive': '404 Card not found',
			'internal restore from another board': '404 Card not found on this board'
		});
	});

	it("refuses a viewer, and an editor who is not a comment's author, in each tree's own words, rows 6 to 16, and writes and tells nothing", async () => {
		const s = subtaskScene();
		makeLabel(s.A.board, 'Urgent');
		const helpers = makeComment(s.first, s.helper, 'The helper wrote this');
		const viewer = { user: s.viewer };
		const helper = { user: s.helper };
		const before = snapshotDb();
		const sent = effects();
		const refusals: Record<string, unknown> = {};
		try {
			const ask = async (what: string, res: Promise<ApiResult>) => {
				const { status, body } = await res;
				refusals[what] = `${status} ${body?.message}`;
			};
			const card = `/api/cards/${s.first.id}`;
			const v1Card = `/api/v1/cards/${s.first.id}`;
			await ask('internal assign', api('POST', `${card}/assignees`, { ...viewer, body: { userId: s.viewer.id } }));
			await ask('v1 assign', api('POST', `${v1Card}/assignees`, { ...viewer, body: { userId: s.viewer.id } }));
			await ask('internal unassign', api('DELETE', `${card}/assignees`, { ...viewer, body: { userId: s.helper.id } }));
			await ask('v1 unassign', api('DELETE', `${v1Card}/assignees`, { ...viewer, body: { userId: s.helper.id } }));
			await ask('internal comment', api('POST', `${card}/comments`, { ...viewer, body: { content: 'No' } }));
			await ask('v1 comment', api('POST', `${v1Card}/comments`, { ...viewer, body: { content: 'No' } }));
			await ask('internal comment edit', api('PUT', `${card}/comments/${s.comment.id}`, { ...viewer, body: { content: 'No' } }));
			await ask('v1 comment edit', api('PUT', `/api/v1/comments/${s.comment.id}`, { ...viewer, body: { content: 'No' } }));
			await ask('internal comment edit, not the author', api('PUT', `${card}/comments/${s.comment.id}`, { ...helper, body: { content: 'No' } }));
			await ask('v1 comment edit, not the author', api('PUT', `/api/v1/comments/${s.comment.id}`, { ...helper, body: { content: 'No' } }));
			// The comment's own text is refused the same: the guard is asked before
			// an unchanged edit is answered with the comment (card 2284).
			const asItWas = { content: 'As it was' };
			await ask('internal comment edit, unchanged', api('PUT', `${card}/comments/${s.comment.id}`, { ...viewer, body: asItWas }));
			await ask('v1 comment edit, unchanged', api('PUT', `/api/v1/comments/${s.comment.id}`, { ...viewer, body: asItWas }));
			await ask('internal comment edit, unchanged, not the author', api('PUT', `${card}/comments/${s.comment.id}`, { ...helper, body: asItWas }));
			await ask('v1 comment edit, unchanged, not the author', api('PUT', `/api/v1/comments/${s.comment.id}`, { ...helper, body: asItWas }));
			await ask('internal comment delete', api('DELETE', `${card}/comments/${helpers.id}`, viewer));
			await ask('internal comment delete, not the author', api('DELETE', `${card}/comments/${s.comment.id}`, helper));
			await ask('v1 comment delete', api('DELETE', `/api/v1/comments/${helpers.id}`, viewer));
			await ask('v1 comment delete, not the author', api('DELETE', `/api/v1/comments/${s.comment.id}`, helper));
			await ask('internal label', api('PUT', '/api/labels', { ...viewer, body: { cardId: s.first.id, labelId: 1 } }));
			await ask('v1 label on', api('POST', `${v1Card}/labels`, { ...viewer, body: { labelId: 1 } }));
			await ask('v1 label off', api('DELETE', `${v1Card}/labels`, { ...viewer, body: { labelId: 1 } }));
			await ask('internal subtask', api('POST', '/api/subtasks', { ...viewer, body: { cardId: s.first.id, title: 'No' } }));
			await ask('v1 subtask', api('POST', `${v1Card}/subtasks`, { ...viewer, body: { title: 'No' } }));
			await ask('internal subtask tick', api('PUT', '/api/subtasks/1', { ...viewer, body: { completed: true } }));
			await ask('v1 subtask tick', api('PUT', '/api/v1/subtasks/1', { ...viewer, body: { completed: true } }));
			await ask('internal subtask delete', api('DELETE', '/api/subtasks/1', viewer));
			await ask('v1 subtask delete', api('DELETE', '/api/v1/subtasks/1', viewer));
			await sent.settle();
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}

		expect(refusals).toEqual({
			'internal assign': '403 No edit access',
			'v1 assign': "403 No edit access to this card's board",
			'internal unassign': '403 No edit access',
			'v1 unassign': '403 No edit access',
			'internal comment': '403 No edit access',
			'v1 comment': '403 No edit access',
			'internal comment edit': '403 No edit access to this board',
			'v1 comment edit': '403 No edit access to this board',
			'internal comment edit, not the author': '403 You can only edit your own comments',
			'v1 comment edit, not the author': '403 You can only edit your own comments',
			'internal comment edit, unchanged': '403 No edit access to this board',
			'v1 comment edit, unchanged': '403 No edit access to this board',
			'internal comment edit, unchanged, not the author': '403 You can only edit your own comments',
			'v1 comment edit, unchanged, not the author': '403 You can only edit your own comments',
			'internal comment delete': '403 No edit access to this board',
			'internal comment delete, not the author': '403 You can only delete your own comments',
			// The page's words, the v1 delete being new (card 2283, decision 4).
			'v1 comment delete': '403 No edit access to this board',
			'v1 comment delete, not the author': '403 You can only delete your own comments',
			'internal label': '403 No edit access to this board',
			'v1 label on': '403 No edit access to this board',
			'v1 label off': '403 No edit access to this board',
			'internal subtask': '403 No edit access to this board',
			'v1 subtask': "403 No edit access to this card's board",
			'internal subtask tick': '403 No edit access to this board',
			'v1 subtask tick': "403 No edit access to this subtask's board",
			'internal subtask delete': '403 No edit access to this board',
			'v1 subtask delete': "403 No edit access to this subtask's board"
		});
		expectUnchanged(before);
	});

	it("answers what is not there, or not sound, in each tree's own words, rows 6 to 16", async () => {
		const s = subtaskScene();
		const outsider = makeUser({ username: 'outsider' });
		makeLabel(s.A.board, 'Urgent');
		const elsewhere = makeLabel(s.S.board, 'Elsewhere');
		const other = makeCard(s.A.cols['To Do'], { title: 'Other' });
		const as = { user: s.owner };
		const refusals: Record<string, unknown> = {};
		const ask = async (what: string, res: Promise<ApiResult>) => {
			const { status, body } = await res;
			refusals[what] = `${status} ${body?.message}`;
		};
		const card = `/api/cards/${s.first.id}`;
		const v1Card = `/api/v1/cards/${s.first.id}`;
		await ask('internal assign, no card', api('POST', '/api/cards/999/assignees', { ...as, body: { userId: s.helper.id } }));
		await ask('v1 assign, no card', api('POST', '/api/v1/cards/999/assignees', { ...as, body: { userId: s.helper.id } }));
		await ask('internal assign, no userId', api('POST', `${card}/assignees`, { ...as, body: {} }));
		await ask('v1 assign, no userId', api('POST', `${v1Card}/assignees`, { ...as, body: {} }));
		await ask('internal assign, no user', api('POST', `${card}/assignees`, { ...as, body: { userId: 999 } }));
		await ask('v1 assign, no user', api('POST', `${v1Card}/assignees`, { ...as, body: { userId: 999 } }));
		await ask('internal assign, an outsider', api('POST', `${card}/assignees`, { ...as, body: { userId: outsider.id } }));
		await ask('v1 assign, an outsider', api('POST', `${v1Card}/assignees`, { ...as, body: { userId: outsider.id } }));
		await ask('internal unassign, no card', api('DELETE', '/api/cards/999/assignees', { ...as, body: { userId: s.helper.id } }));
		await ask('v1 unassign, no card', api('DELETE', '/api/v1/cards/999/assignees', { ...as, body: { userId: s.helper.id } }));
		await ask('internal unassign, not assigned', api('DELETE', `${card}/assignees`, { ...as, body: { userId: s.viewer.id } }));
		await ask('v1 unassign, not assigned', api('DELETE', `${v1Card}/assignees`, { ...as, body: { userId: s.viewer.id } }));
		await ask('internal comment, no card', api('POST', '/api/cards/999/comments', { ...as, body: { content: 'No' } }));
		await ask('v1 comment, no card', api('POST', '/api/v1/cards/999/comments', { ...as, body: { content: 'No' } }));
		await ask('internal comment, empty', api('POST', `${card}/comments`, { ...as, body: { content: '  ' } }));
		await ask('v1 comment, empty', api('POST', `${v1Card}/comments`, { ...as, body: { content: '  ' } }));
		await ask('internal comment edit, no comment', api('PUT', `${card}/comments/999`, { ...as, body: { content: 'No' } }));
		await ask('v1 comment edit, no comment', api('PUT', '/api/v1/comments/999', { ...as, body: { content: 'No' } }));
		await ask('internal comment edit, on another card', api('PUT', `/api/cards/${other.id}/comments/${s.comment.id}`, { ...as, body: { content: 'No' } }));
		await ask('internal comment edit, empty', api('PUT', `${card}/comments/${s.comment.id}`, { ...as, body: { content: '' } }));
		await ask('v1 comment edit, empty', api('PUT', `/api/v1/comments/${s.comment.id}`, { ...as, body: { content: '' } }));
		await ask('internal comment delete, no comment', api('DELETE', `${card}/comments/999`, as));
		await ask('internal comment delete, on another card', api('DELETE', `/api/cards/${other.id}/comments/${s.comment.id}`, as));
		await ask('v1 comment delete, no comment', api('DELETE', '/api/v1/comments/999', as));
		await ask('v1 comment delete, an id that is none', api('DELETE', '/api/v1/comments/abc', as));
		await ask('internal label, no cardId', api('PUT', '/api/labels', { ...as, body: { labelId: 1 } }));
		await ask('internal label, no card', api('PUT', '/api/labels', { ...as, body: { cardId: 999, labelId: 1 } }));
		await ask('v1 label on, no card', api('POST', '/api/v1/cards/999/labels', { ...as, body: { labelId: 1 } }));
		await ask('internal label, no labelId', api('PUT', '/api/labels', { ...as, body: { cardId: s.first.id } }));
		await ask('v1 label on, no labelId', api('POST', `${v1Card}/labels`, { ...as, body: {} }));
		await ask('v1 label off, no labelId', api('DELETE', `${v1Card}/labels`, { ...as, body: {} }));
		await ask('internal label, no label', api('PUT', '/api/labels', { ...as, body: { cardId: s.first.id, labelId: 999 } }));
		await ask('v1 label on, no label', api('POST', `${v1Card}/labels`, { ...as, body: { labelId: 999 } }));
		await ask("internal label, another board's", api('PUT', '/api/labels', { ...as, body: { cardId: s.first.id, labelId: elsewhere.id } }));
		await ask("v1 label on, another board's", api('POST', `${v1Card}/labels`, { ...as, body: { labelId: elsewhere.id } }));
		await ask('v1 label off, not on the card', api('DELETE', `${v1Card}/labels`, { ...as, body: { labelId: 1 } }));
		await ask('internal subtask, no cardId', api('POST', '/api/subtasks', { ...as, body: { title: 'No' } }));
		await ask('internal subtask, no card', api('POST', '/api/subtasks', { ...as, body: { cardId: 999, title: 'No' } }));
		await ask('v1 subtask, no card', api('POST', '/api/v1/cards/999/subtasks', { ...as, body: { title: 'No' } }));
		await ask('internal subtask, no title', api('POST', '/api/subtasks', { ...as, body: { cardId: s.first.id } }));
		await ask('v1 subtask, no title', api('POST', `${v1Card}/subtasks`, { ...as, body: {} }));
		await ask('v1 subtask, a position that is no number', api('POST', `${v1Card}/subtasks`, { ...as, body: { title: 'No', position: 'top' } }));
		await ask('internal subtask tick, no subtask', api('PUT', '/api/subtasks/999', { ...as, body: { completed: true } }));
		await ask('v1 subtask tick, no subtask', api('PUT', '/api/v1/subtasks/999', { ...as, body: { completed: true } }));
		await ask('internal subtask tick, nothing sent', api('PUT', '/api/subtasks/1', { ...as, body: {} }));
		await ask('v1 subtask tick, nothing sent', api('PUT', '/api/v1/subtasks/1', { ...as, body: {} }));
		await ask('internal subtask delete, no subtask', api('DELETE', '/api/subtasks/999', as));
		await ask('v1 subtask delete, no subtask', api('DELETE', '/api/v1/subtasks/999', as));

		expect(refusals).toEqual({
			'internal assign, no card': '404 Card not found',
			'v1 assign, no card': '404 Card not found',
			'internal assign, no userId': '400 userId is required',
			'v1 assign, no userId': '400 userId is required',
			'internal assign, no user': '404 User not found',
			'v1 assign, no user': '404 User not found',
			'internal assign, an outsider': '400 User does not have access to this board',
			'v1 assign, an outsider': '400 User does not have access to this board',
			'internal unassign, no card': '404 Card not found',
			'v1 unassign, no card': '404 Card not found',
			'internal unassign, not assigned': '404 User is not assigned to this card',
			'v1 unassign, not assigned': '404 User is not assigned to this card',
			'internal comment, no card': '404 Card not found',
			'v1 comment, no card': '404 Card not found',
			'internal comment, empty': '400 Comment cannot be empty',
			'v1 comment, empty': '400 Comment cannot be empty',
			'internal comment edit, no comment': '404 Comment not found',
			'v1 comment edit, no comment': '404 Comment not found',
			'internal comment edit, on another card': '404 Comment not found',
			'internal comment edit, empty': '400 Comment cannot be empty',
			'v1 comment edit, empty': '400 Comment cannot be empty',
			'internal comment delete, no comment': '404 Comment not found',
			'internal comment delete, on another card': '404 Comment not found',
			'v1 comment delete, no comment': '404 Comment not found',
			'v1 comment delete, an id that is none': '400 Invalid comment ID',
			'internal label, no cardId': '400 Invalid card ID',
			'internal label, no card': '404 Card not found',
			'v1 label on, no card': '404 Card not found',
			'internal label, no labelId': '400 Invalid label ID',
			'v1 label on, no labelId': '400 labelId is required',
			'v1 label off, no labelId': '400 labelId is required',
			'internal label, no label': '404 Label not found',
			'v1 label on, no label': '404 Label not found',
			"internal label, another board's": '400 That label belongs to a different board',
			"v1 label on, another board's": "400 Label does not belong to this card's board",
			'v1 label off, not on the card': '404 Label not found on this card',
			'internal subtask, no cardId': '400 Invalid card ID',
			'internal subtask, no card': '404 Card not found',
			'v1 subtask, no card': '404 Card not found',
			'internal subtask, no title': '400 title is required',
			'v1 subtask, no title': '400 title is required',
			'v1 subtask, a position that is no number': '400 position must be a number',
			'internal subtask tick, no subtask': '404 Subtask not found',
			'v1 subtask tick, no subtask': '404 Subtask not found',
			'internal subtask tick, nothing sent': '400 No valid fields to update',
			'v1 subtask tick, nothing sent': '400 No valid fields to update',
			'internal subtask delete, no subtask': '404 Subtask not found',
			'v1 subtask delete, no subtask': '404 Subtask not found'
		});
	});

	it("reads a card's comments and subtasks the same through either tree, and refuses an outsider in each tree's words, rows 8 and 13", async () => {
		const s = subtaskScene();
		const outsider = makeUser({ username: 'outsider' });
		const ids = (body: unknown) => (body as { id: number }[]).map((row) => row.id);
		const said = async (res: Promise<ApiResult>) => {
			const { status, body } = await res;
			return `${status} ${body?.message}`;
		};

		const comments = await api('GET', `/api/cards/${s.first.id}/comments`, { user: s.viewer });
		const v1Comments = await api('GET', `/api/v1/cards/${s.first.id}/comments`, { user: s.viewer });
		expect([comments.status, v1Comments.status]).toEqual([200, 200]);
		expect(ids(comments.body)).toEqual([s.comment.id]);
		expect(ids(v1Comments.body)).toEqual([s.comment.id]);
		const subtasks = await api('GET', `/api/subtasks?cardId=${s.first.id}`, { user: s.viewer });
		const v1Subtasks = await api('GET', `/api/v1/cards/${s.first.id}/subtasks`, { user: s.viewer });
		expect([subtasks.status, v1Subtasks.status]).toEqual([200, 200]);
		expect(ids(subtasks.body)).toEqual([1]);
		expect(ids(v1Subtasks.body)).toEqual([1]);
		// The page's list with no card named is empty, as it was.
		expect((await api('GET', '/api/subtasks', { user: s.viewer })).body).toEqual([]);

		// Comments made in the same second come back the later first, by id, in
		// a list that is newest first (card 2301); they came back in no set
		// order, in practice the earlier first. And an author with no emoji is
		// listed with the placeholder the add answers, not `null` (card 2302).
		db.update(users).set({ emoji: null }).where(eq(users.id, s.helper.id)).run();
		const sent = effects();
		let added: ApiResult[];
		try {
			added = [
				await api('POST', `/api/cards/${s.first.id}/comments`, { user: s.helper, body: { content: 'Two' } }),
				await api('POST', `/api/v1/cards/${s.first.id}/comments`, { user: s.helper, body: { content: 'Three' } })
			];
			await sent.settle();
		} finally {
			sent.restore();
		}
		expect(added.map((res) => res.status)).toEqual([201, 201]);
		const tied = [s.comment.id, ...added.map((res) => res.body.id as number)];
		for (const text of ['Four', 'Five', 'Six']) tied.push(makeComment(s.first, s.owner, text).id);
		const later = makeComment(s.first, s.owner, 'Seven').id;
		for (const id of tied) {
			db.update(cardComments).set({ createdAt: '2026-10-20 09:00:00' }).where(eq(cardComments.id, id)).run();
		}
		db.update(cardComments).set({ createdAt: '2026-10-20 09:00:01' }).where(eq(cardComments.id, later)).run();
		const newestFirst = [later, ...tied.slice().reverse()];
		for (const path of [`/api/cards/${s.first.id}/comments`, `/api/v1/cards/${s.first.id}/comments`]) {
			const listed = await api('GET', path, { user: s.viewer });
			expect(listed.status).toBe(200);
			expect(ids(listed.body)).toEqual(newestFirst);
			const emojiOf = (id: number) => (listed.body as { id: number; userEmoji: unknown }[]).find((row) => row.id === id)!.userEmoji;
			for (const res of added) expect(emojiOf(res.body.id)).toBe(res.body.userEmoji);
			expect(added.map((res) => res.body.userEmoji)).toEqual(['👤', '👤']);
			expect(newestFirst.map(emojiOf).every((emoji) => typeof emoji === 'string' && emoji !== '')).toBe(true);
		}

		expect({
			'internal comments, an outsider': await said(api('GET', `/api/cards/${s.first.id}/comments`, { user: outsider })),
			'v1 comments, an outsider': await said(api('GET', `/api/v1/cards/${s.first.id}/comments`, { user: outsider })),
			'internal comments, no card': await said(api('GET', '/api/cards/999/comments', { user: s.owner })),
			'v1 comments, no card': await said(api('GET', '/api/v1/cards/999/comments', { user: s.owner })),
			'internal subtasks, an outsider': await said(api('GET', `/api/subtasks?cardId=${s.first.id}`, { user: outsider })),
			'v1 subtasks, an outsider': await said(api('GET', `/api/v1/cards/${s.first.id}/subtasks`, { user: outsider })),
			'internal subtasks, no card': await said(api('GET', '/api/subtasks?cardId=999', { user: s.owner })),
			'v1 subtasks, no card': await said(api('GET', '/api/v1/cards/999/subtasks', { user: s.owner }))
		}).toEqual({
			'internal comments, an outsider': '403 No access',
			'v1 comments, an outsider': '403 No access to this board',
			'internal comments, no card': '404 Card not found',
			'v1 comments, no card': '404 Card not found',
			'internal subtasks, an outsider': '403 No access to this board',
			'v1 subtasks, an outsider': "403 No access to this card's board",
			'internal subtasks, no card': '404 Card not found',
			'v1 subtasks, no card': '404 Card not found'
		});
	});

	it("refuses a viewer in each tree's own words, rows 17 to 22, and writes and tells nothing", async () => {
		const s = linkScene(true);
		makeMilestone({ board: s.A.board, name: 'Launch', createdBy: s.owner, cards: [s.first] });
		const viewer = { user: s.viewer };
		const before = snapshotDb();
		const sent = effects();
		const refusals: Record<string, unknown> = {};
		try {
			const ask = async (what: string, res: Promise<ApiResult>) => {
				const { status, body } = await res;
				refusals[what] = `${status} ${body?.message}`;
			};
			const link = { body: { dependsOnCardId: 2 } };
			await ask('internal link', api('POST', `/api/cards/${s.first.id}/dependencies`, { ...viewer, ...link }));
			await ask('v1 link', api('POST', `/api/v1/cards/${s.first.id}/dependencies`, { ...viewer, ...link }));
			await ask('internal unlink', api('DELETE', `/api/cards/${s.first.id}/dependencies`, { ...viewer, ...link }));
			await ask('v1 unlink', api('DELETE', `/api/v1/cards/${s.first.id}/dependencies`, { ...viewer, ...link }));
			await ask('internal subtask link', api('POST', '/api/subtasks/1/dependencies', { ...viewer, ...link }));
			await ask('v1 subtask link', api('POST', '/api/v1/subtasks/1/dependencies', { ...viewer, ...link }));
			await ask('internal subtask unlink', api('DELETE', '/api/subtasks/1/dependencies', { ...viewer, ...link }));
			await ask('v1 subtask unlink', api('DELETE', '/api/v1/subtasks/1/dependencies', { ...viewer, ...link }));
			const goal = { name: 'Mine', boardId: s.A.board.id };
			await ask('internal milestone', api('POST', '/api/milestones', { ...viewer, body: goal }));
			await ask('v1 milestone', api('POST', '/api/v1/milestones', { ...viewer, body: goal }));
			await ask('internal milestone change', api('PATCH', `/api/milestones/${launch()}`, { ...viewer, body: { name: 'No' } }));
			await ask('v1 milestone change', api('PATCH', `/api/v1/milestones/${launch()}`, { ...viewer, body: { name: 'No' } }));
			await ask('internal milestone delete', api('DELETE', `/api/milestones/${launch()}`, viewer));
			await ask('v1 milestone delete', api('DELETE', `/api/v1/milestones/${launch()}`, viewer));
			await ask('internal card in', api('PATCH', `/api/milestones/${launch()}`, { ...viewer, body: { cardId: 2 } }));
			await ask('v1 card in', api('POST', `/api/v1/milestones/${launch()}/cards`, { ...viewer, body: { cardId: 2 } }));
			await ask('internal card out', api('PATCH', `/api/milestones/${launch()}`, { ...viewer, body: { cardId: s.first.id, attach: false } }));
			await ask('v1 card out', api('DELETE', `/api/v1/milestones/${launch()}/cards`, { ...viewer, body: { cardId: s.first.id } }));
			await sent.settle();
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}

		expect(refusals).toEqual({
			'internal link': '403 No edit access',
			'v1 link': "403 No edit access to this card's board",
			// A viewer may read the card in the address; the link is the waiting end's board's to remove.
			'internal unlink': '403 No edit access to the board holding #1, the end that waits',
			'v1 unlink': '403 No edit access to the board holding #1, the end that waits',
			'internal subtask link': "403 No edit access to this subtask's board",
			'v1 subtask link': "403 No edit access to this subtask's board",
			'internal subtask unlink': '403 No edit access to the board holding subtask #1, the end that waits',
			'v1 subtask unlink': '403 No edit access to the board holding subtask #1, the end that waits',
			'internal milestone': '403 No edit access to that board',
			'v1 milestone': '403 No edit access to that board',
			'internal milestone change': '403 No edit access to this milestone',
			'v1 milestone change': '403 No edit access to this milestone',
			'internal milestone delete': '403 No edit access to this milestone',
			'v1 milestone delete': '403 No edit access to this milestone',
			'internal card in': '403 No edit access to this milestone',
			'v1 card in': '403 No edit access to this milestone',
			'internal card out': '403 No edit access to this milestone',
			'v1 card out': '403 No edit access to this milestone'
		});
		expectUnchanged(before);
	});

	it("answers what is not there, or not sound, in each tree's own words, rows 17 to 22", async () => {
		const s = linkScene(false);
		const outsider = makeUser({ username: 'outsider' });
		makeMilestone({ board: s.A.board, name: 'Launch', createdBy: s.owner });
		const as = { user: s.owner };
		const refusals: Record<string, unknown> = {};
		const ask = async (what: string, res: Promise<ApiResult>) => {
			const { status, body } = await res;
			refusals[what] = `${status} ${body?.message}`;
		};
		const card = `/api/cards/${s.first.id}/dependencies`;
		const v1Card = `/api/v1/cards/${s.first.id}/dependencies`;
		const both = { dependsOnCardId: 2, blocksCardId: 2 };
		await ask('internal link, no card', api('POST', '/api/cards/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('v1 link, no card', api('POST', '/api/v1/cards/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('internal link, no end', api('POST', card, { ...as, body: {} }));
		await ask('v1 link, no end', api('POST', v1Card, { ...as, body: {} }));
		await ask('internal link, two ends', api('POST', card, { ...as, body: both }));
		await ask('v1 link, two ends', api('POST', v1Card, { ...as, body: both }));
		await ask('internal link, no other end', api('POST', card, { ...as, body: { dependsOnCardId: 999 } }));
		await ask('v1 link, no other end', api('POST', v1Card, { ...as, body: { dependsOnCardId: 999 } }));
		await ask('internal link, an id that is none', api('POST', card, { ...as, body: { dependsOnCardId: 'two' } }));
		await ask('v1 link, an id that is none', api('POST', v1Card, { ...as, body: { dependsOnCardId: 'two' } }));
		await ask('internal unlink, no card', api('DELETE', '/api/cards/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('v1 unlink, no card', api('DELETE', '/api/v1/cards/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('internal unlink, an outsider', api('DELETE', card, { user: outsider, body: { dependsOnCardId: 2 } }));
		await ask('v1 unlink, an outsider', api('DELETE', v1Card, { user: outsider, body: { dependsOnCardId: 2 } }));
		await ask('internal unlink, no link', api('DELETE', card, { ...as, body: { dependsOnCardId: 2 } }));
		await ask('v1 unlink, no link', api('DELETE', v1Card, { ...as, body: { dependsOnCardId: 2 } }));
		await ask('internal unlink, no end', api('DELETE', card, { ...as, body: {} }));
		await ask('v1 unlink, no end', api('DELETE', v1Card, { ...as, body: {} }));
		await ask('internal subtask link, no subtask', api('POST', '/api/subtasks/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('v1 subtask link, no subtask', api('POST', '/api/v1/subtasks/999/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('internal subtask link, no end', api('POST', '/api/subtasks/1/dependencies', { ...as, body: {} }));
		await ask('v1 subtask link, no end', api('POST', '/api/v1/subtasks/1/dependencies', { ...as, body: {} }));
		await ask('internal subtask link, two ends', api('POST', '/api/subtasks/1/dependencies', { ...as, body: both }));
		await ask('v1 subtask link, two ends', api('POST', '/api/v1/subtasks/1/dependencies', { ...as, body: both }));
		await ask('internal subtask unlink, an outsider', api('DELETE', '/api/subtasks/1/dependencies', { user: outsider, body: { dependsOnCardId: 2 } }));
		await ask('v1 subtask unlink, an outsider', api('DELETE', '/api/v1/subtasks/1/dependencies', { user: outsider, body: { dependsOnCardId: 2 } }));
		await ask('internal subtask unlink, no link', api('DELETE', '/api/subtasks/1/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('v1 subtask unlink, no link', api('DELETE', '/api/v1/subtasks/1/dependencies', { ...as, body: { dependsOnCardId: 2 } }));
		await ask('internal milestone, no name', api('POST', '/api/milestones', { ...as, body: { boardId: s.A.board.id } }));
		await ask('v1 milestone, no name', api('POST', '/api/v1/milestones', { ...as, body: { boardId: s.A.board.id } }));
		await ask('internal milestone, no board', api('POST', '/api/milestones', { ...as, body: { name: 'No', boardId: 999 } }));
		await ask('v1 milestone, no board', api('POST', '/api/v1/milestones', { ...as, body: { name: 'No', boardId: 999 } }));
		await ask('internal milestone, a date that is none', api('POST', '/api/milestones', { ...as, body: { name: 'No', targetDate: 'soon' } }));
		await ask('v1 milestone, a date that is none', api('POST', '/api/v1/milestones', { ...as, body: { name: 'No', targetDate: 'soon' } }));
		await ask('internal milestone change, no milestone', api('PATCH', '/api/milestones/999', { ...as, body: { name: 'No' } }));
		await ask('v1 milestone change, no milestone', api('PATCH', '/api/v1/milestones/999', { ...as, body: { name: 'No' } }));
		await ask('internal milestone change, empty name', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { name: ' ' } }));
		await ask('v1 milestone change, empty name', api('PATCH', `/api/v1/milestones/${launch()}`, { ...as, body: { name: ' ' } }));
		await ask('internal milestone change, a status that is none', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { status: 'done' } }));
		await ask('v1 milestone change, a status that is none', api('PATCH', `/api/v1/milestones/${launch()}`, { ...as, body: { status: 'done' } }));
		await ask('internal milestone change, another board', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { boardId: 999 } }));
		await ask('v1 milestone change, another board', api('PATCH', `/api/v1/milestones/${launch()}`, { ...as, body: { boardId: 999 } }));
		await ask('internal milestone delete, no milestone', api('DELETE', '/api/milestones/999', as));
		await ask('v1 milestone delete, no milestone', api('DELETE', '/api/v1/milestones/999', as));
		await ask('internal card in, no milestone', api('PATCH', '/api/milestones/999', { ...as, body: { cardId: 2 } }));
		await ask('v1 card in, no milestone', api('POST', '/api/v1/milestones/999/cards', { ...as, body: { cardId: 2 } }));
		await ask('internal card in, a cardId that is none', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { cardId: null } }));
		await ask('v1 card in, no cardId', api('POST', `/api/v1/milestones/${launch()}/cards`, { ...as, body: {} }));
		await ask('v1 card in, a cardId that is none', api('POST', `/api/v1/milestones/${launch()}/cards`, { ...as, body: { cardId: null } }));
		await ask('internal card in, no card', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { cardId: 999 } }));
		await ask('v1 card in, no card', api('POST', `/api/v1/milestones/${launch()}/cards`, { ...as, body: { cardId: 999 } }));
		await ask('internal card in, attach that is no boolean', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { cardId: 2, attach: 'false' } }));
		await ask('internal card out, not in it', api('PATCH', `/api/milestones/${launch()}`, { ...as, body: { cardId: 2, attach: false } }));
		await ask('v1 card out, not in it', api('DELETE', `/api/v1/milestones/${launch()}/cards`, { ...as, body: { cardId: 2 } }));
		await ask('v1 card out, no cardId', api('DELETE', `/api/v1/milestones/${launch()}/cards`, { ...as, body: {} }));

		expect(refusals).toEqual({
			'internal link, no card': '404 Card not found',
			'v1 link, no card': '404 Card not found',
			'internal link, no end': '400 Nothing to link',
			'v1 link, no end':
				'400 Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)',
			'internal link, two ends': '400 Provide only one end',
			'v1 link, two ends': '400 Provide only one of the dependsOn*/blocks* fields',
			'internal link, no other end': '404 #999 not found',
			'v1 link, no other end': '404 #999 not found',
			'internal link, an id that is none': '400 dependsOnCardId must be an id',
			'v1 link, an id that is none': '400 dependsOnCardId must be an id',
			'internal unlink, no card': '404 Card not found',
			'v1 unlink, no card': '404 Card not found',
			'internal unlink, an outsider': '403 No access',
			'v1 unlink, an outsider': "403 No access to this card's board",
			'internal unlink, no link': '404 Dependency not found',
			'v1 unlink, no link': '404 Dependency not found',
			'internal unlink, no end': '400 Nothing to link',
			'v1 unlink, no end':
				'400 Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)',
			'internal subtask link, no subtask': '404 Subtask not found',
			'v1 subtask link, no subtask': '404 Subtask not found',
			'internal subtask link, no end':
				'400 Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)',
			'v1 subtask link, no end':
				'400 Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)',
			'internal subtask link, two ends': '400 Provide only one end',
			'v1 subtask link, two ends': '400 Provide only one end',
			'internal subtask unlink, an outsider': '403 No access',
			'v1 subtask unlink, an outsider': '403 No access',
			'internal subtask unlink, no link': '404 Dependency not found',
			'v1 subtask unlink, no link': '404 Dependency not found',
			'internal milestone, no name': '400 name is required',
			'v1 milestone, no name': '400 name is required',
			'internal milestone, no board': '404 Board not found',
			'v1 milestone, no board': '404 Board not found',
			'internal milestone, a date that is none': '400 targetDate must be a date written YYYY-MM-DD',
			'v1 milestone, a date that is none': '400 targetDate must be a date written YYYY-MM-DD',
			'internal milestone change, no milestone': '404 Milestone not found',
			'v1 milestone change, no milestone': '404 Milestone not found',
			'internal milestone change, empty name': '400 name cannot be empty',
			'v1 milestone change, empty name': '400 name cannot be empty',
			'internal milestone change, a status that is none': '400 status must be open or closed',
			'v1 milestone change, a status that is none': '400 status must be open or closed',
			'internal milestone change, another board': '404 Board not found',
			'v1 milestone change, another board': '404 Board not found',
			'internal milestone delete, no milestone': '404 Milestone not found',
			'v1 milestone delete, no milestone': '404 Milestone not found',
			'internal card in, no milestone': '404 Milestone not found',
			'v1 card in, no milestone': '404 Milestone not found',
			'internal card in, a cardId that is none': '400 cardId must be an id',
			'v1 card in, no cardId': '400 cardId is required',
			'v1 card in, a cardId that is none': '400 cardId must be an id',
			'internal card in, no card': '404 Card not found',
			'v1 card in, no card': '404 Card not found',
			'internal card in, attach that is no boolean': '400 attach must be true or false',
			'internal card out, not in it': '404 Card is not in this milestone',
			'v1 card out, not in it': '404 Card is not in this milestone',
			'v1 card out, no cardId': '400 cardId is required'
		});
	});

	it("reads dependencies, a card's cost, a milestone and its plan alike through either tree, and refuses in each tree's words, rows 17 to 19, 22 and 23", async () => {
		const s = linkScene(true);
		const outsider = makeUser({ username: 'outsider' });
		makeMilestone({ board: s.A.board, name: 'Launch', createdBy: s.owner, cards: [s.first] });
		db.insert(tokenUsage).values({ cardId: s.first.id, tokens: 5000, model: 'claude-opus-5', reportedByUserId: s.owner.id }).run();
		const viewer = { user: s.viewer };
		/** A body with every timestamp masked: each tree writes its own form. */
		const stamped = (body: unknown) => JSON.parse(JSON.stringify(body), (_key, value) => (typeof value === 'string' && STAMP.test(value) ? '<stamp>' : value));
		const pair = async (internalPath: string, v1Path: string) => {
			const [internal, v1] = [await api('GET', internalPath, viewer), await api('GET', v1Path, viewer)];
			expect([internal.status, v1.status]).toEqual([200, 200]);
			return { internal: stamped(internal.body), v1: stamped(v1.body) };
		};

		// A card's links: v1 adds each link's id, who made it and when (an option of the read).
		const links = await pair(`/api/cards/${s.first.id}/dependencies`, `/api/v1/cards/${s.first.id}/dependencies`);
		expect(links.internal.blockedBy).toHaveLength(1);
		const bare = (ends: Record<string, unknown>[]) => ends.map(({ id: _id, createdByUserId: _by, createdAt: _at, ...end }) => end);
		expect({ ...links.v1, blockedBy: bare(links.v1.blockedBy), blocks: bare(links.v1.blocks) }).toEqual(links.internal);
		expect(links.v1.blockedBy[0]).toMatchObject({ id: 1, createdByUserId: s.owner.id, createdAt: '<stamp>' });
		const onlyBlocks = await api('GET', `/api/v1/cards/${s.first.id}/dependencies?direction=blocks`, viewer);
		expect(Object.keys(onlyBlocks.body)).toEqual(['cardId', 'isBlocked', 'blocks']);
		// A subtask's, the same in both.
		const subtaskLinks = await pair('/api/subtasks/1/dependencies', '/api/v1/subtasks/1/dependencies');
		expect(subtaskLinks.internal.blockedBy).toHaveLength(1);
		expect(subtaskLinks.v1).toEqual(subtaskLinks.internal);
		// A card's cost, the same in both.
		const cost = await pair(`/api/cards/${s.first.id}/tokens`, `/api/v1/cards/${s.first.id}/tokens`);
		expect(cost.internal).toMatchObject({ cardId: s.first.id, recorded: true, total: 5000 });
		expect(cost.v1).toEqual(cost.internal);
		// One milestone: v1 adds its cards.
		const goal = await pair(`/api/milestones/${launch()}`, `/api/v1/milestones/${launch()}`);
		expect(goal.internal.name).toBe('Launch');
		const { cards: held, ...row } = goal.v1;
		expect(row).toEqual(goal.internal);
		expect(held).toEqual([{ id: s.first.id, title: 'First', priority: 'medium', columnId: s.A.cols['To Do'].id, columnTitle: 'To Do', boardId: s.A.board.id, withheld: false }]);
		// Its plan, the same in both.
		const plan = await pair(`/api/milestones/${launch()}/summary`, `/api/v1/milestones/${launch()}/summary`);
		expect(plan.internal.progress.total).toBe(1);
		expect(plan.v1).toEqual(plan.internal);

		const said = async (path: string, user = outsider) => {
			const { status, body } = await api('GET', path, { user });
			return `${status} ${body?.message}`;
		};
		expect({
			'internal links, an outsider': await said(`/api/cards/${s.first.id}/dependencies`),
			'v1 links, an outsider': await said(`/api/v1/cards/${s.first.id}/dependencies`),
			'internal links, no card': await said('/api/cards/999/dependencies', s.owner),
			'v1 links, no card': await said('/api/v1/cards/999/dependencies', s.owner),
			'v1 links, a direction that is none': await said(`/api/v1/cards/${s.first.id}/dependencies?direction=up`, s.owner),
			'v1 links, a direction that is none, no card': await said('/api/v1/cards/999/dependencies?direction=up', s.owner),
			'internal subtask links, an outsider': await said('/api/subtasks/1/dependencies'),
			'v1 subtask links, an outsider': await said('/api/v1/subtasks/1/dependencies'),
			'internal subtask links, no subtask': await said('/api/subtasks/999/dependencies', s.owner),
			'v1 subtask links, no subtask': await said('/api/v1/subtasks/999/dependencies', s.owner),
			'internal cost, an outsider': await said(`/api/cards/${s.first.id}/tokens`),
			'v1 cost, an outsider': await said(`/api/v1/cards/${s.first.id}/tokens`),
			'internal cost, no card': await said('/api/cards/999/tokens', s.owner),
			'v1 cost, no card': await said('/api/v1/cards/999/tokens', s.owner),
			'internal milestone, an outsider': await said(`/api/milestones/${launch()}`),
			'v1 milestone, an outsider': await said(`/api/v1/milestones/${launch()}`),
			'internal milestone, none': await said('/api/milestones/999', s.owner),
			'v1 milestone, none': await said('/api/v1/milestones/999', s.owner),
			'internal plan, an outsider': await said(`/api/milestones/${launch()}/summary`),
			'v1 plan, an outsider': await said(`/api/v1/milestones/${launch()}/summary`),
			'internal plan, none': await said('/api/milestones/999/summary', s.owner),
			'v1 plan, none': await said('/api/v1/milestones/999/summary', s.owner),
			'internal plan PDF, an outsider': await said(`/api/milestones/${launch()}/pdf`),
			'v1 plan PDF, an outsider': await said(`/api/v1/milestones/${launch()}/pdf`)
		}).toEqual({
			'internal links, an outsider': '403 No access',
			'v1 links, an outsider': "403 No access to this card's board",
			'internal links, no card': '404 Card not found',
			'v1 links, no card': '404 Card not found',
			'v1 links, a direction that is none': '400 direction must be one of: blocked-by, blocks, both',
			'v1 links, a direction that is none, no card': '404 Card not found',
			'internal subtask links, an outsider': '403 No access',
			'v1 subtask links, an outsider': '403 No access',
			'internal subtask links, no subtask': '404 Subtask not found',
			'v1 subtask links, no subtask': '404 Subtask not found',
			'internal cost, an outsider': '403 No access to this board',
			'v1 cost, an outsider': '403 No access to this board',
			'internal cost, no card': '404 Card not found',
			'v1 cost, no card': '404 Card not found',
			'internal milestone, an outsider': '403 No access to this milestone',
			'v1 milestone, an outsider': '403 No access to this milestone',
			'internal milestone, none': '404 Milestone not found',
			'v1 milestone, none': '404 Milestone not found',
			'internal plan, an outsider': '403 No access to this milestone',
			'v1 plan, an outsider': '403 No access to this milestone',
			'internal plan, none': '404 Milestone not found',
			'v1 plan, none': '404 Milestone not found',
			'internal plan PDF, an outsider': '403 No access to this milestone',
			'v1 plan PDF, an outsider': '403 No access to this milestone'
		});
	});

	it('records, takes back and records in bulk a cost through v1 alone, as it did, each telling the board once committed, row 20', async () => {
		const tokens = { tokens: 5000, model: 'claude-opus-5', note: 'the fix' };
		const withEntry = () => {
			const s = linkScene(false);
			db.insert(tokenUsage).values({ cardId: s.first.id, tokens: 5000, model: 'claude-opus-5', reportedByUserId: s.owner.id }).run();
			return s;
		};
		const writes: [string, (s: Scene) => Promise<ApiResult>][] = [
			['on a card', (s) => api('POST', `/api/v1/cards/${s.first.id}/tokens`, { user: s.owner, body: tokens })],
			['on a subtask', (s) => api('POST', '/api/v1/subtasks/1/tokens', { user: s.owner, body: tokens })],
			['an entry taken back', (s) => api('DELETE', '/api/v1/tokens/1', { user: s.owner })],
			['in bulk', (s) => api('POST', '/api/v1/tokens/bulk', { user: s.owner, body: { entries: [{ cardId: s.first.id, ...tokens }, { subtaskId: 1, ...tokens }] } })],
			['in bulk, refused', (s) => api('POST', '/api/v1/tokens/bulk', { user: s.owner, body: { entries: [{ cardId: 999, ...tokens }] } })]
		];
		const done: Record<string, unknown> = {};
		for (const [what, request] of writes) {
			const { status, rows, entries: written, told } = await served(withEntry, request);
			done[what] = { status, rows: rows.map((r) => `${r.table} ${r.was ? (r.is ? 'changed' : 'removed') : 'added'}`), entries: written.length, told };
		}
		expect(done).toEqual({
			'on a card': { status: 201, rows: ['sqlite_sequence changed', 'token_usage added'], entries: 0, told: [CARD_UPDATE] },
			'on a subtask': { status: 201, rows: ['sqlite_sequence changed', 'token_usage added'], entries: 0, told: [CARD_UPDATE] },
			'an entry taken back': { status: 200, rows: ['token_usage removed'], entries: 0, told: [CARD_UPDATE] },
			'in bulk': { status: 201, rows: ['sqlite_sequence changed', 'token_usage added', 'token_usage added'], entries: 0, told: [CARD_UPDATE] },
			'in bulk, refused': { status: 409, rows: [], entries: 0, told: [] }
		});
	});

	it("refuses a viewer, and an editor where the owner is asked for, in each tree's own words, rows 24 to 30, and writes and tells nothing", async () => {
		const s = boardScene();
		const viewer = { user: s.viewer };
		const helper = { user: s.helper };
		const before = snapshotDb();
		const sent = effects();
		const refusals: Record<string, unknown> = {};
		try {
			const ask = async (what: string, res: Promise<ApiResult>) => {
				const { status, body } = await res;
				refusals[what] = `${status} ${body?.message}`;
			};
			const A = s.A.board.id;
			const column = s.A.cols['On Hold'].id;
			const under = { name: 'No', parentCardId: s.first.id };
			await ask('internal board under a card', api('POST', '/api/boards', { ...viewer, body: under }));
			await ask('v1 board under a card', api('POST', '/api/v1/boards', { ...viewer, body: under }));
			await ask('internal board change', api('PUT', `/api/boards/${A}`, { ...viewer, body: { name: 'No' } }));
			await ask('v1 board change', api('PUT', `/api/v1/boards/${A}`, { ...viewer, body: { name: 'No' } }));
			await ask('internal board made public by an editor', api('PUT', `/api/boards/${A}`, { ...helper, body: { name: 'No', isPublic: true } }));
			await ask('v1 board made public by an editor', api('PUT', `/api/v1/boards/${A}`, { ...helper, body: { name: 'No', isPublic: true } }));
			await ask('internal board delete by an editor', api('DELETE', `/api/boards/${A}`, helper));
			await ask('v1 board delete by an editor', api('DELETE', `/api/v1/boards/${A}`, helper));
			await ask('internal grouping change', api('PUT', '/api/board-categories/1', { ...viewer, body: { name: 'No' } }));
			await ask('v1 grouping change', api('PUT', '/api/v1/board-categories/1', { ...viewer, body: { name: 'No' } }));
			await ask('internal grouping delete', api('DELETE', '/api/board-categories/1', viewer));
			await ask('v1 grouping delete', api('DELETE', '/api/v1/board-categories/1', viewer));
			await ask('internal column', api('POST', '/api/columns', { ...viewer, body: { boardId: A, title: 'No' } }));
			await ask('v1 column', api('POST', `/api/v1/boards/${A}/columns`, { ...viewer, body: { title: 'No' } }));
			await ask('internal column change', api('PUT', `/api/columns/${column}`, { ...viewer, body: { title: 'No' } }));
			await ask('v1 column change', api('PUT', `/api/v1/columns/${column}`, { ...viewer, body: { title: 'No' } }));
			await ask('internal column delete', api('DELETE', `/api/columns/${column}`, viewer));
			await ask('v1 column delete', api('DELETE', `/api/v1/columns/${column}`, viewer));
			await ask('internal column reorder', api('PUT', '/api/columns/reorder', { ...viewer, body: { updates: [{ id: column, position: 9 }] } }));
			await ask('internal category', api('POST', '/api/categories', { ...viewer, body: { boardId: A, name: 'No' } }));
			await ask('internal category of no board', api('POST', '/api/categories', { ...viewer, body: { name: 'No' } }));
			await ask('v1 category', api('POST', `/api/v1/boards/${A}/categories`, { ...viewer, body: { name: 'No' } }));
			await ask('internal category change', api('PUT', '/api/categories/1', { ...viewer, body: { name: 'No' } }));
			await ask('v1 category change', api('PUT', '/api/v1/categories/1', { ...viewer, body: { name: 'No' } }));
			await ask('internal category delete', api('DELETE', '/api/categories/1', viewer));
			await ask('v1 category delete', api('DELETE', '/api/v1/categories/1', viewer));
			await ask('internal label', api('POST', '/api/labels', { ...viewer, body: { boardId: A, name: 'No' } }));
			await ask('v1 label', api('POST', `/api/v1/boards/${A}/labels`, { ...viewer, body: { name: 'No' } }));
			await ask('internal label change', api('PATCH', '/api/labels', { ...viewer, body: { id: 1, name: 'No' } }));
			await ask('v1 label change', api('PUT', '/api/v1/labels/1', { ...viewer, body: { name: 'No' } }));
			await ask('internal label delete', api('DELETE', '/api/labels', { ...viewer, body: { id: 1 } }));
			await ask('v1 label delete', api('DELETE', '/api/v1/labels/1', viewer));
			await sent.settle();
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}

		expect(refusals).toEqual({
			'internal board under a card': "403 No edit access to the parent card's board",
			'v1 board under a card': "403 No edit access to the parent card's board",
			'internal board change': '403 No edit access to this board',
			'v1 board change': '403 No edit access to this board',
			'internal board made public by an editor': '403 Only board owners and admins can change visibility',
			'v1 board made public by an editor': '403 Only board owners and admins can change visibility',
			'internal board delete by an editor': '403 Only board owners and admins can delete boards',
			'v1 board delete by an editor': '403 Only board owners and admins can delete boards',
			'internal grouping change': '403 This category groups boards you cannot edit',
			'v1 grouping change': '403 This category groups boards you cannot edit',
			'internal grouping delete': '403 This category groups boards you cannot edit',
			'v1 grouping delete': '403 This category groups boards you cannot edit',
			'internal column': '403 No edit access to this board',
			'v1 column': '403 No edit access to this board',
			'internal column change': '403 No edit access to this board',
			'v1 column change': '403 No edit access to this board',
			'internal column delete': '403 No edit access to this board',
			'v1 column delete': '403 No edit access to this board',
			'internal column reorder': '403 No edit access to this board',
			'internal category': '403 No edit access to this board',
			'internal category of no board': '403 Only an administrator can create a category that belongs to no board',
			'v1 category': '403 No edit access to this board',
			'internal category change': '403 No edit access to this board',
			'v1 category change': '403 No edit access to this board',
			'internal category delete': '403 No edit access to this board',
			'v1 category delete': '403 No edit access to this board',
			'internal label': '403 No edit access to this board',
			'v1 label': '403 No edit access to this board',
			'internal label change': '403 No edit access to this board',
			'v1 label change': '403 No edit access to this board',
			'internal label delete': '403 No edit access to this board',
			'v1 label delete': '403 No edit access to this board'
		});
		expectUnchanged(before);
	});

	it("answers what is not there, or not sound, in each tree's own words, rows 24 to 30", async () => {
		const s = boardScene();
		const as = { user: s.owner };
		const refusals: Record<string, unknown> = {};
		const ask = async (what: string, res: Promise<ApiResult>) => {
			const { status, body } = await res;
			refusals[what] = `${status} ${body?.message}`;
		};
		const A = s.A.board.id;
		const column = s.A.cols['On Hold'].id;
		await ask('internal board, no name', api('POST', '/api/boards', { ...as, body: { emoji: '🗺️' } }));
		await ask('v1 board, no name', api('POST', '/api/v1/boards', { ...as, body: { emoji: '🗺️' } }));
		await ask('internal board, no parent card', api('POST', '/api/boards', { ...as, body: { name: 'No', parentCardId: 999 } }));
		await ask('v1 board, no parent card', api('POST', '/api/v1/boards', { ...as, body: { name: 'No', parentCardId: 999 } }));
		await ask('internal board, no grouping', api('POST', '/api/boards', { ...as, body: { name: 'No', categoryId: 999 } }));
		await ask('internal board change, no board', api('PUT', '/api/boards/999', { ...as, body: { name: 'No' } }));
		await ask('v1 board change, no board', api('PUT', '/api/v1/boards/999', { ...as, body: { name: 'No' } }));
		await ask('internal board change, nothing sent', api('PUT', `/api/boards/${A}`, { ...as, body: {} }));
		await ask('v1 board change, nothing sent', api('PUT', `/api/v1/boards/${A}`, { ...as, body: {} }));
		await ask('internal board change, empty name', api('PUT', `/api/boards/${A}`, { ...as, body: { name: ' ' } }));
		await ask('v1 board change, empty name', api('PUT', `/api/v1/boards/${A}`, { ...as, body: { name: ' ' } }));
		await ask('internal board change, no grouping', api('PUT', `/api/boards/${A}`, { ...as, body: { categoryId: 999 } }));
		await ask('v1 board change, no grouping', api('PUT', `/api/v1/boards/${A}`, { ...as, body: { categoryId: 999 } }));
		await ask('internal board change, under no card', api('PUT', `/api/boards/${A}`, { ...as, body: { parentCardId: 999 } }));
		await ask('internal board delete, no board', api('DELETE', '/api/boards/999', as));
		await ask('v1 board delete, no board', api('DELETE', '/api/v1/boards/999', as));
		await ask('internal grouping, no name', api('POST', '/api/board-categories', { ...as, body: { color: '#123456' } }));
		await ask('v1 grouping, no name', api('POST', '/api/v1/board-categories', { ...as, body: { color: '#123456' } }));
		await ask('internal grouping, a colour that is none', api('POST', '/api/board-categories', { ...as, body: { name: 'No', color: 'red' } }));
		await ask('v1 grouping, a colour that is none', api('POST', '/api/v1/board-categories', { ...as, body: { name: 'No', color: 'red' } }));
		await ask('internal grouping change, none', api('PUT', '/api/board-categories/999', { ...as, body: { name: 'No' } }));
		await ask('v1 grouping change, none', api('PUT', '/api/v1/board-categories/999', { ...as, body: { name: 'No' } }));
		await ask('internal grouping change, nothing sent', api('PUT', '/api/board-categories/1', { ...as, body: {} }));
		await ask('v1 grouping change, nothing sent', api('PUT', '/api/v1/board-categories/1', { ...as, body: {} }));
		await ask('internal grouping change, empty name', api('PUT', '/api/board-categories/1', { ...as, body: { name: '' } }));
		await ask('v1 grouping change, empty name', api('PUT', '/api/v1/board-categories/1', { ...as, body: { name: '' } }));
		await ask('internal grouping delete, none', api('DELETE', '/api/board-categories/999', as));
		await ask('v1 grouping delete, none', api('DELETE', '/api/v1/board-categories/999', as));
		await ask('internal column, no boardId', api('POST', '/api/columns', { ...as, body: { title: 'No' } }));
		await ask('internal column, no board', api('POST', '/api/columns', { ...as, body: { boardId: 999, title: 'No' } }));
		await ask('v1 column, no board', api('POST', '/api/v1/boards/999/columns', { ...as, body: { title: 'No' } }));
		await ask('internal column, no title', api('POST', '/api/columns', { ...as, body: { boardId: A } }));
		await ask('v1 column, no title', api('POST', `/api/v1/boards/${A}/columns`, { ...as, body: {} }));
		// Each tree reads the position and the colour in its own order (R2).
		const both = { title: 'No', position: 'top', color: 'red' };
		await ask('internal column, position and colour unsound', api('POST', '/api/columns', { ...as, body: { boardId: A, ...both } }));
		await ask('v1 column, position and colour unsound', api('POST', `/api/v1/boards/${A}/columns`, { ...as, body: both }));
		await ask('internal column change, none', api('PUT', '/api/columns/999', { ...as, body: { title: 'No' } }));
		await ask('v1 column change, none', api('PUT', '/api/v1/columns/999', { ...as, body: { title: 'No' } }));
		await ask('internal column change, nothing sent', api('PUT', `/api/columns/${column}`, { ...as, body: {} }));
		await ask('v1 column change, nothing sent', api('PUT', `/api/v1/columns/${column}`, { ...as, body: {} }));
		await ask('internal column change, empty title', api('PUT', `/api/columns/${column}`, { ...as, body: { title: '' } }));
		await ask('v1 column change, empty title', api('PUT', `/api/v1/columns/${column}`, { ...as, body: { title: '' } }));
		await ask('internal column change, Complete with a card', api('PUT', `/api/columns/${s.A.cols['To Do'].id}`, { ...as, body: { title: 'Complete' } }));
		await ask('v1 column change, Complete with a card', api('PUT', `/api/v1/columns/${s.A.cols['To Do'].id}`, { ...as, body: { title: 'Complete' } }));
		await ask('internal column delete, none', api('DELETE', '/api/columns/999', as));
		await ask('v1 column delete, none', api('DELETE', '/api/v1/columns/999', as));
		await ask('internal column reorder, no updates', api('PUT', '/api/columns/reorder', { ...as, body: {} }));
		await ask('internal column reorder, no column', api('PUT', '/api/columns/reorder', { ...as, body: { updates: [{ id: 999, position: 1 }] } }));
		await ask('internal column reorder, a position that is none', api('PUT', '/api/columns/reorder', { ...as, body: { updates: [{ id: column, position: 'top' }] } }));
		await ask('internal category, no board', api('POST', '/api/categories', { ...as, body: { boardId: 999, name: 'No' } }));
		await ask('v1 category, no board', api('POST', '/api/v1/boards/999/categories', { ...as, body: { name: 'No' } }));
		await ask('internal category, no name', api('POST', '/api/categories', { ...as, body: { boardId: A } }));
		await ask('v1 category, no name', api('POST', `/api/v1/boards/${A}/categories`, { ...as, body: {} }));
		await ask('internal category change, none', api('PUT', '/api/categories/999', { ...as, body: { name: 'No' } }));
		await ask('v1 category change, none', api('PUT', '/api/v1/categories/999', { ...as, body: { name: 'No' } }));
		await ask('internal category change, nothing sent', api('PUT', '/api/categories/1', { ...as, body: {} }));
		await ask('v1 category change, nothing sent', api('PUT', '/api/v1/categories/1', { ...as, body: {} }));
		await ask('internal category change, empty name', api('PUT', '/api/categories/1', { ...as, body: { name: '' } }));
		await ask('v1 category change, empty name', api('PUT', '/api/v1/categories/1', { ...as, body: { name: '' } }));
		await ask('internal category delete, none', api('DELETE', '/api/categories/999', as));
		await ask('v1 category delete, none', api('DELETE', '/api/v1/categories/999', as));
		await ask('internal label, no boardId', api('POST', '/api/labels', { ...as, body: { name: 'No' } }));
		await ask('internal label, no board', api('POST', '/api/labels', { ...as, body: { boardId: 999, name: 'No' } }));
		await ask('v1 label, no board', api('POST', '/api/v1/boards/999/labels', { ...as, body: { name: 'No' } }));
		await ask('internal label, no name', api('POST', '/api/labels', { ...as, body: { boardId: A } }));
		await ask('v1 label, no name', api('POST', `/api/v1/boards/${A}/labels`, { ...as, body: {} }));
		await ask('internal label change, no id', api('PATCH', '/api/labels', { ...as, body: { name: 'No' } }));
		await ask('internal label change, none', api('PATCH', '/api/labels', { ...as, body: { id: 999, name: 'No' } }));
		await ask('v1 label change, none', api('PUT', '/api/v1/labels/999', { ...as, body: { name: 'No' } }));
		await ask('internal label change, nothing sent', api('PATCH', '/api/labels', { ...as, body: { id: 1 } }));
		await ask('v1 label change, nothing sent', api('PUT', '/api/v1/labels/1', { ...as, body: {} }));
		await ask('internal label change, empty name', api('PATCH', '/api/labels', { ...as, body: { id: 1, name: '' } }));
		await ask('v1 label change, empty name', api('PUT', '/api/v1/labels/1', { ...as, body: { name: '' } }));
		await ask('internal label delete, no id', api('DELETE', '/api/labels', { ...as, body: {} }));
		await ask('internal label delete, none', api('DELETE', '/api/labels', { ...as, body: { id: 999 } }));
		await ask('v1 label delete, none', api('DELETE', '/api/v1/labels/999', as));

		const completeRefused =
			'409 This column holds 1 card. Renaming it to "Complete" would mark it finished without anyone finishing it. ' +
			'Move each finished card to a Complete column and the rest out of this one first, or choose another name.';
		expect(refusals).toEqual({
			'internal board, no name': '400 name is required',
			'v1 board, no name': '400 name is required',
			'internal board, no parent card': '404 Parent card not found',
			'v1 board, no parent card': '404 Parent card not found',
			'internal board, no grouping': '404 Board category not found',
			'internal board change, no board': '404 Board not found',
			'v1 board change, no board': '404 Board not found',
			// R2: the internal route answers an empty change as it did, v1 refuses it.
			'internal board change, nothing sent': '200 undefined',
			'v1 board change, nothing sent': '400 No valid fields to update',
			'internal board change, empty name': '400 name cannot be empty',
			'v1 board change, empty name': '400 name cannot be empty',
			'internal board change, no grouping': '404 Board category not found',
			'v1 board change, no grouping': '404 Board category not found',
			'internal board change, under no card': '404 Parent card not found',
			'internal board delete, no board': '404 Board not found',
			'v1 board delete, no board': '404 Board not found',
			'internal grouping, no name': '400 name is required',
			'v1 grouping, no name': '400 name is required',
			'internal grouping, a colour that is none': '400 color must be a colour written #rrggbb',
			'v1 grouping, a colour that is none': '400 color must be a colour written #rrggbb',
			'internal grouping change, none': '404 Board category not found',
			'v1 grouping change, none': '404 Board category not found',
			'internal grouping change, nothing sent': '400 No valid fields to update',
			'v1 grouping change, nothing sent': '400 No valid fields to update',
			'internal grouping change, empty name': '400 name cannot be empty',
			'v1 grouping change, empty name': '400 name cannot be empty',
			'internal grouping delete, none': '404 Board category not found',
			'v1 grouping delete, none': '404 Board category not found',
			'internal column, no boardId': '400 Invalid board ID',
			'internal column, no board': '404 Board not found',
			'v1 column, no board': '404 Board not found',
			'internal column, no title': '400 title is required',
			'v1 column, no title': '400 title is required',
			'internal column, position and colour unsound': '400 position must be a number',
			'v1 column, position and colour unsound': '400 color must be a colour written #rrggbb',
			'internal column change, none': '404 Column not found',
			'v1 column change, none': '404 Column not found',
			'internal column change, nothing sent': '400 No valid fields to update',
			'v1 column change, nothing sent': '400 No valid fields to update',
			'internal column change, empty title': '400 title cannot be empty',
			'v1 column change, empty title': '400 title cannot be empty',
			'internal column change, Complete with a card': completeRefused,
			'v1 column change, Complete with a card': completeRefused,
			'internal column delete, none': '404 Column not found',
			'v1 column delete, none': '404 Column not found',
			'internal column reorder, no updates': '400 updates must be an array',
			'internal column reorder, no column': '404 Column not found',
			'internal column reorder, a position that is none': '400 updates[0].position must be a number',
			'internal category, no board': '404 Board not found',
			'v1 category, no board': '404 Board not found',
			'internal category, no name': '400 name is required',
			'v1 category, no name': '400 name is required',
			'internal category change, none': '404 Category not found',
			'v1 category change, none': '404 Category not found',
			'internal category change, nothing sent': '400 No valid fields to update',
			'v1 category change, nothing sent': '400 No valid fields to update',
			'internal category change, empty name': '400 name cannot be empty',
			'v1 category change, empty name': '400 name cannot be empty',
			'internal category delete, none': '404 Category not found',
			'v1 category delete, none': '404 Category not found',
			'internal label, no boardId': '400 Invalid board ID',
			'internal label, no board': '404 Board not found',
			'v1 label, no board': '404 Board not found',
			'internal label, no name': '400 name is required',
			'v1 label, no name': '400 name is required',
			'internal label change, no id': '400 Invalid label ID',
			'internal label change, none': '404 Label not found',
			'v1 label change, none': '404 Label not found',
			'internal label change, nothing sent': '400 Send name or color to change',
			'v1 label change, nothing sent': '400 No valid fields to update',
			'internal label change, empty name': '400 name cannot be empty',
			'v1 label change, empty name': '400 name cannot be empty',
			'internal label delete, no id': '400 Invalid label ID',
			'internal label delete, none': '404 Label not found',
			'v1 label delete, none': '404 Label not found'
		});
	});

	it("lists boards and a board's labels alike through either tree, and refuses in each tree's words, rows 24 and 30", async () => {
		const s = boardScene();
		const outsider = makeUser({ username: 'outsider' });
		const elsewhere = makeBoard({ name: 'Not shared' });
		makeLabel(elsewhere.board, 'Theirs');
		const said = async (path: string, user = outsider) => {
			const { status, body } = await api('GET', path, { user });
			return `${status} ${body?.message}`;
		};
		const ids = (body: unknown) => (body as { id: number }[]).map((row) => row.id);
		const stamped = (body: unknown) => JSON.parse(JSON.stringify(body), (_key, value) => (typeof value === 'string' && STAMP.test(value) ? '<stamp>' : value));

		// The boards the caller can open, newest first, and every board for an administrator.
		for (const user of [s.viewer, s.owner, makeUser({ username: 'admin', role: 'admin' })]) {
			const [internal, v1] = [await api('GET', '/api/boards', { user }), await api('GET', '/api/v1/boards', { user })];
			expect([internal.status, v1.status]).toEqual([200, 200]);
			expect(stamped(v1.body)).toEqual(stamped(internal.body));
		}
		expect(ids((await api('GET', '/api/boards', { user: s.viewer })).body)).toEqual([s.A.board.id]);
		expect(ids((await api('GET', '/api/boards', { user: outsider })).body)).toEqual([]);
		// A board's labels.
		const labels = await api('GET', `/api/labels?boardId=${s.A.board.id}`, { user: s.viewer });
		const v1Labels = await api('GET', `/api/v1/boards/${s.A.board.id}/labels`, { user: s.viewer });
		expect([labels.status, v1Labels.status]).toEqual([200, 200]);
		expect(ids(labels.body)).toEqual([1]);
		expect(v1Labels.body).toEqual(labels.body);
		// The page's list with no board named is empty, as it was.
		expect((await api('GET', '/api/labels', { user: s.viewer })).body).toEqual([]);

		expect({
			'internal labels, an outsider': await said(`/api/labels?boardId=${s.A.board.id}`),
			'v1 labels, an outsider': await said(`/api/v1/boards/${s.A.board.id}/labels`),
			'internal labels, no board': await said('/api/labels?boardId=999', s.owner),
			'v1 labels, no board': await said('/api/v1/boards/999/labels', s.owner),
			'internal labels, a board id that is none': await said('/api/labels?boardId=two', s.owner)
		}).toEqual({
			'internal labels, an outsider': '403 No access to this board',
			'v1 labels, an outsider': '403 No access to this board',
			'internal labels, no board': '404 Board not found',
			'v1 labels, no board': '404 Board not found',
			'internal labels, a board id that is none': '400 Invalid boardId'
		});
	});

	it('has a case for each pair moved so far that writes in both trees, rows 1 to 7, 9 to 12, 14 to 18, 21, 22, 24 to 27, 29 and 30', () => {
		// Rows 8, 13, 19 and 23 are reads, row 28 (the column reorder) the
		// page's alone, and row 20 (the token writes) v1's alone: the cases
		// above hold their words and what they do. Row 11 (a comment deleted)
		// was the page's alone until v1 had a delete (card 2283).
		expect([...new Set(SERVICE_TWINS.map((twin) => twin.row))]).toEqual([
			1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 18, 21, 22, 24, 25, 26, 27, 29, 30
		]);
	});

	it('hands each service exactly the options its handler took before it moved, read from the source (R3)', () => {
		expect(serviceCalls()).toEqual(SERVICE_OPTIONS);
	});
});

/** A value written in a call: a literal as itself, anything else as the code it is (`{ code: 'baseUrl' }`). */
type Written = string | boolean | null | { code: string } | { [property: string]: Written };

/** A name or expression written in the call, as `Written` has it. */
const code = (text: string) => ({ code: text });

/**
 * Each handler moved onto a service, and its call of the service, read as
 * written: each argument, and each property of an object written out at the
 * call, its value a literal or the code it is. What a handler hands its
 * service, its tree's options among them (`allowMove`, `allowMilestone`,
 * `allowRestore`, `refuseEmpty`, `tellBeforeEntry`, `says`, `source`), is
 * what the handler took and refused with before it moved. A handler that
 * calls a service and is not here fails, and so does one here that no longer
 * calls it so; the order of an object's properties is not compared.
 */
const SERVICE_OPTIONS: Record<string, { service: string; args: Written[] }[]> = {
	'src/routes/api/boards/[id]/archive/+server.ts POST': [
		{ service: 'restoreCardFor', args: [code('caller'), { boardId: code('pathBoardId') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/cards/+server.ts POST': [
		{ service: 'createCard', args: [code('caller'), {}, code('body'), { source: 'ui', baseUrl: code('baseUrl') }] }
	],
	'src/routes/api/cards/[id]/+server.ts PUT': [
		{ service: 'updateCard', args: [code('caller'), { cardId: code('id') }, code('body'), { source: 'ui', baseUrl: code('baseUrl'), allowMove: true }] }
	],
	'src/routes/api/cards/[id]/+server.ts DELETE': [
		{ service: 'removeCard', args: [code('caller'), { cardId: code('id') }, null, { permanent: code('permanent'), source: 'ui' }] }
	],
	'src/routes/api/cards/[id]/restore/+server.ts POST': [
		{ service: 'restoreCardFor', args: [code('caller'), { cardId: code('cardId') }, null, { source: 'ui' }] }
	],
	'src/routes/api/cards/reorder/+server.ts PUT': [
		{ service: 'moveCards', args: [code('caller'), {}, code('body'), { source: 'ui', baseUrl: code('baseUrl') }] }
	],
	'src/routes/api/v1/boards/[boardId]/cards/+server.ts POST': [
		{ service: 'createCard', args: [code('caller'), { boardId: code('boardId') }, code('body'), { source: 'api', baseUrl: code('baseUrl') }] }
	],
	'src/routes/api/v1/cards/[cardId]/+server.ts PUT': [
		{
			service: 'updateCard',
			args: [
				code('caller'),
				{ cardId: code('cardId') },
				code('body'),
				{ source: 'api', allowMilestone: true, allowRestore: true, refuseEmpty: true, tellBeforeEntry: true, says: code('NO_EDIT') }
			]
		}
	],
	'src/routes/api/v1/cards/[cardId]/+server.ts DELETE': [
		{ service: 'removeCard', args: [code('caller'), { cardId: code('cardId') }, null, { permanent: code('permanent'), source: 'api', says: code('NO_EDIT') }] }
	],
	'src/routes/api/v1/cards/[cardId]/move/+server.ts PUT': [
		{ service: 'moveCard', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'api', baseUrl: code('baseUrl') }] }
	],
	// Slice A2: what is on a card. Each tree's words (`says`, a constant of
	// the route file where two handlers share them), and what each does
	// differently today: v1's comment entry words and mail-first order, v1's
	// subtask `position`, entry words and tell-first order, the page's
	// subtask tick told first, and each tree's live event type for a subtask.
	'src/routes/api/cards/[id]/assignees/+server.ts POST': [
		{ service: 'assignToCard', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'ui', baseUrl: code('baseUrl'), says: code('NO_EDIT') }] }
	],
	'src/routes/api/cards/[id]/assignees/+server.ts DELETE': [
		{ service: 'unassignFromCard', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'ui', says: code('NO_EDIT') }] }
	],
	'src/routes/api/v1/cards/[cardId]/assignees/+server.ts POST': [
		{
			service: 'assignToCard',
			args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'api', baseUrl: code('baseUrl'), says: code('NO_EDIT_TO_ASSIGN') }]
		}
	],
	'src/routes/api/v1/cards/[cardId]/assignees/+server.ts DELETE': [
		{ service: 'unassignFromCard', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'api', says: code('NO_EDIT_TO_UNASSIGN') }] }
	],
	'src/routes/api/cards/[id]/comments/+server.ts GET': [
		{ service: 'listComments', args: [code('locals.user'), { cardId: code('cardId') }, { says: 'No access' }] }
	],
	'src/routes/api/v1/cards/[cardId]/comments/+server.ts GET': [
		{ service: 'listComments', args: [code('locals.user'), { cardId: code('cardId') }, { says: 'No access to this board' }] }
	],
	'src/routes/api/cards/[id]/comments/+server.ts POST': [
		{ service: 'addComment', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'ui', baseUrl: code('baseUrl'), says: 'No edit access' }] }
	],
	'src/routes/api/v1/cards/[cardId]/comments/+server.ts POST': [
		{
			service: 'addComment',
			args: [
				code('caller'),
				{ cardId: code('cardId') },
				code('body'),
				{ source: 'api', baseUrl: code('baseUrl'), says: 'No edit access', commentedOn: true, mailBeforeEntry: true }
			]
		}
	],
	'src/routes/api/cards/[id]/comments/[commentId]/+server.ts PUT': [
		{ service: 'editComment', args: [code('caller'), { commentId: code('commentId'), cardId: code('cardId') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/v1/comments/[commentId]/+server.ts PUT': [
		{ service: 'editComment', args: [code('caller'), { commentId: code('commentId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/cards/[id]/comments/[commentId]/+server.ts DELETE': [
		{ service: 'deleteComment', args: [code('caller'), { cardId: code('cardId'), commentId: code('commentId') }, null, { source: 'ui' }] }
	],
	'src/routes/api/v1/comments/[commentId]/+server.ts DELETE': [
		{ service: 'deleteComment', args: [code('caller'), { commentId: code('commentId') }, null, { source: 'api' }] }
	],
	'src/routes/api/labels/+server.ts PUT': [{ service: 'toggleCardLabel', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/cards/[cardId]/labels/+server.ts POST': [
		{ service: 'addCardLabel', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/v1/cards/[cardId]/labels/+server.ts DELETE': [
		{ service: 'removeCardLabel', args: [code('caller'), { cardId: code('cardId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/subtasks/+server.ts GET': [{ service: 'listSubtasks', args: [code('locals.user'), { cardId: code('cardId') }, {}] }],
	'src/routes/api/v1/cards/[cardId]/subtasks/+server.ts GET': [
		{ service: 'listSubtasks', args: [code('locals.user'), { cardId: code('cardId') }, { says: "No access to this card's board" }] }
	],
	'src/routes/api/subtasks/+server.ts POST': [
		{ service: 'createSubtask', args: [code('caller'), {}, code('body'), { source: 'ui', eventType: 'subtask' }] }
	],
	'src/routes/api/v1/cards/[cardId]/subtasks/+server.ts POST': [
		{
			service: 'createSubtask',
			args: [
				code('caller'),
				{ cardId: code('cardId') },
				code('body'),
				{
					source: 'api',
					says: "No edit access to this card's board",
					allowPosition: true,
					namesCard: true,
					tellBeforeEntry: true,
					eventType: 'card'
				}
			]
		}
	],
	'src/routes/api/subtasks/[id]/+server.ts PUT': [
		{
			service: 'updateSubtask',
			args: [code('caller'), { subtaskId: code('id') }, code('body'), { source: 'ui', baseUrl: code('baseUrl'), tellBeforeEntry: true, eventType: 'subtask' }]
		}
	],
	'src/routes/api/v1/subtasks/[subtaskId]/+server.ts PUT': [
		{
			service: 'updateSubtask',
			args: [code('caller'), { subtaskId: code('subtaskId') }, code('body'), { source: 'api', baseUrl: code('baseUrl'), says: code('NO_EDIT'), eventType: 'card' }]
		}
	],
	'src/routes/api/subtasks/[id]/+server.ts DELETE': [
		{ service: 'deleteSubtask', args: [code('caller'), { subtaskId: code('id') }, null, { source: 'ui', eventType: 'subtask' }] }
	],
	'src/routes/api/v1/subtasks/[subtaskId]/+server.ts DELETE': [
		{ service: 'deleteSubtask', args: [code('caller'), { subtaskId: code('subtaskId') }, null, { source: 'api', says: code('NO_EDIT'), eventType: 'card' }] }
	],
	// Slice A3: dependencies, a card's cost and the token writes, milestones.
	// What each does differently today: the card window's words for a link
	// (`nothingToLink`), v1's card words (`says`) and each link's id, maker and
	// time in its read (`withLinkDetails`), v1's milestone read with its cards
	// (`withCards`), and the page's milestone PATCH that also puts a card in or
	// takes one out (`allowCard`).
	'src/routes/api/cards/[id]/dependencies/+server.ts GET': [
		{ service: 'readWorkDependencies', args: [code('locals.user'), { kind: 'card', id: code('cardId') }, {}] }
	],
	'src/routes/api/cards/[id]/dependencies/+server.ts POST': [
		{ service: 'addWorkDependency', args: [code('caller'), { kind: 'card', id: code('cardId') }, code('body'), { source: 'ui', nothingToLink: true }] }
	],
	'src/routes/api/cards/[id]/dependencies/+server.ts DELETE': [
		{ service: 'removeWorkDependency', args: [code('caller'), { kind: 'card', id: code('cardId') }, code('body'), { source: 'ui', nothingToLink: true }] }
	],
	'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts GET': [
		{ service: 'readWorkDependencies', args: [code('locals.user'), { kind: 'card', id: code('cardId') }, { says: code('NO_ACCESS'), withLinkDetails: true }] }
	],
	'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts POST': [
		{ service: 'addWorkDependency', args: [code('caller'), { kind: 'card', id: code('cardId') }, code('body'), { source: 'api', says: code('NO_EDIT') }] }
	],
	'src/routes/api/v1/cards/[cardId]/dependencies/+server.ts DELETE': [
		{ service: 'removeWorkDependency', args: [code('caller'), { kind: 'card', id: code('cardId') }, code('body'), { source: 'api', says: code('NO_ACCESS') }] }
	],
	'src/routes/api/subtasks/[id]/dependencies/+server.ts GET': [
		{ service: 'readWorkDependencies', args: [code('locals.user'), { kind: 'subtask', id: code('id') }, {}] }
	],
	'src/routes/api/subtasks/[id]/dependencies/+server.ts POST': [
		{ service: 'addWorkDependency', args: [code('caller'), { kind: 'subtask', id: code('id') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/subtasks/[id]/dependencies/+server.ts DELETE': [
		{ service: 'removeWorkDependency', args: [code('caller'), { kind: 'subtask', id: code('id') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts GET': [
		{ service: 'readWorkDependencies', args: [code('locals.user'), { kind: 'subtask', id: code('id') }, {}] }
	],
	'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts POST': [
		{ service: 'addWorkDependency', args: [code('caller'), { kind: 'subtask', id: code('id') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/v1/subtasks/[subtaskId]/dependencies/+server.ts DELETE': [
		{ service: 'removeWorkDependency', args: [code('caller'), { kind: 'subtask', id: code('id') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/cards/[id]/tokens/+server.ts GET': [{ service: 'readCardTokens', args: [code('locals.user'), { cardId: code('cardId') }, {}] }],
	'src/routes/api/v1/cards/[cardId]/tokens/+server.ts GET': [{ service: 'readCardTokens', args: [code('locals.user'), { cardId: code('cardId') }, {}] }],
	'src/routes/api/v1/cards/[cardId]/tokens/+server.ts POST': [
		{ service: 'recordTokens', args: [code('caller'), { kind: 'card', id: code('cardId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/v1/subtasks/[subtaskId]/tokens/+server.ts POST': [
		{ service: 'recordTokens', args: [code('caller'), { kind: 'subtask', id: code('subtaskId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/v1/tokens/[entryId]/+server.ts DELETE': [
		{ service: 'removeTokenEntry', args: [code('caller'), { entryId: code('entryId') }, null, { source: 'api' }] }
	],
	'src/routes/api/v1/tokens/bulk/+server.ts POST': [{ service: 'recordTokenBatch', args: [code('caller'), {}, code('body'), { source: 'api' }] }],
	'src/routes/api/milestones/+server.ts POST': [{ service: 'createMilestoneFor', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/milestones/+server.ts POST': [{ service: 'createMilestoneFor', args: [code('caller'), {}, code('body'), { source: 'api' }] }],
	'src/routes/api/milestones/[id]/+server.ts GET': [{ service: 'readMilestone', args: [code('locals.user'), { milestoneId: code('id') }, {}] }],
	'src/routes/api/v1/milestones/[milestoneId]/+server.ts GET': [
		{ service: 'readMilestone', args: [code('locals.user'), { milestoneId: code('id') }, { withCards: true }] }
	],
	'src/routes/api/milestones/[id]/+server.ts PATCH': [
		{ service: 'changeMilestone', args: [code('caller'), { milestoneId: code('id') }, code('body'), { source: 'ui', allowCard: true }] }
	],
	'src/routes/api/v1/milestones/[milestoneId]/+server.ts PATCH': [
		{ service: 'changeMilestone', args: [code('caller'), { milestoneId: code('id') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/milestones/[id]/+server.ts DELETE': [
		{ service: 'deleteMilestoneFor', args: [code('caller'), { milestoneId: code('id') }, null, { source: 'ui' }] }
	],
	'src/routes/api/v1/milestones/[milestoneId]/+server.ts DELETE': [
		{ service: 'deleteMilestoneFor', args: [code('caller'), { milestoneId: code('id') }, null, { source: 'api' }] }
	],
	'src/routes/api/v1/milestones/[milestoneId]/cards/+server.ts POST': [
		{ service: 'attachCardToMilestone', args: [code('caller'), { milestoneId: code('milestoneId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/v1/milestones/[milestoneId]/cards/+server.ts DELETE': [
		{ service: 'detachCardFromMilestone', args: [code('caller'), { milestoneId: code('milestoneId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/milestones/[id]/summary/+server.ts GET': [
		{ service: 'readMilestoneSummary', args: [code('locals.user'), { milestoneId: code('id') }, {}] }
	],
	'src/routes/api/v1/milestones/[milestoneId]/summary/+server.ts GET': [
		{ service: 'readMilestoneSummary', args: [code('locals.user'), { milestoneId: code('id') }, {}] }
	],
	'src/routes/api/milestones/[id]/pdf/+server.ts GET': [{ service: 'readMilestoneSummary', args: [code('locals.user'), { milestoneId: code('id') }, {}] }],
	'src/routes/api/v1/milestones/[milestoneId]/pdf/+server.ts GET': [
		{ service: 'readMilestoneSummary', args: [code('locals.user'), { milestoneId: code('id') }, {}] }
	],
	// Slice A4: boards, dashboard groupings, columns, card categories and
	// labels. What each does differently today: the page files a new board
	// under a grouping (`allowCategory`) and moves a board under a card
	// (`allowParent`); v1 refuses a board change that names no field
	// (`refuseEmpty`) and tells the board first (`tellBeforeEntry`); v1 puts a
	// new column sent with no position after the last (`placeAfterLast`) and
	// reads its colour first (`colorBeforePosition`); the page's words for a
	// label change that names nothing (`sendNameOrColor`).
	'src/routes/api/boards/+server.ts GET': [{ service: 'listBoardsFor', args: [code('locals.user'), {}, {}] }],
	'src/routes/api/v1/boards/+server.ts GET': [{ service: 'listBoardsFor', args: [code('locals.user'), {}, {}] }],
	'src/routes/api/boards/+server.ts POST': [{ service: 'createBoard', args: [code('caller'), {}, code('body'), { source: 'ui', allowCategory: true }] }],
	'src/routes/api/v1/boards/+server.ts POST': [{ service: 'createBoard', args: [code('caller'), {}, code('body'), { source: 'api' }] }],
	'src/routes/api/boards/[id]/+server.ts PUT': [
		{ service: 'updateBoard', args: [code('caller'), { boardId: code('id') }, code('body'), { source: 'ui', allowParent: true }] }
	],
	'src/routes/api/v1/boards/[boardId]/+server.ts PUT': [
		{ service: 'updateBoard', args: [code('caller'), { boardId: code('boardId') }, code('body'), { source: 'api', refuseEmpty: true, tellBeforeEntry: true }] }
	],
	'src/routes/api/boards/[id]/+server.ts DELETE': [{ service: 'deleteBoardFor', args: [code('caller'), { boardId: code('id') }, null, { source: 'ui' }] }],
	'src/routes/api/v1/boards/[boardId]/+server.ts DELETE': [
		{ service: 'deleteBoardFor', args: [code('caller'), { boardId: code('boardId') }, null, { source: 'api' }] }
	],
	'src/routes/api/board-categories/+server.ts POST': [{ service: 'createBoardGrouping', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/board-categories/+server.ts POST': [{ service: 'createBoardGrouping', args: [code('caller'), {}, code('body'), { source: 'api' }] }],
	'src/routes/api/board-categories/[id]/+server.ts PUT': [
		{ service: 'updateBoardGrouping', args: [code('caller'), { categoryId: code('id') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/v1/board-categories/[categoryId]/+server.ts PUT': [
		{ service: 'updateBoardGrouping', args: [code('caller'), { categoryId: code('categoryId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/board-categories/[id]/+server.ts DELETE': [
		{ service: 'deleteBoardGrouping', args: [code('caller'), { categoryId: code('id') }, null, { source: 'ui' }] }
	],
	'src/routes/api/v1/board-categories/[categoryId]/+server.ts DELETE': [
		{ service: 'deleteBoardGrouping', args: [code('caller'), { categoryId: code('categoryId') }, null, { source: 'api' }] }
	],
	'src/routes/api/columns/+server.ts POST': [{ service: 'createColumn', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/boards/[boardId]/columns/+server.ts POST': [
		{
			service: 'createColumn',
			args: [code('caller'), { boardId: code('boardId') }, code('body'), { source: 'api', placeAfterLast: true, colorBeforePosition: true }]
		}
	],
	'src/routes/api/columns/[id]/+server.ts PUT': [{ service: 'updateColumn', args: [code('caller'), { columnId: code('id') }, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/columns/[columnId]/+server.ts PUT': [
		{ service: 'updateColumn', args: [code('caller'), { columnId: code('columnId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/columns/[id]/+server.ts DELETE': [{ service: 'deleteColumnFor', args: [code('caller'), { columnId: code('id') }, null, { source: 'ui' }] }],
	'src/routes/api/v1/columns/[columnId]/+server.ts DELETE': [
		{ service: 'deleteColumnFor', args: [code('caller'), { columnId: code('columnId') }, null, { source: 'api' }] }
	],
	'src/routes/api/columns/reorder/+server.ts PUT': [{ service: 'reorderColumns', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/categories/+server.ts POST': [{ service: 'createCardCategory', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/boards/[boardId]/categories/+server.ts POST': [
		{ service: 'createCardCategory', args: [code('caller'), { boardId: code('boardId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/categories/[id]/+server.ts PUT': [
		{ service: 'updateCardCategory', args: [code('caller'), { categoryId: code('id') }, code('body'), { source: 'ui' }] }
	],
	'src/routes/api/v1/categories/[categoryId]/+server.ts PUT': [
		{ service: 'updateCardCategory', args: [code('caller'), { categoryId: code('categoryId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/categories/[id]/+server.ts DELETE': [
		{ service: 'deleteCardCategory', args: [code('caller'), { categoryId: code('id') }, null, { source: 'ui' }] }
	],
	'src/routes/api/v1/categories/[categoryId]/+server.ts DELETE': [
		{ service: 'deleteCardCategory', args: [code('caller'), { categoryId: code('categoryId') }, null, { source: 'api' }] }
	],
	'src/routes/api/labels/+server.ts GET': [{ service: 'labelsOfBoard', args: [code('locals.user'), { boardId: code('boardId') }, {}] }],
	'src/routes/api/v1/boards/[boardId]/labels/+server.ts GET': [{ service: 'labelsOfBoard', args: [code('locals.user'), { boardId: code('boardId') }, {}] }],
	'src/routes/api/labels/+server.ts POST': [{ service: 'createLabel', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/boards/[boardId]/labels/+server.ts POST': [
		{ service: 'createLabel', args: [code('caller'), { boardId: code('boardId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/labels/+server.ts PATCH': [{ service: 'updateLabel', args: [code('caller'), {}, code('body'), { source: 'ui', sendNameOrColor: true }] }],
	'src/routes/api/v1/labels/[labelId]/+server.ts PUT': [
		{ service: 'updateLabel', args: [code('caller'), { labelId: code('labelId') }, code('body'), { source: 'api' }] }
	],
	'src/routes/api/labels/+server.ts DELETE': [{ service: 'deleteLabel', args: [code('caller'), {}, code('body'), { source: 'ui' }] }],
	'src/routes/api/v1/labels/[labelId]/+server.ts DELETE': [
		{ service: 'deleteLabel', args: [code('caller'), { labelId: code('labelId') }, null, { source: 'api' }] }
	]
};

/** An argument as `Written` has it. */
function written(node: ts.Expression, tree: ts.SourceFile): Written {
	if (ts.isStringLiteralLike(node)) return node.text;
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (node.kind === ts.SyntaxKind.NullKeyword) return null;
	if (ts.isObjectLiteralExpression(node) && node.properties.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) {
		return Object.fromEntries(
			node.properties.map((p) => [
				p.name!.getText(tree),
				ts.isPropertyAssignment(p) ? written(p.initializer, tree) : code((p as ts.ShorthandPropertyAssignment).name.text)
			])
		);
	}
	return code(node.getText(tree).replace(/\s+/g, ' '));
}

/**
 * Every call of a service's function in a route file under src/routes (`+server.ts`,
 * `+page.server.ts`, `+layout.server.ts`), by `file METHOD`, `file load`, `file
 * actions.<name>`, or `file (in no handler)`. A service is a module of src/lib/server
 * that exports `READS`.
 */
function serviceCalls(): Record<string, { service: string; args: Written[] }[]> {
	const isService = new Map<string, boolean>();
	const serviceModule = (specifier: string) => {
		if (!specifier.startsWith('$lib/server/')) return false;
		if (!isService.has(specifier)) {
			let source = '';
			try {
				source = readFileSync(join(ROOT, `src/lib/server/${specifier.slice('$lib/server/'.length)}.ts`), 'utf8');
			} catch {
				// A folder, or no such module: no service.
			}
			isService.set(specifier, /^export const READS\b/m.test(source));
		}
		return isService.get(specifier)!;
	};
	const found: Record<string, { service: string; args: Written[] }[]> = {};
	const files = (readdirSync(join(ROOT, 'src/routes'), { recursive: true }) as string[])
		.map((file) => `src/routes/${file.split('\\').join('/')}`)
		.filter((file) => /\/\+(server|page\.server|layout\.server)\.ts$/.test(file))
		.sort();
	for (const file of files) {
		const tree = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
		const services = new Set<string>();
		for (const statement of tree.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !serviceModule(statement.moduleSpecifier.text)) continue;
			const bindings = statement.importClause?.namedBindings;
			if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) services.add(element.name.text);
		}
		if (services.size === 0) continue;
		// Each handler: a method of a `+server.ts`, a `load`, and each form action
		// (`actions.<name>`) of a `+page.server.ts`.
		const handlers: [string, ts.Node][] = [];
		for (const statement of tree.statements) {
			const named: [string, ts.Node][] = [];
			if (ts.isVariableStatement(statement)) {
				for (const declared of statement.declarationList.declarations) {
					if (ts.isIdentifier(declared.name) && declared.initializer) named.push([declared.name.text, declared.initializer]);
				}
			}
			if (ts.isFunctionDeclaration(statement) && statement.name) named.push([statement.name.text, statement]);
			for (const [name, node] of named) {
				if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'load'].includes(name)) handlers.push([name, node]);
				let value: ts.Node = node;
				while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
				if (name === 'actions' && ts.isObjectLiteralExpression(value)) {
					for (const property of value.properties) handlers.push([`actions.${property.name?.getText(tree) ?? '?'}`, property]);
				}
			}
		}
		const callsIn = (node: ts.Node) => {
			const calls: { service: string; args: Written[]; at: ts.CallExpression }[] = [];
			const visit = (inner: ts.Node): void => {
				if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && services.has(inner.expression.text)) {
					calls.push({ service: inner.expression.text, args: inner.arguments.map((argument) => written(argument, tree)), at: inner });
				}
				ts.forEachChild(inner, visit);
			};
			visit(node);
			return calls;
		};
		const placed = new Set<ts.CallExpression>();
		for (const [method, node] of handlers) {
			const calls = callsIn(node);
			for (const { at } of calls) placed.add(at);
			if (calls.length > 0) found[`${file} ${method}`] = calls.map(({ service, args }) => ({ service, args }));
		}
		// A call in no handler (a helper of the file) is pinned too, so none goes unread.
		const elsewhere = callsIn(tree).filter(({ at }) => !placed.has(at));
		if (elsewhere.length > 0) found[`${file} (in no handler)`] = elsewhere.map(({ service, args }) => ({ service, args }));
	}
	return found;
}

describe('each internal route writes and tells all or nothing', () => {
	it('assigning: the assignee and the entry, then the mail and the update once committed', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => api('POST', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(entries()).toEqual([
					{
						boardId: s.A.board.id,
						cardId: s.first.id,
						userId: s.owner.id,
						action: 'assignee_added',
						detail: 'Assigned helper to "First"',
						userName: 'owner',
						userEmoji: '👤',
						source: 'ui'
					}
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into card_assignees', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual([
			'email to helper@example.test: Assigned: First',
			'event update {"type":"card"} on board 1'
		]);
	});

	it('unassigning: the removal and the entry, then the update once committed', async () => {
		const run = await eachWriteInTurn({
			build: assigned,
			request: (s) => api('DELETE', `/api/cards/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(entries()).toMatchObject([
					{ action: 'assignee_removed', cardId: s.first.id, detail: 'Removed helper from "First"', source: 'ui' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['delete from card_assignees', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update {"type":"card"} on board 1']);
	});

	it('editing a comment: the comment and the entry, then the update once committed', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) =>
				api('PUT', `/api/cards/${s.first.id}/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it is now' } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toMatchObject({ id: s.comment.id, content: 'As it is now' });
				expect(entries()).toMatchObject([
					{ action: 'comment_edited', cardId: s.first.id, detail: 'Edited a comment on "First"', source: 'ui' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['update card_comments set', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update {"type":"comment","cardId":1} on board 1']);
	});

	it('making a board under a card: the board, its columns, its owner and the entry, then the parent board is told', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => api('POST', '/api/boards', { user: s.owner, body: { name: 'Roadmap', parentCardId: s.first.id } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(entries()).toMatchObject([
					{ boardId: res.body.id, cardId: null, action: 'board_created', detail: 'Created board "Roadmap"', source: 'ui' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual([
			'insert into boards',
			'insert into columns',
			'insert into board_members',
			'insert into activity_log'
		]);
		// To the board the parent card is on, and to no other: no name in it.
		expect(run.effects.map(name)).toEqual(['event update {"type":"board","action":"created"} on board 1']);
	});

	it('changing a board: the board and the entry, then the board is told', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => api('PUT', `/api/boards/${s.A.board.id}`, { user: s.owner, body: { name: 'Renamed' } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(entries()).toMatchObject([
					{ boardId: s.A.board.id, action: 'board_updated', detail: 'Updated board "Renamed" (fields: name)', source: 'ui' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['update boards set', 'insert into activity_log']);
		expect(run.effects.map(name)).toEqual(['event update {"type":"board"} on board 1']);
	});

	it('making a milestone on a board: the milestone and the entry', async () => {
		const run = await eachWriteInTurn({
			build: scene,
			request: (s) => api('POST', '/api/milestones', { user: s.owner, body: { name: 'Launch', boardId: s.A.board.id } }),
			afterSuccess: (s, res: ApiResult) => {
				expect(res.status).toBe(201);
				expect(entries()).toMatchObject([
					{ boardId: s.A.board.id, cardId: null, action: 'milestone_created', detail: 'Created milestone "Launch"', source: 'ui' }
				]);
			}
		});

		expect(shape(run.writes)).toEqual(['insert into milestones', 'insert into activity_log']);
		// No event, in either tree: a goal with no cards is drawn on no card.
		expect(run.effects).toEqual([]);
	});
});

describe('nothing changed, nothing recorded', () => {
	it.each([
		['the internal route', '/api/cards'],
		['the v1 route', '/api/v1/cards']
	])('assigning someone already assigned, through %s, writes no entry and sends no mail, and one update', async (_tree, base) => {
		const s = assigned();
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('POST', `${base}/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } });
			await sent.settle();

			expect(res.status).toBe(200);
			expectUnchanged(before);
			// v1 has always told the board, and the internal route now does as v1.
			expect(sent.all.map(name)).toEqual(['event update {"type":"card"} on board 1']);
		} finally {
			sent.restore();
		}
	});

	it.each([
		['the internal route', '/api/cards'],
		['the v1 route', '/api/v1/cards']
	])('removing someone not assigned, through %s, is 404 and writes and tells nothing', async (_tree, base) => {
		const s = scene();
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('DELETE', `${base}/${s.first.id}/assignees`, { user: s.owner, body: { userId: s.helper.id } });
			await sent.settle();

			expect(res.status).toBe(404);
			expect(res.body).toEqual({ message: 'User is not assigned to this card' });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	/** As `scene`, with the comment written, and last changed, on 1 October. */
	function oldComment(content?: string): Scene {
		const s = scene();
		db.update(cardComments)
			.set({ createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00', ...(content === undefined ? {} : { content }) })
			.where(eq(cardComments.id, s.comment.id))
			.run();
		return s;
	}

	// Card 2183's rule for cards, applied to a comment (card 2284): Save
	// pressed on a comment nobody changed wrote it again with a new
	// `updatedAt`, which the window shows as "(edited)", recorded "Edited a
	// comment" and told the board.
	it.each([
		['the internal route', (s: Scene) => `/api/cards/${s.first.id}/comments/${s.comment.id}`],
		['the v1 route', (s: Scene) => `/api/v1/comments/${s.comment.id}`]
	])('saving a comment unchanged, through %s, writes and tells nothing, and answers the comment as it is', async (tree, path) => {
		const s = oldComment();
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('PUT', path(s), { user: s.owner, body: { content: 'As it was' } });
			await sent.settle();

			expect(res.status).toBe(200);
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
			// The page's route answers the row as stored; v1 adds the author, and
			// writes its times in ISO.
			expect(res.body).toEqual(
				tree === 'the v1 route'
					? {
							id: s.comment.id,
							cardId: s.first.id,
							userId: s.owner.id,
							content: 'As it was',
							createdAt: '2026-10-01T09:00:00.000Z',
							updatedAt: '2026-10-01T09:00:00.000Z',
							username: 'owner',
							userEmoji: '👤'
						}
					: {
							id: s.comment.id,
							cardId: s.first.id,
							userId: s.owner.id,
							content: 'As it was',
							createdAt: '2026-10-01 09:00:00',
							updatedAt: '2026-10-01 09:00:00'
						}
			);
		} finally {
			sent.restore();
		}
	});

	// The rule is the shared service's, so the page's route alone. A comment
	// stored with outer spaces (from before edits were trimmed, or copied from
	// a request's discussion) is unchanged by its text sent trimmed: the
	// window cannot show the spaces, and the stored text keeps them.
	it('saving a comment whose stored text has outer spaces, sent trimmed, is unchanged too', async () => {
		const s = oldComment('  As it was\n');
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('PUT', `/api/cards/${s.first.id}/comments/${s.comment.id}`, { user: s.owner, body: { content: 'As it was' } });
			await sent.settle();

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({ id: s.comment.id, content: '  As it was\n', updatedAt: '2026-10-01 09:00:00' });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});

	// Card 2285: archiving a card already archived stamped it again with now,
	// so the first archive time was lost, moved its `updatedAt`, recorded a
	// second "Archived card" and told the board. The restore already answers a
	// card that is not archived as it is, with nothing written; this is its
	// other half. Still 200, so a retried `DELETE` does not fail. The board has
	// a webhook that takes every event, so none is sent either.
	it.each([
		['the internal route', '/api/cards'],
		['the v1 route', '/api/v1/cards']
	])('archiving a card already archived, through %s, answers 200 and writes and tells nothing', async (_tree, base) => {
		const s = archivedScene();
		const before = snapshotDb();
		const sent = effects();
		try {
			const res = await api('DELETE', `${base}/${s.first.id}`, { user: s.owner });
			await sent.settle();

			expect(res.status).toBe(200);
			expect(res.body).toEqual({ success: true });
			// `archivedAt` and `updatedAt` as they were, and no entry.
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		} finally {
			sent.restore();
		}
	});
});

describe('the details', () => {
	/** Make one request with its effects recorded, and answer what it wrote and sent. */
	async function recorded(request: () => Promise<ApiResult>) {
		const sent = effects();
		try {
			const res = await request();
			await sent.settle();
			expect(sent.duringTransaction).toEqual([]);
			return { res, told: sent.all.map(name) };
		} finally {
			sent.restore();
		}
	}

	it.each([
		['the internal route', '/api/boards'],
		['the v1 route', '/api/v1/boards']
	])('a change to three fields, through %s, names them in the order v1 reads them', async (_tree, base) => {
		const s = scene();

		// Sent in another order. The internal route read isPublic before
		// categoryId, and would have named them so.
		const { res } = await recorded(() =>
			api('PUT', `${base}/${s.A.board.id}`, {
				user: s.owner,
				body: { isPublic: false, categoryId: null, name: 'Renamed' }
			})
		);

		expect(res.status).toBe(200);
		expect(entries().map((e) => e.detail)).toEqual(['Updated board "Renamed" (fields: name, categoryId, isPublic)']);
	});

	it.each([
		['the internal route', '/api/boards'],
		['the v1 route', '/api/v1/boards']
	])('an editor who sends isPublic, through %s, is refused and nothing is recorded', async (_tree, base) => {
		const s = scene();
		const before = snapshotDb();

		const { res, told } = await recorded(() =>
			api('PUT', `${base}/${s.A.board.id}`, { user: s.helper, body: { name: 'Renamed', isPublic: true } })
		);

		expect(res.status).toBe(403);
		expectUnchanged(before);
		expect(told).toEqual([]);
	});

	it('a board put under a card names the field, and tells the board and the card\'s board once each', async () => {
		const s = scene();

		const { res, told } = await recorded(() =>
			api('PUT', `/api/boards/${s.S.board.id}`, { user: s.owner, body: { parentCardId: s.first.id } })
		);

		expect(res.status).toBe(200);
		expect(entries()).toMatchObject([
			{ boardId: s.S.board.id, action: 'board_updated', detail: 'Updated board "S" (fields: parentCardId)', source: 'ui' }
		]);
		expect(told).toEqual([
			`event update {"type":"board"} on board ${s.S.board.id}`,
			`event update {"type":"board"} on board ${s.A.board.id}`
		]);
	});

	it('a change that sends no field records nothing and tells nobody', async () => {
		const s = scene();

		const { res, told } = await recorded(() => api('PUT', `/api/boards/${s.A.board.id}`, { user: s.owner, body: {} }));

		// The internal route answers it as it did; v1 refuses it (400).
		expect(res.status).toBe(200);
		expect(entries()).toEqual([]);
		expect(told).toEqual([]);
	});

	it.each([
		['the internal route', '/api/milestones'],
		['the v1 route', '/api/v1/milestones']
	])('a milestone of no board, through %s, writes no entry', async (_tree, path) => {
		const s = scene();

		const { res, told } = await recorded(() => api('POST', path, { user: s.owner, body: { name: 'Across boards' } }));

		expect(res.status).toBe(201);
		expect(res.body).toMatchObject({ name: 'Across boards', boardId: null });
		expect(entries()).toEqual([]);
		expect(told).toEqual([]);
	});

	it.each([
		['the internal route', '/api/boards'],
		['the v1 route', '/api/v1/boards']
	])('a top-level board, through %s, writes its entry and tells nobody', async (_tree, path) => {
		const s = scene();

		const { res, told } = await recorded(() => api('POST', path, { user: s.owner, body: { name: 'Roadmap' } }));

		expect(res.status).toBe(201);
		expect(entries()).toMatchObject([{ boardId: res.body.id, action: expect.stringMatching(/board_created$/) }]);
		expect(told).toEqual([]);
	});

	// An administrator removing someone's words is named with whose they were,
	// and the text is never recorded (card 2283, decision 6).
	it.each([
		['the internal route', (s: Scene) => `/api/cards/${s.first.id}/comments/${s.comment.id}`],
		['the v1 route', (s: Scene) => `/api/v1/comments/${s.comment.id}`]
	])("an administrator deleting the owner's comment, through %s, names its author and not its text", async (_tree, path) => {
		const s = scene();
		const admin = makeUser({ username: 'admin', role: 'admin' });

		const { res, told } = await recorded(() => api('DELETE', path(s), { user: admin }));

		expect(res.status).toBe(200);
		expect(db.select().from(cardComments).all()).toEqual([]);
		expect(entries()).toMatchObject([
			{ cardId: s.first.id, userName: 'admin', action: expect.stringMatching(/comment_deleted$/), detail: 'Deleted a comment by owner on "First"' }
		]);
		expect(told).toEqual([`event update {"type":"comment","cardId":${s.first.id}} on board ${s.A.board.id}`]);
	});

	// What the open card window does with it is held in
	// tests/card-window-comments.svelte.test.ts; here, that the delete's event
	// is one the window open on that card is told of, and no other card's.
	it.each([
		['the internal route', (s: Scene) => `/api/cards/${s.first.id}/comments/${s.comment.id}`],
		['the v1 route', (s: Scene) => `/api/v1/comments/${s.comment.id}`]
	])("a comment deleted, through %s, tells the window open on its card, and no other card's", async (_tree, path) => {
		const s = scene();
		const other = makeCard(s.A.cols['To Do'], { title: 'Other' });
		const sent = effects();
		try {
			const res = await api('DELETE', path(s), { user: s.owner });
			await sent.settle();
			expect(res.status).toBe(200);
			// Read as a page reads it off the stream: the data sent as JSON.
			const updates = sent.events.filter((e) => e.event === 'update').map((e) => boardEvent(JSON.stringify(e.data)));
			expect(updates).not.toEqual([]);
			expect(updates.some((event) => commentsChanged(event, s.first.id))).toBe(true);
			expect(updates.some((event) => commentsChanged(event, other.id))).toBe(false);
		} finally {
			sent.restore();
		}
	});
});

describe('accepting a request with an assignee', () => {
	it('records the card, then its assignee, by whoever accepted it, in the words the card window uses', async () => {
		const s = scene();
		const request = db
			.insert(taskRequests)
			.values({
				targetType: 'user',
				targetId: s.owner.id,
				requesterName: 'Rita',
				requesterEmail: 'rita@example.test',
				title: 'Please add an export',
				accessToken: 'a'.repeat(64)
			})
			.returning()
			.get();

		// All or nothing, and the mail it sends, are held by tests/atomic-requests.test.ts.
		const sent = effects();
		let res: ApiResult;
		try {
			res = await api('PATCH', `/api/requests/${request.id}`, {
				user: s.owner,
				body: { action: 'accept', boardId: s.A.board.id, columnId: s.A.cols['To Do'].id, assigneeId: s.helper.id }
			});
			await sent.settle();
			expect(sent.duringTransaction).toEqual([]);
		} finally {
			sent.restore();
		}

		expect(res.status).toBe(200);
		const card = res.body.resolvedCardId;
		expect(entries()).toEqual([
			{
				boardId: s.A.board.id,
				cardId: card,
				userId: s.owner.id,
				action: 'card_created',
				detail: 'Please add an export',
				userName: 'owner',
				userEmoji: '👤',
				source: 'ui'
			},
			{
				boardId: s.A.board.id,
				cardId: card,
				userId: s.owner.id,
				action: 'assignee_added',
				detail: 'Assigned helper to "Please add an export"',
				userName: 'owner',
				userEmoji: '👤',
				source: 'ui'
			}
		]);
	});
});

// ─── One set of activity labels (card 2212) ─────────────────────────────────
//
// The board page's Activity Log and All Tasks' activity panel each made their
// own words from the stored name, and came apart: "Card Moved In" on one, and
// "api:card completed" on the other for a card completed through the API.
// Both call `activityLabel` now, and every name the log is written with has a
// label in its one table.

const ROOT = process.cwd();

/**
 * The names an `action:` can give, as written: a string, a member of
 * `ACTIONS`, or a ternary of them (`card-moves.ts` chooses between three).
 * Null for anything else, whose name could not be known without running it.
 */
function namesOf(expression: ts.Expression): string[] | null {
	if (ts.isStringLiteralLike(expression)) return [expression.text];
	if (ts.isParenthesizedExpression(expression)) return namesOf(expression.expression);
	if (ts.isPropertyAccessExpression(expression) && expression.expression.getText() === 'ACTIONS') {
		const name = (ACTIONS as Record<string, string>)[expression.name.text];
		return name === undefined ? null : [name];
	}
	if (ts.isConditionalExpression(expression)) {
		const either = [namesOf(expression.whenTrue), namesOf(expression.whenFalse)];
		return either[0] && either[1] ? [...either[0], ...either[1]] : null;
	}
	return null;
}

/**
 * Every call of `logActivity` or `logUiActivity` in `src`, where it is and
 * the names its `action` can give: null when it has no `action` written out
 * or one `namesOf` cannot read. `logActivity.ts` itself is left out: its
 * `logUiActivity` hands its caller's entry on.
 */
function actionsWritten(): { where: string; names: string[] | null }[] {
	const found: { where: string; names: string[] | null }[] = [];
	const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
		.map((file) => `src/${file.split('\\').join('/')}`)
		.filter((file) => file.endsWith('.ts') && file !== 'src/lib/server/logActivity.ts');
	for (const file of files) {
		const source = readFileSync(join(ROOT, file), 'utf8');
		if (!/\blog(Ui)?Activity\(/.test(source)) continue;
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && ['logActivity', 'logUiActivity'].includes(node.expression.getText())) {
				const [entry] = node.arguments;
				const action =
					entry && ts.isObjectLiteralExpression(entry)
						? entry.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'action')
						: undefined;
				found.push({
					where: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
					names: action && ts.isPropertyAssignment(action) ? namesOf(action.initializer) : null
				});
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	return found;
}

describe('one set of activity labels, for the board page and All Tasks (card 2212)', () => {
	it('has a label for every action written to the log, and every action is written so that it can be read', () => {
		const written = actionsWritten();

		// A string, `ACTIONS.x`, or a ternary of them, so that no name reaches the log unread.
		expect(written.filter((call) => call.names === null)).toEqual([]);
		// Card 2012 merges the two trees' call sites into one service each, so the count of sites falls while every action keeps its label.
		expect(written.length).toBeGreaterThan(20);
		const names = new Set([...Object.values(ACTIONS), ...written.flatMap((call) => call.names ?? [])].map(canonicalAction));
		expect([...names].filter((name) => !Object.hasOwn(ACTIVITY_LABELS, name))).toEqual([]);
		// Among them the one written through the API alone, which `ACTIONS` does not hold.
		expect(names).toContain('dependencies_bulk_added');
	});

	it('reads both spellings of an action alike, in words', () => {
		for (const name of Object.keys(ACTIVITY_LABELS)) {
			const label = activityLabel(name);
			expect({ name, api: activityLabel(`api:${name}`) }).toEqual({ name, api: label });
			expect(label, name).not.toMatch(/api:|_/);
			expect(label, name).toMatch(/^[A-Z]/);
		}
		expect(activityLabel('card_moved_in')).toBe('Moved card from another board');
		expect(activityLabel('api:card_completed')).toBe('Completed card');
		expect(activityLabel('subtask_toggled')).toBe('Updated subtask');
	});

	it('reads a name it has no label for as that name in words, never with api:', () => {
		expect(activityLabel('api:time_logged')).toBe('Time logged');
		expect(activityLabel('time_logged')).toBe('Time logged');
		// A name every object has is not taken for a label of the table.
		expect(activityLabel('constructor')).toBe('Constructor');
		expect(activityLabel('api:toString')).toBe('ToString');
	});

	it('is what both pages call, and neither has words of its own', () => {
		// The board page's Activity Log is its panel's (card 2280, slice B3: moved from the page).
		const board = readFileSync(join(ROOT, 'src/lib/components/board/ActivityPanel.svelte'), 'utf8');
		const boardPage = readFileSync(join(ROOT, 'src/routes/board/[id]/+page.svelte'), 'utf8');
		// All Tasks' is its activity panel's (card 2281, slice C3a-2: moved from the page); no label is written out on the page or any of its parts either.
		const all = readFileSync(join(ROOT, 'src/lib/components/tasks/TasksActivityPanel.svelte'), 'utf8');
		const allParts = [
			'src/routes/all/+page.svelte',
			...(readdirSync(join(ROOT, 'src/lib/components/tasks')) as string[]).filter((name) => name.endsWith('.svelte')).map((name) => `src/lib/components/tasks/${name}`)
		];
		for (const file of allParts) {
			const source = readFileSync(join(ROOT, file), 'utf8');
			for (const label of new Set(Object.values(ACTIVITY_LABELS))) expect(source, `${file}: ${label}`).not.toContain(`'${label}'`);
			expect(source, file).not.toContain('getActionLabel');
		}

		for (const label of new Set(Object.values(ACTIVITY_LABELS))) expect(boardPage, `board page: ${label}`).not.toContain(`'${label}'`);
		expect(boardPage).toContain('<ActivityPanel {activities} loading={loadingActivities} onClose={() => (showActivityPanel = false)} />');
		for (const [page, source] of [['board', board], ['all', all]]) {
			expect(source, page).toContain("import { activityLabel } from '$lib/utils/activity-labels';");
			// No label of the table written out on the page.
			for (const label of new Set(Object.values(ACTIVITY_LABELS))) expect(source, `${page}: ${label}`).not.toContain(`'${label}'`);
		}
		expect(board).toContain('<span class="activity-action">{activityLabel(activity.action)}</span>');
		expect(board).not.toContain(".replace('api:'");
		expect(boardPage).not.toContain(".replace('api:'");
		// The labels are written as they are read: no capital laid on each word.
		expect(/\.activity-action \{([^}]*)\}/.exec(board)?.[1]).not.toContain('text-transform');
		expect(all).toContain('{activityLabel(item.action)}');
		expect(all).not.toContain('getActionLabel');
		// The API badge stays All Tasks' own.
		expect(all).toContain('{#if isApiAction(item.action)}');
	});
});
