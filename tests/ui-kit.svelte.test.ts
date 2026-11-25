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
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import PageShell from '$lib/components/ui/PageShell.svelte';
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

	it('2. with a rail, draws the page first and the rail after it in an aside, in a grid', () => {
		const target = draw(PageShell, {
			title: 'Decisions',
			rail: html('<div data-said="rail">Filters</div>'),
			railPosition: 'start',
			railLabel: 'Filters',
			children: html('<div data-said="page">Rows</div>')
		});

		expect(target.querySelector('header')?.textContent).toContain('Decisions');
		const main = target.querySelector('main')!;
		expect(main.classList.contains('ui-shell-grid')).toBe(true);
		expect(main.classList.contains('ui-shell-full')).toBe(true);
		const aside = main.querySelector('aside')!;
		expect(aside.getAttribute('aria-label')).toBe('Filters');
		expect(aside.querySelector('[data-said="rail"]')).not.toBeNull();
		const page = main.querySelector('[data-said="page"]')!;
		expect(aside.contains(page)).toBe(false);
		// The page before the rail in the document, whichever side the rail is drawn on.
		expect(page.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
