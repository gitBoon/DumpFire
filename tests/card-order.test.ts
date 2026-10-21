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
import { beforeEach, describe, expect, it } from 'vitest';
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

	it('both CSV exports, whose rows run across columns and boards', async () => {
		const board = await api('GET', `/api/boards/${boardA}/export/csv`, { user: owner });
		expect(board.status).toBe(200);
		expect(named(String(board.body))).toEqual(['FIRST-A4', 'TIE-A2', 'TIE-A3', 'TIE-A5']);

		const every = await api('GET', '/api/cards/export/csv', { user: owner });
		expect(every.status).toBe(200);
		expect(named(String(every.body))).toEqual(['FIRST-A4', 'TIE-B1', 'TIE-A2', 'TIE-A3', 'TIE-A5']);
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
