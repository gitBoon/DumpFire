/**
 * The board's contents, read in one place (card 2280, slice B1 of card 2012's
 * part B).
 *
 * The board page's load read everything the page draws in its own body. The
 * page is to stop re-running that whole load after every change and read
 * only its board instead, from `GET /api/boards/[id]/contents`. So the read
 * moves into one server reader, `readBoardContents` in
 * `src/lib/server/board-contents.ts`, which the load and the route both
 * call: the first draw and every refresh after it cannot then differ.
 *
 *   1. The contract the move relies on: for a board with every kind of thing
 *      on it, the load gives what it gave before the move (written first,
 *      against the load as it was), and the reader gives exactly the load.
 *   2-4. The route refuses as the load does: 404 for a board that is not
 *      there, 403 for one the caller cannot open; and answers a viewer with
 *      the reader's contents for that viewer, a withheld blocker withheld.
 *   5. The answer is never kept by a browser or a proxy.
 *   6. The breadcrumb walk reads each crumb's board once for someone who is
 *      not an administrator, through a helper that takes the board row
 *      (`roleOnBoard`); `getBoardRole` and `canViewBoard` answer as before.
 *
 * The plan is `docs/planning/card-2012-service-layer-and-pages.md`, part B
 * (decision 9, section 4.5, R6, section 6.2).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { boardMembers, boards, cardLabels, categories, taskRequests, tokenUsage, type Board } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { eq } from 'drizzle-orm';
import { canViewBoard, getBoardRole, roleOnBoard } from '$lib/server/board-access';
import { breadcrumbsFor, readBoardContents } from '$lib/server/board-contents';
import { WITHHELD_BOARD_NAME } from '$lib/server/planning';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { watchReads } from './helpers/reads';
import {
	addBoardMember,
	assignCard,
	makeBoard,
	makeCard,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	resetDb,
	shareBoardWithTeam
} from './helpers/fixtures';

beforeEach(resetDb);

/**
 * A board with one of everything the page draws:
 *
 *   G (owner's, the viewer not on it) > P (the viewer a member) > A
 *
 * A's cards: `full` with a subtask, a label, an assignee, a category, a goal,
 * a token entry and the request it was made from; `waits`, blocked by a card
 * on B, a board only `outsider` can open; `parent`, under which hangs S, a
 * sub-board only the owner can open, with one open card; and an archived
 * card, which is not drawn.
 */
function world() {
	const owner = makeUser({ username: 'owner' });
	const viewer = makeUser({ username: 'viewer' });
	const outsider = makeUser({ username: 'outsider' });
	const admin = makeUser({ username: 'admin', role: 'admin' });

	const G = makeBoard({ owner, name: 'Grand' });
	const gCard = makeCard(G.cols['To Do'], { title: 'G card' });
	const P = makeBoard({ owner, name: 'Parent', parentCardId: gCard.id });
	addBoardMember(P.board, viewer, 'viewer');
	const pCard = makeCard(P.cols['To Do'], { title: 'P card' });
	const A = makeBoard({ owner, name: 'Board A', parentCardId: pCard.id });
	addBoardMember(A.board, viewer, 'viewer');

	// A board of the owner's under no card, which the owner may link under a card of A.
	const loose = makeBoard({ owner, name: 'Loose' });
	const B = makeBoard({ owner: outsider, name: 'Kept to B' });
	const awaited = makeCard(B.cols['To Do'], { title: 'B card kept to B' });

	const category = db.insert(categories).values({ boardId: A.board.id, name: 'Ops', color: '#112233' }).returning().get();
	const label = makeLabel(A.board, 'Urgent');

	const full = makeCard(A.cols['To Do'], { title: 'Full card', position: 1, categoryId: category.id, priority: 'high' });
	const subtask = makeSubtask(full, { title: 'Step one' });
	db.insert(cardLabels).values({ cardId: full.id, labelId: label.id }).run();
	assignCard(full, viewer);
	const goal = makeMilestone({ board: A.board, name: 'Goal', cards: [full], createdBy: owner });
	db.insert(tokenUsage).values({ cardId: full.id, tokens: 1500, reportedByUserId: owner.id }).run();
	db.insert(taskRequests)
		.values({ targetType: 'user', targetId: owner.id, requesterName: 'Rae', title: 'Asked for', status: 'accepted', resolvedCardId: full.id })
		.run();

	const waits = makeCard(A.cols['In Progress'], { title: 'Waits on B', position: 1 });
	makeDependency({ blocked: waits, blocker: awaited, createdBy: outsider });

	const parent = makeCard(A.cols['In Progress'], { title: 'Has a sub-board', position: 2 });
	const S = makeSubBoard(parent, { owner, name: 'Sub S' });

	const archived = makeCard(A.cols['Complete'], { title: 'Archived card', archivedAt: '2026-10-01 09:00:00' });

	return { owner, viewer, outsider, admin, G, P, pCard, A, loose, B, awaited, category, label, full, subtask, goal, waits, parent, S, archived };
}

/** What the load answers, as data. */
async function loaded(path: string, user: Parameters<typeof readBoardContents>[0]) {
	const res = await pageLoad(path, { user });
	expect(res.type).toBe('data');
	return res.type === 'data' ? res.data : null;
}

const KEYS = [
	'blockedState',
	'board',
	'boardTokenSummary',
	'boardUsers',
	'breadcrumbs',
	'canEdit',
	'canManage',
	'cardTokens',
	'categories',
	'columns',
	'labels',
	'linkableBoards',
	'milestones',
	'userBoardRole'
];

describe('readBoardContents: the one reader of what the board page draws', () => {
	it('gives what the board load gave, key for key, and the load gives the reader', async () => {
		const w = world();

		for (const who of ['owner', 'viewer'] as const) {
			const user = w[who];
			const data = await loaded(`/board/${w.A.board.id}`, user);

			// The load, as it was before the move (this part was written first and
			// passed against it).
			expect(Object.keys(data).sort(), who).toEqual(KEYS);
			expect(data.board, who).toMatchObject({ id: w.A.board.id, name: 'Board A', parentCardId: w.pCard.id });
			expect(data.canEdit, who).toBe(who === 'owner');
			expect(data.canManage, who).toBe(who === 'owner');
			expect(data.userBoardRole, who).toBe(who === 'owner' ? 'owner' : 'viewer');
			expect(
				data.breadcrumbs.map((c: { label: string; href: string | null }) => [c.label, c.href]),
				who
			).toEqual(
				who === 'owner'
					? [
							['Grand', `/board/${w.G.board.id}`],
							['Parent', `/board/${w.P.board.id}`]
						]
					: [
							[WITHHELD_BOARD_NAME, null],
							['Parent', `/board/${w.P.board.id}`]
						]
			);
			expect(data.columns.map((c: { title: string; cards: { title: string }[] }) => [c.title, c.cards.map((card) => card.title)]), who).toEqual([
				['To Do', ['Full card']],
				['On Hold', []],
				['In Progress', ['Waits on B', 'Has a sub-board']],
				['Complete', []]
			]);

			const full = data.columns[0].cards[0];
			expect(full, who).toMatchObject({
				id: w.full.id,
				categoryId: w.category.id,
				priority: 'high',
				milestoneId: w.goal.id,
				labelIds: [w.label.id],
				subBoards: [],
				hiddenOpenCount: 0,
				assignees: [{ id: w.viewer.id, username: 'viewer', emoji: '👤' }],
				requestOrigin: { requesterName: 'Rae', requestTitle: 'Asked for' }
			});
			expect(full.subtasks.map((s: { id: number; title: string }) => [s.id, s.title]), who).toEqual([[w.subtask.id, 'Step one']]);

			const parent = data.columns[2].cards[1];
			if (who === 'owner') {
				expect(parent.subBoards, who).toEqual([{ id: w.S.board.id, name: 'Sub S', emoji: '📋', done: 0, total: 1 }]);
				expect(parent.hiddenOpenCount, who).toBe(0);
			} else {
				// A sub-board the viewer cannot open is not named, and its open card counted.
				expect(parent.subBoards, who).toEqual([]);
				expect(parent.hiddenOpenCount, who).toBe(1);
			}

			expect(data.categories.map((c: { id: number }) => c.id), who).toContain(w.category.id);
			expect(data.labels.map((l: { id: number; name: string }) => [l.id, l.name]), who).toEqual([[w.label.id, 'Urgent']]);
			expect(data.boardUsers.map((u: { username: string }) => u.username).sort(), who).toEqual(['admin', 'owner', 'viewer']);

			// The blocker on B is withheld: neither caller can open B.
			const blockers = data.blockedState[w.waits.id];
			expect(blockers, who).toHaveLength(1);
			expect(blockers[0].withheld, who).toBe(true);
			expect(JSON.stringify(data), who).not.toContain('kept to B');
			expect(JSON.stringify(data), who).not.toContain('Kept to B');

			expect(data.cardTokens, who).toEqual({ [w.full.id]: { tokens: 1500, costUsd: null } });
			expect(data.boardTokenSummary, who).toMatchObject({ total: 1500, entries: 1 });
			expect(data.milestones.map((m: { id: number }) => m.id), who).toEqual([w.goal.id]);
			// An owner may link a board here; a viewer may not.
			expect(data.linkableBoards.map((b: { id: number }) => b.id), who).toEqual(who === 'owner' ? [w.loose.board.id] : []);

			// The reader is the load.
			expect(readBoardContents(user, w.A.board.id), who).toEqual(data);
		}
	});

	it('gives nothing a JSON answer would lose', () => {
		const w = world();
		const contents = readBoardContents(w.owner, w.A.board.id);
		// A Map or a Set would be sent as `{}`: the route answers JSON.
		expect(JSON.parse(JSON.stringify(contents))).toEqual(contents);
	});
});

describe('GET /api/boards/{id}/contents', () => {
	it('answers 404 for a board that is not there, an administrator included', async () => {
		const w = world();
		for (const user of [w.owner, w.admin]) {
			const res = await api('GET', '/api/boards/9999/contents', { user });
			expect(res.status, user.username).toBe(404);
			expect(res.body.message).toBe('Board not found');
		}
	});

	it('answers 403 for a board the caller cannot open, 401 for nobody', async () => {
		const w = world();
		const res = await api('GET', `/api/boards/${w.A.board.id}/contents`, { user: w.outsider });
		expect(res.status).toBe(403);
		expect(JSON.stringify(res.body)).not.toContain('Board A');

		expect((await api('GET', `/api/boards/${w.A.board.id}/contents`)).status).toBe(401);
	});

	it("answers a viewer with the reader's contents for that viewer, a withheld blocker withheld", async () => {
		const w = world();
		const res = await api('GET', `/api/boards/${w.A.board.id}/contents`, { user: w.viewer });

		expect(res.status).toBe(200);
		expect(res.body).toEqual(JSON.parse(JSON.stringify(readBoardContents(w.viewer, w.A.board.id))));
		expect(res.body.userBoardRole).toBe('viewer');
		expect(res.body.canEdit).toBe(false);
		expect(res.body.blockedState[w.waits.id][0].withheld).toBe(true);
		expect(JSON.stringify(res.body)).not.toContain('kept to B');

		// And through a team, as the load lets a team member in.
		const guest = makeUser({ username: 'guest' });
		shareBoardWithTeam(w.A.board, makeTeam([guest]), 'viewer');
		const asGuest = await api('GET', `/api/boards/${w.A.board.id}/contents`, { user: guest });
		expect(asGuest.status).toBe(200);
		expect(asGuest.body.userBoardRole).toBe('viewer');
	});

	it('is never kept: cache-control private, no-store', async () => {
		const w = world();
		const res = await api('GET', `/api/boards/${w.A.board.id}/contents`, { user: w.owner });
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('private, no-store');
	});
});

describe('the breadcrumb walk (S5)', () => {
	it("reads each crumb's board once for someone who is not an administrator", () => {
		const w = world();
		const A = db.select().from(boards).where(eq(boards.id, w.A.board.id)).get() as Board;

		for (const user of [w.viewer, w.owner, w.admin]) {
			const reads = watchReads('boards');
			let crumbs: ReturnType<typeof breadcrumbsFor>;
			try {
				crumbs = breadcrumbsFor(user, A);
			} finally {
				reads.restore();
			}
			// Two crumbs, G and P: one read of `boards` each. `canViewBoard` read
			// each again, so it was four.
			expect(reads.inTransaction, user.username).toHaveLength(2);
			expect(crumbs.map((c) => c.label), user.username).toEqual(
				user === w.viewer ? [WITHHELD_BOARD_NAME, 'Parent'] : ['Grand', 'Parent']
			);
		}
	});

	it('roleOnBoard, given the row, getBoardRole and canViewBoard each give every caller the role the access model gives', () => {
		const w = world();
		const editor = makeUser({ username: 'editor' });
		addBoardMember(w.A.board, editor, 'editor');
		const teamViewer = makeUser({ username: 'teamViewer' });
		shareBoardWithTeam(w.A.board, makeTeam([teamViewer]), 'viewer');
		const teamEditor = makeUser({ username: 'teamEditor' });
		shareBoardWithTeam(w.A.board, makeTeam([teamEditor]), 'editor');
		// A member row stored with a role that is not one of the three (before card 2117) is a viewer.
		const storedAdmin = makeUser({ username: 'storedAdmin' });
		db.insert(boardMembers).values({ boardId: w.A.board.id, userId: storedAdmin.id, role: 'admin' }).run();
		const chief = makeUser({ username: 'chief', role: 'superadmin' });
		const publicBoard = makeBoard({ owner: w.outsider, isPublic: true, name: 'Public' }).board;

		const A = w.A.board;
		const cases: [SessionUser, Board, 'admin' | 'owner' | 'editor' | 'viewer' | null][] = [
			[w.owner, A, 'owner'],
			[editor, A, 'editor'],
			[w.viewer, A, 'viewer'],
			[teamViewer, A, 'viewer'],
			[teamEditor, A, 'editor'],
			[storedAdmin, A, 'viewer'],
			[w.admin, A, 'admin'],
			[chief, A, 'admin'],
			[w.outsider, A, null],
			[w.outsider, w.B.board, 'owner'],
			[w.owner, publicBoard, 'viewer'],
			[teamEditor, publicBoard, 'viewer']
		];
		for (const [user, board, expected] of cases) {
			const row = db.select().from(boards).where(eq(boards.id, board.id)).get() as Board;
			const at = `${user.username} on ${row.name}`;
			expect(roleOnBoard(user, row), at).toBe(expected);
			expect(getBoardRole(user, board.id), at).toBe(expected);
			expect(canViewBoard(user, board.id), at).toBe(expected !== null);
		}
	});
});
