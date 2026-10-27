// @vitest-environment jsdom
/**
 * The board's Manage Categories window and the keyboard's focus (card
 * 2473), `CategoryModal` mounted alone with Svelte's client runtime, as the
 * confirm dialog's file mounts it, a button outside it standing for the More
 * menu's button that opened it.
 *
 *   - It moved no focus: the focus stayed on the page behind the overlay,
 *     Tab walked the page, and Escape did nothing. It now holds the focus as
 *     Add Column does (`holdFocus`): the name box takes it as the window
 *     opens, Tab and Shift+Tab stay on the window's own controls, Escape
 *     closes it, and the focus goes back to what opened it.
 *   - The window is named by its heading.
 *   - Its colour swatches are named by their colour, the chosen one pressed,
 *     and the custom colour's own picker is a named Tab stop laid over the
 *     ✎ swatch, no longer one at no size with nothing to show.
 *
 * Adding a category one at a time is in `tests/page-failures.test.ts`. The
 * plan is `docs/planning/2470-2473-board-keyboard.md`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import CategoryModal from '$lib/components/board/CategoryModal.svelte';
import type { CategoryType } from '$lib/types';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let opener: HTMLButtonElement;
let onClose: Mock<() => void>;

beforeEach(() => {
	onClose = vi.fn<() => void>();
	// The More menu's button, which has the focus once Manage Categories is chosen (HeaderMenu gives it back first).
	opener = document.createElement('button');
	opener.textContent = 'More';
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	close();
	document.body.replaceChildren();
});

/** Opens the window, as the board page does on Manage Categories. */
function open(categories: Partial<CategoryType>[] = []) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const props = { categories, onAdd: async () => true, onDeleteCategory: () => {}, onClose };
	drawn = { component: mount(CategoryModal, { target, props: props as never }), target };
	flushSync();
	return target;
}

/** Closes the window, as the page does by no longer drawing it. */
function close() {
	if (!drawn) return;
	unmount(drawn.component);
	drawn.target.remove();
	drawn = null;
	flushSync();
}

/** A key pressed where the focus is, bubbling to the window as a real one does; gives back whether its default was taken. */
function press(key: string, shiftKey = false): boolean {
	const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(event);
	flushSync();
	return event.defaultPrevented;
}

const nameBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('#category-name')!;
const doneButton = (target: HTMLElement) => [...target.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Done')!;
/** One macrotask turn: what the window schedules as it closes has run. */
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Manage Categories takes, holds and gives back the focus (card 2473)', () => {
	it('gives the name box the focus as it opens, and is named by its heading', () => {
		const target = open();
		expect(document.activeElement).toBe(nameBox(target));
		const dialog = target.querySelector('[role="dialog"]')!;
		const heading = target.querySelector(`#${dialog.getAttribute('aria-labelledby')}`);
		expect(heading?.textContent).toBe('Manage Categories');
	});

	it('keeps Tab and Shift+Tab on its own controls, and brings a Tab from outside back to the name box', () => {
		let target = open();
		doneButton(target).focus();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(nameBox(target));
		expect(press('Tab', true)).toBe(true);
		expect(document.activeElement).toBe(doneButton(target));

		opener.focus();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(nameBox(target));

		// With a category listed, its ✕ is the first stop the Tab from Done wraps to.
		close();
		target = open([{ id: 4, name: 'Bug', color: '#ef4444' }]);
		doneButton(target).focus();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(target.querySelector('.chip-delete'));
	});

	it('closes on Escape, from the name box as from anywhere in it', () => {
		const target = open();
		press('Escape');
		doneButton(target).focus();
		press('Escape');
		expect(onClose).toHaveBeenCalledTimes(2);
	});

	it('gives the focus back to what opened it as it closes', async () => {
		const target = open();
		// Done pressed: the focus is on the window as the page stops drawing it.
		doneButton(target).focus();
		close();
		await macrotask();
		expect(document.activeElement).toBe(opener);
	});
});

describe('Manage Categories names its colours (card 2473’s follow-up)', () => {
	it('names each swatch by its colour, the chosen one pressed', () => {
		const target = open();
		const swatches = () => [...target.querySelectorAll<HTMLButtonElement>('.color-row button.color-swatch')];
		expect(swatches()).toHaveLength(8);
		expect(swatches()[0].getAttribute('aria-label')).toBe('Colour #6366f1');
		expect(swatches().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false']);
		swatches()[3].click();
		flushSync();
		expect(swatches()[3].getAttribute('aria-label')).toBe('Colour #d946ef');
		expect(swatches().filter((b) => b.getAttribute('aria-pressed') === 'true')).toEqual([swatches()[3]]);
	});

	it('makes the custom colour’s picker a named Tab stop over the ✎ swatch, not one at no size', () => {
		const target = open();
		const picker = target.querySelector<HTMLInputElement>('input[type="color"]')!;
		expect(picker.getAttribute('aria-label')).toBe('Custom colour');
		expect(picker.tabIndex).toBe(0);
		expect(picker.nextElementSibling?.getAttribute('aria-hidden')).toBe('true');
		const rule = /\.color-native-input \{([^}]*)\}/.exec(readFileSync(join(process.cwd(), 'src/lib/components/board/CategoryModal.svelte'), 'utf8'))![1];
		expect(rule).toContain('width: 100%');
		expect(rule).not.toMatch(/width: 0|pointer-events: none/);
	});
});
