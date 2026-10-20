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
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import AppUrlPanel from '$lib/components/admin/AppUrlPanel.svelte';
import ScheduledBackupsPanel from '$lib/components/admin/ScheduledBackupsPanel.svelte';

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

beforeEach(() => {
	sent = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? 'GET';
			sent.push({ what: `${method} ${url}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
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

function draw(component: typeof ScheduledBackupsPanel | typeof AppUrlPanel, props: Record<string, unknown> = {}) {
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
