// @vitest-environment jsdom
/**
 * Drafting a decision, in the page (card 2676, slice A2: the plan's cases 22
 * to 29 and 31; case 30 is in `tests/header-menus.svelte.test.ts`). Each
 * component is mounted alone with Svelte's client runtime, as the Share
 * window's file mounts it, `fetch` a stand-in that keeps every request sent
 * and answers what the case gives it.
 *
 *   - `ParticipantPicker`: the search over name, job title and group name, and
 *     no address in the data a non-administrator is handed; group ticks, a
 *     mixed group and one with no active members; the decision's own
 *     participants who have left, flagged and never ticked by a group; Save
 *     with the revision, its refusals, and the question an opened decision
 *     asks first (decisions 15 and 29, D6).
 *   - `DecisionEditor`: options added, removed and moved, sent with the ids the
 *     server issued and none for a new one; the title, closing time and vote
 *     mode fixed once open and sent unchanged (D5); the agent label and Mark
 *     reviewed (decision 9); the readability panel (decision 11, R4); the
 *     decider select (decision 17, D6).
 *   - The board's decision list: New decision, and a title that links to its
 *     editor only where the row says the caller may edit; an opened decision's
 *     title links to its page as well (card 2677, F4).
 *
 * What the server answers, and to whom, is in `tests/decision-authoring.test.ts`.
 * The plan is `docs/planning/card-2676-decision-authoring.md`.
 */
import { readdirSync, readFileSync } from 'node:fs';
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
// The board's decision list listens for `decision` events (card 2680): jsdom has no EventSource, and the listening is
// tests/decision-register.svelte.test.ts's.
vi.mock('$lib/live-refresh', () => ({ connectLiveRefresh: vi.fn(() => () => {}) }));
// A bare 'svelte' gives the server's runtime, whose tick and onDestroy the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import ParticipantPicker from '$lib/components/decision/ParticipantPicker.svelte';
import DecisionEditor from '$lib/components/decision/DecisionEditor.svelte';
import BoardDecisionsPage from '../src/routes/board/[id]/decisions/+page.svelte';
import type { WorkingContent } from '$lib/decision-readiness';

// The browser's `mount`, loaded by its path (see the XP bars' file).
const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { createRawSnippet, flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

type Json = any;

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** Each request sent, as `METHOD url`, with its body read as JSON. */
let sent: { what: string; body: Json }[] = [];
/** What the next request to each `METHOD url` is answered; anything else is `{}`. */
let answers: Record<string, { status: number; body: unknown }[]> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A link pressed in a test is not followed: jsdom cannot navigate. */
function noNavigation(e: MouseEvent) {
	if ((e.target as Element | null)?.closest?.('a[href]')) e.preventDefault();
}

beforeEach(() => {
	sent = [];
	answers = {};
	navigation.goto.mockClear();
	navigation.invalidateAll.mockClear();
	window.addEventListener('click', noNavigation, true);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const what = `${init?.method ?? 'GET'} ${url}`;
			sent.push({ what, body: init?.body ? JSON.parse(String(init.body)) : undefined });
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
	window.removeEventListener('click', noNavigation, true);
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

const answer = (what: string, body: unknown, status = 200) => (answers[what] ??= []).push({ status, body });
const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const button = (within: ParentNode, text: string) =>
	[...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b) === text || b.getAttribute('aria-label') === text)!;
const requests = (what: string) => sent.filter((r) => r.what === what).map((r) => r.body);

/** Types into a field as a person does: its value, then the input event its binding listens for. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

// ─── The picker ─────────────────────────────────────────────────────────────

const GROUPS = [
	{ id: 1, name: 'Finance', activeMemberIds: [11, 12] },
	{ id: 2, name: 'Design', activeMemberIds: [13] },
	{ id: 3, name: 'Empty', activeMemberIds: [] }
];
/** People as a caller who is not an administrator is handed them: no address. */
const PEOPLE = [
	{ id: 11, fullName: 'Ann Able', jobTitle: 'Accountant', groupIds: [1] },
	{ id: 12, fullName: 'Bob Brown', jobTitle: 'Controller', groupIds: [1] },
	{ id: 13, fullName: 'Cat Cole', jobTitle: 'Designer', groupIds: [2] },
	{ id: 15, fullName: 'Fay Ford', jobTitle: 'Buyer', groupIds: [] }
];

const row = (id: number, personId: number | null, name: string, more: Partial<Json> = {}) => ({
	id,
	personId,
	role: 'consulted',
	name,
	jobTitle: '',
	groups: [],
	includedAt: '2026-11-01 09:00:00',
	includedByName: 'editor',
	removedAt: null,
	reach: 'account',
	hasLeft: false,
	notInDirectory: false,
	...more
});
/** Dan Dale, a participant who has since left (he was in Finance), and Eve East, deleted from the directory. */
const DAN = row(1, 14, 'Dan Dale', { hasLeft: true });
const EVE = row(2, null, 'Eve East', { notInDirectory: true });

function drawPicker(more: Partial<Json> = {}) {
	return draw(ParticipantPicker, {
		decisionId: 5,
		status: 'draft',
		participants: [],
		people: PEOPLE,
		groups: GROUPS,
		revision: 'rev-1',
		canSave: true,
		onSaved: () => {},
		onReload: () => {},
		...more
	});
}

const personRows = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>('.people-ticks .person-row')];
const shownPeople = (target: HTMLElement) => personRows(target).map((r) => r.querySelector('.person-name')!.textContent);
const tickOf = (target: HTMLElement, name: string) =>
	[...target.querySelectorAll<HTMLElement>('.person-row, .flagged-row')].find((r) => r.querySelector('.person-name')?.textContent === name)!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const groupTick = (target: HTMLElement, name: string) => [...target.querySelectorAll<HTMLButtonElement>('.group-tick')].find((b) => textOf(b) === name)!;
const ticked = (target: HTMLElement) => PEOPLE.filter((p) => tickOf(target, p.fullName).checked).map((p) => p.fullName);
const search = (target: HTMLElement, text: string) => type(target.querySelector<HTMLInputElement>('input[type="search"]')!, text);

describe('ParticipantPicker (cases 22 to 25)', () => {
	it('22: searches by name, by job title and by group name; a non-administrator is handed no address, and searching one finds nobody', () => {
		const target = drawPicker();
		expect(shownPeople(target)).toEqual(['Ann Able', 'Bob Brown', 'Cat Cole', 'Fay Ford']);

		search(target, 'cat');
		expect(shownPeople(target)).toEqual(['Cat Cole']);
		search(target, 'controller');
		expect(shownPeople(target)).toEqual(['Bob Brown']);
		search(target, 'finance');
		expect(shownPeople(target)).toEqual(['Ann Able', 'Bob Brown']);

		// The data holds no address, and the page draws none: an address is no search term.
		expect(JSON.stringify(PEOPLE)).not.toContain('@');
		expect(target.textContent).not.toContain('@');
		search(target, 'ann.able@example.test');
		expect(shownPeople(target)).toEqual([]);
		expect(target.textContent).toContain('No one matches.');
	});

	it('23: a group ticks its active members as Consulted and unticks them; one unticked makes it mixed; a group with no active members cannot be ticked', () => {
		const target = drawPicker();
		groupTick(target, 'Finance').click();
		flushSync();
		expect(ticked(target)).toEqual(['Ann Able', 'Bob Brown']);
		expect(groupTick(target, 'Finance').getAttribute('aria-checked')).toBe('true');
		expect(personRows(target).filter((r) => r.querySelector('.role-toggle')).map((r) => textOf(r.querySelector('.role-toggle')!))).toEqual(['Consulted', 'Consulted']);

		groupTick(target, 'Finance').click();
		flushSync();
		expect(ticked(target)).toEqual([]);
		expect(groupTick(target, 'Finance').getAttribute('aria-checked')).toBe('false');

		groupTick(target, 'Finance').click();
		flushSync();
		tickOf(target, 'Bob Brown').click();
		flushSync();
		expect(ticked(target)).toEqual(['Ann Able']);
		expect(groupTick(target, 'Finance').getAttribute('aria-checked')).toBe('mixed');

		const empty = groupTick(target, 'Empty');
		expect(empty.disabled).toBe(true);
		expect(empty.parentElement!.textContent).toContain('no active members');
		empty.click();
		flushSync();
		expect(ticked(target)).toEqual(['Ann Able']);
	});

	it('23: a participant who has left is flagged "has left: remove before saving", ticked until the editor unticks them, and a group tick does not tick them', () => {
		const target = drawPicker({ participants: [DAN] });
		const flagged = target.querySelector<HTMLElement>('.flagged-row')!;
		expect(textOf(flagged)).toBe('Dan Dale has left: remove before saving');
		expect(tickOf(target, 'Dan Dale').checked).toBe(true);

		tickOf(target, 'Dan Dale').click();
		flushSync();
		expect(tickOf(target, 'Dan Dale').checked).toBe(false);
		groupTick(target, 'Finance').click();
		flushSync();
		expect(ticked(target)).toEqual(['Ann Able', 'Bob Brown']);
		expect(tickOf(target, 'Dan Dale').checked).toBe(false);
	});

	it('24: a role toggled, Save sends the participants and the revision; a 409 says the server’s words and keeps the ticks, offering Reload', async () => {
		const reloads: string[] = [];
		const target = drawPicker({ onReload: () => reloads.push('reload') });
		tickOf(target, 'Ann Able').click();
		tickOf(target, 'Cat Cole').click();
		flushSync();
		button(target, 'Role of Ann Able: Consulted').click();
		flushSync();
		expect(textOf(target.querySelector('.summary')!)).toBe('1 consulted, 1 informed');

		const words = 'This decision was changed since you opened it: reload it to see the change';
		answer('PUT /api/decisions/5/participants', { message: words }, 409);
		button(target, 'Save participants').click();
		await settle();
		expect(requests('PUT /api/decisions/5/participants')).toEqual([
			{
				participants: [
					{ personId: 11, role: 'informed' },
					{ personId: 13, role: 'consulted' }
				],
				revision: 'rev-1'
			}
		]);
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe(`${words} Reload`);
		expect(ticked(target)).toEqual(['Ann Able', 'Cat Cole']);
		button(target, 'Reload').click();
		expect(reloads).toEqual(['reload']);
	});

	it('24: a 409 in words other than the stale revision keeps the ticks and offers no Reload, in the picker and in the editor (C6)', async () => {
		const reloads: string[] = [];
		const target = drawPicker({ status: 'open', onReload: () => reloads.push('reload') });
		tickOf(target, 'Ann Able').click();
		flushSync();
		const words = 'Ann Able was mailed about this decision less than 10 minutes ago: they can be mailed again from 2026-11-03 10:10:00 UTC';
		answer('PUT /api/decisions/5/participants', { message: words }, 409);
		button(target, 'Save participants').click();
		flushSync();
		button(dialog()!, 'Save').click();
		await settle();
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe(words);
		expect(button(target, 'Reload')).toBeUndefined();
		expect(ticked(target)).toEqual(['Ann Able']);

		const editor = drawEditor({ decision: decision({ status: 'open', shownStatus: 'open', currentVersion: 1 }) });
		type(fieldLabelled(editor, 'Situation'), 'Changed.');
		const refused = 'This decision has been opened: its vote mode cannot be changed';
		answer('PUT /api/decisions/5', { message: refused }, 409);
		button(editor, 'Save').click();
		await settle();
		expect(textOf(editor.querySelector('[role="alert"]')!)).toBe(refused);
		expect(button(editor, 'Reload')).toBeUndefined();
		expect(fieldLabelled(editor, 'Situation').value).toBe('Changed.');
		expect(reloads).toEqual([]);
	});

	it('24: a flagged participant still ticked is sent, and the field-named 400 shown; unticked, the body is sent without them', async () => {
		const saved: string[] = [];
		const target = drawPicker({ participants: [DAN, row(3, 11, 'Ann Able')], onSaved: (revision: string) => saved.push(revision) });
		const words = 'participants: Dan Dale has left: remove before saving';
		answer('PUT /api/decisions/5/participants', { message: words }, 400);
		button(target, 'Save participants').click();
		await settle();
		expect(requests('PUT /api/decisions/5/participants')[0].participants).toEqual([
			{ personId: 11, role: 'consulted' },
			{ personId: 14, role: 'consulted' }
		]);
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe(words);
		expect(button(target, 'Reload')).toBeUndefined();

		tickOf(target, 'Dan Dale').click();
		flushSync();
		answer('PUT /api/decisions/5/participants', { participants: [row(3, 11, 'Ann Able')], revision: 'rev-2' });
		button(target, 'Save participants').click();
		await settle();
		expect(requests('PUT /api/decisions/5/participants')[1]).toEqual({ participants: [{ personId: 11, role: 'consulted' }], revision: 'rev-1' });
		expect(saved).toEqual(['rev-2']);
		expect(target.querySelector('.flagged-row')).toBeNull();
		expect(target.querySelector('[role="alert"]')).toBeNull();
	});

	const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Save participants"]');

	it('25: on an open decision, a Save that adds two and removes one asks first with both counts, and Cancel sends nothing', async () => {
		const target = drawPicker({ status: 'open', participants: [row(3, 11, 'Ann Able'), row(4, 12, 'Bob Brown', { role: 'informed' })] });
		tickOf(target, 'Cat Cole').click();
		tickOf(target, 'Fay Ford').click();
		tickOf(target, 'Bob Brown').click();
		flushSync();
		button(target, 'Save participants').click();
		flushSync();
		expect(textOf(dialog()!)).toContain('2 people will be mailed now; 1 will be marked removed.');
		button(dialog()!, 'Cancel').click();
		await settle();
		expect(dialog()).toBeNull();
		expect(requests('PUT /api/decisions/5/participants')).toEqual([]);
	});

	it('25: a flagged participant unticked, and one no longer in the directory, are counted among those taken off', async () => {
		const target = drawPicker({ status: 'open', participants: [DAN, EVE, row(3, 11, 'Ann Able')] });
		expect(textOf(target.querySelectorAll<HTMLElement>('.flagged-row')[1])).toBe('Eve East no longer in the people directory: saving takes them off');
		tickOf(target, 'Dan Dale').click();
		flushSync();
		button(target, 'Save participants').click();
		flushSync();
		expect(textOf(dialog()!)).toContain('0 people will be mailed now; 2 will be marked removed.');
		answer('PUT /api/decisions/5/participants', { participants: [EVE, row(3, 11, 'Ann Able')], revision: 'rev-2' });
		button(dialog()!, 'Save').click();
		await settle();
		expect(requests('PUT /api/decisions/5/participants')).toEqual([{ participants: [{ personId: 11, role: 'consulted' }], revision: 'rev-1' }]);
	});

	// Card 2743 (D5): the count is what the save mails, as the server decides it at the shown status.
	it('25: awaiting a ruling, one added as consulted is counted as not asked and one added as informed as mailed; open, one made consulted is mailed (2743-7)', async () => {
		const closed = drawPicker({ status: 'closed', shownStatus: 'awaiting_ruling', participants: [row(3, 11, 'Ann Able')] });
		tickOf(closed, 'Cat Cole').click();
		tickOf(closed, 'Fay Ford').click();
		flushSync();
		button(closed, 'Role of Fay Ford: Consulted').click();
		flushSync();
		button(closed, 'Save participants').click();
		flushSync();
		// Card 2744 (D7): the reopening asks them, so the confirmation can say so.
		expect(textOf(dialog()!)).toContain('1 person will be mailed now; 1 consulted may be asked for their view when the decision is reopened; 0 will be marked removed.');
		button(dialog()!, 'Cancel').click();
		await settle();

		// Stored open past its closing time reads as the shown status says.
		const lapsed = drawPicker({ status: 'open', shownStatus: 'awaiting_ruling', participants: [] });
		tickOf(lapsed, 'Cat Cole').click();
		flushSync();
		button(lapsed, 'Save participants').click();
		flushSync();
		expect(textOf(dialog()!)).toContain('0 people will be mailed now; 1 consulted may be asked for their view when the decision is reopened; 0 will be marked removed.');
		button(dialog()!, 'Cancel').click();
		await settle();

		// Card 2744 (F3): one made consulted while it is closed is asked at the reopening too, and counted so (2744-8).
		const switched = drawPicker({ status: 'closed', shownStatus: 'awaiting_ruling', participants: [row(4, 12, 'Bob Brown', { role: 'informed' })] });
		button(switched, 'Role of Bob Brown: Informed').click();
		flushSync();
		button(switched, 'Save participants').click();
		flushSync();
		expect(textOf(dialog()!)).toContain('0 people will be mailed now; 1 consulted may be asked for their view when the decision is reopened; 0 will be marked removed.');
		button(dialog()!, 'Cancel').click();
		await settle();

		const open = drawPicker({ status: 'open', shownStatus: 'open', participants: [row(4, 12, 'Bob Brown', { role: 'informed' })] });
		button(open, 'Role of Bob Brown: Informed').click();
		tickOf(open, 'Cat Cole').click();
		flushSync();
		button(open, 'Save participants').click();
		flushSync();
		expect(textOf(dialog()!)).toContain('2 people will be mailed now; 0 will be marked removed.');
		button(dialog()!, 'Cancel').click();
		await settle();
		expect(requests('PUT /api/decisions/5/participants')).toEqual([]);
	});
});

// ─── The editor ─────────────────────────────────────────────────────────────

const option = (optionId: number | undefined, title: string, more: Partial<WorkingContent['options'][number]> = {}) => ({
	...(optionId === undefined ? {} : { optionId }),
	title,
	summary: `${title} summary`,
	pros: ['Cheap'],
	cons: ['Slow'],
	commercial: 'About 1,000 a year',
	...more
});

function content(more: Partial<WorkingContent> = {}): WorkingContent {
	return {
		situation: 'We buy paper monthly.',
		question: 'Which supplier?',
		ask: 'Pick one.',
		options: [option(101, 'Acme'), option(102, 'Bolt')],
		audiences: [],
		stories: [],
		unknowns: '',
		alreadyRuled: '',
		technicalDetail: '',
		surveyQuestions: [],
		agentDrafted: {},
		reviewed: {},
		lastLabel: 'B',
		...more
	};
}

function decision(more: Partial<Json> = {}) {
	return {
		id: 5,
		boardId: 7,
		boardName: 'Website',
		title: 'Pick a supplier',
		status: 'draft',
		shownStatus: 'draft',
		voteMode: 'single',
		closesAt: '2099-12-01 12:00:30',
		currentVersion: 0,
		authorName: 'editor',
		deciderUserId: 2,
		deciderName: 'bob',
		content: content(),
		...more
	};
}

const OPTIONS = [
	{ id: 101, label: 'A', position: 0, addedInVersion: null, retiredInVersion: null },
	{ id: 102, label: 'B', position: 1, addedInVersion: null, retiredInVersion: null }
];
const CANDIDATES = [
	{ id: 1, username: 'alice', emoji: '🙂' },
	{ id: 2, username: 'bob', emoji: '🐝' },
	{ id: 3, username: 'cara', emoji: '🌵' }
];

function drawEditor(more: Partial<Json> = {}) {
	return draw(DecisionEditor, {
		decision: decision(),
		options: OPTIONS,
		participants: [],
		groups: GROUPS,
		revision: 'rev-1',
		readiness: { refusals: [], warnings: [] },
		editable: true,
		canSetDecider: true,
		canReview: true,
		productOwnerUserId: 3,
		deciderCandidates: CANDIDATES,
		callerId: 1,
		onSaved: () => {},
		onReload: () => {},
		...more
	});
}

const optionCards = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>('.option-card')];
const optionTitles = (target: HTMLElement) => optionCards(target).map((card) => card.querySelector<HTMLInputElement>('input')!.value);
const fieldLabelled = (target: HTMLElement, label: string) => {
	const found = [...target.querySelectorAll('label')].find((l) => textOf(l) === label)!;
	return document.getElementById(found.getAttribute('for')!) as HTMLInputElement & HTMLTextAreaElement;
};

describe('DecisionEditor (cases 26 to 29)', () => {
	it('26: options are added, removed and moved; Save sends the ids the server issued and none for a new option; a 409 keeps the edits and says the words', async () => {
		const target = drawEditor();
		expect(optionCards(target).map((card) => textOf(card.querySelector('.option-label')!))).toEqual(['Option A', 'Option B']);

		button(target, '+ Add option').click();
		flushSync();
		type(optionCards(target)[2].querySelector('input')!, 'Crest');
		button(target, 'Remove option 2').click();
		flushSync();
		button(target, 'Move option 2 left').click();
		flushSync();
		expect(optionTitles(target)).toEqual(['Crest', 'Acme']);
		expect(optionCards(target).map((card) => textOf(card.querySelector('.option-label')!))).toEqual(['New option', 'Option A']);
		expect(target.querySelector('.unsaved')).not.toBeNull();

		const words = 'This decision was changed since you opened it: reload it to see the change';
		answer('PUT /api/decisions/5', { message: words }, 409);
		button(target, 'Save').click();
		await settle();
		const [body] = requests('PUT /api/decisions/5');
		expect(body.revision).toBe('rev-1');
		expect(body.content.options).toEqual([
			{ title: 'Crest', summary: '', pros: [], cons: [], commercial: '' },
			{ optionId: 101, title: 'Acme', summary: 'Acme summary', pros: ['Cheap'], cons: ['Slow'], commercial: 'About 1,000 a year' }
		]);
		// No key the server keeps is sent (decision 8); card 2683: the survey questions always are, `[]` with none (R15).
		expect(Object.keys(body.content).sort()).toEqual([
			'alreadyRuled',
			'ask',
			'audiences',
			'options',
			'question',
			'situation',
			'stories',
			'surveyQuestions',
			'technicalDetail',
			'unknowns'
		]);
		expect(body.content.surveyQuestions).toEqual([]);
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe(`${words} Reload`);
		expect(optionTitles(target)).toEqual(['Crest', 'Acme']);
		expect(target.querySelector('.unsaved')).not.toBeNull();
	});

	it('26: on an open decision the title, closing time and vote mode are read-only, and Save sends them unchanged with the content', async () => {
		// Card 2683 (R23): published options, so the vote mode is fixed; with none published it may still change.
		const target = drawEditor({
			decision: decision({ status: 'open', shownStatus: 'open', voteMode: 'score', currentVersion: 1 }),
			options: OPTIONS.map((option) => ({ ...option, addedInVersion: 1 }))
		});
		expect(target.querySelector('.title-input')).toBeNull();
		expect(target.querySelector('select[id$="-vote"]')).toBeNull();
		expect(textOf(target.querySelector('p[id$="-vote"]')!)).toBe('A score for each option, 0 to 5');
		expect(textOf(target.querySelector('.title-text')!)).toBe('Pick a supplier');
		expect(target.querySelector('input[type="datetime-local"]')).toBeNull();
		expect(textOf(target.querySelector('.side-column')!)).toContain('2099-12-01 12:00 UTC');
		expect(textOf(target.querySelector('.side-column')!)).toContain('A score for each option, 0 to 5');

		type(fieldLabelled(target, 'Situation'), 'We buy paper weekly now.');
		answer('PUT /api/decisions/5', { decision: decision({ status: 'open', shownStatus: 'open', voteMode: 'score' }), options: OPTIONS, revision: 'rev-2', readiness: { refusals: [], warnings: [] } });
		button(target, 'Save').click();
		await settle();
		const [body] = requests('PUT /api/decisions/5');
		expect(body.title).toBe('Pick a supplier');
		// The stored closing time, to the second, as it was: unchanged, so the server takes it.
		expect(body.closesAt).toBe('2099-12-01 12:00:30');
		expect(body.voteMode).toBe('score');
		expect(body.content.situation).toBe('We buy paper weekly now.');
	});

	it('27: a flagged section carries the agent label; Mark reviewed sends that section and Mark all reviewed sends all, each with the revision', async () => {
		const saved: string[] = [];
		const flagged = { situation: true as const, 'options.101': true as const };
		const target = drawEditor({ decision: decision({ content: content({ agentDrafted: flagged }) }), onSaved: (r: string) => saved.push(r) });
		expect([...target.querySelectorAll('.agent-label')].map((l) => [l.getAttribute('data-section'), textOf(l)])).toEqual([
			['situation', 'Drafted by an agent and not yet reviewed by a person'],
			['options.101', 'Drafted by an agent and not yet reviewed by a person']
		]);

		answer('POST /api/decisions/5/reviewed', { decision: decision({ content: content({ agentDrafted: { 'options.101': true } }) }), revision: 'rev-2' });
		button(target, 'Mark Situation reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([{ sections: ['situation'], revision: 'rev-1' }]);
		expect([...target.querySelectorAll('.agent-label')].map((l) => l.getAttribute('data-section'))).toEqual(['options.101']);

		answer('POST /api/decisions/5/reviewed', { decision: decision(), revision: 'rev-3' });
		button(target, 'Mark all reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')[1]).toEqual({ sections: 'all', revision: 'rev-1' });
		expect(target.querySelector('.agent-label')).toBeNull();
		expect(button(target, 'Mark all reviewed')).toBeUndefined();
		expect(saved).toEqual(['rev-2', 'rev-3']);
	});

	it('27 (card 2728): a title, decider and participants an agent chose each carry the label beside them; Mark reviewed waits while that key has edits not yet saved, then sends that key alone, keeping other edits', async () => {
		const flagged = { title: true as const, decider: true as const, participants: true as const };
		const side = createRawSnippet(() => ({ render: () => '<div class="picker">The picker</div>' }));
		const target = drawEditor({ decision: decision({ content: content({ agentDrafted: flagged }) }), side });
		const labels = () => [...target.querySelectorAll('.agent-label')].map((l) => l.getAttribute('data-section'));
		expect(labels()).toEqual(['title', 'decider', 'participants']);
		expect(target.querySelector('.top-bar [data-section="title"]')).not.toBeNull();
		expect(textOf(target.querySelector('[data-section="decider"]')!.parentElement!)).toContain('Decider');
		const participants = target.querySelector('[data-flagged="participants"]')!;
		expect(participants.parentElement!.querySelector('.picker')).not.toBeNull();
		expect(textOf(participants)).toContain('Participants');

		// The code review: a title typed over and not yet saved holds its Mark reviewed (and Mark all reviewed) off, saying to save first.
		const titleInput = target.querySelector<HTMLInputElement>('.title-input')!;
		type(titleInput, 'Pick a supplier, edited');
		expect(button(target, 'Mark Title reviewed').getAttribute('aria-disabled')).toBe('true');
		expect(textOf(target.querySelector('[data-save-first="title"]')!)).toBe('Save your changes first to mark this reviewed');
		expect(button(target, 'Mark all reviewed').getAttribute('aria-disabled')).toBe('true');
		button(target, 'Mark Title reviewed').click();
		button(target, 'Mark all reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([]);
		expect(labels()).toEqual(['title', 'decider', 'participants']);

		// The title as saved again, an unflagged section edited: Mark reviewed sends the title alone, the edit kept.
		type(titleInput, 'Pick a supplier');
		type(fieldLabelled(target, 'Situation'), 'Typed, not yet saved.');
		expect(button(target, 'Mark Title reviewed').getAttribute('aria-disabled')).toBeNull();
		expect(target.querySelector('[data-save-first]')).toBeNull();
		answer('POST /api/decisions/5/reviewed', { decision: decision({ content: content({ agentDrafted: { decider: true, participants: true } }) }), revision: 'rev-2' });
		button(target, 'Mark Title reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([{ sections: ['title'], revision: 'rev-1' }]);
		expect(labels()).toEqual(['decider', 'participants']);
		expect(fieldLabelled(target, 'Situation').value).toBe('Typed, not yet saved.');

		answer('POST /api/decisions/5/reviewed', { decision: decision({ content: content({ agentDrafted: { decider: true } }) }), revision: 'rev-3' });
		button(target, 'Mark Participants reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')[1]).toEqual({ sections: ['participants'], revision: 'rev-1' });
		expect(target.querySelector('[data-flagged="participants"]')).toBeNull();
		expect(target.querySelector('.picker')).not.toBeNull();
		expect(button(target, 'Mark Decider reviewed')).toBeDefined();

		// Another decider selected and not yet changed: its Mark reviewed waits too.
		const select = fieldLabelled(target, 'Decider') as unknown as HTMLSelectElement;
		select.value = '3';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(button(target, 'Mark Decider reviewed').getAttribute('aria-disabled')).toBe('true');
		expect(target.querySelector('[data-save-first="decider"]')).not.toBeNull();
		button(target, 'Mark Decider reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toHaveLength(2);
	});

	it("27 (card 2728's code review): a flagged section or option with edits not yet saved holds its Mark reviewed and Mark all reviewed off, saying to save first; saved, they send", async () => {
		const flagged = { situation: true as const, 'options.101': true as const };
		const target = drawEditor({ decision: decision({ content: content({ agentDrafted: flagged }) }) });
		const held = (name: string) => button(target, name).getAttribute('aria-disabled') === 'true';

		type(fieldLabelled(target, 'Situation'), 'Typed over the agent.');
		expect([held('Mark Situation reviewed'), held('Mark option 1 reviewed'), held('Mark all reviewed')]).toEqual([true, false, true]);
		expect([...target.querySelectorAll('[data-save-first]')].map((hint) => hint.getAttribute('data-save-first'))).toEqual(['all', 'situation']);
		expect(button(target, 'Mark Situation reviewed').getAttribute('aria-describedby')).toBe(target.querySelector('[data-save-first="situation"]')!.id);
		button(target, 'Mark Situation reviewed').click();
		button(target, 'Mark all reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([]);

		type(optionCards(target)[0].querySelector<HTMLInputElement>('input')!, 'Acme, typed over');
		expect(held('Mark option 1 reviewed')).toBe(true);
		button(target, 'Mark option 1 reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([]);

		// Saved: each sends again.
		const savedContent = content({ agentDrafted: flagged, situation: 'Typed over the agent.' });
		savedContent.options[0].title = 'Acme, typed over';
		answer('PUT /api/decisions/5', { decision: decision({ content: savedContent }), options: OPTIONS, revision: 'rev-2', readiness: { refusals: [], warnings: [] } });
		button(target, 'Save').click();
		await settle();
		expect(target.querySelector('[data-save-first]')).toBeNull();
		answer('POST /api/decisions/5/reviewed', { decision: decision({ content: { ...savedContent, agentDrafted: {} } }), revision: 'rev-3' });
		button(target, 'Mark all reviewed').click();
		await settle();
		expect(requests('POST /api/decisions/5/reviewed')).toEqual([{ sections: 'all', revision: 'rev-1' }]);
	});

	it('28: the readability panel lists the server’s refusals and warnings in their words; an emptied question shows checkContent’s warning, the refusals as the server gave them', () => {
		const refusals = [{ code: 'no_consulted', words: 'This decision has no consulted participant: it cannot be opened' }];
		const warnings = [{ code: 'option_no_commercial', key: 'options[1]', words: 'Option 2, "Bolt", has no commercial note' }];
		const target = drawEditor({ readiness: { refusals, warnings } });
		const panel = () => target.querySelector<HTMLElement>('.readiness')!;
		const listed = (kind: string) => [...panel().querySelectorAll(`.${kind} li`)].map((li) => [li.getAttribute('data-code'), textOf(li)]);
		expect(listed('refusals')).toEqual([['no_consulted', refusals[0].words]]);
		expect(listed('warnings')).toEqual([['option_no_commercial', warnings[0].words]]);

		type(fieldLabelled(target, 'Question'), '   ');
		expect(listed('warnings')).toEqual([['empty_question', 'The question is empty']]);
		expect(listed('refusals')).toEqual([['no_consulted', refusals[0].words]]);
	});

	it('28: no page or component imports refusalsOf, which the server alone runs (R4)', () => {
		const svelteFiles = (readdirSync(join(process.cwd(), 'src'), { recursive: true }) as string[]).filter((file) => file.endsWith('.svelte'));
		expect(svelteFiles.length).toBeGreaterThan(50);
		const importing = svelteFiles.filter((file) => /\brefusalsOf\b/.test(readFileSync(join(process.cwd(), 'src', file), 'utf8')));
		expect(importing).toEqual([]);
	});

	const deciderSelect = (target: HTMLElement) => fieldLabelled(target, 'Decider') as unknown as HTMLSelectElement;
	const offered = (select: HTMLSelectElement) => [...select.options].map((o) => [o.value, textOf(o)]);

	it('29: the decider select lists the candidates, the stored decider chosen and the Product Owner marked; on an open decision the caller is not offered', async () => {
		let target = drawEditor();
		expect(offered(deciderSelect(target))).toEqual([
			['1', '🙂 alice'],
			['2', '🐝 bob'],
			['3', '🌵 cara (Product Owner)']
		]);
		expect(deciderSelect(target).value).toBe('2');

		for (const { component, target: t } of drawn) {
			unmount(component);
			t.remove();
		}
		drawn = [];
		target = drawEditor({ decision: decision({ status: 'open', shownStatus: 'open', deciderUserId: 1, deciderName: 'alice' }) });
		// alice, the caller, is the decider: she is shown as chosen, and not offered among the candidates.
		expect(offered(deciderSelect(target))).toEqual([
			['1', 'alice'],
			['2', '🐝 bob'],
			['3', '🌵 cara (Product Owner)']
		]);
		expect(deciderSelect(target).value).toBe('1');
		const select = deciderSelect(target);
		select.value = '3';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		answer('PUT /api/decisions/5/decider', { decision: decision({ status: 'open', shownStatus: 'open', deciderUserId: 3, deciderName: 'cara' }), revision: 'rev-2' });
		button(target, 'Change decider').click();
		await settle();
		expect(requests('PUT /api/decisions/5/decider')).toEqual([{ deciderUserId: 3, revision: 'rev-1' }]);
	});

	it('29: a decider who is not the author sees the decider read-only, with no candidates', () => {
		const target = drawEditor({ canSetDecider: false, deciderCandidates: [], callerId: 2 });
		expect(target.querySelector('.side-column select[id$="-decider"]')).toBeNull();
		expect(button(target, 'Change decider')).toBeUndefined();
		expect(textOf(target.querySelector('.decider-fixed')!)).toBe('bob');
	});
});

// ─── The editor's survey questions (card 2683, slice S3a) ───────────────────

describe("DecisionEditor's survey questions (card 2683, U4 and U5)", () => {
	const entries = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>('[data-survey]')];
	/** A field of one survey question, by its label, within that question alone (each question has the same labels). */
	const fieldIn = (entry: HTMLElement, label: string) => {
		const found = [...entry.querySelectorAll('label')].find((l) => textOf(l) === label)!;
		return document.getElementById(found.getAttribute('for')!) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement;
	};
	function choose(select: HTMLSelectElement, value: string) {
		select.value = value;
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
	}
	const SHIP = { questionId: 41, kind: 'choice' as const, prompt: 'Where do you ship from?', help: '', required: true, choices: ['Leeds', 'York'] };

	it('U4: a choice and a scale question are added, a third removed, and Save sends surveyQuestions with only each kind’s keys; the saved answer is taken', async () => {
		const target = drawEditor({ decision: decision({ content: content({ options: [] }) }), options: [] });
		expect(entries(target)).toEqual([]);

		for (let i = 0; i < 3; i++) {
			button(target, '+ Add survey question').click();
			flushSync();
		}
		const [first, second, third] = entries(target);
		// A new question is a choice question until its kind is chosen.
		expect(fieldIn(first, 'Kind').value).toBe('choice');
		type(fieldIn(first, 'Prompt'), 'Where do you ship from?');
		type(fieldIn(first, 'Choices, one a line (2 to 20)'), 'Leeds\n  York \n\n');
		first.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
		flushSync();

		choose(fieldIn(second, 'Kind'), 'scale');
		expect([...second.querySelectorAll('label')].map(textOf)).not.toContain('Choices, one a line (2 to 20)');
		type(fieldIn(second, 'Prompt'), 'How often are you late?');
		type(fieldIn(second, 'Top of the scale (2 to 10)'), '7');
		type(fieldIn(second, 'Words at 1'), 'Never');
		type(fieldIn(second, 'Words at the top'), 'Always');

		choose(fieldIn(third, 'Kind'), 'text');
		type(fieldIn(third, 'Prompt'), 'Anything else?');
		button(target, 'Remove survey question 3').click();
		flushSync();
		expect(entries(target).map((entry) => fieldIn(entry, 'Prompt').value)).toEqual(['Where do you ship from?', 'How often are you late?']);
		expect(target.querySelector('.unsaved')).not.toBeNull();

		const asked = [
			SHIP,
			{ questionId: 42, kind: 'scale' as const, prompt: 'How often are you late?', help: '', required: false, scale: { max: 7, lowLabel: 'Never', highLabel: 'Always' } }
		];
		answer('PUT /api/decisions/5', {
			decision: decision({ content: content({ options: [], surveyQuestions: asked }) }),
			options: [],
			surveyQuestions: [
				{ id: 41, position: 0, addedInVersion: null, retiredInVersion: null },
				{ id: 42, position: 1, addedInVersion: null, retiredInVersion: null }
			],
			revision: 'rev-2'
		});
		button(target, 'Save').click();
		await settle();
		const [body] = requests('PUT /api/decisions/5');
		expect(body.content.surveyQuestions).toEqual([
			{ kind: 'choice', prompt: 'Where do you ship from?', help: '', required: true, choices: ['Leeds', 'York'] },
			{ kind: 'scale', prompt: 'How often are you late?', help: '', required: false, scale: { max: 7, lowLabel: 'Never', highLabel: 'Always' } }
		]);
		// The server's answer is what is now saved: nothing left unsaved, the choices one a line.
		expect(target.querySelector('.unsaved')).toBeNull();
		expect(fieldIn(entries(target)[0], 'Choices, one a line (2 to 20)').value).toBe('Leeds\nYork');
	});

	it('U5: on an opened survey a published question’s kind is fixed and it says a change but its help asks everyone again; a new one’s kind is chosen; the vote mode can still change (R23) until an option is published', async () => {
		const opened = { status: 'open', shownStatus: 'open', currentVersion: 1, content: content({ options: [], surveyQuestions: [SHIP], agentDrafted: { 'survey.41': true } }) };
		const target = drawEditor({
			decision: decision(opened),
			options: [],
			surveyQuestions: [{ id: 41, position: 0, addedInVersion: 1, retiredInVersion: null }]
		});
		const [published] = entries(target);
		expect(published.querySelector('select')).toBeNull();
		expect(textOf(published.querySelector('[data-kind]')!)).toBe('Pick one of its choices');
		// Code review F8: the fixed kind is named by text, and no <label for> points at what is not a field.
		expect(textOf(published.querySelector('[data-name="kind"]')!)).toBe('Kind');
		const labelled = (label: Element) => document.getElementById(label.getAttribute('for')!)?.tagName ?? 'none';
		expect([...published.querySelectorAll('label[for]')].filter((label) => !['INPUT', 'TEXTAREA', 'SELECT'].includes(labelled(label))).map(textOf)).toEqual([]);
		expect(textOf(published.querySelector('[data-note="published"]')!)).toBe(
			'Published: its kind is fixed, so remove it and add a new question to ask another kind. A change to anything but its help asks everyone again when the decision is re-published.'
		);
		// An agent's question carries the label; its Mark reviewed waits while it has edits not yet saved (R16).
		expect(published.querySelector('.agent-label[data-section="survey.41"]')).not.toBeNull();
		type(fieldIn(published, 'Prompt'), 'Where do you ship from now?');
		expect(button(published, 'Mark survey question 1 reviewed').getAttribute('aria-disabled')).toBe('true');

		button(target, '+ Add survey question').click();
		flushSync();
		const added = entries(target)[1];
		expect(fieldIn(added, 'Kind').tagName).toBe('SELECT');
		expect(added.querySelector('[data-note="published"]')).toBeNull();
		choose(fieldIn(added, 'Kind'), 'text');
		type(fieldIn(added, 'Prompt'), 'Anything else?');

		// R23: no option is published, so the vote mode is still offered, and sent as chosen.
		expect(target.querySelector('[data-note="mode-free"]')).not.toBeNull();
		choose(fieldLabelled(target, 'Vote mode') as unknown as HTMLSelectElement, 'score');
		answer('PUT /api/decisions/5', { decision: decision(opened), options: [], surveyQuestions: [], revision: 'rev-2' });
		button(target, 'Save').click();
		await settle();
		const [body] = requests('PUT /api/decisions/5');
		expect(body.voteMode).toBe('score');
		expect(body.content.surveyQuestions).toEqual([
			{ ...SHIP, prompt: 'Where do you ship from now?' },
			{ kind: 'text', prompt: 'Anything else?', help: '', required: false }
		]);

		// Once an option is published the vote mode is fixed, as before.
		const voting = drawEditor({
			decision: decision({ ...opened, content: content() }),
			options: OPTIONS.map((option) => ({ ...option, addedInVersion: 1 }))
		});
		expect(voting.querySelector('select[id$="-vote"]')).toBeNull();
		expect(voting.querySelector('[data-note="mode-free"]')).toBeNull();
		expect(textOf(voting.querySelector('p[id$="-vote"]')!)).toBe('One choice');
	});

	it("F5: a vote mode a key chose on an opened survey carries the agent label and its own Mark reviewed, which waits while the mode has an unsaved change", () => {
		const opened = { status: 'open', shownStatus: 'open', currentVersion: 1, content: content({ options: [], surveyQuestions: [SHIP], agentDrafted: { voteMode: true } }) };
		const target = drawEditor({ decision: decision(opened), options: [], surveyQuestions: [{ id: 41, position: 0, addedInVersion: 1, retiredInVersion: null }] });
		const label = target.querySelector('.agent-label[data-section="voteMode"]')!;
		expect(label).not.toBeNull();
		expect(textOf(label.parentElement!)).toContain('Vote mode');
		const review = button(target, 'Mark Vote mode reviewed');
		expect(review.getAttribute('aria-disabled')).toBeNull();

		choose(fieldLabelled(target, 'Vote mode') as unknown as HTMLSelectElement, 'score');
		expect(review.getAttribute('aria-disabled')).toBe('true');
		expect(target.querySelector('[data-save-first="voteMode"]')).not.toBeNull();
	});
});

// ─── The board's decision list ──────────────────────────────────────────────

describe("the board's decision list (case 31)", () => {
	const listRow = (id: number, title: string, mayEdit: boolean) => ({
		id,
		title,
		status: 'open',
		shownStatus: 'open',
		authorName: 'editor',
		deciderName: 'bob',
		closesAt: '2099-12-01 12:00:00',
		updatedAt: '2026-11-02 08:30:00',
		mayEdit
	});

	it('31: New decision posts the title and goes to its editor; every opened row links to its page, and to its editor too where the caller may edit it; a draft links to its editor alone, or is plain text', async () => {
		const draft = (id: number, title: string, mayEdit: boolean) => ({ ...listRow(id, title, mayEdit), status: 'draft', shownStatus: 'draft' });
		const target = draw(BoardDecisionsPage, {
			data: {
				board: { id: 7, name: 'Website' },
				canCreate: true,
				decisions: [listRow(40, 'Pick a host', true), listRow(41, 'Pick a font', false), draft(43, 'Pick a logo', true), draft(44, 'Pick a name', false)]
			}
		});
		// Card 2680 (decisions 26 and 28): All decisions goes to the register for this board, and the list listens to
		// this board's `decision` events alone.
		expect(target.querySelector('[data-action="all"]')!.getAttribute('href')).toBe('/decisions?board=7');
		const { connectLiveRefresh } = await import('$lib/live-refresh');
		expect(vi.mocked(connectLiveRefresh).mock.calls.at(-1)?.[2]).toEqual({ events: ['decision'], boardId: 7 });
		const rows = [...target.querySelectorAll<HTMLElement>('tbody tr')];
		// Card 2677 (F4): an opened decision's title links to its page.
		expect(rows.map((r) => [...r.querySelector('td')!.querySelectorAll('a')].map((a) => [textOf(a), a.getAttribute('href')]))).toEqual([
			[
				['Pick a host', '/decisions/40'],
				['Edit', '/decisions/40/edit']
			],
			[['Pick a font', '/decisions/41']],
			[['Pick a logo', '/decisions/43/edit']],
			[]
		]);
		expect(textOf(rows[3].querySelector('td')!)).toBe('Pick a name');
		expect(textOf(rows[0])).toContain('2099-12-01 12:00 UTC');

		button(target, 'New decision').click();
		flushSync();
		const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="New decision"]')!;
		type(dialog.querySelector<HTMLInputElement>('input')!, 'Pick a supplier');
		answer('POST /api/boards/7/decisions', { decision: { id: 42 }, revision: 'rev-1' }, 201);
		button(dialog, 'Make draft').click();
		await settle();
		expect(requests('POST /api/boards/7/decisions')).toEqual([{ title: 'Pick a supplier' }]);
		expect(navigation.goto).toHaveBeenCalledWith('/decisions/42/edit');
	});
});
