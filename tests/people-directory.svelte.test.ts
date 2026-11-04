// @vitest-environment jsdom
/**
 * The people directory's dialog, in the page (card 2697, slice B2b: the plan's
 * case 61). `PersonDialog` is mounted alone with Svelte's client runtime, as
 * the decision files mount their components, `fetch` a stand-in that keeps
 * every request sent and answers what the case gives it.
 *
 * A change of a person's address or account decides where a decision's record
 * mail and personal links go, so the server asks for the caller's own
 * password with it (Q21): the dialog sends `email` and `userId` only when they
 * change, and with them `currentPassword`, from a field it shows only then. A
 * rename sends neither and asks nothing. A refusal of the password keeps the
 * dialog open, its words shown and the field cleared.
 *
 * The code review's part B (S1): adding a person, Add from accounts and the
 * page's Delete each ask for the password every time, and send it.
 *
 * What the server answers is in `tests/step-up.test.ts` (case 60). The plan
 * is `docs/planning/card-2676-decision-authoring.md`, section 6 part B.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	goto: async () => {},
	invalidateAll: navigation.invalidateAll,
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
// A bare 'svelte' gives the server's runtime, whose tick and onDestroy the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import PersonDialog from '$lib/components/admin/people/PersonDialog.svelte';
import FromAccountsDialog from '$lib/components/admin/people/FromAccountsDialog.svelte';
import PeoplePage from '../src/routes/admin/people/+page.svelte';
import { STEP_UP_WRONG } from '$lib/step-up-words';

// The browser's `mount`, loaded by its path (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** Each request sent, as `METHOD url`, with its body read as JSON. */
let sent: { what: string; body: Record<string, unknown> }[] = [];
/** What the next request to each `METHOD url` is answered; anything else is `{}`. */
let answers: Record<string, { status: number; body: unknown }[]> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	sent = [];
	answers = {};
	navigation.invalidateAll.mockClear();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const what = `${init?.method ?? 'GET'} ${url}`;
			sent.push({ what, body: typeof init?.body === 'string' ? JSON.parse(init.body) : {} });
			const next = answers[what]?.shift();
			return next ? json(next.body, next.status) : json({});
		})
	);
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const person = {
	id: 5,
	fullName: 'Pat Doe',
	email: 'pat.doe@example.test',
	jobTitle: 'Analyst',
	userId: null,
	status: 'active',
	leftAt: null,
	createdAt: '2026-11-01 09:00:00',
	updatedAt: '2026-11-01 09:00:00',
	groupIds: [],
	account: null
};
const data = {
	people: [person],
	groups: [],
	accounts: [{ id: 9, username: 'pat', email: 'pat@example.test', emoji: '🙂', personId: null }]
};

/** The dialog on Pat, and what it calls once closed. */
function drawDialog() {
	const onClose = vi.fn();
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(PersonDialog as never, { target, props: { data, person, onClose } as never }), target });
	flushSync();
	return { target, onClose };
}

/** The field labelled `label`, its value set as typed. */
function type(target: HTMLElement, label: string, value: string) {
	const field = [...target.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent!.trim().startsWith(label))!.querySelector('input')!;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}
const passwordField = (target: HTMLElement) => target.querySelector<HTMLInputElement>('input[type="password"]');
function typePassword(target: HTMLElement, value: string) {
	const field = passwordField(target)!;
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}
const saveButton = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Save')!;

describe('PersonDialog (61)', () => {
	it('sends a rename alone with no password field, and no email, userId or currentPassword', async () => {
		const { target, onClose } = drawDialog();

		type(target, 'Full name', 'Pat Renamed');
		expect(passwordField(target)).toBeNull();
		saveButton(target).click();
		await settle();

		expect(sent).toEqual([{ what: 'PUT /api/people/5', body: { fullName: 'Pat Renamed', jobTitle: 'Analyst', groupIds: [] } }]);
		expect(onClose).toHaveBeenCalled();
	});

	it('shows the password field for a changed address, and sends email and currentPassword', async () => {
		const { target } = drawDialog();

		type(target, 'Email', 'Pat.Moved@Example.Test');
		expect(passwordField(target)).not.toBeNull();
		expect(saveButton(target).disabled).toBe(true);
		typePassword(target, 'my password');
		saveButton(target).click();
		await settle();

		expect(sent).toEqual([
			{
				what: 'PUT /api/people/5',
				body: { fullName: 'Pat Doe', email: 'Pat.Moved@Example.Test', jobTitle: 'Analyst', groupIds: [], currentPassword: 'my password' }
			}
		]);
	});

	it('shows the password field for a changed account, and sends userId and currentPassword', async () => {
		const { target } = drawDialog();

		const select = target.querySelector<HTMLSelectElement>('select')!;
		select.value = '9';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(passwordField(target)).not.toBeNull();
		typePassword(target, 'my password');
		saveButton(target).click();
		await settle();

		expect(sent).toEqual([{ what: 'PUT /api/people/5', body: { fullName: 'Pat Doe', jobTitle: 'Analyst', userId: 9, groupIds: [], currentPassword: 'my password' } }]);
	});

	it('keeps the dialog open on a refused password, its words shown and the field cleared', async () => {
		const { target, onClose } = drawDialog();
		(answers['PUT /api/people/5'] ??= []).push({ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } });

		type(target, 'Email', 'pat.moved@example.test');
		typePassword(target, 'a wrong one');
		saveButton(target).click();
		await settle();

		expect(onClose).not.toHaveBeenCalled();
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
		expect(passwordField(target)!.value).toBe('');
		expect(target.querySelector('[role="alert"]')!.textContent!.trim()).toBe(STEP_UP_WRONG);
	});

	// Card 2697's code review, part B (S1): a new person is always given an address, so adding one asks.
	it('asks for the password to add a person, Add Person off until it is typed, and sends it with every field', async () => {
		const onClose = vi.fn();
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn.push({ component: mount(PersonDialog as never, { target, props: { data, person: null, onClose } as never }), target });
		flushSync();
		const add = () => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent!.trim() === 'Add Person')!;

		type(target, 'Full name', 'Ann Lee');
		type(target, 'Email', 'ann.lee@example.test');
		expect(passwordField(target)).not.toBeNull();
		expect(add().disabled).toBe(true);
		typePassword(target, 'my password');
		add().click();
		await settle();

		expect(sent).toEqual([
			{
				what: 'POST /api/people',
				body: { fullName: 'Ann Lee', email: 'ann.lee@example.test', jobTitle: '', userId: null, groupIds: [], currentPassword: 'my password' }
			}
		]);
		expect(onClose).toHaveBeenCalled();
	});
});

describe('FromAccountsDialog (S1)', () => {
	it('asks for the password, Add off until it is typed, sends { userIds, currentPassword }, and keeps the dialog open on a refused one', async () => {
		const onClose = vi.fn();
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn.push({ component: mount(FromAccountsDialog as never, { target, props: { data, onClose } as never }), target });
		flushSync();
		const add = () => [...target.querySelectorAll<HTMLButtonElement>('.modal-actions button')][1];
		(answers['POST /api/people/from-accounts'] ??= []).push(
			{ status: 403, body: { message: STEP_UP_WRONG, stepUp: 'wrong' } },
			{ status: 200, body: { created: 1, skipped: [] } }
		);

		const tick = target.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		tick.click();
		flushSync();
		expect(add().disabled).toBe(true);
		typePassword(target, 'a wrong one');
		add().click();
		await settle();
		expect(sent).toEqual([{ what: 'POST /api/people/from-accounts', body: { userIds: [9], currentPassword: 'a wrong one' } }]);
		expect(onClose).not.toHaveBeenCalled();
		expect(passwordField(target)!.value).toBe('');
		expect(target.querySelector('[role="alert"]')!.textContent!.trim()).toBe(STEP_UP_WRONG);

		typePassword(target, 'my password');
		add().click();
		await settle();
		expect(sent.at(-1)).toEqual({ what: 'POST /api/people/from-accounts', body: { userIds: [9], currentPassword: 'my password' } });
		expect(onClose).toHaveBeenCalled();
	});
});

describe('the People page (S1)', () => {
	it("deletes a person through a confirmation that asks for the password, and sends { currentPassword }", async () => {
		const target = document.createElement('div');
		document.body.appendChild(target);
		drawn.push({ component: mount(PeoplePage as never, { target, props: { data: { ...data, user: null } } as never }), target });
		flushSync();
		(answers['DELETE /api/people/5'] ??= []).push({ status: 200, body: { success: true, linksCleared: 0 } });

		target.querySelector<HTMLButtonElement>('button[aria-label="Delete Pat Doe"]')!.click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('.confirm-modal')!;
		const confirm = dialog.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[1];
		expect(confirm.disabled).toBe(true);
		typePassword(dialog, 'my password');
		confirm.click();
		await settle();

		expect(sent).toEqual([{ what: 'DELETE /api/people/5', body: { currentPassword: 'my password' } }]);
		expect(document.querySelector('.confirm-modal')).toBeNull();
		expect(navigation.invalidateAll).toHaveBeenCalled();
	});
});
