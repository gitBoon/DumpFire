// @vitest-environment jsdom
/**
 * The theme menu on every page, and help tips a screen reader announces
 * (cards 2471 and 2516).
 *
 *   - Card 2471: `ThemePicker.svelte` had no Escape, no arrow keys and no
 *     `aria-haspopup` or `aria-expanded`. The pages still on it draw the theme
 *     as the dashboard does, a `HeaderMenu` holding `ThemeMenuItems`, and the
 *     picker is deleted. HeaderMenu's keys are mounted and tried in
 *     `tests/header-menus.svelte.test.ts`; here the source is read.
 *   - Card 2516: `InfoTip.svelte` put `aria-describedby` on its wrapper only
 *     while open, and pointed it at a panel drawn only while open: with
 *     `focusable={false}` the focus is on an inner control, which was never
 *     described, and with `focusable` the description came after the focus.
 *     InfoTip is mounted under jsdom with Svelte's client runtime (as
 *     `tests/xp-leaderboard.svelte.test.ts` is) and its snippets made by
 *     `createRawSnippet`; it is named `.svelte.test.ts` so that a prop can be
 *     `$state` and changed while it is drawn.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import { get } from 'svelte/store';
import InfoTip from '$lib/components/InfoTip.svelte';
import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';
import { theme } from '$lib/stores/theme';

// The browser's runtime, by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { createRawSnippet, flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** Every file under a folder, its path from the repository's root with forward slashes. */
function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(join(ROOT, dir))) {
		const path = `${dir}/${name}`;
		if (statSync(join(ROOT, path)).isDirectory()) out.push(...filesUnder(path));
		else out.push(relative(ROOT, join(ROOT, path)).replaceAll('\\', '/'));
	}
	return out;
}

describe('the theme as a menu on every page (card 2471)', () => {
	const pages = [
		'src/lib/components/tasks/AllTasksHeader.svelte',
		'src/routes/account/+page.svelte',
		'src/routes/admin/+page.svelte',
		'src/routes/archived/+page.svelte',
		'src/routes/audit/+page.svelte',
		'src/routes/reports/+page.svelte',
		'src/routes/teams/+page.svelte',
		'src/routes/todo/+page.svelte'
	];

	it('ThemePicker is gone, and no file under src names it', () => {
		expect(existsSync(join(ROOT, 'src/lib/components/ThemePicker.svelte'))).toBe(false);
		const naming = filesUnder('src').filter((file) => /\.(svelte|ts|js)$/.test(file) && read(file).includes('ThemePicker'));
		expect(naming).toEqual([]);
	});

	it.each(pages)('%s draws the theme as a HeaderMenu holding ThemeMenuItems, with no heading of their own', (file) => {
		const source = read(file);
		expect(source).toContain("import HeaderMenu from '$lib/components/HeaderMenu.svelte';");
		expect(source).toContain("import ThemeMenuItems from '$lib/components/ThemeMenuItems.svelte';");
		// The theme's own menu, its items inside it, its button showing the theme in use.
		const menu = source.indexOf('<HeaderMenu label="Theme"');
		const items = source.indexOf('<ThemeMenuItems heading={false} />', menu);
		const end = source.indexOf('</HeaderMenu>', menu);
		expect(menu).toBeGreaterThan(-1);
		expect(items).toBeGreaterThan(menu);
		expect(end).toBeGreaterThan(items);
		expect(source.slice(menu, end)).toContain('triggerTitle="Change theme"');
		expect(source.slice(menu, end)).toContain('{themeIcon($theme)}');
	});
});

describe('ThemeMenuItems with and without its heading (card 2471, the review)', () => {
	let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

	afterEach(() => {
		if (drawn) {
			unmount(drawn.component);
			drawn.target.remove();
			drawn = null;
		}
		theme.set('light');
	});

	function draw(props: Record<string, unknown>): HTMLElement {
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(ThemeMenuItems as never, { target, props: props as never }), target };
		flushSync();
		return target;
	}

	it('in a More menu, as the dashboard and the board draw it, a "Theme" heading names the group of items', () => {
		const target = draw({});
		const label = target.querySelector<HTMLElement>('.hm-label')!;
		expect(label.textContent).toBe('Theme');
		const group = target.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-labelledby')).toBe(label.id);
		expect(group.querySelectorAll('[role="menuitemradio"]')).toHaveLength(17);
	});

	it('with heading={false}, in a menu of its own, the 17 items alone: no heading, no group', () => {
		const target = draw({ heading: false });
		expect(target.querySelector('.hm-label')).toBeNull();
		expect(target.querySelector('[role="group"]')).toBeNull();
		expect(target.textContent).not.toMatch(/^\s*Theme/);
		const items = [...target.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
		expect(items).toHaveLength(17);
		expect(items.every((item) => item.parentElement === target)).toBe(true);
		// Each still chooses its theme, and shows it chosen.
		const dark = items.find((item) => item.textContent!.includes('Dark'))!;
		dark.click();
		flushSync();
		expect(get(theme)).toBe('dark');
		expect(dark.getAttribute('aria-checked')).toBe('true');
	});
});

describe('InfoTip tells a screen reader its explanation (card 2516)', () => {
	const TIP = 'Cards finished since the start of the period.';
	let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

	afterEach(() => {
		if (drawn) {
			unmount(drawn.component);
			drawn.target.remove();
			drawn = null;
		}
		document.getElementById('own-help')?.remove();
		vi.unstubAllGlobals();
	});

	const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

	function draw(props: Record<string, unknown>): HTMLElement {
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(InfoTip as never, { target, props: { tip: html(`<p>${TIP}</p>`), ...props } as never }), target };
		flushSync();
		return target;
	}

	/** The text an element's `aria-describedby` names, each id's text in turn, as a browser puts a description together. */
	function description(el: Element): string {
		return (el.getAttribute('aria-describedby') ?? '')
			.split(/\s+/)
			.filter(Boolean)
			.map((id) => document.getElementById(id)?.textContent?.trim() ?? `<no #${id}>`)
			.join(' ');
	}

	it('the wrapper that takes the focus is described by the tip from the start, before any hover or focus', () => {
		const target = draw({ children: html('<span>Finished</span>') });
		const wrapper = target.querySelector<HTMLElement>('.it')!;
		expect(wrapper.tabIndex).toBe(0);
		expect(document.activeElement).not.toBe(wrapper);
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(description(wrapper)).toBe(TIP);
		// The copy is hidden, read only as the description it is named for, and is not a tooltip.
		const said = document.getElementById(wrapper.getAttribute('aria-describedby')!)!;
		expect(said.hidden).toBe(true);
		expect(said.getAttribute('role')).toBeNull();
	});

	it('the hidden copy is at the end of the body, not beside the words it explains', () => {
		// So a table heading's name, or the page read in order, does not take the explanation in too.
		const target = draw({ children: html('<span>Remaining</span>') });
		const said = document.getElementById(target.querySelector('.it')!.getAttribute('aria-describedby')!)!;
		expect(said.parentElement).toBe(document.body);
		expect(target.textContent!.trim()).toBe('Remaining');
	});

	it('with focusable={false}, the inner control is described, and the wrapper is not', () => {
		const target = draw({ focusable: false, dotted: false, children: html('<label><input type="checkbox"> Show upstream</label>') });
		const wrapper = target.querySelector<HTMLElement>('.it')!;
		const box = target.querySelector<HTMLInputElement>('input')!;
		expect(wrapper.hasAttribute('tabindex')).toBe(false);
		expect(wrapper.hasAttribute('aria-describedby')).toBe(false);
		expect(description(box)).toBe(TIP);
	});

	it('an aria-describedby the inner control has is kept, the tip added beside it', () => {
		const own = document.createElement('p');
		own.id = 'own-help';
		own.textContent = 'Shows the Options column.';
		document.body.appendChild(own);
		const target = draw({ focusable: false, children: html('<button type="button" aria-describedby="own-help">Show upstream</button>') });
		const button = target.querySelector('button')!;
		const ids = button.getAttribute('aria-describedby')!.split(' ');
		expect(ids[0]).toBe('own-help');
		expect(ids).toHaveLength(2);
		expect(description(button)).toBe(`Shows the Options column. ${TIP}`);
	});

	it('the tip going takes its id off the inner control, and leaves the control its own', () => {
		const own = document.createElement('p');
		own.id = 'own-help';
		own.textContent = 'Shows the Options column.';
		document.body.appendChild(own);
		const target = draw({ focusable: false, children: html('<button type="button" aria-describedby="own-help">Show upstream</button>') });
		const button = target.querySelector('button')!;
		expect(button.getAttribute('aria-describedby')).not.toBe('own-help');
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		expect(button.getAttribute('aria-describedby')).toBe('own-help');
	});

	it('an inner control with no description of its own is left with none once the tip goes', () => {
		const target = draw({ focusable: false, children: html('<a href="/burndown">Full chart</a>') });
		const link = target.querySelector('a')!;
		expect(description(link)).toBe(TIP);
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		expect(link.hasAttribute('aria-describedby')).toBe(false);
	});

	it('made focusable while drawn, the description moves from the inner control to the wrapper', () => {
		const props = $state({ focusable: false, tip: html(`<p>${TIP}</p>`), children: html('<button type="button">Show upstream</button>') });
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(InfoTip as never, { target, props: props as never }), target };
		flushSync();
		const wrapper = target.querySelector<HTMLElement>('.it')!;
		const button = target.querySelector('button')!;
		expect(description(button)).toBe(TIP);
		props.focusable = true;
		flushSync();
		expect(button.hasAttribute('aria-describedby')).toBe(false);
		expect(description(wrapper)).toBe(TIP);
	});

	it('the panel focus opens is the tooltip, under an id of its own, and the description stays on the hidden copy', async () => {
		// The panel watches its own size, which jsdom has no ResizeObserver for.
		vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
		const target = draw({ title: 'Finished', children: html('<span>Finished</span>') });
		const wrapper = target.querySelector<HTMLElement>('.it')!;
		const said = wrapper.getAttribute('aria-describedby')!;
		wrapper.focus();
		flushSync();
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
		const panel = document.querySelector<HTMLElement>('[role="tooltip"]')!;
		expect(panel).not.toBeNull();
		expect(panel.textContent).toContain(TIP);
		expect(panel.id).not.toBe(said);
		expect(document.querySelectorAll(`[id="${said}"]`)).toHaveLength(1);
		expect(wrapper.getAttribute('aria-describedby')).toBe(said);
		expect(description(wrapper)).toBe(TIP);
	});
});
