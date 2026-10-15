/**
 * Every colour a request can store, held to one rule (card 2162,
 * `docs/planning/card-2162-colours-and-csp.md`).
 *
 * A colour is written into a `style` attribute on every page that draws it: a
 * label's chip, a category's badge, a column's bar, a grouping on the
 * dashboard, a card's or a subtask's colour tag. Each of the 24 routes of the
 * two API trees that stores one stored any text it was sent (up to 32
 * characters where a length was checked), so `red;background:url(//x.io)`
 * was saved with 200 or 201 and would have made each viewer's browser fetch an
 * address of the writer's choosing. Each now reads it with `readColour`
 * (`src/lib/server/request-body.ts`): a colour written `#rrggbb` and nothing
 * else, trimmed, stored in the case it was sent in; a colour tag may also be
 * empty, which clears it. A value the row already holds, sent back unchanged,
 * is kept, so a colour stored before the rule never stops a rename.
 *
 * What the reader itself does is in `tests/request-body.test.ts`
 * (`describe('readColour')`, and the readers' common table). Here are the
 * routes, one refusal through the gate in each tree, and the page function
 * that copies a colour tag into a new subtask (decision 4).
 *
 * And the other half: a colour already stored is kept, so every page draws a
 * stored colour through `drawnColour` (`src/lib/colours.ts`), which draws one
 * that carries more than a colour grey. The last tests hold that rule and read
 * every `.svelte` file to see that each page follows it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { db, sqlite } from '$lib/server/db';
import { boardCategories, categories } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { saveCard } from '$lib/board/card-actions';
import { drawnColour, isHexColour, isSafeColour, NEUTRAL_COLOUR } from '$lib/colours';
import type { ColumnType } from '$lib/types';
import { api, type ApiResult } from './helpers/api';
import { gate } from './helpers/gate';
import { makeApiKey, makeBoard, makeCard, makeLabel, makeSession, makeSubtask, makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type World = {
	owner: SessionUser;
	boardId: number;
	columnId: number;
	cardId: number;
	subtaskId: number;
	labelId: number;
	categoryId: number;
	groupingId: number;
};

function world(): World {
	const owner = makeUser({ username: 'owner' });
	const A = makeBoard({ owner, name: 'A' });
	const card = makeCard(A.cols['To Do']);
	return {
		owner,
		boardId: A.board.id,
		columnId: A.cols['To Do'].id,
		cardId: card.id,
		subtaskId: makeSubtask(card, { position: 1 }).id,
		labelId: makeLabel(A.board, 'A label').id,
		categoryId: db.insert(categories).values({ boardId: A.board.id, name: 'A category' }).returning().get().id,
		groupingId: db.insert(boardCategories).values({ name: 'A grouping' }).returning().get().id
	};
}

beforeEach(resetDb);

type Method = 'POST' | 'PUT' | 'PATCH';
type Table = 'labels' | 'categories' | 'board_categories' | 'columns' | 'cards' | 'subtasks';

/**
 * One route that stores a colour. `body` holds a name or a title beside the
 * colour, so a refusal is seen to write neither. `row` is the row an update
 * changes; a create's row is the newest of its table.
 */
type ColourRoute = {
	route: string;
	path: (w: World) => string;
	field: 'color' | 'colorTag';
	table: Table;
	body: (w: World, colour: unknown) => Record<string, unknown>;
	row?: (w: World) => number;
};

const colour = (more: (w: World) => Record<string, unknown>) => (w: World, sent: unknown) => ({ ...more(w), color: sent });
const tag = (more: (w: World) => Record<string, unknown>) => (w: World, sent: unknown) => ({ ...more(w), colorTag: sent });
const named = () => ({ name: 'Renamed' });
const titled = () => ({ title: 'Renamed' });

const ROUTES: ColourRoute[] = [
	// The web application's.
	{ route: 'POST /api/board-categories', path: () => '/api/board-categories', field: 'color', table: 'board_categories', body: colour(named) },
	{ route: 'PUT /api/board-categories/:id', path: (w) => `/api/board-categories/${w.groupingId}`, field: 'color', table: 'board_categories', body: colour(named), row: (w) => w.groupingId },
	{ route: 'POST /api/categories', path: () => '/api/categories', field: 'color', table: 'categories', body: colour((w) => ({ boardId: w.boardId, name: 'Renamed' })) },
	{ route: 'PUT /api/categories/:id', path: (w) => `/api/categories/${w.categoryId}`, field: 'color', table: 'categories', body: colour(named), row: (w) => w.categoryId },
	{ route: 'POST /api/columns', path: () => '/api/columns', field: 'color', table: 'columns', body: colour((w) => ({ boardId: w.boardId, title: 'Renamed' })) },
	{ route: 'PUT /api/columns/:id', path: (w) => `/api/columns/${w.columnId}`, field: 'color', table: 'columns', body: colour(titled), row: (w) => w.columnId },
	{ route: 'POST /api/labels', path: () => '/api/labels', field: 'color', table: 'labels', body: colour((w) => ({ boardId: w.boardId, name: 'Renamed' })) },
	{ route: 'PATCH /api/labels', path: () => '/api/labels', field: 'color', table: 'labels', body: colour((w) => ({ id: w.labelId, name: 'Renamed' })), row: (w) => w.labelId },
	{ route: 'POST /api/cards', path: () => '/api/cards', field: 'colorTag', table: 'cards', body: tag((w) => ({ columnId: w.columnId, title: 'Renamed' })) },
	{ route: 'PUT /api/cards/:id', path: (w) => `/api/cards/${w.cardId}`, field: 'colorTag', table: 'cards', body: tag(titled), row: (w) => w.cardId },
	{ route: 'POST /api/subtasks', path: () => '/api/subtasks', field: 'colorTag', table: 'subtasks', body: tag((w) => ({ cardId: w.cardId, title: 'Renamed' })) },
	{ route: 'PUT /api/subtasks/:id', path: (w) => `/api/subtasks/${w.subtaskId}`, field: 'colorTag', table: 'subtasks', body: tag(titled), row: (w) => w.subtaskId },
	// The API's.
	{ route: 'POST /api/v1/board-categories', path: () => '/api/v1/board-categories', field: 'color', table: 'board_categories', body: colour(named) },
	{ route: 'PUT /api/v1/board-categories/:categoryId', path: (w) => `/api/v1/board-categories/${w.groupingId}`, field: 'color', table: 'board_categories', body: colour(named), row: (w) => w.groupingId },
	{ route: 'POST /api/v1/boards/:boardId/categories', path: (w) => `/api/v1/boards/${w.boardId}/categories`, field: 'color', table: 'categories', body: colour(named) },
	{ route: 'POST /api/v1/boards/:boardId/columns', path: (w) => `/api/v1/boards/${w.boardId}/columns`, field: 'color', table: 'columns', body: colour(titled) },
	{ route: 'POST /api/v1/boards/:boardId/labels', path: (w) => `/api/v1/boards/${w.boardId}/labels`, field: 'color', table: 'labels', body: colour(named) },
	{ route: 'POST /api/v1/boards/:boardId/cards', path: (w) => `/api/v1/boards/${w.boardId}/cards`, field: 'colorTag', table: 'cards', body: tag((w) => ({ columnId: w.columnId, title: 'Renamed' })) },
	{ route: 'PUT /api/v1/cards/:cardId', path: (w) => `/api/v1/cards/${w.cardId}`, field: 'colorTag', table: 'cards', body: tag(titled), row: (w) => w.cardId },
	{ route: 'POST /api/v1/cards/:cardId/subtasks', path: (w) => `/api/v1/cards/${w.cardId}/subtasks`, field: 'colorTag', table: 'subtasks', body: tag(titled) },
	{ route: 'PUT /api/v1/categories/:categoryId', path: (w) => `/api/v1/categories/${w.categoryId}`, field: 'color', table: 'categories', body: colour(named), row: (w) => w.categoryId },
	{ route: 'PUT /api/v1/columns/:columnId', path: (w) => `/api/v1/columns/${w.columnId}`, field: 'color', table: 'columns', body: colour(titled), row: (w) => w.columnId },
	{ route: 'PUT /api/v1/labels/:labelId', path: (w) => `/api/v1/labels/${w.labelId}`, field: 'color', table: 'labels', body: colour(named), row: (w) => w.labelId },
	{ route: 'PUT /api/v1/subtasks/:subtaskId', path: (w) => `/api/v1/subtasks/${w.subtaskId}`, field: 'colorTag', table: 'subtasks', body: tag(titled), row: (w) => w.subtaskId }
];

const COLOUR = 'color must be a colour written #rrggbb';
const COLOUR_TAG = 'colorTag must be a colour written #rrggbb, or empty';
const refusal = (r: ColourRoute) => (r.field === 'color' ? COLOUR : COLOUR_TAG);
const methodOf = (r: ColourRoute) => r.route.split(' ')[0] as Method;
const column = (r: ColourRoute) => (r.field === 'color' ? 'color' : 'color_tag');

/** The colour the route's row holds: the updated one, or the newest of the table. */
function storedColour(r: ColourRoute, w: World): string {
	const sql = r.row
		? `SELECT ${column(r)} AS c FROM ${r.table} WHERE id = ?`
		: `SELECT ${column(r)} AS c FROM ${r.table} ORDER BY id DESC LIMIT 1`;
	const found = (r.row ? sqlite.prepare(sql).get(r.row(w)) : sqlite.prepare(sql).get()) as { c: string };
	return found.c;
}

async function send(r: ColourRoute, w: World, sent: unknown): Promise<ApiResult> {
	return api(methodOf(r), r.path(w), { user: w.owner, body: r.body(w, sent) });
}

/** What a stored colour is set to by hand, as one stored before the rule might be. */
function setStored(r: ColourRoute, w: World, value: string): void {
	sqlite.prepare(`UPDATE ${r.table} SET ${column(r)} = ? WHERE id = ?`).run(value, r.row!(w));
}

describe('every route that stores a colour', () => {
	it('is in the table: 24 routes, and every handler that reads a colour reads it with readColour', () => {
		expect(ROUTES).toHaveLength(24);
		expect(new Set(ROUTES.map((r) => r.route)).size).toBe(24);

		// Every handler that names color or colorTag to a reader names it to readColour, and is in the table.
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name === '+server.ts') files.push(path);
			}
		};
		walk(join('src', 'routes', 'api'));
		const reading: string[] = [];
		const otherReaders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf8');
			const route = '/' + relative(join('src', 'routes'), file).split(sep).slice(0, -1).join('/');
			for (const match of text.matchAll(/\b(read\w+)\(body, '(color|colorTag)'/g)) {
				if (match[1] === 'readColour') reading.push(route);
				else otherReaders.push(`${route}: ${match[1]}(body, '${match[2]}'`);
			}
		}
		expect(otherReaders).toEqual([]);
		const inTable = new Set(ROUTES.map((r) => r.route.split(' ')[1].replace(/:(\w+)/g, '[$1]')));
		// A label's fields are read by one function for POST and PATCH.
		expect([...new Set(reading)].filter((route) => !inTable.has(route))).toEqual([]);
	});

	it.each(ROUTES.map((r) => [r.route, r] as const))('%s refuses anything but a colour written #rrggbb, and writes nothing', async (_, r) => {
		const w = world();
		for (const sent of ['red;background:url(//x.io)', 'red', '#fff', 'url(x)', 5, ['#ffffff']]) {
			const before = snapshotDb();
			const res = await send(r, w, sent);
			expect({ sent, status: res.status, body: res.body }).toEqual({ sent, status: 400, body: { message: refusal(r) } });
			expectUnchanged(before, JSON.stringify(sent));
		}
	});

	it.each(ROUTES.map((r) => [r.route, r] as const))('%s stores a colour as it was sent, and trimmed', async (_, r) => {
		const w = world();
		const first = await send(r, w, '#a1B2c3');
		expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
		expect(storedColour(r, w)).toBe('#a1B2c3');

		const second = await send(r, w, ' #c3b2a1 ');
		expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
		expect(storedColour(r, w)).toBe('#c3b2a1');
	});

	it.each(ROUTES.filter((r) => r.field === 'colorTag').map((r) => [r.route, r] as const))('%s takes an empty colour tag, which clears one', async (_, r) => {
		const w = world();
		if (r.row) setStored(r, w, '#ef4444');
		const res = await send(r, w, '');
		expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
		expect(storedColour(r, w)).toBe('');
	});
});

describe('a colour stored before the rule', () => {
	const OLD = 'red;background:url(//x.io)';
	const KEPT = [
		'PUT /api/columns/:id',
		'PUT /api/categories/:id',
		'PUT /api/cards/:id',
		'PUT /api/v1/columns/:columnId',
		'PUT /api/v1/categories/:categoryId',
		'PUT /api/v1/cards/:cardId'
	].map((route) => ROUTES.find((r) => r.route === route)!);

	// Labels are held the same way in tests/request-body.test.ts ("keeps what the row holds").
	it.each(KEPT.map((r) => [r.route, r] as const))('%s keeps it when a page sends it back unchanged with a rename', async (_, r) => {
		const w = world();
		setStored(r, w, OLD);

		const res = await send(r, w, OLD);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(storedColour(r, w)).toBe(OLD);
		const renamed = sqlite.prepare(`SELECT ${r.table === 'categories' ? 'name' : 'title'} AS n FROM ${r.table} WHERE id = ?`).get(r.row!(w)) as { n: string };
		expect(renamed.n).toBe('Renamed');

		// Another value that is no colour is still refused.
		expect((await send(r, w, 'blue')).status).toBe(400);
	});
});

describe('one refusal through the gate in each tree', () => {
	// The first request of a test file starts the server and loads the gate,
	// which takes seconds while every other file is starting too: done here,
	// with time to do it in (as tests/body-limits.test.ts does).
	beforeAll(async () => {
		await gate('GET', '/login', { headers: { accept: 'text/html' } });
	}, 120_000);

	it('answers 400 in the error shape, with the reader’s words, to a key and to a session', async () => {
		const w = world();

		const byKey = await gate('PUT', `/api/v1/labels/${w.labelId}`, {
			headers: { authorization: `Bearer ${makeApiKey(w.owner)}` },
			body: { color: 'red;background:url(//x.io)' }
		});
		expect(byKey.status).toBe(400);
		expect(byKey.headers.get('content-type')).toBe('application/json');
		expect(await byKey.json()).toEqual({ message: COLOUR });

		// As a page's fetch sends it: `*/*`, which SvelteKit answers with JSON.
		const asPage = { cookie: `${SESSION_COOKIE_NAME}=${makeSession(w.owner)}`, accept: '*/*' };
		const before = snapshotDb();
		const bySession = await gate('POST', '/api/columns', {
			headers: asPage,
			body: { boardId: w.boardId, title: 'Review', color: 'url(x)' }
		});
		expect(bySession.status).toBe(400);
		expect(bySession.headers.get('content-type')).toBe('application/json');
		expect(await bySession.json()).toEqual({ message: COLOUR });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM columns WHERE title = 'Review'").get()).toEqual({ n: 0 });
		expect(snapshotDb().columns).toEqual(before.columns);
	});
});

describe('a page that copies a colour tag into a new subtask (decision 4)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('sends a pending subtask’s colour tag only when it is one, so the subtask is made either way', async () => {
		const w = world();
		// The board page's requests, answered by the routes themselves.
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const res = await api(init.method as Method, url, { user: w.owner, body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
		});
		const columns = [{ id: w.columnId, cards: [] }] as unknown as ColumnType[];
		const pending = (title: string, colorTag: string) => JSON.stringify({ title, description: '', priority: 'medium', colorTag, dueDate: null });

		const saved = await saveCard(null, w.columnId, w.boardId, columns, {
			title: 'With steps',
			description: '',
			priority: 'medium',
			categoryId: null,
			dueDate: null,
			pendingSubtasks: [pending('Old tag', 'red;background:url(//x.io)'), pending('Good tag', '#ef4444'), pending('No tag', '')]
		});
		expect(saved.isNew).toBe(true);
		const made = sqlite.prepare('SELECT title, color_tag AS colorTag FROM subtasks WHERE card_id = ? ORDER BY id').all(saved.cardId!);
		expect(made).toEqual([
			{ title: 'Old tag', colorTag: '' },
			{ title: 'Good tag', colorTag: '#ef4444' },
			{ title: 'No tag', colorTag: '' }
		]);
	});
});

// ─── Drawing a stored colour (slice C) ───────────────────────────────────────
//
// A colour stored before the rule, or brought back by a restore, is kept and
// returned as stored (decision 3). What keeps it from carrying more than a
// colour into a page is that every page draws it through `drawnColour`.

describe('isHexColour, isSafeColour and drawnColour', () => {
	const SAFE_NOT_HEX = ['#fff', '#ffff', '#ff000080', 'red', 'var(--accent)'];
	const NEITHER: unknown[] = [
		'red;background:url(//x.io)', 'url(x)', '#zzzzzz', '#12345', 'rgb(1,2,3)', 'x y', '', 5, ['#ffffff'], null,
		' red', 'var(--a,red)', 'var(--x, url(//x.io))', 'a'.repeat(31), '   ', ' red;x:url(//x.io) '
	];
	// Neither as written, but a safe colour once its spaces, tabs and line
	// breaks are trimmed, which `drawnColour` does first (and SQL 1, `trim`).
	const PADDED = [' red', '#ef4444 ', '\t#fff\n', '\r\nvar(--accent)\f'];

	it('takes #rrggbb as both; a shorter hex, a colour word or var() as safe only; nothing else as either', () => {
		expect(isHexColour('#a1B2c3')).toBe(true);
		expect(isSafeColour('#a1B2c3')).toBe(true);
		for (const v of SAFE_NOT_HEX) {
			expect(isSafeColour(v), v).toBe(true);
			expect(isHexColour(v), v).toBe(false);
		}
		for (const v of NEITHER) {
			expect(isSafeColour(v), JSON.stringify(v)).toBe(false);
			expect(isHexColour(v), JSON.stringify(v)).toBe(false);
		}
	});

	it('draws a safe colour as stored, trimmed, nothing for no colour, and the grey (or the fallback given) for anything else', () => {
		expect(NEUTRAL_COLOUR).toBe('#94a3b8');
		for (const v of ['#a1B2c3', ...SAFE_NOT_HEX]) expect(drawnColour(v)).toBe(v);
		for (const v of PADDED) expect(drawnColour(v), JSON.stringify(v)).toBe(v.trim());
		for (const v of [null, undefined, '']) expect(drawnColour(v)).toBe('');
		for (const v of NEITHER.filter((x) => x !== '' && x !== null && !PADDED.includes(x as string))) {
			expect(drawnColour(v), JSON.stringify(v)).toBe('#94a3b8');
			expect(drawnColour(v, 'var(--text-tertiary)'), JSON.stringify(v)).toBe('var(--text-tertiary)');
		}
	});
});

/**
 * Each `style`, `fill` or `stroke` attribute (and `style:` directive) in the
 * markup of a `.svelte` file, with the expressions interpolated into it: the
 * `{…}` parts of a quoted value, the `${…}` parts of a template literal in a
 * `{…}` value, or the whole of a `{…}` value that holds no template literal.
 * Scripts, `<style>` blocks and comments are blanked first, keeping the line
 * numbers. An attribute is found by its own name in the tag, so `stroke-width`
 * and a `style="color: var(...)"` beside other braces are not read (R4).
 */
function drawnExpressions(source: string): { attribute: string; line: number; expression: string }[] {
	const blank = (text: string, re: RegExp) => text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
	let text = blank(source, /<script[\s\S]*?<\/script>/g);
	text = blank(text, /<style[\s\S]*?<\/style>/g);
	text = blank(text, /<!--[\s\S]*?-->/g);

	function skipString(i: number): number {
		const q = text[i];
		for (i++; i < text.length; i++) {
			if (text[i] === '\\') { i++; continue; }
			if (q === '`' && text[i] === '$' && text[i + 1] === '{') { i = closeBrace(i + 1); continue; }
			if (text[i] === q) return i + 1;
		}
		return i;
	}
	function closeBrace(i: number): number {
		let depth = 0;
		while (i < text.length) {
			const c = text[i];
			if (c === '"' || c === "'" || c === '`') { i = skipString(i); continue; }
			if (c === '{') depth++;
			else if (c === '}' && --depth === 0) return i;
			i++;
		}
		return i;
	}
	function templateParts(from: number, to: number): string[] {
		const parts: string[] = [];
		for (let i = from; i < to; ) {
			if (text[i] === '`') {
				for (i++; i < to && text[i] !== '`'; i++) {
					if (text[i] === '\\') { i++; continue; }
					if (text[i] === '$' && text[i + 1] === '{') { const end = closeBrace(i + 1); parts.push(text.slice(i + 2, end)); i = end; }
				}
				i++;
			} else if (text[i] === '"' || text[i] === "'") i = skipString(i);
			else i++;
		}
		return parts;
	}

	const found: { attribute: string; line: number; expression: string }[] = [];
	for (const m of text.matchAll(/\s(style|fill|stroke|style:[\w-]+)=(?=["'{])/g)) {
		const line = text.slice(0, m.index).split('\n').length;
		let i = m.index! + m[0].length;
		if (text[i] === '{') {
			const end = closeBrace(i);
			const parts = templateParts(i + 1, end);
			for (const expression of parts.length ? parts : [text.slice(i + 1, end)]) found.push({ attribute: m[1], line, expression });
		} else {
			const q = text[i];
			for (i++; i < text.length && text[i] !== q; i++) {
				if (text[i] === '{') { const end = closeBrace(i); found.push({ attribute: m[1], line, expression: text.slice(i + 1, end) }); i = end; }
			}
		}
	}
	return found;
}

describe('every page draws a colour through drawnColour (slice C)', () => {
	const root = join(process.cwd(), 'src');
	function svelteFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			return e.isDirectory() ? svelteFiles(p) : e.name.endsWith('.svelte') ? [p] : [];
		});
	}

	it('finds what it is meant to find, and nothing it is not (the reader itself)', () => {
		const source = [
			'<script>const s = `style="${x.color}"`;</script>',
			'<div style="background: {cat.color}20; width: {pct}%"></div>',
			'<div style={group.color ? `color: ${group.color}` : \'\'}></div>',
			'<path fill="{drawnColour(layer.color)}40" stroke={nodeColor(t)} stroke-width={colorWidth} />',
			'<span style:color={label.color} style="color: var(--x)" title={label.color}></span>',
			'<!-- <div style="color: {old.color}"></div> -->'
		].join('\n');
		expect(drawnExpressions(source)).toEqual([
			{ attribute: 'style', line: 2, expression: 'cat.color' },
			{ attribute: 'style', line: 2, expression: 'pct' },
			{ attribute: 'style', line: 3, expression: 'group.color' },
			{ attribute: 'fill', line: 4, expression: 'drawnColour(layer.color)' },
			{ attribute: 'stroke', line: 4, expression: 'nodeColor(t)' },
			{ attribute: 'style:color', line: 5, expression: 'label.color' }
		]);
	});

	it('every expression in a style, fill or stroke attribute that names a colour calls drawnColour', () => {
		const offenders: string[] = [];
		let colours = 0;
		for (const file of svelteFiles(root)) {
			for (const { attribute, line, expression } of drawnExpressions(readFileSync(file, 'utf8'))) {
				if (!/colou?r/i.test(expression)) continue;
				colours++;
				if (!expression.includes('drawnColour(')) offenders.push(`${relative(process.cwd(), file).split(sep).join('/')}:${line} ${attribute}={${expression.trim()}}`);
			}
		}
		expect(offenders).toEqual([]);
		// The sites slice C wrapped: a reader that found none would pass on nothing.
		expect(colours).toBeGreaterThanOrEqual(70);
	});
});
