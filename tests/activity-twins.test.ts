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
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { activityLog, taskRequests, type Card, type CardComment } from '$lib/server/db/schema';
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
	makeSmtp,
	makeUser,
	resetDb,
	type BoardFixture
} from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

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
		expect(written.length).toBeGreaterThan(30);
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
