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
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';
import UsersPanel from '$lib/components/admin/UsersPanel.svelte';
import ResetPasswordDialog from '$lib/components/admin/ResetPasswordDialog.svelte';
import TeamsPanel from '$lib/components/admin/TeamsPanel.svelte';
import SmtpPanel from '$lib/components/admin/SmtpPanel.svelte';
import DangerZonePanel from '$lib/components/admin/DangerZonePanel.svelte';

import AdminPage from '../src/routes/admin/+page.svelte';

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

/** An answer of the test's own for a request, ahead of the ones below; undefined for those. */
let answer: ((what: string) => Response | undefined) | null = null;

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
			if (url === '/api/admin/smtp') return Response.json({ appUrl: 'https://kanban.example.com' });
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
});

describe('the App URL panel, mounted', () => {
	it('reads the App URL once as it opens, and shows it', async () => {
		const target = draw(AppUrlPanel);
		await settle();

		expect(sent.map((request) => request.what)).toEqual(['GET /api/admin/smtp']);
		expect(target.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe('https://kanban.example.com');
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
			message: 'User carol was made, but the invite mail could not be sent: no mail server.'
		});
		expect(loadMailStatus).toHaveBeenCalledTimes(1);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
	});

	it('asks the page’s confirm before a delete, whose action sends it', async () => {
		const confirm = vi.fn();
		const target = draw(UsersPanel, { data: pageData, isSuperadmin: true, confirm, loadMailStatus: vi.fn(), inviteLink: null });

		target.querySelector<HTMLButtonElement>('button[title="Delete user"]')!.click();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toBe('Delete User');
		await confirm.mock.calls[0][2]();
		await settle();

		expect(asked('DELETE /api/users/2')).toHaveLength(1);
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

	it('shows an administrator who is not the superadmin no mail panel and no Reset Everything, and reads no mail settings', async () => {
		const target = draw(AdminPage, { data: asAdministrator });
		await settle();

		expect(headings(target)).not.toContain('📧 Email / SMTP');
		expect(target.textContent).not.toContain('Reset Everything');
		expect(headings(target)).toContain("🔒 The superadmin's");
		expect(headings(target)).toContain('👥 User Management');
		expect(mailReads()).toBe(0);
		expect(asked('GET /api/admin/backup')).toHaveLength(0);
	});
});
