// @vitest-environment jsdom
/**
 * The app's confirm dialog taking, keeping and giving back the keyboard's
 * focus (card 2353), `ConfirmModal` mounted alone with Svelte's client
 * runtime, a button outside it standing for the one that opened it.
 *
 *   - It moved no focus: the focus stayed on whatever opened it, behind the
 *     overlay, Tab walked the page behind, and nothing gave it back when the
 *     dialog closed. Cancel now takes it as the dialog opens, Tab and
 *     Shift+Tab stay on the dialog's two buttons, and a Tab from outside the
 *     dialog comes back to Cancel.
 *   - The dialog's message is tied to it by `aria-describedby`, so a screen
 *     reader that lands on Cancel reads what is being confirmed (F5).
 *   - On close the focus goes back to the opener after one macrotask, and
 *     only if the opener is still in the page and nothing else has taken the
 *     focus: a card window the confirm opened (the board page's Cannot
 *     Complete, Open Card) focuses its title in a microtask, and keeps it.
 *
 * The plan is `docs/planning/cards-2337-2338-2341-2342-2353-card-window.md`
 * (section 3.1, decisions 1 to 4, tests 3 to 7).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import ConfirmModal from '$lib/components/ConfirmModal.svelte';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let opener: HTMLButtonElement;
let onConfirm: Mock<() => void>;
let onCancel: Mock<() => void>;

beforeEach(() => {
	onConfirm = vi.fn<() => void>();
	onCancel = vi.fn<() => void>();
	// The button a page's confirm is opened from, with the focus, as a click or Enter leaves it.
	opener = document.createElement('button');
	opener.textContent = 'Delete Team';
	document.body.appendChild(opener);
	opener.focus();
});

afterEach(() => {
	close();
	document.body.replaceChildren();
});

/** Opens the dialog, as a page does on its button. */
function open(extra: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const props = { title: 'Delete Team', message: 'The team will be deleted.', onConfirm, onCancel, ...extra };
	drawn = { component: mount(ConfirmModal, { target, props: props as never }), target };
	flushSync();
	return target;
}

/** Closes the dialog, as a page does by no longer drawing it. */
function close() {
	if (!drawn) return;
	unmount(drawn.component);
	drawn.target.remove();
	drawn = null;
	flushSync();
}

const cancelButton = (target: HTMLElement) => [...target.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Cancel')!;
const confirmButton = (target: HTMLElement) => [...target.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Delete')!;

/** A Tab (or Shift+Tab) pressed where the focus is, bubbling as a real one does; gives back whether its default was taken. */
function tab(shiftKey = false): boolean {
	const key = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(key);
	flushSync();
	return key.defaultPrevented;
}

/** One macrotask turn: what the dialog schedules as it closes has run. */
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the confirm dialog takes the focus as it opens (card 2353)', () => {
	it('gives Cancel the focus, and ties its message to the dialog', () => {
		const target = open();
		expect(document.activeElement).toBe(cancelButton(target));

		const dialog = target.querySelector('[role="dialog"]')!;
		const message = target.querySelector('.confirm-message')!;
		expect(message.id).not.toBe('');
		expect(dialog.getAttribute('aria-describedby')).toBe(message.id);
	});

	it('names no message when it has none', () => {
		const target = open({ message: '' });
		expect(target.querySelector('[role="dialog"]')!.hasAttribute('aria-describedby')).toBe(false);
		expect(document.activeElement).toBe(cancelButton(target));
	});
});

describe('the confirm dialog keeps the focus on its two buttons (card 2353)', () => {
	it('Tab on the confirm button goes to Cancel, and Shift+Tab on Cancel to the confirm button, each taking the default; Tab on Cancel is the browser’s own', () => {
		const target = open();
		confirmButton(target).focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));

		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(confirmButton(target));

		// From Cancel forwards the next button is the confirm button: left to the browser.
		cancelButton(target).focus();
		expect(tab()).toBe(false);
		expect(document.activeElement).toBe(cancelButton(target));
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it('Tab with the focus outside the dialog (a click on its overlay leaves it on the page) brings it to Cancel', () => {
		const target = open();
		(document.activeElement as HTMLElement).blur();
		expect(document.activeElement).toBe(document.body);
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));

		opener.focus();
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(cancelButton(target));
	});
});

describe('the confirm dialog gives the focus back as it closes (card 2353)', () => {
	it('to the button that opened it, after one macrotask, when the focus was on the dialog', async () => {
		const target = open();
		confirmButton(target).focus();
		close();
		// Not at once, nor in a microtask: a window the confirm opened may focus its title then.
		await Promise.resolve();
		expect(document.activeElement).not.toBe(opener);
		await macrotask();
		expect(document.activeElement).toBe(opener);
	});

	it('to nothing when something else took the focus as it closed (a card window’s title), or when its opener is gone; and nothing throws', async () => {
		// Passes on a dialog that gives nothing back: it guards against a give-back that beats the title.
		let target = open();
		confirmButton(target).focus();
		const title = document.createElement('input');
		document.body.appendChild(title);
		close();
		// As Svelte's `autofocus` does: in a microtask, if the focus is then on the body.
		queueMicrotask(() => {
			if (document.activeElement === document.body) title.focus();
		});
		await macrotask();
		expect(document.activeElement).toBe(title);

		// The opener the action removed: a deleted comment's Delete button, say.
		opener.focus();
		target = open();
		confirmButton(target).focus();
		opener.remove();
		close();
		await macrotask();
		expect(document.activeElement).toBe(document.body);
	});
});
