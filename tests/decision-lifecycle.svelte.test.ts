// @vitest-environment jsdom
/**
 * Previewing, a dry run, opening and the lifecycle controls, in the page
 * (card 2697). Slice B2a: the editor's delivery panel (the plan's case 42).
 * Slice B2b: the administrator's account and address actions in it, each
 * asking for the password (case 43). Slice B3: the preview page (case 45).
 * Slice B4: the lifecycle controls, `DecisionActions` (cases 51 to 54), and
 * the editor's dirty signal and closing-time help text. The code review's
 * part B (2026-11-04): the server's offers alone drawn (F2), the editor
 * following the server after a lifecycle write (F1), Withdraw and Delete on a
 * page gone stale (S4), and the focus and status region (F6).
 * Each component is mounted alone with Svelte's client runtime, as the
 * decision editor's file mounts them, `fetch` a stand-in that keeps every
 * request sent, with its headers, and answers what the case gives it.
 *
 *   - `DeliveryPanel`: each participant's latest mail and how it went, their
 *     latest skip and their link's latest ending, in the server's words;
 *     Resend only where the server says it would send, the moment it may
 *     where the rest holds them back, and the write's words otherwise; Resend
 *     sent saying it is JSON, with no body, and a refusal said in the
 *     server's words.
 *
 * What the server answers, and to whom, is in `tests/decision-lifecycle.test.ts`.
 * The plan is `docs/planning/card-2676-decision-authoring.md`, section 6 part B.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';

const navigation = vi.hoisted(() => ({ goto: vi.fn(async () => {}), invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	goto: navigation.goto,
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

import DeliveryPanel from '$lib/components/decision/DeliveryPanel.svelte';
import DecisionActions from '$lib/components/decision/DecisionActions.svelte';
import DecisionEditor from '$lib/components/decision/DecisionEditor.svelte';
import PreviewPage from '../src/routes/decisions/[id]/preview/+page.svelte';
import { STEP_UP_MISSING } from '$lib/step-up-words';
import { CODE, codeFieldIn } from './helpers/step-up-code';

// The browser's `mount`, loaded by its path (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** Each request sent, as `METHOD url`, with its headers and its body as sent. */
let sent: { what: string; headers: Record<string, string>; body: unknown }[] = [];
/** What the next request to each `METHOD url` is answered; anything else is `{}`. */
let answers: Record<string, { status: number; body: unknown }[]> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	sent = [];
	answers = {};
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const what = `${init?.method ?? 'GET'} ${url}`;
			sent.push({ what, headers: { ...(init?.headers as Record<string, string> | undefined) }, body: init?.body });
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

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const rowOf = (within: ParentNode, participantId: number) => within.querySelector<HTMLElement>(`[data-participant="${participantId}"]`)!;
const lineOf = (row: HTMLElement, line: string) => row.querySelector(`[data-line="${line}"]`);
const resendIn = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b) === 'Resend');

const participants = [
	{ id: 1, name: 'Sent Ok', role: 'consulted', removedAt: null },
	{ id: 2, name: 'Fail Ed', role: 'informed', removedAt: null },
	{ id: 3, name: 'Just Mailed', role: 'consulted', removedAt: null },
	{ id: 4, name: 'Lef Tearly', role: 'consulted', removedAt: null }
];
const none = { lastMail: null, lastSkip: null, lastRevoked: null, reachNow: null, resendFrom: null, refusal: null };
const delivery = [
	{
		...none,
		participantId: 1,
		lastMail: { mail: 'invitation', at: '2026-11-03 09:00:00', resend: false, outcome: 'sent', problem: null },
		resendable: true
	},
	{
		...none,
		participantId: 2,
		lastMail: { mail: 'told_of_change', at: '2026-11-03 10:00:00', resend: false, outcome: 'failed', problem: 'the mail server did not accept the message' },
		lastRevoked: { at: '2026-11-03 08:00:00', words: 'Their link was ended by a restore from a backup: Resend sends them a new one' },
		resendable: true
	},
	{
		...none,
		participantId: 3,
		lastMail: { mail: 'invitation', at: '2026-11-03 11:00:00', resend: true, outcome: 'pending', problem: null },
		resendable: false,
		resendFrom: '2026-11-03 11:10:00',
		refusal: 'Just Mailed was mailed about this decision less than 10 minutes ago: they can be mailed again from 2026-11-03 11:10:00 UTC'
	},
	{
		...none,
		participantId: 4,
		lastSkip: { mail: 'asked_again', at: '2026-11-03 12:00:00', words: 'Lef Tearly has left: they cannot be mailed about this decision' },
		reachNow: 'Lef Tearly has left: they cannot be mailed about this decision',
		resendable: false,
		refusal: 'Lef Tearly has left: they cannot be mailed about this decision'
	}
];

describe('DeliveryPanel (42)', () => {
	it("shows each row's outcome, skip and link ending in the server's words, and Resend only where it would send", () => {
		const panel = draw(DeliveryPanel, { decisionId: 7, participants, delivery, onSaved: () => {} });

		expect(textOf(lineOf(rowOf(panel, 1), 'mail')!)).toBe('Invitation, 2026-11-03 09:00 UTC: sent');
		expect(textOf(lineOf(rowOf(panel, 2), 'mail')!)).toBe('Told of a change, 2026-11-03 10:00 UTC: not sent: the mail server did not accept the message');
		expect(textOf(lineOf(rowOf(panel, 2), 'revoked')!)).toBe('Their link was ended by a restore from a backup: Resend sends them a new one, 2026-11-03 08:00 UTC');
		expect(textOf(lineOf(rowOf(panel, 3), 'mail')!)).toBe('Invitation, sent again, 2026-11-03 11:00 UTC: being sent');
		expect(textOf(lineOf(rowOf(panel, 4), 'mail')!)).toBe('Not mailed yet');
		expect(textOf(lineOf(rowOf(panel, 4), 'skip')!)).toBe('Asked again not sent, 2026-11-03 12:00 UTC: Lef Tearly has left: they cannot be mailed about this decision');

		expect(resendIn(rowOf(panel, 1))).toBeDefined();
		expect(resendIn(rowOf(panel, 2))).toBeDefined();
		expect(resendIn(rowOf(panel, 3))).toBeUndefined();
		expect(textOf(lineOf(rowOf(panel, 3), 'from')!)).toBe('Resend from 2026-11-03 11:10 UTC');
		expect(resendIn(rowOf(panel, 4))).toBeUndefined();
		expect(textOf(lineOf(rowOf(panel, 4), 'refusal')!)).toBe('Lef Tearly has left: they cannot be mailed about this decision');
		// Nothing of an address is drawn.
		expect(panel.textContent).not.toContain('@');
	});

	it("sends Resend saying it is JSON, with no body, hands the next revision up, and says a 409 in the server's words", async () => {
		const onSaved = vi.fn(async () => {});
		const panel = draw(DeliveryPanel, { decisionId: 7, participants, delivery, onSaved });
		(answers['POST /api/decisions/7/participants/1/resend'] ??= []).push({ status: 200, body: { participant: { id: 1 }, revision: 'next' } });
		(answers['POST /api/decisions/7/participants/2/resend'] ??= []).push({
			status: 409,
			body: { message: 'Fail Ed was mailed about this decision less than 10 minutes ago: they can be mailed again from 2026-11-03 10:10:00 UTC' }
		});

		resendIn(rowOf(panel, 1))!.click();
		await settle();
		expect(sent).toEqual([{ what: 'POST /api/decisions/7/participants/1/resend', headers: { 'Content-Type': 'application/json' }, body: undefined }]);
		expect(onSaved).toHaveBeenCalledWith('next');

		resendIn(rowOf(panel, 2))!.click();
		await settle();
		expect(sent.at(-1)).toEqual({ what: 'POST /api/decisions/7/participants/2/resend', headers: { 'Content-Type': 'application/json' }, body: undefined });
		expect(onSaved).toHaveBeenCalledTimes(1);
		expect(textOf(rowOf(panel, 2).querySelector('[role="alert"]')!)).toBe(
			'Fail Ed was mailed about this decision less than 10 minutes ago: they can be mailed again from 2026-11-03 10:10:00 UTC'
		);
		expect(rowOf(panel, 1).querySelector('[role="alert"]')).toBeNull();
	});

	// The code review's part B (F6): the page's data read again, the rest now holds them, and the button goes.
	it('hands the focus to the row, which says from when, once its Resend button has gone', async () => {
		const props = $state({ decisionId: 7, participants, delivery: delivery as Record<string, unknown>[], onSaved: async () => {} });
		props.onSaved = async () => {
			props.delivery = delivery.map((row) =>
				row.participantId === 1 ? { ...row, resendable: false, resendFrom: '2026-11-03 09:10:00', refusal: 'Sent Ok was mailed less than 10 minutes ago' } : row
			);
		};
		const panel = draw(DeliveryPanel, props);
		(answers['POST /api/decisions/7/participants/1/resend'] ??= []).push({ status: 200, body: { participant: { id: 1 }, revision: 'next' } });

		const button = resendIn(rowOf(panel, 1))!;
		button.focus();
		button.click();
		await settle();

		expect(resendIn(rowOf(panel, 1))).toBeUndefined();
		expect(document.activeElement).toBe(rowOf(panel, 1));
		expect(textOf(lineOf(rowOf(panel, 1), 'from')!)).toBe('Resend from 2026-11-03 09:10 UTC');
	});
});

// ─── B3: the preview page (case 45) ─────────────────────────────────────────

describe('the preview page (45)', () => {
	const content = {
		situation: 'Money is short.',
		question: 'Which budget?',
		ask: 'Pick one.',
		unknowns: '',
		alreadyRuled: '',
		technicalDetail: '',
		stories: [],
		agentDrafted: {},
		reviewed: {}
	};
	const option = (optionId: number, label: string, title: string) => ({ optionId, label, title, summary: '', pros: [], cons: [], commercial: '', agentDrafted: false });
	/** What `readPreview` gives, as `previewing` and the participant's role say. */
	const dataOf = (previewing: Record<string, unknown>, role: 'consulted' | 'informed') => ({
		decision: { id: 7, boardId: 3, boardName: 'The board', title: 'Pick a budget', shownStatus: 'open', voteMode: 'single', closesAt: '2099-01-01 12:00:00', deciderName: 'decider' },
		content,
		options: [option(1, 'A', 'Lean'), option(2, 'B', 'Full')],
		audiences: [{ heading: 'For Finance', body: 'Finance text.', own: true, open: true }],
		participant: { role },
		previewing,
		participants: [
			{ id: 11, name: 'Pat Doe', role: 'consulted', groups: ['Finance'] },
			{ id: 12, name: 'Lin Holder', role: 'informed', groups: [] }
		],
		groups: [{ id: 5, name: 'Finance' }]
	});
	const asPat = dataOf({ kind: 'participant', participantId: 11, name: 'Pat Doe', role: 'consulted', groupNames: ['Finance'] }, 'consulted');
	const asLin = dataOf({ kind: 'participant', participantId: 12, name: 'Lin Holder', role: 'informed', groupNames: [] }, 'informed');

	beforeEach(() => navigation.goto.mockClear());

	it('(a) draws DecisionView in preview mode, the banner, and for a consulted participant a form that is off and sends nothing', async () => {
		const page = draw(PreviewPage, { data: asPat });

		expect(page.querySelector('.decision-view')!.getAttribute('data-mode')).toBe('preview');
		expect(textOf(page.querySelector('[data-banner="preview"]')!)).toBe('Preview: this is what Pat Doe will see. Nothing is recorded.');
		const form = page.querySelector<HTMLFormElement>('.response-form')!;
		expect(form.getAttribute('data-disabled')).toBe('yes');
		const send = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
		expect(send.disabled).toBe(true);
		form.querySelector<HTMLInputElement>('input')?.click();
		form.requestSubmit();
		await settle();
		expect(sent).toEqual([]);
	});

	it('(b) draws no form for an informed participant', () => {
		const page = draw(PreviewPage, { data: asLin });

		expect(textOf(page.querySelector('[data-banner="preview"]')!)).toBe('Preview: this is what Lin Holder will see. Nothing is recorded.');
		expect(page.querySelector('.response-form')).toBeNull();
	});

	it('(c) fetches nothing on a pointer press or a key press, as no seen watch is armed, and the select reads the page again with ?as=', async () => {
		const page = draw(PreviewPage, { data: asPat });

		page.querySelector('.decision-view')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
		await settle();
		expect(sent).toEqual([]);

		const select = page.querySelector<HTMLSelectElement>('[data-select="participant"]')!;
		select.value = '12';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(navigation.goto).toHaveBeenCalledWith('/decisions/7/preview?as=12', { keepFocus: true });
		expect(sent).toEqual([]);
	});
});

// ─── B2b: the administrator's actions (case 43) ─────────────────────────────

describe("DeliveryPanel's administrator's actions (43)", () => {
	/** The rows as an administrator is given them: each participant's snapshot address and account besides. */
	const asAdmin = [
		{ id: 1, name: 'Sent Ok', role: 'consulted', removedAt: null, email: 'sent.ok@example.test', userId: null },
		{ id: 2, name: 'Fail Ed', role: 'informed', removedAt: null, email: 'fail.ed.old@example.test', userId: 31 }
	];
	/**
	 * What the server offers (the code review's part B, F2): Sent Ok's person has
	 * an account the row has not; Fail Ed's row holds an account, and the
	 * directory a new address.
	 */
	const directory = [
		{ participantId: 1, canAttach: true, canClear: false, canUseDirectoryAddress: false, directoryAddress: null },
		{ participantId: 2, canAttach: false, canClear: true, canUseDirectoryAddress: true, directoryAddress: 'fail.ed.new@example.test' }
	];
	const twoRows = delivery.slice(0, 2);

	const buttonsOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLButtonElement>('[data-actions="admin"] button')].map((b) => textOf(b));
	const press = (row: HTMLElement, label: string) => [...row.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b) === label)!.click();
	const dialog = () => document.querySelector<HTMLElement>('.confirm-modal');
	const passwordField = () => dialog()!.querySelector<HTMLInputElement>('input[type="password"]')!;
	/** Types `CODE` into the code field beside the password within `within` (card 2770). */
	function typeCode(within: ParentNode) {
		const field = codeFieldIn(within)!;
		field.value = CODE;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}
	function confirmWith(password: string) {
		const field = passwordField();
		field.value = password;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		typeCode(dialog()!);
		dialog()!.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[1].click();
	}

	it('are shown to an administrator alone, as the directory offers each', () => {
		const panel = draw(DeliveryPanel, { decisionId: 7, participants, delivery: twoRows, onSaved: () => {} });
		expect(panel.querySelector('[data-actions="admin"]')).toBeNull();

		const admin = draw(DeliveryPanel, { decisionId: 7, participants: asAdmin, delivery: twoRows, directory, onSaved: () => {} });
		expect(buttonsOf(rowOf(admin, 1))).toEqual(['Attach account']);
		expect(buttonsOf(rowOf(admin, 2))).toEqual(['Clear account', "Use the directory's address"]);
	});

	// F2: the panel offers what the server says, and works out none of it: a row holding no account, whose account was deleted, is offered Clear account.
	it("offers exactly what the server's facts say, whatever the row holds", () => {
		const removedAccount = [{ id: 1, name: 'Sent Ok', role: 'consulted', removedAt: null, email: 'sent.ok@example.test', userId: null }];
		const facts = [{ participantId: 1, canAttach: false, canClear: true, canUseDirectoryAddress: false, directoryAddress: null }];
		const admin = draw(DeliveryPanel, { decisionId: 7, participants: removedAccount, delivery: delivery.slice(0, 1), directory: facts, onSaved: () => {} });
		expect(buttonsOf(rowOf(admin, 1))).toEqual(['Clear account']);
	});

	it("sends each through a confirmation asking for the password: the account with { account, currentPassword }, the address with { currentPassword } alone, naming it", async () => {
		const onSaved = vi.fn(async () => {});
		const panel = draw(DeliveryPanel, { decisionId: 7, participants: asAdmin, delivery: twoRows, directory, onSaved });
		for (const route of ['1/account', '2/account', '2/address']) {
			(answers[`PUT /api/decisions/7/participants/${route}`] ??= []).push({ status: 200, body: { participant: {}, revision: `after ${route}` } });
		}

		press(rowOf(panel, 1), 'Attach account');
		flushSync();
		expect(passwordField()).not.toBeNull();
		confirmWith('my password');
		await settle();
		expect(sent.at(-1)).toEqual({
			what: 'PUT /api/decisions/7/participants/1/account',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ account: 'person', currentPassword: 'my password', currentCode: CODE })
		});
		expect(dialog()).toBeNull();

		press(rowOf(panel, 2), 'Clear account');
		flushSync();
		confirmWith('my password');
		await settle();
		expect(sent.at(-1)).toEqual({
			what: 'PUT /api/decisions/7/participants/2/account',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ account: 'none', currentPassword: 'my password', currentCode: CODE })
		});

		press(rowOf(panel, 2), "Use the directory's address");
		flushSync();
		expect(textOf(dialog()!.querySelector('.confirm-message')!)).toContain('fail.ed.new@example.test');
		confirmWith('my password');
		await settle();
		expect(sent.at(-1)).toEqual({
			what: 'PUT /api/decisions/7/participants/2/address',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ currentPassword: 'my password', currentCode: CODE })
		});
		expect(onSaved.mock.calls).toEqual([['after 1/account'], ['after 2/account'], ['after 2/address']]);
	});

	it('keeps the dialog open on a refused password, its words shown and the field cleared', async () => {
		const onSaved = vi.fn(async () => {});
		const panel = draw(DeliveryPanel, { decisionId: 7, participants: asAdmin, delivery: twoRows, directory, onSaved });
		(answers['PUT /api/decisions/7/participants/2/address'] ??= []).push({
			status: 403,
			body: { message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' }
		});

		press(rowOf(panel, 2), "Use the directory's address");
		flushSync();
		confirmWith('a wrong one');
		await settle();

		expect(dialog()).not.toBeNull();
		expect(passwordField().value).toBe('');
		expect(textOf(dialog()!.querySelector('[role="alert"]')!)).toBe('Password is incorrect. Nothing was changed.');
		expect(onSaved).not.toHaveBeenCalled();
	});
});

// ─── B4: the lifecycle controls (cases 51 to 54) ────────────────────────────

describe('DecisionActions (51 to 54)', () => {
	const NONE = {
		open: false,
		republish: false,
		close: false,
		extend: false,
		withdraw: false,
		delete: false,
		dryRun: false,
		resend: false,
		participantAccount: false,
		participantAddress: false,
		withdrawAsks: false,
		deleteAsks: false
	};
	const JSON_TYPE = { 'Content-Type': 'application/json' };
	/** A working copy as the editor is handed it. */
	const workingCopy = {
		situation: 'Money is short.',
		question: 'Which budget?',
		ask: 'Pick one.',
		options: [],
		audiences: [],
		stories: [],
		unknowns: '',
		alreadyRuled: '',
		technicalDetail: '',
		agentDrafted: {},
		reviewed: {}
	};

	function drawActions(more: Record<string, unknown> = {}, actions: Partial<typeof NONE> = {}) {
		const onSaved = vi.fn(async () => {});
		const target = draw(DecisionActions, {
			decisionId: 7,
			boardId: 3,
			title: 'Pick a budget',
			closesAt: '2099-01-01 12:00:00',
			revision: 'rev-1',
			actions: { ...NONE, ...actions },
			republishSummary: null,
			refusals: [],
			warnings: [],
			mailCount: 2,
			dirty: false,
			onSaved,
			...more
		});
		return { target, onSaved };
	}

	const control = (target: HTMLElement, action: string) => target.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
	const dialog = () => document.querySelector<HTMLElement>('.confirm-modal');
	const confirmButton = () => dialog()!.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[1];
	const passwordIn = () => dialog()!.querySelector<HTMLInputElement>('input[type="password"]');
	function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
		field.value = value;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}
	/** Types `CODE` into the code field beside the password within `within` (card 2770). */
	const typeCode = (within: ParentNode) => typeInto(codeFieldIn(within)!, CODE);
	const submit = (target: HTMLElement, panel: string) => {
		target.querySelector<HTMLFormElement>(`[data-panel="${panel}"]`)!.requestSubmit();
		flushSync();
	};
	const answer = (what: string, status: number, body: unknown) => (answers[what] ??= []).push({ status, body });

	beforeEach(() => navigation.goto.mockClear());

	describe('Open (51)', () => {
		it('is off while the server gives a refusal, which it lists', () => {
			const { target } = drawActions({ refusals: [{ code: 'no_options', words: 'Give it at least two options' }] }, { open: true });

			expect(control(target, 'open')!.disabled).toBe(true);
			expect(textOf(target.querySelector('[data-note="refusals"]')!)).toBe('It cannot be opened yet: Give it at least two options');
		});

		it('with two warnings confirms "Open with 2 warnings", then sends { revision } saying it is JSON', async () => {
			const warnings = [
				{ code: 'empty_section', key: 'unknowns', words: 'What is not yet known is empty' },
				{ code: 'empty_section', key: 'alreadyRuled', words: 'Already settled is empty' }
			];
			const { target, onSaved } = drawActions({ warnings }, { open: true });
			answer('POST /api/decisions/7/open', 200, { decision: {}, revision: 'rev-2' });

			control(target, 'open')!.click();
			flushSync();
			expect(textOf(confirmButton())).toBe('Open with 2 warnings');
			// Card 2682 (D32): the confirmation says how many people are mailed, before the warnings.
			expect(textOf(dialog()!.querySelector('.confirm-message')!)).toContain('Every participant of "Pick a budget" is mailed now: 2 people.');
			expect(textOf(dialog()!.querySelector('.confirm-message')!)).toContain('What is not yet known is empty; Already settled is empty');
			confirmButton().click();
			await settle();

			expect(sent).toEqual([{ what: 'POST /api/decisions/7/open', headers: JSON_TYPE, body: JSON.stringify({ revision: 'rev-1' }) }]);
			expect(onSaved).toHaveBeenCalledWith('rev-2');
			expect(dialog()).toBeNull();
		});

		it('says "1 person" where the saved set holds one live participant (card 2682, D32)', () => {
			const { target } = drawActions({ mailCount: 1 }, { open: true });

			control(target, 'open')!.click();
			flushSync();
			expect(textOf(dialog()!.querySelector('.confirm-message')!)).toBe('Every participant of "Pick a budget" is mailed now: 1 person.');
		});

		it('is off, with Re-publish and the dry run, while the editor holds edits not yet saved; the editor says when it does', () => {
			const { target } = drawActions({ dirty: true }, { open: true, republish: true, dryRun: true });
			for (const action of ['open', 'republish', 'dryRun']) {
				expect(control(target, action)!.disabled, action).toBe(true);
				expect(control(target, action)!.title, action).toBe('Save your changes first');
			}
			expect(textOf(target.querySelector('[data-note="dirty"]')!)).toContain('Save your changes first');

			// The editor reports it: once as it is drawn, and again on the first edit.
			const onDirtyChange = vi.fn();
			const editor = draw(DecisionEditor, {
				decision: {
					id: 7,
					title: 'Pick a budget',
					status: 'draft',
					shownStatus: 'draft',
					voteMode: 'single',
					closesAt: '2099-01-01 12:00:00',
					deciderUserId: 1,
					deciderName: 'author',
					content: workingCopy
				},
				options: [],
				participants: [],
				groups: [],
				revision: 'rev-1',
				readiness: { refusals: [], warnings: [] },
				editable: true,
				canSetDecider: false,
				canReview: false,
				productOwnerUserId: null,
				deciderCandidates: [],
				callerId: 1,
				onSaved: () => {},
				onReload: () => {},
				onDirtyChange
			});
			expect(onDirtyChange.mock.calls).toEqual([[false]]);
			const label = [...editor.querySelectorAll('label')].find((l) => textOf(l) === 'Question')!;
			typeInto(document.getElementById(label.getAttribute('for')!) as HTMLInputElement, 'Which budget, now?');
			expect(onDirtyChange.mock.calls).toEqual([[false], [true]]);
		});
	});

	describe('Re-publish (52)', () => {
		it('needs a change note, and sends { changeNote, askAgain, revision }', async () => {
			const { target, onSaved } = drawActions({ republishSummary: { changesOptions: false, adding: [], retiring: [] } }, { republish: true });
			answer('POST /api/decisions/7/republish', 200, { decision: {}, revision: 'rev-2' });

			control(target, 'republish')!.click();
			flushSync();
			const panel = target.querySelector<HTMLElement>('[data-panel="republish"]')!;
			const send = panel.querySelector<HTMLButtonElement>('button[type="submit"]')!;
			expect(send.disabled).toBe(true);
			typeInto(panel.querySelector('textarea')!, 'The dates moved.');
			expect(send.disabled).toBe(false);
			const tellOnly = panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
			expect(tellOnly.disabled).toBe(false);
			tellOnly.click();
			flushSync();
			submit(target, 'republish');
			await settle();

			expect(sent).toEqual([
				{ what: 'POST /api/decisions/7/republish', headers: JSON_TYPE, body: JSON.stringify({ changeNote: 'The dates moved.', askAgain: false, revision: 'rev-1' }) }
			]);
			expect(onSaved).toHaveBeenCalledWith('rev-2');
		});

		it('holds Tell them only off, with its reason, where the working copy adds or retires an option', () => {
			const { target } = drawActions({ republishSummary: { changesOptions: true, adding: ['C'], retiring: ['A'] } }, { republish: true });

			control(target, 'republish')!.click();
			flushSync();
			const panel = target.querySelector<HTMLElement>('[data-panel="republish"]')!;
			const [askAgain, tellOnly] = panel.querySelectorAll<HTMLInputElement>('input[type="radio"]');
			expect(tellOnly.disabled).toBe(true);
			expect(askAgain.checked).toBe(true);
			expect(textOf(panel.querySelector('[data-note="tell-only"]')!)).toBe(
				'Tell them only is off: this version adds option C and retires option A, so everyone consulted is asked again; people kept informed are told.'
			);
		});

		it('says who each choice asks, tells or invites: the informed are told, never asked (card 2739, 2739-5)', () => {
			const { target } = drawActions({ republishSummary: { changesOptions: false, adding: [], retiring: [] } }, { republish: true });

			control(target, 'republish')!.click();
			flushSync();
			const panel = target.querySelector<HTMLElement>('[data-panel="republish"]')!;
			const who = () => textOf(panel.querySelector('[data-note="republish-who"]')!);
			expect(textOf(panel.querySelector('label')!)).toBe('What changed (participants are told it)');
			expect(who()).toBe(
				"Everyone consulted is asked for their view again; anyone consulted whom this round's ask has not reached is sent the invitation instead. Everyone informed is told of the change."
			);
			panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click();
			flushSync();
			expect(who()).toBe(
				"Everyone consulted whom this round's ask reached, and everyone informed, is told of the change. Anyone consulted whom this round's ask has not reached is sent nothing: Resend asks them while the decision is open for input."
			);
		});
	});

	describe('Close, Extend, Withdraw and Delete (53)', () => {
		it('Extend on a decision shown not open for input says the reopening asks whoever was not asked yet; shown open, it does not (card 2744, 2744-9)', () => {
			const asks = 'Anyone consulted who has not yet been asked for their view is sent the invitation now, as the mail limits allow.';
			const confirmWords = (shownStatus: string | undefined) => {
				const { target } = drawActions(shownStatus === undefined ? {} : { shownStatus }, { extend: true });
				control(target, 'extend')!.click();
				flushSync();
				typeInto(target.querySelector<HTMLInputElement>('[data-panel="extend"] input')!, '2027-06-01T09:30');
				submit(target, 'extend');
				const words = textOf(dialog()!);
				dialog()!.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[0].click();
				flushSync();
				target.remove();
				return words;
			};
			expect(confirmWords('awaiting_ruling')).toContain(`"Pick a budget" closes at 2027-06-01 09:30 UTC, and is open for input until then. ${asks}`);
			expect(confirmWords('open')).not.toContain(asks);
			expect(confirmWords(undefined)).not.toContain(asks);
		});

		it('Extend, offered where it alone is allowed: the field read and sent as typed, in UTC, its help saying at most a year ahead, as the editor says too', async () => {
			const { target } = drawActions({}, { extend: true });
			expect([...target.querySelectorAll('[data-action]')].map((el) => el.getAttribute('data-action'))).toEqual(['preview', 'extend']);
			answer('POST /api/decisions/7/extend', 200, { decision: {}, revision: 'rev-2' });

			control(target, 'extend')!.click();
			flushSync();
			const field = target.querySelector<HTMLInputElement>('[data-panel="extend"] input')!;
			expect(field.value).toBe('2099-01-01T12:00');
			expect(textOf(target.querySelector('[data-help="extend"]')!)).toBe('At most a year ahead (365 days), in UTC.');
			typeInto(field, '2027-06-01T09:30');
			submit(target, 'extend');
			confirmButton().click();
			await settle();

			expect(sent).toEqual([{ what: 'POST /api/decisions/7/extend', headers: JSON_TYPE, body: JSON.stringify({ closesAt: '2027-06-01T09:30' }) }]);

			const editor = draw(DecisionEditor, {
				decision: {
					id: 7,
					title: 'Pick a budget',
					status: 'draft',
					shownStatus: 'draft',
					voteMode: 'single',
					closesAt: null,
					deciderUserId: null,
					deciderName: null,
					content: workingCopy
				},
				options: [],
				participants: [],
				groups: [],
				revision: 'rev-1',
				readiness: { refusals: [], warnings: [] },
				editable: true,
				canSetDecider: false,
				canReview: false,
				productOwnerUserId: null,
				deciderCandidates: [],
				callerId: 1,
				onSaved: () => {},
				onReload: () => {}
			});
			expect(textOf(editor.querySelector('[data-help="closes"]')!)).toBe('At most a year ahead (365 days), in UTC.');
		});

		it('Withdraw needs a reason; once opened it asks for the password and sends { reason, currentPassword }, on a draft { reason } alone', async () => {
			const opened = drawActions({}, { withdraw: true, withdrawAsks: true });
			answer('POST /api/decisions/7/withdraw', 200, { decision: {}, revision: 'rev-2' });
			control(opened.target, 'withdraw')!.click();
			flushSync();
			const withdrawIn = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-panel="withdraw"]')!;
			expect(withdrawIn(opened.target).querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
			typeInto(withdrawIn(opened.target).querySelector('textarea')!, 'No longer needed.');
			submit(opened.target, 'withdraw');
			expect(passwordIn()).not.toBeNull();
			typeInto(passwordIn()!, 'my password');
			typeCode(dialog()!);
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({
				what: 'POST /api/decisions/7/withdraw',
				headers: JSON_TYPE,
				body: JSON.stringify({ reason: 'No longer needed.', currentPassword: 'my password', currentCode: CODE })
			});
			expect(opened.onSaved).toHaveBeenCalledWith('rev-2');

			const draft = drawActions({}, { withdraw: true, withdrawAsks: false });
			control(draft.target, 'withdraw')!.click();
			flushSync();
			typeInto(withdrawIn(draft.target).querySelector('textarea')!, 'Not needed.');
			submit(draft.target, 'withdraw');
			expect(passwordIn()).toBeNull();
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({ what: 'POST /api/decisions/7/withdraw', headers: JSON_TYPE, body: JSON.stringify({ reason: 'Not needed.' }) });
		});

		it('Delete of a draft never opened asks no password and sends {}; of one once opened it asks and sends { currentPassword }; then goes to the board\'s decisions', async () => {
			const draft = drawActions({}, { delete: true, deleteAsks: false });
			answer('DELETE /api/decisions/7', 200, { success: true });
			control(draft.target, 'delete')!.click();
			flushSync();
			expect(passwordIn()).toBeNull();
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({ what: 'DELETE /api/decisions/7', headers: JSON_TYPE, body: '{}' });
			expect(navigation.goto).toHaveBeenCalledWith('/board/3/decisions');

			const once = drawActions({}, { delete: true, deleteAsks: true });
			answer('DELETE /api/decisions/7', 403, { message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' });
			control(once.target, 'delete')!.click();
			flushSync();
			typeInto(passwordIn()!, 'a wrong one');
			typeCode(dialog()!);
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({ what: 'DELETE /api/decisions/7', headers: JSON_TYPE, body: JSON.stringify({ currentPassword: 'a wrong one', currentCode: CODE }) });
			// A refused password keeps the dialog open, the field cleared, the words in it.
			expect(dialog()).not.toBeNull();
			expect(passwordIn()!.value).toBe('');
			expect(textOf(dialog()!.querySelector('[role="alert"]')!)).toBe('Password is incorrect. Nothing was changed.');
			expect(navigation.goto).toHaveBeenCalledTimes(1);
		});

		// The code review's part B (S4): the page drawn before the decision was opened elsewhere says no password is asked.
		it('Withdraw and Delete on a page gone stale: the server asks for the password, the dialog shows the field, and what is typed is sent', async () => {
			const MISSING = { message: STEP_UP_MISSING, stepUp: 'missing' };
			const withdrawing = drawActions({}, { withdraw: true, withdrawAsks: false });
			answer('POST /api/decisions/7/withdraw', 400, MISSING);
			answer('POST /api/decisions/7/withdraw', 200, { decision: {}, revision: 'rev-2' });
			control(withdrawing.target, 'withdraw')!.click();
			flushSync();
			typeInto(withdrawing.target.querySelector<HTMLTextAreaElement>('[data-panel="withdraw"] textarea')!, 'No longer needed.');
			submit(withdrawing.target, 'withdraw');
			expect(passwordIn()).toBeNull();
			confirmButton().click();
			await settle();
			expect(sent.at(-1)!.body).toBe(JSON.stringify({ reason: 'No longer needed.' }));
			// Told to ask: the field is shown, and the password typed into it goes.
			expect(passwordIn()).not.toBeNull();
			typeInto(passwordIn()!, 'my password');
			typeCode(dialog()!);
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({
				what: 'POST /api/decisions/7/withdraw',
				headers: JSON_TYPE,
				body: JSON.stringify({ reason: 'No longer needed.', currentPassword: 'my password', currentCode: CODE })
			});
			expect(withdrawing.onSaved).toHaveBeenCalledWith('rev-2');
			expect(dialog()).toBeNull();

			const deleting = drawActions({}, { delete: true, deleteAsks: false });
			answer('DELETE /api/decisions/7', 400, MISSING);
			answer('DELETE /api/decisions/7', 200, { success: true });
			control(deleting.target, 'delete')!.click();
			flushSync();
			confirmButton().click();
			await settle();
			expect(sent.at(-1)!.body).toBe('{}');
			typeInto(passwordIn()!, 'my password');
			typeCode(dialog()!);
			confirmButton().click();
			await settle();
			expect(sent.at(-1)).toEqual({ what: 'DELETE /api/decisions/7', headers: JSON_TYPE, body: JSON.stringify({ currentPassword: 'my password', currentCode: CODE }) });
			expect(navigation.goto).toHaveBeenCalledWith('/board/3/decisions');
		});

		it('Close confirms and sends the JSON type with no body', async () => {
			const { target, onSaved } = drawActions({}, { close: true });
			answer('POST /api/decisions/7/close', 200, { decision: {}, revision: 'rev-2' });

			control(target, 'close')!.click();
			flushSync();
			confirmButton().click();
			await settle();

			expect(sent).toEqual([{ what: 'POST /api/decisions/7/close', headers: JSON_TYPE, body: undefined }]);
			expect(onSaved).toHaveBeenCalledWith('rev-2');
		});
	});

	// The code review's part B (F1): the page reads its data again after each lifecycle write, while the editor stays drawn.
	describe('the editor follows the server after a lifecycle write (F1)', () => {
		it('after Open the chip reads Open and the draft-only fields lock, the unsaved edits kept; after Extend the closing time follows', () => {
			const draftDecision = {
				id: 7,
				title: 'Pick a budget',
				status: 'draft',
				shownStatus: 'draft',
				voteMode: 'single',
				closesAt: '2026-12-01 12:00:00',
				deciderUserId: 1,
				deciderName: 'author',
				content: workingCopy
			};
			const props = $state({
				decision: draftDecision,
				options: [],
				participants: [],
				groups: [],
				revision: 'rev-1',
				readiness: { refusals: [], warnings: [] },
				editable: true,
				canSetDecider: false,
				canReview: false,
				productOwnerUserId: null,
				deciderCandidates: [],
				callerId: 1,
				onSaved: () => {},
				onReload: () => {}
			});
			const editor = draw(DecisionEditor, props);
			const chip = () => textOf(editor.querySelector('.status-chip')!);
			const closesShown = () => editor.querySelector<HTMLElement>('p.fixed[id$="-closes"]');
			expect(chip()).toBe('Draft');
			expect(editor.querySelector('.title-input')).not.toBeNull();
			expect(editor.querySelector('input[type="datetime-local"]')).not.toBeNull();
			const question = () => document.getElementById([...editor.querySelectorAll('label')].find((l) => textOf(l) === 'Question')!.getAttribute('for')!) as HTMLInputElement;
			typeInto(question(), 'Which budget, now?');
			expect(editor.querySelector('.unsaved')).not.toBeNull();

			// Open, taken: the page's data read again.
			props.decision = { ...draftDecision, status: 'open', shownStatus: 'open' };
			flushSync();
			expect(chip()).toBe('Open');
			expect(editor.querySelector('.title-input')).toBeNull();
			expect(textOf(editor.querySelector('.title-text')!)).toBe('Pick a budget');
			expect(editor.querySelector('input[type="datetime-local"]')).toBeNull();
			expect(textOf(closesShown()!)).toBe('2026-12-01 12:00 UTC');
			expect(question().value).toBe('Which budget, now?');
			expect(editor.querySelector('.unsaved')).not.toBeNull();

			// Extend, taken: a new closing time.
			props.decision = { ...draftDecision, status: 'open', shownStatus: 'open', closesAt: '2027-06-01 09:30:00' };
			flushSync();
			expect(textOf(closesShown()!)).toBe('2027-06-01 09:30 UTC');
			expect(question().value).toBe('Which budget, now?');
		});
	});

	// The code review's part B (F6).
	describe('accessibility (F6)', () => {
		it('each form toggle says whether its form is open and which it is; opening moves the focus into it, and Cancel hands it back', async () => {
			const { target } = drawActions({ republishSummary: { changesOptions: false, adding: [], retiring: [] } }, { republish: true, extend: true, withdraw: true });

			for (const [action, field] of [
				['republish', 'textarea'],
				['extend', 'input'],
				['withdraw', 'textarea']
			] as const) {
				const toggle = control(target, action)!;
				expect(toggle.getAttribute('aria-expanded'), action).toBe('false');
				toggle.click();
				await settle();
				expect(toggle.getAttribute('aria-expanded'), action).toBe('true');
				const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
				expect(panel.getAttribute('data-panel'), action).toBe(action);
				expect(document.activeElement, action).toBe(panel.querySelector(field));

				[...panel.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b) === 'Cancel')!.click();
				await settle();
				expect(toggle.getAttribute('aria-expanded'), action).toBe('false');
				expect(document.activeElement, action).toBe(toggle);
			}
		});

		it('hands the focus back to Extend once it is taken, and keeps one status region drawn, only its words changing', async () => {
			const { target } = drawActions({}, { extend: true });
			const status = target.querySelector<HTMLElement>('[role="status"]')!;
			expect(textOf(status)).toBe('');
			answer('POST /api/decisions/7/extend', 200, { decision: {}, revision: 'rev-2' });

			control(target, 'extend')!.click();
			await settle();
			typeInto(target.querySelector<HTMLInputElement>('[data-panel="extend"] input')!, '2027-06-01T09:30');
			submit(target, 'extend');
			confirmButton().click();
			await settle();

			expect(target.querySelector('[role="status"]')).toBe(status);
			expect(textOf(status)).toBe('Extended.');
			expect(document.activeElement).toBe(control(target, 'extend'));
		});

		it('hands the focus to what was said where the toggle has gone after the write', async () => {
			const { target } = drawActions({}, { withdraw: true, withdrawAsks: false });
			answer('POST /api/decisions/7/withdraw', 200, { decision: {}, revision: 'rev-2' });
			control(target, 'withdraw')!.click();
			await settle();
			typeInto(target.querySelector<HTMLTextAreaElement>('[data-panel="withdraw"] textarea')!, 'Not needed.');
			submit(target, 'withdraw');
			// The page's data read again: a withdrawn decision offers no Withdraw.
			target.querySelector<HTMLButtonElement>('[data-action="withdraw"]')!.remove();
			confirmButton().click();
			await settle();

			expect(document.activeElement).toBe(target.querySelector('[role="status"]'));
			expect(textOf(document.activeElement!)).toBe('Withdrawn.');
		});
	});

	describe('the top bar (54)', () => {
		it('links Preview as a participant to the preview', () => {
			const { target } = drawActions();
			expect(target.querySelector<HTMLAnchorElement>('[data-action="preview"]')!.getAttribute('href')).toBe('/decisions/7/preview');
		});

		it('sends Send me a dry run with { revision }, and says a 429 in its words', async () => {
			const { target, onSaved } = drawActions({}, { dryRun: true });
			const words = 'Your last dry run was less than 10 minutes ago: the next can be sent from 2026-11-04 10:10:00 UTC';
			answer('POST /api/decisions/7/dry-run', 429, { message: words });

			control(target, 'dryRun')!.click();
			await settle();

			expect(sent).toEqual([{ what: 'POST /api/decisions/7/dry-run', headers: JSON_TYPE, body: JSON.stringify({ revision: 'rev-1' }) }]);
			expect(textOf(target.querySelector('[role="alert"]')!)).toBe(words);
			expect(onSaved).not.toHaveBeenCalled();
		});
	});
});
