// @vitest-environment jsdom
/**
 * The card window's keys (card 2280, slice B5c of card 2012's part B),
 * mounted with the client's `mount`, as `tests/xp-leaderboard.svelte.test.ts`
 * is: this file alone takes jsdom, by the comment above. The window's own
 * `import … from 'svelte'` is given the client's runtime too, by the
 * `vi.mock('svelte')` below, as `tests/card-window-comments.svelte.test.ts`
 * does: without it the window gets the server's, whose `onMount` never runs
 * and whose `untrack` tracks, so the window's opening reads of its comments
 * and dependencies were never made here (card 2341).
 *
 *   - The window's footer says Ctrl+Enter saves, and nothing did: its
 *     `handleKeydown` answered Escape only. Ctrl+Enter (or Cmd+Enter) now
 *     saves it, once, from any box in it.
 *   - The comment box's Ctrl+Enter posts the comment and nothing more. Its
 *     handler is delegated by Svelte to the root the window is mounted in,
 *     and the window's handler is on `window`, so the box's runs first; its
 *     `stopPropagation()` stops the key at that root, and the window's
 *     handler never sees it. That is what the case below proves, since the
 *     window here is the whole `CardModal` and its `<svelte:window>` listener.
 *   - Escape in the dependency picker's search box closes the picker alone.
 *     The key went on to the window's handler, which closed the whole window
 *     and what was typed in it (found nearby by the B4 review).
 *
 * `$app/stores` is the page's, which only a running SvelteKit app has: the
 * comment list asks it who is signed in, so it is given here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
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

const MODAL = 'src/lib/components/CardModal.svelte';

/** Every request the window sent, in order, as `METHOD url`. */
let sent: string[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
let onSave: Mock<(data: unknown) => void | Promise<void>>;
let onClose: Mock<() => void>;

/** What the routes the window reads answer: empty lists, and a comment for a post. */
function answer(url: string, method: string): unknown {
	if (url.endsWith('/comments') && method === 'POST') {
		return { id: 9, cardId: 7, userId: 1, content: 'Hello', createdAt: '2026-10-20 10:00:00', updatedAt: '2026-10-20 10:00:00', username: 'alice', userEmoji: null };
	}
	if (url === '/api/categories' && method === 'POST') return { id: 5, boardId: 1, name: 'Ops', color: '#6366f1' };
	if (url === '/api/labels' && method !== 'GET') return { id: 4, boardId: 1, name: 'Bug', color: '#6366f1' };
	if (url.startsWith('/api/cards/search')) return [{ id: 12, title: 'Another card', boardId: 1, boardName: 'Board', boardEmoji: '📋', columnName: 'To Do', priority: 'medium' }];
	if (url.includes('/dependencies')) return { blockedBy: [], blocks: [] };
	if (url.includes('/tokens')) return null;
	return [];
}

beforeEach(() => {
	sent = [];
	onSave = vi.fn<(data: unknown) => void | Promise<void>>();
	onClose = vi.fn<() => void>();
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		sent.push(`${method} ${url}`);
		const body = answer(url, method);
		return { ok: true, status: 200, json: async () => body } as Response;
	}));
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	document.querySelectorAll('.confirm-modal').forEach((el) => el.remove());
	vi.unstubAllGlobals();
});

const card = {
	id: 7, columnId: 1, categoryId: null, title: 'A card', description: '', position: 0, priority: 'medium',
	colorTag: null, dueDate: null, createdAt: '2026-10-20 09:00:00', updatedAt: '2026-10-20 09:00:00',
	subtasks: [], labelIds: [], pinned: false, onHoldNote: '', businessValue: null, subBoards: [],
	assignees: [], archivedAt: null, coverUrl: null, milestoneId: null
} as unknown as CardType;

/**
 * Mounts the window, as the board page opens it, and lets its first reads
 * land: on a saved card unless `card: null` is given (the New Task window).
 */
async function draw(extra: Record<string, unknown> = {}): Promise<HTMLElement> {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(CardModal, {
		target,
		props: { card, categories: [], labels: [], boardId: 1, boardUsers: [], onSave, onClose, ...extra } as never
	});
	drawn = { component, target };
	flushSync();
	await settle();
	return target;
}

/**
 * Lets the stubbed requests answer and the window draw what they gave: five
 * microtasks and then a macrotask turn, as the comments file's `settle` has,
 * since five microtasks alone are only just enough for a read and its write.
 */
async function settle() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

/** A key pressed in `el`, bubbling as a real one does. */
function press(el: Element, key: string, mods: KeyboardEventInit = {}) {
	el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
	flushSync();
}

function click(el: Element | null) {
	expect(el).not.toBeNull();
	(el as HTMLElement).click();
	flushSync();
}

/** Types `text` into a box, as `bind:value` hears it. */
function type(el: Element | null, text: string) {
	expect(el).not.toBeNull();
	(el as HTMLTextAreaElement).value = text;
	el!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('the card window’s start-up code runs here (card 2341)', () => {
	// The window reads its comments and its dependencies in its `onMount`, which
	// runs only with the client's runtime (the `vi.mock('svelte')` above). Every
	// case below opens the window this way, so its opening reads are part of each.
	it('reads a saved card’s comments and dependencies as it opens, and a New Task window reads neither', async () => {
		await draw();
		expect(sent).toContain('GET /api/cards/7/comments');
		expect(sent).toContain('GET /api/cards/7/dependencies');

		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		sent = [];
		await draw({ card: null });
		expect(sent.filter((r) => r.includes('/comments') || r.includes('/dependencies'))).toEqual([]);
	});
});

describe('Ctrl+Enter in the card window (card 2280, slice B5c)', () => {
	it('saves the window, once, from the title box and from a box with no key handler of its own', async () => {
		const target = await draw();
		press(target.querySelector('#card-title')!, 'Enter', { ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'A card' });

		press(target.querySelector('.modal-body')!, 'Enter', { metaKey: true });
		expect(onSave).toHaveBeenCalledTimes(2);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not save on Enter alone, on Shift+Enter, or on Ctrl with another key', async () => {
		const target = await draw();
		const body = target.querySelector('.modal-body')!;
		press(body, 'Enter');
		press(body, 'Enter', { shiftKey: true });
		press(body, 's', { ctrlKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it('leaves Ctrl+Enter to a confirmation the page opened over it, as it leaves Escape', async () => {
		const target = await draw();
		const confirmation = document.createElement('div');
		confirmation.className = 'confirm-modal';
		document.body.appendChild(confirmation);
		press(target.querySelector('.modal-body')!, 'Enter', { ctrlKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it('in the Save as Template dialog saves the template, and not the window', async () => {
		const target = await draw();
		click(target.querySelector('.template-btn'));
		const name = target.querySelector('#tmpl-name');
		expect(name).not.toBeNull();
		press(name!, 'Enter', { ctrlKey: true });
		await settle();
		expect(sent.filter((r) => r.startsWith('POST'))).toEqual(['POST /api/templates']);
		expect(onSave).not.toHaveBeenCalled();
	});

	it('in the comment box posts the comment, and the key never reaches the window: no save, no close', async () => {
		const target = await draw();
		click([...target.querySelectorAll('.tab')].find((tab) => tab.textContent?.includes('Comments')) ?? null);
		await settle();
		const box = target.querySelector('textarea.comment-input');
		type(box, 'Hello');

		// A listener on window, beside the window's own: nothing of this key may reach it.
		const reachedWindow = vi.fn();
		window.addEventListener('keydown', reachedWindow);
		try {
			press(box!, 'Enter', { ctrlKey: true });
			await settle();
		} finally {
			window.removeEventListener('keydown', reachedWindow);
		}

		expect(sent.filter((r) => r.startsWith('POST'))).toEqual(['POST /api/cards/7/comments']);
		expect(reachedWindow).not.toHaveBeenCalled();
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(target.querySelector('.comment-content')?.textContent).toContain('Hello');
	});

	it('in a comment being edited saves that comment, and not the window', async () => {
		const target = await draw();
		click([...target.querySelectorAll('.tab')].find((tab) => tab.textContent?.includes('Comments')) ?? null);
		await settle();
		type(target.querySelector('textarea.comment-input'), 'Hello');
		press(target.querySelector('textarea.comment-input')!, 'Enter', { ctrlKey: true });
		await settle();

		click([...target.querySelectorAll('.comment-action-btn')].find((b) => b.textContent?.includes('Edit')) ?? null);
		const edit = target.querySelector('textarea.comment-edit-input');
		type(edit, 'Hello again');
		press(edit!, 'Enter', { ctrlKey: true });
		await settle();

		expect(sent.filter((r) => r.startsWith('PUT'))).toEqual(['PUT /api/cards/7/comments/9']);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});
});

/** Opens More options, where the sub-boards and labels are. */
function openMoreOptions(target: HTMLElement) {
	click(target.querySelector('.advanced-toggle'));
}

const buttonNamed = (target: HTMLElement, selector: string, text: string) =>
	[...target.querySelectorAll(selector)].find((b) => b.textContent?.includes(text)) ?? null;

describe('Ctrl+Enter in a name box of the card window (card 2280, slice B5c)', () => {
	// Enter in each of these boxes does the box's own job (makes the label or
	// the sub-board, saves the label's new name). Ctrl+Enter does that same
	// job there and goes no further, as in the comment box: the window used to
	// make the label or sub-board and then save and close as well.
	it('in the New label box makes the label, once, and does not save the window', async () => {
		const target = await draw();
		openMoreOptions(target);
		click(buttonNamed(target, '.label-link', '+ New label'));
		const name = target.querySelector('input[aria-label="New label name"]');
		type(name, 'Bug');
		press(name!, 'Enter', { ctrlKey: true });
		await settle();
		// Made, then put on the card, as the picker does with a label made in it.
		expect(sent.filter((r) => !r.startsWith('GET'))).toEqual(['POST /api/labels', 'PUT /api/labels']);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('in a label’s name box, editing it, saves the new name, once, and does not save the window', async () => {
		const target = await draw({ labels: [{ id: 4, boardId: 1, name: 'Bug', color: '#6366f1' }] });
		openMoreOptions(target);
		click(buttonNamed(target, '.label-link', 'Edit labels'));
		click(buttonNamed(target, '.label-toggle', 'Bug'));
		const name = target.querySelector('input[aria-label="Label name"]');
		type(name, 'Bugs');
		press(name!, 'Enter', { metaKey: true });
		await settle();
		expect(sent.filter((r) => !r.startsWith('GET'))).toEqual(['PATCH /api/labels']);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('in a saved card’s sub-board box makes the sub-board, once, and does not save the window', async () => {
		const onCreateSubBoard = vi.fn<(name: string) => void>();
		const target = await draw({ onCreateSubBoard });
		openMoreOptions(target);
		const name = target.querySelector('.subboard-name-input');
		type(name, 'Phase two');
		press(name!, 'Enter', { ctrlKey: true });
		expect(onCreateSubBoard.mock.calls).toEqual([['Phase two']]);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('in a new card’s sub-board box adds the name to the list, and does not create the card', async () => {
		const target = await draw({ card: null });
		// A title, so that a save would go through: one with none is refused in the window.
		type(target.querySelector('#card-title'), 'A new card');
		openMoreOptions(target);
		const name = target.querySelector('.subboard-name-input');
		type(name, 'Phase two');
		press(name!, 'Enter', { ctrlKey: true });
		expect(target.querySelector('.subboard-link-name')?.textContent).toBe('Phase two');
		expect(onSave).not.toHaveBeenCalled();

		// Ctrl+Enter elsewhere then creates the card, with the sub-board named.
		press(target.querySelector('.modal-body')!, 'Enter', { ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'A new card', pendingSubBoards: ['Phase two'] });
	});
});

describe('Escape in the card window’s dependency picker (card 2280, slice B5c; the B4 review’s found nearby)', () => {
	it('closes the picker alone, and Escape again closes the window', async () => {
		const target = await draw();
		click(target.querySelector('.advanced-toggle'));
		click([...target.querySelectorAll('.dep-add-btn')].find((b) => b.textContent?.includes('Add a blocker')) ?? null);
		const search = target.querySelector('.dep-picker-input');
		type(search, '#12');

		press(search!, 'Escape');
		expect(target.querySelector('.dep-picker-input')).toBeNull();
		expect(onClose).not.toHaveBeenCalled();

		press(target.querySelector('.modal-body')!, 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);

		// The search typed runs 250 ms later (debounced): let it, with `fetch`
		// still stubbed, or it reaches the real one in a later test.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(sent).toContain('GET /api/cards/search?q=%2312&exclude=7');
	});
});

// ─── The B5 review ──────────────────────────────────────────────────────────

/** A promise the test settles when it chooses: a save still on its way until then. */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe('Ctrl+Enter in the card window, after the B5 review (card 2280, slice B5c)', () => {
	it('in the New Category box makes the category, and does not save the window', async () => {
		const target = await draw();
		const chips = target.querySelectorAll('.chip');
		click(chips[1]); // the category chip
		click(buttonNamed(target, '.chip-dropdown-item', '+ New Category'));
		const name = target.querySelector('.inline-cat-input');
		type(name, 'Ops');
		press(name!, 'Enter', { ctrlKey: true });
		await settle();
		expect(sent.filter((r) => !r.startsWith('GET'))).toEqual(['POST /api/categories']);
		expect(onSave).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it('saves once while a save is on its way: a held key’s repeats, a second Ctrl+Enter, Enter in the title and the Create button are all ignored', async () => {
		const out = deferred();
		onSave.mockReturnValue(out.promise);
		const target = await draw({ card: null });
		type(target.querySelector('#card-title'), 'A new card');
		const body = target.querySelector('.modal-body')!;

		press(body, 'Enter', { ctrlKey: true });
		press(body, 'Enter', { ctrlKey: true, repeat: true });
		press(body, 'Enter', { ctrlKey: true });
		press(target.querySelector('#card-title')!, 'Enter');
		const create = target.querySelector('.btn-create') as HTMLButtonElement;
		expect(create.disabled).toBe(true);
		create.click();
		flushSync();
		expect(onSave).toHaveBeenCalledTimes(1);

		// Answered: the window may save again.
		out.resolve();
		await settle();
		expect(create.disabled).toBe(false);
		press(body, 'Enter', { ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(2);
	});

	it('does not close on Escape while a save is on its way, so a refused one keeps what was typed; closes on it once the save is answered', async () => {
		const out = deferred();
		onSave.mockReturnValue(out.promise);
		const target = await draw({ card: null });
		type(target.querySelector('#card-title'), 'A new card');
		const body = target.querySelector('.modal-body')!;
		press(body, 'Enter', { ctrlKey: true });
		expect(onSave).toHaveBeenCalledTimes(1);

		press(body, 'Escape');
		expect(onClose).not.toHaveBeenCalled();

		out.resolve();
		await settle();
		press(body, 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('closes on Cancel and on ✕ while a save is on its way: a server that never answers does not keep anyone in the window', async () => {
		for (const button of ['.btn-cancel', '.close-btn']) {
			onSave.mockReset();
			onClose.mockReset();
			onSave.mockReturnValue(deferred().promise); // never answered
			const target = await draw({ card: null });
			type(target.querySelector('#card-title'), 'A new card');
			press(target.querySelector('.modal-body')!, 'Enter', { ctrlKey: true });
			expect(onSave, button).toHaveBeenCalledTimes(1);
			const close = target.querySelector(button) as HTMLButtonElement;
			expect(close.disabled, button).toBe(false);
			close.click();
			flushSync();
			expect(onClose, button).toHaveBeenCalledTimes(1);
			unmount(drawn!.component);
			drawn!.target.remove();
			drawn = null;
		}
	});

	it('ignores a held key’s repeat even with no save on its way', async () => {
		const target = await draw();
		press(target.querySelector('.modal-body')!, 'Enter', { ctrlKey: true, repeat: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it('takes the key’s default, so a focused button is not pressed as well', async () => {
		const target = await draw();
		const cancel = target.querySelector('.btn-cancel') as HTMLButtonElement;
		cancel.focus();
		const key = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
		cancel.dispatchEvent(key);
		flushSync();
		expect(key.defaultPrevented).toBe(true);
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it('does not save while the From template picker is open', async () => {
		const target = await draw({ card: null });
		type(target.querySelector('#card-title'), 'A new card');
		click(buttonNamed(target, '.template-btn', 'From template'));
		await settle();
		expect(target.querySelector('.template-overlay')).not.toBeNull();
		press(target.querySelector('.template-dialog')!, 'Enter', { ctrlKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});

	it('does not save while the subtask window is open over it', async () => {
		const target = await draw();
		click(target.querySelector('.add-st-btn'));
		press(document.body, 'Enter', { ctrlKey: true });
		expect(onSave).not.toHaveBeenCalled();
	});
});

describe('Escape in the card window closes the innermost thing open (card 2280, slice B5c; the B5 review)', () => {
	/** Escape closes what `open` says is open and not the window; Escape again closes the window. */
	function escapeTwice(target: HTMLElement, at: () => Element, open: () => boolean) {
		expect(open()).toBe(true);
		press(at(), 'Escape');
		expect(open()).toBe(false);
		expect(onClose).not.toHaveBeenCalled();
		press(target.querySelector('.modal-body')!, 'Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
	}

	it('the Save as Template dialog', async () => {
		const target = await draw();
		click(buttonNamed(target, '.template-btn', 'Save as Template'));
		escapeTwice(target, () => target.querySelector('#tmpl-name')!, () => target.querySelector('#tmpl-name') !== null);
	});

	it('the From template picker', async () => {
		const target = await draw({ card: null });
		click(buttonNamed(target, '.template-btn', 'From template'));
		await settle();
		escapeTwice(target, () => target.querySelector('.template-dialog')!, () => target.querySelector('.template-overlay') !== null);
	});

	it('a chip’s dropdown', async () => {
		const target = await draw();
		click(target.querySelectorAll('.chip')[0]); // the priority chip
		escapeTwice(target, () => target.querySelector('.chip')!, () => target.querySelector('.chip-dropdown') !== null);
	});

	it('the New Category form', async () => {
		const target = await draw();
		click(target.querySelectorAll('.chip')[1]);
		click(buttonNamed(target, '.chip-dropdown-item', '+ New Category'));
		escapeTwice(target, () => target.querySelector('.inline-cat-input')!, () => target.querySelector('.inline-cat-input') !== null);
	});

	it('a comment being edited', async () => {
		const target = await draw();
		click(buttonNamed(target, '.tab', 'Comments'));
		await settle();
		type(target.querySelector('textarea.comment-input'), 'Hello');
		press(target.querySelector('textarea.comment-input')!, 'Enter', { ctrlKey: true });
		await settle();
		click(buttonNamed(target, '.comment-action-btn', 'Edit'));
		escapeTwice(target, () => target.querySelector('textarea.comment-edit-input')!, () => target.querySelector('textarea.comment-edit-input') !== null);
	});

	it('the New label form', async () => {
		const target = await draw();
		openMoreOptions(target);
		click(buttonNamed(target, '.label-link', '+ New label'));
		const box = () => target.querySelector('input[aria-label="New label name"]');
		escapeTwice(target, () => box()!, () => box() !== null);
	});

	it('a label being edited', async () => {
		const target = await draw({ labels: [{ id: 4, boardId: 1, name: 'Bug', color: '#6366f1' }] });
		openMoreOptions(target);
		click(buttonNamed(target, '.label-link', 'Edit labels'));
		click(buttonNamed(target, '.label-toggle', 'Bug'));
		const box = () => target.querySelector('input[aria-label="Label name"]');
		escapeTwice(target, () => box()!, () => box() !== null);
	});

	/** Opens the dependency picker ("+ Add a blocker"); with a search typed and answered, if asked. */
	async function openDependencyPicker(target: HTMLElement, search = false) {
		openMoreOptions(target);
		click(buttonNamed(target, '.dep-add-btn', 'Add a blocker'));
		if (search) {
			type(target.querySelector('.dep-picker-input'), '#12');
			await new Promise((resolve) => setTimeout(resolve, 300)); // the search is debounced
			await settle();
		}
	}
	const pickerOpen = (target: HTMLElement) => () => target.querySelector('.dep-picker') !== null;

	it('the dependency picker, with the focus on the window’s body and not on its box', async () => {
		const target = await draw();
		await openDependencyPicker(target);
		escapeTwice(target, () => target.querySelector('.modal-body')!, pickerOpen(target));
	});

	it('the dependency picker, with the focus on one of its results', async () => {
		const target = await draw();
		await openDependencyPicker(target, true);
		expect(target.querySelector('.dep-result')).not.toBeNull();
		escapeTwice(target, () => target.querySelector('.dep-result')!, pickerOpen(target));
		expect(target.querySelector('.dep-result')).toBeNull();
	});

	it('the dependency picker, with the focus on the milestone list', async () => {
		const target = await draw();
		await openDependencyPicker(target);
		escapeTwice(target, () => target.querySelector('#dep-milestone')!, pickerOpen(target));
	});

	it('the sub-board link picker', async () => {
		const target = await draw({ availableBoards: [{ id: 2, name: 'Other', emoji: '📋' }], onLinkSubBoard: vi.fn() });
		openMoreOptions(target);
		click(target.querySelector('.subboard-link-btn'));
		escapeTwice(target, () => target.querySelector('.link-picker-item')!, () => target.querySelector('.link-picker') !== null);
	});
});

describe('the card window’s unused state (card 2280, slice B5c; the B4 review’s found nearby)', () => {
	it('has no `showDueDate`: it was set from the card and never read', () => {
		const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
		expect(source).not.toMatch(/\bshowDueDate\b/);
		// The due-date chip's dropdown is another thing, and stays.
		expect(source).toMatch(/\bshowDueDateDrop\b/);
	});
});
