// @vitest-environment jsdom
/**
 * Which board columns offer Add Task (card 2280, slice B5a of card 2012's
 * part B), mounted with Svelte's client runtime, as
 * `tests/xp-leaderboard.svelte.test.ts` is: this file alone takes jsdom, by
 * the comment above.
 *
 * The board page chose its add-card columns with
 * `title.toLowerCase() === 'to do'`: no trim, and no "Todo", which All Tasks
 * and the All To Do page already count as To Do (`isTodoColumnTitle` in
 * `src/lib/column-role.ts`, card 2240). The header's Add Task and its menu's
 * Show Add Task tick, and the page's double-click to add, its empty column's
 * hint and its Show Add Task switch, now ask `isTodoColumnTitle`. A column
 * whose Add Task switch is on offers it whatever it is called, as before.
 *
 * Not changed, by the plan's ruling 3: whether a move into a To Do column
 * skips the still-blocked warning (`warnIfStillBlocked`), which keeps its own
 * test of the title.
 *
 * And the board's Options column on its header, its menu's keyboard hold, and
 * the Add Column window (milestone 22, slice S1b; card 2527, which made the
 * Options column part of every delivery board): see the last three blocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Svelte from 'svelte';
import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
import AddColumnModal from '$lib/components/board/AddColumnModal.svelte';
import ColumnListView from '$lib/components/board/ColumnListView.svelte';
import CfdChart from '$lib/components/board/CfdChart.svelte';
import { optionsSuffix } from '$lib/column-role';
import { NARROW_WIDTH, scrollPastFoldedStrip } from '$lib/board/board-view';
import type { ColumnType } from '$lib/types';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const BOARD_PAGE = 'src/routes/board/[id]/+page.svelte';
const HEADER = 'src/lib/components/board/KanbanColumnHeader.svelte';

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
});

const noop = () => {};

/** Mounts the header of a column with this title, its menu open to someone who manages the board. */
function draw(title: string, showAddCard = false): HTMLElement {
	const column = { id: 1, boardId: 1, title, position: 0, color: '#6366f1', wipLimit: 0, showAddCard, cards: [] } as unknown as ColumnType;
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(KanbanColumnHeader, {
		target,
		props: {
			column, canManage: true, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
			sort: undefined, visibleCount: null, colorOpen: false, menuOpen: true,
			onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
			onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
			onDelete: noop, onCloseDropdowns: noop
		}
	});
	drawn = { component, target };
	flushSync();
	return target;
}

/** Whether the header offers Add Task, and what its menu's Show Add Task says. */
function offers(title: string, showAddCard = false) {
	const target = draw(title, showAddCard);
	const tick = [...target.querySelectorAll('.column-menu-item')].find((item) => item.textContent?.includes('Show Add Task'));
	const result = { addTask: target.querySelector('.add-card-badge') !== null, ticked: tick?.textContent?.trim().startsWith('✓') ?? null };
	unmount(drawn!.component);
	drawn!.target.remove();
	drawn = null;
	return result;
}

describe('Add Task on a column’s header (card 2280, slice B5a)', () => {
	it('is offered on a column called To Do or Todo, in any capitals and with space around it', () => {
		for (const title of ['To Do', 'Todo', 'TO DO', 'todo', 'TODO', ' To Do ', '  todo\t']) {
			expect(offers(title), JSON.stringify(title)).toEqual({ addTask: true, ticked: true });
		}
	});

	it('is not offered on another column whose switch is off, To-Do included, as All Tasks does not count it', () => {
		for (const title of ['To-Do', 'Backlog', 'In Progress', 'Todos', 'To Do Soon']) {
			expect(offers(title), title).toEqual({ addTask: false, ticked: false });
		}
	});

	it('is offered on any column whose switch is on', () => {
		for (const title of ['To-Do', 'Backlog', 'In Progress']) {
			expect(offers(title, true), title).toEqual({ addTask: true, ticked: true });
		}
	});
});

describe('the board page’s To Do columns (card 2280, slice B5a)', () => {
	const page = readFileSync(join(process.cwd(), BOARD_PAGE), 'utf8');
	const header = readFileSync(join(process.cwd(), HEADER), 'utf8');

	it('asks isTodoColumnTitle for the double-click to add, the empty column’s hint and the Show Add Task switch', () => {
		expect(page).toMatch(/import \{[^}]*\bisTodoColumnTitle\b[^}]*\} from '\$lib\/column-role';/);
		expect(page).toContain('const showAddCard = !(column.showAddCard || isTodoColumnTitle(column.title));');
		// The Options column offers it too, whatever it is called (milestone 22), and every column of an ideas board (card 2463).
		expect(page).toContain("ondblclick={(e: MouseEvent) => { if ((isUpstreamColumn(column, boardState.board.kind) || isTodoColumnTitle(column.title) || column.showAddCard) && !(e.target as HTMLElement).closest('.kanban-card')) openNewCardModal(column.id); }}");
		const hint = page.indexOf('<span class="empty-hint">Double-click to add one</span>');
		expect(hint).toBeGreaterThan(0);
		expect(page.slice(page.lastIndexOf('{#if', hint), hint)).toMatch(/^\{#if isUpstreamColumn\(column, boardState\.board\.kind\) \|\| isTodoColumnTitle\(column\.title\) \|\| column\.showAddCard\}/);

		expect(header).toMatch(/import \{[^}]*\bisTodoColumnTitle\b[^}]*\} from '\$lib\/column-role';/);
		expect(header).toContain('const upstream = $derived(isUpstreamColumn(column, boardKind));');
		expect(header).toContain('const addsCards = $derived(upstream || isTodoColumnTitle(column.title) || column.showAddCard);');
		expect(header).toContain('{#if addsCards}');
		expect(header).toContain("{column.showAddCard || isTodoColumnTitle(column.title) ? '✓' : '○'} Show Add Task");
	});

	it('leaves the still-blocked warning’s own test of the title as it was (ruling 3)', () => {
		expect(header).not.toMatch(/toLowerCase\(\) === 'to do'/);
		const left = [...page.matchAll(/^.*toLowerCase\(\) === 'to do'.*$/gm)].map((line) => line[0].trim());
		expect(left).toEqual(["if (toColumnName.toLowerCase() === 'to do') return;"]);
		const warn = /function warnIfStillBlocked\([\s\S]*?\r?\n\t\}\r?\n/.exec(page)?.[0] ?? '';
		expect(warn).toContain("if (toColumnName.toLowerCase() === 'to do') return;");
		expect(warn).not.toContain('isTodoColumnTitle');
	});
});

/**
 * The board's Options column on its header, and the Add Column window
 * (milestone 22, card 2459, slice S1b; card 2527). Every delivery board has
 * its Options column, called Options, made with the board: it reads
 * "Options", with no "(Options)" after it (R10), which only a role column
 * still carrying another title shows, until the start-up step renames it. It
 * has no WIP limit and always offers "Add idea". It is not renamed or deleted
 * (R9), so its menu offers neither, and there is no "Make this the Options
 * column…" or "Stop being the Options column" anywhere (O6).
 */
describe('the Options column on its header (milestone 22)', () => {
	type Drawn = { target: HTMLElement; collapsed: number; renamed: number[]; deleted: number[] };

	function drawColumn(column: Partial<ColumnType> & { title: string }, props: { boardKind?: string; menuOpen?: boolean } = {}): Drawn {
		const full = { id: 1, boardId: 1, position: 0, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [], ...column } as ColumnType;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const result: Drawn = { target, collapsed: 0, renamed: [], deleted: [] };
		const component = mount(KanbanColumnHeader, {
			target,
			props: {
				column: full, canManage: true, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
				sort: undefined, visibleCount: null, colorOpen: false, menuOpen: props.menuOpen ?? true,
				boardKind: props.boardKind ?? 'delivery',
				onCollapse: () => result.collapsed++,
				onStartRename: (c: ColumnType) => result.renamed.push(c.id), onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
				onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
				onDelete: (id: number) => result.deleted.push(id), onCloseDropdowns: noop
			}
		});
		drawn = { component, target };
		flushSync();
		return result;
	}

	const items = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('.column-menu-item')];
	const item = (target: HTMLElement, text: string) => items(target).find((b) => b.textContent?.includes(text)) ?? null;
	const close = () => {
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
	};

	it('reads "Options", with no "(Options)" after it, no WIP limit, Add idea and a way back to the strip (R10)', () => {
		const { target } = drawColumn({ title: 'Options', role: 'options', wipLimit: 3, cards: [{ id: 1 }, { id: 2 }] as never });

		expect(target.querySelector('.column-title')?.textContent?.trim()).toBe('Options');
		expect(target.querySelector('.options-suffix')).toBeNull();
		expect(target.querySelector('.column-count')?.textContent).toBe('2');
		expect(target.querySelector('.wip-limit-label')).toBeNull();
		expect(target.querySelector('.add-card-badge')?.textContent?.trim()).toBe('Add idea');
		expect(item(target, 'WIP Limit')).toBeNull();
		expect(item(target, 'Show Add Task')).toBeNull();
		expect(target.querySelector('.options-collapse')).not.toBeNull();
	});

	it('reads "Ideas (Options)" for a role column still carrying another title, the "(Options)" not part of it', () => {
		const { target } = drawColumn({ title: 'Ideas', role: 'options' });
		expect(target.querySelector('.column-title')?.textContent?.trim()).toBe('Ideas (Options)');
		expect(target.querySelector('.options-suffix')?.textContent).toBe(' (Options)');
	});

	it('folds to the strip from its header, the arrow saying the column is open (R14)', () => {
		const result = drawColumn({ title: 'Options', role: 'options' });
		const fold = result.target.querySelector<HTMLButtonElement>('.options-collapse')!;
		expect(fold.getAttribute('aria-expanded')).toBe('true');
		fold.click();
		expect(result.collapsed).toBe(1);
	});

	it('offers no rename and no delete on the Options column, by its menu or its title; its colour, sort and fold stay (R9)', () => {
		const options = drawColumn({ title: 'Options', role: 'options', cards: [{ id: 1 }] as never });
		expect(item(options.target, 'Rename')).toBeNull();
		expect(item(options.target, 'Delete column')).toBeNull();
		expect(options.target.querySelector('.column-menu-item.danger')).toBeNull();
		// Its menu starts at the sort, with nothing below it.
		expect(items(options.target).map((b) => b.textContent?.trim())).toEqual(['↑ Oldest first', '↓ Newest first', '⚡ Priority', '🏷 Category', '👤 Assignee']);
		expect(options.target.querySelector('.column-menu-dropdown .menu-divider')).toBeNull();
		expect(options.target.querySelector('[title="Change color"]')).not.toBeNull();
		expect(options.target.querySelector('.options-collapse')).not.toBeNull();
		const title = options.target.querySelector<HTMLElement>('.column-title')!;
		// Not a button and out of the Tab order, though the page can still focus it (a Send's focusColumn).
		expect(title.getAttribute('role')).toBeNull();
		expect(title.getAttribute('tabindex')).toBe('-1');
		title.click();
		expect(options.renamed).toEqual([]);
		close();

		// An ordinary column keeps all of it.
		const ordinary = drawColumn({ title: 'Backlog' });
		expect(item(ordinary.target, 'Rename')).not.toBeNull();
		expect(item(ordinary.target, 'WIP Limit')).not.toBeNull();
		expect(item(ordinary.target, 'Show Add Task')).not.toBeNull();
		item(ordinary.target, 'Delete column')!.click();
		expect(ordinary.deleted).toEqual([1]);
		ordinary.target.querySelector<HTMLElement>('.column-title')!.click();
		expect(ordinary.renamed).toEqual([1]);
	});

	it('shows no rename box on the Options column even while the page is renaming it', () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		const column = { id: 1, boardId: 1, title: 'Options', position: 0, color: '#6366f1', wipLimit: 0, showAddCard: false, role: 'options', cards: [] } as ColumnType;
		drawn = {
			component: mount(KanbanColumnHeader, {
				target,
				props: {
					column, canManage: true, editing: true, editTitle: 'Options', editingWip: false, wipLimitInput: 0,
					sort: undefined, visibleCount: null, colorOpen: false, menuOpen: false,
					onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
					onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
					onDelete: noop, onCloseDropdowns: noop
				}
			}),
			target
		};
		flushSync();
		expect(target.querySelector('.column-title-input')).toBeNull();
		expect(target.querySelector('.column-title')?.textContent?.trim()).toBe('Options');
	});

	it('offers no way to make or stop an Options column, on any column (O6)', () => {
		for (const [title, role, boardKind] of [['Backlog', null, 'delivery'], ['Options', 'options', 'delivery'], ['Shaping', null, 'ideas']] as const) {
			drawColumn({ title, role, cards: [] }, { boardKind });
			expect(item(drawn!.target, 'Options column'), title).toBeNull();
			close();
		}
		const header = readFileSync(join(process.cwd(), HEADER), 'utf8');
		expect(header).not.toMatch(/onMakeOptions|onStopOptions|hasOptionsColumn|Make this the Options column|Stop being the Options column/);
	});

	it('takes the focus into its menu as it opens, closes on Escape, and hands the focus back to the button', async () => {
		const column = { id: 1, boardId: 1, title: 'Backlog', position: 0, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [] } as ColumnType;
		const props = $state({
			column, canManage: true, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
			sort: undefined, visibleCount: null, colorOpen: false, menuOpen: false,
			onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
			onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
			onDelete: noop, onCloseDropdowns: () => (props.menuOpen = false)
		});
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(KanbanColumnHeader, { target, props }), target };
		flushSync();
		const button = target.querySelector<HTMLButtonElement>('[aria-haspopup="true"]')!;
		button.focus();

		props.menuOpen = true;
		flushSync();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement?.textContent?.trim()).toBe('Rename');

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		flushSync();
		expect(target.querySelector('.column-menu-dropdown')).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.activeElement).toBe(button);
	});
});

describe('the Add Column window (milestone 22)', () => {
	type Added = { title: string; position: string; color: string };

	function drawWindow(columns: Partial<ColumnType>[]) {
		const added: Added[] = [];
		let closed = 0;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(AddColumnModal, {
			target,
			props: {
				columns: columns.map((c, i) => ({ id: i + 1, boardId: 1, position: i, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [], title: `Column ${i}`, ...c })) as ColumnType[],
				onAdd: (data: Added) => added.push(data),
				onClose: () => closed++
			}
		});
		drawn = { component, target };
		flushSync();
		return { target, added, closed: () => closed };
	}

	const press = (target: HTMLElement, text: string) =>
		[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!.click();

	it('adds an ordinary column only: no Options choice, every delivery board having its Options column (card 2527)', () => {
		const { target, added } = drawWindow([{ title: 'Options', role: 'options' }, { title: 'To Do' }]);

		expect(target.querySelector('h2')?.textContent).toBe('Add Column');
		expect(target.querySelector('input[type="checkbox"]')).toBeNull();
		expect(target.textContent).not.toContain('Options column');
		expect(target.querySelector<HTMLInputElement>('#col-name')!.placeholder).toBe('e.g. Review, Testing...');
		press(target, 'Add Column');
		expect(added).toEqual([{ title: 'New Column', position: 'end', color: '#6366f1' }]);
	});

	it('offers no place left of the Options column: "After "Options"" is the start, with no "(Options)" after it (R10)', () => {
		const { target } = drawWindow([{ title: 'Options', role: 'options' }, { title: 'To Do' }]);
		const choices = [...target.querySelectorAll('option')].map((o) => o.textContent);

		expect(choices).toEqual(['After "Options"', 'After "To Do"', 'At the end']);
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		// A role column still carrying another title says what it is.
		const renamed = drawWindow([{ title: 'Ideas', role: 'options' }, { title: 'To Do' }]);
		expect([...renamed.target.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['After "Ideas" (Options)', 'After "To Do"', 'At the end']);
	});

	it('offers "At the start" on a board with no Options column (an ideas board, or one read before the start-up step)', () => {
		const { target } = drawWindow([{ title: 'Shaping' }]);
		expect([...target.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['At the start', 'After "Shaping"', 'At the end']);
	});

	it('takes the focus to the name as it opens, and closes on Escape', () => {
		const { target, closed } = drawWindow([{ title: 'To Do' }]);

		expect(document.activeElement).toBe(target.querySelector('#col-name'));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(closed()).toBe(1);
	});

	it('is opened by the board page as an ordinary column window, with no Options props (O6)', () => {
		const page = readFileSync(join(process.cwd(), BOARD_PAGE), 'utf8');
		expect(page).not.toMatch(/canAddOptions|asOptions|addColumnAsOptions|newColumnRole/);
		expect(page).toMatch(/<AddColumnModal\s+columns=\{boardState\.columns\}\s+onAdd=\{\(\{ title, position, color \}\) => \{/);
	});
});

/**
 * The list view with an Options column (milestone 22, the S1b review's U4):
 * the Options column is the first button of its strip, "Ideas (Options)" with
 * its count, and the list opens on To Do, not on the options.
 */
describe('the list view with an Options column (milestone 22)', () => {
	function drawList(columns: Partial<ColumnType>[]) {
		const changed: unknown[] = [];
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(ColumnListView, {
			target,
			props: {
				columns: columns.map((c, i) => ({ id: i + 1, boardId: 1, position: i, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [], title: `Column ${i}`, ...c })) as ColumnType[],
				categories: [],
				filter: { search: '', assigneeId: null, hideBlocked: false },
				blockerCount: () => 0,
				blockerTooltip: () => '',
				milestoneNameById: new Map(),
				cardTokens: {},
				tick: 0,
				selectedCards: new Set<number>(),
				selectionMode: false,
				choice: { view: 'list', columnId: null, order: 'priority' },
				onOpen: noop,
				onContextMenu: noop,
				onChange: (choice: unknown) => changed.push(choice)
			}
		});
		drawn = { component, target };
		flushSync();
		return { target, changed };
	}

	it('shows the Options column first, with "(Options)" and its count, and opens on To Do', () => {
		const { target } = drawList([
			{ title: 'Ideas', role: 'options', cards: [{ id: 1 }, { id: 2 }] as never },
			{ title: 'Doing' },
			{ title: 'To Do', cards: [{ id: 3 }] as never }
		]);
		const buttons = [...target.querySelectorAll<HTMLButtonElement>('.strip-btn')];

		expect(buttons.map((b) => [b.querySelector('.strip-title')?.textContent, b.querySelector('.strip-count')?.textContent])).toEqual([
			['Ideas (Options)', '2'],
			['Doing', '0'],
			['To Do', '1']
		]);
		expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
	});

	it('shows the Options column called Options with no "(Options)" after it (card 2527, R10)', () => {
		const { target } = drawList([{ title: 'Options', role: 'options', cards: [{ id: 1 }] as never }, { title: 'To Do' }]);
		const first = target.querySelector('.strip-btn .strip-title');
		expect(first?.textContent).toBe('Options');
		expect(first?.querySelector('.strip-options')).toBeNull();
	});

	it('opens on the first column that is not the Options column when there is no To Do', () => {
		const { target } = drawList([{ title: 'Ideas', role: 'options' }, { title: 'Doing' }]);
		const pressed = target.querySelector('.strip-btn[aria-pressed="true"] .strip-title');

		expect(pressed?.textContent).toBe('Doing');
		expect(target.querySelector('.list-empty')?.textContent).toBe('No cards in Doing');
	});

	it('opens on no column when the Options column is the only one, and asks for one; chosen, it is shown (card 2527, K1)', () => {
		const { target, changed } = drawList([{ title: 'Options', role: 'options', cards: [{ id: 1 }] as never }]);

		expect(target.querySelector('.strip-btn[aria-pressed="true"]')).toBeNull();
		expect(target.querySelector('.list-empty')?.textContent).toBe('Choose a column above.');
		target.querySelector<HTMLButtonElement>('.strip-btn')!.click();
		expect(changed).toEqual([{ view: 'list', columnId: 1, order: 'priority' }]);
	});
});

/**
 * The Options column on the screens once every delivery board has one (card
 * 2527, slice S2): no "Options (Options)" anywhere (R10), the strip saying it
 * is folded (R14), and a narrow screen opening the board on To Do, past the folded
 * strip (R13).
 */
describe('the Options column on every board’s screens (card 2527)', () => {
	const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

	it('says "(Options)" after a title only where the title does not say it already (R10)', () => {
		expect(optionsSuffix({ title: 'Options', role: 'options' })).toBe('');
		expect(optionsSuffix({ title: ' options ', role: 'options' })).toBe('');
		expect(optionsSuffix({ title: 'Ideas', role: 'options' })).toBe(' (Options)');
		expect(optionsSuffix({ title: 'Options', role: null })).toBe('');
		expect(optionsSuffix({ title: 'Backlog', role: null })).toBe('');
	});

	it('asks it on every screen that names a column, and none says " (Options)" for itself (R10)', () => {
		for (const file of [
			'src/lib/components/board/KanbanColumnHeader.svelte',
			'src/routes/board/[id]/+page.svelte',
			'src/lib/components/board/ColumnListView.svelte',
			'src/lib/components/board/BulkActionBar.svelte',
			'src/lib/components/board/ContextMenu.svelte',
			'src/lib/components/tasks/MoveCardModal.svelte',
			'src/lib/components/board/AddColumnModal.svelte'
		]) {
			const source = read(file);
			expect(source, file).toContain('optionsSuffix(');
			expect(source, file).not.toMatch(/['"] \(Options\)['"]/);
		}
		// The flow diagram's legend knows a column only as upstream, and asks the title.
		expect(read('src/lib/components/board/CfdChart.svelte')).toContain("col.upstream && upstreamCount < columns.length && !isOptionsTitle(col.title) ? ' (Options)' : ''");
	});

	it('draws the flow diagram’s legend "Options", and "Ideas (Options)" for a role column with another title (R10)', () => {
		const legend = (title: string) => {
			const target = document.createElement('div');
			document.body.appendChild(target);
			const component = mount(CfdChart, {
				target,
				props: {
					columns: [{ id: 9, title, color: '#888888', upstream: true }, { id: 1, title: 'To Do', color: '#6366f1', upstream: false }],
					data: [{ date: '2026-06-20', columns: [{ columnId: 9, count: 1 }, { columnId: 1, count: 1 }] }, { date: '2026-06-21', columns: [{ columnId: 9, count: 1 }, { columnId: 1, count: 2 }] }]
				}
			});
			flushSync();
			const items = [...target.querySelectorAll('.cfd-legend-item')].map((el) => el.textContent?.replace(/\s+/g, ' ').trim());
			unmount(component);
			target.remove();
			return items;
		};
		expect(legend('Options')).toEqual(['Options', 'To Do']);
		expect(legend('Ideas')).toEqual(['Ideas (Options)', 'To Do']);
	});

	it('marks the strip folded and the header’s arrow open, and names the column in the strip’s label only when it is not called Options (R14, R10)', () => {
		const page = read(BOARD_PAGE);
		expect(page).toMatch(/class="options-strip"\s+onclick=\{\(\) => setOptionsOpen\(true\)\}\s+title="Open the Options column"\s+aria-expanded="false"/);
		expect(page).toContain("aria-label=\"Open the Options column{isOptionsTitle(column.title) ? '' : `, ${column.title}`}: {column.cards.length}");
		expect(read(HEADER)).toContain('aria-label="Collapse the Options column" aria-expanded="true"');
	});

	/** A row of columns whose places are `lefts`, the strip first, scrolled `scrolled` already. */
	function row(lefts: { strip?: number | null; first?: number | null }, scrolled = 0) {
		const wrapper = document.createElement('div');
		const place = (el: HTMLElement, left: number) => (el.getBoundingClientRect = () => ({ left: left - scrolled }) as DOMRect);
		if (lefts.strip !== null) {
			const strip = document.createElement('div');
			strip.className = 'kanban-column options-column options-collapsed';
			place(strip, lefts.strip ?? 16);
			wrapper.appendChild(strip);
		}
		if (lefts.first !== null) {
			const first = document.createElement('div');
			first.className = 'kanban-column';
			place(first, lefts.first ?? 84);
			wrapper.appendChild(first);
		}
		const second = document.createElement('div');
		second.className = 'kanban-column';
		place(second, 500);
		wrapper.appendChild(second);
		return wrapper;
	}

	it('scrolls a narrow screen’s row of columns to the first committed column, past the folded strip (R13)', () => {
		const wrapper = row({ strip: 16, first: 84 });
		expect(scrollPastFoldedStrip(wrapper, true)).toBe(true);
		expect(wrapper.scrollLeft).toBe(68);

		// Already scrolled somewhere: the same place.
		const scrolled = row({ strip: 16, first: 84 }, 30);
		scrollPastFoldedStrip(scrolled, true);
		expect(scrolled.scrollLeft).toBe(68);
	});

	it('scrolls nothing above the narrow width, with the strip open, with no strip or no other column (R13)', () => {
		const wide = row({});
		expect(scrollPastFoldedStrip(wide, false)).toBe(false);
		expect(wide.scrollLeft).toBe(0);
		const open = row({});
		open.querySelector('.options-collapsed')!.classList.remove('options-collapsed');
		expect(scrollPastFoldedStrip(open, true)).toBe(false);
		expect(scrollPastFoldedStrip(row({ strip: null }), true)).toBe(false);
		const alone = document.createElement('div');
		alone.innerHTML = '<div class="kanban-column options-column options-collapsed"></div>';
		expect(scrollPastFoldedStrip(alone, true)).toBe(false);
		expect(scrollPastFoldedStrip(null, true)).toBe(false);
	});

	it('is done by the board page as a board opens at a narrow width, the strip folded, and not as it is folded later or on a same-board navigation (R13; the S2 review\'s P1 and P2)', () => {
		expect(NARROW_WIDTH).toBe(768);
		const page = read(BOARD_PAGE);
		expect(page).toContain("const boardShown = $derived.by(() => boardView.view !== 'list');");
		const effect = /\$effect\(\(\) => \{\s+void optionsBoardId;\s+if \(!boardShown\) return;\s+untrack\(\(\) => \{\s+if \(!optionsColumn \|\| optionsOpen\) return;\s+void nextTick\(\)\.then\(\(\) => scrollPastFoldedStrip\(document\.querySelector<HTMLElement>\('\.columns-wrapper'\), window\.matchMedia\(`\(max-width: \$\{NARROW_WIDTH\}px\)`\)\.matches\)\);\s+\}\);\s+\}\);/.exec(page);
		expect(effect).not.toBeNull();
		// Every navigation reassigns boardView: the effect reads only the derived boolean and the board's id.
		expect(effect![0]).not.toContain('boardView');
		// The columns scroll sideways from the same 768 pixels.
		expect(page).toContain('@media (max-width: 768px)');
	});

	it('keeps an effect that reads a derived boolean still when the object behind it is replaced with the same view (P1)', () => {
		// The rule the page relies on, run with Svelte's own runes: a reassigned
		// boardView whose view is unchanged does not run the effect again.
		let runs = 0;
		let boardView = $state({ view: 'board' as 'board' | 'list', columnId: null as number | null });
		const boardShown = $derived(boardView.view !== 'list');
		const stop = $effect.root(() => {
			$effect(() => {
				void boardShown;
				runs++;
			});
		});
		flushSync();
		expect(runs).toBe(1);
		boardView = { view: 'board', columnId: 3 };
		flushSync();
		expect(runs).toBe(1);
		boardView = { view: 'list', columnId: 3 };
		flushSync();
		expect(runs).toBe(2);
		stop();
	});
});
