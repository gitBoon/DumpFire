/**
 * The four routes that add and remove one dependency link write it with the
 * activity entry that says so, in one transaction with the check (card 2114).
 *
 * There are four: a link is edited from a card or from a subtask, through
 * `/api/` with the session the card window uses or through `/api/v1/` with a
 * key. Only the v1 card route wrote an entry, and it alone checked and wrote
 * in one transaction. The session card route read the card and checked the
 * caller before it awaited the body, and checked the graph outside any
 * transaction; both subtask routes did the same. A dependency added or removed
 * in the card window left no record, nor did one made through the v1 subtask
 * routes.
 *
 * `src/lib/server/dependency-refusals.ts` now writes the link, or takes it
 * away, for all four, with one entry (decision 6 of the plan
 * `docs/planning/cards-2114-2115-2138-2139-writes.md`):
 *
 *               addition                       removal
 *     action    dependency_added               dependency_removed
 *     source    ui from /api/, api from /api/v1/ (stored `api:` as before)
 *     board     the address's card's board     the board of the end that waits
 *     card      the address's card             the address's card where it is on
 *                                              that board, else the card that waits
 *     detail    "#12 now waits on subtask #45" "#12 no longer waits on subtask #45"
 *
 * "The address's card" is the card in the path, or the card of the subtask in
 * the path. The answers are as they were. The v1 card route's own entries are
 * held by `tests/atomic-v1.test.ts`, and the refusals of all four by
 * `tests/dependency-refusals.test.ts`.
 *
 * Three kinds of test, in the forms `docs/testing.md` describes:
 *
 *   - each of the six handlers that wrote no entry, with `eachWriteInTurn`: the
 *     link and the entry, or neither, and nothing sent for a write that failed;
 *   - every handler of the four routes reads the row its address check reads,
 *     and the links, only inside a transaction;
 *   - a link the other way round, written by another writer just as an adding
 *     handler reads the graph, cannot close a loop.
 *
 * And what the entries are not: work on the card they name, in the activity
 * report (card 2115's review).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { activityLog, cards, workDependencies, type Card, type Subtask } from '$lib/server/db/schema';
import { buildActivityReport } from '$lib/server/activity-report';
import { logActivity } from '$lib/server/logActivity';
import type { SessionUser } from '$lib/server/auth';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import type { RecordedEffect } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeDependency,
	makeSubtask,
	makeUser,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { watchReads } from './helpers/reads';

beforeEach(resetDb);

type Scene = {
	/** Owns board A, and may look at board B and change nothing on it. */
	owner: SessionUser;
	admin: SessionUser;
	A: BoardFixture;
	/** Somebody else's board. */
	B: BoardFixture;
	/** Two cards on A. */
	first: Card;
	second: Card;
	/** A card on B. */
	far: Card;
	/** A subtask of `first`, on A. */
	step: Subtask;
	/** A subtask of `far`, on B. */
	farStep: Subtask;
};

/**
 * Board A with two cards, board B with one, and a subtask of a card on each.
 * Cards 1 and 2 are on A and card 3 on B; subtask 1 is on A and subtask 2 on
 * B, so "#1" and "subtask #1" are two things and an entry must say which.
 */
function scene(): Scene {
	const owner = makeUser({ username: 'owner' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	const other = makeUser({ username: 'other' });
	const A = makeBoard({ owner, name: 'A' });
	const B = makeBoard({ owner: other, name: 'B' });
	addBoardMember(B.board, owner, 'viewer');
	const first = makeCard(A.cols['To Do'], { title: 'First' });
	const second = makeCard(A.cols['To Do'], { title: 'Second', position: 1 });
	const far = makeCard(B.cols['To Do'], { title: 'Far' });
	const step = makeSubtask(first, { title: 'Step' });
	const farStep = makeSubtask(far, { title: 'Far step' });
	return { owner, admin, A, B, first, second, far, step, farStep };
}

/** A recorded effect in a few words. Only live events are expected: neither entry sends a webhook. */
function name(effect: RecordedEffect): string {
	if (effect.kind === 'event') return `event ${effect.event} (${effect.data?.type}) on board ${effect.boardId}`;
	return effect.kind;
}

/** The first words of each write, to read a request's writes as a list. */
const shape = (writes: string[]) =>
	writes.map((sql) => sql.split(/[ (]/).slice(0, 3).join(' ').replace(/"/g, '').toLowerCase());

type Entry = {
	boardId: number;
	cardId: number | null;
	userId: number | null;
	action: string;
	detail: string | null;
	source: string | null;
};

const entries = (): Entry[] =>
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

type End = Card | Subtask;
const kindOf = (end: End) => ('columnId' in end ? 'card' : 'subtask');

/** A link as the table holds it, `blocked` waiting on `blocker`. */
const link = (blocked: End, blocker: End) => ({
	blockedType: kindOf(blocked),
	blockedId: blocked.id,
	blockerType: kindOf(blocker),
	blockerId: blocker.id
});

const links = () =>
	db
		.select({
			blockedType: workDependencies.blockedType,
			blockedId: workDependencies.blockedId,
			blockerType: workDependencies.blockerType,
			blockerId: workDependencies.blockerId
		})
		.from(workDependencies)
		.all();

// ─── The link and its entry, or neither ─────────────────────────────────────

describe('each writes the link, or takes it away, with its activity entry, or does neither', () => {
	type Case = {
		name: string;
		/** The link there before the request, `[blocked, blocker]`. */
		before?: (s: Scene) => [End, End];
		request: (s: Scene) => Promise<ApiResult>;
		status: number;
		/** The links after it. */
		after: (s: Scene) => ReturnType<typeof link>[];
		/** The one entry it writes. */
		entry: (s: Scene) => Entry;
		/** The boards told, in order. */
		told: (s: Scene) => number[];
	};

	const at = (s: Scene, path: string, method: 'POST' | 'DELETE', body: unknown, user = s.owner) =>
		api(method, path, { user, body });

	const CASES: Case[] = [
		// ── Additions: the entry is on the board of the work in the address.
		{
			name: 'POST /api/cards/:id/dependencies, at the card that waits',
			request: (s) => at(s, `/api/cards/${s.first.id}/dependencies`, 'POST', { dependsOnCardId: s.second.id }),
			status: 201,
			after: (s) => [link(s.first, s.second)],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_added',
				detail: `#${s.first.id} now waits on #${s.second.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id]
		},
		{
			name: 'POST /api/cards/:id/dependencies, at the card waited on, on another board than the card that waits',
			request: (s) =>
				at(s, `/api/cards/${s.far.id}/dependencies`, 'POST', { blocksCardId: s.first.id }, s.admin),
			status: 201,
			after: (s) => [link(s.first, s.far)],
			// On board B, where the card in the address is, as the v1 card route
			// has always written it.
			entry: (s) => ({
				boardId: s.B.board.id,
				cardId: s.far.id,
				userId: s.admin.id,
				action: 'dependency_added',
				detail: `#${s.first.id} now waits on #${s.far.id}`,
				source: 'ui'
			}),
			told: (s) => [s.B.board.id, s.A.board.id]
		},
		{
			name: 'POST /api/subtasks/:id/dependencies, at the subtask that waits',
			request: (s) => at(s, `/api/subtasks/${s.step.id}/dependencies`, 'POST', { dependsOnCardId: s.second.id }),
			status: 201,
			after: (s) => [link(s.step, s.second)],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_added',
				detail: `subtask #${s.step.id} now waits on #${s.second.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id]
		},
		{
			name: 'POST /api/v1/subtasks/:subtaskId/dependencies, at the subtask waited on',
			request: (s) => at(s, `/api/v1/subtasks/${s.step.id}/dependencies`, 'POST', { blocksCardId: s.second.id }),
			status: 201,
			after: (s) => [link(s.second, s.step)],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'api:dependency_added',
				detail: `#${s.second.id} now waits on subtask #${s.step.id}`,
				source: 'api'
			}),
			told: (s) => [s.A.board.id]
		},

		// ── Removals: the entry is on the board of the end that waits.
		{
			name: 'DELETE /api/cards/:id/dependencies, at the card that waits',
			before: (s) => [s.first, s.second],
			request: (s) => at(s, `/api/cards/${s.first.id}/dependencies`, 'DELETE', { dependsOnCardId: s.second.id }),
			status: 200,
			after: () => [],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_removed',
				detail: `#${s.first.id} no longer waits on #${s.second.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id]
		},
		{
			name: 'DELETE /api/cards/:id/dependencies, at the card waited on, on another board',
			before: (s) => [s.first, s.far],
			request: (s) => at(s, `/api/cards/${s.far.id}/dependencies`, 'DELETE', { blocksCardId: s.first.id }),
			status: 200,
			after: () => [],
			// Board A's history names its own card, not board B's.
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_removed',
				detail: `#${s.first.id} no longer waits on #${s.far.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			name: 'DELETE /api/subtasks/:id/dependencies, at the subtask that waits',
			before: (s) => [s.step, s.second],
			request: (s) => at(s, `/api/subtasks/${s.step.id}/dependencies`, 'DELETE', { dependsOnCardId: s.second.id }),
			status: 200,
			after: () => [],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_removed',
				detail: `subtask #${s.step.id} no longer waits on #${s.second.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id]
		},
		{
			name: 'DELETE /api/subtasks/:id/dependencies, at the subtask waited on, on another board',
			before: (s) => [s.first, s.farStep],
			request: (s) => at(s, `/api/subtasks/${s.farStep.id}/dependencies`, 'DELETE', { blocksCardId: s.first.id }),
			status: 200,
			after: () => [],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'dependency_removed',
				detail: `#${s.first.id} no longer waits on subtask #${s.farStep.id}`,
				source: 'ui'
			}),
			told: (s) => [s.A.board.id, s.B.board.id]
		},
		{
			name: 'DELETE /api/v1/subtasks/:subtaskId/dependencies, at the subtask waited on, on the same board',
			before: (s) => [s.second, s.step],
			request: (s) => at(s, `/api/v1/subtasks/${s.step.id}/dependencies`, 'DELETE', { blocksCardId: s.second.id }),
			status: 200,
			after: () => [],
			// The subtask's card is on the board of the end that waits, so it is
			// the card named.
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'api:dependency_removed',
				detail: `#${s.second.id} no longer waits on subtask #${s.step.id}`,
				source: 'api'
			}),
			told: (s) => [s.A.board.id]
		},
		{
			name: 'DELETE /api/v1/subtasks/:subtaskId/dependencies, at the subtask waited on, on another board',
			before: (s) => [s.first, s.farStep],
			request: (s) => at(s, `/api/v1/subtasks/${s.farStep.id}/dependencies`, 'DELETE', { blocksCardId: s.first.id }),
			status: 200,
			after: () => [],
			entry: (s) => ({
				boardId: s.A.board.id,
				cardId: s.first.id,
				userId: s.owner.id,
				action: 'api:dependency_removed',
				detail: `#${s.first.id} no longer waits on subtask #${s.farStep.id}`,
				source: 'api'
			}),
			told: (s) => [s.A.board.id, s.B.board.id]
		}
	];

	for (const c of CASES) {
		it(c.name, async () => {
			// The same rows, with the same ids, on every run.
			let fixture!: Scene;
			const run = await eachWriteInTurn({
				build: () => {
					fixture = scene();
					const linked = c.before?.(fixture);
					if (linked) makeDependency({ blocked: linked[0], blocker: linked[1] });
					return fixture;
				},
				request: (s) => c.request(s),
				afterSuccess: (s, res: ApiResult) => {
					expect(res.status, JSON.stringify(res.body)).toBe(c.status);
					expect(links()).toEqual(c.after(s));
					expect(entries()).toEqual([c.entry(s)]);
				}
			});

			// The link and the entry. Before card 2114 there was no second write
			// to fail: the link was recorded, or taken away, and nothing said so.
			expect(shape(run.writes)).toEqual([
				c.before ? 'delete from work_dependencies' : 'insert or ignore',
				'insert into activity_log'
			]);
			expect(run.effects.map(name)).toEqual(c.told(fixture).map((board) => `event update (card) on board ${board}`));
		});
	}
});

// ─── Read where it is used ──────────────────────────────────────────────────

describe('each reads what it checks, and the links, inside the transaction that writes', () => {
	/**
	 * The session card route and both subtask routes used to read the card or
	 * the subtask, and check the caller against it, before they awaited the
	 * body, and to read the graph and the answer's list outside any
	 * transaction. For each handler of the four routes: the table its address
	 * check reads, and a request that succeeds. Every read of that table, and of
	 * `work_dependencies`, must be inside a transaction, and there must be one.
	 *
	 * The v1 card route did this already; it is here to show it still does.
	 */
	type Case = {
		route: string;
		/**
		 * The table the address check reads (`cards` for a card, `subtasks` for
		 * a subtask), and `work_dependencies` where the handler reads the links:
		 * all but the v1 card removal, which answers with a count.
		 */
		tables: string[];
		before?: (s: Scene) => [End, End];
		status: number;
		request: (s: Scene) => Promise<ApiResult>;
	};

	const post = (path: string, body: unknown) => (s: Scene) => api('POST', path, { user: s.owner, body });
	const del = (path: string, body: unknown) => (s: Scene) => api('DELETE', path, { user: s.owner, body });

	const CASES: Case[] = [
		['/api/cards', 'cards'],
		['/api/v1/cards', 'cards'],
		['/api/subtasks', 'subtasks'],
		['/api/v1/subtasks', 'subtasks']
	].flatMap(([prefix, guard]) => {
		const self = (s: Scene): End => (guard === 'cards' ? s.first : s.step);
		const path = (s: Scene) => `${prefix}/${self(s).id}/dependencies`;
		return [
			{
				route: `POST ${prefix}/:id/dependencies`,
				tables: [guard, 'work_dependencies'],
				status: 201,
				request: (s: Scene) => post(path(s), { dependsOnCardId: s.second.id })(s)
			},
			{
				route: `DELETE ${prefix}/:id/dependencies`,
				tables: prefix === '/api/v1/cards' ? [guard] : [guard, 'work_dependencies'],
				before: (s: Scene): [End, End] => [self(s), s.second],
				status: 200,
				request: (s: Scene) => del(path(s), { dependsOnCardId: s.second.id })(s)
			}
		];
	});

	for (const c of CASES) {
		for (const table of c.tables) {
			it(`${c.route} (${table})`, async () => {
				const s = scene();
				const linked = c.before?.(s);
				if (linked) makeDependency({ blocked: linked[0], blocker: linked[1] });
				// Installed last: it counts every read of the table from here on.
				const reads = watchReads(table);

				let res: ApiResult;
				try {
					res = await c.request(s);
				} finally {
					reads.restore();
				}

				expect(res.status, JSON.stringify(res.body)).toBe(c.status);
				expect(reads.inTransaction.length).toBeGreaterThan(0);
				expect(reads.inTransaction).toEqual(reads.inTransaction.map(() => true));
			});
		}
	}
});

// ─── A loop closed by another writer ────────────────────────────────────────

describe('a link the other way round, written as the graph is read, cannot close a loop', () => {
	/**
	 * Another writer records the opposite link just as the request has read
	 * the graph it checks against: what a second request, or a second process
	 * on the database file, would do at that moment. Read outside a
	 * transaction, the check passed on the graph as it was and the write then
	 * closed a loop. Read inside the transaction that writes, no other writer
	 * can come between, and `afterRead` is never called.
	 *
	 * It acts on the first read only. The handlers read the links twice, the
	 * graph and then the answer's list, and the opposite link written a second
	 * time would fail on the pair's unique index and stop the request.
	 */
	const ADDS: { route: string; path: (s: Scene) => string; body: (s: Scene) => unknown; ends: (s: Scene) => [End, End] }[] = [
		{
			route: 'POST /api/cards/:id/dependencies',
			path: (s) => `/api/cards/${s.first.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.second.id }),
			ends: (s) => [s.first, s.second]
		},
		{
			route: 'POST /api/subtasks/:id/dependencies',
			path: (s) => `/api/subtasks/${s.step.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.second.id }),
			ends: (s) => [s.step, s.second]
		},
		{
			route: 'POST /api/v1/subtasks/:subtaskId/dependencies',
			path: (s) => `/api/v1/subtasks/${s.step.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.second.id }),
			ends: (s) => [s.step, s.second]
		},
		// Built in one transaction before card 2114; here to show it still is.
		{
			route: 'POST /api/v1/cards/:cardId/dependencies',
			path: (s) => `/api/v1/cards/${s.first.id}/dependencies`,
			body: (s) => ({ dependsOnCardId: s.second.id }),
			ends: (s) => [s.first, s.second]
		}
	];

	for (const c of ADDS) {
		it(c.route, async () => {
			const s = scene();
			const [blocked, blocker] = c.ends(s);
			let landed = false;
			const reads = watchReads('work_dependencies', (nth) => {
				if (nth !== 1) return;
				landed = true;
				makeDependency({ blocked: blocker, blocker: blocked });
			});

			let res: ApiResult;
			try {
				res = await api('POST', c.path(s), { user: s.owner, body: c.body(s) });
			} finally {
				reads.restore();
			}

			expect(reads.inTransaction.length).toBeGreaterThan(0);
			expect(reads.inTransaction).toEqual(reads.inTransaction.map(() => true));
			expect(landed).toBe(false);
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			// The one link asked for, and no loop.
			expect(links()).toEqual([link(blocked, blocker)]);
		});
	}
});

// ─── What the entries are not ───────────────────────────────────────────────

describe('the activity report does not count a dependency added or removed as work on the card', () => {
	/**
	 * `buildActivityReport` puts a card in the window for any activity entry
	 * on it, and puts it down to whoever wrote the entry. Since card 2114 the
	 * card window and the subtask routes record their links too, so linking a
	 * blocker would have put a card nobody worked on into the report, as the
	 * work of whoever linked it. Neither the window nor the person counts them.
	 */
	const today = new Date().toISOString().slice(0, 10);
	const reported = (s: Scene, userId: number | null = null) =>
		buildActivityReport({ actor: s.admin, userId, from: today, to: today }).boards.flatMap((board) => board.cards.map((card) => card.id));

	it('in the window, or for the person who linked them, in either spelling', async () => {
		const s = scene();
		// Made long ago and not changed since: only the entries could bring them in.
		db.update(cards).set({ createdAt: '2020-01-01 00:00:00', updatedAt: '2020-01-01 00:00:00' }).run();
		const sent = async (method: 'POST' | 'DELETE', path: string, body: unknown, status: number) => {
			const res = await api(method, path, { user: s.owner, body });
			expect(res.status, JSON.stringify(res.body)).toBe(status);
		};

		await sent('POST', `/api/cards/${s.first.id}/dependencies`, { dependsOnCardId: s.second.id }, 201);
		await sent('DELETE', `/api/cards/${s.first.id}/dependencies`, { dependsOnCardId: s.second.id }, 200);
		await sent('POST', `/api/v1/cards/${s.second.id}/dependencies`, { dependsOnSubtaskId: s.step.id }, 201);
		await sent('DELETE', `/api/v1/cards/${s.second.id}/dependencies`, { dependsOnSubtaskId: s.step.id }, 200);
		// The bulk entry names no card; if one ever did, it would not count either.
		logActivity({ boardId: s.A.board.id, cardId: s.first.id, userId: s.owner.id, action: 'api:dependencies_bulk_added', detail: 'Recorded 1 dependency' });
		expect(
			entries()
				.map((entry) => entry.action)
				.sort()
		).toEqual(['api:dependencies_bulk_added', 'api:dependency_added', 'api:dependency_removed', 'dependency_added', 'dependency_removed']);

		expect(reported(s)).toEqual([]);
		expect(reported(s, s.owner.id)).toEqual([]);

		// Any other entry on the card is still work on it, and its author's.
		logActivity({ boardId: s.A.board.id, cardId: s.first.id, userId: s.admin.id, action: 'card_updated', detail: 'Renamed' });
		expect(reported(s)).toEqual([s.first.id]);
		expect(reported(s, s.admin.id)).toEqual([s.first.id]);
		// The card is in the window now, and still not put down to the one who only linked it.
		expect(reported(s, s.owner.id)).toEqual([]);
		logActivity({ boardId: s.A.board.id, cardId: s.first.id, userId: s.owner.id, action: 'card_updated', detail: 'Renamed again' });
		expect(reported(s, s.owner.id)).toEqual([s.first.id]);
	});

	// Card 2299: a subtask edit is now recorded, as `subtask_updated`, and it
	// is work on the card, as a tick (`subtask_completed`) is. So a card whose
	// only activity in the window is an edit to one of its subtasks now enters
	// it, put down to whoever made the edit. The owner neither made the card
	// nor is assigned to it, so only the entry can bring it in.
	it('a subtask edited is work on its card, in the window and for the person who edited it', async () => {
		const s = scene();
		db.update(cards).set({ createdAt: '2020-01-01 00:00:00', updatedAt: '2020-01-01 00:00:00' }).run();
		expect(reported(s)).toEqual([]);

		const res = await api('PUT', `/api/v1/subtasks/${s.step.id}`, { user: s.owner, body: { title: 'Step two' } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);

		expect(entries().map((entry) => `${entry.action} by ${entry.userId}`)).toEqual([`api:subtask_updated by ${s.owner.id}`]);
		expect(reported(s)).toEqual([s.first.id]);
		expect(reported(s, s.owner.id)).toEqual([s.first.id]);
		expect(reported(s, s.admin.id)).toEqual([]);
	});

	// The board's activity panel names an entry by its action, as stored
	// ("dependency added"). The labelled list that named these two,
	// `getActionLabel`, was read only by a panel nothing drew, and went with it
	// (card 2010).
});
