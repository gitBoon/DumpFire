// @vitest-environment jsdom
/**
 * The board header's XP bars (card 2304), mounted with Svelte's client runtime.
 *
 * The suite runs in vitest's `node` environment. This file, its first
 * component test, takes jsdom by the comment above, as the ones after it do
 * (card 2280's column header and card window), so that `mount` is the
 * browser's and not the server's. It is named `.svelte.test.ts` so that it
 * can make the list with `$state`, as the board page does: a plain array
 * would not show the fault, since only a write to state while drawing is
 * refused.
 *
 * The bars used to draw `entries.sort(...)`, which sorts the page's own array
 * in place. With two entries or more that writes to it, even when it is
 * already in order, and Svelte stops with `state_unsafe_mutation`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type * as Svelte from 'svelte';
import XpLeaderboard from '$lib/components/board/XpLeaderboard.svelte';
import type { XpEntry } from '$lib/types';

// The component is compiled for the browser in this environment, but a bare
// 'svelte' still gives the server's `mount`, which only throws: vitest leaves
// packages to Node, and Node does not use their "browser" export. So the
// browser's entry is loaded by its path, the one the "browser" export names.
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
});

/** Mounts the bars on a `$state` copy of `list`, and gives back that array. */
function draw(list: XpEntry[]): XpEntry[] {
	const entries = $state(list);
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(XpLeaderboard, { target, props: { entries } }), target };
	flushSync();
	return entries;
}

/** The names on the bars, in the order they are drawn. */
const namesDrawn = () =>
	[...(drawn?.target.querySelectorAll('.xp-name') ?? [])].map((el) => el.textContent);

const entry = (name: string, xp: number): XpEntry => ({ name, xp, emoji: '🔥' });

describe('the XP bars', () => {
	it('draw one entry', () => {
		draw([entry('alice', 40)]);
		expect(namesDrawn()).toEqual(['alice']);
	});

	it('draw entries already highest first in that order, and leave the page’s list as it was', () => {
		const entries = draw([entry('alice', 300), entry('bob', 200), entry('carol', 100)]);
		expect(namesDrawn()).toEqual(['alice', 'bob', 'carol']);
		expect(entries.map((e) => e.name)).toEqual(['alice', 'bob', 'carol']);
	});

	it('draw entries out of order highest first, and leave the page’s list in its own order', () => {
		const entries = draw([entry('alice', 10), entry('bob', 500), entry('carol', 0), entry('dave', 120)]);
		expect(namesDrawn()).toEqual(['bob', 'dave', 'alice', 'carol']);
		expect(entries.map((e) => e.name)).toEqual(['alice', 'bob', 'carol', 'dave']);
	});

	it('draw an entry added to the page’s list afterwards in its place', () => {
		const entries = draw([entry('alice', 10), entry('bob', 500)]);
		entries.push(entry('carol', 200));
		flushSync();
		expect(namesDrawn()).toEqual(['bob', 'carol', 'alice']);
		expect(entries.map((e) => e.name)).toEqual(['alice', 'bob', 'carol']);
	});
});
