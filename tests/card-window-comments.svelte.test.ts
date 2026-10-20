// @vitest-environment jsdom
/**
 * The card window's Comments tab (`CardComments.svelte`), mounted with
 * Svelte's client runtime, as `tests/card-window-follow.svelte.test.ts`
 * mounts the whole window. Named `.svelte.test.ts` so that its props can be
 * `$state`, as the window's are: the comment list is bound, and what the tab
 * writes to it is read back from the props.
 *
 *   - Save on a comment whose text is unchanged sends nothing and shows no
 *     "(edited)". It sent the text, and stamped the comment's `updatedAt`
 *     with the browser's own time, so "(edited)" showed on a comment nobody
 *     changed (card 2284).
 *   - A save that changes the text takes the comment's text and `updatedAt`
 *     from the server's answer, not from what was typed and the browser's
 *     clock.
 *
 * The plan is `docs/planning/cards-2282-2283-2284-2301-2302-comments.md`
 * (decision 12, test 8).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import type { CardType } from '$lib/types';
import type { CommentItem } from '$lib/components/card/CardComments.svelte';

// The comment list asks the page who is signed in: the comment's author.
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});

const CardComments = (await import('$lib/components/card/CardComments.svelte')).default;

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let fetched: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

/** What the server answers a save with: set by a case before it saves. */
let answer: unknown = null;

beforeEach(() => {
	answer = null;
	fetched = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }) as Response);
	vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
});

const card = { id: 7, title: 'Plan' } as unknown as CardType;

/** Alice's comment, written and last changed on 1 October. */
const written: CommentItem = {
	id: 3, cardId: 7, userId: 1, content: 'As it was',
	createdAt: '2026-10-01 09:00:00', updatedAt: '2026-10-01 09:00:00', username: 'alice', userEmoji: '👤'
};

/** Mounts the tab on `written`, its props `$state`, and gives them back to read. */
function draw() {
	const props = $state({ card, activeTab: 'comments' as const, boardUsers: [], comments: [written], loadingComments: false, windowError: '' });
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(CardComments, { target, props: props as never }), target };
	flushSync();
	return { props, target };
}

/** Lets the answers already given be read, and draws what they changed. */
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

const button = (target: HTMLElement, text: string) =>
	[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === text)!;
const editBox = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('.comment-edit-input');

describe('saving an edited comment (card 2284)', () => {
	it('sends nothing and shows no "(edited)" when the text is unchanged, and closes the box', async () => {
		const { props, target } = draw();
		button(target, 'Edit').click();
		flushSync();
		expect(editBox(target)!.value).toBe('As it was');

		button(target, 'Save').click();
		await settle();

		expect(fetched).not.toHaveBeenCalled();
		expect(editBox(target)).toBeNull();
		expect(target.querySelector('.comment-edited')).toBeNull();
		expect(props.comments).toEqual([written]);
		expect(props.windowError).toBe('');
	});

	it('takes the text and the time from the answer when the text has changed', async () => {
		const { props, target } = draw();
		button(target, 'Edit').click();
		flushSync();
		const box = editBox(target)!;
		box.value = '  As it is now ';
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		answer = { ...written, content: 'As it is now', updatedAt: '2026-10-02 10:00:00' };
		button(target, 'Save').click();
		await settle();

		expect(fetched).toHaveBeenCalledTimes(1);
		expect(fetched.mock.calls[0][0]).toBe('/api/cards/7/comments/3');
		expect(JSON.parse(String(fetched.mock.calls[0][1]!.body))).toEqual({ content: 'As it is now' });
		expect(props.comments).toEqual([{ ...written, content: 'As it is now', updatedAt: '2026-10-02 10:00:00' }]);
		expect(target.querySelector('.comment-edited')).not.toBeNull();
		expect(editBox(target)).toBeNull();
	});
});
