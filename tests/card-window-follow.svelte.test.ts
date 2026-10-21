// @vitest-environment jsdom
/**
 * The card window following its card (card 2280, slice B5d of card 2012's
 * part B), mounted with Svelte's client runtime, as
 * `tests/card-window-keys.svelte.test.ts` is, so that its follow `$effect`
 * is run by Svelte itself. The window's own `import … from 'svelte'` is given
 * the client's runtime by the `vi.mock('svelte')` below, as in the keys file:
 * without it the window gets the server's, whose `onMount` never runs and
 * whose `untrack` tracks (card 2341). Named `.svelte.test.ts` so that its
 * props can be `$state`, as the board page's are: the window's card is handed
 * afresh as each read of the board draws it.
 *
 *   - On the board page (given the controller's `edits`), each typed field
 *     the user has not touched shows the card's value as the card changes;
 *     one typed in stays as typed.
 *   - Given no `edits` the fields are filled once, whatever the card is
 *     handed afterwards. (All Tasks, All To Do and the plan page pass the
 *     controller's `edits` too since card 2281's C3a-1 review:
 *     `tests/card-window-pages.test.ts`.)
 *
 * What a save of each sends is in `tests/card-window.test.ts`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import { CardWindow, WindowEdits } from '$lib/board/card-window.svelte';
import type { CardType } from '$lib/types';

vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => { run(value); return () => {}; } } };
});
// A bare 'svelte' gives the server's runtime, whose `onMount` never runs: the window reads its
// comments and dependencies as it mounts only with the client's, by its path (as All Tasks' file does).
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

const CardModal = (await import('$lib/components/CardModal.svelte')).default;

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let onSave: Mock<(data: unknown) => void>;

beforeEach(() => {
	onSave = vi.fn<(data: unknown) => void>();
	// The window's own reads on open: empty lists.
	vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('/dependencies') ? { blockedBy: [], blocks: [] } : url.includes('/tokens') ? null : []) }) as Response));
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
});

const opened = {
	id: 7, columnId: 1, categoryId: null, title: 'Plan', description: 'Old notes', position: 0, priority: 'low',
	colorTag: null, dueDate: null, createdAt: '2026-10-20 09:00:00', updatedAt: '2026-10-20 09:00:00',
	subtasks: [], labelIds: [], pinned: false, onHoldNote: '', businessValue: null, subBoards: [],
	assignees: [], archivedAt: null, coverUrl: null, milestoneId: null, summary: null, theme: null
} as unknown as CardType;

/** Mounts the window on `opened`, its props `$state`, and gives them back to change. */
function draw(edits?: WindowEdits) {
	const props = $state({ card: opened, categories: [], labels: [], boardId: 1, boardUsers: [], onSave, onClose: () => {}, edits });
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(CardModal, { target, props: props as never }), target };
	flushSync();
	return { props, target };
}

const titleBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('#card-title')!;
const descriptionBox = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('#card-desc')!;
const priorityChip = (target: HTMLElement) => target.querySelector('.chip')!.textContent!.trim();

/** Types `text` into a box, as `bind:value` hears it. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
	el.value = text;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the card window’s start-up code runs here (card 2341)', () => {
	// The window reads its comments and its dependencies in its `onMount`, which
	// runs only with the client's runtime (the `vi.mock('svelte')` above).
	it('reads the card’s comments and dependencies as it opens', () => {
		draw(new WindowEdits());
		const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
		expect(urls).toContain('/api/cards/7/comments');
		expect(urls).toContain('/api/cards/7/dependencies');
	});
});

describe('the card window follows its card where nothing was typed (card 2280, slice B5d)', () => {
	it('on the board page shows the card’s new values in the fields not touched, and keeps a title typed in', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Plan', 'Old notes', 'Low']);
		// The window gives the title the focus as it opens, and a box with the
		// focus is held (the cases below): left, untyped in.
		expect(document.activeElement).toBe(titleBox(target));
		titleBox(target).blur();
		flushSync();

		// A read of the board hands the window the card someone else changed.
		props.card = { ...opened, title: 'Theirs', description: 'Their notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Theirs', 'Their notes', 'High']);

		// The user types a title; the next read brings another title and description.
		type(titleBox(target), 'Mine');
		props.card = { ...opened, title: 'Theirs again', description: 'Third notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value]).toEqual(['Mine', 'Third notes']);
		expect(edits.touched).toEqual(new Set(['title']));

		// What the window hands its save is what it shows.
		target.querySelector<HTMLButtonElement>('.btn-create')!.click();
		flushSync();
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Mine', description: 'Third notes', priority: 'high' });
	});

	// The B5d review: a value brought into the box being typed in moved its caret to the end.
	it('holds the field whose box has the focus: a read leaves its text and caret, and once it is left the new value shows', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		const box = descriptionBox(target);
		box.focus();
		box.setSelectionRange(3, 3);
		flushSync();
		props.card = { ...opened, description: 'Their notes' } as CardType;
		flushSync();
		expect([box.value, box.selectionStart, box.selectionEnd]).toEqual(['Old notes', 3, 3]);

		box.blur();
		flushSync();
		expect(box.value).toBe('Their notes');
		// The focus alone was no touch.
		expect(edits.touched.size).toBe(0);
	});

	it('holds the title the window gives the focus as it opens, and follows it once it is left: the focus alone is no touch', () => {
		const edits = new WindowEdits();
		const { props, target } = draw(edits);
		titleBox(target).focus();
		flushSync();
		props.card = { ...opened, title: 'Theirs' } as CardType;
		flushSync();
		expect(titleBox(target).value).toBe('Plan');
		descriptionBox(target).focus();
		flushSync();
		expect(titleBox(target).value).toBe('Theirs');
		expect(edits.touched.size).toBe(0);
	});

	// The B5d review: the board page draws the window inside `{#key cardWindow.edits}`,
	// which needs the controller's `edits` to be state.
	it('the controller’s edits is state: what reads it is told when a window is opened or closed', () => {
		const board = $state({ columns: [{ id: 1, cards: [opened] }], labels: [], boardUsers: [] });
		const cardWindow = new CardWindow(board as never, 1);
		let seen = 0;
		const stop = $effect.root(() => {
			$effect(() => {
				void cardWindow.edits;
				seen++;
			});
		});
		flushSync();
		cardWindow.openCard(opened);
		flushSync();
		cardWindow.openCard(opened);
		flushSync();
		cardWindow.close();
		flushSync();
		stop();
		expect(seen).toBe(4);
	});

	it('given no edits keeps the fields it was filled with (no page does this now: all four host pages pass edits inside {#key cardWindow.edits} since card 2281’s slice C3a-1)', () => {
		const { props, target } = draw();
		props.card = { ...opened, title: 'Theirs', description: 'Their notes', priority: 'high' } as CardType;
		flushSync();
		expect([titleBox(target).value, descriptionBox(target).value, priorityChip(target)]).toEqual(['Plan', 'Old notes', 'Low']);

		target.querySelector<HTMLButtonElement>('.btn-create')!.click();
		flushSync();
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Plan', description: 'Old notes', priority: 'low' });
	});
});

// Card 2382: the window's read of the card's links was try/finally with an
// unguarded parse. No answer, or an answer that is not JSON, rejected out of
// it unhandled (which fails a case here), and every failure said nothing.
describe('the card window’s read of the card’s links says when it fails, and keeps the links shown (card 2382)', () => {
	const blocker = { kind: 'card', cardId: 9, dependencyId: 1, title: 'Docs', boardId: 1, boardName: 'Website', columnName: 'To Do', resolved: false, withheld: false };
	const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
	const notJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;

	/** The window's own reads answered by `links` for the links, empty lists for the rest. */
	function answering(links: (init?: RequestInit) => Promise<Response>) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) =>
				url === '/api/cards/7/dependencies' ? links(init) : answer(200, url.includes('/tokens') ? null : [])
			)
		);
	}

	/** Lets every answer in flight arrive, and draws. */
	async function settle() {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}

	/** Draws the window and opens More options, where the links are. */
	async function opened() {
		const { target } = draw(new WindowEdits());
		await settle();
		target.querySelector<HTMLButtonElement>('.advanced-toggle')!.click();
		flushSync();
		return target;
	}
	const said = (target: HTMLElement) => target.querySelector('.dep-error')?.textContent?.trim();

	it.each([
		['no answer', () => Promise.reject(new TypeError('Failed to fetch')), 'No answer from the server. The dependencies could not be loaded.'],
		['an answer that is not JSON', async () => notJson(), "The server's answer could not be read. The dependencies could not be loaded."],
		['an answer that is not the two lists', async () => answer(200, { error: 'proxy' }), "The server's answer could not be read. The dependencies could not be loaded."],
		['a refusal, in its words', async () => answer(403, { message: 'No access to this card' }), 'No access to this card'],
		['a refusal with no words', async () => answer(500, {}), 'The dependencies could not be loaded.']
	])('as the window opens, %s: says so, and is no longer loading', async (_what, links, words) => {
		answering(links);
		const target = await opened();

		expect(said(target)).toBe(words);
		expect(target.textContent).not.toContain('Loading…');
	});

	it('a refused removal whose read again gets no answer keeps the row shown, and says both', async () => {
		let reads = 0;
		answering(async (init) => {
			if (init?.method === 'DELETE') return answer(404, { message: 'Dependency not found' });
			reads++;
			if (reads > 1) throw new TypeError('Failed to fetch');
			return answer(200, { blockedBy: [blocker], blocks: [] });
		});
		const target = await opened();
		expect(target.querySelectorAll('.dep-row')).toHaveLength(1);

		target.querySelector<HTMLButtonElement>('.dep-remove')!.click();
		await settle();

		expect(reads).toBe(2);
		expect(target.querySelectorAll('.dep-row')).toHaveLength(1);
		expect(said(target)).toBe('Dependency not found No answer from the server. The dependencies could not be loaded.');
	});

	it('a read that works shows the links and says nothing', async () => {
		answering(async () => answer(200, { blockedBy: [blocker], blocks: [] }));
		const target = await opened();

		expect(target.querySelectorAll('.dep-row')).toHaveLength(1);
		expect(said(target)).toBeUndefined();
	});
});
