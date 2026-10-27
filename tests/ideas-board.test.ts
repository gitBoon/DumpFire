/**
 * An ideas board feeds every delivery board (milestone 22, card 2463, slice
 * S5a): the server side.
 *
 * A board's `kind` is `'delivery'`, as every board was, or `'ideas'`: every
 * column of an ideas board is upstream of the commitment point, so its cards
 * are options. Here, on both trees:
 *
 *   - the kind on a new board, with each kind's default columns, and read with
 *     `keep` on an update (ruling r), changed by the owner of an empty board,
 *     which is given the other kind's columns (ruling j, decision M22-18);
 *   - a board holding cards made an ideas board by the conversion, which asks
 *     first, counts the cards and is recorded once (ruling i), and the way
 *     back refused while it holds any;
 *   - a sub-board is a delivery board (ruling p), and no sub-board hangs under
 *     an option (ruling o);
 *   - an ideas board has no Complete column;
 *   - Send to board, from any upstream column to another delivery board's
 *     Options or To Do (ruling l), recorded as `card_sent` on the board it left
 *     and `card_moved_in` on the one it joined, at one moment (ruling b,
 *     decision M22-19), keeping the option's age (decision M22-20);
 *   - the aging and figures reading a board's conversion, and the board
 *     history reading a Send;
 *   - All Tasks and All To Do sending each board's kind.
 *
 * Each write is checked for what it stores, the entries and webhooks it
 * writes, and the start-up repair finding nothing to fill or clear after it.
 * Boards that are not ideas boards behave as before: `tests/commitment.test.ts`,
 * `tests/options-column.test.ts` and the rest hold that, and the end of this
 * file holds what a Send changed beside it.
 *
 * The plan is `docs/planning/milestone-22-upstream-kanban.md`, section 3's
 * card E and section 7.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { runBackfills } from '$lib/server/db/migrate';
import { cardLabels, cards, categories, type Card, type Column } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { readBoardContents } from '$lib/server/board-contents';
import { getCardBoardHistory } from '$lib/server/activity-report';
import { timeInOptions, upstreamFigures } from '$lib/server/upstream';
import { stamp } from '$lib/timestamps';
import {
	cardSentMessage,
	DEFAULT_COLUMN_TITLES,
	deliveryBoardRefusal,
	deliveryBoardWarning,
	ideasBoardColumnRefusal,
	ideasBoardSubBoardRefusal,
	ideasBoardWarning
} from '$lib/api';
import { activityLabel } from '$lib/utils/activity-labels';
import { api, type ApiResult } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { effects, type Effects } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeLabel, makeMilestone, makeSmtp, makeTeam, makeUser, makeWebhook, resetDb, shareBoardWithTeam, type BoardFixture } from './helpers/fixtures';
import { readBudget } from './helpers/reads';
import { sendTargetsFor } from '$lib/server/cards';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

/** When every card here was made, long before any write. */
const OLD = '2026-01-05 09:00:00';

const DELIVERY = ['To Do', 'On Hold', 'In Progress', 'Complete'];
const IDEAS = ['New Ideas', 'Shaping', 'Ready for Replenishment'];
/** A new board's columns, by kind: a delivery board's Options column first (card 2527). */
const DELIVERY_DEFAULTS = ['Options', 'To Do', 'On Hold', 'In Progress', 'Complete'];
/** A new delivery board's columns as stored, at 0 to 4, the first with the Options role. */
const DELIVERY_STORED = DELIVERY_DEFAULTS.map((title, position) => ({ title, position, role: title === 'Options' ? 'options' : null }));

const SUB_BOARD = 'A sub-board is a delivery board.';
const UNDER_IDEA = 'An idea has no sub-boards; send it to a delivery board first.';
const UNDER_OPTION = 'An option has no sub-boards; commit it first, by moving it out of the Options column.';
/** The refusal of a column of an ideas board whose title makes it To Do, On Hold or Complete (the S5a review's L1). */
const noColumn = (what: string, title: string) => `An ideas board has no ${what} column: "${title}" would make one. Choose another name.`;

let owner: SessionUser;
let editor: SessionUser;
/** "Delivery", a delivery board with its Options column (card 2527), and To Do, On Hold, In Progress and Complete. */
let D: BoardFixture;
/** "Ideas board", an ideas board. */
let I: BoardFixture;
let sent: Effects;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	editor = makeUser({ username: 'editor' });
	D = makeBoard({ owner, name: 'Delivery', options: true, columns: DELIVERY });
	I = makeBoard({ owner, name: 'Ideas board', columns: IDEAS });
	sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(I.board.id);
	for (const board of [D, I]) addBoardMember(board.board, editor, 'editor');
	sent = effects();
});
afterEach(() => {
	sent.restore();
	vi.useRealTimers();
});

/**
 * A delivery board with the columns given, and the editor an editor of it;
 * with `options`, its Options column too (`cols['Options']`, card 2527).
 * Without, it has none, as a board made before card 2527 has until the next
 * start.
 */
function deliveryBoard(name: string, titles: string[], options = false): BoardFixture {
	const board = makeBoard({ owner, name, options, columns: titles });
	addBoardMember(board.board, editor, 'editor');
	return board;
}

/** A card made long ago by the owner. */
const cardIn = (column: Column, title: string, opts: Partial<typeof cards.$inferInsert> = {}) =>
	makeCard(column, { title, createdAt: OLD, updatedAt: OLD, createdBy: owner.id, ...opts });

/** A board as stored: its kind and its columns, in their order. */
const boardAsStored = (boardId: number) => ({
	kind: (sqlite.prepare('SELECT kind FROM boards WHERE id = ?').get(boardId) as { kind: string }).kind,
	columns: sqlite.prepare('SELECT title, position, role FROM columns WHERE board_id = ? ORDER BY position, id').all(boardId) as {
		title: string;
		position: number;
		role: string | null;
	}[]
});

const commitmentOf = (card: Card) =>
	sqlite.prepare('SELECT committed_at AS committedAt, committed_by AS committedBy FROM cards WHERE id = ?').get(card.id) as {
		committedAt: string | null;
		committedBy: number | null;
	};

/** The card's entries, oldest first: the stored action, the board, the detail and the moment. */
const entriesOf = (card: Card) =>
	sqlite.prepare('SELECT action, board_id AS boardId, detail, created_at AS at FROM activity_log WHERE card_id = ? ORDER BY id').all(card.id) as {
		action: string;
		boardId: number;
		detail: string;
		at: string;
	}[];

/** A CFD snapshot of each of the board's columns, as the hourly job writes them. */
function snapshotsOf(board: BoardFixture): void {
	const row = sqlite.prepare('INSERT INTO daily_snapshots (board_id, column_id, date, card_count) VALUES (?, ?, ?, ?)');
	for (const column of Object.values(board.cols)) row.run(board.board.id, column.id, '2026-10-01', 0);
}

/** How many CFD snapshots the board has. */
const snapshotCount = (boardId: number) => (sqlite.prepare('SELECT COUNT(*) AS n FROM daily_snapshots WHERE board_id = ?').get(boardId) as { n: number }).n;

/** The start-up repair finds nothing to fill and nothing to clear: every write kept the rule. */
function nothingToRepair() {
	expect(runBackfills(sqlite)).toMatchObject({ committedFilled: 0, upstreamCleared: 0, discardedCleared: 0 });
}

/** Expect `status` with `message`, nothing written and nothing sent. */
async function expectRefused(request: () => Promise<ApiResult>, status: number, message: string): Promise<void> {
	const before = snapshotDb();
	const res = await request();
	await sent.settle();
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body).toEqual({ message });
	expectUnchanged(before);
	expect(sent.all).toEqual([]);
}

type Tree = {
	name: string;
	/** The prefix the tree's entries are stored with. */
	prefix: '' | 'api:';
	create: (body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	update: (boardId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	convert: (boardId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	send: (cardId: number, body: Record<string, unknown>, user?: SessionUser) => Promise<ApiResult>;
	/** How a refused change of kind names the conversion: the page's menu item, or the operation. */
	convertNamed: (boardId: number) => string;
};

const TREES: Tree[] = [
	{
		name: 'the board page’s routes',
		prefix: '',
		create: (body, user = owner) => api('POST', '/api/boards', { user, body }),
		update: (boardId, body, user = owner) => api('PUT', `/api/boards/${boardId}`, { user, body }),
		convert: (boardId, body, user = owner) => api('POST', `/api/boards/${boardId}/convert`, { user, body }),
		send: (cardId, body, user = editor) => api('POST', `/api/cards/${cardId}/send`, { user, body }),
		convertNamed: () => '"Make this an ideas board…" in its More menu'
	},
	{
		name: 'the documented routes',
		prefix: 'api:',
		create: (body, user = owner) => api('POST', '/api/v1/boards', { user, body }),
		update: (boardId, body, user = owner) => api('PUT', `/api/v1/boards/${boardId}`, { user, body }),
		convert: (boardId, body, user = owner) => api('POST', `/api/v1/boards/${boardId}/convert`, { user, body }),
		send: (cardId, body, user = editor) => api('POST', `/api/v1/cards/${cardId}/send`, { user, body }),
		convertNamed: (boardId) => `POST /api/v1/boards/${boardId}/convert`
	}
];

describe.each(TREES)('a board’s kind, through $name', (tree) => {
	describe('on a new board', () => {
		it('makes a delivery board by default with its Options column and its four (M22-12, card 2527), and an ideas board with its three, the kind stored', async () => {
			const delivery = await tree.create({ name: 'New work' });
			const ideas = await tree.create({ name: 'New ideas', kind: 'ideas' });

			expect(delivery.status).toBe(201);
			expect(delivery.body.kind).toBe('delivery');
			expect(boardAsStored(delivery.body.id)).toEqual({ kind: 'delivery', columns: DELIVERY_STORED });
			expect(ideas.status).toBe(201);
			expect(ideas.body.kind).toBe('ideas');
			expect(boardAsStored(ideas.body.id)).toEqual({ kind: 'ideas', columns: IDEAS.map((title, position) => ({ title, position, role: null })) });
			// "delivery" sent is the default written out.
			expect((await tree.create({ name: 'Said', kind: 'delivery' })).body.kind).toBe('delivery');
			nothingToRepair();
		});

		it('refuses a kind that is not one, 400, quoting what was sent (ruling r)', async () => {
			await expectRefused(() => tree.create({ name: 'X', kind: 'portfolio' }), 400, 'kind must be "delivery" or "ideas", not "portfolio"');
			await expectRefused(() => tree.create({ name: 'X', kind: 7 }), 400, 'kind must be "delivery" or "ideas", not 7');
			await expectRefused(() => tree.create({ name: 'X', kind: null }), 400, 'kind must be "delivery" or "ideas", not null');
		});

		it('refuses an ideas sub-board, and a sub-board under an option, in the Options column or on an ideas board (rulings o and p)', async () => {
			const committed = cardIn(D.cols['To Do'], 'Committed work');
			const option = cardIn(D.cols['Options'], 'An option');
			const idea = cardIn(I.cols['Shaping'], 'An idea');

			await expectRefused(() => tree.create({ name: 'S', kind: 'ideas', parentCardId: committed.id }), 409, SUB_BOARD);
			await expectRefused(() => tree.create({ name: 'S', parentCardId: option.id }), 409, UNDER_OPTION);
			await expectRefused(() => tree.create({ name: 'S', parentCardId: idea.id }), 409, UNDER_IDEA);
			// Under committed work, as before.
			const made = await tree.create({ name: 'S', parentCardId: committed.id });
			expect(made.status).toBe(201);
			expect(made.body).toMatchObject({ parentCardId: committed.id, kind: 'delivery' });
		});
	});

	describe('on an existing board', () => {
		it('keeps the kind, and the columns, when an update leaves it out or sends it as it is, and asks no owner then (ruling r)', async () => {
			const [dWas, iWas] = [boardAsStored(D.board.id), boardAsStored(I.board.id)];

			const renamed = await tree.update(D.board.id, { name: 'Renamed' }, editor);
			expect(renamed.status).toBe(200);
			expect(renamed.body.kind).toBe('delivery');
			expect((await tree.update(D.board.id, { name: 'Again', kind: 'delivery' }, editor)).status).toBe(200);
			expect((await tree.update(I.board.id, { name: 'Still ideas', kind: 'ideas' }, editor)).body.kind).toBe('ideas');

			// The S5a review's L8: nothing but the name moved.
			expect(boardAsStored(D.board.id)).toEqual(dWas);
			expect(boardAsStored(I.board.id)).toEqual(iWas);
		});

		it('takes a kind sent alone as the board holds it, from an editor, and writes, records and sends nothing (L8)', async () => {
			const before = snapshotDb();

			const res = await tree.update(D.board.id, { kind: 'delivery' }, editor);
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.kind).toBe('delivery');
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		});

		it('refuses a kind that is not one, 400, quoting what was sent', async () => {
			await expectRefused(() => tree.update(D.board.id, { kind: 'backlog' }), 400, 'kind must be "delivery" or "ideas", not "backlog"');
		});

		it('is the owner’s or an administrator’s to change: an editor is refused, and nothing else sent is saved', async () => {
			const empty = deliveryBoard('Empty', DELIVERY, true);
			const admin = makeUser({ role: 'admin' });

			await expectRefused(
				() => tree.update(empty.board.id, { name: 'Renamed', kind: 'ideas' }, editor),
				403,
				"Only the board's owner or an administrator can change whether it is an ideas board"
			);
			expect((await tree.update(empty.board.id, { kind: 'ideas' }, admin)).status).toBe(200);
		});

		it('switches an empty delivery board to an ideas board, replacing its columns with the ideas defaults, and back (ruling j, M22-18), saying what it replaced (L3)', async () => {
			const empty = deliveryBoard('Empty', ['To Do', 'Done'], true);
			const oldIds = Object.values(empty.cols).map((c) => c.id);
			// The CFD's snapshots of the old columns, which go with them (the S5a review's L8).
			snapshotsOf(empty);

			const toIdeas = await tree.update(empty.board.id, { kind: 'ideas' });
			await sent.settle();

			expect(toIdeas.status).toBe(200);
			expect(toIdeas.body.kind).toBe('ideas');
			expect(boardAsStored(empty.board.id)).toEqual({ kind: 'ideas', columns: IDEAS.map((title, position) => ({ title, position, role: null })) });
			const left = sqlite.prepare(`SELECT COUNT(*) AS n FROM columns WHERE id IN (${oldIds.join(', ')})`).get() as { n: number };
			expect(left.n).toBe(0);
			expect(sqlite.prepare('SELECT action, detail FROM activity_log WHERE board_id = ?').all(empty.board.id)).toEqual([
				{
					action: `${tree.prefix}board_updated`,
					detail:
						'Updated board "Empty" (fields: kind): now an ideas board; its columns Options, To Do, Done were replaced with New Ideas, Shaping, Ready for Replenishment'
				}
			]);
			expect(sent.events.map((e) => `${e.event} (${e.data.type})`).sort()).toEqual(['update (board)', 'update (column)']);
			expect(sent.webhooks).toEqual([]);
			expect(snapshotCount(empty.board.id)).toBe(0);

			const back = await tree.update(empty.board.id, { kind: 'delivery' });
			expect(back.status).toBe(200);
			expect(boardAsStored(empty.board.id)).toEqual({ kind: 'delivery', columns: DELIVERY_STORED });
			expect((sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ? ORDER BY id DESC LIMIT 1').get(empty.board.id) as { detail: string }).detail).toBe(
				'Updated board "Empty" (fields: kind): now a delivery board; its columns New Ideas, Shaping, Ready for Replenishment were replaced with Options, To Do, On Hold, In Progress, Complete'
			);
			nothingToRepair();
		});

		it('refuses a change of kind while the board holds a card, archived ones included, naming the conversion (ruling i)', async () => {
			cardIn(D.cols['To Do'], 'Archived work', { archivedAt: stamp() });

			await expectRefused(
				() => tree.update(D.board.id, { kind: 'ideas' }),
				409,
				`This board holds 1 card. Making it an ideas board would make it an option without anyone deciding it: convert it instead (${tree.convertNamed(D.board.id)}), which counts the cards first and records it.`
			);
			cardIn(D.cols['To Do'], 'Live work');
			await expectRefused(
				() => tree.update(D.board.id, { kind: 'ideas' }),
				409,
				`This board holds 2 cards. Making it an ideas board would make them options without anyone deciding it: convert it instead (${tree.convertNamed(D.board.id)}), which counts the cards first and records it.`
			);
		});

		it('turns an ideas board back into a delivery board only once it is empty', async () => {
			cardIn(I.cols['Shaping'], 'One');
			await expectRefused(
				() => tree.update(I.board.id, { kind: 'delivery' }),
				409,
				'This ideas board holds 1 card. Making it a delivery board would commit it without anyone committing it: move it to a delivery board, or delete it, first.'
			);
			cardIn(I.cols['Shaping'], 'Two', { archivedAt: stamp() });
			await expectRefused(
				() => tree.update(I.board.id, { kind: 'delivery' }),
				409,
				'This ideas board holds 2 cards. Making it a delivery board would commit them without anyone committing them: move them to a delivery board, or delete them, first.'
			);
		});

		it('refuses to make a sub-board an ideas board (ruling p), before it asks whether the board holds cards (L8)', async () => {
			const parent = cardIn(D.cols['To Do'], 'Parent');
			const sub = makeBoard({ owner, parentCardId: parent.id });
			cardIn(sub.cols['To Do'], 'Work on the sub-board');

			await expectRefused(() => tree.update(sub.board.id, { kind: 'ideas' }), 409, SUB_BOARD);
		});
	});
});

describe('putting a board under a card, from the board page (rulings o and p)', () => {
	const put = (boardId: number, body: Record<string, unknown>) => api('PUT', `/api/boards/${boardId}`, { user: owner, body });

	it('refuses an ideas board under any card, and a kind of ideas sent with a parent', async () => {
		const committed = cardIn(D.cols['To Do'], 'Committed work');
		const empty = deliveryBoard('Empty', DELIVERY, true);
		const ideas = deliveryBoard('Empty ideas', IDEAS);
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideas.board.id);

		await expectRefused(() => put(ideas.board.id, { parentCardId: committed.id }), 409, SUB_BOARD);
		await expectRefused(() => put(empty.board.id, { kind: 'ideas', parentCardId: committed.id }), 409, SUB_BOARD);
	});

	it('refuses any board under an option, in the Options column or on an ideas board, and puts one under committed work as before', async () => {
		const empty = deliveryBoard('Empty', DELIVERY, true);
		const option = cardIn(D.cols['Options'], 'An option');
		const idea = cardIn(I.cols['New Ideas'], 'An idea');

		await expectRefused(() => put(empty.board.id, { parentCardId: option.id }), 409, UNDER_OPTION);
		await expectRefused(() => put(empty.board.id, { parentCardId: idea.id }), 409, UNDER_IDEA);
		const committed = cardIn(D.cols['To Do'], 'Committed work');
		const res = await put(empty.board.id, { parentCardId: committed.id });
		expect(res.status).toBe(200);
		expect(res.body.parentCardId).toBe(committed.id);
	});
});

describe('a new card made in an upstream column with a sub-board', () => {
	it('is refused whole, as the sub-board under an option is (ruling o)', async () => {
		await expectRefused(
			() => api('POST', '/api/cards', { user: owner, body: { columnId: D.cols['Options'].id, title: 'An option', subBoards: [{ name: 'Its plan' }] } }),
			409,
			`subBoards[0]: ${UNDER_OPTION}`
		);
	});
});

describe.each(TREES)('converting a board to an ideas board, cards and all, through $name (ruling i)', (tree) => {
	it('makes every card on it an option, removes its empty To Do, On Hold and Complete columns and the Options role, and writes one entry naming them and nothing else (L1, L4)', async () => {
		makeSmtp();
		makeWebhook(D.board);
		const member = makeUser();
		addBoardMember(D.board, member, 'editor');
		const live = [cardIn(D.cols['In Progress'], 'Doing', { createdBy: member.id }), cardIn(D.cols['In Progress'], 'Also doing')];
		const archived = cardIn(D.cols['In Progress'], 'Stopped long ago', { archivedAt: stamp() });
		const option = cardIn(D.cols['Options'], 'An option');
		expect(commitmentOf(live[0])).toEqual({ committedAt: OLD, committedBy: member.id });
		snapshotsOf(D);

		const res = await tree.convert(D.board.id, { kind: 'ideas', cards: 4 });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: D.board.id, kind: 'ideas' });
		expect(res.body.columns.map((c: { title: string; role: string | null }) => [c.title, c.role])).toEqual([
			// The Options column, holding an option, kept with its role taken off (card 2527, O7).
			['Options', null],
			['In Progress', null]
		]);
		expect(boardAsStored(D.board.id).kind).toBe('ideas');
		for (const card of [...live, archived, option]) expect(commitmentOf(card)).toEqual({ committedAt: null, committedBy: null });
		// The removed columns' snapshots went with them; the others' are kept.
		expect(snapshotCount(D.board.id)).toBe(2);

		const entries = sqlite.prepare('SELECT action, detail, source, card_id AS cardId, user_id AS userId FROM activity_log WHERE board_id = ?').all(D.board.id);
		expect(entries).toEqual([
			{
				action: `${tree.prefix}board_converted_to_ideas`,
				detail: `"Delivery": 4 cards became ideas; its columns To Do, On Hold, Complete were removed (board ${D.board.id})`,
				source: tree.prefix ? 'api' : 'ui',
				cardId: null,
				userId: owner.id
			}
		]);
		// No webhook, no mail, and the board told once.
		expect(sent.webhooks).toEqual([]);
		expect(sent.emails).toEqual([]);
		expect(sent.events.map((e) => `${e.event} (${e.data.type})`)).toEqual(['update (board)']);
		expect(sent.duringTransaction).toEqual([]);
		nothingToRepair();
	});

	it('converts a board of one card, and says "1 card became an idea"', async () => {
		const board = deliveryBoard('Small', ['Backlog']);
		cardIn(board.cols['Backlog'], 'Only one');

		expect((await tree.convert(board.board.id, { kind: 'ideas', cards: 1 })).status).toBe(200);
		expect(sqlite.prepare('SELECT detail FROM activity_log').all()).toEqual([{ detail: `"Small": 1 card became an idea (board ${board.board.id})` }]);
	});

	it('refuses a count that no longer matches, so a card added since is not made an option unseen', async () => {
		cardIn(D.cols['In Progress'], 'One');
		cardIn(D.cols['In Progress'], 'Two', { archivedAt: stamp() });

		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas', cards: 1 }), 409, 'The board now holds 2 cards; look again.');
	});

	it('refuses while a To Do or On Hold column holds a card, live or archived, naming it: it is renamed first (L1)', async () => {
		cardIn(D.cols['On Hold'], 'Parked', { archivedAt: stamp() });
		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas', cards: 1 }), 409, '"On Hold" holds 1 card, and an ideas board has no On Hold column: rename it first.');
		cardIn(D.cols['To Do'], 'Waiting');
		cardIn(D.cols['To Do'], 'Waiting too');
		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas', cards: 3 }), 409, '"To Do" holds 2 cards, and an ideas board has no To Do column: rename it first.');

		// Renamed, they stay, with their cards, and only the empty Complete
		// column goes, with the empty Options column, named first in the board's
		// order (card 2527, O7).
		sqlite.prepare("UPDATE columns SET title = 'Next up' WHERE id = ?").run(D.cols['To Do'].id);
		sqlite.prepare("UPDATE columns SET title = 'Paused' WHERE id = ?").run(D.cols['On Hold'].id);
		const res = await tree.convert(D.board.id, { kind: 'ideas', cards: 3 });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(boardAsStored(D.board.id).columns.map((c) => c.title)).toEqual(['Next up', 'Paused', 'In Progress']);
		expect((sqlite.prepare('SELECT detail FROM activity_log').get() as { detail: string }).detail).toBe(
			`"Delivery": 3 cards became ideas; its columns Options, Complete were removed (board ${D.board.id})`
		);
	});

	it('gives a board with no card at all the ideas board’s columns, as the empty switch does: one whose only column is an empty Complete is not left with none (L1)', async () => {
		const done = deliveryBoard('Done only', ['Complete']);
		snapshotsOf(done);

		const res = await tree.convert(done.board.id, { kind: 'ideas', cards: 0 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.columns.map((c: { title: string }) => c.title)).toEqual(IDEAS);
		expect(boardAsStored(done.board.id)).toEqual({ kind: 'ideas', columns: IDEAS.map((title, position) => ({ title, position, role: null })) });
		expect(snapshotCount(done.board.id)).toBe(0);
		expect(sqlite.prepare('SELECT detail FROM activity_log WHERE board_id = ?').all(done.board.id)).toEqual([
			{ detail: `"Done only": 0 cards became ideas; its column Complete was replaced with New Ideas, Shaping, Ready for Replenishment (board ${done.board.id})` }
		]);
		nothingToRepair();
	});

	it('is the owner’s or an administrator’s, not an editor’s', async () => {
		const admin = makeUser({ role: 'admin' });

		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas', cards: 0 }, editor), 403, "Only the board's owner or an administrator can make it an ideas board");
		expect((await tree.convert(D.board.id, { kind: 'ideas', cards: 0 }, admin)).status).toBe(200);
	});

	it('reads kind, which must be "ideas", and cards, a whole number', async () => {
		await expectRefused(() => tree.convert(D.board.id, { kind: 'delivery', cards: 0 }), 400, 'kind must be "ideas", not "delivery"');
		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas' }), 400, 'cards is required');
		await expectRefused(() => tree.convert(D.board.id, { cards: 0 }), 400, 'kind is required');
		await expectRefused(() => tree.convert(D.board.id, { kind: 'ideas', cards: 1.5 }), 400, 'cards must be a whole number');
	});

	it('refuses, in order: an ideas board, a card with a sub-board, live or archived (L7), a sub-board, a card in a Complete column, live or archived', async () => {
		const parent = cardIn(D.cols['To Do'], 'Parent');
		const board = makeBoard({ owner, name: 'Nested', parentCardId: parent.id, columns: ['Backlog', 'Complete'] });
		const done = cardIn(board.cols['Complete'], 'Done work', { completedAt: OLD });
		const sub = makeBoard({ owner, parentCardId: done.id });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(board.board.id);
		const convert = () => tree.convert(board.board.id, { kind: 'ideas', cards: 1 });

		await expectRefused(convert, 409, 'This board is already an ideas board.');
		sqlite.prepare("UPDATE boards SET kind = 'delivery' WHERE id = ?").run(board.board.id);
		await expectRefused(
			convert,
			409,
			'Card "Done work" has a sub-board, and a card with sub-boards is never an option: move it to another board, or move or delete its sub-board, first.'
		);
		sqlite.prepare('UPDATE cards SET archived_at = ? WHERE id = ?').run(stamp(), done.id);
		await expectRefused(
			convert,
			409,
			'Archived card "Done work" has a sub-board, and a card with sub-boards is never an option: restore it and move it to another board, or move or delete its sub-board, first.'
		);
		sqlite.prepare('DELETE FROM boards WHERE id = ?').run(sub.board.id);
		await expectRefused(convert, 409, SUB_BOARD);
		sqlite.prepare('UPDATE boards SET parent_card_id = NULL WHERE id = ?').run(board.board.id);
		const inComplete = '"Complete" holds 1 card, and an ideas board has no Complete column: move it to a delivery board, or delete it, first.';
		await expectRefused(convert, 409, inComplete);
		sqlite.prepare('UPDATE cards SET archived_at = NULL WHERE id = ?').run(done.id);
		await expectRefused(convert, 409, inComplete);
		sqlite.prepare('DELETE FROM cards WHERE id = ?').run(done.id);
		// Now empty, it is switched as an empty board is (L1).
		expect((await tree.convert(board.board.id, { kind: 'ideas', cards: 0 })).status).toBe(200);
		expect(boardAsStored(board.board.id)).toEqual({ kind: 'ideas', columns: IDEAS.map((title, position) => ({ title, position, role: null })) });
	});
});

describe.each([
	['the board page’s routes', (boardId: number) => `/api/boards/${boardId}`, '/api/columns', (columnId: number) => `/api/columns/${columnId}`],
	['the documented routes', (boardId: number) => `/api/v1/boards/${boardId}`, null, (columnId: number) => `/api/v1/columns/${columnId}`]
] as const)('an ideas board’s columns, through %s', (_name, _board, pageCreate, columnPath) => {
	const create = (boardId: number, title: string) =>
		pageCreate
			? api('POST', pageCreate, { user: owner, body: { boardId, title } })
			: api('POST', `/api/v1/boards/${boardId}/columns`, { user: owner, body: { title } });

	it('refuses a To Do, On Hold or Complete column on an ideas board, made or renamed so (L1), and takes a WIP limit (M22-13)', async () => {
		await expectRefused(() => create(I.board.id, 'Done'), 409, noColumn('Complete', 'Done'));
		await expectRefused(() => create(I.board.id, 'To Do'), 409, noColumn('To Do', 'To Do'));
		await expectRefused(() => create(I.board.id, 'Blocked'), 409, noColumn('On Hold', 'Blocked'));
		await expectRefused(() => api('PUT', columnPath(I.cols['Shaping'].id), { user: owner, body: { title: 'Complete' } }), 409, noColumn('Complete', 'Complete'));
		await expectRefused(() => api('PUT', columnPath(I.cols['Shaping'].id), { user: owner, body: { title: 'todo' } }), 409, noColumn('To Do', 'todo'));
		await expectRefused(() => api('PUT', columnPath(I.cols['Shaping'].id), { user: owner, body: { title: 'Waiting' } }), 409, noColumn('On Hold', 'Waiting'));
		const limited = await api('PUT', columnPath(I.cols['Ready for Replenishment'].id), { user: owner, body: { wipLimit: 3 } });
		expect(limited.status).toBe(200);
		expect(limited.body.wipLimit).toBe(3);
		expect((await api('PUT', columnPath(I.cols['Shaping'].id), { user: owner, body: { title: 'Sorting' } })).status).toBe(200);
	});

	it('makes and renames To Do, On Hold and Complete columns on a delivery board as before', async () => {
		expect((await create(D.board.id, 'Done')).status).toBe(201);
		expect((await create(D.board.id, 'Blocked')).status).toBe(201);
		expect((await api('PUT', columnPath(D.cols['In Progress'].id), { user: owner, body: { title: 'Complete' } })).status).toBe(200);
		expect((await api('PUT', columnPath(D.cols['On Hold'].id), { user: owner, body: { title: 'Todo' } })).status).toBe(200);
	});

	it('refuses to delete a column of an ideas board while it holds live ideas, as the Options column (L2), and deletes it with archived ones alone', async () => {
		const path = columnPath(I.cols['Shaping'].id);
		cardIn(I.cols['Shaping'], 'One');
		await expectRefused(() => api('DELETE', path, { user: owner }), 409, 'This column of an ideas board still holds 1 idea: move it out, or archive it to discard it, first.');
		cardIn(I.cols['Shaping'], 'Two');
		cardIn(I.cols['Shaping'], 'Archived', { archivedAt: stamp() });
		await expectRefused(() => api('DELETE', path, { user: owner }), 409, 'This column of an ideas board still holds 2 ideas: move them out, or archive them to discard them, first.');

		sqlite.prepare('UPDATE cards SET archived_at = ? WHERE column_id = ?').run(stamp(), I.cols['Shaping'].id);
		expect((await api('DELETE', path, { user: owner })).status).toBe(200);
		// A delivery board's ordinary column goes with its cards, as before (decision M22-9).
		cardIn(D.cols['In Progress'], 'Work');
		expect((await api('DELETE', columnPath(D.cols['In Progress'].id), { user: owner })).status).toBe(200);
	});
});

describe.each(TREES)('sending an option to another delivery board, through $name (rulings b and l)', (tree) => {
	it('to its Options column: still an option, keeping its age, recorded as card_sent where it left and card_moved_in where it arrived, at one moment', async () => {
		makeWebhook(I.board);
		makeWebhook(D.board);
		const idea = cardIn(I.cols['Ready for Replenishment'], 'An idea');

		const res = await tree.send(idea.id, { boardId: D.board.id, to: 'options' });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: idea.id, columnId: D.cols['Options'].id, columnTitle: 'Options', boardId: D.board.id, leftMilestone: null });
		expect(commitmentOf(idea)).toEqual({ committedAt: null, committedBy: null });
		const entries = entriesOf(idea);
		expect(entries.map((e) => [e.action, e.boardId, e.detail])).toEqual([
			[`${tree.prefix}card_sent`, I.board.id, `"An idea" sent to another board's Options (Ready for Replenishment → Options)`],
			[`${tree.prefix}card_moved_in`, D.board.id, '"An idea" moved from another board (Ready for Replenishment → Options)']
		]);
		expect(entries[1].at).toBe(entries[0].at);
		expect(sent.webhooks.map((w) => [w.body.boardId, w.event, w.body.data.action])).toEqual([
			[I.board.id, 'card.moved', 'card_sent'],
			[D.board.id, 'card.moved', 'card_moved_in']
		]);
		// Its age is its own, from its creation (decision M22-20).
		const onD = readBoardContents(owner, D.board.id).columns.flatMap((c) => c.cards).find((c) => c.id === idea.id) as Record<string, unknown>;
		expect(onD.optionSince).toBe(OLD);
		nothingToRepair();
	});

	it('to its To Do: committed on arrival, now and by the sender, with card_committed on the board it joined', async () => {
		makeWebhook(I.board);
		makeWebhook(D.board);
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		const before = stamp();

		const res = await tree.send(idea.id, { boardId: D.board.id, to: 'todo' });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ columnId: D.cols['To Do'].id, columnTitle: 'To Do', boardId: D.board.id });
		if (!tree.prefix) expect(res.body.committed).toBe(true);
		const { committedAt, committedBy } = commitmentOf(idea);
		expect(committedBy).toBe(editor.id);
		expect(committedAt! >= before).toBe(true);
		const entries = entriesOf(idea);
		expect(entries.map((e) => [e.action, e.boardId, e.detail])).toEqual([
			[`${tree.prefix}card_sent`, I.board.id, `"An idea" sent to another board's To Do (Shaping → To Do)`],
			[`${tree.prefix}card_moved_in`, D.board.id, '"An idea" moved from another board (Shaping → To Do)'],
			[`${tree.prefix}card_committed`, D.board.id, `"An idea": Shaping → To Do (column ${D.cols['To Do'].id}, from column ${I.cols['Shaping'].id})`]
		]);
		expect(new Set(entries.map((e) => e.at)).size).toBe(1);
		expect(sent.webhooks.map((w) => [w.body.boardId, w.event, w.body.data.action])).toEqual([
			[I.board.id, 'card.moved', 'card_sent'],
			[D.board.id, 'card.moved', 'card_moved_in'],
			[D.board.id, 'card.committed', 'card_committed']
		]);
		nothingToRepair();
	});

	it('from a delivery board’s Options column too, to another delivery board (ruling l)', async () => {
		const other = deliveryBoard('Other', ['To Do', 'Complete'], true);
		const option = cardIn(D.cols['Options'], 'An option');

		const res = await tree.send(option.id, { boardId: other.board.id, to: 'options' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.columnId).toBe(other.cols['Options'].id);
		expect(entriesOf(option).map((e) => [e.action, e.boardId])).toEqual([
			[`${tree.prefix}card_sent`, D.board.id],
			[`${tree.prefix}card_moved_in`, other.board.id]
		]);
		nothingToRepair();
	});

	it('refuses committed work, which is moved, not sent, 400', async () => {
		const other = deliveryBoard('Other', ['To Do'], true);
		const committed = cardIn(D.cols['To Do'], 'Committed work');

		await expectRefused(() => tree.send(committed.id, { boardId: other.board.id, to: 'options' }), 400, 'A committed card is moved, not sent');
	});

	it('refuses an ideas board, and the card’s own board, as where it goes, 400', async () => {
		const option = cardIn(D.cols['Options'], 'An option');

		await expectRefused(
			() => tree.send(option.id, { boardId: I.board.id, to: 'options' }),
			400,
			'"Ideas board" is an ideas board: a card is sent to a delivery board, and moved onto an ideas board'
		);
		await expectRefused(() => tree.send(option.id, { boardId: D.board.id, to: 'todo' }), 400, 'The card is already on "Delivery": move it within the board instead');
	});

	it('reads boardId, to and position, 400', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		await expectRefused(() => tree.send(idea.id, {}), 400, 'boardId is required');
		await expectRefused(() => tree.send(idea.id, { boardId: 'D' }), 400, 'boardId must be an id');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id }), 400, 'to is required');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'backlog' }), 400, 'to must be "options" or "todo", not "backlog"');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: null }), 400, 'to must be "options" or "todo", not null');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'todo', position: 'top' }), 400, 'position must be a number');
	});

	it('looks for the card and the board it goes to, and asks edit access to each (404, then 403)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		const viewer = makeUser();
		addBoardMember(I.board, viewer, 'viewer');
		const halfway = makeUser();
		addBoardMember(I.board, halfway, 'editor');
		addBoardMember(D.board, halfway, 'viewer');

		await expectRefused(() => tree.send(999_999, { boardId: D.board.id, to: 'todo' }), 404, 'Card not found');
		await expectRefused(() => tree.send(idea.id, { boardId: 999_999, to: 'todo' }), 404, 'Board not found');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'todo' }, viewer), 403, 'No edit access to this board');
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'todo' }, halfway), 403, 'No edit access to this board');
	});

	it('refuses an archived option, to either column, 409 (ruling n)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'Archived idea', { archivedAt: stamp() });
		const message = 'Card "Archived idea" is archived: restore it before moving it out of or back into Options';

		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'options' }), 409, message);
		await expectRefused(() => tree.send(idea.id, { boardId: D.board.id, to: 'todo' }), 409, message);
	});

	it('refuses a board with no Options column, and one with no column to commit into, 409', async () => {
		const plain = deliveryBoard('Plain', ['To Do', 'Done']);
		const parked = deliveryBoard('Parked', ['On Hold', 'Complete'], true);
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		await expectRefused(() => tree.send(idea.id, { boardId: plain.board.id, to: 'options' }), 409, '"Plain" has no Options column');
		await expectRefused(() => tree.send(idea.id, { boardId: parked.board.id, to: 'todo' }), 409, '"Parked" has no column to commit into: add a To Do column');
	});

	it('to To Do takes the first column titled To Do, else the first committed one that is neither Complete nor On Hold: never On Hold', async () => {
		const titled = deliveryBoard('Titled', ['On Hold', 'Backlog', 'To Do', 'Complete'], true);
		const untitled = deliveryBoard('Untitled', ['On Hold', 'Complete', 'Backlog', 'In Progress']);

		const one = await tree.send(cardIn(I.cols['Shaping'], 'One').id, { boardId: titled.board.id, to: 'todo' });
		const two = await tree.send(cardIn(I.cols['Shaping'], 'Two').id, { boardId: untitled.board.id, to: 'todo' });

		expect(one.body.columnId).toBe(titled.cols['To Do'].id);
		expect(two.body.columnId).toBe(untitled.cols['Backlog'].id);
	});

	it('sheds the board’s labels, a category of the board and its milestone, as any move to another board', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		const label = makeLabel(I.board, 'Shaped');
		db.insert(cardLabels).values({ cardId: idea.id, labelId: label.id }).run();
		const category = db.insert(categories).values({ boardId: I.board.id, name: 'Theme' }).returning().get();
		db.update(cards).set({ categoryId: category.id }).where(eq(cards.id, idea.id)).run();
		const goal = makeMilestone({ board: I.board, name: 'Spring ideas', createdBy: owner, cards: [idea] });

		const res = await tree.send(idea.id, { boardId: D.board.id, to: 'options' });

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ categoryId: null, milestoneId: null, leftMilestone: { id: goal.id, name: 'Spring ideas' } });
		expect(db.select().from(cardLabels).where(eq(cardLabels.cardId, idea.id)).all()).toEqual([]);
		expect(entriesOf(idea)[0].detail).toBe(`"An idea" sent to another board's Options (Shaping → Options) and out of milestone "Spring ideas"`);
		// The goal's own entry says it was sent (the S5a review's L7).
		expect(entriesOf(idea).find((e) => e.action.endsWith('milestone_card_removed'))!.detail).toBe('Removed "An idea" from milestone "Spring ideas" (sent to another board)');
	});

	it('refuses an idea with a sub-board, made before that was refused, going into another board’s Options column, and takes it to To Do (L6)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'Planned idea');
		makeBoard({ owner, parentCardId: idea.id });

		await expectRefused(
			() => tree.send(idea.id, { boardId: D.board.id, to: 'options' }),
			409,
			'Card "Planned idea" has a sub-board, so it cannot go into the Options column: a card with sub-boards is committed work. Keep it in a committed column, or archive it if it is no longer wanted.'
		);
		expect((await tree.send(idea.id, { boardId: D.board.id, to: 'todo' })).status).toBe(200);
		nothingToRepair();
	});

	it('is read by the board history as the departure it is (M22-19)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		await tree.send(idea.id, { boardId: D.board.id, to: 'options' });

		expect(getCardBoardHistory(idea.id).map((span) => [span.boardId, span.current])).toEqual([
			[I.board.id, false],
			[D.board.id, true]
		]);
	});
});

describe('a Send, counted and aged', () => {
	const send = (cardId: number, boardId: number, to: 'options' | 'todo') => api('POST', `/api/v1/cards/${cardId}/send`, { user: editor, body: { boardId, to } });

	it('stores every entry of the Send at the move’s one moment, not the database’s clock, so the pair never splits across a second', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await send(idea.id, D.board.id, 'todo')).status).toBe(200);

		expect(entriesOf(idea).map((e) => [e.action, e.at])).toEqual([
			['api:card_sent', '2026-06-01 10:00:00'],
			['api:card_moved_in', '2026-06-01 10:00:00'],
			['api:card_committed', '2026-06-01 10:00:00']
		]);
	});

	it('pairs each card_sent with its card_moved_in: "sent on" counts a Send whose board is out of scope, and not one into a board in scope (ruling b)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		await send(idea.id, D.board.id, 'options');
		const today = stamp().slice(0, 10);

		expect(upstreamFigures([I.board.id], today, today).sentOn).toBe(1);
		expect(upstreamFigures([I.board.id, D.board.id], today, today).sentOn).toBe(0);
		expect(upstreamFigures(null, today, today).sentOn).toBe(0);
	});

	it('keeps the option’s age, even in an Options column converted after it was made, where a card there already is an option from the conversion (M22-20)', async () => {
		const there = cardIn(D.cols['Options'], 'Already there');
		const entry = sqlite.prepare('INSERT INTO activity_log (board_id, action, detail, created_at) VALUES (?, ?, ?, ?)');
		entry.run(D.board.id, 'column_converted_to_options', `"Ideas": 1 card became an option (column ${D.cols['Options'].id})`, '2026-09-01 08:00:00');
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await send(idea.id, D.board.id, 'options')).status).toBe(200);

		const since = (id: number) => (readBoardContents(owner, D.board.id).columns.flatMap((c) => c.cards).find((c) => c.id === id) as Record<string, unknown>).optionSince;
		expect(since(idea.id)).toBe(OLD);
		expect(since(there.id)).toBe('2026-09-01 08:00:00');
		// The figures by the same rule: the oldest option is the sent one, from its creation.
		const now = Date.parse('2026-10-01T09:00:00Z');
		expect(upstreamFigures([D.board.id], '2026-10-01', '2026-10-01', now).oldestOptionDays).toBe(Math.floor((now - Date.parse('2026-01-05T09:00:00Z')) / 86_400_000));
	});

	it('ages an ideas board’s options from its conversion, in the board, the figures and the time in options (board_converted_to_ideas)', async () => {
		const board = deliveryBoard('Converted', ['Backlog', 'Doing']);
		const old = cardIn(board.cols['Backlog'], 'Old work');
		const res = await api('POST', `/api/boards/${board.board.id}/convert`, { user: owner, body: { kind: 'ideas', cards: 1 } });
		expect(res.status).toBe(200);
		sqlite.prepare("UPDATE activity_log SET created_at = '2026-09-01 08:00:00' WHERE action = 'board_converted_to_ideas'").run();
		const fresh = cardIn(board.cols['Doing'], 'Fresh idea', { createdAt: '2026-09-15 08:00:00' });

		const cardsThere = readBoardContents(owner, board.board.id).columns.flatMap((c) => c.cards) as Record<string, unknown>[];
		expect(cardsThere.find((c) => c.id === old.id)!.optionSince).toBe('2026-09-01 08:00:00');
		expect(cardsThere.find((c) => c.id === fresh.id)!.optionSince).toBe('2026-09-15 08:00:00');
		const now = Date.parse('2026-10-01T08:00:00Z');
		expect(upstreamFigures([board.board.id], '2026-10-01', '2026-10-01', now)).toMatchObject({ options: 2, oldestOptionDays: 30 });

		expect((await send(old.id, D.board.id, 'todo')).status).toBe(200);
		const today = stamp().slice(0, 10);
		expect(timeInOptions([D.board.id], today, today).map((t) => [t.cardId, t.optionSince])).toEqual([[old.id, '2026-09-01 08:00:00']]);
	});

	it('pairs a Send by its stamp: one sent out of scope and moved into scope later is still sent on (L8)', async () => {
		const later = deliveryBoard('Later', ['To Do'], true);
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
		expect((await send(idea.id, D.board.id, 'options')).status).toBe(200);
		vi.setSystemTime(new Date('2026-06-01T10:05:00Z'));
		expect((await api('PUT', `/api/v1/cards/${idea.id}/move`, { user: editor, body: { columnId: later.cols['Options'].id } })).status).toBe(200);

		// The Send from the ideas board went out of scope (D); the later move into scope (Later) is not its pair.
		expect(upstreamFigures([I.board.id, later.board.id], '2026-06-01', '2026-06-01').sentOn).toBe(1);
		// With every board in scope, each Send pairs with its own arrival, and the card stayed in scope.
		expect(upstreamFigures([I.board.id, D.board.id, later.board.id], '2026-06-01', '2026-06-01').sentOn).toBe(0);
	});
});

describe('an option moved to another board, not sent, is sent on all the same (the S5a review’s L5)', () => {
	it('by the v1 move: card_sent on the board it left, naming a column that is neither Options nor To Do, at the move’s one moment', async () => {
		makeWebhook(I.board);
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		const res = await api('PUT', `/api/v1/cards/${idea.id}/move`, { user: editor, body: { columnId: D.cols['In Progress'].id } });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(entriesOf(idea).map((e) => [e.action, e.boardId, e.detail, e.at])).toEqual([
			['api:card_sent', I.board.id, `"An idea" sent to another board's "In Progress" column (Shaping → In Progress)`, '2026-06-01 10:00:00'],
			['api:card_moved_in', D.board.id, '"An idea" moved from another board (Shaping → In Progress)', '2026-06-01 10:00:00'],
			['api:card_committed', D.board.id, `"An idea": Shaping → In Progress (column ${D.cols['In Progress'].id}, from column ${I.cols['Shaping'].id})`, '2026-06-01 10:00:00']
		]);
		expect(sent.webhooks.map((w) => [w.event, w.body.data.action])).toEqual([['card.moved', 'card_sent']]);
		nothingToRepair();
	});

	it('by the card window’s and All Tasks’ move (PUT /api/cards/:id with a column of another board): to Options, and to To Do', async () => {
		const one = cardIn(I.cols['Shaping'], 'One');
		const two = cardIn(D.cols['Options'], 'Two');
		const other = deliveryBoard('Other', ['To Do'], true);

		expect((await api('PUT', `/api/cards/${one.id}`, { user: editor, body: { boardId: D.board.id, columnId: D.cols['Options'].id } })).status).toBe(200);
		expect((await api('PUT', `/api/cards/${two.id}`, { user: editor, body: { columnId: other.cols['To Do'].id } })).status).toBe(200);

		expect(entriesOf(one).map((e) => [e.action, e.detail])[0]).toEqual(['card_sent', `"One" sent to another board's Options (Shaping → Options)`]);
		expect(entriesOf(two).map((e) => [e.action, e.detail])[0]).toEqual(['card_sent', `"Two" sent to another board's To Do (Options → To Do)`]);
		nothingToRepair();
	});

	it('so the discard rate counts every way an option leaves: one moved on and one discarded is a half', async () => {
		const moved = cardIn(I.cols['Shaping'], 'Moved on');
		const dropped = cardIn(I.cols['Shaping'], 'Dropped');

		expect((await api('PUT', `/api/v1/cards/${moved.id}/move`, { user: editor, body: { columnId: D.cols['To Do'].id } })).status).toBe(200);
		expect((await api('DELETE', `/api/v1/cards/${dropped.id}`, { user: editor })).status).toBe(200);

		const today = stamp().slice(0, 10);
		expect(upstreamFigures([I.board.id], today, today)).toMatchObject({ sentOn: 1, discarded: 1, discardRate: 0.5 });
	});

	it('keeps the option’s age, moved from another board’s Options into an Options column converted since it was made (M22-20)', async () => {
		const other = deliveryBoard('Other', ['To Do'], true);
		const option = cardIn(other.cols['Options'], 'An option');
		sqlite
			.prepare('INSERT INTO activity_log (board_id, action, detail, created_at) VALUES (?, ?, ?, ?)')
			.run(D.board.id, 'column_converted_to_options', `"Ideas": 0 cards became options (column ${D.cols['Options'].id})`, '2026-09-01 08:00:00');

		expect((await api('PUT', `/api/v1/cards/${option.id}/move`, { user: editor, body: { columnId: D.cols['Options'].id } })).status).toBe(200);

		const onD = readBoardContents(owner, D.board.id).columns.flatMap((c) => c.cards).find((c) => c.id === option.id) as Record<string, unknown>;
		expect(onD.optionSince).toBe(OLD);
	});

	it('a move between two columns of one ideas board is no Send, and writes card_moved as before', async () => {
		const idea = cardIn(I.cols['New Ideas'], 'An idea');

		expect((await api('PUT', `/api/v1/cards/${idea.id}/move`, { user: editor, body: { columnId: I.cols['Shaping'].id } })).status).toBe(200);
		expect(entriesOf(idea).map((e) => e.action)).toEqual(['api:card_moved']);
	});
});

describe('All To Do and All Tasks’ To Do bucket never take an upstream column (L1’s second guard)', () => {
	it('leaves out an ideas board’s column titled To Do, from before the rule, and puts its cards in the Options bucket', async () => {
		sqlite.prepare("UPDATE columns SET title = 'To Do' WHERE id = ?").run(I.cols['New Ideas'].id);
		const idea = cardIn(I.cols['New Ideas'], 'Now an idea');
		const work = cardIn(D.cols['To Do'], 'Waiting work');

		const todo = await pageLoad('/todo', { user: owner });
		const all = await pageLoad('/all', { user: owner });
		if (todo.type !== 'data' || all.type !== 'data') throw new Error('a page was refused');

		expect(todo.data.cards.map((c: { id: number }) => c.id)).toEqual([work.id]);
		expect(Object.fromEntries(todo.data.boards.map((b: { id: number; hasTodo: boolean }) => [b.id, b.hasTodo]))).toEqual({ [D.board.id]: true, [I.board.id]: false });
		const bucketOf = (id: number) => all.data.buckets.flatMap((b: { cards: { id: number; bucket: string }[] }) => b.cards).find((c: { id: number }) => c.id === id)?.bucket;
		expect(bucketOf(idea.id)).toBe('Options');
		expect(bucketOf(work.id)).toBe('To Do');
	});
});

describe('All Tasks and All To Do', () => {
	it('send each board’s kind, for the pages to tell an ideas board (card 2463)', async () => {
		for (const path of ['/all', '/todo']) {
			const res = await pageLoad(path, { user: owner });
			if (res.type !== 'data') throw new Error(`${path} answered ${JSON.stringify(res)}`);
			const kinds = Object.fromEntries(res.data.boards.map((b: { id: number; kind: string }) => [b.id, b.kind]));
			expect(kinds, path).toEqual({ [D.board.id]: 'delivery', [I.board.id]: 'ideas' });
		}
	});
});

describe('boards that are not ideas boards, beside a Send', () => {
	it('a move to another board still writes card_moved_away, and a delivery board still makes its four columns', async () => {
		const other = deliveryBoard('Other', ['To Do', 'Complete']);
		const work = cardIn(D.cols['To Do'], 'Work');

		expect((await api('PUT', `/api/v1/cards/${work.id}/move`, { user: editor, body: { columnId: other.cols['To Do'].id } })).status).toBe(200);
		expect(entriesOf(work).map((e) => [e.action, e.boardId])).toEqual([
			['api:card_moved_away', D.board.id],
			['api:card_moved_in', other.board.id]
		]);
		const made = await api('POST', '/api/boards', { user: owner, body: { name: 'Plain' } });
		expect(boardAsStored(made.body.id).columns.map((c) => c.title)).toEqual(DELIVERY_DEFAULTS);
		nothingToRepair();
	});
});

// ─── Slice S5b: what the screens read, and the words they say first ──────────

describe('the boards the Send window offers, GET /api/cards/:id/send (slice S5b)', () => {
	const targets = async (cardId: number, user: SessionUser = editor) => api('GET', `/api/cards/${cardId}/send`, { user });

	it('lists every delivery board the caller can edit but the card’s own, by name, with its Options column and the column To Do commits into', async () => {
		const plain = deliveryBoard('Archive work', ['Backlog', 'In Progress', 'On Hold', 'Done']);
		const none = deliveryBoard('Bare', ['Done']);
		const watched = makeBoard({ owner, name: 'Only watched', columns: ['To Do'] });
		addBoardMember(watched.board, editor, 'viewer');
		const ideasToo = makeBoard({ owner, name: 'More ideas', columns: IDEAS });
		sqlite.prepare("UPDATE boards SET kind = 'ideas' WHERE id = ?").run(ideasToo.board.id);
		addBoardMember(ideasToo.board, editor, 'editor');
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		const res = await targets(idea.id);

		expect(res.status).toBe(200);
		// Never an ideas board, never its own, never one the caller only views; never On Hold for To Do.
		expect(res.body).toEqual({
			boards: [
				{ id: plain.board.id, name: 'Archive work', emoji: plain.board.emoji, options: false, todo: 'Backlog' },
				{ id: none.board.id, name: 'Bare', emoji: none.board.emoji, options: false, todo: null },
				{ id: D.board.id, name: 'Delivery', emoji: D.board.emoji, options: true, todo: 'To Do' }
			]
		});
		// An option on a delivery board's Options column is offered the other boards, its own left out.
		const option = cardIn(D.cols['Options'], 'An option');
		expect((await targets(option.id)).body.boards.map((b: { id: number }) => b.id)).toEqual([plain.board.id, none.board.id]);
		// Every delivery board for an administrator, who can edit them all.
		const admin = makeUser({ username: 'admin', role: 'admin' });
		expect((await targets(idea.id, admin)).body.boards.map((b: { name: string }) => b.name)).toEqual(['Archive work', 'Bare', 'Delivery', 'Only watched']);
	});

	it('reads edit access as the guard does: a team editor’s board listed, a public one not, a direct viewer’s not whatever a team gives (the S5b review’s P2, P3)', async () => {
		const teamEdited = makeBoard({ owner, name: 'Team edited', columns: ['To Do'] });
		const viaTeam = makeTeam([editor], 'Planners');
		shareBoardWithTeam(teamEdited.board, viaTeam, 'editor');
		makeBoard({ owner, name: 'Public only', isPublic: true, columns: ['To Do'] });
		// A direct member row decides before a team share, as `roleOnBoard` reads it.
		const viewedDirectly = makeBoard({ owner, name: 'Viewed directly', columns: ['To Do'] });
		addBoardMember(viewedDirectly.board, editor, 'viewer');
		shareBoardWithTeam(viewedDirectly.board, viaTeam, 'editor');
		const teamViewed = makeBoard({ owner, name: 'Team viewed', columns: ['To Do'] });
		shareBoardWithTeam(teamViewed.board, makeTeam([editor], 'Readers'), 'viewer');
		const idea = cardIn(I.cols['Shaping'], 'An idea');

		expect((await targets(idea.id)).body.boards.map((b: { name: string }) => b.name)).toEqual(['Delivery', 'Team edited']);
		// An administrator: every delivery board, no ideas board.
		const admin = makeUser({ username: 'chief', role: 'admin' });
		expect((await targets(idea.id, admin)).body.boards.map((b: { name: string }) => b.name)).toEqual(['Delivery', 'Public only', 'Team edited', 'Team viewed', 'Viewed directly']);
	});

	it('reads the database as often with two hundred more boards as with none (P2)', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		const team = makeTeam([editor], 'Many');
		const reads = () => {
			const budget = readBudget(10_000);
			try {
				sendTargetsFor(editor, { cardId: idea.id }, {});
			} finally {
				budget.restore();
			}
			return budget.count;
		};
		const few = reads();
		for (let i = 0; i < 200; i++) {
			const board = makeBoard({ owner, name: `Board ${i}`, columns: ['To Do'] });
			if (i % 2 === 0) addBoardMember(board.board, editor, 'editor');
			else shareBoardWithTeam(board.board, team, 'editor');
		}
		expect(sendTargetsFor(editor, { cardId: idea.id }, {})).toHaveLength(201);
		expect(reads()).toBe(few);
		expect(few).toBeLessThanOrEqual(12);
	});

	it('is refused to a caller who cannot edit the card’s board, and writes nothing', async () => {
		const idea = cardIn(I.cols['Shaping'], 'An idea');
		const watcher = makeUser({ username: 'watcher' });
		addBoardMember(I.board, watcher, 'viewer');
		const before = snapshotDb();
		expect((await targets(idea.id, watcher)).status).toBe(403);
		expect((await targets(999999)).status).toBe(404);
		expectUnchanged(before);
	});
});

describe('the board page’s own words, said before it asks (slice S5b)', () => {
	it('names the columns an ideas board and a delivery board are made with, as the server makes them', async () => {
		const ideas = await api('POST', '/api/boards', { user: owner, body: { name: 'Fresh', kind: 'ideas' } });
		const delivery = await api('POST', '/api/boards', { user: owner, body: { name: 'Plain' } });
		expect(boardAsStored(ideas.body.id).columns.map((c) => c.title)).toEqual([...DEFAULT_COLUMN_TITLES.ideas]);
		expect(boardAsStored(delivery.body.id).columns.map((c) => c.title)).toEqual([...DEFAULT_COLUMN_TITLES.delivery]);
	});

	it('refuses a To Do, On Hold or Complete column holding cards, and a card with a sub-board, in the server’s words', async () => {
		const convert = (board: BoardFixture, cards: number) => api('POST', `/api/boards/${board.board.id}/convert`, { user: owner, body: { kind: 'ideas', cards } });
		const todo = deliveryBoard('Todo held', ['To Do', 'Complete']);
		cardIn(todo.cols['To Do'], 'Waiting');
		expect((await convert(todo, 1)).body.message).toBe(ideasBoardColumnRefusal('To Do', 1, 'todo'));
		const hold = deliveryBoard('Hold held', ['Backlog', 'Parked']);
		cardIn(hold.cols['Parked'], 'One');
		cardIn(hold.cols['Parked'], 'Two');
		expect((await convert(hold, 2)).body.message).toBe(ideasBoardColumnRefusal('Parked', 2, 'hold'));
		const done = deliveryBoard('Done held', ['Backlog', 'Done']);
		cardIn(done.cols['Done'], 'Finished', { completedAt: OLD });
		expect((await convert(done, 1)).body.message).toBe(ideasBoardColumnRefusal('Done', 1, 'complete'));
		// And with two: "move them…, or delete them".
		cardIn(done.cols['Done'], 'Finished too', { completedAt: OLD });
		const two = (await convert(done, 2)).body.message;
		expect(two).toBe(ideasBoardColumnRefusal('Done', 2, 'complete'));
		expect(two).toBe('"Done" holds 2 cards, and an ideas board has no Complete column: move them to a delivery board, or delete them, first.');
		const parent = deliveryBoard('Parent held', ['Backlog']);
		const card = cardIn(parent.cols['Backlog'], 'Has one');
		makeBoard({ owner, parentCardId: card.id });
		expect((await convert(parent, 1)).body.message).toBe(ideasBoardSubBoardRefusal('Has one'));
		// An archived one the page does not see (the S5b review's P4): the server's own words, in its archived form.
		const archivedParent = deliveryBoard('Archived parent', ['Backlog']);
		const gone = cardIn(archivedParent.cols['Backlog'], 'Put away', { archivedAt: OLD });
		makeBoard({ owner, parentCardId: gone.id });
		expect((await convert(archivedParent, 1)).body.message).toBe(
			'Archived card "Put away" has a sub-board, and a card with sub-boards is never an option: restore it and move it to another board, or move or delete its sub-board, first.'
		);
	});

	it('refuses an ideas board holding cards the way back, in the server’s words, singular and plural', async () => {
		cardIn(I.cols['Shaping'], 'One');
		const back = () => api('PUT', `/api/boards/${I.board.id}`, { user: owner, body: { kind: 'delivery' } });
		expect((await back()).body.message).toBe(deliveryBoardRefusal(1));
		cardIn(I.cols['Shaping'], 'Two');
		expect((await back()).body.message).toBe(deliveryBoardRefusal(2));
	});

	it('asks with the counts, the columns that go and the columns that replace them', () => {
		// An empty Options column goes with them, named first, as the server removes it (card 2527, ruling O7).
		expect(ideasBoardWarning('Work', 2, 1, ['Options', 'To Do', 'Backlog', 'Complete'], ['Options', 'To Do', 'Complete'], true)).toBe(
			'Make "Work" an ideas board? The 2 live cards and 1 archived card on it become ideas: options not yet committed to, sent on to a delivery board when chosen, and the commitment recorded on them is cleared. Its empty columns Options, To Do and Complete are removed: an ideas board has no Options, To Do, On Hold or Complete column. This is recorded as one entry in the activity log. It can be made a delivery board again only once it holds no cards.'
		);
		// The Options column kept (it holds a card): the sentence names only what an ideas board has none of among those that go (the S2 review's P4).
		expect(ideasBoardWarning('Work', 2, 0, ['Options', 'To Do', 'Backlog'], ['To Do'])).toBe(
			'Make "Work" an ideas board? The 2 live cards on it become ideas: options not yet committed to, sent on to a delivery board when chosen, and the commitment recorded on them is cleared. Its empty column To Do is removed: an ideas board has no To Do, On Hold or Complete column. This is recorded as one entry in the activity log. It can be made a delivery board again only once it holds no cards.'
		);
		expect(ideasBoardWarning('Work', 1, 0, ['Backlog'], [])).toBe(
			'Make "Work" an ideas board? The 1 live card on it becomes an idea: an option not yet committed to, sent on to a delivery board when chosen, and the commitment recorded on it is cleared. This is recorded as one entry in the activity log. It can be made a delivery board again only once it holds no cards.'
		);
		expect(ideasBoardWarning('Empty', 0, 0, ['To Do', 'On Hold', 'In Progress', 'Complete'], [])).toBe(
			'Make "Empty" an ideas board? It holds no cards, so its columns To Do, On Hold, In Progress and Complete are replaced with New Ideas, Shaping and Ready for Replenishment. Its ideas are sent on to delivery boards when they are chosen. It can be made a delivery board again while it holds no cards.'
		);
		expect(deliveryBoardWarning('Ideas', ['New Ideas', 'Shaping', 'Ready for Replenishment'])).toBe(
			'Make "Ideas" a delivery board? Its columns New Ideas, Shaping and Ready for Replenishment are replaced with Options, To Do, On Hold, In Progress and Complete.'
		);
		expect(cardSentMessage('Idea', 'Ops', 'options')).toBe(`Sent "Idea" to Ops's Options`);
		expect(cardSentMessage('Idea', 'Ops', 'todo')).toBe(`Sent "Idea" to Ops's To Do`);
	});

	it('labels the two entries in words: card_sent and board_converted_to_ideas, from either tree', () => {
		expect(activityLabel('card_sent')).toBe('Sent card to another board');
		expect(activityLabel('api:card_sent')).toBe('Sent card to another board');
		expect(activityLabel('board_converted_to_ideas')).toBe('Converted board to an ideas board');
		expect(activityLabel('api:board_converted_to_ideas')).toBe('Converted board to an ideas board');
	});
});
