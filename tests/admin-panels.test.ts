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
import InviteLinkDialog from '$lib/components/admin/InviteLinkDialog.svelte';
import TeamsPanel from '$lib/components/admin/TeamsPanel.svelte';
import SmtpPanel from '$lib/components/admin/SmtpPanel.svelte';
import DangerZonePanel from '$lib/components/admin/DangerZonePanel.svelte';
// Card 2922: the settings held for review, and the superadmin's banner.
import SettingsHeldPanel from '$lib/components/admin/SettingsHeldPanel.svelte';
import SettingsHeldBanner from '$lib/components/SettingsHeldBanner.svelte';

import AdminPage from '../src/routes/admin/+page.svelte';
import AdminOverview from '$lib/components/admin/AdminOverview.svelte';
import BackupRestorePanel from '$lib/components/admin/BackupRestorePanel.svelte';
import FromAccountsDialog from '$lib/components/admin/people/FromAccountsDialog.svelte';
import PersonDialog from '$lib/components/admin/people/PersonDialog.svelte';
import ArchivedPage from '../src/routes/archived/+page.svelte';
import ArchivePanel from '$lib/components/board/ArchivePanel.svelte';
import TeamsPage from '../src/routes/teams/+page.svelte';
import { toasts } from '$lib/stores/toast';
import Toast from '$lib/components/Toast.svelte';
import { ASKS_FOR_PASSWORD, CONFIRMATION_HEADER, STEP_UP_CODE_SPENT, STEP_UP_MISSING, STEP_UP_SIGNED_OUT, STEP_UP_WRONG, type StepUpProof } from '$lib/step-up-words';
import { CODE, codeFieldIn, proofOf } from './helpers/step-up-code';
import { purgeDescription, purgeWarning, readableWebhooksWords, resetWarning, userEnableWarning } from '$lib/api';
// Card 3064 (S4: U3, U5): the Two-step sign-in panel.
import TwoStepSwitchPanel from '$lib/components/admin/TwoStepSwitchPanel.svelte';

/**
 * What the confirmation of making an administrator a user says of the webhooks whose secret it could read (card
 * 2935, P2), word for word as UsersPanel.svelte says it.
 */
const DEMOTION_HOLDS =
	"As an administrator they could read every webhook's secret: every webhook that has a secret, other than on the boards they own and those they set up, is switched off, unless the server can show they never had access to them (they never signed in, never held a key and were made after two-step sign-in came in), and can be switched on again only with a new secret; the boards' owners are mailed. Their API keys and sessions are as for any change of role.";

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
// The page's data, as the layout's load gives it (card 3064, R7): empty unless a case says, so that a code is asked
// beside the password, as for an account that holds a factor.
const pageStub = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock('$app/state', () => ({ page: pageStub }));
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
	pageStub.data = {};
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

/** Types `CODE` into the code field beside the password within `within` (card 2770). */
const typeCode = (within: ParentNode) => type(codeFieldIn(within)!, CODE);

const asked = (what: string) => sent.filter((request) => request.what === what);
const lastPut = () => asked('PUT /api/admin/backup').at(-1)?.body as { destinations: Record<string, unknown>[]; currentPassword?: string };

/** The caller's own password, as typed in a confirm that asks for it (card 2701). */
const MINE = 'my-own-password';

/**
 * The page's confirm, its Confirm pressed at once with the caller's password
 * and a code typed in it (cards 2701, 2770), for a case about what the action then does (card 2701). What
 * each asked is kept, as `vi.fn` keeps it.
 */
const confirmedAtOnce = () =>
	vi.fn((_title: string, _message: string, action: (proof: StepUpProof) => unknown, _options?: { askPassword?: boolean }) => {
		void action(proofOf(MINE));
	});

describe('the Scheduled Backups panel, mounted', () => {
	it('reads the backup settings once as it opens', async () => {
		draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/backup']);
		expect(document.body.textContent).toContain('NAS');
	});

	it('sends what is typed in the inline edit form, bound through the form to the panel', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
		await settle();

		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		const form = target.querySelector('.dest-edit-form')!;
		type(form.querySelector<HTMLInputElement>('input[placeholder="Host"]')!, 'nas2.example');
		buttonNamed(form, 'Save').click();
		await settle();

		expect(lastPut().destinations[0]).toMatchObject({ type: 'sftp', name: 'NAS', host: 'nas2.example', hostKey: 'ssh-ed25519 SHA256:abc' });
		// Card 2701: a change of where backups go asks for the caller's password, and sends it.
		expect(lastPut().currentPassword).toBe(MINE);
		// Saved: the form is closed.
		expect(target.querySelector('.dest-edit-form')).toBeNull();
	});

	it('sends what is typed in the Add Destination form, bound through the form to the panel', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		expect(lastPut().currentPassword).toBe(MINE);
		expect(target.querySelector('.dest-add-form')).toBeNull();
	});

	// Card 2305: the two forms share one set of fields, so only one is open at a
	// time. With both open, a name typed in the add form let the edit form's
	// Save replace the destination being edited with the new one.
	it('closes the edit form when + Add Destination opens the add form, and leaves the destination edited as it was saved', async () => {
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
		await settle();
		expect(target.querySelector('.sched-keep-note')!.textContent).toBe(KEEP);

		buttonNamed(target, '▶ Run Now').click();
		await settle();
		expect(asked('POST /api/admin/backup')).toHaveLength(1);
		expect(toastsShown()).toEqual([`Backup completed to 1 destination. ${KEEP}`]);

		unmount(drawn!.component);
		drawn!.target.remove();
		const chief = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: true });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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

	it('says in a toast a schedule-only save refused for the password, which it never sent: never silent (card 2701, F6)', async () => {
		answer = (what) =>
			what === 'PUT /api/admin/backup'
				? Response.json({ message: STEP_UP_MISSING, stepUp: 'missing' }, { status: 400 })
				: undefined;
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
		await settle();

		changeTo(schedule(target), 'weekly');
		await settle();

		expect(asked('PUT /api/admin/backup').map((request) => request.body)).toEqual([expect.not.objectContaining({ currentPassword: expect.anything() })]);
		expect(toastsShown()).toEqual([expect.stringContaining(STEP_UP_MISSING)]);
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

	// Card 2701, case 31 (decision 17): the destinations go, and the password is
	// asked for, only when the list differs from the one read.
	it('sends the destinations, and asks for the password, only when the list changed: a save of the schedule alone sends neither (card 2701)', async () => {
		dismissAll();
		const confirm = confirmedAtOnce();
		const target = draw(ScheduledBackupsPanel, { confirm, isSuperadmin: true });
		await settle();

		changeTo(schedule(target), 'weekly');
		await settle();
		expect(confirm).not.toHaveBeenCalled();
		expect(lastPut()).not.toHaveProperty('destinations');
		expect(lastPut()).not.toHaveProperty('currentPassword');
		expect((lastPut() as unknown as { schedule: string }).schedule).toBe('weekly');

		remove(target).click();
		await settle();
		expect(confirm.mock.calls.map((call) => call[0])).toEqual(['Remove Destination']);
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		expect(lastPut().destinations.map((destination) => destination.name)).toEqual(['Drive']);
		expect(lastPut().currentPassword).toBe(MINE);

		// The list saved is the one compared with now: a save of the schedule after it asks nothing again.
		changeTo(schedule(target), 'daily');
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(lastPut()).not.toHaveProperty('destinations');
		expect(lastPut()).not.toHaveProperty('currentPassword');
	});

	it('gives a refusal of the password back to the confirm, the list put back with no toast and no read, and Run Now asks and sends it too (card 2701)', async () => {
		dismissAll();
		answer = (what) =>
			what === 'PUT /api/admin/backup' || what === 'POST /api/admin/backup'
				? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
				: undefined;
		const confirm = vi.fn();
		const target = draw(ScheduledBackupsPanel, { confirm, isSuperadmin: true });
		await settle();

		remove(target).click();
		expect(await confirm.mock.calls[0][2](proofOf('a-wrong-one'))).toBe('Password is incorrect. Nothing was changed.');
		await settle();
		expect(lastPut()).toMatchObject({ currentPassword: 'a-wrong-one', currentCode: CODE });
		// Put back as it was, with no read and no toast: the dialog says it.
		expect([...target.querySelectorAll('.dest-card')]).toHaveLength(2);
		expect(asked('GET /api/admin/backup')).toHaveLength(1);
		expect(toastsShown()).toEqual([]);

		buttonNamed(target, '▶ Run Now').click();
		expect(confirm.mock.calls[1][0]).toBe('Run Backup Now');
		expect(confirm.mock.calls[1][3]).toEqual({ askPassword: true });
		expect(await confirm.mock.calls[1][2](proofOf('a-wrong-one'))).toBe('Password is incorrect. Nothing was changed.');
		expect(asked('POST /api/admin/backup').map((request) => request.body)).toEqual([{ currentPassword: 'a-wrong-one', currentCode: CODE }]);
		expect(toastsShown()).toEqual([]);
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: true });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: true });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: true });
		await settle();

		changeTo(keepLast(target), '9');
		await settle();

		expect(toastsShown()).toEqual(['Forbidden. The page could not read the settings back: reload it before changing them again.']);
	});

	// The card 2398 review: a rename is the old destination removed, said under the name before it is tried.
	it('says under the edit form’s name, to an administrator alone, that renaming needs the superadmin', async () => {
		const hint = 'Renaming needs the superadmin: a destination renamed is the old one removed.';
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: false });
		await settle();
		buttonNamed(target.querySelector('.dest-card')!, '✏️ Edit').click();
		flushSync();
		expect(target.querySelector('.dest-edit-form .dest-name-hint')!.textContent!.trim()).toBe(hint);
		unmount(drawn!.component);
		drawn!.target.remove();

		const chief = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce(), isSuperadmin: true });
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
		const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
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
	/** The init `fetch` was given for the first request to an address that begins `start`. */
	const initFor = (start: string) =>
		(vi.mocked(fetch).mock.calls as unknown as [string, RequestInit | undefined][]).find(([url]) => url.startsWith(start))?.[1];

	/** A backup picked in the hidden file box, as the browser's picker hands it over. */
	function pick(target: HTMLElement, name = 'backup.db') {
		const box = target.querySelector<HTMLInputElement>('.hidden-input')!;
		const file = new File([new Uint8Array([83, 81, 76])], name);
		Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([83, 81, 76]).buffer });
		Object.defineProperty(box, 'files', { value: [file], configurable: true });
		box.dispatchEvent(new Event('change', { bubbles: true }));
	}

	it('gives Cancel the focus, keeps Tab on its own stops, closes on Escape sending nothing, and gives the focus back to Import', async () => {
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		const opener = target.querySelector<HTMLButtonElement>('.btn-backup.import')!;
		const picker = vi.spyOn(target.querySelector<HTMLInputElement>('.hidden-input')!, 'click');
		opener.focus();
		// The picker first, from the press itself (card 2701's code review, F1); the dialog once a backup is chosen.
		opener.click();
		flushSync();
		expect(picker).toHaveBeenCalledTimes(1);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		pick(target);
		await settle();

		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const cancel = buttonNamed(dialog, 'Cancel');
		const confirmButton = buttonNamed(dialog, 'Confirm');
		const chosen = dialog.querySelector<HTMLInputElement>('input[type="radio"]:checked')!;
		expect(chosen.value).toBe('keep');
		expect(document.activeElement).toBe(cancel);
		// Card 2701: Confirm waits for the caller's password, and is a stop once it is typed.
		expect(confirmButton.disabled).toBe(true);
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(dialog);
		expect(confirmButton.disabled).toBe(false);
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
		// Nothing was sent, and the file chosen went with the dialog: the next press starts with the picker again.
		expect(sent).toEqual([]);
		expect(picker).toHaveBeenCalledTimes(1);
	});

	// Card 2701, case 29 (decision 8), as its code review's F1 ruled it: the
	// backup is chosen first and checked here; the password then goes alone to
	// the confirm; and the upload goes, with the confirmation it answered, only
	// once the password has been accepted.
	it('picks the backup first, then sends the typed password to the confirm, and only then the upload with the confirmation in its header (card 2701)', async () => {
		answer = (what) =>
			what === 'POST /api/admin/import/confirm'
				? Response.json({ confirmation: 'the-confirmation', expiresInSeconds: 60 })
				: what === 'POST /api/admin/import?outside=keep'
					? Response.json({ restored: { boards: 2 }, sizeBytes: 4096 })
					: undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		const picker = vi.spyOn(target.querySelector<HTMLInputElement>('.hidden-input')!, 'click');
		target.querySelector<HTMLButtonElement>('.btn-backup.import')!.click();
		flushSync();
		expect(picker).toHaveBeenCalledTimes(1);
		pick(target, 'monday.db');
		await settle();

		// Chosen and read here, and named in the dialog: nothing sent yet.
		expect(sent).toEqual([]);
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('.import-file')?.textContent).toBe('Backup chosen: monday.db');
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(field.getAttribute('autocomplete')).toBe('current-password');
		expect(dialog.querySelector(`label[for="${field.id}"]`)?.textContent).toBe('Your password');
		type(field, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();

		// The confirm first, with the password alone, and the upload as soon as it answered.
		expect(asked('POST /api/admin/import/confirm')[0].body).toEqual({ currentPassword: MINE, currentCode: CODE });
		expect(sent.map((request) => request.what)).toEqual(['POST /api/admin/import/confirm', 'POST /api/admin/import?outside=keep']);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		const headers = initFor('/api/admin/import?')!.headers as Record<string, string>;
		expect(headers[CONFIRMATION_HEADER]).toBe('the-confirmation');
		expect(headers['Content-Type']).toBe('application/octet-stream');
		// The password itself went nowhere but the confirm.
		expect(JSON.stringify(initFor('/api/admin/import?'))).not.toContain(MINE);
		expect(target.querySelector('.import-report')?.textContent).toContain('Database restored');
		// An answer with no `systemLog` (a backup that held no log lines) shows no line of it (card 2899, case 7).
		expect(target.querySelector('.import-report')?.textContent).not.toContain('system log');
		expect(picker).toHaveBeenCalledTimes(1);

		// Used once: a second backup chosen asks for the password again, and sends nothing until it is confirmed.
		pick(target);
		await settle();
		expect(asked('POST /api/admin/import?outside=keep')).toHaveLength(1);
		expect(document.querySelector('.confirm-modal input[type="password"]')).not.toBeNull();
	});

	// Card 2899 (case 7): the server's sentence that its system log was kept,
	// and the backup's lines not brought in, is shown with the rest.
	it('shows that the system log was kept, when the answer says so (card 2899)', async () => {
		const kept = "The system log was kept as it was: the backup's 42 log line(s) were not brought in, and remain in the backup file.";
		answer = (what) =>
			what === 'POST /api/admin/import/confirm'
				? Response.json({ confirmation: 'the-confirmation', expiresInSeconds: 60 })
				: what === 'POST /api/admin/import?outside=keep'
					? Response.json({ success: true, message: 'Database restored (4.0 KB).', restored: { boards: 2 }, sizeBytes: 4096, systemLog: kept })
					: undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		target.querySelector<HTMLButtonElement>('.btn-backup.import')!.click();
		flushSync();
		pick(target, 'monday.db');
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();

		const lines = [...target.querySelectorAll('.import-report .import-report-detail')].map((p) => p.textContent);
		expect(lines).toContain(kept);
	});

	// Card 2995 (test 24): the server's sentence of the API keys left out, and card 2922's of the settings held again
	// (its F6), each shown when the answer has it and not otherwise.
	it.each([
		{ answered: 'both sentences', given: true },
		{ answered: 'neither', given: false }
	])('shows the keys left out and the settings held again when the answer says so: $answered (card 2995)', async ({ given }) => {
		const keysLeftOut =
			'1 API key(s) in the backup were left out, because each was revoked or ended on this server, or was gone from it before endings were recorded: ' +
			'none of them works, and their holders make new ones on the Account page.';
		const settingsHeld = 'The mail settings, held for review on this server, are held again: keep or remove them under Settings held for review.';
		answer = (what) =>
			what === 'POST /api/admin/import/confirm'
				? Response.json({ confirmation: 'the-confirmation', expiresInSeconds: 60 })
				: what === 'POST /api/admin/import?outside=keep'
					? Response.json({
							success: true,
							message: 'Database restored (4.0 KB).',
							restored: { boards: 2 },
							sizeBytes: 4096,
							...(given ? { keysLeftOut, apiKeysLeftOut: 1, settingsHeld } : { apiKeysLeftOut: 0 })
						})
					: undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		target.querySelector<HTMLButtonElement>('.btn-backup.import')!.click();
		flushSync();
		pick(target, 'monday.db');
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();

		const lines = [...target.querySelectorAll('.import-report .import-report-detail')].map((p) => p.textContent);
		if (given) {
			expect(lines).toContain(keysLeftOut);
			expect(lines).toContain(settingsHeld);
		} else {
			expect(lines.join(' ')).not.toContain('API key');
			expect(lines.join(' ')).not.toContain('held for review');
		}
	});

	// Card 2996 (test 42): the server's lines of the accounts the record of account endings kept ended or lowered, each
	// shown when the answer has them and none otherwise.
	it.each([
		{ answered: 'two lines', given: true },
		{ answered: 'none', given: false }
	])('shows the accounts the record of account endings kept ended or lowered when the answer says so: $answered (card 2996)', async ({ given }) => {
		const accountsKeptLines = [
			'1 account(s) in the backup are named as deleted by the record of account endings: each is kept disabled, with no password or second factor that works, and cannot be enabled again.',
			'1 account(s) in the backup were given back the lower role the record of account endings holds.'
		];
		answer = (what) =>
			what === 'POST /api/admin/import/confirm'
				? Response.json({ confirmation: 'the-confirmation', expiresInSeconds: 60 })
				: what === 'POST /api/admin/import?outside=keep'
					? Response.json({
							success: true,
							message: 'Database restored (4.0 KB).',
							restored: { boards: 2 },
							sizeBytes: 4096,
							...(given
								? { accountsKept: { deleted: 1, beforeRecord: 0, disabled: 0, lowered: 1 }, accountsKeptLines }
								: { accountsKept: { deleted: 0, beforeRecord: 0, disabled: 0, lowered: 0 } })
						})
					: undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		target.querySelector<HTMLButtonElement>('.btn-backup.import')!.click();
		flushSync();
		pick(target, 'monday.db');
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();

		const shown = [...target.querySelectorAll('[data-testid="import-accounts-kept"]')].map((p) => p.textContent);
		expect(shown).toEqual(given ? accountsKeptLines : []);
		if (!given) expect([...target.querySelectorAll('.import-report .import-report-detail')].map((p) => p.textContent).join(' ')).not.toContain('record of account endings');
	});

	it('opens no dialog and sends nothing for a file that is not a .db backup, or one that cannot be read', async () => {
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		pick(target, 'export.json');
		await settle();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(target.querySelector('.import-report')?.textContent).toContain('is not a .db backup');

		const box = target.querySelector<HTMLInputElement>('.hidden-input')!;
		const unreadable = new File([new Uint8Array([1])], 'gone.db');
		Object.defineProperty(unreadable, 'arrayBuffer', { value: async () => Promise.reject(new DOMException('gone', 'NotReadableError')) });
		Object.defineProperty(box, 'files', { value: [unreadable], configurable: true });
		box.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(target.querySelector('.import-report')?.textContent).toContain('gone.db');
		expect(sent).toEqual([]);
	});

	it('sends no upload for a refused confirm: it says the server’s words in the dialog, which stays open with the field cleared and focused (card 2701)', async () => {
		answer = (what) =>
			what === 'POST /api/admin/import/confirm' ? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 }) : undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		pick(target);
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		type(field, 'a-wrong-one');
		typeCode(document);
		// Enter in the field is Confirm.
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await settle();

		expect(document.querySelector('.confirm-modal')).toBe(dialog);
		const alert = dialog.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe('Password is incorrect. Nothing was changed.');
		expect(field.getAttribute('aria-invalid')).toBe('true');
		expect(field.getAttribute('aria-describedby')).toBe(alert!.id);
		expect(field.value).toBe('');
		expect(document.activeElement).toBe(field);
		expect(sent.map((request) => request.what)).toEqual(['POST /api/admin/import/confirm']);

		// Cancel takes the words, the field and the file with it.
		type(field, 'half-typed');
		typeCode(document);
		buttonNamed(dialog, 'Cancel').click();
		flushSync();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		pick(target);
		await settle();
		const again = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(again.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
		expect(again.querySelector('[role="alert"]')).toBeNull();
		expect(sent.map((request) => request.what)).toEqual(['POST /api/admin/import/confirm']);
	});

	it('leaves no field to type in once the confirm says the session is signed out, and sends nothing more (card 2701, F5)', async () => {
		answer = (what) =>
			what === 'POST /api/admin/import/confirm'
				? Response.json({ message: STEP_UP_SIGNED_OUT, signedOut: true, stepUp: 'signed-out' }, { status: 403 })
				: undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		pick(target);
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		type(field, 'a-wrong-one');
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();

		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(STEP_UP_SIGNED_OUT);
		expect(field.disabled).toBe(true);
		expect(buttonNamed(dialog, 'Confirm').disabled).toBe(true);
		expect(sent.map((request) => request.what)).toEqual(['POST /api/admin/import/confirm']);
	});
});

// Card 2701, case 30 (decision 17): the export is a POST with the password, from a confirm that asks for it.
describe('the export asks for the password, mounted (card 2701)', () => {
	let saved: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		// The browser saves a file from the link the page clicks: here only counted.
		saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
		vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:the-file'), revokeObjectURL: vi.fn() }));
	});
	afterEach(() => saved.mockRestore());

	/** The export's confirm, opened from its button, the caller's password typed in it. */
	function askToExport(target: HTMLElement, password: string) {
		target.querySelector<HTMLButtonElement>('.btn-backup.export')!.click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('h3')?.textContent).toBe('Export Database');
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, password);
		typeCode(dialog);
		return dialog;
	}

	it('asks, sends a POST with the password, and saves the file from the answer', async () => {
		answer = (what) => (what === 'POST /api/admin/export' ? new Response('SQLite format 3', { headers: { 'content-type': 'application/octet-stream' } }) : undefined);
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		// Nothing is sent until the password is confirmed.
		const dialog = askToExport(target, MINE);
		expect(sent).toEqual([]);
		buttonNamed(dialog, 'Export').click();
		await settle();

		expect(asked('POST /api/admin/export').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		expect(asked('GET /api/admin/export')).toEqual([]);
		expect(saved).toHaveBeenCalledTimes(1);
		expect(document.querySelector('.confirm-modal')).toBeNull();
	});

	it('saves nothing for a refusal of the password, and says the server’s words in the dialog, which stays open', async () => {
		answer = (what) =>
			what === 'POST /api/admin/export' ? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 }) : undefined;
		const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
		const dialog = askToExport(target, 'a-wrong-one');
		buttonNamed(dialog, 'Export').click();
		await settle();

		expect(saved).not.toHaveBeenCalled();
		expect(document.querySelector('.confirm-modal')).toBe(dialog);
		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(field.value).toBe('');
		expect(document.activeElement).toBe(field);
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

	it('asks Purge All for the caller’s password and sends it; a refusal of it stays in the dialog, purging nothing more (card 2701)', async () => {
		let refuse = true;
		answer = (what) =>
			what === 'POST /api/admin/purge-archived'
				? refuse
					? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
					: Response.json({ success: true, purged: 1 })
				: undefined;
		const target = draw(ArchivedPage, { data: archivedData });
		buttonNamed(target, '🗑️ Purge All').click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(document.activeElement).toBe(field);
		type(field, 'a-wrong-one');
		typeCode(document);
		buttonNamed(dialog, 'Purge All').click();
		await settle();

		expect(asked('POST /api/admin/purge-archived').map((request) => request.body)).toEqual([{ currentPassword: 'a-wrong-one', currentCode: CODE }]);
		expect(document.querySelector('.confirm-modal')).toBe(dialog);
		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();

		refuse = false;
		type(field, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Purge All').click();
		await settle();
		expect(asked('POST /api/admin/purge-archived').map((request) => request.body)).toEqual([{ currentPassword: 'a-wrong-one', currentCode: CODE }, { currentPassword: MINE, currentCode: CODE }]);
		expect(document.querySelector('.confirm-modal')).toBeNull();
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

	it('is read-only to an administrator, with no Save and a line naming the superadmin, and has Save for the superadmin (card 2847)', async () => {
		const target = draw(AppUrlPanel, { isSuperadmin: false, superadminName: 'chief' });
		await settle();

		const field = target.querySelector<HTMLInputElement>('input[type="url"]')!;
		expect(field.value).toBe('https://kanban.example.com');
		expect(field.readOnly).toBe(true);
		expect(field.getAttribute('aria-disabled')).toBe('true');
		expect([...target.querySelectorAll('button')].map((button) => button.textContent!.trim())).toEqual([]);
		expect(target.querySelector('.app-url-superadmin')!.textContent!.replace(/\s+/g, ' ').trim()).toBe(
			'🔒 Setting the App URL belongs to the superadmin, chief: every link in a mail begins with it.'
		);
		expect(target.querySelector('.app-url-superadmin strong')!.textContent).toBe('chief');
		// Read, and nothing sent besides.
		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp']);

		unmount(drawn!.component);
		drawn!.target.remove();
		const own = draw(AppUrlPanel, { isSuperadmin: true, superadminName: 'chief' });
		await settle();
		expect(own.querySelector<HTMLInputElement>('input[type="url"]')!.readOnly).toBe(false);
		expect(buttonNamed(own, 'Save')).toBeDefined();
		expect(own.querySelector('.app-url-superadmin')).toBeNull();
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
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
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
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
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
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
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
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
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
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
		await settle();
		const field = target.querySelector<HTMLInputElement>('input[type="url"]')!;

		type(field, '');
		buttonNamed(target, 'Save').click();
		flushSync();
		// Card 2701: Save asks for the caller's password first, and sends nothing until it is confirmed.
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('h3')?.textContent).toBe('Save App URL');
		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp']);
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(dialog);
		buttonNamed(dialog, 'Save').click();
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp', 'PUT /api/admin/smtp', 'GET /api/admin/smtp']);
		expect(asked('PUT /api/admin/smtp')[0].body).toEqual({ appUrl: '', currentPassword: MINE, currentCode: CODE });
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(field.value).toBe('https://env.example.com');
		expect(target.querySelector('.app-url-from')?.textContent?.trim()).toBe(FROM.environment);
	});

	it('keeps the confirm open on a refusal of the password, saying it there and nowhere else, and saves on the next Confirm (card 2701)', async () => {
		let refuse = true;
		answer = (what) =>
			what === 'PUT /api/admin/smtp'
				? refuse
					? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
					: Response.json({ success: true })
				: undefined;
		// The superadmin's panel, with Save (card 2847).
		const target = draw(AppUrlPanel, { isSuperadmin: true });
		await settle();
		buttonNamed(target, 'Save').click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const box = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		type(box, 'a-wrong-one');
		typeCode(document);
		buttonNamed(dialog, 'Save').click();
		await settle();

		expect(document.querySelector('.confirm-modal')).toBe(dialog);
		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		let shown: { message: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string }[]))();
		expect(shown.map((toast) => toast.message)).not.toContain('Password is incorrect. Nothing was changed.');
		// The panel is not read again for a refusal.
		expect(asked('GET /api/admin/smtp')).toHaveLength(1);

		refuse = false;
		type(box, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Save').click();
		await settle();
		expect(asked('PUT /api/admin/smtp').map((request) => (request.body as { currentPassword: string }).currentPassword)).toEqual(['a-wrong-one', MINE]);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(asked('GET /api/admin/smtp')).toHaveLength(2);
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
	dbSizeBytes: 0,
	// Card 2920: the uploads volume, with room.
	uploadsSpace: { state: 'room', lowBecause: null, freeBytes: 40 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, freeInodes: null, refusedBelowBytes: 1049 * 1024 ** 2 },
	// Card 3064: two-step sign-in required, as on HEAD.
	twoStepSwitch: {
		required: true,
		requiredAt: '2026-11-24 09:00:00' as string | null,
		accountsWithoutFactor: 0,
		passwordOnlySessions: 0,
		administratorsWithoutFactor: [] as { id: number; username: string }[],
		keysWithoutFactor: 0,
		keysWithoutFactorListed: [] as { id: number; createdAt: string; lastUsedAt: string | null; holder: string; holderId: number }[] | null,
		mayRequire: true
	}
};

// Card 2920: the Database Overview's line for the uploads volume, in each of its three states.
describe('the uploads volume on the Database Overview (card 2920)', () => {
	const GiB = 1024 ** 3;
	it.each([
		{
			row: 'room',
			space: { state: 'room', lowBecause: null, freeBytes: 40 * GiB, totalBytes: 100 * GiB, freeInodes: null, refusedBelowBytes: 1.5 * GiB },
			says: 'Uploads disk: 40.0 GB free of 100.0 GB. Uploads are refused when less than 1.5 GB is free.',
			alert: false
		},
		{
			row: 'low',
			space: { state: 'low', lowBecause: 'space', freeBytes: 1.2 * GiB, totalBytes: 100 * GiB, freeInodes: null, refusedBelowBytes: 1.5 * GiB },
			says: "Uploads are refused: 1.2 GB free of 100.0 GB, below 1.5 GB (1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume.",
			alert: true
		},
		// The code review's C2: a full disk is 0 B free, not a figure not read.
		{
			row: 'low, nothing free',
			space: { state: 'low', lowBecause: 'space', freeBytes: 0, totalBytes: 100 * GiB, freeInodes: null, refusedBelowBytes: 1.5 * GiB },
			says: "Uploads are refused: 0 B free of 100.0 GB, below 1.5 GB (1 GB plus twice the database's size, and room for a 25 MB upload). Free some space or grow the volume.",
			alert: true
		},
		// C1: too few inodes, and a write that found the disk full.
		{
			row: 'low, inodes',
			space: { state: 'low', lowBecause: 'inodes', freeBytes: 40 * GiB, totalBytes: 100 * GiB, freeInodes: 12, refusedBelowBytes: 1.5 * GiB },
			says: 'Uploads are refused: the uploads disk has 12 free inodes (file entries), below 1,000. Delete files or grow the volume.',
			alert: true
		},
		{
			row: 'low, a write found it full',
			space: { state: 'low', lowBecause: 'full', freeBytes: 2 * GiB, totalBytes: 100 * GiB, freeInodes: null, refusedBelowBytes: 1.5 * GiB },
			says: 'Uploads are refused: an upload found the uploads disk full. 2.0 GB free of 100.0 GB now; uploads are accepted again when more is free than before it filled, or 5 minutes after.',
			alert: true
		},
		{
			row: 'unreadable',
			space: { state: 'unreadable', lowBecause: null, freeBytes: null, totalBytes: null, freeInodes: null, refusedBelowBytes: 1.5 * GiB },
			says: 'Uploads are refused: the free space on the uploads disk could not be read. The system log says why.',
			alert: true
		}
	])('11. says how much is free and whether uploads are refused: $row', ({ space, says, alert }) => {
		const target = draw(AdminOverview, { data: { ...pageData, uploadsSpace: space } });

		const line = target.querySelector<HTMLElement>('.space-line')!;
		expect(line.textContent!.replace(/\s+/g, ' ').trim()).toBe(says);
		expect(line.getAttribute('role')).toBe(alert ? 'alert' : null);
	});
});

/** `user` as the admin load gives a disabled account's row, disabled by the superadmin (card 2671). */
const disabledRow = <T extends object>(user: T) => ({ ...user, disabledAt: '2099-01-02 09:00:00', disabledByName: 'chief', disabledBySuperadmin: true });
/** The page's data with bob disabled: only a disabled account is offered 🗑️ (card 2671, D14). */
const withBobDisabled = <T extends { users: { id: number }[] }>(data: T): T => ({ ...data, users: data.users.map((u) => (u.id === bob.id ? disabledRow(u) : u)) });

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
		// Card 2701: Create waits for the caller's own password, typed in a field of the form's own.
		expect(buttonNamed(target, 'Create').disabled).toBe(true);
		const mine = target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
		expect(mine.type).toBe('password');
		expect(mine.getAttribute('autocomplete')).toBe('current-password');
		type(mine, MINE);
		typeCode(document);
		buttonNamed(target, 'Create').click();
		flushSync();
		// Cleared once sent.
		expect(mine.value).toBe('');
		await settle();

		expect(asked('POST /api/users').map((request) => request.body)).toEqual([
			{ username: 'carol', email: 'carol@example.com', emoji: '👤', role: 'user', currentPassword: MINE, currentCode: CODE }
		]);
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

	it('shows the set-up link of a user made with a password in the dialog, under its own words (card 2851)', async () => {
		const message = 'carol was made. Give them their set-up link yourself, with the password you chose: it is shown once, and works for seven days.';
		answer = (what) =>
			what === 'POST /api/users'
				? Response.json({ username: 'carol', invited: false, enrolmentUrl: 'http://localhost/enrol/t4', message }, { status: 201 })
				: undefined;
		const link = { value: null as unknown };
		const target = draw(UsersPanel, bound({ data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn() }, 'inviteLink', link));

		buttonNamed(target, '+ Add User').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!, 'carol');
		type(target.querySelector<HTMLInputElement>('input[placeholder="Email"]')!, 'carol@example.com');
		type(target.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')!, 'a long password');
		type(target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, MINE);
		typeCode(document);
		buttonNamed(target, 'Create').click();
		flushSync();
		await settle();

		expect(asked('POST /api/users').map((request) => (request.body as { password?: string }).password)).toEqual(['a long password']);
		expect(link.value).toEqual({
			url: 'http://localhost/enrol/t4',
			username: 'carol',
			message,
			returnTo: buttonNamed(target, '+ Add User'),
			kind: 'new-account'
		});

		// Drawn as the page draws it, from the link the panel handed back.
		const dialog = draw(InviteLinkDialog, { inviteLink: link.value }).querySelector<HTMLElement>('[role="alertdialog"]')!;
		flushSync();
		expect(dialog.getAttribute('aria-label')).toBe("The new account's set-up link");
		expect(dialog.querySelector('h2')!.textContent).toBe('🔑 Their set-up link');
		expect(dialog.querySelector('code')!.textContent).toBe('http://localhost/enrol/t4');
		expect(dialog.querySelector('#invite-link-said')!.textContent).toBe(message);
		expect(dialog.querySelector('#invite-link-warning')!.textContent).toBe(
			'Give carol this link yourself, with the password you chose, by a way only they read: it is shown once, here. It works for seven ' +
				'days, and stops working if their password is set again or their two-step sign-in is reset. Whoever opens it and knows the ' +
				"password sets up the authenticator of carol's account. Do not open it yourself."
		);
		expect(dialog.textContent).toContain('It is not shown again. If it is lost, give a new one with 🛡️ on their row.');
		expect(document.activeElement).toBe(buttonNamed(dialog, '📋 Copy'));
		expect(dialog.textContent).not.toContain('invite');
	});

	it('says a refusal of the caller’s password in Add User beside its field, labelled and focused, with no toast; the form stays (card 2701, F7)', async () => {
		answer = (what) =>
			what === 'POST /api/users' ? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 }) : undefined;
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });

		buttonNamed(target, '+ Add User').click();
		flushSync();
		type(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!, 'carol');
		type(target.querySelector<HTMLInputElement>('input[placeholder="Email"]')!, 'carol@example.com');
		const mine = target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
		expect(target.querySelector(`label[for="${mine.id}"]`)?.textContent).toBe('Your password');
		type(mine, 'a-wrong-one');
		typeCode(document);
		buttonNamed(target, 'Create').click();
		await settle();

		const alert = target.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe('Password is incorrect. Nothing was changed.');
		expect(mine.getAttribute('aria-describedby')).toBe(alert!.id);
		expect(document.activeElement).toBe(mine);
		expect(mine.value).toBe('');
		let shown: { message: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string }[]))();
		expect(shown.map((toast) => toast.message)).not.toContain('Password is incorrect. Nothing was changed.');
		expect(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!.value).toBe('carol');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});

	it('asks the page’s confirm before a delete, whose action sends it', async () => {
		const confirm = vi.fn();
		// Card 2671: 🗑️ is offered on a disabled row alone, and on no enabled one.
		const target = draw(UsersPanel, { data: withBobDisabled(pageData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		expect(target.querySelectorAll('button[title="Delete user"]')).toHaveLength(1);

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toBe('Delete User');
		// Card 2701: it asks for the caller's password, which the delete sends.
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();

		expect(asked('DELETE /api/users/2').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
	});

	it('gives a refusal of the password back to the confirm, with no toast and nothing changed on the page (card 2701)', async () => {
		answer = (what) =>
			what === 'DELETE /api/users/2' || what === 'POST /api/users/2/invite'
				? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
				: undefined;
		// Every toast gone: an earlier case's may still be up.
		let before: { id: number }[] = [];
		toasts.subscribe((list) => (before = list))();
		for (const toast of before) toasts.dismiss(toast.id);
		const confirm = vi.fn();
		// Card 2671: the delete of bob once disabled, and 📧 for bob as he is, each on a page of its own.
		const disabledPage = draw(UsersPanel, { data: withBobDisabled(pageData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		disabledPage.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(await confirm.mock.calls[0][2](proofOf('a-wrong-one'))).toBe('Password is incorrect. Nothing was changed.');
		unmount(drawn!.component);
		drawn!.target.remove();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		// 📧 asks first too, and its refusal comes back the same way.
		target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!.click();
		expect(confirm.mock.calls[1][0]).toBe('Send Invite');
		expect(confirm.mock.calls[1][3]).toEqual({ askPassword: true });
		expect(await confirm.mock.calls[1][2](proofOf('a-wrong-one'))).toBe('Password is incorrect. Nothing was changed.');
		await settle();

		expect(asked('POST /api/users/2/invite').map((request) => request.body)).toEqual([{ currentPassword: 'a-wrong-one', currentCode: CODE }]);
		let shown: unknown[] = [];
		toasts.subscribe((list) => (shown = list))();
		expect(shown).toEqual([]);
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
		// 📧 can be pressed again: the invite is no longer out.
		expect(target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!.disabled).toBe(false);
	});

	// Card 3012 (R8): 📧's confirm names the address the invite goes to, which a restore may have taken from a file.
	it("(s) 3012: 📧's confirm names the account's address", () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!.click();

		expect(confirm.mock.calls[0][0]).toBe('Send Invite');
		expect(confirm.mock.calls[0][1]).toMatch(/^Send bob a new invite, to bob@example\.com\? Whoever opens its link sets the account's password/);
	});

	it("(s2) 3012, FP3: each character of the address outside printable ASCII is shown as its code point, a look-alike's too, and the name holds no direction override", () => {
		const RLO = String.fromCharCode(0x202e);
		const BELL = String.fromCharCode(0x07);
		const CYRILLIC_A = String.fromCharCode(0x430);
		const turned = {
			...pageData,
			users: pageData.users.map((user) =>
				user.id === bob.id ? { ...user, username: `bob${RLO}evil`, email: `bob${RLO}moc.elpmaxe${BELL}@ex${CYRILLIC_A}mple.com` } : user
			)
		};
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: turned, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!.click();

		const said = confirm.mock.calls[0][1] as string;
		expect(said).toContain(String.raw`Send bob evil a new invite, to bob\u{202E}moc.elpmaxe\u{7}@ex\u{430}mple.com? `);
		for (const character of [RLO, BELL, CYRILLIC_A]) expect(said).not.toContain(character);
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
		const target = draw(UsersPanel, { data: withBobDisabled({ ...pageData, teams }), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message] = confirm.mock.calls[0];
		expect(title).toBe('Delete User');
		expect(message).toMatch(
			/^Delete user "bob" for good\? They are the only owner of: Alpha, Zeta, so the delete will be refused: make someone else an owner or delete those teams first\. The account is disabled already, /
		);
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('DELETE /api/users/2')).toHaveLength(1);
	});

	it('says nothing of teams in the confirmation for an account that alone owns none (card 2380)', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: withBobDisabled(pageData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm.mock.calls[0][1]).toMatch(/^Delete user "bob" for good\? The account is disabled already, /);
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
		// Card 2701: a reset waits for the administrator's own password too.
		expect(buttonNamed(target, 'Reset Password').disabled).toBe(true);
		type(target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, MINE);
		typeCode(target);
		buttonNamed(target, 'Reset Password').click();
		await settle();

		expect(asked('PUT /api/users/2/password').map((request) => request.body)).toEqual([{ password: 'a-new-password', currentPassword: MINE, currentCode: CODE }]);
		expect(target.textContent).not.toContain('Enter a new password for bob.');
	});

	it('keeps the password dialog open on a refusal of the administrator’s own password, saying it there, the field cleared and focused (card 2701)', async () => {
		answer = (what) =>
			what === 'PUT /api/users/2/password' ? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 }) : undefined;
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[1].click();
		await settle();
		type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
		const mine = target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
		type(mine, 'a-wrong-one');
		typeCode(document);
		buttonNamed(target, 'Reset Password').click();
		await settle();

		expect(target.textContent).toContain('Enter a new password for bob.');
		expect(target.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		expect(mine.value).toBe('');
		expect(document.activeElement).toBe(mine);
		// The new password typed is kept, to send again with the right one.
		expect(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!.value).toBe('a-new-password');
	});
});

// Card 2671 (case 45): ⛔ disables an account, and a disabled account's row offers ✅ and 🗑️ alone.
describe('disabling and enabling on the users panel, mounted (card 2671)', () => {
	const ada = { id: 3, username: 'ada', email: 'ada@example.com', emoji: '🛠️', role: 'admin' };
	/** The page's data with bob disabled by `by`, as the admin load gives a disabled row. */
	const bobDisabled = (currentUser: typeof chief | typeof ada, by: { name: string; superadmin: boolean }) => ({
		...pageData,
		currentUser,
		users: [
			{ ...chief, apiKeys: null, webhooks: null, reportSchedules: null },
			{ ...bob, disabledAt: '2099-01-02 09:00:00', disabledByName: by.name, disabledBySuperadmin: by.superadmin },
			{ ...ada, apiKeys: null, webhooks: null, reportSchedules: null }
		]
	});
	const rowOf = (target: HTMLElement, name: string) =>
		[...target.querySelectorAll<HTMLElement>('.user-row')].find((row) => row.querySelector('.user-row-name')?.textContent === name)!;
	const titlesIn = (row: HTMLElement) => [...row.querySelectorAll('button')].map((button) => button.title).filter((title) => title !== '');

	it('shows a disabled row greyed, with when and by whom, offering Enable and Delete and not 🔑, 📧 or 🛡️; and neither to an administrator for one the superadmin disabled', () => {
		const target = draw(UsersPanel, { data: bobDisabled(chief, { name: 'chief', superadmin: true }), isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		const row = rowOf(target, 'bob');

		expect(row.classList.contains('disabled-row')).toBe(true);
		expect(row.querySelector('.user-row-disabled')?.textContent).toBe('Disabled 2099-01-02 by chief');
		expect(titlesIn(row)).toEqual(['Enable user', 'Delete user']);
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;

		// An administrator, for an account the superadmin disabled (S14, S14b): nothing but the row.
		const asAdmin = draw(UsersPanel, { data: bobDisabled(ada, { name: 'chief', superadmin: true }), isSuperadmin: false, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		expect(titlesIn(rowOf(asAdmin, 'bob'))).toEqual([]);
		expect(rowOf(asAdmin, 'bob').querySelector('.user-row-disabled')?.textContent).toBe('Disabled 2099-01-02 by chief');
	});

	it('asks before a disable, naming the settings that go with an administrator, then sends it with the password and says what it ended and that the notice could not go', async () => {
		answer = (what) =>
			what === 'GET /api/users/3'
				? Response.json({ id: 3, settingsSet: { mail: true, appUrl: false, destinations: ['NAS'] } })
				: what === 'POST /api/users/3/disable'
					? Response.json({
							disabled: true,
							sessionsEnded: 1,
							apiKeysEnded: 0,
							webhooksSwitchedOff: 0,
							reportSchedulesPaused: 0,
							requestLinksEnded: 0,
							soleOwnerOf: [],
							noticeSent: false,
							settingsRemoved: { mail: true, appUrl: false, destinations: ['NAS'], failureAddress: true }
						})
					: undefined;
		const confirm = vi.fn();
		const settingsRemoved = vi.fn();
		const data = { ...pageData, users: [...pageData.users, { ...ada, apiKeys: 0, webhooks: 0, reportSchedules: 0, failureAddress: true }] };
		const target = draw(UsersPanel, { data, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });

		rowOf(target, 'ada').querySelector<HTMLButtonElement>('button[title="Disable user"]')!.click();
		await settle();
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message, send, options] = confirm.mock.calls[0];
		expect(title).toBe('Disable User');
		expect(options).toEqual({ askPassword: true });
		expect(message).toMatch(/^Disable user "ada"\? They can no longer sign in\./);
		// Card 2923 (S9): the boards' owners are mailed, of those already off too.
		expect(message).toContain(
			"none of this comes back if the account is enabled again. Their boards' owners are mailed about the webhooks, and about any already switched off, which can now be switched on only with a new secret."
		);
		expect(message).toContain(
			'This also removes what they set: the mail settings, so no mail is sent, invites and password resets included, until an administrator sets them again in Email / SMTP; ' +
				'the backup destination "NAS"; their address from the backup failure address, so backup failures are not mailed to them.'
		);
		expect(message.endsWith(ASKS_FOR_PASSWORD)).toBe(true);

		await send(proofOf(MINE));
		await settle();
		expect(asked('POST /api/users/3/disable').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		expect(settingsRemoved).toHaveBeenCalledWith({ mail: true, appUrl: false, destinations: ['NAS'] });
		let shown: { message: string }[] = [];
		toasts.subscribe((list) => (shown = list as { message: string }[]))();
		expect(shown.map((toast) => toast.message)).toContainEqual(
			expect.stringMatching(/^ada was disabled: ended 1 session, 0 API keys and 0 request links, .* The notice to ada could not be sent: the mail settings were removed with them\.$/)
		);
	});

	it("asks before an enable, listing what comes back and what does not, then sends it with the password", async () => {
		answer = (what) => (what === 'POST /api/users/2/enable' ? Response.json({ enabled: true, noticeSent: true }) : undefined);
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: bobDisabled(chief, { name: 'ada', superadmin: false }), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		rowOf(target, 'bob').querySelector<HTMLButtonElement>('button[title="Enable user"]')!.click();
		expect(confirm).toHaveBeenCalledTimes(1);
		const [title, message, send, options] = confirm.mock.calls[0];
		expect(title).toBe('Enable User');
		expect(options).toEqual({ askPassword: true });
		expect(message).toBe(`${userEnableWarning('bob')} ${ASKS_FOR_PASSWORD}`);
		for (const said of ['the boards and teams they are on', "a board's Product Owner or a decision's decider", 'being sent requests', 'and their mail', 'Their API keys, webhooks, report schedules and request links stay ended']) {
			expect(message).toContain(said);
		}

		await send(proofOf(MINE));
		await settle();
		expect(asked('POST /api/users/2/enable').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});
});

// Card 2773: 🛡️ resets another account's two-step sign-in, its link shown once in the invite
// link's dialog with words of its own, and 📧 is refused for an account that uses it.
describe('the two-step sign-in reset on the users panel and its dialog, mounted (card 2773)', () => {
	const ada = { id: 3, username: 'ada', email: 'ada@example.com', emoji: '🛠️', role: 'admin' };
	/** Every account but the caller's own counted, as the admin load gives them; `twoStep` null where the caller may not manage it. */
	const withTwoStep = (currentUser: typeof chief | typeof ada, bobsTwoStep: boolean) => ({
		...pageData,
		currentUser,
		users: [
			{ ...chief, apiKeys: null, webhooks: null, reportSchedules: null, twoStep: null },
			{ ...bob, twoStep: bobsTwoStep },
			{ ...ada, apiKeys: 0, webhooks: 0, reportSchedules: 0, twoStep: currentUser.id === chief.id ? false : null }
		]
	});
	const shieldsOf = (target: HTMLElement) =>
		[...target.querySelectorAll<HTMLButtonElement>('button[title="Reset two-step sign-in"]')].map(
			(button) => button.closest('.user-row')!.querySelector('.user-row-name')!.textContent
		);

	it('T18: shows 🛡️ on every account the caller manages but their own and the superadmin’s, asks with the password, sends it, and hands the link back with its kind', async () => {
		answer = (what) =>
			what === 'POST /api/users/2/mfa/reset'
				? Response.json({ success: true, enrolmentUrl: 'https://kanban.example.com/enrol/t3', mailSent: false, message: "bob's two-step sign-in was reset." })
				: undefined;
		const asAdmin = draw(UsersPanel, { data: withTwoStep(ada, true), isSuperadmin: false, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		expect(shieldsOf(asAdmin)).toEqual(['bob']);
		unmount(drawn!.component);
		drawn!.target.remove();

		const link = { value: null as unknown };
		const confirm = vi.fn();
		const target = draw(UsersPanel, bound({ data: withTwoStep(chief, true), isSuperadmin: true, confirm, loadMailStatus: vi.fn() }, 'inviteLink', link));
		expect(shieldsOf(target)).toEqual(['bob', 'ada']);

		const shield = target.querySelector<HTMLButtonElement>('button[title="Reset two-step sign-in"]')!;
		shield.click();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toBe('Reset Two-Step Sign-In');
		expect(confirm.mock.calls[0][1]).toBe(
			// Card 2894 (case 8, E24): the reset pauses the account's report schedules, and the confirm says so first;
			// card 2915 (case 16): it ends their API keys and switches off their webhooks, said with no counts.
			// Card 2923 (S9): and that the boards' owners are mailed, of those already off too.
			"Reset bob's two-step sign-in? Their authenticator and recovery codes stop working, they are signed out everywhere, their API keys end, the webhooks they set up are switched off, their report schedules are paused, and you are given a link, once, to pass on to them yourself. " +
				"Their boards' owners are mailed about the webhooks, and about any already switched off, which can now be switched on only with a new secret." +
				// Card 2935 (P8): and the webhooks on the boards they own whose secret they could read, in words.
				`${readableWebhooksWords(false)} ` +
				ASKS_FOR_PASSWORD
		);
		expect(readableWebhooksWords(false)).toContain('Every webhook on the boards they own that has a secret, whoever set it up, is switched off too');
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();

		expect(asked('POST /api/users/2/mfa/reset').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		expect(link.value).toEqual({
			url: 'https://kanban.example.com/enrol/t3',
			username: 'bob',
			message: "bob's two-step sign-in was reset.",
			returnTo: shield,
			kind: 'mfa-reset'
		});
		// So that `twoStep` is read again, and 📧 is offered again.
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('T19: makes 📧 aria-disabled for an account that uses two-step sign-in, its title saying why, and pressing it sends nothing', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: withTwoStep(chief, true), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		const refused = target.querySelector<HTMLButtonElement>('button[title="This account uses two-step sign-in. Reset it first, then send the invite"]')!;
		expect(refused.closest('.user-row')!.querySelector('.user-row-name')!.textContent).toBe('bob');
		expect(refused.getAttribute('aria-disabled')).toBe('true');
		// Not disabled, so its title shows.
		expect(refused.disabled).toBe(false);
		refused.click();
		await settle();

		expect(confirm).not.toHaveBeenCalled();
		expect(sent.filter((request) => request.what.includes('/invite'))).toEqual([]);
		// ada does not use it: her 📧 is as it was.
		const hers = target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!;
		expect(hers.closest('.user-row')!.querySelector('.user-row-name')!.textContent).toBe('ada');
		expect(hers.hasAttribute('aria-disabled')).toBe(false);
	});

	it('T20: shows a reset’s link in the dialog with its own label, heading, warning and footer, and none of the invite’s words', () => {
		const target = draw(InviteLinkDialog, {
			inviteLink: { url: 'https://kanban.example.com/enrol/t3', username: 'bob', message: "bob's two-step sign-in was reset.", kind: 'mfa-reset' }
		});

		const dialog = target.querySelector<HTMLElement>('[role="alertdialog"]')!;
		expect(dialog.getAttribute('aria-label')).toBe("The two-step sign-in reset's link");
		expect(dialog.querySelector('h2')!.textContent).toBe('🛡️ Two-step sign-in was reset');
		expect(dialog.querySelector('code')!.textContent).toBe('https://kanban.example.com/enrol/t3');
		expect(dialog.querySelector('#invite-link-said')!.textContent).toBe("bob's two-step sign-in was reset.");
		expect(dialog.querySelector('#invite-link-warning')!.textContent).toBe(
			'Give bob this link yourself, by a way only they read: it is shown once, here. It works for seven days, and stops working if their ' +
				"two-step sign-in is reset again. Whoever opens it sets up the authenticator of bob's account, and the account still needs its " +
				'password. Do not open it yourself.'
		);
		expect(dialog.textContent).toContain("It is not shown again. If it is lost, reset bob's two-step sign-in again with 🛡️");
		expect(dialog.textContent).not.toContain('invite');
		expect(buttonNamed(dialog, '📋 Copy')).toBeDefined();
		expect(buttonNamed(dialog, 'Done')).toBeDefined();
	});
});

// Card 2769 (decision 25): an account that may still set up two-step sign-in on its
// password alone, in the 14 days after the release, says until when.
describe('the users panel’s password set-up date (card 2769)', () => {
	it('T76: a row with passwordSetUpUntil says "may set up on password until <date>", and a row without says nothing of it', () => {
		const data = { ...pageData, users: [{ ...pageData.users[0], passwordSetUpUntil: null }, { ...bob, passwordSetUpUntil: '2026-11-27 10:00:00' }] };

		const target = draw(UsersPanel, { data, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });

		const rows = [...target.querySelectorAll('.user-row')];
		const said = (name: string) => rows.find((row) => row.querySelector('.user-row-name')!.textContent === name)!.textContent!;
		expect(said('bob')).toContain('may set up on password until 2026-11-27 10:00:00 UTC');
		expect(said('chief')).not.toContain('may set up on password');
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
		// Card 2701: a change of role asks for the caller's password, through the page's confirm.
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: confirmedAtOnce(), loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });
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
		const target = draw(UsersPanel, { data: withBobDisabled(pageData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2](proofOf(MINE));
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
		expect(confirm.mock.calls[0].slice(0, 2)).toEqual(['Change Role', `Make bob a user? This removes what they set: ${NAMED}. ${DEMOTION_HOLDS} ${ASKS_FOR_PASSWORD}`]);
		// Card 2701: and for the caller's password, which the change sends.
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user', currentPassword: MINE, currentCode: CODE }]);
	});

	// Card 2701: every change of role asks for the caller's password; where nothing would go it names nothing (the controls).
	it('asks only for the password, naming nothing, where nothing would go: bob made an administrator, or made a user holding nothing (the controls)', async () => {
		answer = (what) => (what === 'PUT /api/users/2' ? Response.json({ id: 2, role: 'admin', invitesEnded: 0 }) : undefined);
		const confirm = confirmedAtOnce();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'admin');
		changeButton(target).click();
		await settle();
		expect(confirm.mock.calls.map((call) => call.slice(0, 2))).toEqual([['Change Role', `Make bob an administrator? ${ASKS_FOR_PASSWORD}`]]);
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'admin', currentPassword: MINE, currentCode: CODE }]);
		// Made an administrator: nothing goes, so nothing is read first.
		expect(asked('GET /api/users/2')).toEqual([]);
		unmount(drawn!.component);
		drawn!.target.remove();

		const plain = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const again = draw(UsersPanel, { data: plain, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(again, 'user');
		changeButton(again).click();
		await settle();
		expect(confirm.mock.calls[1].slice(0, 2)).toEqual(['Change Role', `Make bob a user? ${DEMOTION_HOLDS} ${ASKS_FOR_PASSWORD}`]);
		expect(asked('PUT /api/users/2')).toHaveLength(2);
		expect(asked('GET /api/users/2')).toHaveLength(1);
	});

	it('names in the delete’s confirmation what would go with bob’s account', async () => {
		answer = holding;
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: withBobDisabled(holdingData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(confirm.mock.calls[0][1]).toMatch(/^Delete user "bob" for good\? The account is disabled already, /);
		expect(confirm.mock.calls[0][1]).toMatch(
			new RegExp(` Their XP stays on the leaderboard\\. What they set goes too: ${NAMED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. You will be asked for your password and a code from your authenticator app\\.$`)
		);
	});

	// The card 2397 second review: the page's data is as old as the page. Another administrator took a
	// setting over, or gave one back, since it was read; the question follows the server.
	it('asks before bob is made a user, or deleted, where the server says he holds settings the page’s data does not name', async () => {
		answer = holding;
		const confirm = vi.fn();
		const stale = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const target = draw(UsersPanel, { data: withBobDisabled(stale), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'user');

		changeButton(target).click();
		await settle();
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(asked('PUT /api/users/2')).toEqual([]);
		expect(confirm.mock.calls.map((call) => call[0])).toEqual(['Change Role', 'Delete User']);
		expect(confirm.mock.calls[0][1]).toBe(`Make bob a user? This removes what they set: ${NAMED}. ${DEMOTION_HOLDS} ${ASKS_FOR_PASSWORD}`);
		expect(confirm.mock.calls[1][1]).toMatch(/ What they set goes too: the mail settings, /);
	});

	it('names nothing in the role change’s or the delete’s confirmation where the server says he no longer holds what the page’s data names', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: withBobDisabled(holdingData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		expect(confirm.mock.calls[0][1]).not.toContain('What they set');
		choose(target, 'user');

		changeButton(target).click();
		await settle();

		// Card 2701: the change asks for the caller's password all the same, naming nothing.
		expect(confirm.mock.calls[1].slice(0, 2)).toEqual(['Change Role', `Make bob a user? ${DEMOTION_HOLDS} ${ASKS_FOR_PASSWORD}`]);
		await confirm.mock.calls[1][2](proofOf(MINE));
		await settle();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user', currentPassword: MINE, currentCode: CODE }]);
	});

	it.each([
		{ how: 'refused', fails: () => Response.json({ message: 'Server error' }, { status: 500 }) },
		{ how: 'not answered', fails: () => Promise.reject(new TypeError('Failed to fetch')) }
	])('asks all the same, in general words, where the read of what bob holds is $how', async ({ fails }) => {
		answer = (what) => (what === 'GET /api/users/2' ? (fails() as Response | Promise<Response>) : undefined);
		const confirm = vi.fn();
		const plain = { ...pageData, users: [pageData.users[0], { ...bob, role: 'admin', settingsSet: null }] };
		const target = draw(UsersPanel, { data: withBobDisabled(plain), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		choose(target, 'user');
		const UNREAD =
			'What they set of the mail settings, the App URL and the backup destinations could not be read just now: whatever of it is still theirs goes too.';

		changeButton(target).click();
		await settle();
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();

		expect(asked('PUT /api/users/2')).toEqual([]);
		expect(confirm.mock.calls[0].slice(0, 2)).toEqual(['Change Role', `Make bob a user? ${UNREAD} ${DEMOTION_HOLDS} ${ASKS_FOR_PASSWORD}`]);
		expect(confirm.mock.calls[1][1]).toMatch(/^Delete user "bob" for good\? The account is disabled already, /);
		expect(confirm.mock.calls[1][1].endsWith(` ${UNREAD} ${ASKS_FOR_PASSWORD}`)).toBe(true);
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'user', currentPassword: MINE, currentCode: CODE }]);
	});

	it('says only that it was done, and asks nothing of the page, where the answer names nothing removed', async () => {
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true }) : undefined);
		const confirm = vi.fn();
		const settingsRemoved = vi.fn();
		const target = draw(UsersPanel, { data: withBobDisabled(pageData), isSuperadmin: true, confirm, loadMailStatus: vi.fn(), settingsRemoved, inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2](proofOf(MINE));
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
		type(target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'the-old-one');
		typeCode(target);
		type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
		buttonNamed(target, 'Change Password').click();
		await settle();

		expect(asked('PUT /api/account/password').map((request) => request.body)).toEqual([{ currentPassword: 'the-old-one', currentCode: CODE, newPassword: 'a-new-password' }]);
	});

	// Card 2894 (case 8, D1, E22): the own row's change always pauses the caller's report schedules; the dialog says so
	// before, and the toast gives the answer's count after.
	it('says on the own row that the report schedules are paused, and gives the count the answer gives in the toast', async () => {
		answer = (what) =>
			what === 'PUT /api/account/password'
				? Response.json({ success: true, apiKeysEnded: 0, webhooksSwitchedOff: 0, reportSchedulesPaused: 2 })
				: undefined;
		/** The toasts up now, by kind and words. */
		const toastsShown = () => {
			let shown: { id: number; message: string; type: string }[] = [];
			toasts.subscribe((list) => (shown = list as typeof shown))();
			return shown;
		};
		for (const toast of toastsShown()) toasts.dismiss(toast.id);
		const target = draw(ResetPasswordDialog, { data: pageData });
		await (drawn!.component as unknown as { openResetDialog: (userId: number) => Promise<void> }).openResetDialog(1);
		flushSync();
		expect(target.textContent).toContain('Your other sessions will be signed out. Your report schedules are paused.');

		type(target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, 'the-old-one');
		typeCode(target);
		type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
		buttonNamed(target, 'Change Password').click();
		await settle();

		expect(toastsShown().map((toast) => [toast.type, toast.message])).toEqual([['success', 'Password changed: 2 report schedules paused']]);
		for (const toast of toastsShown()) toasts.dismiss(toast.id);
	});

	// Card 2886 (plan section 5, case 1; D1, D2, F1): the dialog held no focus, kept no Tab, took no Escape and had no name.
	it('holds the focus as the other admin dialogs do: the password focused, Tab kept inside, Escape is Cancel, the focus back on 🔑, and named', async () => {
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		const opener = target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[1];
		opener.focus();
		opener.click();
		await settle();

		const dialog = target.querySelector<HTMLElement>('[role="dialog"]')!;
		expect(dialog.getAttribute('aria-label')).toBe('Reset Password');
		const password = dialog.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
		expect(document.activeElement).toBe(password);
		// Reset Password is off with nothing typed, so Cancel is the last stop.
		const cancel = buttonNamed(dialog, 'Cancel');
		cancel.focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(password);
		expect(tab(true)).toBe(true);
		expect(document.activeElement).toBe(cancel);
		// From the page behind, Tab comes back into the dialog.
		opener.focus();
		expect(tab()).toBe(true);
		expect(document.activeElement).toBe(password);

		escape();
		expect([...target.querySelectorAll('h2')].map((heading) => heading.textContent)).not.toContain('🔑 Reset Password');
		await settle();
		expect(document.activeElement).toBe(opener);
		expect(sent.filter((request) => request.what.startsWith('PUT '))).toEqual([]);
	});

	// Card 2886 (plan section 5, case 2; D3): Enter in the code field did nothing on either row.
	it('moves the focus on to the new password with Enter in the code field, and in the password once a code is typed, on both rows, sending nothing', async () => {
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
		const enter = (box: HTMLInputElement) => {
			box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			flushSync();
		};
		for (const [row, heading] of [[0, '🔑 Change Your Password'], [1, '🔑 Reset Password']] as const) {
			target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[row].click();
			await settle();
			const dialog = target.querySelector<HTMLElement>('[role="dialog"]')!;
			expect(dialog.querySelector('h2')?.textContent, heading).toBe(heading);
			const password = dialog.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
			const code = codeFieldIn(dialog)!;
			const newPassword = dialog.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!;

			type(password, MINE);
			enter(password);
			expect(document.activeElement, heading).toBe(code);
			typeCode(dialog);
			enter(code);
			expect(document.activeElement, heading).toBe(newPassword);
			password.focus();
			enter(password);
			expect(document.activeElement, heading).toBe(newPassword);

			buttonNamed(dialog, 'Cancel').click();
			await settle();
		}
		expect(sent.filter((request) => request.what.startsWith('PUT '))).toEqual([]);
	});
});

describe('every dialog with a password field of its own waits for the sign-in code too (card 2770, T5)', () => {
	/** What `draw` drew, taken away, for the next dialog to be drawn. */
	function undraw() {
		if (!drawn) return;
		unmount(drawn.component);
		drawn.target.remove();
		drawn = null;
		flushSync();
	}

	const peopleData = { people: [], groups: [], accounts: [{ id: 9, username: 'pat', email: 'pat@example.test', emoji: '🙂', personId: null }] };

	/** Each dialog opened as a person opens it, every field but the password and the code filled: where it is, and its sending button. */
	const dialogs: Array<[string, () => Promise<{ within: ParentNode; button: () => HTMLButtonElement }>]> = [
		[
			'Add from accounts',
			async () => {
				const target = draw(FromAccountsDialog, { data: peopleData, onClose: vi.fn() });
				target.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
				flushSync();
				return { within: target, button: () => target.querySelectorAll<HTMLButtonElement>('.modal-actions button')[1] };
			}
		],
		[
			'Person',
			async () => {
				const target = draw(PersonDialog, { data: peopleData, person: null, onClose: vi.fn() });
				const boxIn = (label: string) =>
					[...target.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent!.trim().startsWith(label))!.querySelector('input')!;
				type(boxIn('Full name'), 'Ann Lee');
				type(boxIn('Email'), 'ann.lee@example.test');
				return { within: target, button: () => buttonNamed(target, 'Add Person') };
			}
		],
		[
			'Add User',
			async () => {
				const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
				buttonNamed(target, '+ Add User').click();
				flushSync();
				type(target.querySelector<HTMLInputElement>('input[placeholder="Username"]')!, 'carol');
				type(target.querySelector<HTMLInputElement>('input[placeholder="Email"]')!, 'carol@example.com');
				return { within: target, button: () => buttonNamed(target, 'Create') };
			}
		],
		[
			'🔑 for another account',
			async () => {
				const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
				target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[1].click();
				await settle();
				type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
				return { within: target, button: () => buttonNamed(target, 'Reset Password') };
			}
		],
		[
			'Drive Connect',
			async () => {
				const target = draw(ScheduledBackupsPanel, { confirm: confirmedAtOnce() });
				await settle();
				buttonNamed(target, '🔗 Connect').click();
				await settle();
				type(target.querySelector<HTMLInputElement>('input[placeholder="Paste the whole address, starting http://localhost/?state=…"]')!, 'http://localhost/?state=s1&code=c1');
				return { within: target, button: () => buttonNamed(target, '✅ Connect') };
			}
		],
		[
			'Import Database',
			async () => {
				const target = draw(BackupRestorePanel, { importOutsideDefault: 'keep' });
				const box = target.querySelector<HTMLInputElement>('.hidden-input')!;
				const file = new File([new Uint8Array([83, 81, 76])], 'backup.db');
				Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([83, 81, 76]).buffer });
				Object.defineProperty(box, 'files', { value: [file], configurable: true });
				box.dispatchEvent(new Event('change', { bubbles: true }));
				await settle();
				const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
				return { within: dialog, button: () => buttonNamed(dialog, 'Confirm') };
			}
		]
	];

	it('keeps each one’s button off with the password typed and no code, and turns it on once both are typed', async () => {
		for (const [name, open] of dialogs) {
			const { within, button } = await open();
			type(within.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, MINE);
			expect(button().disabled, name).toBe(true);
			// The code review's SR3: Enter in the code field, blank or spaces only, gets round no button.
			const before = sent.length;
			for (const blank of ['', '   ']) {
				const code = codeFieldIn(within)!;
				type(code, blank);
				code.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
				await settle();
				expect(sent.slice(before), `${name}, code ${JSON.stringify(blank)}`).toEqual([]);
			}
			typeCode(within);
			expect(button().disabled, name).toBe(false);
			undraw();
		}
		expect(sent.filter((request) => request.what !== 'GET /api/admin/backup' && !request.what.startsWith('GET /api/admin/backup/gdrive/auth'))).toEqual([]);
	});

	// Card 2771 (plan section 5.1, T16; D9, E9): a refusal decided before the password was compared keeps it typed.
	it('T16. keeps the password typed and empties the code in each, 🔑 on both rows among them, when the send is answered code-spent', async () => {
		const ownRow: [string, () => Promise<{ within: ParentNode; button: () => HTMLButtonElement }>] = [
			'🔑 on your own row',
			async () => {
				const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: vi.fn(), loadMailStatus: vi.fn(), inviteLink: null });
				target.querySelectorAll<HTMLButtonElement>('button[title="Reset password"]')[0].click();
				await settle();
				type(target.querySelector<HTMLInputElement>('input[placeholder="New password (min 8 chars)"]')!, 'a-new-password');
				return { within: target, button: () => buttonNamed(target, 'Change Password') };
			}
		];
		// Every send of a proof answered as the step-up answers a step already used; reads as before.
		answer = (what) => (what.startsWith('GET ') ? undefined : Response.json({ message: STEP_UP_CODE_SPENT, stepUp: 'code-spent' }, { status: 400 }));
		for (const [name, open] of [...dialogs, ownRow]) {
			const { within, button } = await open();
			const password = within.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
			type(password, MINE);
			typeCode(within);
			const before = sent.length;
			button().click();
			await settle();

			const proofs = sent.slice(before).filter((request) => !request.what.startsWith('GET '));
			expect(proofs.map((request) => (request.body as { currentPassword?: unknown }).currentPassword), name).toEqual([MINE]);
			expect(within.querySelector('[role="alert"]')?.textContent, name).toBe(STEP_UP_CODE_SPENT);
			expect(password.value, name).toBe(MINE);
			expect(codeFieldIn(within)!.value, name).toBe('');
			undraw();
		}
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
		// Card 2701: each Change asks for the caller's password through the page's confirm, confirmed here at once.
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm: confirmedAtOnce(), loadMailStatus: vi.fn(), inviteLink: null });
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
		expect(asked('PUT /api/users/2').map((request) => request.body)).toEqual([{ role: 'admin', currentPassword: MINE, currentCode: CODE }]);
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
		// Bob disabled, so that the panel can delete him (card 2671); his role is still chosen and changed.
		const live = withBobDisabled(pageData);
		const { target, props } = drawLive(live);
		choose(rolePicker(target)!, 'admin');
		props.data = { ...live, users: [live.users[0]] };
		flushSync();
		props.data = live;
		flushSync();
		expect(rolePicker(target)!.value).toBe('user');
		expect(changeButton(target).getAttribute('aria-disabled')).toBe('true');

		choose(rolePicker(target)!, 'admin');
		props.data = { ...live, users: [live.users[0], { ...live.users[1], role: 'admin' }] };
		flushSync();
		props.data = live;
		flushSync();
		expect(rolePicker(target)!.value).toBe('user');
		expect(changeButton(target).getAttribute('aria-disabled')).toBe('true');

		// Deleted here, and the same id read again with no re-read between (the stand-in's invalidateAll reads nothing).
		answer = (what) => (what === 'DELETE /api/users/2' ? Response.json({ success: true }) : undefined);
		choose(rolePicker(target)!, 'admin');
		const confirm = props.confirm as unknown as ReturnType<typeof vi.fn>;
		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('DELETE /api/users/2')).toHaveLength(1);
		props.data = { ...live };
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
		// What they may do to bob's account is still there: since card 2671, Disable, and Delete only once he is disabled.
		expect(bobsRow.querySelector('button[title="Reset password"]')).not.toBeNull();
		expect(bobsRow.querySelector('button[title="Disable user"]')).not.toBeNull();
		expect(bobsRow.querySelector('button[title="Delete user"]')).toBeNull();
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

	/** A button of the panel pressed; Save SMTP asks for the caller's password first (card 2701), typed and confirmed here. */
	function press(target: HTMLElement, name: string) {
		buttonNamed(target, name).click();
		flushSync();
		if (name !== 'Save SMTP') return;
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('h3')?.textContent).toBe('Save SMTP Settings');
		// Nothing is sent until it is confirmed.
		expect(asked('PUT /api/admin/smtp')).toEqual([]);
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(dialog);
		buttonNamed(dialog, 'Save').click();
	}

	it('asks Save SMTP for the caller’s password and sends it with the settings; a refusal of it stays in the dialog, and not below the panel (card 2701)', async () => {
		let refuse = true;
		answer = (what) =>
			what === 'PUT /api/admin/smtp'
				? refuse
					? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
					: Response.json({ success: true })
				: answered(what);
		const target = draw(SmtpPanel, { currentUser: chief });
		await settle();

		press(target, 'Save SMTP');
		await settle();
		expect(asked('PUT /api/admin/smtp').map((request) => request.body)).toEqual([
			{ host: 'smtp.example.com', port: 587, allowInsecure: false, user: 'mailer', pass: '••••••••', fromAddress: 'kanban@example.com', fromName: 'DumpFire', currentPassword: MINE, currentCode: CODE }
		]);
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		expect(target.querySelector('.smtp-msg.smtp-error')).toBeNull();
		expect(buttonNamed(target, 'Save SMTP').disabled).toBe(false);

		refuse = false;
		type(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, MINE);
		typeCode(dialog);
		buttonNamed(dialog, 'Save').click();
		await settle();
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(target.querySelector('.smtp-success')?.textContent).toBe('SMTP settings saved!');
	});

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

		press(target, button);
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

		press(target, 'Save SMTP');
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
		// Card 2701: it asks for the caller's password, which the reset sends.
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();

		expect(asked('POST /api/admin/reset').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
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
		users: [...asSuperadmin.users, { ...admin, apiKeys: null, webhooks: null, reportSchedules: null }],
		twoStepSwitch: { ...asSuperadmin.twoStepSwitch, keysWithoutFactorListed: null, mayRequire: false }
	};
	const mailReads = () => asked('GET /api/admin/smtp').length;
	const headings = (target: HTMLElement) => [...target.querySelectorAll('h2')].map((heading) => heading.textContent);
	const inviteButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('button[title="Resend invite email"]')!;
	/**
	 * The page's confirm, the caller's password typed in it and Confirm pressed
	 * (card 2701): 📧, Delete and Reset Everything ask for it, in the dialog the
	 * page draws, with the focus in the field.
	 */
	const confirmWithPassword = () => {
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(document.activeElement).toBe(field);
		type(field, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
	};

	it('reads the mail panel again through the page once 📧 is answered, for the superadmin', async () => {
		answer = (what) => (what === 'POST /api/users/2/invite' ? Response.json({ mailSent: true, message: 'Invite sent to bob@example.com' }) : undefined);
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();
		expect(headings(target)).toContain('📧 Email / SMTP');
		// The App URL panel's read and the mail panel's.
		expect(mailReads()).toBe(2);

		inviteButton(target).click();
		confirmWithPassword();
		await settle();

		expect(asked('POST /api/users/2/invite').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		// The page's confirm closes once the invite is answered with no refusal.
		expect(document.querySelector('.confirm-modal')).toBeNull();
		// The users panel's loadMailStatus is the mail panel's, reached by the page through bind:this.
		expect(mailReads()).toBe(3);
	});

	// Card 2701 (D6): the page's confirm closed before the action ran, so a refusal had nowhere to be said.
	it('keeps its confirm open on a refusal of the password, saying it there with the field cleared and focused, and closes it once the action is done', async () => {
		let refuse = true;
		answer = (what) =>
			what === 'POST /api/admin/purge-archived'
				? refuse
					? Response.json({ message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }, { status: 403 })
					: Response.json({ success: true, purged: 3 })
				: undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();

		buttonNamed(target, 'Purge All').click();
		confirmWithPassword();
		await settle();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog).not.toBeNull();
		expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Password is incorrect. Nothing was changed.');
		const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
		expect(field.value).toBe('');
		expect(document.activeElement).toBe(field);
		expect(navigation.invalidateAll).not.toHaveBeenCalled();

		refuse = false;
		type(field, MINE);
		typeCode(document);
		buttonNamed(dialog, 'Confirm').click();
		await settle();
		expect(asked('POST /api/admin/purge-archived').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }, { currentPassword: MINE, currentCode: CODE }]);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('asks no password where the action asks none: Vacuum confirms with no field, and closes', async () => {
		answer = (what) => (what === 'POST /api/admin/vacuum' ? Response.json({ success: true }) : undefined);
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();

		buttonNamed(target, 'Vacuum').click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		expect(dialog.querySelector('input[type="password"]')).toBeNull();
		buttonNamed(dialog, 'Confirm').click();
		await settle();
		expect(asked('POST /api/admin/vacuum')).toHaveLength(1);
		expect(document.querySelector('.confirm-modal')).toBeNull();
	});

	it('opens the invite link’s dialog from the users panel through the page, and Done clears it there too', async () => {
		answer = (what) =>
			what === 'POST /api/users/2/invite'
				? Response.json({ mailSent: false, message: 'The invite mail could not be sent.', inviteUrl: 'http://localhost/invite/t2' })
				: undefined;
		const target = draw(AdminPage, { data: asSuperadmin });
		await settle();

		inviteButton(target).click();
		confirmWithPassword();
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
		confirmWithPassword();
		await settle();

		expect(asked('POST /api/admin/reset').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
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
		confirmWithPassword();
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
		type(target.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!, MINE);
		typeCode(target);
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
		// Card 2701: through the page's confirm, which asks for the password.
		confirmWithPassword();
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
		confirmWithPassword();
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
		confirmWithPassword();
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
		confirmWithPassword();
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
		// Bob disabled: only a disabled account is offered 🗑️ (card 2671).
		const target = draw(AdminPage, { data: withBobDisabled(asSuperadmin) });
		await settle();
		expect(mailReads()).toBe(2);
		expect(asked('GET /api/admin/backup')).toHaveLength(1);

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		await settle();
		confirmWithPassword();
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

// ─── Card 2922: the settings held for review ─────────────────────────────────

describe('the settings held for review on the admin pages, mounted (card 2922, case 35)', () => {
	const ann = { id: 3, username: 'ann', email: 'ann@example.com', emoji: '🛠️', role: 'admin' };
	/** Ann's row as the superadmin's admin load gives it: she set the mail settings and destination "Offsite". */
	const annSet = { mail: true, appUrl: false, destinations: ['Offsite'] };
	const withAnn = {
		...pageData,
		users: [...pageData.users, { ...ann, apiKeys: 0, webhooks: 0, webhooksAlreadyOff: 0, webhooksReadable: 0, reportSchedules: 0, twoStep: false, settingsSet: annSet }]
	};
	// Said before the action, so in the future (the code review's C11); the invite's holds only once it is used.
	const HELD_WORDS =
		" What they set (the mail settings, the backup destination \"Offsite\") will be held for the superadmin's review: nothing will be sent to it until it is kept or removed under Settings held for review.";
	// The invite's (B3): mail or the App URL the account set refuses the invite until a two-step reset holds them (C15).
	const INVITE_REFUSED =
		" This account set the mail settings in force, so the invite will be refused until the account's two-step sign-in is reset, which holds them for the superadmin's review.";
	// Destinations alone are held when the invite is used.
	const HELD_WHEN_USED =
		" What they set (the backup destination \"Offsite\") will be held for the superadmin's review when the invite is used: nothing will be sent to it until it is kept or removed under Settings held for review.";
	const MAIL_HELD = {
		setting: 'mail',
		kind: 'mail',
		name: null,
		place: 'p'.repeat(64),
		heldAt: '2026-11-19 09:00:00',
		setBy: 3,
		setByName: 'ann',
		where: { host: 'smtp.evil.example', port: 587, user: '', allowInsecure: false }
	};

	it('says in the two-step reset’s and the invite’s confirms what the account set, which is held, and nothing where it set none', () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: withAnn, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		const rowOf = (name: string) => [...target.querySelectorAll('.user-row')].find((row) => row.querySelector('.user-row-name')!.textContent === name)!;

		rowOf('ann').querySelector<HTMLButtonElement>('button[title="Reset two-step sign-in"]')!.click();
		rowOf('ann').querySelector<HTMLButtonElement>('button.invite-resend')!.click();
		rowOf('bob').querySelector<HTMLButtonElement>('button[title="Reset two-step sign-in"]')!.click();

		const messages = confirm.mock.calls.map((call) => call[1] as string);
		expect(messages).toHaveLength(3);
		expect(messages[0]).toContain(`${HELD_WORDS} ${ASKS_FOR_PASSWORD}`);
		expect(messages[1]).toContain(`${INVITE_REFUSED} ${ASKS_FOR_PASSWORD}`);
		expect(messages[1]).not.toContain('when the invite is used');
		expect(messages[2]).not.toContain('held for the superadmin');
	});

	it('says in the invite’s confirm that backup destinations alone are held when the invite is used (B3)', () => {
		const confirm = vi.fn();
		const destinationsOnly = {
			...withAnn,
			users: withAnn.users.map((user) => (user.id === ann.id ? { ...user, settingsSet: { mail: false, appUrl: false, destinations: ['Offsite'] } } : user))
		};
		const target = draw(UsersPanel, { data: destinationsOnly, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });
		const row = [...target.querySelectorAll('.user-row')].find((r) => r.querySelector('.user-row-name')!.textContent === 'ann')!;

		row.querySelector<HTMLButtonElement>('button.invite-resend')!.click();

		expect(confirm.mock.calls[0][1]).toContain(`${HELD_WHEN_USED} ${ASKS_FOR_PASSWORD}`);
		expect(confirm.mock.calls[0][1]).not.toContain('will be refused');
	});

	it('says in the password dialog, once read again, what the account set, which the reset holds', async () => {
		const target = draw(ResetPasswordDialog, { data: withAnn });
		await (drawn!.component as unknown as { openResetDialog: (userId: number) => Promise<void> }).openResetDialog(ann.id);
		flushSync();

		expect(target.querySelector('.settings-held')!.textContent).toBe(HELD_WORDS.trim());
	});

	it('lists what is held, offers Keep and Remove to the superadmin alone, and sends Keep with the place reviewed and the password', async () => {
		answer = (what) =>
			what === 'GET /api/admin/settings/held'
				? Response.json({ held: [MAIL_HELD], tombstones: 0, mayRelease: true })
				: what === 'POST /api/admin/settings/held'
					? Response.json({ success: true, kept: 'mail' })
					: undefined;
		const confirm = vi.fn();
		const target = draw(SettingsHeldPanel, { confirm });
		await settle();

		expect(target.querySelector('.held-item')!.textContent).toContain('The mail settings: mail server smtp.evil.example, port 587');
		// What was mailed through it before the hold still works (C14).
		expect(target.querySelector('.held-urgent')!.textContent!.trim()).toBe(
			'Links already mailed through these mail settings stay usable until they are removed, so decide quickly.'
		);
		// Each button names its setting to a screen reader (C11).
		expect(buttonNamed(target, 'Keep').getAttribute('aria-label')).toBe('Keep the mail settings');
		expect(buttonNamed(target, 'Remove').getAttribute('aria-label')).toBe('Remove the mail settings');
		buttonNamed(target, 'Keep').click();
		expect(confirm.mock.calls[0][1]).toContain('Keep the mail settings in use as they are now: mail server smtp.evil.example, port 587.');
		expect(confirm.mock.calls[0][3]).toEqual({ askPassword: true });
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('POST /api/admin/settings/held').map((request) => request.body)).toEqual([
			{ setting: 'mail', place: MAIL_HELD.place, action: 'keep', currentPassword: MINE, currentCode: CODE }
		]);
		// Remove says, before it is pressed, every mailed link it ends (C2, C3).
		buttonNamed(target, 'Remove').click();
		expect(confirm.mock.calls[1][1]).toContain(
			'Remove the mail settings (mail server smtp.evil.example, port 587). Every invite not yet used, two-step set-up link, request link and ' +
				'decision link on the server will end too'
		);

		unmount(drawn!.component);
		drawn!.target.remove();
		answer = (what) => (what === 'GET /api/admin/settings/held' ? Response.json({ held: [MAIL_HELD], tombstones: 0, mayRelease: false }) : undefined);
		const asAdmin = draw(SettingsHeldPanel, { confirm: vi.fn() });
		await settle();
		expect(asAdmin.querySelector('.held-item')).not.toBeNull();
		expect(buttonNamed(asAdmin, 'Keep')).toBeUndefined();
		expect(buttonNamed(asAdmin, 'Remove')).toBeUndefined();
	});

	it('words each hold by why it was held: an unsealed restore names no setter, and says the list came in with that backup (card 3009’s code review, FP4)', async () => {
		const RESTORED = { ...MAIL_HELD, setBy: null, setByName: null, heldBecause: 'restored from a backup whose seal did not verify' };
		answer = (what) => (what === 'GET /api/admin/settings/held' ? Response.json({ held: [RESTORED], tombstones: 0, mayRelease: true }) : undefined);
		const target = draw(SettingsHeldPanel, { confirm: vi.fn() });
		await settle();

		const said = target.querySelector('.settings-held')!.textContent!.replace(/\s+/g, ' ');
		expect(said).toContain("Each of these came in with a backup whose seal did not verify, so where it sends is only the file's word. Nothing is sent to it until you keep it or remove it.");
		expect(target.querySelector('.held-meta')!.textContent!.trim()).toBe('From a backup whose seal did not verify; held since 2026-11-19 09:00:00 UTC');
		expect(said).not.toMatch(/Set by|user unknown|access was ended/);

		unmount(drawn!.component);
		drawn!.target.remove();
		// Both reasons at once: the list says both, and each item its own.
		answer = (what) =>
			what === 'GET /api/admin/settings/held'
				? Response.json({ held: [RESTORED, { ...MAIL_HELD, setting: 'app_url', kind: 'app_url', where: { url: 'https://x.example.test' } }], tombstones: 0, mayRelease: true })
				: undefined;
		const mixed = draw(SettingsHeldPanel, { confirm: vi.fn() });
		await settle();
		expect(mixed.querySelector('.settings-held')!.textContent!.replace(/\s+/g, ' ')).toContain(
			'Each of these was set by an account whose access was ended with its API keys, or came in with a backup whose seal did not verify.'
		);
		expect([...mixed.querySelectorAll('.held-meta:not(.held-urgent)')].map((meta) => meta.textContent!.trim().split(';')[0])).toEqual([
			'From a backup whose seal did not verify',
			'Set by ann'
		]);
	});

	it('shows the superadmin a banner while a setting is held, and nothing to an administrator or with none held', () => {
		// In its own number (C11): the mail settings are, a destination is.
		const shown = draw(SettingsHeldBanner, { held: [{ kind: 'mail', name: null }], superadmin: true });
		const said = (within: HTMLElement) => within.querySelector('.settings-held-banner')!.textContent!.replace(/\s+/g, ' ');
		expect(said(shown)).toContain('The mail settings are held for your review: nothing is sent to them until you keep or remove them. Review them');
		unmount(drawn!.component);
		drawn!.target.remove();
		const one = draw(SettingsHeldBanner, { held: [{ kind: 'destination', name: 'Offsite' }], superadmin: true });
		expect(said(one)).toContain('Backup destination "Offsite" is held for your review: nothing is sent to it until you keep or remove it. Review it');
		unmount(drawn!.component);
		drawn!.target.remove();

		expect(draw(SettingsHeldBanner, { held: [{ kind: 'mail', name: null }], superadmin: false }).querySelector('.settings-held-banner')).toBeNull();
		unmount(drawn!.component);
		drawn!.target.remove();
		expect(draw(SettingsHeldBanner, { held: [], superadmin: true }).querySelector('.settings-held-banner')).toBeNull();
	});
});

// ─── Card 3064, S4: the Two-step sign-in panel (U3, U5) ──────────────────────
// What the page's load gives the panel is tests/two-step-switch.test.ts (U3, U5 there): the server's modules load a
// WebAssembly build through `fetch` under this file's browser environment, which the network guard refuses.

describe('the Two-step sign-in panel, mounted (card 3064, S4)', () => {
	type SwitchView = (typeof pageData)['twoStepSwitch'];
	/** The text of `target`, its spaces collapsed. */
	const textOf = (target: Element) => target.textContent!.replace(/\s+/g, ' ').trim();
	const requireButton = (target: HTMLElement) => buttonNamed(target, 'Require two-step sign-in');
	/** Takes the panel drawn away, for the next to be drawn. */
	const undraw = () => {
		unmount(drawn!.component);
		drawn!.target.remove();
		drawn = null;
	};
	/** The key of an account with no factor, as the load lists it to the superadmin. */
	const KEY = { id: 4, createdAt: '2026-11-20 08:30:00', lastUsedAt: null, holder: 'plain', holderId: 5 };
	/** Dormant, as the load gives it to the superadmin: an administrator without a factor, and one key. */
	const dormant: SwitchView = {
		required: false,
		requiredAt: null,
		accountsWithoutFactor: 2,
		passwordOnlySessions: 1,
		administratorsWithoutFactor: [{ id: 3, username: 'ada' }],
		keysWithoutFactor: 1,
		keysWithoutFactorListed: [KEY],
		mayRequire: true
	};

	it('U3. shows "not required", the counts, and the button to the superadmin alone; once required, says so with no button', () => {
		const forChief = draw(TwoStepSwitchPanel, { twoStepSwitch: dormant, confirm: vi.fn() });
		expect(textOf(forChief)).toContain(
			'Two-step sign-in is not required on this server. Accounts that have set up an authenticator app are asked for its code; the others sign in with their password alone.'
		);
		expect([...forChief.querySelectorAll('.switch-counts li')].map(textOf)).toEqual([
			'2 enabled accounts have not set up two-step sign-in.',
			'1 session is signed in on a password alone: requiring two-step sign-in ends them.'
		]);
		expect(requireButton(forChief)).toBeDefined();
		undraw();

		// An administrator who is not the superadmin: the state and the counts, and no button.
		const forAda = draw(TwoStepSwitchPanel, { twoStepSwitch: { ...dormant, accountsWithoutFactor: 1, keysWithoutFactorListed: null, mayRequire: false }, confirm: vi.fn() });
		expect(textOf(forAda)).toContain('Two-step sign-in is not required on this server.');
		expect([...forAda.querySelectorAll('.switch-counts li')].map(textOf)[0]).toBe('1 enabled account has not set up two-step sign-in.');
		expect(requireButton(forAda)).toBeUndefined();
		expect(textOf(forAda)).toContain("Requiring two-step sign-in is the superadmin's.");
		undraw();

		// Required: the state and its moment, and no button, counts or lists for anyone.
		const required = { ...dormant, required: true, requiredAt: '2026-12-01 09:00:00' };
		const forRequired = draw(TwoStepSwitchPanel, { twoStepSwitch: required, confirm: vi.fn() });
		expect(textOf(forRequired)).toBe(
			'🛡️ Two-step sign-in Two-step sign-in is required on this server, since 2026-12-01 09:00 UTC. Every account signs in with its password and a code from an authenticator app. It cannot be turned off here.'
		);
		expect(requireButton(forRequired)).toBeUndefined();
	});

	it('U5. lists every administrator without a factor, the button off while any is, saying why; the keys by holder to the superadmin, counted for any other; with none listed, the button asks with the password and a code and sends both', async () => {
		const confirm = vi.fn();
		const target = draw(TwoStepSwitchPanel, { twoStepSwitch: dormant, confirm });
		expect([...target.querySelectorAll('.switch-admins li')].map(textOf)).toEqual(['ada (user 3)']);
		expect(textOf(target)).toContain('1 API key was made by accounts that have not set up two-step sign-in.');
		expect([...target.querySelectorAll('.switch-keys li')].map(textOf)).toEqual(['A key of plain (user 5): made 2026-11-20 08:30 UTC, never used']);
		// Off while an administrator is listed, saying why, tied to it.
		const button = requireButton(target);
		expect(button.disabled).toBe(true);
		const reason = target.querySelector<HTMLElement>(`[id="${button.getAttribute('aria-describedby')}"]`);
		expect(reason?.textContent).toBe('Each administrator listed above must set up two-step sign-in first.');
		button.click();
		expect(confirm).not.toHaveBeenCalled();
		undraw();

		// An administrator who is not the superadmin is told how many keys, never their names.
		const forAda = draw(TwoStepSwitchPanel, { twoStepSwitch: { ...dormant, keysWithoutFactorListed: null, mayRequire: false }, confirm: vi.fn() });
		expect(textOf(forAda)).toContain('1 API key was made by accounts that have not set up two-step sign-in.');
		expect(textOf(forAda)).not.toContain('A key of plain');
		expect(forAda.querySelector('.switch-keys')).toBeNull();
		undraw();

		// Every administrator with a factor: none listed, and the button asks with the password and a code, and sends both.
		const again = draw(TwoStepSwitchPanel, {
			twoStepSwitch: { ...dormant, administratorsWithoutFactor: [], keysWithoutFactor: 0, keysWithoutFactorListed: [] },
			confirm
		});
		expect(textOf(again)).toContain('Every administrator has set up two-step sign-in.');
		expect(textOf(again)).toContain('API keys of accounts without two-step sign-in None.');
		expect(requireButton(again).disabled).toBe(false);
		expect(requireButton(again).hasAttribute('aria-describedby')).toBe(false);
		requireButton(again).click();
		expect(confirm.mock.calls.map((call) => [call[0], call[3]])).toEqual([['Require two-step sign-in', { askPassword: true }]]);
		expect(confirm.mock.calls[0][1]).toBe(
			'Require two-step sign-in on this server? From now on every account signs in with its password and a code from an authenticator app. ' +
				'The 1 session signed in on a password alone is ended now, and everyone else, you included, signs in again at their next visit. ' +
				`Accounts that have not set it up are taken through setting it up when they next sign in. This cannot be turned off here. ${ASKS_FOR_PASSWORD}`
		);
		answer = (what) => (what === 'POST /api/admin/two-step/require' ? Response.json({ success: true, sessionsEnded: 1, accountsMarked: 1 }) : undefined);
		await confirm.mock.calls[0][2](proofOf(MINE));
		await settle();
		expect(asked('POST /api/admin/two-step/require').map((request) => request.body)).toEqual([{ currentPassword: MINE, currentCode: CODE }]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('CR-L8. a refusal that is not of the password or the code is said in a toast and reads the panel again; one of the password goes back to the dialog and reads nothing', async () => {
		const confirm = vi.fn();
		draw(TwoStepSwitchPanel, { twoStepSwitch: { ...dormant, administratorsWithoutFactor: [], keysWithoutFactor: 0, keysWithoutFactorListed: [] }, confirm });
		requireButton(drawn!.target).click();
		const send = confirm.mock.calls[0][2] as (proof: unknown) => Promise<string | void>;

		answer = (what) => (what === 'POST /api/admin/two-step/require' ? Response.json({ message: 'Two-step sign-in is already required on this server.' }, { status: 409 }) : undefined);
		expect(await send(proofOf(MINE))).toBeUndefined();
		await settle();
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);

		navigation.invalidateAll.mockClear();
		answer = (what) => (what === 'POST /api/admin/two-step/require' ? Response.json({ message: STEP_UP_WRONG, stepUp: 'wrong' }, { status: 400 }) : undefined);
		expect(await send(proofOf(MINE))).toBe(STEP_UP_WRONG);
		await settle();
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});
});

// ─── Card 3064, S4b: what a confirmation asks, said by the layout's codeAsked (F25) ─

describe("the panels say what a confirmation asks by the layout's codeAsked (card 3064, S4b)", () => {
	it('F25 the danger zone: the password alone where codeAsked is false, beside its buttons and in its confirms; the words with a code otherwise', () => {
		for (const [data, asked] of [
			[{ codeAsked: false }, false],
			[{ codeAsked: true }, true],
			[{}, true]
		] as const) {
			pageStub.data = data;
			const confirm = vi.fn();
			const target = draw(DangerZonePanel, { isSuperadmin: true, confirm, resetNotice: null });
			const said = JSON.stringify(data);

			expect(target.textContent, said).toContain(purgeDescription(asked));
			expect(target.textContent!.includes('a code from your authenticator app'), said).toBe(asked);
			buttonNamed(target, 'Purge All').click();
			buttonNamed(target, 'Reset Everything').click();
			expect(confirm.mock.calls.map((call) => call[1]), said).toEqual([purgeWarning(asked), resetWarning(asked)]);
			expect(resetWarning(asked).endsWith(asked ? 'You will be asked for your password and a code from your authenticator app.' : 'You will be asked for your password.'), said).toBe(true);
			unmount(drawn!.component);
			drawn!.target.remove();
			drawn = null;
		}
	});

	it("F25 the password dialog on the caller's own account: the current password and a new one where codeAsked is false; the code named between them otherwise", async () => {
		for (const [data, words] of [
			[{ codeAsked: false }, 'This is your own account. Enter your current password and a new one.'],
			[{}, 'This is your own account. Enter your current password, a code from your authenticator app, and a new one.']
		] as const) {
			pageStub.data = data;
			const target = draw(ResetPasswordDialog, { data: pageData });
			await (drawn!.component as unknown as { openResetDialog: (userId: number) => Promise<void> }).openResetDialog(1);
			flushSync();

			expect(target.querySelector('.modal-content p')!.textContent, JSON.stringify(data)).toBe(`${words} Your other sessions will be signed out. Your report schedules are paused.`);
			unmount(drawn!.component);
			drawn!.target.remove();
			drawn = null;
		}
	});
});
