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
 * the Add Column window that makes one (milestone 22, slice S1b): see the
 * last two blocks.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Svelte from 'svelte';
import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
import AddColumnModal from '$lib/components/board/AddColumnModal.svelte';
import ColumnListView from '$lib/components/board/ColumnListView.svelte';
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
 * The board's Options column on its header, and the Add Column window that
 * makes one (milestone 22, card 2459, slice S1b). The Options column reads
 * "Ideas (Options)": the "(Options)" is not part of the title (ruling k). It
 * has no WIP limit and always offers "Add idea". Someone who manages a
 * delivery board with no Options column is offered "Make this the Options
 * column…" on a column whose title means nothing else (ruling x), and "Stop
 * being the Options column" while the Options column is empty.
 */
describe('the Options column on its header (milestone 22)', () => {
	type Drawn = { target: HTMLElement; made: ColumnType[]; stopped: ColumnType[]; collapsed: number };

	function drawColumn(
		column: Partial<ColumnType> & { title: string },
		props: { boardKind?: string; hasOptionsColumn?: boolean; menuOpen?: boolean } = {}
	): Drawn {
		const full = { id: 1, boardId: 1, position: 0, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [], ...column } as ColumnType;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const result: Drawn = { target, made: [], stopped: [], collapsed: 0 };
		const component = mount(KanbanColumnHeader, {
			target,
			props: {
				column: full, canManage: true, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
				sort: undefined, visibleCount: null, colorOpen: false, menuOpen: props.menuOpen ?? true,
				boardKind: props.boardKind ?? 'delivery',
				hasOptionsColumn: props.hasOptionsColumn ?? full.role === 'options',
				onMakeOptions: (c: ColumnType) => result.made.push(c),
				onStopOptions: (c: ColumnType) => result.stopped.push(c),
				onCollapse: () => result.collapsed++,
				onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
				onColor: noop, onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop,
				onDelete: noop, onCloseDropdowns: noop
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

	it('reads "Ideas (Options)", with no WIP limit, and offers Add idea and a way back to the strip', () => {
		const { target } = drawColumn({ title: 'Ideas', role: 'options', wipLimit: 3, cards: [{ id: 1 }, { id: 2 }] as never });

		expect(target.querySelector('.column-title')?.textContent?.trim()).toBe('Ideas (Options)');
		expect(target.querySelector('.options-suffix')?.textContent).toBe(' (Options)');
		expect(target.querySelector('.column-count')?.textContent).toBe('2');
		expect(target.querySelector('.wip-limit-label')).toBeNull();
		expect(target.querySelector('.add-card-badge')?.textContent?.trim()).toBe('Add idea');
		expect(item(target, 'WIP Limit')).toBeNull();
		expect(item(target, 'Show Add Task')).toBeNull();
		expect(target.querySelector('.options-collapse')).not.toBeNull();
	});

	it('collapses to the strip from its header', () => {
		const result = drawColumn({ title: 'Ideas', role: 'options' });
		result.target.querySelector<HTMLButtonElement>('.options-collapse')!.click();
		expect(result.collapsed).toBe(1);
	});

	it('offers "Stop being the Options column" only while it is empty', () => {
		const empty = drawColumn({ title: 'Ideas', role: 'options' });
		const stop = item(empty.target, 'Stop being the Options column')!;
		expect(stop.disabled).toBe(false);
		stop.click();
		expect(empty.stopped.map((c) => c.id)).toEqual([1]);
		close();

		const holding = drawColumn({ title: 'Ideas', role: 'options', cards: [{ id: 1 }] as never });
		expect(item(holding.target, 'Stop being the Options column')!.disabled).toBe(true);
		expect(item(holding.target, 'Make this the Options column')).toBeNull();
	});

	it('offers "Make this the Options column…" on a delivery board with none, for a column whose title means nothing else', () => {
		const offered = drawColumn({ title: 'Backlog', cards: [{ id: 1 }] as never });
		item(offered.target, 'Make this the Options column')!.click();
		expect(offered.made.map((c) => c.title)).toEqual(['Backlog']);
		// An ordinary column keeps its WIP limit and Show Add Task.
		expect(item(offered.target, 'WIP Limit')).not.toBeNull();
		expect(item(offered.target, 'Show Add Task')).not.toBeNull();
		close();

		for (const title of ['To Do', 'On Hold', 'Waiting', 'Complete', 'done']) {
			drawColumn({ title });
			expect(item(drawn!.target, 'Make this the Options column'), title).toBeNull();
			close();
		}
		drawColumn({ title: 'Backlog' }, { hasOptionsColumn: true });
		expect(item(drawn!.target, 'Make this the Options column'), 'a board that has one').toBeNull();
		close();
		drawColumn({ title: 'Backlog' }, { boardKind: 'ideas' });
		expect(item(drawn!.target, 'Make this the Options column'), 'an ideas board').toBeNull();
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
	type Added = { title: string; position: string; color: string; role: 'options' | null };

	function drawWindow(columns: Partial<ColumnType>[], props: { canAddOptions?: boolean; asOptions?: boolean } = {}) {
		const added: Added[] = [];
		let closed = 0;
		const target = document.createElement('div');
		document.body.appendChild(target);
		const component = mount(AddColumnModal, {
			target,
			props: {
				columns: columns.map((c, i) => ({ id: i + 1, boardId: 1, position: i, color: '#6366f1', wipLimit: 0, showAddCard: false, role: null, cards: [], title: `Column ${i}`, ...c })) as ColumnType[],
				canAddOptions: props.canAddOptions ?? false,
				asOptions: props.asOptions ?? false,
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

	it('adds an Options column called Ideas when opened as one, asking no position', () => {
		const { target, added } = drawWindow([{ title: 'To Do' }], { canAddOptions: true, asOptions: true });

		expect(target.querySelector('h2')?.textContent).toBe('Add Options Column');
		expect(target.querySelector('select')).toBeNull();
		press(target, 'Add Options Column');
		expect(added).toEqual([{ title: 'Ideas', position: 'end', color: '#6366f1', role: 'options' }]);
	});

	it('offers "Options column" only where the board may have one, and an ordinary column by default', () => {
		const offered = drawWindow([{ title: 'To Do' }], { canAddOptions: true });
		const box = offered.target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(box.checked).toBe(false);
		press(offered.target, 'Add Column');
		expect(offered.added[0]).toMatchObject({ title: 'New Column', role: null });
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		const notOffered = drawWindow([{ title: 'To Do' }], { asOptions: true });
		expect(notOffered.target.querySelector('input[type="checkbox"]')).toBeNull();
		press(notOffered.target, 'Add Column');
		expect(notOffered.added[0]).toMatchObject({ role: null });
	});

	it('offers no place left of the Options column: "After … (Options)" is the start', () => {
		const { target } = drawWindow([{ title: 'Ideas', role: 'options' }, { title: 'To Do' }]);
		const choices = [...target.querySelectorAll('option')].map((o) => o.textContent);

		expect(choices).toEqual(['After "Ideas" (Options)', 'After "To Do"', 'At the end']);
	});

	it('takes the focus to the name as it opens, and closes on Escape', () => {
		const { target, closed } = drawWindow([{ title: 'To Do' }]);

		expect(document.activeElement).toBe(target.querySelector('#col-name'));
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(closed()).toBe(1);
	});

	it('is offered as Add Options Column only to someone who can edit the board (the S1b review’s U11)', () => {
		const page = readFileSync(join(process.cwd(), BOARD_PAGE), 'utf8');
		expect(page).toContain("const canAddOptions = $derived(boardState.board.kind !== 'ideas' && optionsColumn === null && boardState.canEdit);");
		expect(page).toMatch(/<BoardMoreMenu[\s\S]*?\{canAddOptions\}/);
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

	it('opens on the first column that is not the Options column when there is no To Do', () => {
		const { target } = drawList([{ title: 'Ideas', role: 'options' }, { title: 'Doing' }]);
		const pressed = target.querySelector('.strip-btn[aria-pressed="true"] .strip-title');

		expect(pressed?.textContent).toBe('Doing');
		expect(target.querySelector('.list-empty')?.textContent).toBe('No cards in Doing');
	});
});
