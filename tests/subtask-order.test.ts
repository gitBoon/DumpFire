/**
 * Subtasks in one order everywhere (card 2223).
 *
 * `POST /api/v1/cards/{cardId}/subtasks` stored every subtask sent with no
 * `position` at 0, where the web application's `POST /api/subtasks` puts a
 * new one after the last. Readers then disagreed about a tie: some ordered by
 * `position` alone, so subtasks sharing it came in whatever order SQLite read
 * them, and the v1 list, the v1 card, the report and both CSV exports had no
 * order at all. The milestone page's graph sorted by id while its table
 * followed the card.
 *
 * Now both creates take the next position from `nextSubtaskPosition`, and
 * every reader that hands out a card's subtasks as a list orders them by
 * `SUBTASK_ORDER`, position and then id, from `$lib/server/subtask-order`.
 * The graph orders its subtask nodes as the card lists them, through
 * `orderSubtaskNodes` in `$lib/plan-table`, as the table does.
 *
 * A tie cannot be made to scan out of id order in SQLite (ids are rowids, and
 * the card's index holds them in order), so the readers' test puts positions
 * out of id order as well: a reader with no order gives id order and fails, and
 * the ties at 0 pin the id tiebreak. The source check is what holds the tie.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { generateBoardReport, generateCardReport, generateReportPdf } from '$lib/server/reports';
import { orderSubtaskNodes } from '$lib/plan-table';
import { api } from './helpers/api';
import { pageLoad } from './helpers/actions';
import { pdfText } from './helpers/pdf';
import { makeBoard, makeCard, makeSubtask, makeUser, resetDb } from './helpers/fixtures';

beforeEach(resetDb);

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf-8');

describe('a new subtask goes after the card’s last one', () => {
	it('three v1 creates with no position read back 0, 1 and 2; one sent at 0.5 keeps 0.5', async () => {
		const owner = makeUser();
		const card = makeCard(makeBoard({ owner }).cols['To Do']);
		const positions: number[] = [];
		for (const title of ['one', 'two', 'three']) {
			const res = await api('POST', `/api/v1/cards/${card.id}/subtasks`, { user: owner, body: { title } });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			positions.push(res.body.position);
		}
		expect(positions).toEqual([0, 1, 2]);

		const sent = await api('POST', `/api/v1/cards/${card.id}/subtasks`, { user: owner, body: { title: 'between', position: 0.5 } });
		expect([sent.status, sent.body.position]).toEqual([201, 0.5]);

		const list = await api('GET', `/api/v1/cards/${card.id}/subtasks`, { user: owner });
		expect(list.body.map((s: { title: string }) => s.title)).toEqual(['one', 'between', 'two', 'three']);
	});

	it('the web application’s create still puts each new one last: after a v1 one sent at 7, it gets 8', async () => {
		const owner = makeUser();
		const card = makeCard(makeBoard({ owner }).cols['To Do']);
		const first = await api('POST', '/api/subtasks', { user: owner, body: { cardId: card.id, title: 'first' } });
		expect([first.status, first.body.position]).toEqual([201, 0]);
		const sent = await api('POST', `/api/v1/cards/${card.id}/subtasks`, { user: owner, body: { title: 'sent at 7', position: 7 } });
		expect([sent.status, sent.body.position]).toEqual([201, 7]);
		const after = await api('POST', '/api/subtasks', { user: owner, body: { cardId: card.id, title: 'after' } });
		expect([after.status, after.body.position]).toEqual([201, 8]);
		const v1 = await api('POST', `/api/v1/cards/${card.id}/subtasks`, { user: owner, body: { title: 'v1 after' } });
		expect([v1.status, v1.body.position]).toEqual([201, 9]);
	});

	it('the first subtask of a card is at 0 whichever create makes it', async () => {
		const owner = makeUser();
		const { cols } = makeBoard({ owner });
		const a = makeCard(cols['To Do']);
		const b = makeCard(cols['To Do']);
		// Another card's subtasks do not count.
		makeSubtask(a, { position: 5 });
		const v1 = await api('POST', `/api/v1/cards/${b.id}/subtasks`, { user: owner, body: { title: 'v1' } });
		expect(v1.body.position).toBe(0);
		const c = makeCard(cols['To Do']);
		const session = await api('POST', '/api/subtasks', { user: owner, body: { cardId: c.id, title: 'session' } });
		expect(session.body.position).toBe(0);
	});
});

describe('every reader of a card’s subtasks orders them by position, then id', () => {
	/** In the order they are made (so in id order): positions 2, 0, 0 and 1. */
	const MADE = [
		{ title: 'SUB-DELTA', position: 2 },
		{ title: 'SUB-ALPHA', position: 0 },
		{ title: 'SUB-BRAVO', position: 0 },
		{ title: 'SUB-CHARLIE', position: 1 }
	];
	const ORDER = ['SUB-ALPHA', 'SUB-BRAVO', 'SUB-CHARLIE', 'SUB-DELTA'];

	let owner: ReturnType<typeof makeUser>;
	let boardId = 0;
	let cardId = 0;

	beforeEach(() => {
		owner = makeUser();
		const { board, cols } = makeBoard({ owner });
		boardId = board.id;
		const card = makeCard(cols['To Do'], { title: 'ORDERED-CARD' });
		cardId = card.id;
		for (const s of MADE) makeSubtask(card, s);
	});

	const titles = (list: { title: string }[]) => list.map((s) => s.title);

	/** The `subtasks` of the object with the card's id, wherever it is in a page's data. */
	function subtasksIn(data: unknown): { title: string }[] {
		const seen: unknown[] = [data];
		while (seen.length > 0) {
			const value = seen.pop();
			if (Array.isArray(value)) seen.push(...value);
			else if (value && typeof value === 'object') {
				const row = value as Record<string, unknown>;
				if (row.id === cardId && Array.isArray(row.subtasks)) return row.subtasks as { title: string }[];
				seen.push(...Object.values(row));
			}
		}
		throw new Error(`No card ${cardId} with subtasks in the data`);
	}

	/** The titles in the order a line of text names them. */
	const named = (text: string) =>
		ORDER.map((t) => [t, text.indexOf(t)] as const)
			.filter(([, at]) => at >= 0)
			.sort((a, b) => a[1] - b[1])
			.map(([t]) => t);

	it('the board page', async () => {
		const load = await pageLoad(`/board/${boardId}`, { user: owner });
		expect(load.type).toBe('data');
		expect(titles(subtasksIn((load as { data: unknown }).data))).toEqual(ORDER);
	});

	it('All Tasks', async () => {
		const load = await pageLoad('/all', { user: owner });
		expect(load.type).toBe('data');
		expect(titles(subtasksIn((load as { data: unknown }).data))).toEqual(ORDER);
	});

	it('the card window (GET /api/cards/{id}/context) and GET /api/subtasks', async () => {
		const context = await api('GET', `/api/cards/${cardId}/context`, { user: owner });
		expect(titles(context.body.card.subtasks)).toEqual(ORDER);
		const session = await api('GET', `/api/subtasks?cardId=${cardId}`, { user: owner });
		expect(titles(session.body)).toEqual(ORDER);
	});

	it('the v1 list and the v1 card', async () => {
		const list = await api('GET', `/api/v1/cards/${cardId}/subtasks`, { user: owner });
		expect(titles(list.body)).toEqual(ORDER);
		const card = await api('GET', `/api/v1/cards/${cardId}`, { user: owner });
		expect(titles(card.body.subtasks)).toEqual(ORDER);
	});

	it('the board report and the card report, and the card report’s PDF', async () => {
		const today = new Date().toISOString().slice(0, 10);
		const board = generateBoardReport(boardId, '2026-01-01', today, owner)!;
		const task = board.outstandingTasks.flatMap((g) => g.tasks).find((t) => t.id === cardId)!;
		expect(titles(task.subtasks)).toEqual(ORDER);

		const card = generateCardReport(cardId)!;
		expect(titles(card.outstandingTasks[0].tasks[0].subtasks)).toEqual(ORDER);
		expect(named(pdfText(await generateReportPdf(card, 'detailed')))).toEqual(ORDER);
	});

	it('both CSV exports', async () => {
		for (const path of [`/api/boards/${boardId}/export/csv`, `/api/cards/export/csv?boardId=${boardId}`]) {
			const res = await api('GET', path, { user: owner });
			expect(res.status, path).toBe(200);
			const line = String(res.body).split('\n').find((l) => l.includes('ORDERED-CARD'))!;
			expect(named(line), path).toEqual(ORDER);
		}
	});

	it('each reader orders by SUBTASK_ORDER, and none by position alone', () => {
		const readers: [string, number][] = [
			// The board page's load and GET /api/boards/:id/contents, through their one reader (card 2280).
			['src/lib/server/board-contents.ts', 1],
			['src/lib/server/cross-board-cards.ts', 1],
			['src/routes/api/cards/[id]/context/+server.ts', 1],
			// GET /api/subtasks and GET /api/v1/cards/:cardId/subtasks, through their one list (card 2012).
			['src/lib/server/subtasks.ts', 1],
			['src/routes/api/v1/cards/[cardId]/+server.ts', 1],
			['src/lib/server/reports.ts', 2],
			['src/routes/api/boards/[id]/export/csv/+server.ts', 1],
			['src/routes/api/cards/export/csv/+server.ts', 1]
		];
		for (const [file, sites] of readers) {
			const text = source(file);
			expect(text, file).toMatch(/import \{[^}]*\bSUBTASK_ORDER\b[^}]*\} from '(\$lib\/server|\.)\/subtask-order'/);
			expect(text.split('.orderBy(...SUBTASK_ORDER)').length - 1, file).toBe(sites);
			expect(text, file).not.toContain('asc(subtasks.position))');
		}
		// Both creates take the next position from the one helper, in the one create they share (card 2012).
		for (const file of ['src/lib/server/subtasks.ts']) {
			expect(source(file), file).toContain('nextSubtaskPosition(cardId)');
		}
	});
});

describe('the milestone graph orders a card’s subtask nodes as the card lists them', () => {
	const node = (id: number) => ({ kind: 'subtask' as const, id });

	it('orderSubtaskNodes: nodes 9, 4 and 6, listed 6, 9, 4, come back 6, 9, 4; nodes not listed go last, by id', () => {
		const listed = [{ id: 6 }, { id: 9 }, { id: 4 }];
		expect(orderSubtaskNodes([node(9), node(4), node(6)], listed).map((n) => n.id)).toEqual([6, 9, 4]);
		expect(orderSubtaskNodes([node(12), node(9), node(2), node(4), node(6)], listed).map((n) => n.id)).toEqual([6, 9, 4, 2, 12]);
		expect(orderSubtaskNodes([node(5), node(3)], undefined).map((n) => n.id)).toEqual([3, 5]);
	});

	it('the plan page groups its subtask nodes through orderSubtaskNodes, with the card’s list', () => {
		const page = source('src/routes/plan/[id]/+page.svelte');
		expect(page).toContain('orderSubtaskNodes(list, data.subtasks[cardId])');
		expect(page).not.toContain('list.sort((a, b) => a.id - b.id)');
	});
});
