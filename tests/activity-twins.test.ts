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
import { activityLog, cardLabels, cards, milestones, taskRequests, type Card, type CardComment } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { ACTIONS, canonicalAction } from '$lib/server/logActivity';
import { ACTIVITY_LABELS, activityLabel } from '$lib/utils/activity-labels';
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
			return { internal: [webhook('on "First"'), ...mail], v1: [...mail, webhook('Commented on "First"')] };
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
		sources: { internal: ['comment_edited ui'], v1: ['api:comment_edited api'] }
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
			// entries too, unless the pair records none and says so (a label on a card).
			expect(internal.rows.length).toBeGreaterThan(0);
			if (!twin.entries) expect(internal.entries.length + v1.entries.length).toBeGreaterThan(0);
			expect(internal.told.length).toBeGreaterThan(0);
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
			await ask('internal comment delete', api('DELETE', `${card}/comments/${helpers.id}`, viewer));
			await ask('internal comment delete, not the author', api('DELETE', `${card}/comments/${s.comment.id}`, helper));
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
			'internal comment delete': '403 No edit access to this board',
			'internal comment delete, not the author': '403 You can only delete your own comments',
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

	it('has a case for each pair moved so far that writes in both trees, rows 1 to 7, 9, 10, 12 and 14 to 16', () => {
		// Rows 8 and 13 are reads and row 11 (a comment deleted) the page's alone:
		// the cases below hold their words.
		expect([...new Set(SERVICE_TWINS.map((twin) => twin.row))]).toEqual([1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 14, 15, 16]);
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
		expect(run.effects.map(name)).toEqual(['event update {"type":"card"} on board 1']);
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
		const board = readFileSync(join(ROOT, 'src/routes/board/[id]/+page.svelte'), 'utf8');
		const all = readFileSync(join(ROOT, 'src/routes/all/+page.svelte'), 'utf8');

		for (const [page, source] of [['board', board], ['all', all]]) {
			expect(source, page).toContain("import { activityLabel } from '$lib/utils/activity-labels';");
			// No label of the table written out on the page.
			for (const label of new Set(Object.values(ACTIVITY_LABELS))) expect(source, `${page}: ${label}`).not.toContain(`'${label}'`);
		}
		expect(board).toContain('<span class="activity-action">{activityLabel(activity.action)}</span>');
		expect(board).not.toContain(".replace('api:'");
		// The labels are written as they are read: no capital laid on each word.
		expect(/\.activity-action \{([^}]*)\}/.exec(board)?.[1]).not.toContain('text-transform');
		expect(all).toContain('{activityLabel(item.action)}');
		expect(all).not.toContain('getActionLabel');
		// The API badge stays All Tasks' own.
		expect(all).toContain('{#if isApiAction(item.action)}');
	});
});
