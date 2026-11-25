// @vitest-environment jsdom
/**
 * The guided tour of decision records, in the page (card 3070, the plan
 * docs/planning/card-3070-decision-tour.md, cases 8 to 11). The tour's page
 * and the register are mounted alone with Svelte's client runtime, as
 * tests/decision-register.svelte.test.ts mounts the register; the tour reads
 * no data, so it is given none. Each test starts with an empty
 * `localStorage` and no hash in the address.
 *
 * What each stop shows is worked out in `$lib/decision-tour`, whose own
 * cases are in tests/decision-tour.test.ts.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { RegisterPage } from '$lib/decision-register-types';

vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: vi.fn(async () => {}),
	replaceState: vi.fn(),
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
// The tour keeps its details under the signed-in account's id, which it reads from the page store.
vi.mock('$app/stores', () => {
	const value = () => ({ data: { user: { id: 1, username: 'alice', role: 'user' } } });
	return { page: { subscribe: (run: (v: ReturnType<typeof value>) => void) => (run(value()), () => {}) } };
});
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import { EXAMPLE_DETAILS, addDays, todayIso } from '$lib/decision-tour';
import RegisterPageView from '../src/routes/decisions/+page.svelte';
import TourPage from '../src/routes/decisions/tour/+page.svelte';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

/** The register's live stream, which these tests never send to. */
class QuietSource {
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	addEventListener() {}
	close() {}
}

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

beforeEach(() => {
	window.localStorage.clear();
	history.replaceState(null, '', '/decisions/tour');
	vi.stubGlobal('EventSource', QuietSource);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** The signed-in account's key (user 1, as the page store above gives). */
const KEY = 'dumpfire-decision-tour:1';

/** Saves the example as Start would have, closing a week from today. */
const saveExample = () => window.localStorage.setItem(KEY, JSON.stringify({ ...EXAMPLE_DETAILS(todayIso()), closes: addDays(todayIso(), 7) }));

const shownStop = (target: HTMLElement) => target.querySelector('[data-stop]')?.getAttribute('data-stop') ?? null;

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

/** Lets the hash change, its `hashchange` and the page's ticks run. */
async function settle() {
	for (let i = 0; i < 4; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const press = (target: HTMLElement, selector: string) => target.querySelector<HTMLButtonElement>(selector)!.click();

describe('the tour page', () => {
	it('with no saved details shows the form; Start with empty fields lists the problems, marks the fields and goes nowhere (8)', async () => {
		const target = draw(TourPage, {});
		await settle();
		expect(target.querySelector('#setup h2')!.id).toBe('h-0');
		expect(target.querySelector('[data-stop]')).toBeNull();
		const errors = target.querySelector<HTMLElement>('#setup-errors')!;
		expect(errors.getAttribute('role')).toBe('alert');
		expect(errors.hidden).toBe(true);

		press(target, '[data-action="start"]');
		await settle();
		expect(errors.hidden).toBe(false);
		expect([...errors.querySelectorAll('li')].map(textOf)).toEqual([
			'Give the decision a title.',
			'Write the question and its background in a sentence or two.',
			'Name the board the decision sits on.',
			'Choose a closing date.',
			'Enter at least two options.',
			'Name the decider.',
			'Enter at least two participants.'
		]);
		const marked = [...target.querySelectorAll('[aria-invalid="true"]')].map((field) => field.id);
		expect(marked).toEqual(['setup-title', 'setup-question', 'setup-board', 'setup-closes', 'setup-opt-1', 'setup-decider', 'setup-p1-name']);
		expect(document.activeElement!.id).toBe('setup-title');
		expect(location.hash).toBe('');
		expect(target.querySelector('[data-stop]')).toBeNull();
		expect(window.localStorage.getItem(KEY)).toBeNull();
	});

	it('Fill with an example then Start shows stop 1 with its title; Next reaches stop 2; Edit details keeps the values (9)', async () => {
		const target = draw(TourPage, {});
		await settle();
		press(target, '[data-action="fill-example"]');
		flushSync();
		expect(target.querySelector('[data-note="example"]')).not.toBeNull();
		press(target, '[data-action="start"]');
		await settle();

		const title = 'Move the support desk to a four-day week';
		expect(location.hash).toBe('#stop-1');
		expect(target.querySelector('[data-stop]')!.getAttribute('data-stop')).toBe('1');
		expect(textOf(target.querySelector('[data-v="title"]')!)).toBe(title);
		expect(document.activeElement!.id).toBe('h-1');
		expect(target.querySelector('.steps a[aria-current="step"]')!.getAttribute('href')).toBe('#stop-1');
		expect(JSON.parse(window.localStorage.getItem(KEY)!).title).toBe(title);

		press(target, '[data-action="next"]');
		await settle();
		expect(target.querySelector('[data-stop]')!.getAttribute('data-stop')).toBe('2');
		expect(textOf(target.querySelector('#h-2')!)).toBe('Drafting it');

		press(target, '[data-action="edit"]');
		await settle();
		expect(location.hash).toBe('#setup');
		expect(target.querySelector('[data-stop]')).toBeNull();
		expect(target.querySelector<HTMLInputElement>('#setup-title')!.value).toBe(title);
		expect(target.querySelector<HTMLInputElement>('#setup-p5-name')!.value).toBe('Rob Hale');
		expect(target.querySelector<HTMLSelectElement>('#setup-p5-role')!.value).toBe('informed');
	});

	it('draws a title holding markup as text (10)', async () => {
		const target = draw(TourPage, {});
		await settle();
		press(target, '[data-action="fill-example"]');
		flushSync();
		const field = target.querySelector<HTMLInputElement>('#setup-title')!;
		field.value = '<img src=x onerror=alert(1)>';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		press(target, '[data-action="start"]');
		await settle();

		expect(textOf(target.querySelector('[data-v="title"]')!)).toBe('<img src=x onerror=alert(1)>');
		expect(document.querySelector('img')).toBeNull();
	});

	it('with valid details saved, opens on the stop the address names (6b)', async () => {
		saveExample();
		history.replaceState(null, '', '/decisions/tour#stop-5');
		const target = draw(TourPage, {});
		await settle();
		expect(shownStop(target)).toBe('5');
		expect(textOf(target.querySelector('#h-5')!)).toBe("The decider's results");
	});

	it('ignores ArrowRight in a field, and moves on with it from the page (6c)', async () => {
		saveExample();
		history.replaceState(null, '', '/decisions/tour#stop-2');
		const target = draw(TourPage, {});
		await settle();
		const field = target.querySelector<HTMLInputElement>('#m2-title')!;
		field.focus();
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await settle();
		expect(shownStop(target)).toBe('2');

		field.blur();
		document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await settle();
		expect(shownStop(target)).toBe('3');
	});

	it('starts the tour from the form when storage throws (6d)', async () => {
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('blocked');
		});
		const target = draw(TourPage, {});
		await settle();
		press(target, '[data-action="fill-example"]');
		flushSync();
		press(target, '[data-action="start"]');
		await settle();
		expect(shownStop(target)).toBe('1');
	});
});

describe('the register', () => {
	it('links How it works to /decisions/tour (11)', () => {
		const page: RegisterPage = {
			tab: 'open',
			query: { tab: null, status: null, board: null, person: null, who: null, q: null, before: null },
			rows: [],
			next: null,
			counts: { waitingResponse: 0, waitingRuling: 0 },
			capped: false,
			boards: [],
			people: [],
			myPersonId: null
		};
		const target = draw(RegisterPageView, { data: page });
		const link = target.querySelector('[data-action="tour"]')!;
		expect(textOf(link)).toBe('How it works');
		expect(link.getAttribute('href')).toBe('/decisions/tour');
		expect(target.querySelector('[data-action="tour-empty"]')!.getAttribute('href')).toBe('/decisions/tour');
	});
});
