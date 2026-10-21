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
 * What the list answers, and to whom, is in `tests/webhooks.test.ts`. The
 * plan is `docs/planning/cards-2329-2383-2384.md`.
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
let list: { members: Row[]; teams: Row[]; isPublic: boolean; heldWebhooks?: number };

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

/** Opens the window on board 3, as its owner. */
async function open() {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(ShareModal, { target, props: { boardId: 3, boardName: 'Website', canManage: true, onClose: () => {} } }), target };
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
