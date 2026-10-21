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
 *   - Delete asks first, in the app's confirm dialog drawn inside the tab:
 *     it sent the delete at once, and a deleted comment cannot be got back
 *     (card 2338). An administrator deleting someone else's comment is told
 *     whose it is and that the Activity Log records it.
 *   - A post takes its text and empties the box as it goes, so what is typed
 *     while it is out is kept, and goes once: Post Comment is off and
 *     Ctrl+Enter sends nothing until it is answered. A refused or unanswered
 *     post puts its text back in front of what was typed since (card 2342).
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
 * tests 13 to 22), and for the delete's confirm
 * `docs/planning/cards-2337-2338-2341-2342-2353-card-window.md` (decisions 5
 * and 7, tests 8 to 10) and the post (decision 9, tests 12 to 14).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import type { CardType } from '$lib/types';
import type { CommentItem } from '$lib/components/card/CardComments.svelte';
import type { AttachmentItem } from '$lib/components/card/CardAttachments.svelte';
import { attachmentsChanged, commentsChanged } from '$lib/board/sse';

// The comment list asks the page who is signed in: the comment's author, unless a case says
// otherwise before it draws (an administrator, card 2338).
const signedIn = vi.hoisted(() => ({ user: { id: 1, username: 'alice', role: 'user' } }));
vi.mock('$app/stores', () => {
	const value = { data: signedIn };
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
	signedIn.user = { id: 1, username: 'alice', role: 'user' };
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

/** Mounts the tab on `written` (or the comments given), its props `$state`, and gives them back to read. */
function draw(list: CommentItem[] = [written], onWritten?: () => void) {
	const props = $state({ card, activeTab: 'comments' as const, boardUsers: [], comments: list, loadingComments: false, windowError: '', onWritten });
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

/** The tab's own confirm, when it is open: its title, its message and its two buttons. */
function confirmShown(target: HTMLElement) {
	const dialog = target.querySelector<HTMLElement>('.confirm-modal');
	if (!dialog) return null;
	return {
		title: dialog.querySelector('h3')!.textContent!.trim(),
		message: dialog.querySelector('.confirm-message')!.textContent!.trim(),
		cancel: button(dialog, 'Cancel'),
		confirm: button(dialog, 'Delete')
	};
}

describe('deleting a comment asks first (card 2338)', () => {
	it('Delete opens "Delete Comment" and sends nothing; Cancel closes it, the comment kept and nothing sent (test 8)', () => {
		const { props, target } = draw();
		button(target, 'Delete').click();
		flushSync();

		const asked = confirmShown(target);
		expect(asked).not.toBeNull();
		expect(asked!.title).toBe('Delete Comment');
		expect(asked!.message).toBe('This comment will be deleted for everyone on the card. This cannot be undone.');
		expect(fetched).not.toHaveBeenCalled();

		asked!.cancel.click();
		flushSync();
		expect(confirmShown(target)).toBeNull();
		expect(props.comments).toEqual([written]);
		expect(target.querySelector('.comment-content')?.textContent).toContain('As it was');
		expect(fetched).not.toHaveBeenCalled();
	});

	it('the dialog’s Delete sends one delete, takes the comment out, closes the dialog and tells the window once (test 9)', async () => {
		const onWritten = vi.fn();
		const { props, target } = draw([written], onWritten);
		answer = { success: true };
		button(target, 'Delete').click();
		flushSync();
		confirmShown(target)!.confirm.click();
		await settle();

		expect(fetched.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual(['DELETE /api/cards/7/comments/3']);
		expect(props.comments).toEqual([]);
		expect(confirmShown(target)).toBeNull();
		expect(onWritten).toHaveBeenCalledTimes(1);
		expect(props.windowError).toBe('');
	});

	it('names the author and the Activity Log to an administrator deleting someone else’s comment (test 10)', () => {
		signedIn.user = { id: 5, username: 'root', role: 'admin' };
		const bobs: CommentItem = { ...written, id: 4, userId: 2, username: 'bob', content: 'Bob was here' };
		const { target } = draw([bobs]);
		button(target, 'Delete').click();
		flushSync();

		expect(confirmShown(target)!.message).toBe("bob's comment will be deleted for everyone on the card, and the Activity Log will record that you deleted it. This cannot be undone.");
		expect(fetched).not.toHaveBeenCalled();
	});
});

describe('posting a comment keeps what is typed and posts once (card 2342)', () => {
	/** The post's answer, held until the case gives it: a Response, or an Error for no answer. */
	let answerPost: (given: Response | Error) => void;
	let sentBodies: string[] = [];

	beforeEach(() => {
		sentBodies = [];
		vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
			sentBodies.push(JSON.parse(String(init!.body)).content);
			return new Promise<Response>((resolve, reject) => {
				answerPost = (given) => (given instanceof Error ? reject(given) : resolve(given));
			});
		}));
		// jsdom lays nothing out: a window's message box is brought into view.
		Element.prototype.scrollIntoView = () => {};
	});

	const madeAnswer = (content: string) =>
		new Response(JSON.stringify({ ...written, id: 9, content, createdAt: '2026-10-21 09:00:00', updatedAt: '2026-10-21 09:00:00' }), { status: 201 });
	const newBox = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('.comment-input')!;
	function typeInto(box: HTMLTextAreaElement, text: string) {
		box.value = text;
		box.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}
	function ctrlEnter(box: HTMLTextAreaElement) {
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
		flushSync();
	}

	it('empties the box as the post goes, and keeps what is typed while it is out once it is answered (test 12)', async () => {
		const onWritten = vi.fn();
		const { props, target } = draw([written], onWritten);
		typeInto(newBox(target), '  Hello  ');
		button(target, 'Post Comment').click();
		flushSync();
		expect(newBox(target).value).toBe('');
		expect(sentBodies).toEqual(['Hello']);

		typeInto(newBox(target), 'And more');
		answerPost(madeAnswer('Hello'));
		await settle();

		expect(newBox(target).value).toBe('And more');
		expect(props.comments.map((c) => c.content)).toEqual(['Hello', 'As it was']);
		expect(onWritten).toHaveBeenCalledTimes(1);
		expect(props.windowError).toBe('');
	});

	it('sends one post while one is out: Post Comment is off, and a second click and Ctrl+Enter twice send nothing and leave the box (test 13)', async () => {
		const { props, target } = draw();
		typeInto(newBox(target), 'Hello');
		const post = button(target, 'Post Comment');
		post.click();
		flushSync();
		typeInto(newBox(target), 'Typed meanwhile');
		expect(post.disabled).toBe(true);

		post.click();
		ctrlEnter(newBox(target));
		ctrlEnter(newBox(target));
		flushSync();
		expect(sentBodies).toEqual(['Hello']);
		expect(newBox(target).value).toBe('Typed meanwhile');

		answerPost(madeAnswer('Hello'));
		await settle();
		expect(sentBodies).toEqual(['Hello']);
		expect(props.comments.map((c) => c.content)).toEqual(['Hello', 'As it was']);
		expect(post.disabled).toBe(false);
	});

	it.each([
		['refused', () => new Response(JSON.stringify({ message: 'Comment too long' }), { status: 400 }), 'Comment too long', 'And more', 'Hello\n\nAnd more'],
		['not answered', () => new Error('offline'), 'No answer from the server. It is not known whether that was saved.', 'And more', 'Hello\n\nAnd more'],
		['refused, with nothing typed since', () => new Response(JSON.stringify({ message: 'Comment too long' }), { status: 400 }), 'Comment too long', '', 'Hello']
	] as const)('a post %s says so and puts its text back in front of anything typed since (test 14)', async (_what, given, said, typed, box) => {
		const onWritten = vi.fn();
		const { props, target } = draw([written], onWritten);
		typeInto(newBox(target), 'Hello');
		button(target, 'Post Comment').click();
		flushSync();
		if (typed) typeInto(newBox(target), typed);

		answerPost(given());
		await settle();

		expect(props.windowError).toBe(said);
		expect(newBox(target).value).toBe(box);
		expect(button(target, 'Post Comment').disabled).toBe(false);
		expect(props.comments).toEqual([written]);
		expect(onWritten).not.toHaveBeenCalled();
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
			flushSync();
			// The delete asks first (card 2338): its dialog's Delete sends it.
			button(target.querySelector<HTMLElement>('.confirm-modal')!, 'Delete').click();
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

// ─── The window following its card's files (card 2337) ──────────────────────

describe('which events tell a card window of its files (card 2337, test 18)', () => {
	it.each([
		['this card’s attachment event', { type: 'attachment', cardId: 7 }, true],
		['another card’s attachment event', { type: 'attachment', cardId: 8 }, false],
		['a comment event on this card', { type: 'comment', cardId: 7 }, false],
		['a reconnect or a return to the tab, which may have missed one', null, true],
		['no event at all, read as a gap rather than thrown on', undefined, true]
	] as const)('%s', (_what, event, told) => {
		expect(attachmentsChanged(event, 7)).toBe(told);
	});
});

describe('the card window re-reads its files when told, once it has read them (card 2337, tests 19 and 20)', () => {
	/** Each read of the card's files, answered when the case says, in the order they were sent. */
	let reads: ((list: AttachmentItem[]) => void)[] = [];
	/** Each upload, answered when the case says with the file as saved. */
	let uploads: ((made: AttachmentItem) => void)[] = [];
	let requests: string[] = [];

	const file = (id: number, originalName: string): AttachmentItem => ({
		id, cardId: 7, filename: `${id}-${originalName}`, originalName, mimeType: 'text/plain', sizeBytes: 10, uploadedBy: 1, createdAt: '2026-10-21 09:00:00'
	});

	beforeEach(() => {
		reads = [];
		uploads = [];
		requests = [];
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string, init?: RequestInit) => {
				const method = init?.method ?? 'GET';
				requests.push(`${method} ${url}`);
				if (url === '/api/cards/7/attachments' && method === 'GET') return new Promise((resolve) => reads.push((list) => resolve(respond(list))));
				if (url === '/api/cards/7/attachments' && method === 'POST') return new Promise((resolve) => uploads.push((made) => resolve(respond(made))));
				if (url.includes('/dependencies')) return Promise.resolve(respond({ blockedBy: [], blocks: [] }));
				if (url.includes('/tokens')) return Promise.resolve(respond(null));
				return Promise.resolve(respond([]));
			})
		);
		Element.prototype.scrollIntoView = () => {};
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function pass(ms = 0) {
		await vi.advanceTimersByTimeAsync(ms);
		for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
		flushSync();
	}

	/** Mounts the window on card 7, its props `$state` as a page's are; with its Files tab opened and its first read answered with `first`, if given. */
	async function drawWindow(first: AttachmentItem[] | null) {
		const props = $state({ card: opened, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {}, attachmentsTold: 0 });
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(CardModal, { target, props: props as never }), target };
		await pass();
		if (first) {
			[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((tab) => tab.textContent!.includes('Files'))!.click();
			flushSync();
			expect(reads).toHaveLength(1);
			reads[0](first);
			await pass();
		}
		return { props, target };
	}

	function told(props: { attachmentsTold: number }) {
		props.attachmentsTold++;
		flushSync();
	}

	/** Chooses `chosen` in the Files tab's file box, as the browser does. */
	function choose(target: HTMLElement, chosen: File) {
		const input = target.querySelector<HTMLInputElement>('.upload-input')!;
		Object.defineProperty(input, 'files', { value: [chosen], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	}

	const fileReads = () => requests.filter((what) => what === 'GET /api/cards/7/attachments').length;
	const shownFiles = (target: HTMLElement) => [...target.querySelectorAll('.attachment-name')].map((name) => name.textContent!.trim());
	const filesBadge = (target: HTMLElement) =>
		[...target.querySelectorAll('.tab')].find((tab) => tab.textContent!.includes('Files'))!.querySelector('.tab-badge')?.textContent ?? null;
	const loadingFiles = (target: HTMLElement) => target.querySelector('.comments-loading')?.textContent === 'Loading attachments...';

	it('reads its files again once, quietly, for three raises within 250 ms, showing the new file and the count; a window whose Files tab was never opened reads none (test 19)', async () => {
		const { props, target } = await drawWindow([file(1, 'plan.txt')]);
		expect(shownFiles(target)).toEqual(['plan.txt']);

		told(props);
		await pass(100);
		told(props);
		await pass(100);
		told(props);
		await pass(50);
		expect(fileReads()).toBe(2);
		expect(loadingFiles(target)).toBe(false);
		reads[1]([file(1, 'plan.txt'), file(2, 'notes.txt')]);
		await pass(1000);

		expect(shownFiles(target)).toEqual(['plan.txt', 'notes.txt']);
		expect(filesBadge(target)).toBe('2');
		expect(fileReads()).toBe(2);

		// A window that has not read its files reads them when its tab is opened.
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		requests = [];
		const unread = await drawWindow(null);
		told(unread.props);
		await pass(1000);
		expect(fileReads()).toBe(0);
	});

	// The card 2337 review: a change told while the tab's first read was out was dropped,
	// the window waiting for a read to have been answered before it would re-read.
	it('reads its files again when told while the Files tab’s first read is out, and shows the newer answer when the first comes back stale (test 19)', async () => {
		const { props, target } = await drawWindow(null);
		[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((tab) => tab.textContent!.includes('Files'))!.click();
		flushSync();
		expect(fileReads()).toBe(1);

		told(props);
		await pass(250);
		expect(fileReads()).toBe(2);
		reads[0]([file(1, 'plan.txt')]);
		await pass();
		reads[1]([file(1, 'plan.txt'), file(2, 'notes.txt')]);
		await pass();

		expect(shownFiles(target)).toEqual(['plan.txt', 'notes.txt']);
		expect(filesBadge(target)).toBe('2');
		expect(loadingFiles(target)).toBe(false);
	});

	it('takes no answer of a re-read sent before an upload made in the window, and shows a file once when a re-read brought it before the upload’s answer (test 20)', async () => {
		const { props, target } = await drawWindow([file(1, 'plan.txt')]);

		// A re-read out; an upload made and answered; then the re-read answers with the files as they were.
		told(props);
		await pass(250);
		expect(fileReads()).toBe(2);
		choose(target, new File(['hello'], 'notes.txt', { type: 'text/plain' }));
		await pass();
		uploads[0](file(2, 'notes.txt'));
		await pass();
		expect(shownFiles(target)).toEqual(['plan.txt', 'notes.txt']);
		reads[1]([file(1, 'plan.txt')]);
		await pass();
		expect(shownFiles(target)).toEqual(['plan.txt', 'notes.txt']);

		// Another upload, whose answer comes after a re-read already brought its file.
		choose(target, new File(['more'], 'more.txt', { type: 'text/plain' }));
		await pass();
		told(props);
		await pass(250);
		expect(fileReads()).toBe(3);
		reads[2]([file(1, 'plan.txt'), file(2, 'notes.txt'), file(3, 'more.txt')]);
		await pass();
		uploads[1](file(3, 'more.txt'));
		await pass();

		expect(shownFiles(target)).toEqual(['plan.txt', 'notes.txt', 'more.txt']);
		expect(filesBadge(target)).toBe('3');
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
