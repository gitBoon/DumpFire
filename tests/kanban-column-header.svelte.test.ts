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
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Svelte from 'svelte';
import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
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
		expect(page).toContain("ondblclick={(e: MouseEvent) => { if ((isTodoColumnTitle(column.title) || column.showAddCard) && !(e.target as HTMLElement).closest('.kanban-card')) openNewCardModal(column.id); }}");
		const hint = page.indexOf('<span class="empty-hint">Double-click to add one</span>');
		expect(hint).toBeGreaterThan(0);
		expect(page.slice(page.lastIndexOf('{#if', hint), hint)).toMatch(/^\{#if isTodoColumnTitle\(column\.title\) \|\| column\.showAddCard\}/);

		expect(header).toMatch(/import \{[^}]*\bisTodoColumnTitle\b[^}]*\} from '\$lib\/column-role';/);
		expect(header).toContain('{#if isTodoColumnTitle(column.title) || column.showAddCard}');
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
