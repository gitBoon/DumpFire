// @vitest-environment jsdom
/**
 * The admin page's backup panels (card 2281, slice C1a of card 2012's part
 * C), mounted with Svelte's client runtime as the XP bars' file does, so
 * that what crosses each component's edge is run by Svelte itself: the
 * panels' own loads as they open, the add and edit forms' bound fields, the
 * history's "Show all" bound to the panel, and the Connect box reached
 * through `bind:this`. `fetch` and `window.open` are stand-ins; what each
 * request sent is kept.
 *
 * The source pins of the same code are in `tests/page-failures.test.ts` and
 * `tests/backups.test.ts`.
 *
 * Slice C1b moved the rest of the page into components, mounted here the
 * same way at the end of the file: the users panel (its form's bound fields,
 * the page's confirm and mail-panel callbacks, the invite link bound back to
 * the page, and 🔑 opening the password dialog through `bind:this`), the
 * password dialog, the teams panel, the mail panel (its own load, the
 * signed-in account handed to Send Test, its exported read) and the danger
 * zone (the reset's notice bound back to the page). `invalidateAll` is a
 * stand-in. Last, the page itself with all of them, for the superadmin and
 * for an administrator who is not: what the page joins up between its
 * panels (the mail panel reached through `bind:this`, the invite link and
 * the reset notice bound through it) and what it draws for each. Named
 * admin-backup-panels.test.ts until it covered every panel.
 *
 * Card 2362: the page's confirm and the Archived page's are the app's
 * `ConfirmModal`, and the Import Database dialog and the Connect box hold
 * the focus through `$lib/dialog-focus`; each is mounted here and its focus,
 * Tab and Escape driven.
 *
 * Card 2365: the invite link's dialog and the reset's notice hold the focus
 * too, and Manage Categories (in `tests/dashboard.test.ts`). Card 2355: a
 * member's role changed in place on the teams panel, and the Teams page
 * (`src/routes/teams/+page.svelte`, not an admin panel, mounted here beside
 * the panel that does the same) with its role when adding.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type * as Svelte from 'svelte';
import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';
import UsersPanel from '$lib/components/admin/UsersPanel.svelte';
import ResetPasswordDialog from '$lib/components/admin/ResetPasswordDialog.svelte';
import TeamsPanel from '$lib/components/admin/TeamsPanel.svelte';
import SmtpPanel from '$lib/components/admin/SmtpPanel.svelte';
import DangerZonePanel from '$lib/components/admin/DangerZonePanel.svelte';

import AdminPage from '../src/routes/admin/+page.svelte';
import BackupRestorePanel from '$lib/components/admin/BackupRestorePanel.svelte';
import ArchivedPage from '../src/routes/archived/+page.svelte';
import ArchivePanel from '$lib/components/board/ArchivePanel.svelte';
import TeamsPage from '../src/routes/teams/+page.svelte';
import { toasts } from '$lib/stores/toast';
import Toast from '$lib/components/Toast.svelte';

// The page's data is read again after a write; here it is only counted. The
// page's Toast listens for navigations, which there are none of here.
const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	invalidateAll: navigation.invalidateAll,
	goto: vi.fn(),
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
// A bare 'svelte' gives the server's runtime, whose onDestroy the page's Toast cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

// The browser's `mount`, loaded by its path: a bare 'svelte' gives the server's (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);
// The proxy SvelteKit puts a page's props in, so that a new `data` is drawn as a re-read is (the plan page's file does the same).
// Named through a variable: the package declares no types for its internal entry.
const internalEntry = 'svelte/internal/client';
const { proxy } = (await import(/* @vite-ignore */ internalEntry)) as { proxy: <T>(value: T) => T };

/** Each request the panel sent, as `METHOD url`, with its body read as JSON where it had one. */
let sent: { what: string; body: unknown }[] = [];
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement } | null = null;

const NAS = { type: 'sftp', name: 'NAS', host: 'nas.example', port: 22, username: 'backup', password: '••••••••', privateKey: '', remotePath: '/backups', hostKey: 'ssh-ed25519 SHA256:abc' };
const DRIVE = { type: 'gdrive', name: 'Drive', authMethod: 'oauth', folderId: '', clientId: 'client', clientSecret: '••••••••' };
const history = Array.from({ length: 7 }, (_, i) => ({
	id: i + 1,
	destinationType: 'sftp',
	destinationName: 'NAS',
	filename: `b${i}.db`,
	sizeBytes: 2048,
	status: 'success',
	error: null,
	durationMs: 1200,
	createdAt: '2026-10-20 09:00:00'
}));
const settings = { schedule: 'daily', scheduleTime: '02:00', scheduleDay: 0, retention: 7, notifyOnFailure: false, notifyEmail: '', destinations: [NAS, DRIVE], history };

/** An answer of the test's own for a request, ahead of the ones below (held, if it likes); undefined for those. */
let answer: ((what: string) => Response | Promise<Response> | undefined) | null = null;

/** An answer held until the case lets it go, for a save still on its way. */
function held(response: () => Response) {
	let release!: () => void;
	const answered = new Promise<Response>((resolve) => (release = () => resolve(response())));
	return { answered, release };
}

beforeEach(() => {
	sent = [];
	answer = null;
	navigation.invalidateAll.mockClear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
			const own = answer?.(`${method} ${url}`);
			if (own) return own;
			if (url === '/api/admin/backup' && method === 'GET') return Response.json(settings);
			if (url === '/api/admin/backup' && method === 'PUT') return Response.json({ ok: true });
			if (url === '/api/admin/backup' && method === 'POST') return Response.json({ results: [{ status: 'success' }] });
			if (url.startsWith('/api/admin/backup/gdrive/auth')) return Response.json({ authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s1' });
			if (url === '/api/admin/smtp') return Response.json({ appUrl: 'https://kanban.example.com', appUrlFrom: 'setting', appUrlEnvSet: false });
			// What an account holds, read before a role change or a delete is asked (card 2397's second review): nothing, unless a case says.
			if (/^\/api\/users\/\d+$/.test(url) && method === 'GET') return Response.json({ id: Number(url.split('/').at(-1)), settingsSet: null });
			return Response.json({ message: 'Not found' }, { status: 404 });
		})
	);
	vi.stubGlobal('open', vi.fn(() => ({})));
});

afterEach(() => {
	if (drawn) {
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
	}
	vi.unstubAllGlobals();
});

function draw(component: unknown, props: Record<string, unknown> = {}) {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn = { component: mount(component as typeof ScheduledBackupsPanel, { target, props: props as never }), target };
	flushSync();
	return target;
}

/** Lets every answer on its way come in, and the panel draw what it changed. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

/** Long enough for the toast's region to be filled again after it is emptied (`SAY_AFTER_MS` in Toast.svelte, 100 ms). */
async function sayingTime() {
	await new Promise((resolve) => setTimeout(resolve, 150));
	flushSync();
}

const buttonNamed = (within: ParentNode, text: string) =>
	[...within.querySelectorAll('button')].find((button) => button.textContent!.trim() === text) as HTMLButtonElement;

/** Types `text` into a box, as `bind:value` hears it. */
function type(box: HTMLInputElement, text: string) {
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

const asked = (what: string) => sent.filter((request) => request.what === what);
const lastPut = () => asked('PUT /api/admin/backup').at(-1)?.body as { destinations: Record<string, unknown>[] };

describe('the Scheduled Backups panel, mounted', () => {
	it('reads the backup settings once as it opens', async () => {
		draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/backup']);
		expect(document.body.textContent).toContain('NAS');
	});

	it('sends what is typed in the inline edit form, bound through the form to the panel', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		const form = target.querySelector('.dest-edit-form')!;
		type(form.querySelector<HTMLInputElement>('input[placeholder="Host"]')!, 'nas2.example');
		buttonNamed(form, 'Save').click();
		await settle();

		expect(lastPut().destinations[0]).toMatchObject({ type: 'sftp', name: 'NAS', host: 'nas2.example', hostKey: 'ssh-ed25519 SHA256:abc' });
		// Saved: the form is closed.
		expect(target.querySelector('.dest-edit-form')).toBeNull();
	});

	it('sends what is typed in the Add Destination form, bound through the form to the panel', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target, '+ Add Destination').click();
		flushSync();
		const form = target.querySelector('.dest-add-form')!;
		type(form.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!, 'Office');
		type(form.querySelector<HTMLInputElement>('input[placeholder="Host"]')!, 'office.example');
		buttonNamed(form, 'Add Destination').click();
		await settle();

		expect(lastPut().destinations.map((destination) => destination.name)).toEqual(['NAS', 'Drive', 'Office']);
		expect(lastPut().destinations[2]).toMatchObject({ type: 'sftp', name: 'Office', host: 'office.example', port: 22, remotePath: '/backups' });
		expect(target.querySelector('.dest-add-form')).toBeNull();
	});

	// Card 2305: the two forms share one set of fields, so only one is open at a
	// time. With both open, a name typed in the add form let the edit form's
	// Save replace the destination being edited with the new one.
	it('closes the edit form when + Add Destination opens the add form, and leaves the destination edited as it was saved', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		buttonNamed(target, '+ Add Destination').click();
		flushSync();

		expect(target.querySelectorAll('.dest-edit-form')).toHaveLength(0);
		expect(target.querySelectorAll('.dest-add-form')).toHaveLength(1);
		const name = target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!;
		expect(name.value).toBe('');
		expect(target.querySelector('.dest-card-detail')!.textContent!.trim()).toBe('nas.example:22 → /backups');

		type(name, 'Office');
		type(target.querySelector<HTMLInputElement>('.dest-add-form input[placeholder="Host"]')!, 'office.example');
		buttonNamed(target, 'Add Destination').click();
		await settle();

		expect(asked('PUT /api/admin/backup')).toHaveLength(1);
		expect(lastPut().destinations.map((destination) => destination.name)).toEqual(['NAS', 'Drive', 'Office']);
		expect(lastPut().destinations[0]).toEqual(NAS);
	});

	// The card 2305 review: what follows a save's answer acted on whichever form
	// was open by then, so a form opened while it was on its way was emptied
	// (and a Save of it then replaced the destination with blanks). ✏️ Edit and
	// + Add Destination are off while a save is on its way; each is also forced
	// on here, to show the answer leaves alone a form that is not the one that
	// sent it.
	it('keeps ✏️ Edit off while an added destination is being saved, and the answer leaves an edit form opened meanwhile as it is', async () => {
		const put = held(() => Response.json({ ok: true }));
		answer = (what) => (what === 'PUT /api/admin/backup' ? put.answered : undefined);
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target, '+ Add Destination').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!, 'Office');
		type(target.querySelector<HTMLInputElement>('.dest-add-form input[placeholder="Host"]')!, 'office.example');
		buttonNamed(target, 'Add Destination').click();
		await settle();

		const edit = buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit');
		expect(edit.disabled).toBe(true);
		expect(buttonNamed(target, '+ Add Destination').disabled).toBe(true);
		edit.disabled = false;
		edit.click();
		flushSync();
		expect(target.querySelector<HTMLInputElement>('.dest-edit-form input[placeholder="Host"]')!.value).toBe('nas.example');

		put.release();
		await settle();

		expect(lastPut().destinations.map((destination) => destination.name)).toEqual(['NAS', 'Drive', 'Office']);
		const form = target.querySelector('.dest-edit-form')!;
		expect(form.querySelector<HTMLInputElement>('input[placeholder="Destination name"]')!.value).toBe('NAS');
		expect(form.querySelector<HTMLInputElement>('input[placeholder="Host"]')!.value).toBe('nas.example');
	});

	it('keeps + Add Destination off while an edited destination is being saved, and the answer leaves an add form opened meanwhile as typed', async () => {
		const put = held(() => Response.json({ ok: true }));
		answer = (what) => (what === 'PUT /api/admin/backup' ? put.answered : undefined);
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('.dest-edit-form input[placeholder="Host"]')!, 'nas2.example');
		buttonNamed(target.querySelector('.dest-edit-form')!, 'Save').click();
		await settle();

		const add = buttonNamed(target, '+ Add Destination');
		expect(add.disabled).toBe(true);
		expect(buttonNamed(target.querySelectorAll('.dest-card')[1], '✏️ Edit').disabled).toBe(true);
		add.disabled = false;
		add.click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!, 'Office');

		put.release();
		await settle();

		expect(lastPut().destinations[0]).toMatchObject({ name: 'NAS', host: 'nas2.example' });
		expect(target.querySelector('.dest-edit-form')).toBeNull();
		expect(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!.value).toBe('Office');
	});

	it('closes the add form when ✏️ Edit opens a destination’s edit form, which shows that destination', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();

		buttonNamed(target, '+ Add Destination').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!, 'Office');
		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();

		expect(target.querySelectorAll('.dest-add-form')).toHaveLength(0);
		const form = target.querySelectorAll('.dest-edit-form');
		expect(form).toHaveLength(1);
		expect(form[0].querySelector<HTMLInputElement>('input[placeholder="Destination name"]')!.value).toBe('NAS');
		expect(form[0].querySelector<HTMLInputElement>('input[placeholder="Host"]')!.value).toBe('nas.example');
	});

	it('keeps "Show all" of the history open through the read after Run Now, which draws the history afresh', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();
		expect(target.querySelectorAll('.history-row')).toHaveLength(5);

		buttonNamed(target, '▼ Show all 7 entries').click();
		flushSync();
		expect(target.querySelectorAll('.history-row')).toHaveLength(7);

		buttonNamed(target, '▶ Run Now').click();
		await settle();

		expect(asked('POST /api/admin/backup')).toHaveLength(1);
		// The settings were read again, the loading line in place of the section meanwhile.
		expect(asked('GET /api/admin/backup')).toHaveLength(2);
		expect(target.querySelectorAll('.history-row')).toHaveLength(7);
		expect(buttonNamed(target, '▲ Show less')).toBeDefined();
	});

	it('opens Google Drive’s Connect box from a destination’s 🔗 Connect, through the box the panel holds', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();
		expect(target.textContent).not.toContain('Connect Google Drive');

		buttonNamed(target, '🔗 Connect').click();
		await settle();

		expect(asked('GET /api/admin/backup/gdrive/auth?dest=Drive')).toHaveLength(1);
		expect(window.open).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s1', '_blank', 'width=600,height=700');
		expect([...target.querySelectorAll('h2')].map((heading) => heading.textContent)).toContain('🔗 Connect Google Drive');
		expect(target.querySelector<HTMLInputElement>('input[placeholder="Paste the whole address, starting http://localhost/?state=…"]')!.disabled).toBe(false);
	});

	// Card 2362: the box took no focus and answered no Escape.
	it('gives the Connect box’s Cancel the focus, and closes the box on Escape (card 2362)', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();
		const opener = buttonNamed(target, '🔗 Connect');
		opener.focus();
		opener.click();
		await settle();
		const box = [...target.querySelectorAll<HTMLElement>('.confirm-modal')].find((each) => each.querySelector('h2')?.textContent === '🔗 Connect Google Drive')!;
		expect(document.activeElement).toBe(buttonNamed(box, 'Cancel'));

		escape();
		expect(target.textContent).not.toContain('Connect Google Drive');
		await settle();
		expect(document.activeElement).toBe(opener);
	});
});

// Card 2398: lowering Keep Last, removing a destination and switching the
// schedule off are the superadmin's; the server refuses them to anyone else.
describe('the Scheduled Backups panel for an administrator and for the superadmin (card 2398)', () => {
	const RULE =
		'Lowering Keep Last, removing a destination, switching the schedule or the failure mail off, or changing who receives the failure mail needs the superadmin.';
	const toastsShown = () => {
		let shown: { message: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string }[]))();
		return shown.map((toast) => toast.message);
	};
	/** A change as the browser makes it: the value set, then `change`, which `bind:value` and `onchange` both hear. */
	const changeTo = (box: HTMLInputElement | HTMLSelectElement, value: string) => {
		box.value = value;
		if (box instanceof HTMLInputElement) box.dispatchEvent(new Event('input', { bubbles: true }));
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};
	const keepLast = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[type="number"]')!;
	const schedule = (target: HTMLElement) => target.querySelector<HTMLSelectElement>('.sched-row select')!;
	const remove = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('.dest-card button.danger')!;
	/** Every toast gone: an earlier case's may still be up. */
	const dismissAll = () => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	};

	beforeEach(dismissAll);
	afterEach(dismissAll);

	// Card 2405's review: Keep Last keeps two lists, and the panel says so by it and with each Run Now.
	it('says by Keep Last, to an administrator and to the superadmin, and with a Run Now that succeeds, that the two kinds of copy are counted separately (card 2405)', async () => {
		const KEEP = 'Keep Last counts scheduled copies and Run Now copies separately: a Run Now removes only older Run Now copies.';
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		expect(target.querySelector('.sched-keep-note')!.textContent).toBe(KEEP);

		buttonNamed(target, '▶ Run Now').click();
		await settle();
		expect(asked('POST /api/admin/backup')).toHaveLength(1);
		expect(toastsShown()).toEqual([`Backup completed to 1 destination. ${KEEP}`]);

		unmount(drawn!.component);
		drawn!.target.remove();
		const chief = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: true });
		await settle();
		expect(chief.querySelector('.sched-keep-note')!.textContent).toBe(KEEP);
	});

	it('shows an administrator 🗑️ aria-disabled, not disabled, saying the rule when pressed, with no confirm and nothing sent', async () => {
		const confirm = vi.fn();
		const target = draw(ScheduledBackupsPanel, { confirm, isSuperadmin: false });
		await settle();

		const button = remove(target);
		expect(button.getAttribute('aria-disabled')).toBe('true');
		expect(button.disabled).toBe(false);
		expect(button.title).toBe('Removing a destination needs the superadmin');
		expect(target.querySelector('.sched-note')!.textContent).toBe(`🔒 ${RULE}`);

		button.click();
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(toastsShown()).toEqual([RULE]);
	});

	it('puts an administrator’s lower Keep Last back, sending nothing, and sends a higher one', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		expect(keepLast(target).min).toBe('7');

		changeTo(keepLast(target), '3');
		await settle();
		expect(keepLast(target).value).toBe('7');
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(toastsShown()).toEqual([RULE]);

		changeTo(keepLast(target), '9');
		await settle();
		expect(asked('PUT /api/admin/backup').map((request) => (request.body as { retention: number }).retention)).toEqual([9]);
		// Saved: 9 is now the least.
		expect(keepLast(target).min).toBe('9');
	});

	it('marks Disabled for an administrator, puts the schedule back when it is chosen, sending nothing, and sends another schedule', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		const off = schedule(target).querySelector<HTMLOptionElement>('option[value="disabled"]')!;
		expect(off.textContent).toBe('Disabled (superadmin only)');
		expect(off.getAttribute('aria-disabled')).toBe('true');

		changeTo(schedule(target), 'disabled');
		await settle();
		expect(schedule(target).value).toBe('daily');
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(toastsShown()).toEqual([RULE]);

		changeTo(schedule(target), 'weekly');
		await settle();
		expect(asked('PUT /api/admin/backup').map((request) => (request.body as { schedule: string }).schedule)).toEqual(['weekly']);
	});

	it('leaves the superadmin’s panel as it was: 🗑️ asks the confirm, Keep Last lowered and Disabled are sent, and no rule is shown', async () => {
		const confirm = vi.fn();
		const target = draw(ScheduledBackupsPanel, { confirm, isSuperadmin: true });
		await settle();

		expect(target.querySelector('.sched-note')).toBeNull();
		expect(remove(target).hasAttribute('aria-disabled')).toBe(false);
		expect(remove(target).hasAttribute('title')).toBe(false);
		expect(keepLast(target).min).toBe('1');
		const off = schedule(target).querySelector<HTMLOptionElement>('option[value="disabled"]')!;
		expect(off.textContent).toBe('Disabled');
		expect(off.hasAttribute('aria-disabled')).toBe(false);

		remove(target).click();
		expect(confirm).toHaveBeenCalledTimes(1);
		changeTo(keepLast(target), '3');
		await settle();
		changeTo(schedule(target), 'disabled');
		await settle();
		expect(asked('PUT /api/admin/backup').map((request) => {
			const body = request.body as { retention: number; schedule: string };
			return [body.retention, body.schedule];
		})).toEqual([
			[3, 'daily'],
			[3, 'disabled']
		]);
		expect(toastsShown()).not.toContain(RULE);
	});

	// Card 2408: switching the failure mail off and changing who receives it are the superadmin's too.
	const notifyBox = (target: HTMLElement) => target.querySelector<HTMLInputElement>('.sched-row input[type="checkbox"]')!;
	const notifyEmail = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[placeholder="Notification email"]');
	/** The settings with the failure mail on, to one address. */
	const mailOn = () => {
		answer = (what) => (what === 'GET /api/admin/backup' ? Response.json({ ...settings, notifyOnFailure: true, notifyEmail: 'chief@example.com' }) : undefined);
	};

	it('marks Email on failure and its address for an administrator, ticks it again and puts the address back with the rule, sending nothing (card 2408)', async () => {
		mailOn();
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		expect(target.querySelector('.sched-note')!.textContent).toBe(`🔒 ${RULE}`);
		const box = notifyBox(target);
		expect([box.checked, box.disabled, box.getAttribute('aria-disabled'), box.title]).toEqual([true, false, 'true', 'Switching the failure mail off needs the superadmin']);
		const address = notifyEmail(target)!;
		expect([address.value, address.readOnly, address.getAttribute('aria-disabled'), address.title]).toEqual([
			'chief@example.com',
			true,
			'true',
			'Changing who receives the failure mail needs the superadmin'
		]);

		box.click();
		flushSync();
		await settle();
		expect(notifyBox(target).checked).toBe(true);
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(toastsShown()).toEqual([RULE]);

		dismissAll();
		changeTo(notifyEmail(target)!, 'chief@example.com, ann@example.com');
		await settle();
		expect(notifyEmail(target)!.value).toBe('chief@example.com');
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(toastsShown()).toEqual([RULE]);
	});

	/** What each save sent of the failure mail: a field not sent is left out. */
	const notifySent = () =>
		asked('PUT /api/admin/backup').map((request) => {
			const body = request.body as Record<string, unknown>;
			return Object.fromEntries(['notifyOnFailure', 'notifyEmail'].filter((field) => field in body).map((field) => [field, body[field]]));
		});

	it('lets an administrator tick Email on failure on, sending that alone of the failure mail, and marks it once saved (card 2408)', async () => {
		answer = (what) => (what === 'GET /api/admin/backup' ? Response.json({ ...settings, notifyEmail: 'chief@example.com' }) : undefined);
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		expect(notifyBox(target).hasAttribute('aria-disabled')).toBe(false);
		expect(notifyEmail(target)).toBeNull();

		notifyBox(target).click();
		flushSync();
		await settle();

		expect(notifySent()).toEqual([{ notifyOnFailure: true }]);
		expect(toastsShown()).not.toContain(RULE);
		expect(notifyBox(target).getAttribute('aria-disabled')).toBe('true');
		expect(notifyEmail(target)!.readOnly).toBe(true);
	});

	it('leaves the superadmin’s Email on failure and its address as they were: unmarked, and each change sent (card 2408)', async () => {
		mailOn();
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: true });
		await settle();
		expect(notifyBox(target).hasAttribute('aria-disabled')).toBe(false);
		expect(notifyBox(target).hasAttribute('title')).toBe(false);
		const address = notifyEmail(target)!;
		expect([address.readOnly, address.hasAttribute('aria-disabled'), address.hasAttribute('title')]).toEqual([false, false, false]);

		changeTo(address, 'ops@example.com');
		await settle();
		notifyBox(target).click();
		flushSync();
		await settle();

		// Each save sends what it changed of the failure mail.
		expect(notifySent()).toEqual([{ notifyEmail: 'ops@example.com' }, { notifyOnFailure: false }]);
		expect(toastsShown()).not.toContain(RULE);
	});

	// Card 2408's review: the box is read-only for an administrator, so typing or pasting never reached the put-back.
	it('says the rule when an administrator types, deletes or pastes in the address box, and leaves Tab and the arrows be (card 2408)', async () => {
		mailOn();
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		const address = notifyEmail(target)!;
		const key = (name: string, extra: KeyboardEventInit = {}) => {
			const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...extra });
			address.dispatchEvent(event);
			flushSync();
			return event.defaultPrevented;
		};

		expect([key('Tab'), key('ArrowLeft'), key('c', { ctrlKey: true })]).toEqual([false, false, false]);
		expect(toastsShown()).toEqual([]);

		expect(key('a')).toBe(true);
		expect(toastsShown()).toEqual([RULE]);
		dismissAll();
		expect(key('Backspace')).toBe(true);
		expect(toastsShown()).toEqual([RULE]);
		dismissAll();
		const paste = new Event('paste', { bubbles: true, cancelable: true });
		address.dispatchEvent(paste);
		flushSync();
		expect(paste.defaultPrevented).toBe(true);
		expect(toastsShown()).toEqual([RULE]);
		dismissAll();
		const typed = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
		address.dispatchEvent(typed);
		flushSync();
		expect(typed.defaultPrevented).toBe(true);
		expect(toastsShown()).toEqual([RULE]);
		expect(asked('PUT /api/admin/backup')).toEqual([]);
		expect(address.value).toBe('chief@example.com');
	});

	it('leaves the superadmin’s typing and pasting in the address box alone (card 2408)', async () => {
		mailOn();
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: true });
		await settle();
		const address = notifyEmail(target)!;
		const typed = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
		const paste = new Event('paste', { bubbles: true, cancelable: true });
		address.dispatchEvent(typed);
		address.dispatchEvent(paste);
		flushSync();

		expect([typed.defaultPrevented, paste.defaultPrevented]).toEqual([false, false]);
		expect(toastsShown()).toEqual([]);
	});

	// Card 2408's review: every save sent the failure mail as last read, so a panel left open was refused for the superadmin's change since.
	it('sends nothing of the failure mail when an administrator raises Keep Last on a panel read before the superadmin changed the recipients (card 2408)', async () => {
		mailOn();
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		// Meanwhile the superadmin sends the mail elsewhere: the server holds another address than the panel shows.
		answer = (what) => {
			if (what === 'GET /api/admin/backup') return Response.json({ ...settings, notifyOnFailure: true, notifyEmail: 'boss@example.com' });
			if (what === 'PUT /api/admin/backup') {
				const body = sent.at(-1)!.body as Record<string, unknown>;
				// As the server rules (card 2408): a change of recipients from an administrator is refused.
				if ('notifyEmail' in body && body.notifyEmail !== 'boss@example.com') return Response.json({ message: 'needs the superadmin' }, { status: 403 });
				return Response.json({ ok: true });
			}
			return undefined;
		};

		changeTo(keepLast(target), '9');
		await settle();

		expect(notifySent()).toEqual([{}]);
		expect(toastsShown()).toEqual(['Backup settings saved']);
	});

	// The card 2398 review: a refused save left the controls showing what was refused.
	it('reads the settings again quietly after a refused save, so Keep Last and the list show what the server holds, and says so', async () => {
		answer = (what) => (what === 'PUT /api/admin/backup' ? Response.json({ message: 'Forbidden' }, { status: 403 }) : undefined);
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();

		changeTo(keepLast(target), '9');
		await settle();

		expect(asked('PUT /api/admin/backup')).toHaveLength(1);
		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/backup', 'PUT /api/admin/backup', 'GET /api/admin/backup']);
		expect(keepLast(target).value).toBe('7');
		expect(keepLast(target).min).toBe('7');
		expect(toastsShown()).toEqual(['Forbidden. The settings shown are the ones the server holds.']);

		// A destination added and refused: off the list again, the list as the server holds it.
		dismissAll();
		buttonNamed(target, '+ Add Destination').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!, 'Office');
		buttonNamed(target, 'Add Destination').click();
		await settle();
		expect([...target.querySelectorAll('.dest-name')].map((name) => name.textContent)).toEqual(['NAS', 'Drive']);
		expect(asked('GET /api/admin/backup')).toHaveLength(3);
		// Still in the form as typed.
		expect(target.querySelector<HTMLInputElement>('input[placeholder="Destination name (e.g. Production NAS)"]')!.value).toBe('Office');
	});

	it('says so where the settings cannot be read back after a refused save', async () => {
		let reads = 0;
		answer = (what) => {
			if (what === 'PUT /api/admin/backup') return Response.json({ message: 'Forbidden' }, { status: 403 });
			if (what === 'GET /api/admin/backup' && ++reads > 1) return Response.json({ message: 'Server error' }, { status: 500 });
			return undefined;
		};
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: true });
		await settle();

		changeTo(keepLast(target), '9');
		await settle();

		expect(toastsShown()).toEqual(['Forbidden. The page could not read the settings back: reload it before changing them again.']);
	});

	// The card 2398 review: a rename is the old destination removed, said under the name before it is tried.
	it('says under the edit form’s name, to an administrator alone, that renaming needs the superadmin', async () => {
		const hint = 'Renaming needs the superadmin: a destination renamed is the old one removed.';
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: false });
		await settle();
		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		expect(target.querySelector('.dest-edit-form .dest-name-hint')!.textContent!.trim()).toBe(hint);
		unmount(drawn!.component);
		drawn!.target.remove();

		const chief = draw(ScheduledBackupsPanel, { confirm: vi.fn(), isSuperadmin: true });
		await settle();
		buttonNamed(chief.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		expect(chief.querySelector('.dest-edit-form')).not.toBeNull();
		expect(chief.querySelector('.dest-name-hint')).toBeNull();
	});
});

// Card 2417: the Run Now toast said only how many failed, the reasons in Backup History alone.
describe('the Run Now toast names each destination that failed and why (card 2417)', () => {
	const KEEP = 'Keep Last counts scheduled copies and Run Now copies separately: a Run Now removes only older Run Now copies.';
	const toastsShown = () => {
		let shown: { message: string; type: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string; type: string }[]))();
		return shown.map((toast) => [toast.type, toast.message]);
	};
	const dismissAll = () => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	};
	/** Run Now pressed, the server answering `results`. */
	async function runNow(results: Record<string, unknown>[]) {
		answer = (what) => (what === 'POST /api/admin/backup' ? Response.json({ results }) : undefined);
		const target = draw(ScheduledBackupsPanel, { confirm: vi.fn() });
		await settle();
		buttonNamed(target, '▶ Run Now').click();
		await settle();
		expect(asked('POST /api/admin/backup')).toHaveLength(1);
	}

	beforeEach(dismissAll);
	afterEach(dismissAll);

	it('says each failed destination’s name and reason, as text: markup in a reason is shown, not drawn', async () => {
		// The page's own toast, to read what is drawn.
		const shelf = document.createElement('div');
		document.body.appendChild(shelf);
		const toast = mount(Toast, { target: shelf });
		onTestFinished(() => {
			unmount(toast);
			shelf.remove();
		});

		await runNow([
			{ destination: 'NAS', status: 'failed', message: '<b>refused</b>', durationMs: 5 },
			{ destination: 'Drive', status: 'success', message: 'Uploaded b.db (2.0 KB)', durationMs: 5 },
			{ destination: '<i>Tape</i>', status: 'failed', message: 'Connection reset.', durationMs: 5 }
		]);

		const said = '2 of 3 backup(s) failed: NAS: <b>refused</b>; <i>Tape</i>: Connection reset.';
		expect(toastsShown()).toEqual([['error', said]]);
		flushSync();
		const drawnToast = shelf.querySelector('.toast-msg')!;
		expect(drawnToast.textContent).toBe(said);
		expect(drawnToast.querySelector('b, i')).toBeNull();
	});

	it('puts each reason on one line, cuts a long one, and counts the destinations past the third', async () => {
		const long = `Permission denied\n\tat ${'x'.repeat(400)}`;
		await runNow(['A', 'B', 'C', 'D', 'E'].map((destination) => ({ destination, status: 'failed', message: long, durationMs: 5 })));

		const [[type, message]] = toastsShown();
		expect(type).toBe('error');
		const cut = `Permission denied at ${'x'.repeat(160 - 'Permission denied at '.length - 1)}…`;
		expect(message).toBe(`5 of 5 backup(s) failed: A: ${cut}; B: ${cut}; C: ${cut}; and 2 more (see Backup History).`);
		expect(message).not.toContain('\n');
	});

	it('says, in a warning that stays, where an upload succeeded but Backup History could not record it', async () => {
		await runNow([
			{ destination: 'NAS', status: 'success', message: 'Uploaded b.db (2.0 KB)', durationMs: 5, note: 'Uploaded, but Backup History could not record it: database or disk is full' }
		]);

		expect(toastsShown()).toEqual([
			['warning', `Backup completed to 1 destination. NAS: Uploaded, but Backup History could not record it: database or disk is full. ${KEEP}`]
		]);
	});
});

/** A Tab (or Shift+Tab) pressed where the focus is, bubbling as a real one does; gives back whether its default was taken. */
function tab(shiftKey = false): boolean {
	const key = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
	(document.activeElement ?? document.body).dispatchEvent(key);
	flushSync();
	return key.defaultPrevented;
}

/** Escape pressed, as the window hears it. */
function escape() {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	flushSync();
}

// Card 2362: the import's warning and choices were a dialog of the panel's own, with no focus and no Escape.
describe('the Import Database dialog, mounted (card 2362)', () => {
	it('gives Cancel the focus, keeps Tab on its own stops, closes on Escape opening no file picker, and gives the focus back to Import', async () => {
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		const opener = target.querySelector<HTMLButtonElement>('.btn-backup.import')!;
		const picker = vi.spyOn(target.querySelector<HTMLInputElement>('.hidden-input')!, 'click');
		opener.focus();
		opener.click();
		flushSync();

		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const cancel = buttonNamed(dialog, 'Cancel');
		const confirmButton = buttonNamed(dialog, 'Confirm');
		const chosen = dialog.querySelector<HTMLInputElement>('input[type="radio"]:checked')!;
		expect(chosen.value).toBe('keep');
		expect(document.activeElement).toBe(cancel);
		// From its last stop round to its first, the chosen way to restore, and back.
		confirmButton.focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(chosen);
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(confirmButton);
		// From the page behind, back to Cancel; Tab from Cancel to Confirm is the browser's own.
		opener.focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(cancel);
		expect(tab()).toBe(false);

		escape();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		await settle();
		expect(document.activeElement).toBe(opener);
		expect(picker).not.toHaveBeenCalled();
	});
});

// Card 2362: the Archived page's confirm was its own, with no focus and no Escape.
describe('the Archived page’s confirm, mounted (card 2362)', () => {
	const archivedData = {
		archivedCards: [
			{ id: 9, title: 'Old idea', description: '', priority: 'low', archivedAt: '2026-10-20 09:00:00', createdAt: '2026-10-01 09:00:00', boardName: 'Website', boardEmoji: '📋', boardId: 3 }
		],
		isAdmin: true
	};

	it('asks with the app’s confirm dialog: Cancel has the focus, Escape closes it deleting nothing and gives the focus back; Delete Forever deletes', async () => {
		answer = (what) => (what === 'DELETE /api/cards/9?permanent=true' ? Response.json({ success: true }) : undefined);
		const target = draw(ArchivedPage, { data: archivedData });
		const opener = target.querySelector<HTMLButtonElement>('button[title="Delete permanently"]')!;
		opener.focus();
		opener.click();
		flushSync();

		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('h3')?.textContent).toBe('Delete Permanently');
		expect(document.activeElement).toBe(buttonNamed(dialog, 'Cancel'));
		escape();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		await settle();
		expect(document.activeElement).toBe(opener);
		expect(asked('DELETE /api/cards/9?permanent=true')).toHaveLength(0);

		opener.click();
		flushSync();
		buttonNamed(document.querySelector<HTMLElement>('.confirm-modal')!, 'Delete Forever').click();
		await settle();
		expect(asked('DELETE /api/cards/9?permanent=true')).toHaveLength(1);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});
});

// Milestone 22, card 2461: an option archived from upstream is a discard, and
// the Archived page and the board's Archived Cards panel say so.
describe('the archive markers, mounted (card 2461)', () => {
	const card = { description: '', priority: 'low', archivedAt: '2026-10-20 09:00:00', createdAt: '2026-10-01 09:00:00', boardName: 'Website', boardEmoji: '📋', boardId: 3 };
	const marks = (target: HTMLElement, item: string, title: string, mark: string) =>
		[...target.querySelectorAll(item)].map((row) => [row.querySelector(title)!.textContent, row.querySelector(mark)?.textContent?.trim() ?? null]);

	it('the Archived page marks a discarded card "Discarded", and no other', () => {
		const target = draw(ArchivedPage, {
			data: {
				archivedCards: [
					{ ...card, id: 9, title: 'Old idea', discardedAt: '2026-10-20 09:00:00' },
					{ ...card, id: 8, title: 'Old work', discardedAt: null }
				],
				isAdmin: true
			}
		});
		expect(marks(target, '.archived-card', '.archived-card-title', '.archived-card-discarded')).toEqual([
			['Old idea', 'Discarded'],
			['Old work', null]
		]);
	});

	it('the board’s Archived Cards panel marks a discarded card "Discarded", and no other', () => {
		const target = draw(ArchivePanel, {
			cards: [
				{ id: 9, title: 'Old idea', archivedAt: '2026-10-20 09:00:00', discardedAt: '2026-10-20 09:00:00' },
				{ id: 8, title: 'Old work', archivedAt: '2026-10-20 09:00:00', discardedAt: null }
			],
			loading: false,
			onClose: () => {},
			onRestore: () => {},
			onDeleteForever: () => {}
		});
		expect(marks(target, '.archive-card', '.archive-card-title', '.archive-card-discarded')).toEqual([
			['Old idea', 'Discarded'],
			['Old work', null]
		]);
	});
});

describe('the App URL panel, mounted', () => {
	it('reads the App URL once as it opens, and shows it', async () => {
		const target = draw(AppUrlPanel);
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp']);
		expect(target.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe('https://kanban.example.com');
	});

	// Card 2401: an App URL from APP_URL was shown as if it were saved.
	// Its review: what clearing a saved App URL goes back to, APP_URL or ORIGIN, is said by whether APP_URL is set.
	const FROM = {
		environment: "From the server's configuration (APP_URL). Saving it unchanged leaves it there, so a later change of APP_URL still applies.",
		setting: "Saved here, ahead of the server's configuration (APP_URL). Clear it and save to use the server's configuration (APP_URL) again.",
		settingNoEnv: "Saved here; the server's configuration sets no APP_URL. Clear it and save to use ORIGIN, the server's own address."
	};
	const UNREAD = '⚠️ The page could not read the App URL settings: reload the page before saving.';

	it.each([
		['environment', true, 'https://env.example.com', FROM.environment, false],
		['setting', true, 'https://saved.example.com', FROM.setting, false],
		['setting', false, 'https://saved.example.com', FROM.settingNoEnv, false],
		['none', false, '', null, true]
	] as const)('says under the field where the App URL comes from: %s, APP_URL set %s (card 2401)', async (appUrlFrom, appUrlEnvSet, appUrl, line, warned) => {
		answer = (what) => (what === 'GET /api/admin/smtp' ? Response.json({ configured: false, appUrl, appUrlFrom, appUrlEnvSet }) : undefined);
		const target = draw(AppUrlPanel);
		await settle();

		expect(target.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(appUrl);
		expect(target.querySelector('.app-url-from')?.textContent?.trim() ?? null).toBe(line);
		expect(target.textContent!.includes('No App URL set.')).toBe(warned);
		expect(target.querySelector('.app-url-unread')).toBeNull();
		expect(buttonNamed(target, 'Save').disabled).toBe(false);
	});

	it('hides where the App URL comes from while the field holds another, and shows it again once it holds the one read (card 2401 review)', async () => {
		answer = (what) =>
			what === 'GET /api/admin/smtp' ? Response.json({ configured: false, appUrl: 'https://env.example.com', appUrlFrom: 'environment', appUrlEnvSet: true }) : undefined;
		const target = draw(AppUrlPanel);
		await settle();
		const field = target.querySelector<HTMLInputElement>('input[type="url"]')!;

		type(field, 'https://typed.example.com');
		expect(target.querySelector('.app-url-from')).toBeNull();
		type(field, 'https://env.example.com');
		expect(target.querySelector('.app-url-from')?.textContent?.trim()).toBe(FROM.environment);
	});

	// Its review: Save before the GET's answer sent the empty field, which cleared a stored App URL.
	it('keeps Save off until the App URL is read, and off with the reason where it could not be (card 2401 review)', async () => {
		const get = held(() => Response.json({ message: 'Server error' }, { status: 500 }));
		answer = (what) => (what === 'GET /api/admin/smtp' ? get.answered : undefined);
		const target = draw(AppUrlPanel);
		await settle();

		// On its way: nothing to save from, and nothing said yet.
		expect(buttonNamed(target, 'Save').disabled).toBe(true);
		expect(target.querySelector('.app-url-unread')).toBeNull();
		expect(target.textContent!.includes('No App URL set.')).toBe(false);

		get.release();
		await settle();
		expect(buttonNamed(target, 'Save').disabled).toBe(true);
		expect(target.querySelector('.app-url-unread')?.textContent?.trim()).toBe(UNREAD);
		expect(target.textContent!.includes('No App URL set.')).toBe(false);
		buttonNamed(target, 'Save').click();
		await settle();
		expect(asked('PUT /api/admin/smtp')).toEqual([]);
	});

	it('keeps Save off with the reason where the server cannot be reached (card 2401 review)', async () => {
		answer = (what) => (what === 'GET /api/admin/smtp' ? Promise.reject(new TypeError('Failed to fetch')) : undefined);
		const target = draw(AppUrlPanel);
		await settle();

		expect(buttonNamed(target, 'Save').disabled).toBe(true);
		expect(target.querySelector('.app-url-unread')?.textContent?.trim()).toBe(UNREAD);
	});

	it('sends the field as it stands on Save, then reads the App URL again and shows where it now comes from (card 2401)', async () => {
		let reads = 0;
		answer = (what) => {
			if (what === 'PUT /api/admin/smtp') return Response.json({ success: true });
			if (what !== 'GET /api/admin/smtp') return undefined;
			reads++;
			return Response.json(
				reads === 1
					? { configured: true, appUrl: 'https://saved.example.com', appUrlFrom: 'setting' }
					: { configured: true, appUrl: 'https://env.example.com', appUrlFrom: 'environment' }
			);
		};
		const target = draw(AppUrlPanel);
		await settle();
		const field = target.querySelector<HTMLInputElement>('input[type="url"]')!;

		type(field, '');
		buttonNamed(target, 'Save').click();
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp', 'PUT /api/admin/smtp', 'GET /api/admin/smtp']);
		expect(asked('PUT /api/admin/smtp')[0].body).toEqual({ appUrl: '' });
		expect(field.value).toBe('https://env.example.com');
		expect(target.querySelector('.app-url-from')?.textContent?.trim()).toBe(FROM.environment);
	});
});

// ─── The rest of the page (card 2281, slice C1b) ─────────────────────────────

const chief = { id: 1, username: 'chief', email: 'chief@example.com', emoji: '👑', role: 'superadmin' };
const bob = { id: 2, username: 'bob', email: 'bob@example.com', emoji: '🙂', role: 'user', apiKeys: 1, webhooks: 0, reportSchedules: 0 };
/** What the admin page's load gives its panels, as much of it as they read. */
const pageData = {
	currentUser: chief,
	users: [{ ...chief, apiKeys: null, webhooks: null, reportSchedules: null }, bob],
	teams: [{ id: 7, name: 'Ops', emoji: '🏢', members: [] }],
	boards: [],
	dbSizeBytes: 0
};

/**
 * `props` with a prop the page binds, as the compiled `bind:` hands it over:
 * a getter and a setter, so that what the component sets it to is kept in
 * `box.value`.
 */
function bound(props: Record<string, unknown>, name: string, box: { value: unknown }): Record<string, unknown> {
	return Object.defineProperty(props, name, {
		enumerable: true,
		get: () => box.value,
		set: (value: unknown) => {
			box.value = value;
		}
	});
}

describe('the users panel, mounted', () => {
	it('sends what is typed in Add User, hands the invite link back to the page, and asks the page for the mail panel’s read', async () => {
		answer = (what) =>
			what === 'POST /api/users'
				? Response.json({ username: 'carol', mailSent: false, mailProblem: 'no mail server', inviteUrl: 'http://localhost/invite/t1' })
				: undefined;
		const link = { value: null as unknown };
		const loadMailStatus = vi.fn();
		const target = draw(UsersPanel, bound({ data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus }, 'inviteLink', link));

		buttonNamed(target, '+ Add User').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!, 'carol');
		type(target.querySelector<HTMLInputElement>('input[placeholder="Email"]')!, 'carol@example.com');
		buttonNamed(target, 'Create').click();
		await settle();

		expect(asked('POST /api/users').map((request) => request.body)).toEqual([{ username: 'carol', email: 'carol@example.com', emoji: '👤', role: 'user' }]);
		expect(link.value).toEqual({
			url: 'http://localhost/invite/t1',
			username: 'carol',
			message: 'User carol was made, but the invite mail could not be sent: no mail server.',
			// Where the focus goes back to after Done (card 2365's review).
			returnTo: buttonNamed(target, '+ Add User')
		});
		expect((link.value as { returnTo: unknown }).returnTo).toBe(buttonNamed(target, '+ Add User'));
		expect(loadMailStatus).toHaveBeenCalledTimes(1);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('asks the page’s confirm before a delete, whose action sends it', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toBe('Delete User');
		await confirm.mock.calls[0][2]();
		await settle();

		expect(asked('DELETE /api/users/2')).toHaveLength(1);
	});

	// Card 2380: the delete is refused for an account that alone owns a team (card 2377); the confirmation says so first.
	it('names in the confirmation the teams the account alone owns, from the page’s data, in name order, and still sends the delete on Confirm', async () => {
		const member = (userId: number, role: string) => ({ userId, role, username: userId === 1 ? 'chief' : 'bob', emoji: '🙂' });
		const teams = [
			{ id: 11, name: 'Zeta', emoji: '🏢', members: [member(2, 'owner')] },
			{ id: 12, name: 'Shared', emoji: '🏢', members: [member(2, 'owner'), member(1, 'owner')] },
			{ id: 13, name: 'Alpha', emoji: '🏢', members: [member(2, 'owner'), member(1, 'member')] },
			{ id: 14, name: 'Helped', emoji: '🏢', members: [member(2, 'member'), member(1, 'owner')] },
			{ id: 15, name: 'Ownerless', emoji: '🏢', members: [member(2, 'member')] }
		];
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: { ...pageData, teams }, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message] = confirm.mock.calls[0];
		expect(title).toBe('Delete User');
		expect(message).toMatch(
			/^Delete user "bob"\? They are the only owner of: Alpha, Zeta, so the delete will be refused: make someone else an owner or delete those teams first\. Their comments, /
		);
		await confirm.mock.calls[0][2]();
		await settle();
		expect(asked('DELETE /api/users/2')).toHaveLength(1);
	});

	it('says nothing of teams in the confirmation for an account that alone owns none (card 2380)', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm.mock.calls[0][1]).toMatch(/^Delete user "bob"\? Their comments, /);
		expect(confirm.mock.calls[0][1]).not.toContain('only owner');
	});

	it('opens the password dialog with 🔑, through the dialog the panel holds, and the dialog sends the reset', async () => {
		answer = (what) =>
			what === 'PUT /api/users/2/password' ? Response.json({ sessionsEnded: 1, apiKeysEnded: 1, webhooksSwitchedOff: 0, reportSchedulesPaused: 0 }) : undefined;
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		expect(target.textContent).not.toContain('Enter a new password for');

		// The superadmin's own row first, then bob's.
		target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[1].click();
		await settle();

		expect([...target.querySelectorAll('h2')].map((heading) => heading.textContent)).toContain('🔑 Reset Password');
		expect(target.textContent).toContain('Enter a new password for bob.');
		// The counts are read again as it opens, and shown once they have been.
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(target.textContent).toContain('They have 1 API key, which stops working.');
		type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
		buttonNamed(target, 'Reset Password').click();
		await settle();

		expect(asked('PUT /api/users/2/password').map((request) => request.body)).toEqual([{ password: 'a-new-password' }]);
		expect(target.textContent).not.toContain('Enter a new password for bob.');
	});
});

// Card 2397: an administrator made a user, or deleted, takes with them the mail
// settings, the App URL and the destinations they last set; the answer says so.
describe('the users panel says what a role change or a delete removed (card 2397)', () => {
	const toastsShown = () => {
		let shown: { message: string; type: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string; type: string }[]))();
		return shown.map((toast) => [toast.type, toast.message]);
	};
	const REMOVED = { mail: true, appUrl: true, destinations: ["Bob's", 'NAS'] };
	/** The settings in words, as the confirmation and the warning both say them (the card 2397 review). */
	const NAMED =
		'the mail settings, so no mail is sent, invites and password resets included, until an administrator sets them again in Email / SMTP; ' +
		"the App URL, so the links in mail point to the server's APP_URL, or else its ORIGIN; the backup destinations \"Bob's\", \"NAS\"";
	const WORDS = `What bob had set was removed: ${NAMED}.`;
	/** Bob as an administrator the page's data says set `REMOVED`, for the confirmations. */
	const bobHolding = { ...bob, role: 'admin', settingsSet: REMOVED };
	const holdingData = { ...pageData, users: [pageData.users[0], bobHolding] };
	/** Bob's picker set to `role`, as the browser changes it. */
	const choose = (target: HTMLElement, role: string) => {
		const picker = target.querySelector<HTMLSelectElement>('select[aria-label="bob\'s role"]')!;
		picker.value = role;
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};
	const changeButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('button[aria-label="Change bob\'s role"]')!;
	/** Every toast gone: an earlier case's may still be up. */
	const dismissAll = () => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	};

	beforeEach(dismissAll);
	afterEach(dismissAll);

	it('says what went with bob’s role in a warning that stays, and tells the page what went', async () => {
		answer = (what) => (what === 'PUT /api/users/2' ? Response.json({ id: 2, role: 'user', invitesEnded: 0, settingsRemoved: REMOVED }) : undefined);
		const settingsRemoved = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });
		choose(target, 'admin');

		changeButton(target).click();
		await settle();

		expect(toastsShown()).toEqual([['warning', `Role updated. ${WORDS}`]]);
		expect(settingsRemoved.mock.calls).toEqual([[REMOVED]]);
	});

	it('says what went with bob’s account, and tells the page what went', async () => {
		const went = { mail: false, appUrl: false, destinations: ["Bob's"] };
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true, settingsRemoved: went }) : undefined);
		const confirm = vi.fn();
		const settingsRemoved = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2]();
		await settle();

		expect(toastsShown()).toEqual([['warning', 'User deleted. What bob had set was removed: the backup destination "Bob\'s".']]);
		expect(settingsRemoved.mock.calls).toEqual([[went]]);
	});

	/** Bob's holdings as the server answers them just before a question (the second review), and the PUT's and DELETE's answers. */
	const holding = (what: string) =>
		what === 'GET /api/users/2'
			? Response.json({ id: 2, settingsSet: REMOVED })
			: what === 'PUT /api/users/2'
				? Response.json({ id: 2, role: 'user', invitesEnded: 0, settingsRemoved: REMOVED })
				: undefined;

	// The card 2397 review: the role picker sent at once, and the delete's confirmation named nothing of the settings.
	// Its second review: what bob holds is read just before asking, whatever the page's data says.
	it('asks first, naming what would go, before bob is made a user, and sends the change only on Confirm', async () => {
		answer = holding;
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: holdingData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'user');

		changeButton(target).click();
		await settle();

		expect(asked('GET /api/users/2')).toHaveLength(1);
		expect(asked('PUT /api/users/2')).toEqual([]);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0].slice(0, 2)).toEqual(['Change Role', `Make bob a user? This removes what they set: ${NAMED}.`]);
		await confirm.mock.calls[0][2]();
		await settle();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user' }]);
	});

	it('sends a role change at once where nothing would go: bob made an administrator, or made a user holding nothing (the controls)', async () => {
		answer = (what) => (what === 'PUT /api/users/2' ? Response.json({ id: 2, role: 'admin', invitesEnded: 0 }) : undefined);
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'admin');
		changeButton(target).click();
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(asked('PUT /api/users/2')).toHaveLength(1);
		// Made an administrator: nothing goes, so nothing is read first.
		expect(asked('GET /api/users/2')).toEqual([]);
		unmount(drawn!.component);
		drawn!.target.remove();

		const plain = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const again = draw(UsersPanel, { data: plain, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(again, 'user');
		changeButton(again).click();
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(asked('PUT /api/users/2')).toHaveLength(2);
		expect(asked('GET /api/users/2')).toHaveLength(1);
	});

	it('names in the delete’s confirmation what would go with bob’s account', async () => {
		answer = holding;
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: holdingData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(confirm.mock.calls[0][1]).toMatch(/^Delete user "bob"\? Their comments, /);
		expect(confirm.mock.calls[0][1]).toMatch(new RegExp(` Their XP stays on the leaderboard\\. What they set goes too: ${NAMED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
	});

	// The card 2397 second review: the page's data is as old as the page. Another administrator took a
	// setting over, or gave one back, since it was read; the question follows the server.
	it('asks before bob is made a user, or deleted, where the server says he holds settings the page’s data does not name', async () => {
		answer = holding;
		const confirm = vi.fn();
		const stale = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const target = draw(UsersPanel, { data: stale, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'user');

		changeButton(target).click();
		await settle();
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(asked('PUT /api/users/2')).toEqual([]);
		expect(confirm.mock.calls.map((call) => call[0])).toEqual(['Change Role', 'Delete User']);
		expect(confirm.mock.calls[0][1]).toBe(`Make bob a user? This removes what they set: ${NAMED}.`);
		expect(confirm.mock.calls[1][1]).toMatch(/ What they set goes too: the mail settings, /);
	});

	it('sends the role change at once, and names nothing in the delete’s confirmation, where the server says he no longer holds what the page’s data names', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: holdingData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm.mock.calls[0][1]).not.toContain('What they set');
		choose(target, 'user');

		changeButton(target).click();
		await settle();

		expect(confirm).toHaveBeenCalledTimes(1);
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user' }]);
	});

	it.each([
		{ how: 'refused', fails: () => Response.json({ message: 'Server error' }, { status: 500 }) },
		{ how: 'not answered', fails: () => Promise.reject(new TypeError('Failed to fetch')) }
	])('asks all the same, in general words, where the read of what bob holds is $how', async ({ fails }) => {
		answer = (what) => (what === 'GET /api/users/2' ? (fails() as Response | Promise<Response>) : undefined);
		const confirm = vi.fn();
		const plain = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const target = draw(UsersPanel, { data: plain, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'user');
		const UNREAD =
			'What they set of the mail settings, the App URL and the backup destinations could not be read just now: whatever of it is still theirs goes too.';

		changeButton(target).click();
		await settle();
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(asked('PUT /api/users/2')).toEqual([]);
		expect(confirm.mock.calls[0].slice(0, 2)).toEqual(['Change Role', `Make bob a user? ${UNREAD}`]);
		expect(confirm.mock.calls[1][1]).toMatch(/^Delete user "bob"\? Their comments, /);
		expect(confirm.mock.calls[1][1].endsWith(` ${UNREAD}`)).toBe(true);
		await confirm.mock.calls[0][2]();
		await settle();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user' }]);
	});

	it('says only that it was done, and asks nothing of the page, where the answer names nothing removed', async () => {
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true }) : undefined);
		const confirm = vi.fn();
		const settingsRemoved = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2]();
		await settle();

		expect(toastsShown()).toEqual([['success', 'User deleted']]);
		expect(settingsRemoved).not.toHaveBeenCalled();
	});
});

describe('the password dialog, mounted', () => {
	it('opens on the caller’s own account through openResetDialog, and sends their current password with the new one', async () => {
		const target = draw(ResetPasswordDialog, { data: pageData });
		expect(target.querySelector('h2')).toBeNull();

		await (drawn!.component as unknown as { openResetDialog: (userId: number) => Promise<void> }).openResetDialog(1);
		flushSync();
		expect([...target.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['🔑 Change Your Password']);
		type(target.querySelector<HTMLInputElement>('input[placeholder="Current password"]')!, 'the-old-one');
		type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
		buttonNamed(target, 'Change Password').click();
		await settle();

		expect(asked('PUT /api/account/password').map((request) => request.body)).toEqual([{ currentPassword: 'the-old-one', newPassword: 'a-new-password' }]);
	});
});

describe('the teams panel, mounted', () => {
	it('sends what is typed in Add Team, and reads the page’s data again', async () => {
		answer = (what) => (what === 'POST /api/teams' ? Response.json({ id: 8, name: 'Support', emoji: '🏢' }) : undefined);
		const target = draw(TeamsPanel, { data: pageData, confirm: vi.fn() });

		buttonNamed(target, '+ Add Team').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Team name"]')!, 'Support');
		buttonNamed(target, 'Create').click();
		await settle();

		expect(asked('POST /api/teams').map((request) => request.body)).toEqual([{ name: 'Support', emoji: '🏢' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(target.querySelector('input[placeholder="Team name"]')).toBeNull();
	});

	// Card 2309: a team's owner may rename and delete it and manage its members
	// without being an administrator, and the route takes the role; the panel
	// always sent "member".
	it('sends the role chosen beside the member picker, Member until another is chosen', async () => {
		answer = (what) => (what === 'POST /api/teams/7/members/2' ? Response.json({ success: true, action: 'added' }, { status: 201 }) : undefined);
		const target = draw(TeamsPanel, { data: pageData, confirm: vi.fn() });
		const rolePicker = () => target.querySelector<HTMLSelectElement>('select[title="Their role in this team"]');
		expect(rolePicker()).toBeNull();

		const people = target.querySelector<HTMLSelectElement>('.add-member-row select')!;
		people.value = '2';
		people.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		const role = rolePicker()!;
		expect([...role.options].map((option) => [option.value, option.textContent])).toEqual([
			['member', 'Member'],
			['owner', 'Owner']
		]);
		expect(role.value).toBe('member');
		role.value = 'owner';
		role.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		buttonNamed(target, 'Add').click();
		await settle();

		expect(asked('POST /api/teams/7/members/2').map((request) => request.body)).toEqual([{ userId: 2, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('puts the role back to Member when another person is chosen (the card 2309 review)', () => {
		const target = draw(TeamsPanel, { data: pageData, confirm: vi.fn() });
		const people = target.querySelector<HTMLSelectElement>('.add-member-row select')!;
		const choose = (box: HTMLSelectElement, value: string) => {
			box.value = value;
			box.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
		};
		const role = () => target.querySelector<HTMLSelectElement>('select[title="Their role in this team"]')!;

		choose(people, '2');
		choose(role(), 'owner');
		expect(role().value).toBe('owner');
		choose(people, '1');

		expect(role().value).toBe('member');
	});

	// Card 2355: no page changed the role of someone already in a team; the route always did.
	// Card 2376: choosing saved at once, so arrowing through a closed picker saved each role passed; Change saves now.
	it('changes a member’s role in place with Change, marking the picker busy while it is out, and shows the stored role again when it is refused (cards 2355 and 2376)', async () => {
		const withMembers = {
			...pageData,
			teams: [{ id: 7, name: 'Ops', emoji: '🏢', members: [{ userId: 2, role: 'member', username: 'bob', emoji: '🙂' }] }]
		};
		const release: (() => void)[] = [];
		let refusing = false;
		answer = (what) =>
			what === 'POST /api/teams/7/members/2'
				? new Promise<Response>((resolve) =>
						release.push(() => resolve(refusing ? Response.json({ message: 'Forbidden' }, { status: 403 }) : Response.json({ success: true, action: 'updated' })))
					)
				: undefined;
		const target = draw(TeamsPanel, { data: withMembers, confirm: vi.fn() });
		const picker = target.querySelector<HTMLSelectElement>('.team-member select')!;
		expect(picker.getAttribute('aria-label')).toBe("bob's role in this team");
		expect([...picker.options].map((option) => option.value)).toEqual(['member', 'owner']);
		expect(picker.value).toBe('member');
		const change = target.querySelector<HTMLButtonElement>('button[aria-label="Change bob\'s team role"]')!;
		expect(change.textContent).toBe('Change');
		expect(change.getAttribute('aria-disabled')).toBe('true');
		const status = () => target.querySelector('[role="status"]')!.textContent;

		// Choosing sends nothing; Change does.
		picker.value = 'owner';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(0);
		expect(change.hasAttribute('aria-disabled')).toBe(false);
		change.click();
		flushSync();
		expect(picker.getAttribute('aria-busy')).toBe('true');
		expect(change.getAttribute('aria-disabled')).toBe('true');
		expect(status()).toBe("Saving bob's role…");
		release.shift()!();
		await settle();
		expect(asked('POST /api/teams/7/members/2').map((request) => request.body)).toEqual([{ userId: 2, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(picker.hasAttribute('aria-busy')).toBe(false);
		expect(status()).toBe('');

		// Refused: the data still says member, and so does the picker.
		refusing = true;
		picker.value = 'owner';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		change.click();
		flushSync();
		release.shift()!();
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(2);
		expect(picker.value).toBe('member');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});
});

describe('the Teams page, mounted (card 2355)', () => {
	const owner = { id: 1, username: 'chief', email: 'chief@example.com', emoji: '👑', role: 'user' };
	const teamsData = (currentUser: { id: number; role: string } = owner) => ({
		currentUser,
		users: [
			{ id: 1, username: 'chief', emoji: '👑' },
			{ id: 2, username: 'bob', emoji: '🙂' },
			{ id: 3, username: 'carol', emoji: '🌷' }
		],
		teams: [
			{
				id: 7,
				name: 'Ops',
				emoji: '🏢',
				members: [
					{ userId: 1, role: 'owner', username: 'chief', emoji: '👑' },
					{ userId: 2, role: 'member', username: 'bob', emoji: '🙂' }
				]
			}
		]
	});
	const rolePicker = (target: HTMLElement, name: string) =>
		[...target.querySelectorAll<HTMLSelectElement>('.team-member-item select')].find((select) => select.getAttribute('aria-label') === `${name}'s role in this team`);
	const choose = (box: HTMLSelectElement, value: string) => {
		box.value = value;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};
	const toastsSaid = () => [...document.querySelectorAll('.toast-msg')].map((toast) => toast.textContent!.trim());

	afterEach(() => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	});

	it('sends the role chosen beside Add, Member until another is chosen and again after each add', async () => {
		answer = (what) => (what === 'POST /api/teams/7/members/3' ? Response.json({ success: true, action: 'added' }, { status: 201 }) : undefined);
		const target = draw(TeamsPage, { data: teamsData() });
		const addRole = () => target.querySelector<HTMLSelectElement>('select[title="Their role in this team"]');
		expect(addRole()).toBeNull();

		const people = target.querySelector<HTMLSelectElement>('.add-member-section select')!;
		choose(people, '3');
		expect([...addRole()!.options].map((option) => [option.value, option.textContent])).toEqual([
			['member', 'Member'],
			['owner', 'Owner']
		]);
		expect(addRole()!.value).toBe('member');
		choose(addRole()!, 'owner');
		buttonNamed(target, 'Add').click();
		await settle();

		expect(asked('POST /api/teams/7/members/3').map((request) => request.body)).toEqual([{ userId: 3, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(toastsSaid()).toContain('Member added');
		choose(people, '3');
		expect(addRole()!.value).toBe('member');
	});

	it('changes a member’s role in place with Change, says so and reads the page again; a refusal says why and shows the stored role again', async () => {
		let refusing = false;
		answer = (what) =>
			what === 'POST /api/teams/7/members/2'
				? refusing
					? Response.json({ message: 'Forbidden' }, { status: 403 })
					: Response.json({ success: true, action: 'updated' })
				: undefined;
		const target = draw(TeamsPage, { data: teamsData() });
		const picker = rolePicker(target, 'bob')!;
		const change = target.querySelector<HTMLButtonElement>('button[aria-label="Change bob\'s team role"]')!;
		expect(picker.value).toBe('member');
		// None on your own row, as there is no picker.
		expect(target.querySelector('button[aria-label="Change chief\'s team role"]')).toBeNull();

		// Card 2376: choosing sends nothing, and choosing their own role again leaves Change dimmed.
		choose(picker, 'owner');
		choose(picker, 'member');
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(0);
		expect(change.getAttribute('aria-disabled')).toBe('true');
		change.click();
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(0);

		choose(picker, 'owner');
		change.click();
		await settle();
		expect(asked('POST /api/teams/7/members/2').map((request) => request.body)).toEqual([{ userId: 2, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(toastsSaid()).toContain('Role changed');

		refusing = true;
		choose(picker, 'owner');
		change.click();
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(2);
		expect(picker.value).toBe('member');
		expect(toastsSaid()).toContain('Forbidden');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('shows the role as a badge on your own row, and to a member who does not run the team on every row', () => {
		const target = draw(TeamsPage, { data: teamsData() });
		expect(rolePicker(target, 'chief')).toBeUndefined();
		expect(rolePicker(target, 'bob')).toBeDefined();
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		const asMember = draw(TeamsPage, { data: teamsData({ id: 2, role: 'user' }) });
		expect(asMember.querySelectorAll('.team-member-item select')).toHaveLength(0);
		expect([...asMember.querySelectorAll('.member-role-badge')].map((badge) => badge.textContent)).toEqual(['owner', 'member']);
		expect(asMember.querySelector('.add-member-section')).toBeNull();
	});

	it('shows a role stored before roles were checked as itself', () => {
		const data = teamsData();
		data.teams[0].members[1].role = 'lead';
		const target = draw(TeamsPage, { data });
		const picker = rolePicker(target, 'bob')!;
		expect([...picker.options].map((option) => option.value)).toEqual(['lead', 'member', 'owner']);
		expect(picker.value).toBe('lead');
	});
});

// The card 2355 review, on both team pages: the rows were drawn without a key and a change held its
// row's picker and member from when it was sent, so a refusal could put a role on another row; one
// slot said whose change was out; the picker was turned off while out (which drops the keyboard's
// focus in a browser; jsdom keeps it, so that is argued, not shown); and a member removed meanwhile,
// whom the route adds again (201 "added"), was said as "Role changed".
describe.each([
	['the teams panel', TeamsPanel],
	['the Teams page', TeamsPage]
])('a member’s role changed in place on %s (the card 2355 review; with Change since card 2376)', (_, component) => {
	const BOB = { userId: 2, role: 'member', username: 'bob', emoji: '🙂' };
	const CAROL = { userId: 3, role: 'owner', username: 'carol', emoji: '🌷' };
	/** The page's data with team 7 holding `members`; the superadmin may manage every row on both pages. */
	const teamWith = (...members: (typeof BOB)[]) => ({
		...pageData,
		users: [...pageData.users, { id: 3, username: 'carol', email: 'carol@example.com', emoji: '🌷', role: 'user' }],
		teams: [{ id: 7, name: 'Ops', emoji: '🏢', members }]
	});
	const picker = (target: HTMLElement, name: string) => target.querySelector<HTMLSelectElement>(`select[aria-label="${name}'s role in this team"]`);
	const choose = (box: HTMLSelectElement, value: string) => {
		box.value = value;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};
	const busy = (box: HTMLSelectElement) => box.getAttribute('aria-busy');
	/** The row's Change (card 2376), which saves the role chosen. */
	const changeButton = (target: HTMLElement, name: string) => target.querySelector<HTMLButtonElement>(`button[aria-label="Change ${name}'s team role"]`)!;
	/** Chooses a role in the row's picker and presses its Change. */
	const changeTo = (target: HTMLElement, name: string, value: string) => {
		choose(picker(target, name)!, value);
		changeButton(target, name).click();
		flushSync();
	};
	const toastsSaid = () => {
		let shown: { message: string }[] = [];
		toasts.subscribe((list) => (shown = list))();
		return shown.map((toast) => toast.message);
	};
	/** Each role change, held until the case answers it. */
	let holds: Record<string, ((response: Response) => void)[]> = {};
	const holdChanges = () => {
		holds = {};
		answer = (what) => (what.startsWith('POST /api/teams/7/members/') ? new Promise<Response>((resolve) => (holds[what] ??= []).push(resolve)) : undefined);
	};
	const answerChange = (userId: number, response: Response) => holds[`POST /api/teams/7/members/${userId}`].shift()!(response);
	const refused = () => Response.json({ message: 'Forbidden' }, { status: 403 });
	const updated = () => Response.json({ success: true, action: 'updated' });

	/** Mounts it with its props in a Svelte proxy, as SvelteKit hands them: setting `data` is a re-read. */
	function drawLive(data: unknown) {
		const props = proxy({ data, confirm: vi.fn() });
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(component as never, { target, props: props as never }), target };
		flushSync();
		return { target, props };
	}

	afterEach(() => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	});

	it('says that a member removed meanwhile has been added again with the role chosen, not "Role changed"', async () => {
		answer = (what) => (what === 'POST /api/teams/7/members/2' ? Response.json({ success: true, action: 'added' }, { status: 201 }) : undefined);
		const { target } = drawLive(teamWith(BOB));
		changeTo(target, 'bob', 'owner');
		await settle();

		expect(asked('POST /api/teams/7/members/2').map((request) => request.body)).toEqual([{ userId: 2, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(toastsSaid()).toEqual(['bob was no longer in the team and has been added again as Owner']);
	});

	it('puts a refused change back on its own member’s row when the rows have moved meanwhile', async () => {
		holdChanges();
		const { target, props } = drawLive(teamWith(BOB, CAROL));
		changeTo(target, 'bob', 'owner');
		// Read again while it is out, with the rows the other way round.
		props.data = teamWith(CAROL, BOB);
		flushSync();
		answerChange(2, refused());
		await settle();

		expect(picker(target, 'carol')!.value).toBe('owner');
		expect(picker(target, 'bob')!.value).toBe('member');
	});

	it('puts back the role the page’s data gives the member when the refusal comes, not the one held when it was sent', async () => {
		holdChanges();
		const { target, props } = drawLive(teamWith(BOB, CAROL));
		changeTo(target, 'carol', 'member');
		// Read again while it is out: carol's role was made 'lead' elsewhere (a role from before roles were checked will do).
		props.data = teamWith(BOB, { ...CAROL, role: 'lead' });
		flushSync();
		answerChange(3, refused());
		await settle();

		expect(picker(target, 'carol')!.value).toBe('lead');
	});

	it('marks the picker busy while its change is out rather than turning it off, and sends no second change for that member meanwhile', async () => {
		holdChanges();
		const { target } = drawLive(teamWith(BOB));
		const bobs = picker(target, 'bob')!;
		changeTo(target, 'bob', 'owner');
		expect(bobs.disabled).toBe(false);
		expect(busy(bobs)).toBe('true');
		expect(changeButton(target, 'bob').disabled).toBe(false);
		expect(changeButton(target, 'bob').getAttribute('aria-disabled')).toBe('true');

		// Another choice goes back to the role being saved, and a second Change sends nothing.
		changeTo(target, 'bob', 'member');
		expect(bobs.value).toBe('owner');
		changeButton(target, 'bob').click();
		await settle();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(1);

		answerChange(2, updated());
		await settle();
		expect(busy(bobs)).toBeNull();
		expect(asked('POST /api/teams/7/members/2').map((request) => request.body)).toEqual([{ userId: 2, role: 'owner' }]);
	});

	// Card 2374: Add had no guard, so a double click sent the add twice and said "Member added" twice.
	it('sends one add for a double click on Add, marking Add busy rather than off while it is out (card 2374)', async () => {
		holdChanges();
		const { target } = drawLive(teamWith(BOB));
		const people = [...target.querySelectorAll('select')].find((select) => select.options[0]?.textContent === 'Add member...')!;
		choose(people, '3');
		const add = buttonNamed(target, 'Add');
		add.click();
		add.click();
		flushSync();
		expect(asked('POST /api/teams/7/members/3')).toHaveLength(1);
		expect(add.getAttribute('aria-busy')).toBe('true');
		expect(add.disabled).toBe(false);

		answerChange(3, Response.json({ success: true, action: 'added' }, { status: 201 }));
		await settle();
		expect(asked('POST /api/teams/7/members/3')).toHaveLength(1);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(toastsSaid()).toEqual(['Member added']);
	});

	// The card 2376 review: a role chosen and not saved was kept until Change or a refusal, so with Owner
	// chosen for bob, bob removed and added back as Member, his picker read Owner and Change was live.
	it('drops a role chosen and not saved once a re-read finds the member gone, or already holding it', () => {
		const { target, props } = drawLive(teamWith(BOB));
		choose(picker(target, 'bob')!, 'owner');
		expect(changeButton(target, 'bob').hasAttribute('aria-disabled')).toBe(false);

		// Removed elsewhere, then added back as Member.
		props.data = teamWith();
		flushSync();
		props.data = teamWith(BOB);
		flushSync();
		expect(picker(target, 'bob')!.value).toBe('member');
		expect(changeButton(target, 'bob').getAttribute('aria-disabled')).toBe('true');

		// Made Owner elsewhere, then Member again.
		choose(picker(target, 'bob')!, 'owner');
		props.data = teamWith({ ...BOB, role: 'owner' });
		flushSync();
		props.data = teamWith(BOB);
		flushSync();
		expect(picker(target, 'bob')!.value).toBe('member');
		expect(changeButton(target, 'bob').getAttribute('aria-disabled')).toBe('true');
		expect(sent.filter((request) => request.what.startsWith('POST'))).toEqual([]);
	});

	it('forgets a role chosen and not saved for a member it removes', async () => {
		answer = (what) => (what === 'DELETE /api/teams/7/members/2' ? Response.json({ success: true }) : undefined);
		const { target, props } = drawLive(teamWith(BOB));
		choose(picker(target, 'bob')!, 'owner');
		target.querySelector<HTMLButtonElement>('button[title="Remove from team"]')!.click();
		await settle();
		expect(asked('DELETE /api/teams/7/members/2')).toHaveLength(1);

		// Added back as Member, with no re-read between (the stand-in's invalidateAll reads nothing).
		props.data = teamWith(BOB);
		flushSync();
		expect(picker(target, 'bob')!.value).toBe('member');
		expect(changeButton(target, 'bob').getAttribute('aria-disabled')).toBe('true');
	});

	// The card 2374 review: an Add for someone already in the team (added meanwhile elsewhere) is answered
	// 200 "updated" with their role set, and both pages said "Member added".
	it('says that someone already in the team had their role set, rather than "Member added"', async () => {
		answer = (what) => (what === 'POST /api/teams/7/members/3' ? Response.json({ success: true, action: 'updated' }) : undefined);
		const { target } = drawLive(teamWith(BOB));
		const people = [...target.querySelectorAll('select')].find((select) => select.options[0]?.textContent === 'Add member...')!;
		choose(people, '3');
		choose(target.querySelector<HTMLSelectElement>('select[title="Their role in this team"]')!, 'owner');
		buttonNamed(target, 'Add').click();
		await settle();

		expect(asked('POST /api/teams/7/members/3').map((request) => request.body)).toEqual([{ userId: 3, role: 'owner' }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(toastsSaid()).toEqual(['carol was already in the team; role set to Owner']);
	});

	it('keeps each of two changes out at once busy until its own answer', async () => {
		holdChanges();
		const { target } = drawLive(teamWith(BOB, CAROL));
		changeTo(target, 'bob', 'owner');
		changeTo(target, 'carol', 'member');
		expect(busy(picker(target, 'bob')!)).toBe('true');
		expect(busy(picker(target, 'carol')!)).toBe('true');

		answerChange(2, updated());
		await settle();
		expect(busy(picker(target, 'bob')!)).toBeNull();
		expect(busy(picker(target, 'carol')!)).toBe('true');

		answerChange(3, updated());
		await settle();
		expect(busy(picker(target, 'carol')!)).toBeNull();
		expect(asked('POST /api/teams/7/members/2')).toHaveLength(1);
		expect(asked('POST /api/teams/7/members/3')).toHaveLength(1);
	});
});

// Card 2376: the admin users panel's role picker saved as it was chosen, so arrowing through it on
// Windows saved each role passed (Admin included), and a second choice was sent while the first was out.
describe('an account’s role on the users panel, saved with Change (card 2376)', () => {
	const choose = (box: HTMLSelectElement, value: string) => {
		box.value = value;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	};

	afterEach(() => {
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	});

	it('sends nothing as roles are chosen, saves once with Change, says it is saving, and shows the stored role again when refused', async () => {
		const release: ((response: Response) => void)[] = [];
		answer = (what) => (what === 'PUT /api/users/2' ? new Promise<Response>((resolve) => release.push(resolve)) : undefined);
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		const picker = target.querySelector<HTMLSelectElement>('select[aria-label="bob\'s role"]')!;
		const change = target.querySelector<HTMLButtonElement>('button[aria-label="Change bob\'s role"]')!;
		const status = () => target.querySelector('[role="status"]')!.textContent;
		expect(picker.value).toBe('user');
		expect(change.textContent!.trim()).toBe('Change');
		expect(change.getAttribute('aria-disabled')).toBe('true');
		// Not on your own row.
		expect(target.querySelector('button[aria-label="Change chief\'s role"]')).toBeNull();

		// Down, up and down again, as arrowing through a closed picker does on Windows: nothing sent.
		choose(picker, 'admin');
		choose(picker, 'user');
		choose(picker, 'admin');
		await settle();
		expect(asked('PUT /api/users/2')).toHaveLength(0);
		expect(change.hasAttribute('aria-disabled')).toBe(false);

		// Change twice while the first is out: one request.
		change.click();
		change.click();
		flushSync();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'admin' }]);
		expect(picker.getAttribute('aria-busy')).toBe('true');
		expect(change.getAttribute('aria-disabled')).toBe('true');
		expect(status()).toBe("Saving bob's role…");
		release.shift()!(Response.json({ success: true, invitesEnded: 0 }));
		await settle();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(picker.hasAttribute('aria-busy')).toBe(false);
		expect(status()).toBe('');

		// Refused: the data still says user, and so does the picker.
		choose(picker, 'admin');
		change.click();
		flushSync();
		release.shift()!(Response.json({ message: 'Only the superadmin can make an administrator' }, { status: 403 }));
		await settle();
		expect(asked('PUT /api/users/2')).toHaveLength(2);
		expect(picker.value).toBe('user');
		expect(change.getAttribute('aria-disabled')).toBe('true');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	/** Mounts the panel with its props in a Svelte proxy, as the page hands them on: setting `data` is a re-read. */
	function drawLive(data: unknown) {
		const props = proxy({ data, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn = { component: mount(UsersPanel as never, { target, props: props as never }), target };
		flushSync();
		return { target, props };
	}
	const rolePicker = (target: HTMLElement) => target.querySelector<HTMLSelectElement>('select[aria-label="bob\'s role"]');
	const changeButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('button[aria-label="Change bob\'s role"]')!;

	// The card 2376 review: a role chosen and not saved outlived the account's row, as on the team pages.
	it('drops a role chosen and not saved once a re-read finds the account gone, or already holding it, and once the panel deletes it', async () => {
		const { target, props } = drawLive(pageData);
		choose(rolePicker(target)!, 'admin');
		props.data = { ...pageData, users: [pageData.users[0]] };
		flushSync();
		props.data = pageData;
		flushSync();
		expect(rolePicker(target)!.value).toBe('user');
		expect(changeButton(target).getAttribute('aria-disabled')).toBe('true');

		choose(rolePicker(target)!, 'admin');
		props.data = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin' }] };
		flushSync();
		props.data = pageData;
		flushSync();
		expect(rolePicker(target)!.value).toBe('user');
		expect(changeButton(target).getAttribute('aria-disabled')).toBe('true');

		// Deleted here, and the same id read again with no re-read between (the stand-in's invalidateAll reads nothing).
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true }) : undefined);
		choose(rolePicker(target)!, 'admin');
		const confirm = props.confirm as unknown as ReturnType<typeof vi.fn>;
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2]();
		await settle();
		expect(asked('DELETE /api/users/2')).toHaveLength(1);
		props.data = { ...pageData };
		flushSync();
		expect(rolePicker(target)!.value).toBe('user');
		expect(asked('PUT /api/users/2')).toHaveLength(0);
	});

	// The card 2376 review: an administrator who is not the superadmin may give only User, so the picker had
	// one option and every row a Change that could never do anything. The role is the badge alone for them.
	it('draws no role picker and no Change for an administrator who is not the superadmin, whose only choice is User', () => {
		const ada = { id: 3, username: 'ada', email: 'ada@example.com', emoji: '🛠️', role: 'admin' };
		const target = draw(UsersPanel, {
			data: { ...pageData, currentUser: ada, users: [...pageData.users, { ...ada, apiKeys: null, webhooks: null, reportSchedules: null }] },
			isSuperadmin: false,
			confirm: vi.fn(),
			loadMailStatus: vi.fn(),
			inviteLink: null
		});
		const bobsRow = [...target.querySelectorAll('.user-row')].find((row) => row.textContent!.includes('bob@example.com'))!;
		expect(bobsRow.querySelector('select')).toBeNull();
		expect(bobsRow.querySelector('button[aria-label="Change bob\'s role"]')).toBeNull();
		expect(bobsRow.querySelector('.role-badge')!.textContent).toBe('user');
		// What they may do to bob's account is still there.
		expect(bobsRow.querySelector('button[title="Reset password"]')).not.toBeNull();
		expect(bobsRow.querySelector('button[title="Delete user"]')).not.toBeNull();
		expect(target.querySelector('[role="status"]')).not.toBeNull();
	});
});

describe('the mail panel, mounted', () => {
	const mail = { configured: true, host: 'smtp.example.com', port: 587, user: 'mailer', pass: '••••••••', fromAddress: 'kanban@example.com', fromName: 'DumpFire', mailStatus: null };

	it('reads the mail settings once as it opens, sends Send Test to the signed-in account’s address, and reads the record again through its export', async () => {
		answer = (what) =>
			what === 'GET /api/admin/smtp' ? Response.json(mail) : what === 'POST /api/admin/smtp' ? Response.json({ message: 'Test email sent!' }) : undefined;
		const target = draw(SmtpPanel, { currentUser: chief });
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp']);
		expect(target.querySelector<HTMLInputElement>('input[placeholder="SMTP Host"]')!.value).toBe('smtp.example.com');

		buttonNamed(target, '🧪 Send Test').click();
		await settle();
		expect(asked('POST /api/admin/smtp').map((request) => request.body)).toEqual([{ to: 'chief@example.com' }]);
		// Send Test reads the record again itself: two reads so far.
		expect(asked('GET /api/admin/smtp')).toHaveLength(2);

		// And the page reaches the same read through the panel, for the users panel.
		await (drawn!.component as unknown as { loadMailStatus: () => Promise<void> }).loadMailStatus();
		expect(asked('GET /api/admin/smtp')).toHaveLength(3);
	});

	// Card 2308: the timer that clears a success line is kept, so the panel
	// going clears it, and so does the next Save or Send Test, whose own line
	// an earlier timer cleared early.
	/** The timer each `setTimeout` of `ms` gave, in the order they were set. */
	const timersOf = (timeouts: { mock: { calls: unknown[][]; results: { value: unknown }[] } }, ms: number) =>
		timeouts.mock.calls.flatMap((call, i) => (call[1] === ms ? [timeouts.mock.results[i].value] : []));
	const answered = (what: string) =>
		what === 'GET /api/admin/smtp' ? Response.json(mail) : what === 'PUT /api/admin/smtp' || what === 'POST /api/admin/smtp' ? Response.json({ message: 'Test email sent!' }) : undefined;

	it.each([
		['Save SMTP', 5000],
		['🧪 Send Test', 8000]
	])('clears the timer of %s’s success line when the panel goes', async (button, ms) => {
		answer = answered;
		const timeouts = vi.spyOn(globalThis, 'setTimeout');
		const cleared = vi.spyOn(globalThis, 'clearTimeout');
		onTestFinished(() => {
			timeouts.mockRestore();
			cleared.mockRestore();
		});
		const target = draw(SmtpPanel, { currentUser: chief });
		await settle();

		buttonNamed(target, button).click();
		await settle();
		expect(target.querySelector('.smtp-success')).not.toBeNull();
		const timers = timersOf(timeouts, ms);
		expect(timers).toHaveLength(1);

		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		expect(cleared).toHaveBeenCalledWith(timers[0]);
	});

	it('starts no timer for a Send Test answered after the panel has gone (the card 2308 review)', async () => {
		const post = held(() => Response.json({ message: 'Test email sent!' }));
		answer = (what) => (what === 'POST /api/admin/smtp' ? post.answered : answered(what));
		const timeouts = vi.spyOn(globalThis, 'setTimeout');
		onTestFinished(() => timeouts.mockRestore());
		const target = draw(SmtpPanel, { currentUser: chief });
		await settle();

		buttonNamed(target, '🧪 Send Test').click();
		await settle();
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
		post.release();
		await settle();

		expect(asked('POST /api/admin/smtp')).toHaveLength(1);
		expect(timersOf(timeouts, 8000)).toEqual([]);
	});

	it('clears an earlier success line’s timer when Send Test starts, so it cannot clear the new line early', async () => {
		answer = answered;
		const timeouts = vi.spyOn(globalThis, 'setTimeout');
		const cleared = vi.spyOn(globalThis, 'clearTimeout');
		onTestFinished(() => {
			timeouts.mockRestore();
			cleared.mockRestore();
		});
		const target = draw(SmtpPanel, { currentUser: chief });
		await settle();

		buttonNamed(target, 'Save SMTP').click();
		await settle();
		const saved = timersOf(timeouts, 5000);
		expect(saved).toHaveLength(1);
		expect(cleared).not.toHaveBeenCalledWith(saved[0]);

		buttonNamed(target, '🧪 Send Test').click();
		await settle();

		expect(cleared).toHaveBeenCalledWith(saved[0]);
		expect(timersOf(timeouts, 8000)).toHaveLength(1);
	});
});

describe('the danger zone, mounted', () => {
	it('shows Reset Everything to the superadmin alone', () => {
		const target = draw(DangerZonePanel, { isSuperadmin: false, confirm: vi.fn(), resetNotice: null });

		expect(target.textContent).toContain('Purge Archived Cards');
		expect(target.textContent).not.toContain('Reset Everything');
	});

	it('asks the page’s confirm before a reset, and hands a refused reset’s notice back to the page', async () => {
		answer = (what) =>
			what === 'POST /api/admin/reset' ? Response.json({ message: 'The reset failed and nothing was cleared: disk full' }, { status: 500 }) : undefined;
		const notice = { value: null as unknown };
		const confirm = vi.fn();
		const target = draw(DangerZonePanel, bound({ isSuperadmin: true, confirm }, 'resetNotice', notice));

		buttonNamed(target, 'Reset Everything').click();
		expect(confirm.mock.calls.map((call) => call[0])).toEqual(['Reset Everything']);
		await confirm.mock.calls[0][2]();
		await settle();

		expect(asked('POST /api/admin/reset')).toHaveLength(1);
		expect(notice.value).toEqual({ title: 'Reset failed', message: 'The reset failed and nothing was cleared: disk full', problems: [], redirect: null });
	});
});

// ─── The page itself, with its panels (card 2281, slice C1b's review) ────────

describe('the admin page, mounted with its panels', () => {
	/** The page's data for the superadmin, or for an administrator who is not. */
	const asSuperadmin = { ...pageData, importOutsideDefault: 'keep' };
	const admin = { id: 3, username: 'ada', email: 'ada@example.com', emoji: '🛠️', role: 'admin' };
	const asAdministrator = {
		...asSuperadmin,
		currentUser: admin,
		users: [...asSuperadmin.users, { ...admin, apiKeys: null, webhooks: null, reportSchedules: null }]
	};
	const mailReads = () => asked('GET /api/admin/smtp').length;
	const headings = (target: HTMLElement) => [...target.querySelectorAll('h2')].map((heading) => heading.textContent);
	const inviteButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!;

	it('reads the mail panel again through the page once 📧 is answered, for the superadmin', async () => {
		answer = (what) => (what === 'POST /api/users/2/invite' ? Response.json({ mailSent: true, message: 'Invite sent to bob@example.com' }) : undefined);
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		expect(headings(target)).toContain('📧 Email / SMTP');
		// The App URL panel's read and the mail panel's.
		expect(mailReads()).toBe(2);

		inviteButton(target).click();
		await settle();

		expect(asked('POST /api/users/2/invite')).toHaveLength(1);
		// The users panel's loadMailStatus is the mail panel's, reached by the page through bind:this.
		expect(mailReads()).toBe(3);
	});

	it('opens the invite link’s dialog from the users panel through the page, and Done clears it there too', async () => {
		answer = (what) =>
			what === 'POST /api/users/2/invite'
				? Response.json({ mailSent: false, message: 'The invite mail could not be sent.', inviteUrl: 'http://localhost/invite/t2' })
				: undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();

		inviteButton(target).click();
		await settle();
		expect(headings(target)).toContain('📧 The invite mail was not sent');
		expect(target.querySelector('code')!.textContent).toBe('http://localhost/invite/t2');
		// While it is open every 📧 waits.
		expect(inviteButton(target).disabled).toBe(true);

		buttonNamed(target, 'Done').click();
		flushSync();
		expect(headings(target)).not.toContain('📧 The invite mail was not sent');
		// The page's link is cleared, so the users panel lets 📧 be pressed again.
		expect(inviteButton(target).disabled).toBe(false);
	});

	it('shows a refused reset’s notice, which the danger zone hands to the page', async () => {
		answer = (what) =>
			what === 'POST /api/admin/reset' ? Response.json({ message: 'The reset failed and nothing was cleared: disk full' }, { status: 500 }) : undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();

		buttonNamed(target, 'Reset Everything').click();
		flushSync();
		buttonNamed(target, 'Confirm').click();
		await settle();

		expect(asked('POST /api/admin/reset')).toHaveLength(1);
		const notice = target.querySelector('[role="alertdialog"][aria-label="Reset failed"]');
		expect(notice).not.toBeNull();
		expect(notice!.textContent).toContain('The reset failed and nothing was cleared: disk full');
		buttonNamed(target, 'Close').click();
		flushSync();
		expect(target.querySelector('[role="alertdialog"]')).toBeNull();
	});

	// Card 2365: the invite link's dialog let Tab walk the page behind it.
	it('keeps Tab in the invite link’s dialog, Copy first, and closes it on Done alone, never on Escape (card 2365)', async () => {
		answer = (what) =>
			what === 'POST /api/users/2/invite'
				? Response.json({ mailSent: false, message: 'The invite mail could not be sent.', inviteUrl: 'http://localhost/invite/t2' })
				: undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		inviteButton(target).click();
		await settle();

		const dialog = document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="The invite mail was not sent"]')!;
		const copy = buttonNamed(dialog, '📋 Copy');
		const done = buttonNamed(dialog, 'Done');
		expect(document.activeElement).toBe(copy);
		done.focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(copy);
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(done);
		// From the page behind, back to Copy.
		buttonNamed(target, 'Vacuum').focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(copy);

		escape();
		expect(headings(target)).toContain('📧 The invite mail was not sent');
		done.click();
		flushSync();
		expect(headings(target)).not.toContain('📧 The invite mail was not sent');
	});

	// Card 2365's review: the dialog opens once its answer comes, by when the pressed Create is gone and
	// 📧 is off, so the focus it gave back after Done was nothing's. jsdom keeps the focus on a button turned
	// off, so the 📧 half passes without the change too: argued, not shown, for 📧; shown for Create.
	it('gives the focus back after the invite link’s Done to + Add User for Create, and to the row’s 📧 for 📧 (card 2365’s review)', async () => {
		answer = (what) =>
			what === 'POST /api/users'
				? Response.json({ username: 'carol', mailSent: false, mailProblem: 'no mail server', inviteUrl: 'http://localhost/invite/t1' })
				: what === 'POST /api/users/2/invite'
					? Response.json({ mailSent: false, message: 'The invite mail could not be sent.', inviteUrl: 'http://localhost/invite/t2' })
					: undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="The invite mail was not sent"]');

		const addUser = buttonNamed(target, '+ Add User');
		addUser.focus();
		addUser.click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!, 'carol');
		type(target.querySelector<HTMLInputElement>('input[placeholder="Email"]')!, 'carol@example.com');
		const create = buttonNamed(target, 'Create');
		create.focus();
		create.click();
		await settle();
		expect(document.activeElement).toBe(buttonNamed(dialog()!, '📋 Copy'));
		buttonNamed(dialog()!, 'Done').click();
		flushSync();
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(addUser);

		const mail = inviteButton(target);
		mail.focus();
		mail.click();
		await settle();
		expect(document.activeElement).toBe(buttonNamed(dialog()!, '📋 Copy'));
		buttonNamed(dialog()!, 'Done').click();
		flushSync();
		await settle();
		expect(document.activeElement).toBe(mail);
	});

	// Card 2365: the reset's notice took no focus, and Tab walked the page behind it.
	it('gives a refused reset’s notice’s Close the focus, keeps Tab on it, and closes it on Escape (card 2365)', async () => {
		answer = (what) =>
			what === 'POST /api/admin/reset' ? Response.json({ message: 'The reset failed and nothing was cleared: disk full' }, { status: 500 }) : undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		buttonNamed(target, 'Reset Everything').click();
		flushSync();
		buttonNamed(document.querySelector<HTMLElement>('.confirm-modal')!, 'Confirm').click();
		await settle();

		const notice = document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="Reset failed"]')!;
		const close = buttonNamed(notice, 'Close');
		expect(document.activeElement).toBe(close);
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(close);
		buttonNamed(target, 'Vacuum').focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(close);

		escape();
		expect(document.querySelector('[role="alertdialog"]')).toBeNull();
	});

	it('gives a done reset’s notice’s Continue to set-up the focus, and does not close it on Escape (card 2365)', async () => {
		answer = (what) =>
			what === 'POST /api/admin/reset' ? Response.json({ redirect: '/setup', trash: { failed: ['uploads/1/a.txt'] } }) : undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		buttonNamed(target, 'Reset Everything').click();
		flushSync();
		buttonNamed(document.querySelector<HTMLElement>('.confirm-modal')!, 'Confirm').click();
		await settle();

		const notice = document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="Reset done"]')!;
		expect(document.activeElement).toBe(buttonNamed(notice, 'Continue to set-up'));
		escape();
		expect(document.querySelector('[role="alertdialog"][aria-label="Reset done"]')).not.toBeNull();
	});

	// Card 2362: the page's confirm was its own, with no focus and no Escape.
	it('asks with the app’s confirm dialog: Cancel has the focus, the warning is tied to it, and Escape closes it running nothing and gives the focus back (card 2362)', async () => {
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		const opener = buttonNamed(target, 'Vacuum');
		opener.focus();
		opener.click();
		flushSync();

		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('h3')?.textContent).toBe('Vacuum Database');
		expect(document.activeElement).toBe(buttonNamed(dialog, 'Cancel'));
		const described = document.getElementById(document.querySelector('[role="dialog"][aria-label="Vacuum Database"]')!.getAttribute('aria-describedby')!);
		expect(described!.textContent).toBe('This rebuilds the database file to reclaim unused space. No data is changed, and ids are not reset.');
		expect(buttonNamed(dialog, 'Confirm')).toBeDefined();

		escape();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		await settle();
		expect(document.activeElement).toBe(opener);
		expect(sent.filter((request) => request.what.includes('vacuum'))).toEqual([]);
	});

	// Card 2395: the mail settings, the App URL and the scheduled backups are every administrator's; the
	// export, the import and Reset Everything stay the superadmin's.
	it('shows an administrator who is not the superadmin the mail, App URL and Scheduled Backups panels, reading each, and no Backup & Restore and no Reset Everything (card 2395)', async () => {
		const target = draw(AdminPage, { data: asAdministrator });
		await settle();

		expect(headings(target)).toContain('📧 Email / SMTP');
		expect(headings(target)).toContain('🌐 Application Settings');
		expect(headings(target)).toContain('☁️ Scheduled Backups');
		expect(headings(target)).not.toContain('💾 Backup & Restore');
		expect(target.textContent).not.toContain('Export Backup');
		expect(target.textContent).not.toContain('Reset Everything');
		expect(headings(target)).toContain("🔒 The superadmin's");
		expect(target.textContent).toContain('Exporting, importing and resetting the database belong to the superadmin, chief, and are on this page for that account only.');
		expect(headings(target)).toContain('👥 User Management');
		// The App URL panel's read and the mail panel's; the backup panel's.
		expect(mailReads()).toBe(2);
		expect(asked('GET /api/admin/backup')).toHaveLength(1);
		expect(asked('GET /api/admin/export')).toHaveLength(0);
	});

	it('reads the mail panel again once 📧 is answered for an administrator too, and its dialog points them to Email / SMTP (card 2395)', async () => {
		answer = (what) =>
			what === 'POST /api/users/2/invite'
				? Response.json({ mailSent: false, message: 'The invite mail could not be sent.', inviteUrl: 'http://localhost/invite/t2' })
				: undefined;
		const target = draw(AdminPage, { data: asAdministrator });
		await settle();
		expect(mailReads()).toBe(2);

		inviteButton(target).click();
		await settle();

		expect(asked('POST /api/users/2/invite')).toHaveLength(1);
		expect(mailReads()).toBe(3);
		const dialog = document.querySelector<HTMLElement>('[role="alertdialog"][aria-label="The invite mail was not sent"]')!;
		expect(dialog.textContent).toContain('Why it failed is under Email / SMTP below.');
		expect(dialog.textContent).not.toContain('The superadmin can see why');
	});

	// Card 2398: the page tells the backup panel who is reading it.
	it('shows an administrator the superadmin’s rule in Scheduled Backups, with 🗑️ aria-disabled, and the superadmin neither (card 2398)', async () => {
		const target = draw(AdminPage, { data: asAdministrator });
		await settle();
		expect(target.querySelector('.sched-note')!.textContent).toContain('needs the superadmin');
		expect(target.querySelector('.dest-card button.danger')!.getAttribute('aria-disabled')).toBe('true');
		unmount(drawn!.component);
		drawn!.target.remove();

		const chief = draw(AdminPage, { data: asSuperadmin });
		await settle();
		expect(chief.querySelector('.sched-note')).toBeNull();
		expect(chief.querySelector('.dest-card button.danger')!.hasAttribute('aria-disabled')).toBe(false);
	});

	// Card 2397: settings removed with an account are read again by the panels that show them, and
	// (its review) only by those: a panel whose settings did not change keeps what is open in it.
	it.each([
		{ went: 'the mail settings', removed: { mail: true, appUrl: false, destinations: [] }, mail: 4, backup: 1 },
		{ went: 'the App URL', removed: { mail: false, appUrl: true, destinations: [] }, mail: 4, backup: 1 },
		{ went: 'a destination', removed: { mail: false, appUrl: false, destinations: ['NAS'] }, mail: 2, backup: 2 },
		{ went: 'all three', removed: { mail: true, appUrl: true, destinations: ['NAS'] }, mail: 4, backup: 2 }
	])('draws again only the panels that show what a delete removed: $went (card 2397)', async ({ removed, mail, backup }) => {
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true, settingsRemoved: removed }) : undefined);
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		expect(mailReads()).toBe(2);
		expect(asked('GET /api/admin/backup')).toHaveLength(1);

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		buttonNamed(document.body, 'Confirm').click();
		await settle();

		expect(asked('DELETE /api/users/2')).toHaveLength(1);
		expect(mailReads()).toBe(mail);
		expect(asked('GET /api/admin/backup')).toHaveLength(backup);
		// Said as a warning, politely, and kept until closed (the review): through the toast's region that
		// is always on the page, not as an alert, and not by the toast itself as well (the second review).
		const warning = document.querySelector<HTMLElement>('.toast-warning')!;
		expect(warning.hasAttribute('role')).toBe(false);
		expect(warning.querySelector('.toast-icon')!.textContent!.trim()).toBe('⚠️');
		const said = document.querySelector<HTMLElement>('.toast-said')!;
		expect(said.getAttribute('role')).toBe('status');
		const words = warning.querySelector('.toast-msg')!.textContent!;
		await sayingTime();
		expect(said.textContent).toBe(words);
		// A warning that goes by itself, as the board's WIP-limit one does, is still an alert (the second review),
		// and the region is not said again for it.
		toasts.add('Over the WIP limit', 'warning');
		flushSync();
		const passing = [...document.querySelectorAll<HTMLElement>('.toast-warning')].find((t) => t.textContent!.includes('Over the WIP limit'))!;
		expect(passing.getAttribute('role')).toBe('alert');
		expect(said.textContent).toBe(words);
		// The same staying warning again: the region empties, then says it again (the third review).
		toasts.add(words, 'warning', undefined, true);
		flushSync();
		expect(said.textContent).toBe('');
		await sayingTime();
		expect(said.textContent).toBe(words);
		let shown: { id: number }[] = [];
		toasts.subscribe((list) => (shown = list))();
		for (const toast of shown) toasts.dismiss(toast.id);
	});
});
