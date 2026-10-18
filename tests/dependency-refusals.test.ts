/**
 * A dependency link that is refused is answered the same way by all four
 * routes that add or remove one.
 *
 * There are four because there are two things a link can be edited from, a
 * card and a subtask, and two ways in: `/api/v1/` with an API key, and `/api/`
 * with the session the pages use. Three implementations sat behind them and
 * they disagreed. An end that waits on itself was a 400 on one route and a 409
 * on the other three, as was an end that is archived; a link that would close
 * a loop carried its chain as `cycle` on one route only; and removing a link
 * that is not there was a 404 on one and a 200 on the rest.
 *
 * `src/lib/server/dependency-refusals.ts` is now the one place that turns what
 * the validator found into an answer:
 *
 *     an end that waits on itself          400 { message }
 *     an end that is archived              400 { message }
 *     a link that is already recorded      409 { message }
 *     a link that would close a loop       409 { message, cycle }
 *     removing a link that is not there    404 { message }
 *
 * Each row below is asked of each route, with the refusals each route makes
 * for itself before it gets that far (no end given, an end that is not there,
 * no edit access). After every refusal not one row of the database has
 * changed and nothing has been sent.
 *
 * A body that is missing, is not JSON or is not an object is refused before
 * any of that: 400, on all four. That refusal is not the routes' own. The
 * gate guards the reading of the body for every route at once
 * (`guardBody` in `src/lib/server/api-errors.ts`), and `api()` guards each
 * request it builds in the same way, so the routes are asked here as they are
 * on the wire. `tests/gate.test.ts` shows the gate itself doing it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards, workDependencies, type Card, type Subtask } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { dependencyEndBody } from '$lib/api';
import { api, type ApiResult } from './helpers/api';
import { effects } from './helpers/effects';
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
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type End = { kind: 'card' | 'subtask'; id: number };

/** "#12" for a card and "subtask #5" for a subtask, as the answers say it. */
const said = (end: End) => (end.kind === 'subtask' ? `subtask #${end.id}` : `#${end.id}`);

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

let owner: SessionUser;
let viewer: SessionUser;
let stranger: SessionUser;
/** The owner's board, which the viewer may read. */
let A: BoardFixture;
/** The stranger's board, which the owner has no access to. */
let B: BoardFixture;
let first: Card;
let second: Card;
let third: Card;
/** A card on the board the owner cannot edit. */
let far: Card;
/** A subtask of `first`. */
let step: Subtask;

beforeEach(() => {
	resetDb();
	owner = makeUser();
	viewer = makeUser();
	stranger = makeUser();
	A = makeBoard({ owner });
	B = makeBoard({ owner: stranger });
	addBoardMember(A.board, viewer, 'viewer');
	first = makeCard(A.cols['To Do']);
	second = makeCard(A.cols['To Do']);
	third = makeCard(A.cols['To Do']);
	far = makeCard(B.cols['To Do']);
	step = makeSubtask(first);
});

/**
 * Make `request`, and check that it was answered `status`, that not one row
 * changed, and that nothing was sent.
 */
async function refused(request: () => Promise<ApiResult>, status: number): Promise<ApiResult> {
	const before = snapshotDb();
	const linksBefore = links();
	const sent = effects();
	try {
		const res = await request();
		await sent.settle();
		expect(res.status).toBe(status);
		// No dependency was written or removed, and nothing else was either.
		expect(links()).toEqual(linksBefore);
		expectUnchanged(before);
		expect(sent.all).toEqual([]);
		return res;
	} finally {
		sent.restore();
	}
}

type Route = {
	name: string;
	path: (id: number | string) => string;
	/** The end the route is asked about: `first` for a card route, its subtask for a subtask route. */
	self: () => End;
	/** The field that names `self` as the thing waited on. */
	selfField: 'dependsOnCardId' | 'dependsOnSubtaskId';
	/** What each route says for the refusals it makes itself. */
	says: { noEnd: string; twoEnds: string; notFound: string; noEdit: string };
};

const CARD_ROUTE = { self: (): End => ({ kind: 'card', id: first.id }), selfField: 'dependsOnCardId' as const };
const SUBTASK_ROUTE = { self: (): End => ({ kind: 'subtask', id: step.id }), selfField: 'dependsOnSubtaskId' as const };
const SUBTASK_SAYS = {
	noEnd:
		'Provide one of dependsOnCardId, dependsOnSubtaskId (this subtask waits on it), blocksCardId or blocksSubtaskId (it waits on this subtask)',
	twoEnds: 'Provide only one end',
	notFound: 'Subtask not found',
	noEdit: "No edit access to this subtask's board"
};

const ROUTES: Route[] = [
	{
		name: 'POST and DELETE /api/v1/cards/:cardId/dependencies',
		path: (id) => `/api/v1/cards/${id}/dependencies`,
		...CARD_ROUTE,
		says: {
			noEnd:
				'Provide one of dependsOnCardId, dependsOnSubtaskId (this card waits on it), blocksCardId or blocksSubtaskId (it waits on this card)',
			twoEnds: 'Provide only one of the dependsOn*/blocks* fields',
			notFound: 'Card not found',
			noEdit: "No edit access to this card's board"
		}
	},
	{
		name: 'POST and DELETE /api/cards/:id/dependencies',
		path: (id) => `/api/cards/${id}/dependencies`,
		...CARD_ROUTE,
		says: { noEnd: 'Nothing to link', twoEnds: 'Provide only one end', notFound: 'Card not found', noEdit: 'No edit access' }
	},
	{
		name: 'POST and DELETE /api/v1/subtasks/:subtaskId/dependencies',
		path: (id) => `/api/v1/subtasks/${id}/dependencies`,
		...SUBTASK_ROUTE,
		says: SUBTASK_SAYS
	},
	{
		name: 'POST and DELETE /api/subtasks/:id/dependencies',
		path: (id) => `/api/subtasks/${id}/dependencies`,
		...SUBTASK_ROUTE,
		says: SUBTASK_SAYS
	}
];

describe.each(ROUTES)('$name', (route) => {
	// Each is a request still to be made, so that `refused` can look at the
	// database before it is.
	const post = (user: SessionUser | null, id: number | string, body: unknown) => () =>
		api('POST', route.path(id), { user, body });
	const del = (user: SessionUser | null, id: number | string, body: unknown) => () =>
		api('DELETE', route.path(id), { user, body });

	it('records a link and removes it again, so that what follows is refused for the reason given', async () => {
		const self = route.self();

		const added = await post(owner, self.id, { dependsOnCardId: second.id })();
		expect(added.status).toBe(201);
		expect(added.body.isBlocked).toBe(true);
		expect(links()).toEqual([
			{ blockedType: self.kind, blockedId: self.id, blockerType: 'card', blockerId: second.id }
		]);

		const removed = await del(owner, self.id, { dependsOnCardId: second.id })();
		expect(removed.status).toBe(200);
		expect(links()).toEqual([]);
	});

	it('answers 400 when the body is missing, is not JSON, or is not an object, and neither adds nor removes a link', async () => {
		const self = route.self();
		// A link to remove, so that a DELETE that got past its body would show.
		makeDependency({ blocked: self, blocker: second });
		// Bytes are sent as they are; anything else `api()` is given it sends as JSON.
		const sent = (method: 'POST' | 'DELETE', text?: string) => () =>
			api(method, route.path(self.id), {
				user: owner,
				body: text === undefined ? undefined : Buffer.from(text),
				headers: { 'content-type': 'application/json' }
			});

		for (const method of ['POST', 'DELETE'] as const) {
			expect((await refused(sent(method), 400)).body).toEqual({
				message: 'The request body is missing or is not valid JSON'
			});
			expect((await refused(sent(method, '{"dependsOnCardId":'), 400)).body).toEqual({
				message: 'The request body is missing or is not valid JSON'
			});
			expect((await refused(sent(method, 'null'), 400)).body).toEqual({
				message: 'The request body must be a JSON object'
			});
			expect((await refused(sent(method, String(third.id)), 400)).body).toEqual({
				message: 'The request body must be a JSON object'
			});
		}
		expect(links()).toHaveLength(1);
	});

	it('answers 400 when no end is given, when two are, and when one is not a number', async () => {
		const self = route.self();

		expect((await refused(post(owner, self.id, {}), 400)).body).toEqual({ message: route.says.noEnd });
		expect(
			(await refused(post(owner, self.id, { dependsOnCardId: second.id, blocksCardId: third.id }), 400)).body
		).toEqual({ message: route.says.twoEnds });
		expect((await refused(post(owner, self.id, { dependsOnCardId: 'abc' }), 400)).body).toEqual({
			message: 'dependsOnCardId must be an id'
		});
	});

	// Card 2114 moved all four routes onto card 2117's readers (`readId`,
	// `pathId`, src/lib/server/request-body.ts). An end was read with
	// `Number()`, so `true` named card 1, `[3]` card 3, and `0`, `1.5` and `''`
	// were looked for and not found.
	it('answers 400 for an end that is not a whole number of 1 or more, and reads one written as text', async () => {
		const self = route.self();

		for (const value of [true, false, 0, -1, 1.5, '', '1.5x', [second.id], { id: second.id }]) {
			for (const send of [post, del]) {
				expect((await refused(send(owner, self.id, { dependsOnCardId: value }), 400)).body, JSON.stringify(value)).toEqual({
					message: 'dependsOnCardId must be an id'
				});
			}
		}
		// `null` is not sent.
		expect((await refused(post(owner, self.id, { dependsOnCardId: null }), 400)).body).toEqual({ message: route.says.noEnd });

		// A whole number written as text is that number.
		const added = await post(owner, self.id, { dependsOnCardId: String(second.id) })();
		expect(added.status).toBe(201);
		expect(links()).toEqual([{ blockedType: self.kind, blockedId: self.id, blockerType: 'card', blockerId: second.id }]);
	});

	it('answers 400 for an id in the path that is not a whole number of 1 or more', async () => {
		const says = route.self().kind === 'card' ? 'Invalid card ID' : 'Invalid subtask ID';

		for (const id of ['0', '1.5', '-1', '1e3']) {
			for (const send of [post, del]) {
				expect((await refused(send(owner, id, { dependsOnCardId: second.id }), 400)).body, id).toEqual({ message: says });
			}
		}
	});

	it('answers 404 when this end is not there, and when the other end is not', async () => {
		const self = route.self();

		expect((await refused(post(owner, 99999, { dependsOnCardId: second.id }), 404)).body).toEqual({
			message: route.says.notFound
		});
		expect((await refused(post(owner, self.id, { dependsOnCardId: 99999 }), 404)).body).toEqual({
			message: '#99999 not found'
		});
		expect((await refused(post(owner, self.id, { blocksSubtaskId: 99999 }), 404)).body).toEqual({
			message: 'subtask #99999 not found'
		});
	});

	it('answers 403 to a caller who may not edit this end’s board, or the other end’s', async () => {
		const self = route.self();

		expect((await refused(post(viewer, self.id, { dependsOnCardId: second.id }), 403)).body).toEqual({
			message: route.says.noEdit
		});
		expect((await refused(post(owner, self.id, { dependsOnCardId: far.id }), 403)).body).toEqual({
			message: `No edit access to the board holding #${far.id}`
		});
	});

	it('answers 409 with a message and no cycle for a link that is already recorded', async () => {
		const self = route.self();
		makeDependency({ blocked: self, blocker: second });

		const res = await refused(post(owner, self.id, { dependsOnCardId: second.id }), 409);

		expect(res.body).toEqual({ message: 'That dependency already exists' });
		// A cycle is the 409 with `cycle` in it. This is the other one.
		expect(res.body).not.toHaveProperty('cycle');
		expect(res.body).not.toHaveProperty('error');
	});

	it('answers 400 for an end that waits on itself', async () => {
		const self = route.self();

		const res = await refused(post(owner, self.id, { [route.selfField]: self.id }), 400);

		expect(res.body).toEqual({ message: `${said(self)} cannot depend on itself` });
	});

	it('answers 400 when the other end is archived, and when this end is', async () => {
		const self = route.self();
		const archive = (card: Card) =>
			db.update(cards).set({ archivedAt: '2026-10-01 00:00:00' }).where(eq(cards.id, card.id)).run();

		archive(second);
		expect((await refused(post(owner, self.id, { dependsOnCardId: second.id }), 400)).body).toEqual({
			message: `#${second.id} does not exist or is archived`
		});

		// `first` is the card of a card route, and the card the subtask of a
		// subtask route belongs to: archived, neither can be an end.
		archive(first);
		expect((await refused(post(owner, self.id, { dependsOnCardId: third.id }), 400)).body).toEqual({
			message: `${said(self)} does not exist or is archived`
		});
	});

	it('answers 409 with the chain, as text in `message` and as ends in `cycle`, for a link that would close a loop', async () => {
		const self = route.self();
		// `self` waits on `second`, which waits on `third`.
		makeDependency({ blocked: self, blocker: second });
		makeDependency({ blocked: second, blocker: third });

		// `third` waiting on `self` would close it.
		const res = await refused(post(owner, self.id, { blocksCardId: third.id }), 409);

		expect(res.body).toEqual({
			message:
				`#${third.id} waiting on ${said(self)} would create a cycle: ` +
				`#${third.id} → #${second.id} → ${said(self)} → #${third.id}`,
			cycle: [{ kind: 'card', id: third.id }, { kind: 'card', id: second.id }, self]
		});
		expect(res.body).not.toHaveProperty('error');
	});

	it('answers 404 when asked to remove a link that is not there, and leaves the links that are', async () => {
		const self = route.self();
		makeDependency({ blocked: self, blocker: second });

		// `self` waits on `second`, not on `third`.
		expect((await refused(del(owner, self.id, { dependsOnCardId: third.id }), 404)).body).toEqual({
			message: 'Dependency not found'
		});
		// And not the other way round.
		expect((await refused(del(owner, self.id, { blocksCardId: second.id }), 404)).body).toEqual({
			message: 'Dependency not found'
		});
		expect(links()).toHaveLength(1);
	});
});

describe('removing a link to a subtask from the card window, POST and DELETE /api/cards/:id/dependencies (card 2138)', () => {
	// A row of the card window's lists is a card or a subtask, and its id is
	// its own: a subtask's for a subtask. The remove button sent it as a card's
	// whatever the row was, so a subtask row's removal found nothing, or took
	// away the link to the card with the subtask's number. The window builds
	// the body from the row now, with `dependencyEndBody`.

	it('takes away the link the subtask row shows, and leaves the link to the card with the same number, from either list', async () => {
		const sub = makeSubtask(third);
		// A card whose id is the subtask's.
		const twin = db.select().from(cards).where(eq(cards.id, sub.id)).get() ?? makeCard(A.cols['To Do'], { id: sub.id });
		const row = { kind: 'subtask' as const, cardId: sub.id, parentCardId: third.id };

		for (const mode of ['blocked-by', 'blocks'] as const) {
			const card = makeCard(A.cols['To Do']);
			// The card waits on the subtask and on its twin, or they wait on the card.
			for (const other of [sub, twin]) {
				makeDependency(mode === 'blocked-by' ? { blocked: card, blocker: other } : { blocked: other, blocker: card });
			}

			const res = await api('DELETE', `/api/cards/${card.id}/dependencies`, { user: owner, body: dependencyEndBody(mode, row) });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const left = links().filter((link) => (mode === 'blocked-by' ? link.blockedId === card.id && link.blockedType === 'card' : link.blockerId === card.id && link.blockerType === 'card'));
			expect(left, mode).toEqual([
				mode === 'blocked-by'
					? { blockedType: 'card', blockedId: card.id, blockerType: 'card', blockerId: twin.id }
					: { blockedType: 'card', blockedId: twin.id, blockerType: 'card', blockerId: card.id }
			]);
			// And the list drawn from the answer has the card row and not the subtask row.
			const list = mode === 'blocked-by' ? res.body.blockedBy : res.body.blocks;
			expect(list.map((d: { kind: string; cardId: number }) => [d.kind, d.cardId]), mode).toEqual([['card', twin.id]]);
		}
	});
});
