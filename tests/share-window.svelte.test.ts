// @vitest-environment jsdom
/**
 * The Share window and a board's webhooks (card 2329), `ShareModal` mounted
 * alone with Svelte's client runtime, as the confirm dialog's file mounts
 * it, `fetch` a stand-in that answers the list and keeps every request sent.
 *
 *   - A webhook is sent only while the account that set it up can open the
 *     board (card 2325), and no screen said when one stopped. ✕ on a person
 *     or a team whose removal would stop webhooks (`stopsWebhooks` above 0 in
 *     the list) now asks first, in the app's confirm, saying how many; **Remove**
 *     sends the removal and **Cancel** sends nothing. ✕ on any other share
 *     removes at once, as it always did.
 *   - The window says how many of the board's webhooks send nothing now
 *     (`heldWebhooks`), whatever stopped them, and says nothing at 0 or when
 *     the list gives no count (anyone but the owner and an administrator).
 *
 *   - The switch to private asks first in the same way when it would stop
 *     webhooks whose setters open the board only because it is public
 *     (`privateStopsWebhooks`, card 2385), and the list is read again after
 *     either switch; only the latest read of the list is shown.
 *
 *   - The window takes, holds and gives back the keyboard's focus (card
 *     2473, `holdFocus`): Close as it opens, the user list once the list is
 *     drawn, Tab and Shift+Tab kept inside, Escape closing it and the focus
 *     back on what opened it; while one of its confirms is up, Escape and
 *     Tab are the confirm's alone.
 *   - Each person's and team's role list is named by whose it is (card 2546).
 *
 * What the list answers, and to whom, is in `tests/webhooks.test.ts`. The
 * plans are `docs/planning/cards-2329-2383-2384.md` and
 * `docs/planning/cards-2385-2386-2387.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import ShareModal from '$lib/components/ShareModal.svelte';

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

type Row = Record<string, unknown>;

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;
/** Each request sent, as `METHOD url`, with its body read as JSON where it had one. */
let sent: { what: string; body: unknown }[] = [];
/** What the list answers: the window reads it as it opens and after each change. */
let list: { members: Row[]; teams: Row[]; isPublic: boolean; heldWebhooks?: number; privateStopsWebhooks?: number };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	sent = [];
	list = { members: [], teams: [], isPublic: false };
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url === '/api/boards/3/share' && method === 'GET') return json(list);
			if (url === '/api/boards/3/share' && method === 'DELETE') return json({ success: true });
			if (url === '/api/boards/3/share' && method === 'PATCH') return json({ success: true });
			return json([]);
		})
	);
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	flushSync();
}

/** Opens the window on board 3, as its owner, and draws it before any answer has come. */
function openNow(more: { canManage?: boolean; onClose?: () => void } = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const props = { boardId: 3, boardName: 'Website', canManage: more.canManage ?? true, onClose: more.onClose ?? (() => {}) };
	drawn = { component: mount(ShareModal, { target, props }), target };
	flushSync();
	return target;
}

/** Opens the window on board 3, as its owner, and lets its list arrive. */
async function open(more: { canManage?: boolean; onClose?: () => void } = {}) {
	const target = openNow(more);
	await settle();
	return target;
}

const member = (userId: number, username: string, stopsWebhooks: number) => ({ userId, username, email: `${username}@example.test`, emoji: '🙂', role: 'editor', stopsWebhooks });
const team = (teamId: number, teamName: string, stopsWebhooks: number) => ({ teamId, teamName, teamEmoji: '🏢', role: 'editor', stopsWebhooks });

/** The ✕ on the row naming `name`. */
function removeButton(name: string): HTMLButtonElement {
	const row = [...document.querySelectorAll('.share-item')].find((r) => r.querySelector('.share-item-name')?.textContent === name);
	return row!.querySelector<HTMLButtonElement>('.share-remove-btn')!;
}
const confirmDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Remove Access"]');
const deletes = () => sent.filter((r) => r.what === 'DELETE /api/boards/3/share').map((r) => r.body);
const button = (within: HTMLElement, text: string) => [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;

describe('✕ on a share whose removal stops webhooks asks first (card 2329)', () => {
	it('a person: says who and how many, sends nothing until Remove, and the removal on Remove', async () => {
		list.members = [member(5, 'sam', 2)];
		await open();

		removeButton('sam').click();
		flushSync();
		const dialog = confirmDialog();
		expect(dialog).not.toBeNull();
		expect(dialog!.querySelector('.confirm-message')!.textContent).toBe(
			'Removing sam stops 2 webhooks they set up on this board: nothing is sent to them until they can open the board again, or someone takes them over.'
		);
		await settle();
		expect(deletes()).toEqual([]);

		button(dialog!, 'Remove').click();
		await settle();
		expect(deletes()).toEqual([{ type: 'user', targetId: 5 }]);
		expect(confirmDialog()).toBeNull();
	});

	it('Cancel sends nothing and closes the confirm, the person still listed', async () => {
		list.members = [member(5, 'sam', 1)];
		await open();

		removeButton('sam').click();
		flushSync();
		expect(confirmDialog()!.querySelector('.confirm-message')!.textContent).toBe(
			'Removing sam stops 1 webhook they set up on this board: nothing is sent to it until they can open the board again, or someone takes it over.'
		);
		button(confirmDialog()!, 'Cancel').click();
		await settle();
		expect(confirmDialog()).toBeNull();
		expect(deletes()).toEqual([]);
		expect(removeButton('sam')).toBeTruthy();
	});

	it('a team: says its members set them up, and removes on Remove', async () => {
		list.teams = [team(9, 'Ops', 1)];
		await open();

		removeButton('Ops').click();
		flushSync();
		expect(confirmDialog()!.querySelector('.confirm-message')!.textContent).toBe(
			'Removing Ops stops 1 webhook set up by its members on this board: nothing is sent to it until those members can open the board again, or someone takes it over.'
		);
		button(confirmDialog()!, 'Remove').click();
		await settle();
		expect(deletes()).toEqual([{ type: 'team', targetId: 9 }]);
	});

	it('a person or a team whose removal stops none, or a list with no count, is removed at once with no confirm', async () => {
		list.members = [member(5, 'sam', 0), { userId: 6, username: 'kim', emoji: '🙂', role: 'viewer' }];
		list.teams = [team(9, 'Ops', 0)];
		await open();

		removeButton('sam').click();
		await settle();
		removeButton('kim').click();
		await settle();
		removeButton('Ops').click();
		await settle();
		expect(confirmDialog()).toBeNull();
		expect(deletes()).toEqual([
			{ type: 'user', targetId: 5 },
			{ type: 'user', targetId: 6 },
			{ type: 'team', targetId: 9 }
		]);
	});
});

// The review of card 2329: each read after a change put "Loading..." in place of the
// list, so the ✕ the confirm hands the focus back to was gone and the focus fell to the page.
describe('after a removal the focus stays in the Share window', () => {
	const closeButton = () => button(drawn!.target, 'Close');

	it('Remove in the confirm: the list is read again in place, and the focus goes to Close once the ✕ is gone', async () => {
		list.members = [member(5, 'sam', 1)];
		await open();

		const x = removeButton('sam');
		x.focus();
		x.click();
		flushSync();
		list = { members: [], teams: [], isPublic: false };
		button(confirmDialog()!, 'Remove').click();
		await settle();

		expect(deletes()).toEqual([{ type: 'user', targetId: 5 }]);
		expect(document.activeElement).not.toBe(document.body);
		expect(document.activeElement).toBe(closeButton());
	});

	it('a removal with no confirm: the same, and no "Loading..." while the list is read again', async () => {
		list.members = [member(5, 'sam', 0)];
		await open();
		let release!: () => void;
		const answered = new Promise<void>((done) => (release = done));
		vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url === '/api/boards/3/share' && method === 'DELETE') return json({ success: true });
			if (url === '/api/boards/3/share') {
				await answered;
				return json({ members: [], teams: [], isPublic: false });
			}
			return json([]);
		});

		const x = removeButton('sam');
		x.focus();
		x.click();
		await settle();
		expect(drawn!.target.textContent).not.toContain('Loading...');
		expect(document.activeElement).toBe(x);

		release();
		await settle();
		expect(document.querySelector('.share-item')).toBeNull();
		expect(document.activeElement).toBe(closeButton());
	});
});

describe('the Share window says how many of the board’s webhooks send nothing now (card 2329)', () => {
	const said = () => document.querySelector('.share-held')?.textContent?.replace(/\s+/g, ' ').trim();

	it('one held, in the singular, with where to read why', async () => {
		list.heldWebhooks = 1;
		await open();
		expect(said()).toBe(
			"⚠️ 1 webhook on this board sends nothing: the account that set each up can no longer open the board, or nobody is recorded as setting it up. Read the board's webhooks with your API key (GET /api/v1/boards/3/webhooks) to see why each is held, and delete it or take it over."
		);
	});

	it('several, in the plural; and the count read again after a removal', async () => {
		list.members = [member(5, 'sam', 2)];
		list.heldWebhooks = 0;
		await open();
		expect(said()).toBeUndefined();

		removeButton('sam').click();
		flushSync();
		list = { members: [], teams: [], isPublic: false, heldWebhooks: 2 };
		button(confirmDialog()!, 'Remove').click();
		await settle();
		expect(said()).toMatch(/^⚠️ 2 webhooks on this board send nothing:/);
	});

	it('nothing when the list gives no count', async () => {
		list.members = [member(5, 'sam', 0)];
		await open();
		expect(document.querySelector('.share-held')).toBeNull();
	});
});

// Card 2385: the switch to private sent its change at once, with no word of the webhooks it
// stops, and the list was not read again, so the held count stayed as before the switch.
describe('the switch to private asks first when it stops webhooks, and the list is read again (card 2385)', () => {
	const privateDialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Make Private"]');
	const patches = () => sent.filter((r) => r.what === 'PATCH /api/boards/3/share').map((r) => r.body);
	const listReads = () => sent.filter((r) => r.what === 'GET /api/boards/3/share').length;
	const theSwitch = () => document.querySelector<HTMLButtonElement>('.toggle-switch')!;
	const said = () => document.querySelector('.share-held')?.textContent?.replace(/\s+/g, ' ').trim();

	it('says how many, sends nothing on Cancel, and on Make Private sends the switch and reads the list again', async () => {
		list = { members: [], teams: [], isPublic: true, heldWebhooks: 0, privateStopsWebhooks: 2 };
		await open();

		theSwitch().click();
		flushSync();
		expect(privateDialog()!.querySelector('.confirm-message')!.textContent).toBe(
			'Making this board private stops 2 webhooks set up by accounts that can open it only because it is public: nothing is sent to them until those accounts can open the board again, or someone takes them over.'
		);
		button(privateDialog()!, 'Cancel').click();
		await settle();
		expect([privateDialog(), patches(), listReads()]).toEqual([null, [], 1]);

		theSwitch().click();
		flushSync();
		list = { members: [], teams: [], isPublic: false, heldWebhooks: 2, privateStopsWebhooks: 0 };
		button(privateDialog()!, 'Make Private').click();
		await settle();
		expect(patches()).toEqual([{ isPublic: false }]);
		expect(listReads()).toBe(2);
		expect(privateDialog()).toBeNull();
		expect(drawn!.target.textContent).toContain('Private Board');
		expect(said()).toMatch(/^⚠️ 2 webhooks on this board send nothing:/);
	});

	it('one, in the singular', async () => {
		list = { members: [], teams: [], isPublic: true, privateStopsWebhooks: 1 };
		await open();

		theSwitch().click();
		flushSync();
		expect(privateDialog()!.querySelector('.confirm-message')!.textContent).toBe(
			'Making this board private stops 1 webhook set up by an account that can open it only because it is public: nothing is sent to it until that account can open the board again, or someone takes it over.'
		);
	});

	it('with none to stop, no count, or going public, switches at once, and reads the list again after each', async () => {
		// No count (anyone but the owner and an administrator is given none).
		list = { members: [], teams: [], isPublic: true };
		await open();
		// The read after it answers a count, which the server never gives a private board: going public asks nothing even so.
		list = { members: [], teams: [], isPublic: false, privateStopsWebhooks: 3 };
		theSwitch().click();
		await settle();
		expect([privateDialog(), patches(), listReads()]).toEqual([null, [{ isPublic: false }], 2]);

		list = { members: [], teams: [], isPublic: true, privateStopsWebhooks: 0 };
		theSwitch().click();
		await settle();
		expect([privateDialog(), patches(), listReads()]).toEqual([null, [{ isPublic: false }, { isPublic: true }], 3]);

		// Public again, with none to stop.
		list = { members: [], teams: [], isPublic: false, privateStopsWebhooks: 0 };
		theSwitch().click();
		await settle();
		expect([privateDialog(), patches(), listReads()]).toEqual([null, [{ isPublic: false }, { isPublic: true }, { isPublic: false }], 4]);
	});

	it('shows only the latest read of the list: an older read answering last does not put back its list', async () => {
		list.members = [member(5, 'sam', 0), member(6, 'kim', 0)];
		await open();
		const reads: ((res: Response) => void)[] = [];
		vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url === '/api/boards/3/share' && method === 'DELETE') return json({ success: true });
			if (url === '/api/boards/3/share') return new Promise<Response>((answer) => reads.push(answer));
			return json([]);
		});

		removeButton('sam').click();
		await settle();
		removeButton('kim').click();
		await settle();
		expect(reads).toHaveLength(2);

		reads[1](json({ members: [], teams: [], isPublic: false }));
		await settle();
		reads[0](json({ members: [member(6, 'kim', 0)], teams: [], isPublic: false }));
		await settle();
		expect(document.querySelector('.share-item')).toBeNull();
	});

	// The review of card 2385: the switch was turned off (`disabled`) the moment Make Private
	// sent the change, before the confirm handed the focus back to it a macrotask later; a
	// button that is off takes no focus, so the focus stayed on the page and the read after
	// the switch moved it to Close.
	it('the focus goes back to the switch after Make Private, and stays on it with no confirm; a press while one is out sends nothing', async () => {
		list = { members: [], teams: [], isPublic: true, privateStopsWebhooks: 1 };
		await open();
		let release!: () => void;
		vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (url === '/api/boards/3/share' && method === 'PATCH') {
				await new Promise<void>((done) => (release = done));
				return json({ success: true });
			}
			if (url === '/api/boards/3/share') return json(list);
			return json([]);
		});

		theSwitch().focus();
		theSwitch().click();
		flushSync();
		list = { members: [], teams: [], isPublic: false, heldWebhooks: 1, privateStopsWebhooks: 0 };
		button(privateDialog()!, 'Make Private').click();
		// The confirm's macrotask runs while the change is still out.
		await settle();
		expect(document.activeElement).toBe(theSwitch());
		expect([theSwitch().disabled, theSwitch().getAttribute('aria-disabled'), theSwitch().getAttribute('aria-busy')]).toEqual([false, 'true', 'true']);
		theSwitch().click();
		await settle();
		expect([patches(), privateDialog()]).toEqual([[{ isPublic: false }], null]);

		release();
		await settle();
		expect(drawn!.target.textContent).toContain('Private Board');
		expect(document.activeElement).toBe(theSwitch());
		expect(theSwitch().hasAttribute('aria-disabled')).toBe(false);

		// Back to public: no confirm, and the focus stays on the switch throughout.
		list = { members: [], teams: [], isPublic: true, privateStopsWebhooks: 0 };
		theSwitch().click();
		await settle();
		expect(document.activeElement).toBe(theSwitch());
		release();
		await settle();
		expect(patches()).toEqual([{ isPublic: false }, { isPublic: true }]);
		expect(document.activeElement).toBe(theSwitch());
	});
});

// Card 2473: the window moved no focus. It stayed on the More button behind the overlay, Tab
// walked the page behind, and Escape did nothing; Add Column already held it (`holdFocus`).
describe('the Share window takes, holds and gives back the focus (card 2473)', () => {
	const closeButton = () => button(drawn!.target, 'Close');
	/** A key pressed where the focus is, bubbling to the window as a real one does; gives back whether its default was taken. */
	function press(key: string, shiftKey = false): boolean {
		const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
		(document.activeElement ?? document.body).dispatchEvent(event);
		flushSync();
		return event.defaultPrevented;
	}

	it('gives Close the focus as it opens, and the user list once the list is drawn; for someone who cannot manage, Close keeps it', async () => {
		openNow();
		expect(document.activeElement).toBe(closeButton());
		await settle();
		expect(document.activeElement).toBe(document.querySelector('.share-select'));
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		await open({ canManage: false });
		expect(document.activeElement).toBe(closeButton());
	});

	// The review of card 2473: a first read that failed still moved the focus to the user list,
	// away from Close and the line saying why.
	it('keeps the focus on Close when the first read of the list fails', async () => {
		vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
			if (url === '/api/boards/3/share') return json({ message: 'Board not found' }, 404);
			return json([]);
		});
		const target = await open();
		expect(target.querySelector('.share-error')?.textContent).toContain('Board not found');
		expect(target.querySelector('.share-select')).not.toBeNull();
		expect(document.activeElement).toBe(closeButton());
	});

	it('is named, and keeps Tab and Shift+Tab on its own controls; a Tab from outside comes back to Close', async () => {
		const target = await open();
		expect(target.querySelector('[role="dialog"]')!.getAttribute('aria-label')).toBe('Share board');
		const theSwitch = document.querySelector<HTMLButtonElement>('.toggle-switch')!;

		closeButton().focus();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(theSwitch);
		expect(press('Tab', true)).toBe(true);
		expect(document.activeElement).toBe(closeButton());

		(document.activeElement as HTMLElement).blur();
		expect(press('Tab')).toBe(true);
		expect(document.activeElement).toBe(closeButton());
	});

	it('names its user, team and role lists', async () => {
		const target = await open();
		const named = () => [...target.querySelectorAll('.share-add-form select')].map((el) => el.getAttribute('aria-label'));
		expect(named()).toEqual(['User to share with', 'Role to share with']);
		button(target, '🏢 Team').click();
		flushSync();
		expect(named()).toEqual(['Team to share with', 'Role to share with']);
	});

	// Card 2546: a row's role list had no name, so a screen reader read "Editor, combo box" with no word of whose; and its ✕ said whose nowhere.
	it('names each person’s and team’s role list and ✕ by whose they are', async () => {
		list.members = [member(5, 'sam', 0), member(6, 'ana', 0)];
		list.teams = [team(9, 'Ops', 0)];
		const target = await open();
		const named = [...target.querySelectorAll('.share-list select')].map((el) => el.getAttribute('aria-label'));
		expect(named).toEqual(['Role for sam', 'Role for ana', 'Role for team Ops']);
		// And each ✕, named "Remove access" alone on every row; its tooltip is kept.
		const removes = [...target.querySelectorAll<HTMLButtonElement>('.share-remove-btn')];
		expect(removes.map((b) => b.getAttribute('aria-label'))).toEqual(['Remove access for sam', 'Remove access for ana', 'Remove access for team Ops']);
		expect(removes.map((b) => b.title)).toEqual(['Remove access', 'Remove access', 'Remove access']);
	});

	it('closes on Escape, and gives the focus back to what opened it', async () => {
		const opener = document.createElement('button');
		document.body.appendChild(opener);
		opener.focus();
		const onClose = vi.fn();
		await open({ onClose });

		press('Escape');
		expect(onClose).toHaveBeenCalledTimes(1);

		// The page closes it by no longer drawing it.
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		await settle();
		expect(document.activeElement).toBe(opener);
	});

	it('stands aside while a confirm is up: Escape cancels the confirm alone, and Shift+Tab is the confirm’s', async () => {
		list.members = [member(5, 'sam', 1)];
		const onClose = vi.fn();
		await open({ onClose });

		removeButton('sam').click();
		flushSync();
		const cancel = button(confirmDialog()!, 'Cancel');
		expect(document.activeElement).toBe(cancel);
		expect(press('Tab', true)).toBe(true);
		expect(document.activeElement).toBe(button(confirmDialog()!, 'Remove'));

		press('Escape');
		await settle();
		expect(confirmDialog()).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		expect(deletes()).toEqual([]);

		// The hold is back once the confirm has gone.
		press('Escape');
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
