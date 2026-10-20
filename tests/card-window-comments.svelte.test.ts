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
 * And the window following its card's comments live (card 2282), the whole
 * `CardModal` mounted: a page that is told of the card's comments, or has
 * been away (a reconnect, a return to the tab), raises the window's
 * `commentsTold`, and the window reads its comments again, quietly (no
 * "Loading comments...", the comment being edited kept as it is), once for
 * a burst, keeping only the latest answer, and never twice for one comment.
 * Which events say so is `commentsChanged` in `$lib/board/sse`; To Do hears
 * them through `connectLiveRefresh`'s `onEvent`, held here with the stream
 * opener stood in for. All Tasks' own handlers are held in
 * `tests/all-tasks-page.test.ts`.
 *
 * The plan is `docs/planning/cards-2282-2283-2284-2301-2302-comments.md`
 * (decision 12, test 8; decisions 1 and 2 with section 8's rulings 1 to 5,
 * tests 13 to 22).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import type { CardType } from '$lib/types';
import type { CommentItem } from '$lib/components/card/CardComments.svelte';
import { commentsChanged } from '$lib/board/sse';

// The comment list asks the page who is signed in: the comment's author.
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});
// A bare 'svelte' gives the server's runtime, whose `onMount` never runs: the window reads its
// comments as it mounts only with the client's, by its path (as All Tasks' file does).
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});
// `connectLiveRefresh` opens its stream with this: stood in for, its listener and its reopen kept.
const stream = vi.hoisted(() => ({
	listen: null as null | ((source: EventSource) => void),
	reopened: null as null | (() => void),
	closed: 0
}));
vi.mock('$lib/live-stream', () => ({
	keepStreamOpen: (_url: string, listen: (source: EventSource) => void, reopened: () => void) => {
		stream.listen = listen;
		stream.reopened = reopened;
		return () => stream.closed++;
	}
}));

const CardComments = (await import('$lib/components/card/CardComments.svelte')).default;
const CardModal = (await import('$lib/components/CardModal.svelte')).default;
const { connectLiveRefresh } = await import('$lib/live-refresh');

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

// ─── The window following its card's comments (card 2282) ──────────────────

describe('which events tell a card window of its comments (card 2282, test 13)', () => {
	it.each([
		['this card’s comment event', { type: 'comment', cardId: 7 }, true],
		['another card’s comment event', { type: 'comment', cardId: 8 }, false],
		['a reconnect or a return to the tab, which may have missed one', null, true],
		['no event at all, read as a gap rather than thrown on', undefined, true],
		['a change to a card', { type: 'card' }, false]
	] as const)('%s', (_what, event, told) => {
		expect(commentsChanged(event, 7)).toBe(told);
	});
});

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A comment of Alice's on card 7. */
const comment = (id: number, content: string, createdAt = '2026-10-01 09:00:00'): CommentItem => ({
	id, cardId: 7, userId: 1, content, createdAt, updatedAt: createdAt, username: 'alice', userEmoji: '👤'
});

const opened = {
	id: 7, columnId: 1, categoryId: null, title: 'Plan', description: '', position: 0, priority: 'low',
	colorTag: null, dueDate: null, createdAt: '2026-10-20 09:00:00', updatedAt: '2026-10-20 09:00:00',
	subtasks: [], labelIds: [], pinned: false, onHoldNote: '', businessValue: null, subBoards: [],
	assignees: [], archivedAt: null, coverUrl: null, milestoneId: null, summary: null, theme: null
} as unknown as CardType;

describe('the card window re-reads its comments when told (card 2282, tests 14 to 21)', () => {
	/** Each read of the card's comments, answered when the case says, in the order they were sent. */
	/** Answered with a list, a whole answer (a 500), or an `Error`, a request that got no answer. */
	let reads: ((answer: CommentItem[] | Response | Error) => void)[] = [];
	/** Each comment posted, answered when the case says. */
	let posts: ((made: CommentItem) => void)[] = [];
	let requests: string[] = [];

	beforeEach(() => {
		reads = [];
		posts = [];
		requests = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				requests.push(`${method} ${url}`);
				if (url === '/api/cards/7/comments' && method === 'GET') {
					return new Promise((resolve, reject) =>
						reads.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer instanceof Response ? answer : respond(answer))))
					);
				}
				if (url === '/api/cards/7/comments' && method === 'POST') return new Promise((resolve) => posts.push((made) => resolve(respond(made, 201))));
				// An edit is answered with the comment as saved, a delete with success, at once.
				const one = /^\/api\/cards\/7\/comments\/(\d+)$/.exec(url);
				if (one && method === 'PUT') {
					const { content } = JSON.parse(String(init!.body));
					return Promise.resolve(respond({ ...comment(Number(one[1]), content), updatedAt: '2026-10-02 10:00:00' }));
				}
				if (one && method === 'DELETE') return Promise.resolve(respond({ success: true }));
				if (url.includes('/dependencies')) return Promise.resolve(respond({ blockedBy: [], blocks: [] }));
				if (url.includes('/tokens')) return Promise.resolve(respond(null));
				return Promise.resolve(respond([]));
			})
		);
		// jsdom lays nothing out: the window brings its message box into view.
		Element.prototype.scrollIntoView = () => {};
		// The window's 250 ms wait runs on these.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Lets `ms` pass, and every answer already given be read and drawn. */
	async function pass(ms = 0) {
		await vi.advanceTimersByTimeAsync(ms);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
		flushSync();
	}

	/** Mounts the window on card 7, its props `$state` as a page's are, its first read answered with `first`. */
	async function drawWindow(first: CommentItem[] | null, commentsTold = 0) {
		const props = $state({ card: opened, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {}, commentsTold });
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(CardModal, { target, props: props as never }), target };
		await pass();
		expect(reads).toHaveLength(1);
		// null: the opening read is left for the case to answer.
		if (first) reads[0](first);
		await pass();
		[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((tab) => tab.textContent!.includes('Comments'))!.click();
		flushSync();
		return { props, target };
	}

	/** The page is told again, as `commentsChanged` says it should be. */
	function told(props: { commentsTold: number }) {
		props.commentsTold++;
		flushSync();
	}

	/** A button of the comment thread: the window has Save and Cancel buttons of its own. */
	const inThread = (target: HTMLElement, text: string) => button(target.querySelector<HTMLElement>('.comment-thread')!, text);
	const commentReads = () => requests.filter((what) => what === 'GET /api/cards/7/comments').length;
	const shown = (target: HTMLElement) => [...target.querySelectorAll('.comment-content')].map((text) => text.textContent!.trim());
	const badge = (target: HTMLElement) => target.querySelector('.tab-badge')?.textContent ?? null;
	const loading = (target: HTMLElement) => target.querySelector('.comments-loading') !== null;

	function typeInto(box: HTMLTextAreaElement, text: string) {
		box.value = text;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}

	it('keeps the comment being edited as it is through a re-read: the same box, its focus, caret and text, and never "Loading comments..." (test 14)', async () => {
		const { props, target } = await drawWindow([comment(2, 'Second'), comment(1, 'First')]);
		inThread(target, 'Edit').click();
		flushSync();
		const box = editBox(target)!;
		typeInto(box, 'Second, rewritten');
		box.focus();
		box.setSelectionRange(6, 6);

		told(props);
		await pass(250);
		expect(commentReads()).toBe(2);
		expect(loading(target)).toBe(false);
		reads[1]([comment(3, 'Third', '2026-10-01 10:00:00'), comment(2, 'Second'), comment(1, 'First')]);
		await pass();

		expect(editBox(target)).toBe(box);
		expect(document.activeElement).toBe(box);
		expect(box.value).toBe('Second, rewritten');
		expect([box.selectionStart, box.selectionEnd]).toEqual([6, 6]);
		expect(loading(target)).toBe(false);
		expect(shown(target)).toEqual(['Third', 'First']);
	});

	it('reads the comments again once when told, showing the new one and the count, and keeps what is typed in the comment box (test 15)', async () => {
		const { props, target } = await drawWindow([comment(1, 'First')]);
		const newBox = target.querySelector<HTMLTextAreaElement>('.comment-input')!;
		typeInto(newBox, 'Half a thought');
		expect(badge(target)).toBe('1');

		told(props);
		await pass(250);
		expect(commentReads()).toBe(2);
		reads[1]([comment(3, 'Third', '2026-10-01 10:00:00'), comment(1, 'First')]);
		await pass(1000);

		expect(shown(target)).toEqual(['Third', 'First']);
		expect(badge(target)).toBe('2');
		expect(newBox.value).toBe('Half a thought');
		expect(commentReads()).toBe(2);
	});

	it('takes the number it opens with as its start: one read as it opens, and no second (test 16)', async () => {
		const { target } = await drawWindow([comment(1, 'First')], 3);
		await pass(1000);

		expect(commentReads()).toBe(1);
		expect(shown(target)).toEqual(['First']);
	});

	it('reads once for three bumps within 250 ms (test 17)', async () => {
		const { props } = await drawWindow([comment(1, 'First')]);

		told(props);
		await pass(100);
		told(props);
		await pass(100);
		told(props);
		await pass(50);
		expect(commentReads()).toBe(2);
		reads[1]([comment(1, 'First')]);
		await pass(1000);

		expect(commentReads()).toBe(2);
	});

	it('keeps the later read’s answer when the earlier one comes last (test 18)', async () => {
		const { props, target } = await drawWindow([comment(1, 'First')]);

		told(props);
		await pass(250);
		told(props);
		await pass(250);
		expect(commentReads()).toBe(3);
		reads[2]([comment(4, 'The latest', '2026-10-01 11:00:00'), comment(1, 'First')]);
		await pass();
		reads[1]([comment(3, 'Older', '2026-10-01 10:00:00'), comment(1, 'First')]);
		await pass();

		expect(shown(target)).toEqual(['The latest', 'First']);
	});

	it('shows a comment it posted once when the re-read brings it before the post’s answer (test 19)', async () => {
		const { props, target } = await drawWindow([comment(1, 'First')]);
		typeInto(target.querySelector<HTMLTextAreaElement>('.comment-input')!, 'Mine');
		button(target, 'Post Comment').click();
		flushSync();

		told(props);
		await pass(250);
		reads[1]([comment(3, 'Mine', '2026-10-01 10:00:00'), comment(1, 'First')]);
		await pass();
		posts[0](comment(3, 'Mine', '2026-10-01 10:00:00'));
		await pass();

		expect(shown(target)).toEqual(['Mine', 'First']);
		expect(badge(target)).toBe('2');
	});

	it('shows a comment it posted once when the post’s answer comes before the re-read (test 20)', async () => {
		const { props, target } = await drawWindow([comment(1, 'First')]);
		typeInto(target.querySelector<HTMLTextAreaElement>('.comment-input')!, 'Mine');
		button(target, 'Post Comment').click();
		flushSync();
		posts[0](comment(3, 'Mine', '2026-10-01 10:00:00'));
		await pass();
		expect(shown(target)).toEqual(['Mine', 'First']);

		told(props);
		await pass(250);
		reads[1]([comment(3, 'Mine', '2026-10-01 10:00:00'), comment(1, 'First')]);
		await pass();

		expect(shown(target)).toEqual(['Mine', 'First']);
		expect(badge(target)).toBe('2');
	});

	it('keeps the comment being edited, marked deleted, when a re-read has it gone; Save sends nothing and says so, and Cancel drops it (test 21)', async () => {
		const { props, target } = await drawWindow([comment(2, 'Second'), comment(1, 'First')]);
		inThread(target, 'Edit').click();
		flushSync();
		const box = editBox(target)!;
		typeInto(box, 'Second, rewritten');

		told(props);
		await pass(250);
		reads[1]([comment(1, 'First')]);
		await pass();

		expect(editBox(target)).toBe(box);
		expect(box.value).toBe('Second, rewritten');
		expect(target.querySelector('.comment-gone')?.textContent).toBe('(deleted)');
		expect(badge(target)).toBe('1');

		inThread(target, 'Save').click();
		await pass();
		expect(requests.filter((what) => what.startsWith('PUT '))).toEqual([]);
		expect(target.querySelector('.window-error')?.textContent).toContain('This comment no longer exists.');
		expect(editBox(target)!.value).toBe('Second, rewritten');

		inThread(target, 'Cancel').click();
		flushSync();
		expect(editBox(target)).toBeNull();
		expect(target.querySelector('.comment-gone')).toBeNull();
		expect(shown(target)).toEqual(['First']);
	});

	// The slice 3 review: a re-read sent before a change made in this window,
	// answered after it, answers with the comments as they were before it. Its
	// answer is not taken: the window's own change, and the re-read its event
	// sets off, are newer.
	describe('a re-read answered after a change made in the window is not taken', () => {
		/** Sends a re-read and leaves it out: `reads[1]`. */
		async function reReadOut(props: { commentsTold: number }) {
			told(props);
			await pass(250);
			expect(commentReads()).toBe(2);
		}

		it('keeps a comment posted while it was out', async () => {
			const { props, target } = await drawWindow([comment(1, 'First')]);
			await reReadOut(props);
			typeInto(target.querySelector<HTMLTextAreaElement>('.comment-input')!, 'Mine');
			button(target, 'Post Comment').click();
			flushSync();
			posts[0](comment(3, 'Mine', '2026-10-01 10:00:00'));
			await pass();
			expect(shown(target)).toEqual(['Mine', 'First']);

			reads[1]([comment(1, 'First')]);
			await pass();

			expect(shown(target)).toEqual(['Mine', 'First']);
			expect(badge(target)).toBe('2');
		});

		it('keeps a comment deleted while it was out deleted', async () => {
			const { props, target } = await drawWindow([comment(2, 'Second'), comment(1, 'First')]);
			await reReadOut(props);
			inThread(target, 'Delete').click();
			await pass();
			expect(requests).toContain('DELETE /api/cards/7/comments/2');
			expect(shown(target)).toEqual(['First']);

			reads[1]([comment(2, 'Second'), comment(1, 'First')]);
			await pass();

			expect(shown(target)).toEqual(['First']);
		});

		it('keeps an edit saved while it was out', async () => {
			const { props, target } = await drawWindow([comment(2, 'Second'), comment(1, 'First')]);
			await reReadOut(props);
			inThread(target, 'Edit').click();
			flushSync();
			typeInto(editBox(target)!, 'Second, rewritten');
			inThread(target, 'Save').click();
			await pass();
			expect(shown(target)).toEqual(['Second, rewritten', 'First']);

			reads[1]([comment(2, 'Second'), comment(1, 'First')]);
			await pass();

			expect(shown(target)).toEqual(['Second, rewritten', 'First']);
		});
	});

	it('shows the slow opening read when a re-read sent after it gets no answer: the newest answer that came wins', async () => {
		const { props, target } = await drawWindow(null);
		expect(loading(target)).toBe(true);

		told(props);
		await pass(250);
		reads[1](new Error('offline'));
		await pass();
		reads[0]([comment(1, 'First')]);
		await pass();

		expect(shown(target)).toEqual(['First']);
		expect(loading(target)).toBe(false);
	});

	it.each([
		['a 500', () => respond({ message: 'Internal error' }, 500)],
		['no answer', () => new Error('offline')]
	])('keeps the list shown when a re-read gets %s', async (_what, answer) => {
		const { props, target } = await drawWindow([comment(1, 'First')]);

		told(props);
		await pass(250);
		reads[1](answer());
		await pass();

		expect(shown(target)).toEqual(['First']);
		expect(badge(target)).toBe('1');
		expect(loading(target)).toBe(false);
	});

	// Card 2283: a delete sends the comment event an add and an edit send, so
	// the window open on the card elsewhere loses the comment. The event as the
	// server sends it for a delete (held in tests/activity-twins.test.ts),
	// heard as To Do hears it.
	it('loses a comment deleted elsewhere, and its count falls, told by the delete’s event as a page hears it', async () => {
		const { props, target } = await drawWindow([comment(2, 'Posted to the wrong card'), comment(1, 'First')]);
		const close = connectLiveRefresh(
			() => {},
			(event) => {
				if (commentsChanged(event, 7)) props.commentsTold++;
			}
		);
		const listeners: Record<string, (e: MessageEvent) => void> = {};
		stream.listen!({ addEventListener: (name: string, run: (e: MessageEvent) => void) => (listeners[name] = run) } as unknown as EventSource);
		expect(badge(target)).toBe('2');

		listeners.update(new MessageEvent('update', { data: JSON.stringify({ type: 'comment', cardId: 7 }) }));
		flushSync();
		await pass(250);
		expect(commentReads()).toBe(2);
		reads[1]([comment(1, 'First')]);
		await pass();
		close();

		expect(shown(target)).toEqual(['First']);
		expect(badge(target)).toBe('1');
		expect(loading(target)).toBe(false);
	});

	it('sends no re-read once the window has closed with one waiting', async () => {
		const { props } = await drawWindow([comment(1, 'First')]);

		told(props);
		await pass(100);
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		await pass(1000);

		expect(commentReads()).toBe(1);
	});
});

describe('connectLiveRefresh tells its page what each update said, and of every gap (card 2282, test 22)', () => {
	beforeEach(() => {
		stream.listen = null;
		stream.reopened = null;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		// A return to the tab is a `visibilitychange` with the page shown.
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('hands `onEvent` the parsed update, and null on a reconnect and on a return to the tab, and still re-reads after each', () => {
		const onRefresh = vi.fn();
		const onEvent = vi.fn();
		const close = connectLiveRefresh(onRefresh, onEvent);
		const listeners: Record<string, (e: MessageEvent) => void> = {};
		stream.listen!({ addEventListener: (name: string, run: (e: MessageEvent) => void) => (listeners[name] = run) } as unknown as EventSource);

		listeners.update(new MessageEvent('update', { data: JSON.stringify({ type: 'comment', cardId: 7 }) }));
		expect(onEvent.mock.calls).toEqual([[{ type: 'comment', cardId: 7 }]]);
		vi.advanceTimersByTime(250);
		expect(onRefresh).toHaveBeenCalledTimes(1);

		stream.reopened!();
		expect(onEvent.mock.calls.at(-1)).toEqual([null]);
		vi.advanceTimersByTime(250);
		expect(onRefresh).toHaveBeenCalledTimes(2);

		document.dispatchEvent(new Event('visibilitychange'));
		expect(onEvent.mock.calls.at(-1)).toEqual([null]);
		expect(onEvent).toHaveBeenCalledTimes(3);
		vi.advanceTimersByTime(250);
		expect(onRefresh).toHaveBeenCalledTimes(3);

		close();
		document.dispatchEvent(new Event('visibilitychange'));
		expect(onEvent).toHaveBeenCalledTimes(3);
	});
});
