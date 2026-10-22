/**
 * Cards in one order everywhere (card 2347).
 *
 * Every reader that lists cards by their place ordered them by `position`
 * alone, but for the internal picker and the v1 listing (card 2295), so cards
 * sharing a position came in whatever order SQLite read them. Within one
 * column that is the order they were made in (ids are rowids, and the column's
 * index holds them in order), so the board page never showed it; across
 * columns it is the column's order, so All Tasks' and All To Do's buckets,
 * which take in a To Do column of every board, and both CSV exports, whose
 * rows run across columns, put a tie by the column it was in. A card made
 * through the API with no `position` is at 0, so a script's cards all tie.
 *
 * Now every such reader orders by `CARD_ORDER`, position and then id, from
 * `$lib/server/card-order`, beside `SUBTASK_ORDER`. The behaviour cases put
 * positions out of id order as well as ties, within a column and across
 * columns and boards; the source check is what holds the tie where SQLite
 * would give id order anyway.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { boards, columns } from '$lib/server/db/schema';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { makeBoard, makeCard, makeUser, resetDb } from './helpers/fixtures';

beforeEach(resetDb);

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8');

describe('every reader that lists cards by their place orders them by position, then id', () => {
	let owner: ReturnType<typeof makeUser>;
	let boardA = 0;

	/**
	 * Board A, made first, so its columns come before board B's; then, in
	 * this order (so in id order): B's To Do card at 0, A's To Do card at 0,
	 * A's In Progress card at 0, A's To Do card at -1, and another A To Do
	 * card at 0.
	 */
	beforeEach(() => {
		owner = makeUser();
		const A = makeBoard({ owner, name: 'A' });
		const B = makeBoard({ owner, name: 'B' });
		boardA = A.board.id;
		makeCard(B.cols['To Do'], { title: 'TIE-B1', position: 0 });
		makeCard(A.cols['To Do'], { title: 'TIE-A2', position: 0 });
		makeCard(A.cols['In Progress'], { title: 'TIE-A3', position: 0 });
		makeCard(A.cols['To Do'], { title: 'FIRST-A4', position: -1 });
		makeCard(A.cols['To Do'], { title: 'TIE-A5', position: 0 });
	});

	const ALL = ['TIE-B1', 'TIE-A2', 'TIE-A3', 'FIRST-A4', 'TIE-A5'];
	const titles = (list: { title: string }[]) => list.map((c) => c.title).filter((t) => ALL.includes(t));
	/** The titles in the order a text names them. */
	const named = (text: string) =>
		ALL.map((t) => [t, text.indexOf(t)] as const)
			.filter(([, at]) => at >= 0)
			.sort((a, b) => a[1] - b[1])
			.map(([t]) => t);

	it('the board page (and GET /api/boards/{id}/contents, its one reader)', async () => {
		const load = await pageLoad(`/board/${boardA}`, { user: owner });
		expect(load.type).toBe('data');
		const data = (load as { data: { columns: { title: string; cards: { title: string }[] }[] } }).data;
		const column = (title: string) => titles(data.columns.find((c) => c.title === title)!.cards);
		expect(column('To Do')).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A5']);
		expect(column('In Progress')).toEqual(['TIE-A3']);
	});

	it('All Tasks: its To Do bucket, which takes in both boards’ To Do columns', async () => {
		const load = await pageLoad('/all', { user: owner });
		expect(load.type).toBe('data');
		const buckets = (load as { data: { buckets: { title: string; cards: { title: string }[] }[] } }).data.buckets;
		expect(titles(buckets.find((b) => b.title === 'To Do')!.cards)).toEqual(['FIRST-A4', 'TIE-B1', 'TIE-A2', 'TIE-A5']);
	});

	it('All To Do: the cards its load hands the page', async () => {
		const load = await pageLoad('/todo', { user: owner });
		expect(load.type).toBe('data');
		expect(titles((load as { data: { cards: { title: string }[] } }).data.cards)).toEqual(['FIRST-A4', 'TIE-B1', 'TIE-A2', 'TIE-A5']);
	});

	it('the internal picker, GET /api/boards/{id}/cards', async () => {
		const res = await api('GET', `/api/boards/${boardA}/cards`, { user: owner });
		expect(res.status).toBe(200);
		expect(titles(res.body.cards)).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A3', 'TIE-A5']);
	});

	it('the v1 listing, GET /api/v1/boards/{boardId}/cards, column by column', async () => {
		const res = await api('GET', `/api/v1/boards/${boardA}/cards`, { user: owner });
		expect(res.status).toBe(200);
		expect(titles(res.body)).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A5', 'TIE-A3']);
	});

	// Card 2368: both exports ordered their rows by the card's position across
	// every column (and the all-boards one across every board), so a board's
	// columns came mixed together. Now board by board in the order the boards
	// were made, column by column in the board's order, then CARD_ORDER.
	it('both CSV exports, board by board, column by column, then by position and id', async () => {
		const board = await api('GET', `/api/boards/${boardA}/export/csv`, { user: owner });
		expect(board.status).toBe(200);
		expect(named(String(board.body))).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A5', 'TIE-A3']);

		const every = await api('GET', '/api/cards/export/csv', { user: owner });
		expect(every.status).toBe(200);
		expect(named(String(every.body))).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A5', 'TIE-A3', 'TIE-B1']);
	});

	it('both CSV exports follow the place of each column, not its id, and the age of each board, not its name (card 2368)', async () => {
		// In Progress moved before To Do on board A, and board A renamed to sort after B.
		db.update(columns).set({ position: -1 }).where(and(eq(columns.boardId, boardA), eq(columns.title, 'In Progress'))).run();
		db.update(boards).set({ name: 'Z' }).where(eq(boards.id, boardA)).run();

		const board = await api('GET', `/api/boards/${boardA}/export/csv`, { user: owner });
		expect(named(String(board.body))).toEqual(['TIE-A3', 'FIRST-A4', 'TIE-A2', 'TIE-A5']);
		const every = await api('GET', '/api/cards/export/csv', { user: owner });
		expect(named(String(every.body))).toEqual(['TIE-A3', 'FIRST-A4', 'TIE-A2', 'TIE-A5', 'TIE-B1']);

		// Two columns at one place: the older column first.
		db.update(columns).set({ position: 0 }).where(and(eq(columns.boardId, boardA), eq(columns.title, 'In Progress'))).run();
		const tied = await api('GET', `/api/boards/${boardA}/export/csv`, { user: owner });
		expect(named(String(tied.body))).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A5', 'TIE-A3']);
	});

	it('each reader orders by CARD_ORDER, and none by position alone', () => {
		const readers: [string, number][] = [
			// The board page's load and GET /api/boards/:id/contents, through their one reader (card 2280).
			['src/lib/server/board-contents.ts', 1],
			// All Tasks and All To Do, through their one reader (card 2240).
			['src/lib/server/cross-board-cards.ts', 1],
			['src/routes/api/boards/[id]/cards/+server.ts', 1],
			['src/routes/api/v1/boards/[boardId]/cards/+server.ts', 1],
			['src/routes/api/boards/[id]/export/csv/+server.ts', 1],
			['src/routes/api/cards/export/csv/+server.ts', 1]
		];
		for (const [file, sites] of readers) {
			const text = source(file);
			expect(text, file).toMatch(/import \{[^}]*\bCARD_ORDER\b[^}]*\} from '(\$lib\/server|\.)\/card-order'/);
			expect(text.split('...CARD_ORDER').length - 1, file).toBe(sites);
			expect(text, file).not.toContain('asc(cards.position)');
		}
		expect(source('src/lib/server/card-order.ts')).toContain('export const CARD_ORDER = [asc(cards.position), asc(cards.id)] as const;');
		// No other file under src orders cards by position in a query of its own.
		const own = (readdirSync(join(process.cwd(), 'src'), { recursive: true }) as string[])
			.map((file) => file.replace(/\\/g, '/'))
			.filter((file) => /\.(ts|svelte)$/.test(file) && file !== 'lib/server/card-order.ts')
			.filter((file) => source(`src/${file}`).includes('asc(cards.position)'));
		expect(own).toEqual([]);
	});
});

// Card 2372: a board's columns were read by position alone, so two at one
// position came in whatever order SQLite read them. SQLite reads them in id
// order (the board's index holds them so), so the behaviour cases are the
// contract and the source check is what holds the tie.
describe('every reader that lists a board’s columns orders them by position, then id (card 2372)', () => {
	let owner: ReturnType<typeof makeUser>;
	let boardId = 0;

	/** Columns made First, Second, Third; Third moved to the front, Second tied with First at 0. */
	beforeEach(() => {
		owner = makeUser();
		const made = makeBoard({ owner, name: 'Cols', columns: ['First', 'Second', 'Third'] });
		boardId = made.board.id;
		db.update(columns).set({ position: -1 }).where(eq(columns.id, made.cols.Third.id)).run();
		db.update(columns).set({ position: 0 }).where(eq(columns.id, made.cols.Second.id)).run();
		makeCard(made.cols.Second, { title: 'IN-SECOND' });
		makeCard(made.cols.First, { title: 'IN-FIRST' });
	});

	const ORDER = ['Third', 'First', 'Second'];
	const titled = (list: { title: string }[]) => list.map((c) => c.title);

	it('the board page (and GET /api/boards/{id}/contents)', async () => {
		const load = await pageLoad(`/board/${boardId}`, { user: owner });
		expect(titled((load as { data: { columns: { title: string }[] } }).data.columns)).toEqual(ORDER);
	});

	it('GET /api/v1/boards/{boardId}, GET /api/v1/boards/{boardId}/columns and the internal picker', async () => {
		const board = await api('GET', `/api/v1/boards/${boardId}`, { user: owner });
		expect(titled(board.body.columns)).toEqual(ORDER);
		const cols = await api('GET', `/api/v1/boards/${boardId}/columns`, { user: owner });
		expect(titled(cols.body)).toEqual(ORDER);
		const picker = await api('GET', `/api/boards/${boardId}/cards`, { user: owner });
		expect(titled(picker.body.columns)).toEqual(ORDER);
	});

	it('the board’s CSV export and the v1 card listing, column by column', async () => {
		const csv = String((await api('GET', `/api/boards/${boardId}/export/csv`, { user: owner })).body);
		expect(csv.indexOf('IN-FIRST')).toBeLessThan(csv.indexOf('IN-SECOND'));
		const listed = await api('GET', `/api/v1/boards/${boardId}/cards`, { user: owner });
		expect(titled(listed.body)).toEqual(['IN-FIRST', 'IN-SECOND']);
	});

	// The card 2372 review: the graph's board expansion read the columns with no order at all, so it
	// gave them in id order, not the board's (shown failing on the old code: First, Second, Third).
	it('the graph’s board expansion, GET /api/graph?boardId=', async () => {
		const res = await api('GET', `/api/graph?boardId=${boardId}`, { user: owner });
		expect(res.status).toBe(200);
		const shown = (res.body.nodes as { type: string; label: string }[]).filter((node) => node.type === 'column').map((node) => node.label);
		expect(shown).toEqual(ORDER);
	});

	it('POST /api/v1/boards answers the columns it made in their order', async () => {
		const res = await api('POST', '/api/v1/boards', { user: owner, body: { name: 'New' } });
		expect(res.status).toBe(201);
		const positions = (res.body.columns as { position: number }[]).map((c) => c.position);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it('each reader orders by COLUMN_ORDER, and no file under src orders columns by position alone', () => {
		expect(source('src/lib/server/card-order.ts')).toContain('export const COLUMN_ORDER = [asc(columns.position), asc(columns.id)] as const;');
		for (const file of [
			'src/lib/server/board-contents.ts',
			'src/lib/server/cross-board-cards.ts',
			'src/lib/server/snapshots.ts',
			'src/routes/api/boards/[id]/cards/+server.ts',
			'src/routes/api/boards/[id]/cfd/+server.ts',
			'src/routes/api/boards/[id]/export/csv/+server.ts',
			'src/routes/api/cards/export/csv/+server.ts',
			// The graph's board expansion (the card 2372 review: it had no order at all).
			'src/routes/api/graph/+server.ts',
			'src/routes/api/v1/boards/+server.ts',
			'src/routes/api/v1/boards/[boardId]/+server.ts',
			'src/routes/api/v1/boards/[boardId]/columns/+server.ts',
			'src/routes/api/v1/boards/[boardId]/cards/+server.ts',
			'src/routes/inbox/+page.server.ts'
		]) {
			const text = source(file);
			expect(text, file).toMatch(/import \{[^}]*\bCOLUMN_ORDER\b[^}]*\} from '(\$lib\/server|\.)\/card-order'/);
			expect(text, file).toContain('...COLUMN_ORDER');
		}
		// `columns.ts` orders the read it takes only the largest position from: the order cannot matter there.
		const own = (readdirSync(join(process.cwd(), 'src'), { recursive: true }) as string[])
			.map((file) => file.replace(/\\/g, '/'))
			.filter((file) => /\.(ts|svelte)$/.test(file) && !['lib/server/card-order.ts', 'lib/server/columns.ts'].includes(file))
			.filter((file) => source(`src/${file}`).includes('asc(columns.position)'));
		expect(own).toEqual([]);
		// The two sorts in code tie by id too.
		expect(source('src/lib/server/reports.ts')).toContain('.sort((a, b) => a.position - b.position || a.id - b.id)');
		expect(source('src/routes/all/+page.server.ts')).toContain('boardCols.sort((a, b) => a.position - b.position || a.id - b.id);');
	});
});

// Card 2371: with no columns the export put the board's raw name in
// Content-Disposition, so a name past Latin-1 was a 500 (a header is bytes)
// and a double quote ended the file name early.
describe('the board’s CSV export names its file safely when the board has no columns (card 2371)', () => {
	it('answers 200 with the header row, named as a full board’s file is', async () => {
		const owner = makeUser();
		const { board } = makeBoard({ owner, name: 'Q3 "launch" 🚀', columns: [] });
		// The clock pinned a tenth of a second before midnight, on purpose (card
		// 2409): the date in the name was read again after the request, so a run
		// that crossed midnight in between expected the next day's.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T23:59:59.900Z') });
		let res: Awaited<ReturnType<typeof api>>;
		try {
			res = await api('GET', `/api/boards/${board.id}/export/csv`, { user: owner });
		} finally {
			vi.useRealTimers();
		}
		expect(res.status).toBe(200);
		expect(String(res.body)).toBe('Title,Description,Priority,Column,Assignees,Due Date,Created,Completed,Labels,Category,Subtasks\n');
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="Q3__launch____-2026-10-22.csv"');
	});
});
