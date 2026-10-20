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
