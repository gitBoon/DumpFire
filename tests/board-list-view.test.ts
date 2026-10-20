/**
 * The board's list view: one column at a time at full width, for a portrait
 * monitor (card 2079).
 *
 *   - A Board | List control in the board header; the list opens on To Do
 *     ("to do" or "todo", any case, else the first column) in priority order:
 *     pinned first, then critical to low, the board's order within each.
 *   - The choice is in the address while the list is shown
 *     (`?view=list&column=<id>`) and remembered per viewer and per board in
 *     the browser, every read and write of `localStorage` inside a `try`.
 *   - The header's filters apply with the board's own tests; a card that
 *     fails one is left out.
 *
 * A page cannot be run here: no browser, no DOM. What the list shows is
 * worked out by `src/lib/board/board-view.ts`, called directly; what the
 * page and the two components do with it is read from their source.
 *
 * The plan is `docs/planning/card-2079-portrait-list-view.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import type { CardType, CategoryType } from '$lib/types';
import {
	BOARD_VIEW,
	boardViewKey,
	defaultListColumn,
	isFiltering,
	listCards,
	openingView,
	passesFilter,
	readBoardView,
	resolveListColumn,
	viewFromUrl,
	withViewParams,
	writeBoardView,
	type ListFilter
} from '$lib/board/board-view';

function card(id: number, priority: string, extra: Partial<CardType> = {}): CardType {
	return {
		id,
		columnId: 1,
		categoryId: null,
		title: `Card ${id}`,
		description: null,
		position: id,
		priority,
		colorTag: null,
		dueDate: null,
		createdAt: '2026-10-01 09:00:00',
		updatedAt: '2026-10-01 09:00:00',
		subtasks: [],
		labelIds: [],
		pinned: false,
		onHoldNote: '',
		businessValue: null,
		subBoards: [],
		assignees: [],
		archivedAt: null,
		coverUrl: null,
		milestoneId: null,
		...extra
	};
}

/** A `localStorage` of a plain map, or one that throws on every call, put on the global object for one test. */
function useStorage(kind: 'working' | 'throwing'): Map<string, string> {
	const stored = new Map<string, string>();
	const fail = () => {
		throw new Error('SecurityError: storage is blocked');
	};
	const storage =
		kind === 'working'
			? { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) }
			: { getItem: fail, setItem: fail };
	Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
	return stored;
}

afterEach(() => {
	delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('remembering the choice', () => {
	it('keeps one choice per viewer and per board', () => {
		const stored = useStorage('working');
		expect(boardViewKey(3, 12)).toBe('dumpfire-board-view:3:12');

		writeBoardView(3, 12, { view: 'list', columnId: 40, order: 'board' });
		expect(readBoardView(3, 12)).toEqual({ view: 'list', columnId: 40, order: 'board' });
		// Another viewer of the board, and the same viewer on another board, have none.
		expect(readBoardView(4, 12)).toBeNull();
		expect(readBoardView(3, 13)).toBeNull();
		expect([...stored.keys()]).toEqual(['dumpfire-board-view:3:12']);
	});

	it('remembers nothing, and throws nothing, with storage blocked or absent', () => {
		useStorage('throwing');
		expect(() => writeBoardView(3, 12, { view: 'list', columnId: 40, order: 'priority' })).not.toThrow();
		expect(readBoardView(3, 12)).toBeNull();

		// The server's render, and any other place with no localStorage at all.
		delete (globalThis as { localStorage?: unknown }).localStorage;
		expect(() => writeBoardView(3, 12, { view: 'list', columnId: 40, order: 'priority' })).not.toThrow();
		expect(readBoardView(3, 12)).toBeNull();
	});

	it('reads nothing it did not write', () => {
		const stored = useStorage('working');
		const key = boardViewKey(3, 12);
		for (const raw of ['not json', 'null', '"list"', '{"view":"grid"}', '[]']) {
			stored.set(key, raw);
			expect(readBoardView(3, 12), raw).toBeNull();
		}
		// A view it knows, with a column and an order it does not: no column, priority order.
		stored.set(key, JSON.stringify({ view: 'list', columnId: -2, order: 'random' }));
		expect(readBoardView(3, 12)).toEqual({ view: 'list', columnId: null, order: 'priority' });
		stored.set(key, JSON.stringify({ view: 'board', columnId: 1.5 }));
		expect(readBoardView(3, 12)).toEqual({ view: 'board', columnId: null, order: 'priority' });
	});
});

describe('the address', () => {
	const at = (search: string) => new URL(`https://dumpfire.test/board/12${search}`);

	it('asks for the list only with view=list', () => {
		expect(viewFromUrl(at(''))).toBeNull();
		expect(viewFromUrl(at('?view=board'))).toBeNull();
		expect(viewFromUrl(at('?card=7'))).toBeNull();
		expect(viewFromUrl(at('?view=list&column=40'))).toEqual({ view: 'list', columnId: 40 });
		expect(viewFromUrl(at('?view=list'))).toEqual({ view: 'list', columnId: null });
		expect(viewFromUrl(at('?view=list&column=abc'))).toEqual({ view: 'list', columnId: null });
		expect(viewFromUrl(at('?view=list&column=0'))).toEqual({ view: 'list', columnId: null });
	});

	it('carries the list, and drops it for the board, keeping everything else', () => {
		const url = at('?card=7');
		const list = withViewParams(url, { view: 'list', columnId: 40, order: 'board' });
		expect(list.search).toBe('?card=7&view=list&column=40');
		// The order is remembered, not put in the address.
		expect(list.searchParams.has('order')).toBe(false);
		expect(url.search).toBe('?card=7');

		const board = withViewParams(list, { view: 'board', columnId: 40, order: 'board' });
		expect(board.search).toBe('?card=7');
		expect(withViewParams(at('?view=list&column=40'), { view: 'list', columnId: null, order: 'priority' }).search).toBe('?view=list');
	});

	it('opens as the address says, else as remembered, else as the board', () => {
		const remembered = { view: 'list' as const, columnId: 41, order: 'board' as const };
		expect(openingView({ view: 'list', columnId: 40 }, remembered)).toEqual({ view: 'list', columnId: 40, order: 'board' });
		expect(openingView({ view: 'list', columnId: null }, remembered)).toEqual({ view: 'list', columnId: 41, order: 'board' });
		expect(openingView({ view: 'list', columnId: null }, null)).toEqual({ view: 'list', columnId: null, order: 'priority' });
		expect(openingView(null, remembered)).toEqual(remembered);
		expect(openingView(null, { view: 'board', columnId: 41, order: 'board' })).toEqual({ view: 'board', columnId: 41, order: 'board' });
		expect(openingView(null, null)).toEqual(BOARD_VIEW);
	});
});

describe('the column the list shows', () => {
	it('opens on the first column titled To Do or Todo, else the first', () => {
		expect(defaultListColumn([{ id: 1, title: 'Backlog' }, { id: 2, title: 'To Do' }, { id: 3, title: 'todo' }])).toBe(2);
		expect(defaultListColumn([{ id: 1, title: 'Backlog' }, { id: 3, title: '  TODO ' }])).toBe(3);
		expect(defaultListColumn([{ id: 1, title: 'Backlog' }, { id: 2, title: 'To Do Soon' }])).toBe(1);
		expect(defaultListColumn([])).toBeNull();
	});

	it('keeps a chosen column while it is on the board, and falls back when it is not', () => {
		const columns = [{ id: 1, title: 'Backlog' }, { id: 2, title: 'To Do' }, { id: 3, title: 'Done' }];
		expect(resolveListColumn(columns, 3)).toBe(3);
		expect(resolveListColumn(columns, 99)).toBe(2);
		expect(resolveListColumn(columns, null)).toBe(2);
	});
});

describe('the rows', () => {
	const categories: CategoryType[] = [];
	const all = () => true;
	// The column as the board holds it: pinned low at 5, two highs (11 before
	// 4) and two criticals (9 before 2) out of their priority order.
	const column = [
		card(11, 'high'),
		card(3, 'low'),
		card(9, 'critical'),
		card(5, 'low', { pinned: true }),
		card(7, 'medium'),
		card(4, 'high'),
		card(2, 'critical')
	];

	it('orders by priority: pinned first, then critical to low, the board order within each', () => {
		expect(listCards(column, 'priority', categories, all).map((c) => c.id)).toEqual([5, 9, 2, 11, 4, 7, 3]);
	});

	it('shows the column as the board does in board order, and never reorders the board', () => {
		const before = column.map((c) => c.id);
		expect(listCards(column, 'board', categories, all).map((c) => c.id)).toEqual(before);
		listCards(column, 'priority', categories, all);
		expect(column.map((c) => c.id)).toEqual(before);
	});

	it('leaves out a card that fails a filter, in either order', () => {
		const keep = (c: CardType) => c.id !== 9 && c.id !== 3;
		expect(listCards(column, 'priority', categories, keep).map((c) => c.id)).toEqual([5, 2, 11, 4, 7]);
		expect(listCards(column, 'board', categories, keep).map((c) => c.id)).toEqual([11, 5, 7, 4, 2]);
	});

	it('applies the header filters with the board tests', () => {
		const none: ListFilter = { search: '', assigneeId: null, hideBlocked: false };
		const blocked = new Set([7]);
		const isBlocked = (id: number) => blocked.has(id);
		const mine = card(7, 'medium', { title: 'Fix the portrait list', assignees: [{ id: 3, username: 'ann', emoji: '🙂' }] });
		const theirs = card(8, 'medium', { title: 'Something else', assignees: [{ id: 4, username: 'bob', emoji: '🙂' }] });

		expect(isFiltering(none)).toBe(false);
		expect(isFiltering({ ...none, search: '   ' })).toBe(false);
		expect(isFiltering({ ...none, search: 'x' })).toBe(true);
		expect(isFiltering({ ...none, assigneeId: 3 })).toBe(true);
		expect(isFiltering({ ...none, hideBlocked: true })).toBe(true);

		expect(passesFilter(mine, none, categories, isBlocked)).toBe(true);
		expect(passesFilter(mine, { ...none, search: 'portrait' }, categories, isBlocked)).toBe(true);
		expect(passesFilter(theirs, { ...none, search: 'portrait' }, categories, isBlocked)).toBe(false);
		expect(passesFilter(theirs, { ...none, search: '#8' }, categories, isBlocked)).toBe(true);
		expect(passesFilter(mine, { ...none, assigneeId: 3 }, categories, isBlocked)).toBe(true);
		expect(passesFilter(theirs, { ...none, assigneeId: 3 }, categories, isBlocked)).toBe(false);
		// Hide blocked hides a card only while a blocker is open.
		expect(passesFilter(mine, { ...none, hideBlocked: true }, categories, isBlocked)).toBe(false);
		expect(passesFilter(theirs, { ...none, hideBlocked: true }, categories, isBlocked)).toBe(true);
	});
});

describe('the page and the components, as source', () => {
	const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

	function all(node: ts.Node, test: (n: ts.Node) => boolean, out: ts.Node[] = []): ts.Node[] {
		if (test(node)) out.push(node);
		node.forEachChild((child) => void all(child, test, out));
		return out;
	}

	it('touches localStorage only in board-view.ts, and there only inside a try', () => {
		const file = 'src/lib/board/board-view.ts';
		const script = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
		const uses = all(script, (n) => ts.isIdentifier(n) && n.text === 'localStorage');
		expect(uses.length).toBe(2);
		for (const use of uses) {
			let inTry = false;
			for (let n: ts.Node = use; n.parent; n = n.parent) {
				if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) inTry = true;
			}
			expect(inTry, use.parent.getText()).toBe(true);
		}
		for (const other of [
			'src/routes/board/[id]/+page.svelte',
			// What the board page draws, in its components (card 2280, slice B3).
			'src/lib/components/board/BoardHeader.svelte',
			'src/lib/components/board/BoardMoreMenu.svelte',
			'src/lib/components/board/KanbanColumnHeader.svelte',
			'src/lib/components/board/KanbanCardBody.svelte',
			'src/lib/components/board/ActivityPanel.svelte',
			'src/lib/components/board/ArchivePanel.svelte',
			'src/lib/components/board/SidePanel.svelte',
			'src/lib/components/board/XpLeaderboard.svelte',
			'src/lib/components/board/ColumnListView.svelte',
			'src/lib/components/board/CardListRow.svelte',
			'src/lib/components/board/BoardViewSwitch.svelte'
		]) {
			expect(read(other), other).not.toContain('localStorage');
		}
	});

	it('makes no request from the list: it calls the page’s own handlers', () => {
		for (const file of [
			'src/lib/components/board/ColumnListView.svelte',
			'src/lib/components/board/CardListRow.svelte',
			'src/lib/components/board/BoardViewSwitch.svelte'
		]) {
			const source = read(file);
			expect(source, file).not.toMatch(/\bfetch\(|\$lib\/api|invalidateAll/);
		}
	});

	it('draws the list in place of the Kanban block, and keeps the list in the address after a card link', () => {
		const source = read('src/routes/board/[id]/+page.svelte');
		const list = source.indexOf("{#if boardView.view === 'list'}");
		const kanban = source.indexOf('<div class="kanban-container">');
		expect(list).toBeGreaterThan(-1);
		expect(source.slice(list, kanban)).toMatch(/<ColumnListView[\s\S]*\{:else\}/);
		expect(source.indexOf('{/if}\r\n</div> <!-- /.board-page -->') > kanban || source.indexOf('{/if}\n</div> <!-- /.board-page -->') > kanban).toBe(true);
		// The header control, first among the right-hand actions, in the board's
		// header (card 2280, slice B3: moved from the page), which hands its
		// choice to the page's setBoardView.
		expect(read('src/lib/components/board/BoardHeader.svelte')).toMatch(/<div class="board-header-right">\s*<BoardViewSwitch \{view\} onChange=\{\(view\) => onViewChange\(view\)\} \/>/);
		expect(source).toContain('onViewChange={(view) => setBoardView({ ...boardView, view })}');
		expect(source.indexOf('<BoardHeader')).toBeGreaterThan(-1);
		expect(source.indexOf('<BoardHeader')).toBeLessThan(list);

		// The view's afterNavigate is registered after the card window's, so the
		// address it puts right is the one openCardFromAddress has already put
		// right. That holds only while both wait the same number of awaits (one
		// nextTick) before replaceState: the callbacks run in the order they were
		// registered, and each resumes after its awaits in that order too. The
		// next tests pin the view's side; card 2164's, in page-failures.test.ts,
		// pin openCardFromAddress's.
		const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1];
		const calls = [...script.matchAll(/^\tafterNavigate\(/gm)].map((m) => m.index!);
		expect(calls).toHaveLength(2);
		expect(script.slice(calls[0], calls[1])).toContain('openCardFromAddress(to?.url)');
		expect(script.slice(calls[1])).toMatch(/^[\s\S]*?openingView\(viewFromUrl\(/);
	});

	describe('the view’s navigation and setBoardView, from the page’s script', () => {
		const source = () => /<script lang="ts">([\s\S]*?)<\/script>/.exec(read('src/routes/board/[id]/+page.svelte'))![1];
		const tree = () => ts.createSourceFile('page.ts', source(), ts.ScriptTarget.Latest, true);
		const flat = (n: ts.Node) => n.getText().replace(/\s+/g, ' ');
		/** The callback of the afterNavigate that opens the view. */
		function viewCallback(): ts.ArrowFunction {
			const calls = all(tree(), (n) => ts.isCallExpression(n) && n.expression.getText() === 'afterNavigate') as ts.CallExpression[];
			const view = calls.filter((c) => c.getText().includes('openingView'));
			expect(view).toHaveLength(1);
			return view[0].arguments[0] as ts.ArrowFunction;
		}
		function setBoardView(): ts.FunctionDeclaration {
			const found = all(tree(), (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'setBoardView');
			expect(found).toHaveLength(1);
			return found[0] as ts.FunctionDeclaration;
		}

		it('reads the browser’s own address on Back and Forward, which keeps the view a shallow replaceState put in it', () => {
			const callback = viewCallback();
			expect(callback.parameters.map((p) => p.getText())).toEqual(['{ to, type }']);
			expect(flat(callback.body)).toContain("openingView(viewFromUrl(type === 'popstate' ? new URL(location.href) : to.url), remembered)");
		});

		it('waits one tick, as openCardFromAddress does, before setBoardView puts the address right', () => {
			const steps = (viewCallback().body as ts.Block).statements.map((st) => flat(st));
			const waited = steps.indexOf('await nextTick();');
			expect(waited).toBeGreaterThan(-1);
			// One await only: the order of the two callbacks' replaceState rests on it.
			expect(steps.filter((st) => /\bawait\b/.test(st))).toEqual(['await nextTick();']);
			expect(steps.findIndex((st) => st.includes('setBoardView(choice)'))).toBeGreaterThan(waited);
		});

		it('builds the address from location.href, not $page.url, which a shallow replaceState leaves behind', () => {
			const body = flat(setBoardView().body!);
			expect(body).toContain('replaceState(withViewParams(new URL(location.href), boardView), $page.state);');
			expect(body).not.toContain('$page.url');
		});

		it('moves the list off a column deleted live at once, through setBoardView, once the view has been opened', () => {
			const effects = all(tree(), (n) => ts.isCallExpression(n) && n.expression.getText() === '$effect' && n.getText().includes('resolveListColumn'));
			expect(effects).toHaveLength(1);
			const text = flat(effects[0]);
			expect(text).toContain('const columnId = resolveListColumn(boardState.columns, boardView.columnId);');
			// Not while the board is refused, whose columns are emptied, not deleted (card 2280, slice B2a).
			expect(text).toContain("if (boardViewRead && !boardState.refused && boardView.view === 'list' && columnId !== boardView.columnId) untrack(() => setBoardView(boardView));");
		});
	});

	describe('the row', () => {
		const row = () => read('src/lib/components/board/CardListRow.svelte');
		const markup = () => row().replace(/<script[\s\S]*?<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '').replace(/<!--[\s\S]*?-->/g, '');
		const style = () => /<style>([\s\S]*)<\/style>/.exec(row())![1];
		/** The declarations of a rule written as `\t<selector> {`, alone on its line or not. */
		const rule = (css: string, selector: string) => {
			const at = css.indexOf(`\n\t${selector} {`);
			expect(at, selector).toBeGreaterThan(-1);
			return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at)).replace(/\s+/g, ' ').trim();
		};

		it('is an article holding a heading, opened by a real button over its title, not a role="button" around a link', () => {
			const html = markup();
			expect(html.trimStart()).toMatch(/^<article\s/);
			expect(html).not.toMatch(/role="button"|tabindex=/);
			const heading = /<h4 class="row-title">([\s\S]*?)<\/h4>/.exec(html)![1];
			const button = /<button\s+type="button"\s+class="row-open"[\s\S]*?<\/button>/.exec(heading)![0];
			expect(button).toContain('onclick={(e) => onOpen(card, e)}');
			expect(button).toContain('aria-pressed={selectionMode ? selected : undefined}');
			// Its name is the card's number and title, and nothing else of the row.
			expect(button.slice(button.indexOf('>', button.indexOf('onkeydown')) + 1)).toBe('<span class="row-id">#{card.id}</span> <span class="row-title-text">{card.title}</span></button>');
			// The milestone is a link of its own, outside the button.
			expect(html.search(/<a\s/)).toBeGreaterThan(html.indexOf('</button>'));
			// Right-click anywhere on the row is the board's context menu.
			expect(/^<article[\s\S]*?\n>/.exec(html.trimStart())![0]).toContain('oncontextmenu={(e) => onContextMenu(e, card)}');
		});

		it('stretches the button over the row, with the milestone link and the Blocked chip above it', () => {
			const css = style();
			expect(rule(css, '.list-row')).toContain('position: relative');
			expect(rule(css, '.row-open::after')).toBe("content: ''; position: absolute; inset: 0; z-index: 0;");
			expect(rule(css, '.chip-milestone, .chip-blocked')).toBe('position: relative; z-index: 1;');
		});

		it('takes a held Enter as one press, so Bulk Select does not flicker the row', () => {
			expect(row()).toContain("if (e.key === 'Enter' && e.repeat) e.preventDefault();");
			expect(markup()).toContain('onkeydown={onKeydown}');
		});

		it('rings a focused row, and a focused selected row differently from a selected one', () => {
			const css = style();
			const selected = rule(css, '.list-row.row-selected');
			const focused = rule(css, '.list-row:has(.row-open:focus-visible)');
			const both = rule(css, '.list-row.row-selected:has(.row-open:focus-visible)');
			expect(focused).toContain('outline: 2px solid var(--accent-indigo)');
			expect(focused).not.toBe(selected);
			expect(both).toContain('box-shadow: inset 0 0 0 2px var(--accent-indigo)');
		});

		it('cuts long chip text with an ellipsis, inside a span, as an inline-flex box cannot', () => {
			expect(rule(style(), '.chip-text')).toBe('min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;');
			const html = markup();
			expect(html).toContain('<span class="chip-text">🎯 {milestoneName}</span>');
			expect(html).toContain('<span class="chip-text">{category.name}</span>');
			expect(html).toContain('<span class="chip-text">{assignee.emoji} {assignee.username}</span>');
		});
	});

	describe('the list', () => {
		const list = () => read('src/lib/components/board/ColumnListView.svelte');
		const style = () => /<style>([\s\S]*)<\/style>/.exec(list())![1];

		it('shows the keyboard’s focus on the order buttons, which app.css takes the outline off', () => {
			expect(style()).toContain('.seg button:focus-visible { outline: 2px solid var(--accent-indigo); outline-offset: -2px; }');
		});

		it('lets a long column title shrink to an ellipsis in the strip', () => {
			expect(style()).toContain('.strip-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
		});

		it('starts another column at its top', () => {
			const source = list();
			expect(source).toContain('<div class="list-view" bind:this={listEl}>');
			expect(source.replace(/\s+/g, ' ')).toContain('$effect(() => { void columnId; if (listEl) listEl.scrollTop = 0; });');
		});
	});
});
