// @vitest-environment jsdom
/**
 * The one colour picker (card 2546), `ColourSwatches` mounted alone with
 * Svelte's client runtime, as the confirm dialog's file mounts it, and in
 * two of the five places that use it.
 *
 *   - Five forms drew their own preset swatches and a native colour box: Add
 *     Column, the card's cover, the card window's New Category, the
 *     dashboard's New Category and Manage Categories. In four of them the box
 *     sat at no size, `opacity: 0` and `pointer-events: none`: a Tab stop with
 *     nothing to show. And the swatches had no names.
 *   - Now each uses `ColourSwatches`: a group named for what it colours, each
 *     swatch a button named by its colour and pressed while chosen, and the
 *     custom colour's picker laid over the ✎ swatch you see, named "Custom
 *     colour" (card 2473's pattern in Manage Categories, now shared).
 *   - Bound, a pick sets the value (the forms). With `onpick`, a pick is
 *     handed over and the value left alone (the cover, which saves each pick),
 *     the custom colour's only as its picker is closed.
 *   - The column colour menu, the dashboard's Manage Categories' quick
 *     colours and the card window's label forms use it too, presets only,
 *     and Manage Categories names its own colour boxes (the copies found
 *     beside the five, ruled into the card).
 *
 * Manage Categories' own focus and names are in
 * `tests/category-window.svelte.test.ts`. The plan is
 * `docs/planning/2546-colour-pickers-names.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import ColourSwatches from '$lib/components/ColourSwatches.svelte';
import AddColumnModal from '$lib/components/board/AddColumnModal.svelte';
import CardCoverPicker from '$lib/components/card/CardCoverPicker.svelte';
import KanbanColumnHeader from '$lib/components/board/KanbanColumnHeader.svelte';
import CategoryManager from '$lib/components/CategoryManager.svelte';
import LabelPicker from '$lib/components/LabelPicker.svelte';
import type { ColumnType } from '$lib/types';

// The dashboard's Manage Categories reloads the page's data after a change; nothing here makes one.
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }));
import { COLUMN_COLORS } from '$lib/utils/constants';
import { COVER_PRESETS } from '$lib/colours';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	document.body.replaceChildren();
});

/** Mounts `component` with these props, as a page would draw it. */
function draw<P extends Record<string, unknown>>(component: Svelte.Component<P, Record<string, never>, keyof P | ''>, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(component, { target, props: props as P }), target };
	flushSync();
	return target;
}

const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const swatchesIn = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('[role="group"] button.color-swatch')];
const pressed = (target: HTMLElement) => swatchesIn(target).filter((b) => b.getAttribute('aria-pressed') === 'true');
const customBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[type="color"]')!;

const COLOURS = ['#6366f1', '#8b5cf6', '#a855f7', '#d946ef'];

describe('ColourSwatches: named swatches, the chosen one pressed', () => {
	it('names the group and each swatch, presses the chosen one alone, and sets a bound value on a click', () => {
		let value = $state('#8b5cf6');
		const target = draw(ColourSwatches, { colours: COLOURS, label: 'Column colour', get value() { return value; }, set value(v: string) { value = v; } });

		const group = target.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-label')).toBe('Column colour');
		expect(swatchesIn(target).map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #6366f1', 'Colour #8b5cf6', 'Colour #a855f7', 'Colour #d946ef']);
		expect(swatchesIn(target).every((b) => b.type === 'button')).toBe(true);
		expect(pressed(target)).toEqual([swatchesIn(target)[1]]);

		swatchesIn(target)[3].click();
		flushSync();
		expect(value).toBe('#d946ef');
		expect(pressed(target)).toEqual([swatchesIn(target)[3]]);

		// The custom colour, bound: each step of the picker sets it, and no preset is pressed.
		customBox(target).value = '#123456';
		customBox(target).dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(value).toBe('#123456');
		expect(pressed(target)).toEqual([]);
	});

	it('lays the custom colour’s picker, named, over the ✎ swatch you see, not at no size', () => {
		const target = draw(ColourSwatches, { colours: COLOURS, label: 'Category colour', value: '#6366f1' });
		const box = customBox(target);
		expect(box.getAttribute('aria-label')).toBe('Custom colour');
		expect(box.tabIndex).toBe(0);
		expect(box.parentElement!.matches('label.color-custom-wrapper')).toBe(true);
		expect(box.parentElement!.parentElement).toBe(target.querySelector('[role="group"]'));
		const shown = box.nextElementSibling!;
		expect(shown.matches('span.color-swatch.custom')).toBe(true);
		expect(shown.getAttribute('aria-hidden')).toBe('true');
		expect(shown.textContent).toBe('✎');

		// jsdom lays nothing out, so the rule is read: the box covers its wrapper, and the ring is drawn on the swatch.
		const source = read('src/lib/components/ColourSwatches.svelte');
		const rule = /\.color-native-input \{([^}]*)\}/.exec(source)![1];
		expect(rule).toMatch(/inset: 0;.*width: 100%; height: 100%;/);
		expect(rule).not.toMatch(/width: 0|height: 0|pointer-events: none/);
		expect(source).toMatch(/\.color-native-input:focus-visible \+ \.color-swatch\.custom,\s*\.color-swatch:focus-visible \{ outline: 2px solid/);
	});

	it('with onpick, hands each pick over and leaves the value alone; the custom colour only as its picker is closed', () => {
		const picks: string[] = [];
		const target = draw(ColourSwatches, { colours: COLOURS, label: 'Cover', value: '#6366f1', customValue: '#a855f7', onpick: (c: string) => picks.push(c) });
		expect(customBox(target).value).toBe('#a855f7');

		swatchesIn(target)[2].click();
		flushSync();
		expect(picks).toEqual(['#a855f7']);
		expect(pressed(target)).toEqual([swatchesIn(target)[0]]);

		customBox(target).value = '#010203';
		customBox(target).dispatchEvent(new Event('input', { bubbles: true }));
		expect(picks).toEqual(['#a855f7']);
		customBox(target).dispatchEvent(new Event('change', { bubbles: true }));
		expect(picks).toEqual(['#a855f7', '#010203']);
	});
});

describe('the five colour forms use it (card 2546)', () => {
	const PLACES = [
		'src/lib/components/board/AddColumnModal.svelte',
		'src/lib/components/card/CardCoverPicker.svelte',
		'src/lib/components/CardModal.svelte',
		'src/lib/components/dashboard/BoardContextMenu.svelte',
		'src/lib/components/board/CategoryModal.svelte'
	];

	it('each draws ColourSwatches, named, and has no colour box or swatch copy of its own', () => {
		for (const file of PLACES) {
			const source = read(file);
			expect(source, file).toMatch(/<ColourSwatches\b[^>]*\blabel="[A-Z][a-z]+( colour)?"/);
			expect(source, file).not.toContain('type="color"');
			expect(source, file).not.toMatch(/color-native-input|color-custom-wrapper/);
		}
	});

	it('Add Column: a swatch chosen is the colour the column is added with, as before', () => {
		const added: { color: string }[] = [];
		const target = draw(AddColumnModal, { columns: [], onAdd: (data: { color: string }) => added.push(data), onClose: () => {} });
		expect(target.querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Column colour');
		expect(swatchesIn(target)).toHaveLength(COLUMN_COLORS.length);
		expect(pressed(target).map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #6366f1']);

		swatchesIn(target)[5].click();
		flushSync();
		[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Add Column')!.click();
		expect(added.map((a) => a.color)).toEqual([COLUMN_COLORS[5]]);
	});

	it('the cover: No cover first in the group, each gradient named by its ends, and a pick shown at once', () => {
		let coverUrl = $state('');
		let windowError = $state('');
		const target = draw(CardCoverPicker, {
			card: null,
			boardId: 1,
			get coverUrl() { return coverUrl; },
			set coverUrl(v: string) { coverUrl = v; },
			get windowError() { return windowError; },
			set windowError(v: string) { windowError = v; }
		});
		const group = target.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-label')).toBe('Cover');
		const none = group.firstElementChild as HTMLButtonElement;
		expect(none.title).toBe('No cover');
		expect(none.getAttribute('aria-pressed')).toBe('true');
		expect(swatchesIn(target)).toHaveLength(COVER_PRESETS.length);
		expect(swatchesIn(target)[0].getAttribute('aria-label')).toBe('Gradient #667eea to #764ba2');
		expect(swatchesIn(target)[8].getAttribute('aria-label')).toBe('Colour #6366f1');
		expect(customBox(target).value).toBe('#6366f1');

		// No card yet: the cover is the window's alone, nothing sent.
		swatchesIn(target)[0].click();
		flushSync();
		expect(coverUrl).toBe(COVER_PRESETS[0]);
		expect(none.getAttribute('aria-pressed')).toBe('false');
		expect(pressed(target)).toEqual([swatchesIn(target)[0]]);
		expect(customBox(target).value).toBe('#667eea');
	});
});

// The coordinator's ruling on card 2546: the copies found beside the five are this card's own kind.
describe('the column colour menu and the dashboard’s Manage Categories (card 2546)', () => {
	it('the column colour menu: presets only, named for the column, the column’s own pressed, a pick handed to the page', () => {
		const noop = () => {};
		const picked: [number, string][] = [];
		const column = { id: 7, boardId: 1, title: 'Review', position: 0, color: '#ec4899', wipLimit: 0, showAddCard: false, role: null, cards: [] } as ColumnType;
		const target = draw(KanbanColumnHeader, {
			column, canManage: true, editing: false, editTitle: '', editingWip: false, wipLimitInput: 0,
			sort: undefined, visibleCount: null, colorOpen: true, menuOpen: false,
			onStartRename: noop, onFinishRename: noop, onSort: noop, onAddCard: noop, onToggleDropdown: noop,
			onColor: (id: number, colour: string) => picked.push([id, colour]),
			onToggleAddCard: noop, onStartWip: noop, onSaveWip: noop, onCancelWip: noop, onDelete: noop, onCloseDropdowns: noop
		});
		const menu = target.querySelector('.color-picker-dropdown')!;
		expect(menu.querySelector('[role="group"]')!.getAttribute('aria-label')).toBe('Colour for column Review');
		expect(menu.querySelector('input[type="color"]')).toBeNull();
		expect(swatchesIn(target)).toHaveLength(COLUMN_COLORS.length);
		expect(swatchesIn(target)[0].getAttribute('aria-label')).toBe('Colour #6366f1');
		expect(pressed(target).map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #ec4899']);

		swatchesIn(target)[2].click();
		flushSync();
		// The page sets the colour and closes the menu (`setColumnColor`); the header changes neither itself.
		expect(picked).toEqual([[7, COLUMN_COLORS[2]]]);
		expect(pressed(target).map((b) => b.getAttribute('aria-label'))).toEqual(['Colour #ec4899']);
	});

	it('the dashboard’s Manage Categories names its colour boxes by what they colour', () => {
		const target = draw(CategoryManager, { categories: [{ id: 3, name: 'Ops', color: '#ef4444' }], onClose: () => {} });
		const boxes = () => [...target.querySelectorAll<HTMLInputElement>('input[type="color"]')].map((b) => b.getAttribute('aria-label'));
		expect(boxes()).toEqual(['New category colour']);

		target.querySelector<HTMLButtonElement>('button[title="Edit category"]')!.click();
		flushSync();
		expect(boxes()).toEqual(['Colour for Ops', 'New category colour']);
	});

	it('the dashboard’s Manage Categories: its quick colours are the shared picker, named, the chosen one pressed, a click the new category’s colour', () => {
		const target = draw(CategoryManager, { categories: [], onClose: () => {} });
		const quick = target.querySelector('.quick-colors [role="group"]')!;
		expect(quick.getAttribute('aria-label')).toBe('Quick colours for the new category');
		expect(quick.querySelector('input[type="color"]')).toBeNull();
		const swatches = () => [...quick.querySelectorAll<HTMLButtonElement>('button.color-swatch')];
		expect(swatches().map((b) => b.getAttribute('aria-label'))).toEqual(COLUMN_COLORS.slice(0, 8).map((c) => `Colour ${c}`));
		const newBox = target.querySelector<HTMLInputElement>('input[aria-label="New category colour"]')!;
		const chosen = () => swatches().filter((b) => b.getAttribute('aria-pressed') === 'true');
		expect(chosen()).toEqual(swatches().filter((b) => b.getAttribute('aria-label') === `Colour ${newBox.value}`));

		swatches()[4].click();
		flushSync();
		expect(newBox.value).toBe(COLUMN_COLORS[4]);
		expect(chosen()).toEqual([swatches()[4]]);
	});

	it('the card window’s labels: the new and the edit forms’ colours are the shared picker, named, the chosen one pressed', () => {
		const target = draw(LabelPicker, { cardId: 1, boardId: 1, labels: [{ id: 2, boardId: 1, name: 'Bug', color: '#ef4444' }], selected: [] });
		const link = (text: string) => [...target.querySelectorAll<HTMLButtonElement>('button.label-link')].find((b) => b.textContent?.trim() === text)!;
		const group = () => target.querySelector('.label-form [role="group"]')!;
		const chosen = () => [...group().querySelectorAll('button[aria-pressed="true"]')].map((b) => b.getAttribute('aria-label'));

		link('+ New label').click();
		flushSync();
		expect(group().getAttribute('aria-label')).toBe('New label colour');
		expect(group().querySelectorAll('button.color-swatch')).toHaveLength(COLUMN_COLORS.length);
		expect(group().querySelector('input[type="color"]')).toBeNull();
		expect(chosen()).toEqual([`Colour ${COLUMN_COLORS[0]}`]);
		group().querySelectorAll<HTMLButtonElement>('button.color-swatch')[3].click();
		flushSync();
		expect(chosen()).toEqual([`Colour ${COLUMN_COLORS[3]}`]);

		[...target.querySelectorAll<HTMLButtonElement>('button.label-btn')].find((b) => b.textContent?.trim() === 'Cancel')!.click();
		flushSync();
		link('Edit labels').click();
		flushSync();
		target.querySelector<HTMLButtonElement>('button.label-toggle')!.click();
		flushSync();
		expect(group().getAttribute('aria-label')).toBe('Colour for label Bug');
		expect(chosen()).toEqual(['Colour #ef4444']);
	});
});
