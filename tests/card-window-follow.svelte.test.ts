// @vitest-environment jsdom
/**
 * The card window following its card (card 2280, slice B5d of card 2012's
 * part B), mounted with Svelte's client runtime, as
 * `tests/card-window-keys.svelte.test.ts` is, so that its follow `$effect`
 * is run by Svelte itself. Named `.svelte.test.ts` so that its props can be
 * `$state`, as the board page's are: the window's card is handed afresh as
 * each read of the board draws it.
 *
 *   - On the board page (given the controller's `edits`), each typed field
 *     the user has not touched shows the card's value as the card changes;
 *     one typed in stays as typed.
 *   - Given no `edits` the fields are filled once, whatever the card is
 *     handed afterwards. (All Tasks, All To Do and the plan page pass the
 *     controller's `edits` too since card 2281's C3a-1 review:
 *     `tests/card-window-pages.test.ts`.)
 *
 * What a save of each sends is in `tests/card-window.test.ts`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import { CardWindow, WindowEdits } from '$lib/board/card-window.svelte';
import type { CardType } from '$lib/types';

vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});

const CardModal = (await import('$lib/components/CardModal.svelte')).default;

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let onSave: Mock<(data: unknown) => void>;

beforeEach(() => {
	onSave = vi.fn<(data: unknown) => void>();
	// The window's own reads on open: empty lists.
	vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('/dependencies') ? { blockedBy: [], blocks: [] } : url.includes('/tokens') ? null : []) }) as Response));
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
});

const opened = {
	id: 7, columnId: 1, categoryId: null, title: 'Plan', description: 'Old notes', position: 0, priority: 'low',
	colorTag: null, dueDate: null, createdAt: '2026-10-20 09:00:00', updatedAt: '2026-10-20 09:00:00',
	subtasks: [], labelIds: [], pinned: false, onHoldNote: '', businessValue: null, subBoards: [],
	assignees: [], archivedAt: null, coverUrl: null, milestoneId: null, summary: null, theme: null
} as unknown as CardType;

/** Mounts the window on `opened`, its props `$state`, and gives them back to change. */
function draw(edits?: WindowEdits) {
	const props = $state({ card: opened, categories: [], labels: [], boardId: 1, boardUsers: [], onSave, onClose: () => {}, edits });
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(CardModal, { target, props: props as never }), target };
	flushSync();
	return { props, target };
}

const titleBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('#card-title')!;
const descriptionBox = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('#card-desc')!;
const priorityChip = (target: HTMLElement) => target.querySelector('.chip')!.textContent!.trim();

/** Types `text` into a box, as `bind:value` hears it. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the card window follows its card where nothing was typed (card 2280, slice B5d)', () => {
	it('on the board page shows the card’s new values in the fields not touched, and keeps a title typed in', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Plan', 'Old notes', 'Low']);
		// The window gives the title the focus as it opens, and a box with the
		// focus is held (the cases below): left, untyped in.
		expect(document.activeElement).toBe(titleBox(target));
		titleBox(target).blur();
		flushSync();

		// A read of the board hands the window the card someone else changed.
		props.card = { ...opened, title: 'Theirs', description: 'Their notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Theirs', 'Their notes', 'High']);

		// The user types a title; the next read brings another title and description.
		type(titleBox(target), 'Mine');
		props.card = { ...opened, title: 'Theirs again', description: 'Third notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value]).toEqual(['Mine', 'Third notes']);
		expect(edits.touched).toEqual(new Set(['title']));

		// What the window hands its save is what it shows.
		target.querySelector<HTMLButtonElement>('.btn-create')!.click();
		flushSync();
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Mine', description: 'Third notes', priority: 'high' });
	});

	// The B5d review: a value brought into the box being typed in moved its caret to the end.
	it('holds the field whose box has the focus: a read leaves its text and caret, and once it is left the new value shows', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		const box = descriptionBox(target);
		box.focus();
		box.setSelectionRange(3, 3);
		flushSync();
		props.card = { ...opened, description: 'Their notes' } as CardType;
		flushSync();
		expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(['Old notes', 3, 3]);

		box.blur();
		flushSync();
		expect(box.value).toBe('Their notes');
		// The focus alone was no touch.
		expect(edits.touched.size).toBe(0);
	});

	it('holds the title the window gives the focus as it opens, and follows it once it is left: the focus alone is no touch', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		titleBox(target).focus();
		flushSync();
		props.card = { ...opened, title: 'Theirs' } as CardType;
		flushSync();
		expect(titleBox(target).value).toBe('Plan');
		descriptionBox(target).focus();
		flushSync();
		expect(titleBox(target).value).toBe('Theirs');
		expect(edits.touched.size).toBe(0);
	});

	// The B5d review: the board page draws the window inside `{#key cardWindow.edits}`,
	// which needs the controller's `edits` to be state.
	it('the controller’s edits is state: what reads it is told when a window is opened or closed', () => {
		const board = $state({ columns: [{ id: 1, cards: [opened] }], labels: [], boardUsers: [] });
		const cardWindow = new CardWindow(board as never, 1);
		let seen = 0;
		const stop = $effect.root(() => {
			$effect(() => {
				void cardWindow.edits;
				seen++;
			});
		});
		flushSync();
		cardWindow.openCard(opened);
		flushSync();
		cardWindow.openCard(opened);
		flushSync();
		cardWindow.close();
		flushSync();
		stop();
		expect(seen).toBe(4);
	});

	it('on All Tasks, All To Do and the plan page (no edits) keeps the fields it was filled with, as before', () => {
		const { props, target } = draw();
		props.card = { ...opened, title: 'Theirs', description: 'Their notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Plan', 'Old notes', 'Low']);

		target.querySelector<HTMLButtonElement>('.btn-create')!.click();
		flushSync();
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Plan', description: 'Old notes', priority: 'low' });
	});
});
