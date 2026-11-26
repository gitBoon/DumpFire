// @vitest-environment jsdom
/**
 * The UI kit, mounted (card 3074, the plan's cases 1 to 6): PageShell, with
 * and without a rail; Button as a link and as a button; Badge by a decision's
 * status; Alert live and not; and `tickUp` where the reader asks for less
 * motion. Each is mounted alone with Svelte's client runtime, as the other
 * `.svelte.test.ts` files mount theirs, its snippets made by
 * `createRawSnippet`.
 *
 * The source checks (the tokens in app.css, and no global CSS in the kit
 * outside a .ui- class) are in `tests/ui-kit.test.ts`. The plan is
 * `docs/planning/card-3074-page-shell-and-ui-kit.md`.
 *
 * Card 3078 (D1 to D5 of `docs/planning/card-3078-dialogs-on-kit.md`): the
 * kit's Dialog frame, its name and role on the box, and its wiring of the
 * app's focus hold (`holdFocus`): the first focus, Tab held inside, Escape,
 * a press on the backdrop, and the focus handed back as it closes.
 *
 * Card 3087 (T1): a captioned Table's frame is a focusable region named by
 * its caption unless `region={false}`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

// A bare 'svelte' gives the server's runtime, whose tick the Theme menu cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import Alert from '$lib/components/ui/Alert.svelte';
import Badge from '$lib/components/ui/Badge.svelte';
import Button from '$lib/components/ui/Button.svelte';
import Dialog from '$lib/components/ui/Dialog.svelte';
import PageShell from '$lib/components/ui/PageShell.svelte';
import Table from '$lib/components/ui/Table.svelte';
import { tickUp } from '$lib/components/ui/motion';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { createRawSnippet, flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	vi.unstubAllGlobals();
});

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

describe('PageShell', () => {
	it('1. draws the logo link home, the crumbs, the actions and the Theme menu, a main of the width asked for, and no h1 of its own', () => {
		const target = draw(PageShell, {
			width: 'reading',
			crumbs: html('<span data-said="crumb">Decisions</span>'),
			actions: html('<a href="/decisions/tour" data-action="tour">How it works</a>'),
			children: html('<section data-said="page"><h2>Inside</h2></section>')
		});

		const header = target.querySelector('header')!;
		const logo = header.querySelector<HTMLAnchorElement>('a[href="/"]')!;
		expect(logo).not.toBeNull();
		expect(logo.textContent).toContain('DumpFire');
		expect(header.querySelector('[data-said="crumb"]')?.textContent).toBe('Decisions');
		expect(header.querySelector('[data-action="tour"]')).not.toBeNull();
		const theme = header.querySelector<HTMLButtonElement>('button[title="Change theme"]')!;
		expect(theme).not.toBeNull();
		expect(theme.getAttribute('aria-haspopup')).toBe('menu');

		const main = target.querySelector('main')!;
		expect(main.classList.contains('ui-shell-reading')).toBe(true);
		expect(main.classList.contains('ui-shell-grid')).toBe(false);
		expect(main.querySelector('[data-said="page"]')).not.toBeNull();
		expect(target.querySelector('aside')).toBeNull();
		expect(target.querySelector('h1')).toBeNull();
	});

	// Card 3076: the document follows what is drawn, so a rail at the start (navigation, filters) is met first by the keyboard.
	it.each([
		{ railPosition: 'end', railFirst: false },
		{ railPosition: 'start', railFirst: true }
	])('2. with a rail at the $railPosition, draws it in an aside in a grid, before the page in the document only at the start', ({ railPosition, railFirst }) => {
		const target = draw(PageShell, {
			title: 'Decisions',
			rail: html('<div data-said="rail">Filters</div>'),
			railPosition,
			railLabel: 'Filters',
			children: html('<div data-said="page">Rows</div>')
		});

		expect(target.querySelector('header')?.textContent).toContain('Decisions');
		const main = target.querySelector('main')!;
		expect(main.classList.contains('ui-shell-grid')).toBe(true);
		expect(main.classList.contains('ui-shell-full')).toBe(true);
		expect(main.classList.contains('ui-shell-rail-start')).toBe(railFirst);
		const aside = main.querySelector('aside')!;
		expect(aside.getAttribute('aria-label')).toBe('Filters');
		expect(aside.querySelector('[data-said="rail"]')).not.toBeNull();
		const page = main.querySelector('[data-said="page"]')!;
		expect(aside.contains(page)).toBe(false);
		const asideFollows = (page.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
		expect(asideFollows).toBe(!railFirst);
	});

	it('T1 (card 3075). bare: the header shows DumpFire as text with no link, no Theme menu, and no crumbs or actions even when given; main as without it', () => {
		const target = draw(PageShell, {
			bare: true,
			crumbs: html('<span data-said="crumb">Board A</span>'),
			actions: html('<button type="button" data-action="edit">Edit</button>'),
			rail: html('<div data-said="rail">Facts</div>'),
			railLabel: 'About this decision',
			children: html('<section data-said="page"><h2>Inside</h2></section>')
		});

		const header = target.querySelector('header')!;
		expect(header.textContent).toContain('DumpFire');
		expect(header.querySelector('a')).toBeNull();
		expect(header.querySelector('button[title="Change theme"]')).toBeNull();
		expect(header.querySelector('[data-said="crumb"]')).toBeNull();
		expect(header.querySelector('[data-action="edit"]')).toBeNull();
		expect(target.querySelector('[href]')).toBeNull();

		const main = target.querySelector('main')!;
		expect(main.classList.contains('ui-shell-full')).toBe(true);
		expect(main.classList.contains('ui-shell-grid')).toBe(true);
		expect(main.querySelector('[data-said="page"]')).not.toBeNull();
		expect(main.querySelector('aside[aria-label="About this decision"] [data-said="rail"]')).not.toBeNull();
	});
});

describe('Button', () => {
	it('3. is a link with an href, a type="button" button without one or the type given, passes data-* through and is disabled when told', () => {
		const link = draw(Button, { href: '/decisions/new', 'data-action': 'new', children: html('<span>New</span>') });
		const a = link.querySelector('a')!;
		expect(a.getAttribute('href')).toBe('/decisions/new');
		expect(a.dataset.action).toBe('new');
		expect(link.querySelector('button')).toBeNull();

		const plain = draw(Button, { 'data-action': 'save', children: html('<span>Save</span>') }).querySelector('button')!;
		expect(plain.getAttribute('type')).toBe('button');
		expect(plain.dataset.action).toBe('save');
		expect(plain.disabled).toBe(false);

		const submit = draw(Button, { type: 'submit', disabled: true, name: 'step', value: 'send', target: '_blank', children: html('<span>Send</span>') }).querySelector('button')!;
		expect(submit.getAttribute('type')).toBe('submit');
		expect(submit.disabled).toBe(true);
		// A button's own attributes go to a button alone, a link's to a link alone.
		expect([submit.name, submit.value, submit.hasAttribute('target')]).toEqual(['step', 'send', false]);

		// A disabled link: no address, no click, out of the Tab order, and said to be disabled.
		const clicked = vi.fn();
		const off = draw(Button, { href: '/decisions/new', disabled: true, name: 'x', onclick: clicked, title: 'Nothing to send', children: html('<span>New</span>') }).querySelector('a')!;
		expect(off.hasAttribute('href')).toBe(false);
		expect(off.getAttribute('aria-disabled')).toBe('true');
		expect(off.tabIndex).toBe(-1);
		expect(off.hasAttribute('name')).toBe(false);
		expect(off.title).toBe('Nothing to send');
		off.click();
		expect(clicked).not.toHaveBeenCalled();
	});

	it('T2 (card 3075). bind:ref holds the element drawn: the button, and with an href the link', () => {
		const held: { ref: HTMLElement | null } = { ref: null };
		draw(Button, {
			get ref() {
				return held.ref;
			},
			set ref(value: HTMLElement | null) {
				held.ref = value;
			},
			'data-action': 'supersede',
			children: html('<span>Supersede…</span>')
		});
		expect(held.ref).toBeInstanceOf(HTMLButtonElement);
		expect((held.ref as HTMLElement).dataset.action).toBe('supersede');

		const linked: { ref: HTMLElement | null } = { ref: null };
		draw(Button, {
			href: '/decisions/5/results',
			get ref() {
				return linked.ref;
			},
			set ref(value: HTMLElement | null) {
				linked.ref = value;
			},
			children: html('<span>Results</span>')
		});
		expect(linked.ref).toBeInstanceOf(HTMLAnchorElement);
		expect(linked.ref!.getAttribute('href')).toBe('/decisions/5/results');
	});
});

describe('Badge', () => {
	it('4. shows awaiting_ruling as the warning variant with its data-status, and a status it does not know as default', () => {
		const known = draw(Badge, { status: 'awaiting_ruling' }).querySelector('span')!;
		expect(known.classList.contains('ui-badge-warning')).toBe(true);
		expect(known.dataset.status).toBe('awaiting_ruling');
		expect(known.textContent?.trim()).toBe('Awaiting ruling');

		const unknown = draw(Badge, { status: 'archived' }).querySelector('span')!;
		expect(unknown.classList.contains('ui-badge-default')).toBe(true);
		expect(unknown.dataset.status).toBe('archived');
	});
});

describe('Alert', () => {
	it('5. is role="alert" when live, and has no role otherwise', () => {
		const live = draw(Alert, { live: true, variant: 'destructive', title: html('<span>Not saved</span>'), children: html('<span>Try again.</span>') });
		expect(live.querySelector('.ui-alert')?.getAttribute('role')).toBe('alert');
		expect(live.textContent).toContain('Not saved');
		expect(live.textContent).toContain('Try again.');

		const still = draw(Alert, { children: html('<span>Read only.</span>') });
		expect(still.querySelector('.ui-alert')?.hasAttribute('role')).toBe(false);
	});
});

describe('Table (card 3087)', () => {
	const ROWS = html('<tbody><tr><th scope="row">Abstained</th><td data-label="Votes">1</td></tr></tbody>');

	it('T1. a captioned table is a focusable region named by its caption by default; with region={false} its frame is neither, the caption kept', () => {
		const framed = draw(Table, { caption: 'Round 2: 3 responded', 'data-table': 'tally', children: ROWS });
		const frame = framed.querySelector<HTMLElement>('.ui-table-frame')!;
		expect([frame.getAttribute('role'), frame.getAttribute('tabindex')]).toEqual(['region', '0']);
		expect(document.getElementById(frame.getAttribute('aria-labelledby')!)!.textContent).toBe('Round 2: 3 responded');
		expect(framed.querySelector('caption')!.closest('table')!.dataset.table).toBe('tally');

		const plain = draw(Table, { caption: 'Round 2: 3 responded', region: false, stack: true, 'data-table': 'tally', children: ROWS });
		const bare = plain.querySelector<HTMLElement>('.ui-table-frame')!;
		expect(['role', 'tabindex', 'aria-labelledby'].map((name) => bare.getAttribute(name))).toEqual([null, null, null]);
		const table = plain.querySelector<HTMLTableElement>('table')!;
		expect([table.caption?.textContent, table.dataset.table, table.classList.contains('ui-table-stack')]).toEqual(['Round 2: 3 responded', 'tally', true]);
	});
});

describe('tickUp', () => {
	const motion = (reduce: boolean) =>
		vi.stubGlobal(
			'matchMedia',
			vi.fn((query: string) => ({ matches: reduce && query === '(prefers-reduced-motion: reduce)', media: query, addEventListener() {}, removeEventListener() {} }))
		);

	it('6. writes the final number at once where the reader asks for less motion, and otherwise counts from 0 until a new value is written', () => {
		motion(true);
		const frames = vi.fn(() => 1);
		vi.stubGlobal('requestAnimationFrame', frames);

		const node = document.createElement('p');
		node.textContent = '42';
		const action = tickUp(node, 42);
		expect(node.textContent).toBe('42');
		expect(frames).not.toHaveBeenCalled();
		action.update?.(57);
		expect(node.textContent).toBe('57');
		action.destroy?.();

		// With motion: 0 first, a frame asked for; a new value cancels the count and is written at once.
		motion(false);
		const cancelled = vi.fn();
		vi.stubGlobal('cancelAnimationFrame', cancelled);
		const counting = document.createElement('p');
		counting.textContent = '42';
		const text = counting.firstChild;
		const count = tickUp(counting, 42);
		expect(counting.textContent).toBe('0');
		expect(counting.firstChild).toBe(text);
		expect(frames).toHaveBeenCalledTimes(1);
		count.update?.(57);
		expect(cancelled).toHaveBeenCalledWith(1);
		expect(counting.textContent).toBe('57');
		count.destroy?.();
	});
});

describe('Dialog (card 3078)', () => {
	/** The button a page's dialog is opened from, with the focus, as a click or Enter leaves it. */
	let opener: HTMLButtonElement;

	beforeEach(() => {
		opener = document.createElement('button');
		opener.textContent = 'Open';
		document.body.appendChild(opener);
		opener.focus();
	});

	afterEach(() => opener.remove());

	/** Draws a dialog with a body and, unless told otherwise, a footer of Cancel and Save; gives back the box. */
	function open(props: Record<string, unknown> = {}): HTMLElement {
		const target = draw(Dialog, {
			title: 'Import Database',
			children: html('<div data-said="body"><p>Choose a file.</p></div>'),
			footer: html('<div data-said="footer"><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="save">Save</button></div>'),
			...props
		});
		return target.querySelector<HTMLElement>('.ui-dialog')!;
	}

	/** Closes the last dialog drawn, as a page does by no longer drawing it. */
	function close() {
		const last = drawn.pop()!;
		unmount(last.component);
		last.target.remove();
		flushSync();
	}

	/** A key pressed where the focus is, bubbling as a real one does; gives back whether its default was taken. */
	function press(key: string, shiftKey = false): boolean {
		const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
		(document.activeElement ?? document.body).dispatchEvent(event);
		flushSync();
		return event.defaultPrevented;
	}

	const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

	/** A press on an element as a pointer makes it: down, then the click. */
	function pressOn(target: HTMLElement) {
		target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		target.click();
		flushSync();
	}

	it('D1. the box, not the backdrop, is the modal dialog, named by its title and described by its description; aria-label, role, titleLevel, class and footerClass as given; no footer without one', () => {
		const box = open({ description: 'The file replaces every board.', class: 'confirm-modal', footerClass: 'modal-actions' });
		const overlay = box.parentElement!;
		expect(overlay.classList.contains('ui-dialog-overlay')).toBe(true);
		expect(overlay.getAttribute('role')).toBe('presentation');
		expect(overlay.hasAttribute('aria-modal')).toBe(false);

		expect(box.getAttribute('role')).toBe('dialog');
		expect(box.getAttribute('aria-modal')).toBe('true');
		expect(box.getAttribute('tabindex')).toBe('-1');
		const title = box.querySelector('h2')!;
		expect(title.textContent).toBe('Import Database');
		expect(box.getAttribute('aria-labelledby')).toBe(title.id);
		expect(box.hasAttribute('aria-label')).toBe(false);
		const description = box.querySelector('.ui-dialog-description')!;
		expect(description.textContent).toBe('The file replaces every board.');
		expect(box.getAttribute('aria-describedby')).toBe(description.id);
		expect(box.classList.contains('confirm-modal')).toBe(true);
		expect(box.querySelector('.ui-dialog-footer')!.classList.contains('modal-actions')).toBe(true);
		expect(box.querySelector('.ui-dialog-body [data-said="body"]')).not.toBeNull();
		close();

		// Named by its aria-label alone; an alert dialog with an h3; no footer, and nothing describing it, where none is given.
		const alert = open({ 'aria-label': 'Reset done', role: 'alertdialog', titleLevel: 3, footer: undefined });
		expect(alert.getAttribute('role')).toBe('alertdialog');
		expect(alert.getAttribute('aria-label')).toBe('Reset done');
		expect(alert.hasAttribute('aria-labelledby')).toBe(false);
		expect(alert.hasAttribute('aria-describedby')).toBe(false);
		expect(alert.querySelector('h3')?.textContent).toBe('Import Database');
		expect(alert.querySelector('h2')).toBeNull();
		expect(alert.querySelector('.ui-dialog-footer')).toBeNull();
	});

	it('D2. gives the first focus to the first enabled field, else the footer’s first button, else what initialFocus names, else the box', () => {
		let box = open({ children: html('<div><button type="button" data-action="help">Help</button><input data-said="off" disabled /><input data-said="name" /></div>') });
		expect(document.activeElement).toBe(box.querySelector('[data-said="name"]'));
		close();

		box = open();
		expect(document.activeElement).toBe(box.querySelector('[data-action="cancel"]'));
		close();

		box = open({ initialFocus: '[data-action="save"]' });
		expect(document.activeElement).toBe(box.querySelector('[data-action="save"]'));
		close();

		// Nothing to focus in it, or a selector that finds nothing: the box itself.
		box = open({ footer: undefined });
		expect(document.activeElement).toBe(box);
		close();
		box = open({ initialFocus: '.not-here' });
		expect(document.activeElement).toBe(box);
	});

	it('D3. holds Tab inside: the last stop to the first, Shift+Tab the first to the last, and a Tab from outside back to the first focus', () => {
		const box = open({ initialFocus: '[data-action="save"]' });
		const cancel = box.querySelector<HTMLElement>('[data-action="cancel"]')!;
		const save = box.querySelector<HTMLElement>('[data-action="save"]')!;

		expect(document.activeElement).toBe(save);
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(cancel);
		expect(press('Tab', true)).toBe(true);
		expect(document.activeElement).toBe(save);
		// Between its stops the browser's own Tab.
		cancel.focus();
		expect(press('Tab')).toBe(false);

		opener.focus();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(save);
	});

	it('D4. runs onEscape once on Escape and onBackdrop on a press on the backdrop alone; without them each does nothing, and while paused Escape is left alone', () => {
		const onEscape = vi.fn();
		const onBackdrop = vi.fn();
		let box = open({ onEscape, onBackdrop });
		press('Escape');
		expect(onEscape).toHaveBeenCalledTimes(1);

		pressOn(box.querySelector<HTMLElement>('[data-said="body"]')!);
		pressOn(box);
		expect(onBackdrop).not.toHaveBeenCalled();
		pressOn(box.parentElement!);
		expect(onBackdrop).toHaveBeenCalledTimes(1);
		expect(onEscape).toHaveBeenCalledTimes(1);
		close();

		// Neither given: Escape and a press on the backdrop do nothing, and nothing throws.
		box = open();
		expect(() => {
			press('Escape');
			pressOn(box.parentElement!);
		}).not.toThrow();
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(onBackdrop).toHaveBeenCalledTimes(1);
		close();

		// Paused, as under a dialog opened over it: its Escape is the top one's.
		open({ onEscape, paused: true });
		press('Escape');
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it('D6. takes a press that went down in the box and came up on the backdrop (a drag to select text) as no press on the backdrop', () => {
		const onBackdrop = vi.fn();
		const box = open({ onBackdrop });
		const overlay = box.parentElement!;
		// The click's target is where the press went down and came up in common: the backdrop.
		box.querySelector<HTMLElement>('[data-said="body"]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		overlay.click();
		expect(onBackdrop).not.toHaveBeenCalled();
		overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
		overlay.click();
		expect(onBackdrop).toHaveBeenCalledTimes(1);
	});

	it('D5. hands the focus back as it closes, after one macrotask: to the opener, or to what returnTo names', async () => {
		open();
		close();
		await Promise.resolve();
		expect(document.activeElement).not.toBe(opener);
		await macrotask();
		expect(document.activeElement).toBe(opener);

		const named = document.createElement('button');
		document.body.appendChild(named);
		open({ returnTo: () => named });
		close();
		await macrotask();
		expect(document.activeElement).toBe(named);
		named.remove();
	});
});
