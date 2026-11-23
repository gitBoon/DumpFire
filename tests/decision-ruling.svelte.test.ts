// @vitest-environment jsdom
/**
 * The results page, the ruling form and the release, in the page (card 2679,
 * slice 2a: the plan's cases 43 to 45), and the participant's screens (slice
 * 2b: cases 41, 42 and 46 to 48). Each component and page is mounted alone
 * with Svelte's client runtime, as the decision editor's file mounts them,
 * `fetch` a stand-in that keeps every request sent and answers what the case
 * gives it.
 *
 *   - `RulingBanner`: the ruling or none of these, the reason and the
 *     conditions with no moment, and the later and earlier decisions, named
 *     and linked only where the page was given them (S8).
 *   - `ReleasedResults`: "withheld", with no number, for what is withheld
 *     (code review S3), the comments with no name, and the table's headers.
 *   - `ConcernForm`: a labelled textarea with its count, who sees a concern,
 *     what it sends each way in, a refusal in the server's words, and the
 *     concern recorded joining the list.
 *   - The decision page: the ruling banner, Results and ruling and
 *     Supersede… only with their flags, and Supersede going to the new
 *     draft's editor; `DecisionActions`' Results and ruling link.
 *
 *   - `RulingForm`: the options in a fieldset with a legend, the warning that
 *     a choice goes against the responses, named by each radio, the people an
 *     early ruling cuts off, Rule held back by an open question, the JSON body
 *     sent with the password, and what a refusal does (F5).
 *   - The results page's release: the preview, Leave out by each comment and
 *     the `omit` it sends, the dialog's words and password, and the server's
 *     words in the status region.
 *   - `ResultsView`: a header for each column and row of the tally, earlier
 *     rounds closed, and the tables that stack at phone width.
 *   - `GroupBreakdown` (card 2686, U1 to U4): the current round per group in
 *     single and score mode and in a survey round, and no panel without one.
 *
 * What the server answers, and to whom, is in `tests/decision-ruling.test.ts`.
 * The plan is `docs/planning/card-2679-results-ruling.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { DecisionPageData, GroupTally, ReleasedResults as Released, ResultFlag, ResultRow, ResultsData, RoundTally, RulingRecord, RulingView, SurveyTally } from '$lib/decision-view-types';

const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async (_to: string) => {}) }));
vi.mock('$app/navigation', () => ({
	goto: navigation.goto,
	invalidateAll: navigation.invalidateAll,
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import ConcernForm from '$lib/components/decision/ConcernForm.svelte';
import DecisionActions from '$lib/components/decision/DecisionActions.svelte';
import ReleasedResults from '$lib/components/decision/ReleasedResults.svelte';
import ResultsView from '$lib/components/decision/ResultsView.svelte';
import RulingBanner from '$lib/components/decision/RulingBanner.svelte';
import RulingForm from '$lib/components/decision/RulingForm.svelte';
import { CONCERN_WHO_SEES, FLAG_REPLIES_CLOSED, FLAG_REPLY_ELSEWHERE, flagReplyWhoSees, NO_OPTIONS_PUT, NO_OPTIONS_TO_RELEASE, RELEASE_INFERENCE, RESULTS_READ_AGAIN, STALE_REVISION } from '$lib/decision-words';
import DecisionPage from '../src/routes/decisions/[id]/+page.svelte';
import ResultsPage from '../src/routes/decisions/[id]/results/+page.svelte';
import { CODE, codeFieldIn } from './helpers/step-up-code';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** Each request sent, as `METHOD url`, with its headers and its body as sent. */
let sent: { what: string; headers: Record<string, string>; body: unknown }[] = [];
/** What the next request to each `METHOD url` is answered; anything else is `{}`. */
let answers: Record<string, { status: number; body: unknown }[]> = {};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const JSON_TYPE = { 'Content-Type': 'application/json' };

beforeEach(() => {
	sent = [];
	answers = {};
	navigation.invalidateAll.mockClear();
	navigation.goto.mockClear();
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
const answer = (what: string, status: number, body: unknown) => (answers[what] ??= []).push({ status, body });
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
function choose(radio: HTMLInputElement) {
	radio.checked = true;
	radio.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}

const OPTIONS = [
	{ optionId: 11, label: 'A', title: 'Plan A' },
	{ optionId: 12, label: 'B', title: 'Plan B' }
];
const WRONG = { message: 'Password is incorrect. Nothing was changed.', stepUp: 'wrong' };

// ─── RulingForm (case 43) ────────────────────────────────────────────────────

describe('RulingForm (43)', () => {
	function drawForm(more: Record<string, unknown> = {}) {
		const onRuled = vi.fn(async () => {});
		const target = draw(RulingForm, {
			decisionId: 7,
			title: 'Which plan?',
			revision: 'rev-1',
			options: OPTIONS,
			mostChosen: [11],
			voted: 3,
			early: false,
			cutOff: [],
			openQuestions: 0,
			onRuled,
			...more
		});
		return { target, onRuled };
	}
	const radios = (target: HTMLElement) => [...target.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
	const ruleButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
	const reasonOf = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('textarea')!;
	const rule = (target: HTMLElement) => {
		target.querySelector<HTMLFormElement>('[data-form="ruling"]')!.requestSubmit();
		flushSync();
	};

	it('draws the options and none of these in a fieldset with a legend, and labelled texts with their counts', () => {
		const { target } = drawForm();
		const fieldset = target.querySelector('fieldset')!;
		expect(textOf(fieldset.querySelector('legend')!)).toBe('The ruling');
		expect(radios(target).map((radio) => textOf(radio.closest('label')!))).toEqual(['Option A: Plan A', 'Option B: Plan B', 'None of these']);
		expect(radios(target).every((radio) => fieldset.contains(radio))).toBe(true);
		for (const area of target.querySelectorAll('textarea')) {
			expect(target.querySelector(`label[for="${area.id}"]`), area.id).not.toBeNull();
			expect(area.maxLength).toBe(4000);
			expect(target.querySelector(`#${area.getAttribute('aria-describedby')}`)?.textContent).toMatch(/^0 of 4,000 characters$/);
		}
	});

	it('warns only when the choice is not most chosen, the warning named by every radio', () => {
		const { target } = drawForm();
		const warning = () => target.querySelector('[data-note="against"]');

		choose(radios(target)[0]);
		expect(warning(), 'the most chosen').toBeNull();
		expect(radios(target)[0].getAttribute('aria-describedby')).toBeNull();

		choose(radios(target)[1]);
		expect(textOf(warning()!)).toMatch(/^This goes against the responses/);
		for (const radio of radios(target)) expect(radio.getAttribute('aria-describedby')).toBe(warning()!.id);

		choose(radios(target)[2]);
		expect(warning(), 'none of these, with votes').not.toBeNull();

		const quiet = drawForm({ voted: 0, mostChosen: [] });
		choose(radios(quiet.target)[1]);
		expect(quiet.target.querySelector('[data-note="against"]'), 'no votes').toBeNull();
	});

	it('names who an early ruling cuts off', () => {
		const { target } = drawForm({ early: true, cutOff: [{ name: 'Sil Ent', reached: true }, { name: 'Qui Et', reached: true }] });
		const note = target.querySelector('[data-note="early"]')!;
		expect([...note.querySelectorAll('li')].map(textOf)).toEqual(['Sil Ent', 'Qui Et']);
		expect(textOf(note.querySelector('p')!)).toBe('The decision is still open: ruling now is early, and cuts off these people who have not responded:');
		expect(drawForm().target.querySelector('[data-note="early"]')).toBeNull();
	});

	it('marks each one the round’s request never reached, and the dialog counts them (card 2738)', () => {
		const { target } = drawForm({
			early: true,
			cutOff: [
				{ name: 'Sil Ent', reached: true },
				{ name: 'Moe Ved', reached: false },
				{ name: 'Lef Tus', reached: false }
			]
		});
		const note = target.querySelector('[data-note="early"]')!;
		expect([...note.querySelectorAll('li')].map(textOf)).toEqual([
			'Sil Ent',
			"Moe Ved (never reached by this round's request)",
			"Lef Tus (never reached by this round's request)"
		]);
		expect(note.querySelectorAll('[data-note="not-reached"]')).toHaveLength(2);

		choose(radios(target)[0]);
		typeInto(reasonOf(target), 'Plan A.');
		rule(target);
		expect(textOf(dialog()!)).toContain("3 who have not responded are cut off, 2 of them never reached by this round's request.");
	});

	it('says nothing of reach in the dialog when the request reached everyone cut off (card 2738)', () => {
		const { target } = drawForm({ early: true, cutOff: [{ name: 'Sil Ent', reached: true }] });
		choose(radios(target)[0]);
		typeInto(reasonOf(target), 'Plan A.');
		rule(target);
		expect(textOf(dialog()!)).toContain('1 who have not responded are cut off.');
		expect(textOf(dialog()!)).not.toContain('never reached');
		expect(target.querySelector('[data-note="not-reached"]')).toBeNull();
	});

	it('says a decision closed before its closing time is ruled early, and names who it cuts off (card 2727)', () => {
		const { target } = drawForm({ early: true, closedEarly: true, cutOff: [{ name: 'Sil Ent', reached: true }] });
		const note = target.querySelector('[data-note="early"]')!;
		expect(textOf(note.querySelector('p')!)).toBe('The decision was closed before its closing time: ruling now is early, and cuts off these people who have not responded:');
		expect([...note.querySelectorAll('li')].map(textOf)).toEqual(['Sil Ent']);
	});

	it('keeps Rule off until a choice, a reason and, with a question open, the box', () => {
		const { target } = drawForm({ openQuestions: 2 });
		expect(ruleButton(target).disabled).toBe(true);
		choose(radios(target)[0]);
		typeInto(reasonOf(target), 'Plan A is enough.');
		expect(ruleButton(target).disabled, 'the box unticked').toBe(true);
		const box = target.querySelector<HTMLInputElement>('[data-check="open-questions"]')!;
		expect(textOf(box.closest('label')!)).toBe('2 questions are still open: I rule with them open');
		box.click();
		flushSync();
		expect(ruleButton(target).disabled).toBe(false);
	});

	it('sends the ruling as JSON with the password, and hands up what was done', async () => {
		const { target, onRuled } = drawForm({ openQuestions: 1 });
		choose(radios(target)[2]);
		typeInto(reasonOf(target), 'Neither works.');
		target.querySelector<HTMLInputElement>('[data-check="open-questions"]')!.click();
		flushSync();
		rule(target);
		expect(passwordIn()).not.toBeNull();
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 200, { decision: {}, revision: 'rev-2' });
		confirmButton().click();
		await settle();

		expect(sent).toEqual([
			{
				what: 'POST /api/decisions/7/rule',
				headers: JSON_TYPE,
				// Card 2684 (R8): with no request to talk open, `openTalksConfirmed` false.
				body: JSON.stringify({
					optionId: null,
					reason: 'Neither works.',
					conditions: '',
					revision: 'rev-1',
					openQuestionsConfirmed: true,
					openTalksConfirmed: false,
					currentPassword: 'my password',
					currentCode: CODE
				})
			}
		]);
		expect(dialog()).toBeNull();
		expect(onRuled).toHaveBeenCalledWith('Ruled: every participant is being mailed the ruling.');
	});

	it('keeps the dialog open on a refused password, and says any other refusal in its status region, the focus back on Rule', async () => {
		const { target, onRuled } = drawForm();
		choose(radios(target)[0]);
		typeInto(reasonOf(target), 'Plan A.');
		rule(target);
		typeInto(passwordIn()!, 'a wrong one');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 403, WRONG);
		confirmButton().click();
		await settle();
		expect(dialog()).not.toBeNull();
		expect(passwordIn()!.value).toBe('');
		expect(textOf(dialog()!.querySelector('[role="alert"]')!)).toBe(WRONG.message);

		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 409, { message: 'Someone has changed this decision since you opened it: reload the page' });
		confirmButton().click();
		await settle();
		expect(dialog()).toBeNull();
		const region = target.querySelector('[data-said="ruling"]')!;
		expect(region.getAttribute('role')).toBe('status');
		expect(textOf(region)).toBe('Someone has changed this decision since you opened it: reload the page');
		expect(document.activeElement).toBe(ruleButton(target));
		expect(onRuled).not.toHaveBeenCalled();
		expect(navigation.invalidateAll, 'another 409 reads nothing again').not.toHaveBeenCalled();
	});

	it('reads the page again on a stale revision, keeps the choice, the reason and the conditions, unticks the box, and rules with the fresh revision (card 2734, D3)', async () => {
		const onRuled = vi.fn(async () => {});
		const props = $state({
			decisionId: 7,
			title: 'Which plan?',
			revision: 'rev-1',
			options: OPTIONS,
			mostChosen: [11],
			voted: 3,
			early: false,
			cutOff: [] as { name: string; reached: boolean }[],
			openQuestions: 1,
			onRuled
		});
		// The page's load run again: the results and their revision come back together.
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.revision = 'rev-2';
		});
		const target = draw(RulingForm, props);
		const [reason, conditions] = target.querySelectorAll<HTMLTextAreaElement>('textarea');
		const box = () => target.querySelector<HTMLInputElement>('[data-check="open-questions"]')!;
		choose(radios(target)[1]);
		typeInto(reason, 'B lasts longer.');
		typeInto(conditions, 'Reviewed in a year.');
		box().click();
		flushSync();
		rule(target);
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 409, { message: STALE_REVISION });
		confirmButton().click();
		await settle();

		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(dialog()).toBeNull();
		expect(textOf(target.querySelector('[data-said="ruling"]')!)).toBe(RESULTS_READ_AGAIN);
		expect(radios(target)[1].checked, 'the choice kept').toBe(true);
		expect(reason.value).toBe('B lasts longer.');
		expect(conditions.value).toBe('Reviewed in a year.');
		expect(box().checked, 'the open questions confirmed again').toBe(false);
		expect(ruleButton(target).disabled).toBe(true);
		expect(document.activeElement, 'the focus on the words, Rule being off').toBe(target.querySelector('[data-said="ruling"]'));

		box().click();
		flushSync();
		rule(target);
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 200, { decision: {}, revision: 'rev-3' });
		confirmButton().click();
		await settle();

		expect(sent.map((request) => JSON.parse(request.body as string))).toEqual([
			{ optionId: 12, reason: 'B lasts longer.', conditions: 'Reviewed in a year.', revision: 'rev-1', openQuestionsConfirmed: true, openTalksConfirmed: false, currentPassword: 'my password', currentCode: CODE },
			{ optionId: 12, reason: 'B lasts longer.', conditions: 'Reviewed in a year.', revision: 'rev-2', openQuestionsConfirmed: true, openTalksConfirmed: false, currentPassword: 'my password', currentCode: CODE }
		]);
		expect(onRuled).toHaveBeenCalledTimes(1);
	});

	it('says the server’s words to reload when the page cannot be read again after a stale revision (card 2734, code review 2026-11-05)', async () => {
		navigation.invalidateAll.mockImplementationOnce(async () => {
			throw new Error('The page could not be read.');
		});
		const { target, onRuled } = drawForm();
		choose(radios(target)[0]);
		typeInto(reasonOf(target), 'Plan A.');
		rule(target);
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 409, { message: STALE_REVISION });
		confirmButton().click();
		await settle();

		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(dialog()).toBeNull();
		const region = target.querySelector('[data-said="ruling"]')!;
		expect(textOf(region)).toBe(STALE_REVISION);
		expect(textOf(region)).not.toBe(RESULTS_READ_AGAIN);
		expect(document.activeElement).toBe(region);
		expect(reasonOf(target).value, 'the reason kept').toBe('Plan A.');
		expect(onRuled).not.toHaveBeenCalled();
	});

	it('holds Rule off once the option chosen is no longer offered after the page is read again (card 2734, D3)', () => {
		// Code review 2026-11-05: A is the most chosen, so B shows the against warning first, and only `offered` takes it away.
		const props = $state({ decisionId: 7, title: 'Which plan?', revision: 'rev-1', options: OPTIONS, mostChosen: [11], voted: 3, early: false, cutOff: [], openQuestions: 0, onRuled: async () => {} });
		const target = draw(RulingForm, props);
		choose(radios(target)[1]);
		typeInto(reasonOf(target), 'B lasts longer.');
		expect(ruleButton(target).disabled).toBe(false);
		expect(textOf(target.querySelector('[data-note="against"]')!), 'B goes against the responses while offered').toMatch(/^This goes against the responses/);

		props.options = [OPTIONS[0]];
		props.revision = 'rev-2';
		flushSync();
		expect(radios(target).map((radio) => radio.checked)).toEqual([false, false]);
		expect(ruleButton(target).disabled).toBe(true);
		expect(target.querySelector('[data-note="against"]'), 'no warning for a choice not offered').toBeNull();
		expect(radios(target)[0].getAttribute('aria-describedby'), 'no radio names a warning not drawn').toBeNull();
		expect(reasonOf(target).value).toBe('B lasts longer.');
	});
});

// ─── The results page and its release (cases 44 and 45) ──────────────────────

const tally = (round: number, more: Partial<RoundTally> = {}): RoundTally => ({
	round,
	responded: 3,
	voted: 2,
	votes: [
		{ optionId: 11, count: 2 },
		{ optionId: 12, count: 0 }
	],
	scores: [],
	abstained: 1,
	noConcerns: 0,
	survey: [],
	rows: [
		{
			participantId: 1,
			name: 'Pat Person',
			role: 'consulted',
			groups: ['Ops'],
			kind: 'vote',
			optionId: 11,
			scores: null,
			comment: 'Plan A is enough.',
			optionComments: { '12': 'B costs too much.' },
			answers: {},
			versionNumber: 1,
			createdAt: '2026-11-03 10:00:00',
			via: 'session',
			changes: 1
		}
	],
	...more
});

function results(more: Partial<ResultsData> = {}): ResultsData {
	return {
		decision: {
			id: 7,
			title: 'Which plan?',
			shownStatus: 'ruled',
			voteMode: 'single',
			closesAt: '2026-11-02 09:00:00',
			deciderName: 'decider',
			boardId: 3,
			boardName: 'The board',
			currentVersion: 2
		},
		revision: 'rev-1',
		round: 2,
		options: OPTIONS,
		surveyQuestions: [],
		current: tally(2),
		earlierRounds: [tally(1, { responded: 1 })],
		notResponded: [{ participantId: 4, name: 'Sil Ent', groups: [], reached: true }],
		// Card 2686: no breakdown, so no panel.
		groupBreakdown: [],
		removed: [],
		openQuestions: [],
		mayAnswerQuestions: false,
		concerns: [],
		// Card 2684 (R23): nothing raised; the decider may reply.
		flags: [],
		mayReply: true,
		ruling: null,
		released: null,
		releasePreview: {
			voteMode: 'single',
			responded: null,
			voted: null,
			abstained: null,
			noConcerns: 0,
			options: [
				{ optionId: 11, label: 'A', title: 'Plan A', votes: null, mean: null, comments: [] },
				{ optionId: 12, label: 'B', title: 'Plan B', votes: 0, mean: null, comments: [{ text: 'B costs too much.', key: 'key-b' }] }
			],
			comments: [
				{ text: 'A, gladly.', key: 'key-1' },
				{ text: 'Plan A is enough.', key: 'key-2' }
			]
		},
		mayRule: false,
		rulesEarly: false,
		mayRelease: true,
		releaseRefusal: null,
		mostChosen: [11],
		...more
	};
}

describe('the ruling form on the results page (card 2727)', () => {
	const awaiting = (rulesEarly: boolean, shownStatus: 'open' | 'awaiting_ruling') =>
		draw(ResultsPage, {
			data: results({
				decision: { ...results().decision, shownStatus },
				ruling: null,
				released: null,
				releasePreview: null,
				mayRule: true,
				mayRelease: false,
				rulesEarly,
				notResponded: [
					{ participantId: 9, name: 'Sil Ent', groups: [], reached: true },
					{ participantId: 10, name: 'Moe Ved', groups: [], reached: false }
				]
			})
		}).querySelector('[data-note="early"]');

	it('names who is cut off by the server rule: closed early, still open, and neither', () => {
		expect(textOf(awaiting(true, 'awaiting_ruling')!.querySelector('p')!)).toMatch(/^The decision was closed before its closing time: ruling now is early/);
		expect(textOf(awaiting(true, 'open')!.querySelector('p')!)).toMatch(/^The decision is still open: ruling now is early/);
		expect(awaiting(false, 'awaiting_ruling'), 'closed at or after its closing time').toBeNull();
	});

	it('hands the form whom the request never reached (card 2738)', () => {
		expect([...awaiting(true, 'open')!.querySelectorAll('li')].map(textOf)).toEqual(['Sil Ent', "Moe Ved (never reached by this round's request)"]);
	});
});

describe('the release on the results page (44)', () => {
	const release = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('[data-action="release"]')!;
	const box = (target: HTMLElement, key: string) => target.querySelector<HTMLInputElement>(`[data-omit="${key}"]`)!;

	it('shows the preview, each comment with Leave out, and sends omit with the ticked keys, the password and the revision', async () => {
		const target = draw(ResultsPage, { data: results() });
		const preview = target.querySelector('[data-block="release"]')!;
		// Drawn by ReleasedResults, as every viewer is shown it (code review F3), each withheld figure "withheld" (S3).
		expect(preview.querySelector('[data-table="preview"]')).not.toBeNull();
		expect(textOf(preview.querySelector('caption')!)).toBe('Responded: withheld');
		expect([...preview.querySelectorAll('tbody tr')].map((row) => [...row.children].map(textOf))).toEqual([
			['A: Plan A', 'withheld'],
			['B: Plan B', '0'],
			['Abstained', 'withheld'],
			['No concerns', '0']
		]);
		expect(['key-1', 'key-2', 'key-b'].map((key) => textOf(box(target, key).closest('label')!))).toEqual(['Leave out', 'Leave out', 'Leave out']);
		// Code review F4: each box is described by the comment it leaves out.
		expect(['key-1', 'key-2', 'key-b'].map((key) => textOf(document.getElementById(box(target, key).getAttribute('aria-describedby')!)!))).toEqual([
			'A, gladly.',
			'Plan A is enough.',
			'B costs too much.'
		]);
		expect(textOf(preview)).not.toContain('Pat Person');

		box(target, 'key-2').click();
		box(target, 'key-b').click();
		flushSync();
		release(target).click();
		flushSync();
		expect(textOf(dialog()!)).toContain(RELEASE_INFERENCE);
		expect(textOf(dialog()!)).toContain('2 comments are left out.');
		expect(passwordIn()).not.toBeNull();
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/release', 200, { decision: {}, revision: 'rev-2' });
		confirmButton().click();
		await settle();

		expect(sent).toEqual([
			{ what: 'POST /api/decisions/7/release', headers: JSON_TYPE, body: JSON.stringify({ revision: 'rev-1', omit: ['key-2', 'key-b'], currentPassword: 'my password', currentCode: CODE }) }
		]);
		expect(navigation.invalidateAll).toHaveBeenCalled();
		const region = target.querySelector<HTMLElement>('[data-said="done"]')!;
		expect(textOf(region)).toMatch(/^Released: everyone who can see this decision/);
		expect(document.activeElement).toBe(region);
	});

	it('keeps a wrong password’s refusal in the dialog, and says the server’s other refusal on the page, the focus back on the control', async () => {
		const target = draw(ResultsPage, { data: results() });
		release(target).click();
		flushSync();
		typeInto(passwordIn()!, 'a wrong one');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/release', 403, WRONG);
		confirmButton().click();
		await settle();
		expect(dialog()).not.toBeNull();
		expect(textOf(dialog()!.querySelector('[role="alert"]')!)).toBe(WRONG.message);

		const TOO_FEW = 'Fewer than 3 people responded: releasing their comments could show who said what';
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/release', 409, { message: TOO_FEW });
		confirmButton().click();
		await settle();
		expect(dialog()).toBeNull();
		expect(textOf(target.querySelector('[data-said="refused"]')!)).toBe(TOO_FEW);
		expect(target.querySelector('[data-said="done"]')!.getAttribute('role')).toBe('status');
		expect(document.activeElement).toBe(release(target));
	});

	it('reads the page again on a stale revision, keeps the ticks, and releases with the fresh revision (card 2734, D4)', async () => {
		const props = $state({ data: results() });
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.data = results({ revision: 'rev-2' });
		});
		const target = draw(ResultsPage, props);
		box(target, 'key-b').click();
		flushSync();
		const releaseOnce = async (status: number, body: unknown) => {
			release(target).click();
			flushSync();
			typeInto(passwordIn()!, 'my password');
			typeCode(dialog()!);
			answer('POST /api/decisions/7/release', status, body);
			confirmButton().click();
			await settle();
		};
		await releaseOnce(409, { message: STALE_REVISION });

		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(textOf(target.querySelector('[data-said="refused"]')!)).toBe(RESULTS_READ_AGAIN);
		expect(box(target, 'key-b').checked, 'the tick kept').toBe(true);

		await releaseOnce(200, { decision: {}, revision: 'rev-3' });
		expect(sent.map((request) => JSON.parse(request.body as string))).toEqual([
			{ revision: 'rev-1', omit: ['key-b'], currentPassword: 'my password', currentCode: CODE },
			{ revision: 'rev-2', omit: ['key-b'], currentPassword: 'my password', currentCode: CODE }
		]);
	});

	it('drops the tick of a comment the page no longer shows once it is read again (card 2734, code review 2026-11-05)', async () => {
		const props = $state({ data: results() });
		const fresh = results().releasePreview!;
		// Read again, the preview no longer shows the comment on B (key-b), nor B's comment list at all.
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.data = results({ revision: 'rev-2', releasePreview: { ...fresh, options: fresh.options.map((option) => ({ ...option, comments: [] })) } });
		});
		const target = draw(ResultsPage, props);
		box(target, 'key-1').click();
		box(target, 'key-b').click();
		flushSync();
		const releaseOnce = async (status: number, body: unknown) => {
			release(target).click();
			flushSync();
			typeInto(passwordIn()!, 'my password');
			typeCode(dialog()!);
			answer('POST /api/decisions/7/release', status, body);
			confirmButton().click();
			await settle();
		};
		await releaseOnce(409, { message: STALE_REVISION });

		expect(textOf(target.querySelector('[data-said="refused"]')!)).toBe(RESULTS_READ_AGAIN);
		expect(target.querySelector('[data-omit="key-b"]'), 'the comment no longer drawn').toBeNull();
		expect(box(target, 'key-1').checked, 'the tick of a comment still shown kept').toBe(true);
		release(target).click();
		flushSync();
		expect(textOf(dialog()!)).toContain('1 comment is left out.');
		document.querySelectorAll<HTMLButtonElement>('.confirm-actions button')[0].click();
		await settle();

		await releaseOnce(200, { decision: {}, revision: 'rev-3' });
		expect(sent.map((request) => JSON.parse(request.body as string))).toEqual([
			{ revision: 'rev-1', omit: ['key-1', 'key-b'], currentPassword: 'my password', currentCode: CODE },
			{ revision: 'rev-2', omit: ['key-1'], currentPassword: 'my password', currentCode: CODE }
		]);
	});

	it('says the server’s words to reload, and keeps the ticks, when the page cannot be read again after a stale revision (card 2734, code review 2026-11-05)', async () => {
		navigation.invalidateAll.mockImplementationOnce(async () => {
			throw new Error('The page could not be read.');
		});
		const target = draw(ResultsPage, { data: results() });
		box(target, 'key-b').click();
		flushSync();
		release(target).click();
		flushSync();
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/release', 409, { message: STALE_REVISION });
		confirmButton().click();
		await settle();

		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(dialog()).toBeNull();
		const refused = target.querySelector('[data-said="refused"]')!;
		expect(textOf(refused)).toBe(STALE_REVISION);
		expect(textOf(refused)).not.toBe(RESULTS_READ_AGAIN);
		expect(box(target, 'key-b').checked, 'the tick kept').toBe(true);
		expect(document.activeElement).toBe(release(target));
	});

	it('offers no release, saying why, where the server gives a refusal, and none once released', () => {
		const refused = draw(ResultsPage, { data: results({ mayRelease: false, releaseRefusal: 'The results of this decision have already been released' }) });
		expect(refused.querySelector('[data-action="release"]')).toBeNull();
		expect(refused.querySelector('[data-omit]')).toBeNull();
		expect(textOf(refused.querySelector('[data-note="release-refusal"]')!)).toBe('The results of this decision have already been released');

		const done = draw(ResultsPage, { data: results({ releasePreview: null, mayRelease: false, released: { at: '2026-11-04 09:00:00', byName: 'decider', omitted: 1 } }) });
		expect(done.querySelector('[data-block="release"]')).toBeNull();
		expect(textOf(done.querySelector('[data-note="released"]')!)).toBe('The results were released on 2026-11-04 09:00 UTC by decider, with 1 comment left out.');
	});
});

describe('ResultsView (45)', () => {
	it('heads each column and row of the tally, keeps earlier rounds closed, and labels every cell of its stacked tables by its column', () => {
		const target = draw(ResultsView, { results: results() });
		const [current] = target.querySelectorAll<HTMLTableElement>('[data-table="tally"]');
		expect([...current.querySelectorAll('thead th')].map((th) => [th.getAttribute('scope'), textOf(th)])).toEqual([
			['col', 'Option'],
			['col', 'Votes']
		]);
		expect([...current.querySelectorAll('tbody th')].map((th) => [th.getAttribute('scope'), textOf(th)])).toEqual([
			['row', 'A: Plan A'],
			['row', 'B: Plan B'],
			['row', 'Abstained'],
			['row', 'No concerns']
		]);
		expect([...current.querySelectorAll('tbody td')].map((td) => td.getAttribute('data-label'))).toEqual(['Votes', 'Votes', 'Votes', 'Votes']);

		const responses = target.querySelector('[data-table="responses"]')!;
		expect([...responses.querySelectorAll('thead th')].map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col', 'col']);
		expect([...responses.querySelector('tbody tr')!.children].map(textOf)).toEqual([
			'Pat Person (Ops)',
			'A: Plan A',
			'Plan A is enough.On B: B costs too much.',
			'2026-11-03 10:00 UTC, changed 1 time'
		]);

		const earlier = target.querySelectorAll<HTMLDetailsElement>('details.earlier');
		expect(earlier).toHaveLength(1);
		expect(earlier[0].open).toBe(false);
		expect(textOf(earlier[0].querySelector('summary')!)).toBe('Round 1');

		// Code review F5: what the stacked layout draws at phone width. Its rule hides each table's header row and labels every
		// cell from its `data-label`, so every table must carry the class, and every cell the header of its own column.
		const tables = [...target.querySelectorAll('table')];
		expect(tables.length).toBe(4);
		for (const table of tables) {
			expect(table.classList.contains('stacked')).toBe(true);
			const headers = [...table.querySelectorAll('thead th')].map(textOf);
			for (const row of table.querySelectorAll('tbody tr')) {
				const [rowHeader, ...cells] = [...row.children];
				expect(rowHeader.tagName).toBe('TH');
				expect(cells.length).toBeLessThanOrEqual(headers.length - 1);
				cells.forEach((cell, index) => expect(cell.getAttribute('data-label'), `${textOf(rowHeader)}: column ${index + 1}`).toBe(headers[index + 1]));
			}
		}
		expect([...target.querySelectorAll('[data-list="not-responded"] li')].map(textOf)).toEqual(['Sil Ent']);
	});

	it('gives score mode the totals and means by option, and who voted, abstained and had no concerns as counts in a column of their own (code review F6)', () => {
		const scored = tally(2, {
			voted: 2,
			votes: [],
			scores: [
				{ optionId: 11, total: 9, mean: 4.5 },
				{ optionId: 12, total: 3, mean: 1.5 }
			],
			abstained: 1,
			noConcerns: 0,
			rows: []
		});
		const target = draw(ResultsView, { results: results({ decision: { ...results().decision, voteMode: 'score' }, current: scored, earlierRounds: [] }) });
		const [byOption] = target.querySelectorAll<HTMLTableElement>('[data-table="tally"]');
		expect([...byOption.querySelectorAll('thead th')].map(textOf)).toEqual(['Option', 'Total score', 'Mean']);
		expect([...byOption.querySelectorAll('tbody tr')].map((row) => [...row.children].map(textOf))).toEqual([
			['A: Plan A', '9', '4.5'],
			['B: Plan B', '3', '1.5']
		]);
		const counts = target.querySelector('[data-table="counts"]')!;
		expect([...counts.querySelectorAll('thead th')].map(textOf)).toEqual(['Answer', 'Count']);
		expect([...counts.querySelectorAll('tbody tr')].map((row) => [...row.children].map(textOf))).toEqual([
			['Voted', '2'],
			['Abstained', '1'],
			['No concerns', '0']
		]);
		expect(counts.classList.contains('stacked')).toBe(true);
	});

	it('gives the ruling with "against", "early" and who was cut off', () => {
		const target = draw(ResultsView, {
			results: results({
				ruling: {
					optionId: 12,
					label: 'B',
					title: 'Plan B',
					reason: 'B anyway.',
					conditions: null,
					early: true,
					closedEarly: false,
					againstResponses: true,
					cutOff: ['Sil Ent'],
					cutOffReached: [true],
					supersededOld: null,
					byName: 'decider',
					at: '2026-11-04 09:00:00'
				}
			})
		});
		const ruling = textOf(target.querySelector('[data-block="ruling"]')!);
		expect(ruling).toContain('Ruled on Option B: Plan B');
		expect(ruling).toContain('Against the responses Yes');
		expect(ruling).toContain('Early Yes: ruled while the decision was open');
		expect(ruling).toContain('Cut off Sil Ent');
	});

	it('says how a ruling was early: while open, or after a close before the closing time; and No when not early (card 2738, code review R6)', () => {
		const earlyWords = (early: boolean, closedEarly: boolean) => {
			const target = draw(ResultsView, {
				results: results({
					ruling: {
						optionId: 12,
						label: 'B',
						title: 'Plan B',
						reason: 'B anyway.',
						conditions: null,
						early,
						closedEarly,
						againstResponses: false,
						cutOff: [],
						cutOffReached: [],
						supersededOld: null,
						byName: 'decider',
						at: '2026-11-04 09:00:00'
					}
				})
			});
			const ruling = target.querySelector('[data-block="ruling"]')!;
			const terms = [...ruling.querySelectorAll('dt')].map(textOf);
			return textOf(ruling.querySelectorAll('dd')[terms.indexOf('Early')]);
		};
		expect(earlyWords(true, false)).toBe('Yes: ruled while the decision was open');
		expect(earlyWords(true, true)).toBe('Yes: ruled after it was closed before its closing time');
		expect(earlyWords(false, false)).toBe('No');
	});

	it('marks a cut-off and a non-responder the request never reached, and leaves one recorded before card 2738 unmarked (card 2738)', () => {
		const target = draw(ResultsView, {
			results: results({
				notResponded: [
					{ participantId: 4, name: 'Sil Ent', groups: ['Ops'], reached: true },
					{ participantId: 5, name: 'Moe Ved', groups: [], reached: false }
				],
				ruling: {
					optionId: 12,
					label: 'B',
					title: 'Plan B',
					reason: 'B anyway.',
					conditions: null,
					early: true,
					closedEarly: false,
					againstResponses: false,
					cutOff: ['Sil Ent', 'Moe Ved', 'Old Timer'],
					cutOffReached: [true, false, null],
					supersededOld: null,
					byName: 'decider',
					at: '2026-11-04 09:00:00'
				}
			})
		});
		expect([...target.querySelectorAll('[data-list="not-responded"] li')].map(textOf)).toEqual([
			'Sil Ent (Ops)',
			"Moe Ved (never reached by this round's request)"
		]);
		expect(textOf(target.querySelector('[data-block="ruling"]')!)).toContain("Cut off Sil Ent, Moe Ved (never reached by this round's request), Old Timer");
	});
});

// ─── The participant's screens (cases 41, 42 and 46 to 48) ───────────────────

const RULING: RulingView = { label: 'B', title: 'Plan B', noneOfThese: false, reason: 'B lasts longer.', conditions: 'Review in a year.', ruledByName: 'Dee Cider' };

describe('RulingBanner (41)', () => {
	const lines = (target: HTMLElement) => Object.fromEntries([...target.querySelectorAll<HTMLElement>('[data-line]')].map((line) => [line.dataset.line, textOf(line)]));

	it('says the option or none of these, then the reason and the conditions, and no moment', () => {
		const target = draw(RulingBanner, { ruling: RULING });
		expect(lines(target)).toEqual({ ruling: 'Ruled by Dee Cider: Option B: Plan B', reason: 'Why: B lasts longer.', conditions: 'Conditions: Review in a year.' });
		expect(textOf(target)).not.toMatch(/\d{4}-\d{2}-\d{2}|UTC|against|early/i);

		const none = draw(RulingBanner, { ruling: { ...RULING, label: null, title: null, noneOfThese: true, conditions: null } });
		expect(lines(none)).toEqual({ ruling: 'Ruled by Dee Cider: None of these', reason: 'Why: B lasts longer.' });
	});

	it('names and links a later decision only where it was given, says one ruled without superseding, and an earlier one by title or not', () => {
		const linked = draw(RulingBanner, { ruling: RULING, laterDecision: { superseded: true, id: 9, title: 'Plan C' } });
		const later = linked.querySelector('[data-line="later"]')!;
		expect(textOf(later)).toBe('Superseded by Plan C');
		expect(later.querySelector('a')!.getAttribute('href')).toBe('/decisions/9');

		const unnamed = draw(RulingBanner, { ruling: RULING, laterDecision: { superseded: true } });
		expect(textOf(unnamed.querySelector('[data-line="later"]')!)).toBe('Superseded by a later decision');
		expect(unnamed.querySelector('a')).toBeNull();

		const beside = draw(RulingBanner, { ruling: RULING, laterDecision: { superseded: false, id: 9, title: 'Plan C' } });
		expect(textOf(beside.querySelector('[data-line="later"]')!)).toBe('A later decision, Plan C, was ruled on without superseding this one');

		const earlier = draw(RulingBanner, { ruling: RULING, supersedes: { id: 4, title: 'Plan A first' } });
		expect(textOf(earlier.querySelector('[data-line="earlier"]')!)).toBe('This decision supersedes Plan A first');
		expect(earlier.querySelector('[data-line="earlier"] a')!.getAttribute('href')).toBe('/decisions/4');

		const earlierUnnamed = draw(RulingBanner, { ruling: RULING, supersedes: {} });
		expect(textOf(earlierUnnamed.querySelector('[data-line="earlier"]')!)).toBe('This decision supersedes an earlier decision');
		expect(earlierUnnamed.querySelector('a')).toBeNull();
	});
});

const RELEASED: Released = {
	voteMode: 'single',
	responded: null,
	voted: null,
	abstained: 0,
	noConcerns: null,
	options: [
		{ optionId: 11, label: 'A', title: 'Plan A', votes: 3, mean: null, comments: ['Cheap.'] },
		{ optionId: 12, label: 'B', title: 'Plan B', votes: null, mean: null, comments: [] }
	],
	comments: ['A, gladly.', 'Either works.']
};

describe('ReleasedResults (42)', () => {
	it('says "withheld", with no number, for a withheld figure and a withheld total, under a header for each column and row (code review S3)', () => {
		const target = draw(ReleasedResults, { released: RELEASED });
		const table = target.querySelector('[data-table="released"]')!;
		expect(textOf(table.querySelector('caption')!)).toBe('Responded: withheld');
		expect([...table.querySelectorAll('thead th')].map((th) => [th.getAttribute('scope'), textOf(th)])).toEqual([
			['col', 'Option'],
			['col', 'Votes']
		]);
		expect([...table.querySelectorAll('tbody tr')].map((row) => [row.querySelector('th')!.getAttribute('scope'), ...[...row.children].map(textOf)])).toEqual([
			['row', 'A: Plan A', '3'],
			['row', 'B: Plan B', 'withheld'],
			['row', 'Abstained', '0'],
			['row', 'No concerns', 'withheld']
		]);
		expect(textOf(target)).not.toMatch(/fewer than|or more/);

		const shown = draw(ReleasedResults, { released: { ...RELEASED, voteMode: 'score', responded: 6, options: [{ ...RELEASED.options[0], votes: null, mean: 3.5 }] } });
		expect(textOf(shown.querySelector('caption')!)).toBe('Responded: 6');
		expect(textOf(shown.querySelectorAll('thead th')[1])).toBe('Mean score');
		expect(textOf(shown.querySelector('tbody td')!)).toBe('3.5');
	});

	it('gives the comments as given, overall and on each option, with no name beside any', () => {
		const target = draw(ReleasedResults, { released: RELEASED });
		expect([...target.querySelectorAll('[data-list="comments"] li')].map(textOf)).toEqual(['A, gladly.', 'Either works.']);
		expect([...target.querySelectorAll('[data-list="option-11"] li')].map(textOf)).toEqual(['Cheap.']);
		expect(target.querySelector('[data-list="option-12"]')).toBeNull();
		expect(textOf(target)).not.toMatch(/Dee Cider|\d{4}-\d{2}-\d{2}/);
	});
});

describe('ConcernForm (46)', () => {
	const area = (target: HTMLElement) => target.querySelector<HTMLTextAreaElement>('textarea')!;
	const sendButton = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('[data-action="concern"]')!;

	it('labels its textarea with a count, and says who sees a concern and that a release never includes one', () => {
		const target = draw(ConcernForm, { url: '/api/decisions/5/concerns', mayRaise: true });
		const field = area(target);
		expect(textOf(target.querySelector(`label[for="${field.id}"]`)!)).toBe('Your concern about the ruling');
		expect(field.maxLength).toBe(4000);
		const count = () => textOf(target.querySelector(`#${field.getAttribute('aria-describedby')}`)!);
		expect(count()).toBe('0 of 4,000 characters');
		typeInto(field, 'Too soon.');
		expect(count()).toBe('9 of 4,000 characters');
		expect(textOf(target.querySelector('[data-note="concern-who-sees"]')!)).toBe(CONCERN_WHO_SEES);
		expect(CONCERN_WHO_SEES).toMatch(/decider and DumpFire's administrators see your concern with your name/);
		expect(CONCERN_WHO_SEES).toMatch(/release of the results never includes concerns/);

		const closed = draw(ConcernForm, { url: '/api/decisions/5/concerns', mayRaise: false, concerns: [{ comment: 'Earlier.', createdAt: '2026-11-03 10:00:00' }] });
		expect(closed.querySelector('textarea')).toBeNull();
		expect([...closed.querySelectorAll('[data-list="concerns"] li')].map(textOf)).toEqual(['2026-11-03 10:00 UTC: Earlier.']);
	});

	it('sends { comment } signed in and { token, comment } by link, as JSON, and lists the concern recorded', async () => {
		const signedIn = draw(ConcernForm, { url: '/api/decisions/5/concerns', mayRaise: true });
		expect(sendButton(signedIn).disabled, 'nothing typed').toBe(true);
		typeInto(area(signedIn), 'Too soon.');
		answer('POST /api/decisions/5/concerns', 200, { concern: { comment: 'Too soon.', createdAt: '2026-11-04 10:00:00' } });
		sendButton(signedIn).click();
		await settle();

		const link = draw(ConcernForm, { url: '/api/decision-by-link/concerns', extra: { token: 'tok-1' }, mayRaise: true });
		typeInto(area(link), 'Not asked.');
		answer('POST /api/decision-by-link/concerns', 200, { concern: { comment: 'Not asked.', createdAt: '2026-11-04 10:01:00' } });
		sendButton(link).click();
		await settle();

		expect(sent).toEqual([
			{ what: 'POST /api/decisions/5/concerns', headers: JSON_TYPE, body: JSON.stringify({ comment: 'Too soon.' }) },
			{ what: 'POST /api/decision-by-link/concerns', headers: JSON_TYPE, body: JSON.stringify({ token: 'tok-1', comment: 'Not asked.' }) }
		]);
		expect([...signedIn.querySelectorAll('[data-list="concerns"] li')].map(textOf)).toEqual(['2026-11-04 10:00 UTC: Too soon.']);
		expect(area(signedIn).value).toBe('');
		expect(textOf(signedIn.querySelector('[data-said="concern"]')!)).toBe('Your concern was recorded on 2026-11-04 10:00 UTC.');
		// Code review F9: the page's data is read again after each, whose list and `mayRaise` the form then draws.
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(2);
	});

	it('draws the page’s list and offers no form where the page says none may be raised, as after the fifth (code review F9)', () => {
		const five = Array.from({ length: 5 }, (_, n) => ({ comment: `Concern ${n}.`, createdAt: `2026-11-04 10:0${n}:00` }));
		const target = draw(ConcernForm, { url: '/api/decisions/5/concerns', mayRaise: false, concerns: five });
		expect(target.querySelector('textarea')).toBeNull();
		expect(target.querySelector('[data-action="concern"]')).toBeNull();
		expect(target.querySelectorAll('[data-list="concerns"] li')).toHaveLength(5);
	});

	it('says a 429 in the server’s words in its status region, and keeps what was typed', async () => {
		const target = draw(ConcernForm, { url: '/api/decisions/5/concerns', mayRaise: true });
		typeInto(area(target), 'Again.');
		const WAIT = 'You raised a concern a moment ago: you can raise another from 2026-11-04 10:10 UTC';
		answer('POST /api/decisions/5/concerns', 429, { message: WAIT });
		sendButton(target).click();
		await settle();
		const region = target.querySelector('[data-said="concern"]')!;
		expect(region.getAttribute('role')).toBe('status');
		expect(textOf(region)).toBe(WAIT);
		expect(area(target).value).toBe('Again.');
		expect(target.querySelector('[data-list="concerns"]')).toBeNull();
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
	});
});

describe('the decision page and DecisionActions (47, 48)', () => {
	const DECISION = { id: 5, title: 'Pick a plan', shownStatus: 'ruled', voteMode: 'single', closesAt: null, deciderName: 'Dee Cider', boardName: 'Website', withdrawnAt: null, withdrawnReason: null } as const;
	const CONTENT = { situation: '', question: 'Which plan?', ask: '', unknowns: '', alreadyRuled: '', technicalDetail: '', stories: [], agentDrafted: {} };

	/** A ruled decision's page as a board reader who is no participant is given it. */
	function pageData(more: Partial<DecisionPageData> = {}): DecisionPageData {
		return {
			via: 'session',
			decision: DECISION,
			draft: false,
			version: { number: 1, publishedAt: '2026-11-01 09:00:00', content: CONTENT },
			options: [],
			surveyQuestions: [],
			audiences: [],
			participant: null,
			ownResponse: null,
			earlierResponse: null,
			mayRespond: false,
			stage: null,
			seenRecorded: false,
			mayEdit: false,
			signedInAs: null,
			ruling: RULING,
			released: null,
			concerns: [],
			mayRaiseConcern: false,
			supersedes: null,
			laterDecision: null,
			mayReadResults: false,
			maySupersede: false,
			// Card 2678: a board reader who is no participant reads no question, asks none and answers none.
			questions: [],
			mayAsk: false,
			mayAnswer: false,
			// Card 2684 (R22): nor raises or reads an objection or a request to talk.
			flags: [],
			mayObject: false,
			mayAskToTalk: false,
			...more
		};
	}
	const action = (target: HTMLElement, name: string) => target.querySelector<HTMLElement>(`[data-action="${name}"]`);

	it('47: shows the ruling to a viewer, Results and ruling and Supersede… only with their flags, and the results and the concern form only where given', () => {
		const reader = draw(DecisionPage, { data: pageData() });
		expect(textOf(reader.querySelector('[data-line="ruling"]')!)).toBe('Ruled by Dee Cider: Option B: Plan B');
		expect(action(reader, 'results')).toBeNull();
		expect(action(reader, 'supersede')).toBeNull();
		expect(reader.querySelector('[data-section="results"]')).toBeNull();
		expect(reader.querySelector('[data-section="concern"]')).toBeNull();

		const decider = draw(DecisionPage, {
			data: pageData({
				mayReadResults: true,
				maySupersede: true,
				released: RELEASED,
				participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: null },
				stage: 'ruling',
				mayRaiseConcern: true
			})
		});
		expect(action(decider, 'results')!.getAttribute('href')).toBe('/decisions/5/results');
		expect(textOf(action(decider, 'supersede')!)).toBe('Supersede…');
		expect(decider.querySelector('[data-section="results"] [data-table="released"]')).not.toBeNull();
		expect(decider.querySelector('[data-section="concern"] [data-action="concern"]')).not.toBeNull();
	});

	it('47: Supersede… sends the title as JSON and goes to the new draft’s editor; a refusal is said in the server’s words', async () => {
		const target = draw(DecisionPage, { data: pageData({ maySupersede: true }) });
		const toggle = action(target, 'supersede') as HTMLButtonElement;
		// Code review F9: aria-controls names the panel only while it is in the page.
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(toggle.getAttribute('aria-controls')).toBeNull();
		toggle.click();
		await settle();
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(document.getElementById(toggle.getAttribute('aria-controls')!)?.dataset.panel).toBe('supersede');
		const title = target.querySelector<HTMLInputElement>('#supersede-title')!;
		expect(title.value).toBe('Pick a plan');
		expect(document.activeElement).toBe(title);
		typeInto(title, 'Pick a plan, again');

		const submit = () => {
			target.querySelector<HTMLFormElement>('[data-panel="supersede"]')!.requestSubmit();
			flushSync();
		};
		answer('POST /api/decisions/5/supersede', 409, { message: 'A later decision that supersedes this one already exists' });
		submit();
		await settle();
		expect(textOf(target.querySelector('[data-said="supersede"]')!)).toBe('A later decision that supersedes this one already exists');
		expect(navigation.goto).not.toHaveBeenCalled();

		answer('POST /api/decisions/5/supersede', 201, { decision: { id: 9 }, revision: 'rev-9' });
		submit();
		await settle();
		expect(sent.map((request) => [request.what, request.headers, request.body])).toEqual([
			['POST /api/decisions/5/supersede', JSON_TYPE, JSON.stringify({ title: 'Pick a plan, again' })],
			['POST /api/decisions/5/supersede', JSON_TYPE, JSON.stringify({ title: 'Pick a plan, again' })]
		]);
		expect(navigation.goto).toHaveBeenCalledWith('/decisions/9/edit');
	});

	it('48: DecisionActions links to the results and ruling only with mayReadResults', () => {
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
		const props = { decisionId: 7, boardId: 3, title: 'Pick a plan', closesAt: null, revision: 'rev-1', actions: NONE, republishSummary: null, refusals: [], warnings: [], dirty: false, onSaved: async () => {} };
		const without = draw(DecisionActions, props);
		expect(action(without, 'results')).toBeNull();
		expect(textOf(without)).toContain('Nothing in its lifecycle can be done by you now.');

		const withResults = draw(DecisionActions, { ...props, mayReadResults: true });
		const link = action(withResults, 'results')!;
		expect(textOf(link)).toBe('Results and ruling');
		expect(link.getAttribute('href')).toBe('/decisions/7/results');
		expect(textOf(withResults)).not.toContain('Nothing in its lifecycle');
	});
});

// ─── Survey questions (card 2683, slice S3b: cases U6 and U7) ───────────────

describe('survey questions on the results and the ruling (card 2683)', () => {
	const row = (participantId: number, name: string, more: Partial<ResultRow>): ResultRow => ({
		participantId,
		name,
		role: 'consulted',
		groups: [],
		kind: 'answered',
		optionId: null,
		scores: null,
		comment: null,
		optionComments: {},
		answers: {},
		versionNumber: 1,
		createdAt: '2026-11-03 10:00:00',
		via: 'session',
		changes: 0,
		...more
	});
	// Version 2 asked the same question with its choices reordered (asked again, R8): each version's figures apart.
	const SURVEY: SurveyTally[] = [
		{
			versionNumber: 1,
			questions: [
				{ questionId: 41, kind: 'choice', prompt: 'Where do you ship from?', answered: 1, choices: [{ choice: 'Leeds', count: 1 }, { choice: 'York', count: 0 }], scale: null },
				{
					questionId: 42,
					kind: 'scale',
					prompt: 'How busy are you?',
					answered: 1,
					choices: null,
					scale: { max: 3, lowLabel: 'Quiet', highLabel: 'Flat out', counts: [{ value: 1, count: 0 }, { value: 2, count: 0 }, { value: 3, count: 1 }], mean: 3 }
				},
				{ questionId: 43, kind: 'text', prompt: 'Anything else?', answered: 1, choices: null, scale: null }
			]
		},
		{
			versionNumber: 2,
			questions: [{ questionId: 41, kind: 'choice', prompt: 'Where do you ship from?', answered: 1, choices: [{ choice: 'York', count: 0 }, { choice: 'Leeds', count: 1 }], scale: null }]
		}
	];
	const surveyed = (more: Partial<ResultsData> = {}) =>
		results({
			options: [],
			surveyQuestions: [{ questionId: 41, kind: 'choice', prompt: 'Where do you ship from?', help: '', required: true, choices: ['York', 'Leeds'] }],
			current: tally(2, {
				responded: 3,
				voted: 0,
				votes: [],
				abstained: 1,
				survey: SURVEY,
				rows: [
					row(1, 'Pat Person', { answers: { '41': 0, '42': 3, '43': 'We ship on Tuesdays' } }),
					row(2, 'Sam Sender', { versionNumber: 2, answers: { '41': 1 } }),
					row(3, 'Abe Stain', { kind: 'abstain' })
				]
			}),
			earlierRounds: [],
			releasePreview: null,
			mayRelease: false,
			mostChosen: [],
			...more
		});
	const SURVEY_RULING: RulingRecord = {
		optionId: null,
		label: null,
		title: null,
		reason: 'Leeds it is.',
		conditions: null,
		early: false,
		closedEarly: false,
		againstResponses: false,
		cutOff: [],
		cutOffReached: [],
		supersededOld: null,
		byName: 'decider',
		at: '2026-11-04 09:00:00',
		noOptions: true
	};
	const rowsOf = (table: Element) => [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(textOf));

	it('U6: a survey round is counted as answered and abstained; each question’s figures are given per version, by its words; each answer by prompt, a written one with its name', () => {
		const target = draw(ResultsView, { results: surveyed() });
		expect(target.querySelector('[data-table="tally"]')).toBeNull();
		expect(rowsOf(target.querySelector('[data-table="survey-counts"]')!)).toEqual([
			['Answered the survey', '2'],
			['Abstained', '1']
		]);

		const [first, second] = [...target.querySelectorAll<HTMLElement>('[data-survey-version]')];
		expect([first.dataset.surveyVersion, second.dataset.surveyVersion]).toEqual(['1', '2']);
		expect(textOf(first.querySelector('h4')!)).toBe('Survey questions, as version 1 asked them');
		const [choice, scale] = [...first.querySelectorAll('[data-table="survey"]')];
		expect(textOf(choice.querySelector('caption')!)).toBe('1. Where do you ship from?: 1 answered');
		expect(rowsOf(choice)).toEqual([
			['Leeds', '1'],
			['York', '0']
		]);
		expect(textOf(scale.querySelector('caption')!)).toBe('2. How busy are you?: 1 answered, mean 3.0 of 3');
		expect(rowsOf(scale)).toEqual([
			['1 (Quiet)', '0'],
			['2', '0'],
			['3 (Flat out)', '1']
		]);
		expect(textOf(first.querySelector('.survey-text')!)).toBe('3. Anything else?: 1 answered. Each written answer is in the responses, with its name.');
		expect(rowsOf(second.querySelector('[data-table="survey"]')!)).toEqual([
			['York', '0'],
			['Leeds', '1']
		]);

		const responses = target.querySelector('[data-table="responses"]')!;
		expect([...responses.querySelectorAll('thead th')].map(textOf)).toEqual(['Who', 'Answer', 'Survey answers', 'Comments', 'Given']);
		const byName = Object.fromEntries([...responses.querySelectorAll('tbody tr')].map((tr) => [textOf(tr.children[0]), tr]));
		expect(textOf(byName['Pat Person'].children[1])).toBe('Answered the survey');
		expect([...byName['Pat Person'].querySelectorAll('[data-answer]')].map(textOf)).toEqual([
			'Where do you ship from?: Leeds',
			'How busy are you?: 3 of 3',
			'Anything else?: We ship on Tuesdays'
		]);
		// Given under version 2, so labelled by its words: index 1 there is Leeds, never York by position.
		expect([...byName['Sam Sender'].querySelectorAll('[data-answer]')].map(textOf)).toEqual(['Where do you ship from?: Leeds']);
		expect(textOf(byName['Abe Stain'].children[1])).toBe('Abstained');
		expect(textOf(target)).not.toContain('None of these');
	});

	it('F7: an earlier survey round where everyone abstained is counted as a survey, with no option table; the vote round after it as a vote', () => {
		const target = draw(ResultsView, {
			results: results({
				current: tally(2),
				earlierRounds: [tally(1, { responded: 2, voted: 0, votes: [], scores: [], abstained: 2, rows: [row(1, 'Pat Person', { kind: 'abstain' }), row(2, 'Sam Sender', { kind: 'abstain' })] })]
			})
		});
		const [current, earlier] = [...target.querySelectorAll<HTMLElement>('[data-table="tally"], [data-table="survey-counts"]')];
		expect(current.dataset.table).toBe('tally');
		expect(earlier.dataset.table).toBe('survey-counts');
		expect(rowsOf(earlier)).toEqual([
			['Answered the survey', '0'],
			['Abstained', '2']
		]);
		expect(target.querySelectorAll('[data-table="tally"]')).toHaveLength(1);
	});

	it('U6: a release and its preview of a decision with options hold no survey answer or figure', () => {
		const voting = results({
			current: tally(2, {
				survey: [SURVEY[1]],
				rows: [row(1, 'Pat Person', { kind: 'vote', optionId: 11, comment: 'Plan A is enough.', versionNumber: 2, answers: { '41': 1 } })]
			})
		});
		const target = draw(ResultsPage, { data: voting });
		expect([...target.querySelectorAll('[data-table="responses"] [data-answer]')].map(textOf)).toEqual(['Where do you ship from?: Leeds']);
		const release = target.querySelector('[data-block="release"]')!;
		expect(release.querySelector('[data-table="preview"]')).not.toBeNull();
		expect(textOf(release)).not.toMatch(/Leeds|York|ship from|survey/i);
	});

	it('U7: the ruling form on a survey offers no option and says no options were put to a vote; the ruling is sent with none, and said so', async () => {
		const onRuled = vi.fn(async () => {});
		const target = draw(RulingForm, {
			decisionId: 7,
			title: 'Where to ship from?',
			revision: 'rev-1',
			options: [],
			mostChosen: [],
			voted: 0,
			early: false,
			cutOff: [],
			openQuestions: 0,
			onRuled
		});
		expect(target.querySelector('input[type="radio"]')).toBeNull();
		expect(target.querySelector('fieldset')).toBeNull();
		expect(textOf(target)).not.toContain('None of these');
		expect(textOf(target.querySelector('[data-note="no-options"]')!)).toContain(NO_OPTIONS_PUT);
		const rule = target.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
		expect(rule.disabled).toBe(true);
		typeInto(target.querySelector<HTMLTextAreaElement>('textarea')!, 'Leeds it is.');
		expect(rule.disabled).toBe(false);
		target.querySelector<HTMLFormElement>('[data-form="ruling"]')!.requestSubmit();
		flushSync();
		expect(textOf(dialog()!)).toContain('"Where to ship from?" is ruled for good on no option, as none were put to a vote');
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 200, { decision: {}, revision: 'rev-2' });
		confirmButton().click();
		await settle();
		expect(sent.map((request) => JSON.parse(String(request.body)).optionId)).toEqual([null]);
		expect(onRuled).toHaveBeenCalledTimes(1);

		const banner = draw(RulingBanner, { ruling: { label: null, title: null, noneOfThese: true, reason: 'Leeds it is.', conditions: null, ruledByName: 'Dee Cider', noOptions: true } });
		expect(textOf(banner.querySelector('[data-line="ruling"]')!)).toBe(`Ruled by Dee Cider: ${NO_OPTIONS_PUT}`);

		const page = draw(ResultsPage, { data: surveyed({ ruling: SURVEY_RULING, releaseRefusal: NO_OPTIONS_TO_RELEASE }) });
		expect(textOf(page.querySelector('[data-block="ruling"] dd')!)).toBe(NO_OPTIONS_PUT);
		expect(page.querySelector('[data-block="release"]')).toBeNull();
		expect(textOf(page.querySelector('[data-note="release-refusal"]')!)).toBe(NO_OPTIONS_TO_RELEASE);
	});
});

// ─── Objections and requests to talk on the results page (card 2684, slice S3: U4 and U5) ─

describe('objections and requests to talk on the results page (card 2684)', () => {
	const flag = (flagId: number, more: Partial<ResultFlag> = {}): ResultFlag => ({
		flagId,
		kind: 'objection',
		name: 'Pat Person',
		reason: 'The cost is not covered.',
		raisedAt: '2026-11-02 10:00:00',
		via: 'session',
		versionNumber: 2,
		reply: null,
		repliedByName: null,
		repliedAt: null,
		...more
	});
	const FLAGS = [
		flag(21, { reply: 'We have **budget**.', repliedByName: 'Dee Cider', repliedAt: '2026-11-02 11:00:00' }),
		flag(22, { kind: 'talk', name: 'Ivy Informed', reason: '', raisedAt: '2026-11-02 12:00:00' }),
		flag(23, { name: 'Lin Holder', reason: 'Not <b>this</b> one.', raisedAt: '2026-11-02 13:00:00', via: 'link' })
	];
	const awaiting = (more: Partial<ResultsData> = {}) =>
		results({ decision: { ...results().decision, shownStatus: 'awaiting_ruling' }, ruling: null, released: null, releasePreview: null, mayRelease: false, flags: FLAGS, ...more });
	const panel = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-block="flags"]')!;
	const items = (target: HTMLElement) => [...panel(target).querySelectorAll<HTMLElement>('li[data-flag]')];
	const boxIn = (item: HTMLElement) => item.querySelector<HTMLTextAreaElement>('form[data-form="reply"] textarea');

	it('U4: lists the flags, unanswered objections first, a reply box for the decider under who reads it, none for an administrator; the replier by name', async () => {
		const target = draw(ResultsPage, { data: awaiting() });
		expect(textOf(panel(target).querySelector('h2')!)).toBe('Objections and requests to talk');
		expect(panel(target).id).toBe('flags');
		expect(items(target).map((item) => [item.getAttribute('data-flag'), item.getAttribute('data-flag-kind')])).toEqual([
			['23', 'objection'],
			['21', 'objection'],
			['22', 'talk']
		]);
		const [lin, pat, ivy] = items(target);
		expect(textOf(lin.querySelector('.line')!)).toBe('Objection from Lin Holder 2026-11-02 13:00 UTC, by link, version 2');
		expect(textOf(lin.querySelector('[data-text="reason"]')!)).toBe('Not <b>this</b> one.');
		expect(lin.querySelector('[data-text="reason"] b'), 'plain text').toBeNull();
		// The replier by name alone, the reply as written.
		expect(textOf(pat.querySelector('[data-note="replied"]')!)).toBe('Answered by Dee Cider, 2026-11-02 11:00 UTC:');
		expect(textOf(pat.querySelector('[data-text="reply"]')!)).toBe('We have **budget**.');
		expect(boxIn(pat), 'no box once replied').toBeNull();
		expect(textOf(ivy.querySelector('.meta:not([data-note])')!)).toBe('2026-11-02 12:00 UTC, version 2');

		// The decider's boxes, each under who reads the reply, named by it.
		for (const [item, name] of [
			[lin, 'Lin Holder'],
			[ivy, 'Ivy Informed']
		] as const) {
			const box = boxIn(item)!;
			const whoSees = item.querySelector('[data-note="reply-who-sees"]')!;
			expect(textOf(whoSees)).toBe(flagReplyWhoSees(name));
			expect(box.getAttribute('aria-describedby')!.split(' ')).toContain(whoSees.id);
			expect(item.querySelector(`label[for="${box.id}"]`), 'labelled').not.toBeNull();
			expect(box.maxLength).toBe(4000);
		}
		expect(textOf(lin.querySelector('button')!)).toBe('Send answer');
		expect(textOf(ivy.querySelector('button')!)).toBe('Record outcome');
		expect(lin.querySelector<HTMLButtonElement>('button')!.disabled, 'an empty reply').toBe(true);

		typeInto(boxIn(lin)!, 'The budget covers it.');
		answer('POST /api/decisions/7/flags/23/reply', 200, { flag: flag(23, { reply: 'The budget covers it.' }) });
		lin.querySelector<HTMLButtonElement>('button')!.click();
		await settle();
		expect(sent.map((request) => [request.what, JSON.parse(String(request.body))])).toEqual([['POST /api/decisions/7/flags/23/reply', { reply: 'The budget covers it.' }]]);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		const region = panel(target).querySelector<HTMLElement>('[data-said="flag-reply"]')!;
		expect(textOf(region)).toBe("Your answer to Lin Holder's objection was recorded.");
		expect(document.activeElement).toBe(region);

		// A refusal in the server's words, the reply kept.
		typeInto(boxIn(ivy)!, 'We spoke.');
		answer('POST /api/decisions/7/flags/22/reply', 409, { message: 'The outcome of this request to talk has already been recorded' });
		ivy.querySelector<HTMLButtonElement>('button')!.click();
		await settle();
		expect(textOf(region)).toBe('The outcome of this request to talk has already been recorded');
		expect(boxIn(ivy)!.value).toBe('We spoke.');

		// An administrator: the same list, with names, and no box.
		const admin = draw(ResultsPage, { data: awaiting({ mayReply: false }) });
		expect(items(admin)).toHaveLength(3);
		expect(panel(admin).querySelector('form, textarea, [data-note="reply-who-sees"]')).toBeNull();
		expect(textOf(panel(admin).querySelector('[data-note="reply-elsewhere"]')!)).toBe(FLAG_REPLY_ELSEWHERE);
		expect(textOf(items(admin)[0].querySelector('[data-note="no-reply"]')!)).toBe('Not answered yet');

		// Ruled: a talk's outcome may still be recorded, an objection's answer no longer.
		const ruled = draw(ResultsPage, { data: results({ flags: FLAGS }) });
		const [ruledLin, , ruledIvy] = items(ruled);
		expect(boxIn(ruledLin), 'an objection after the ruling').toBeNull();
		expect(boxIn(ruledIvy), 'a talk after the ruling').not.toBeNull();

		// Nothing raised: no panel.
		expect(draw(ResultsPage, { data: results() }).querySelector('[data-block="flags"]')).toBeNull();
	});

	it('U5: Rule is off with objections unanswered, naming the count and linking to them; an open request to talk adds a box sent as openTalksConfirmed', async () => {
		const target = draw(ResultsPage, { data: awaiting({ mayRule: true, flags: [...FLAGS, flag(24, { name: 'Sam' })] }) });
		const form = target.querySelector<HTMLElement>('[data-form="ruling"]')!;
		const rule = form.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
		const note = form.querySelector('[data-note="objections"]')!;
		expect(textOf(note)).toBe('2 objections have no answer: answer each before ruling. Go to the objections');
		expect(note.querySelector('a')!.getAttribute('href')).toBe('#flags');
		expect(document.getElementById('flags'), 'the link’s target').toBe(panel(target));
		choose(form.querySelector<HTMLInputElement>('input[type="radio"]')!);
		typeInto(form.querySelector<HTMLTextAreaElement>('textarea')!, 'Plan A.');
		const talks = form.querySelector<HTMLInputElement>('[data-check="open-talks"]')!;
		expect(textOf(talks.closest('label')!)).toBe('1 request to talk has no outcome recorded: I rule with it open');
		talks.click();
		flushSync();
		expect(rule.disabled, 'no box gets past an unanswered objection').toBe(true);

		// The form alone: one objection, two requests to talk, and then none unanswered.
		const onRuled = vi.fn(async () => {});
		const alone = draw(RulingForm, {
			decisionId: 7,
			title: 'Which plan?',
			revision: 'rev-1',
			options: OPTIONS,
			mostChosen: [11],
			voted: 3,
			early: false,
			cutOff: [],
			openQuestions: 0,
			unansweredObjections: 1,
			openTalks: 2,
			onRuled
		});
		expect(textOf(alone.querySelector('[data-note="objections"]')!)).toBe('1 objection has no answer: answer it before ruling. Go to the objections');
		const box = alone.querySelector<HTMLInputElement>('[data-check="open-talks"]')!;
		expect(textOf(box.closest('label')!)).toBe('2 requests to talk have no outcome recorded: I rule with them open');
		choose(alone.querySelector<HTMLInputElement>('input[type="radio"]')!);
		typeInto(alone.querySelector<HTMLTextAreaElement>('textarea')!, 'Plan A.');
		box.click();
		flushSync();
		const ruleAlone = alone.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
		expect(ruleAlone.disabled).toBe(true);

		const answered = draw(RulingForm, { ...{ decisionId: 7, title: 'Which plan?', revision: 'rev-1', options: OPTIONS, mostChosen: [11], voted: 3, early: false, cutOff: [], openQuestions: 0 }, openTalks: 1, onRuled });
		expect(answered.querySelector('[data-note="objections"]')).toBeNull();
		choose(answered.querySelector<HTMLInputElement>('input[type="radio"]')!);
		typeInto(answered.querySelector<HTMLTextAreaElement>('textarea')!, 'Plan A.');
		const ruleAnswered = answered.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
		expect(ruleAnswered.disabled, 'the box unticked').toBe(true);
		answered.querySelector<HTMLInputElement>('[data-check="open-talks"]')!.click();
		flushSync();
		expect(ruleAnswered.disabled).toBe(false);
		answered.querySelector<HTMLFormElement>('[data-form="ruling"]')!.requestSubmit();
		flushSync();
		typeInto(passwordIn()!, 'my password');
		typeCode(dialog()!);
		answer('POST /api/decisions/7/rule', 200, { decision: {}, revision: 'rev-2' });
		confirmButton().click();
		await settle();
		expect(sent.map((request) => JSON.parse(String(request.body)))).toEqual([
			{ optionId: 11, reason: 'Plan A.', conditions: '', revision: 'rev-1', openQuestionsConfirmed: false, openTalksConfirmed: true, currentPassword: 'my password', currentCode: CODE }
		]);
		expect(onRuled).toHaveBeenCalledTimes(1);
	});

	it('U9 (card 2684): on a withdrawn decision, replies are said to be closed, to the decider and an administrator alike, and nobody is told someone else replies (code review C-E-L1)', () => {
		const withdrawn = (more: Partial<ResultsData> = {}) =>
			results({ decision: { ...results().decision, shownStatus: 'withdrawn' }, ruling: null, released: null, releasePreview: null, mayRelease: false, flags: FLAGS, mayReply: false, ...more });
		const target = draw(ResultsPage, { data: withdrawn() });
		expect(textOf(panel(target).querySelector('[data-note="replies-closed"]')!)).toBe(FLAG_REPLIES_CLOSED);
		expect(panel(target).querySelector('[data-note="reply-elsewhere"]'), 'never "someone else replies" on a withdrawn decision').toBeNull();
		expect(panel(target).querySelector('form, textarea')).toBeNull();
		// Every flag replied to: nothing waits, so neither is said.
		const settled = draw(ResultsPage, { data: withdrawn({ flags: [FLAGS[0]] }) });
		expect(panel(settled).querySelector('[data-note="replies-closed"], [data-note="reply-elsewhere"]')).toBeNull();
		// Not withdrawn, an administrator is still told who replies, and not that replies are closed.
		const admin = draw(ResultsPage, { data: awaiting({ mayReply: false }) });
		expect(textOf(panel(admin).querySelector('[data-note="reply-elsewhere"]')!)).toBe(FLAG_REPLY_ELSEWHERE);
		expect(panel(admin).querySelector('[data-note="replies-closed"]')).toBeNull();
	});

	it('U11 (card 2684): a refused reply leaves the focus in its box, what was typed kept; a recorded one moves it to the status region (code review C-E-L5)', async () => {
		const target = draw(ResultsPage, { data: awaiting() });
		const [lin, , ivy] = items(target);
		const region = panel(target).querySelector<HTMLElement>('[data-said="flag-reply"]')!;
		typeInto(boxIn(ivy)!, 'We spoke.');
		ivy.querySelector<HTMLButtonElement>('button')!.focus();
		answer('POST /api/decisions/7/flags/22/reply', 400, { message: 'reply must be at most 4000 characters' });
		ivy.querySelector<HTMLButtonElement>('button')!.click();
		await settle();
		expect(textOf(region)).toBe('reply must be at most 4000 characters');
		expect(document.activeElement, 'the focus in the box').toBe(boxIn(ivy));
		expect(boxIn(ivy)!.value).toBe('We spoke.');

		typeInto(boxIn(lin)!, 'The budget covers it.');
		answer('POST /api/decisions/7/flags/23/reply', 200, { flag: flag(23, { reply: 'The budget covers it.' }) });
		lin.querySelector<HTMLButtonElement>('button')!.click();
		await settle();
		expect(document.activeElement, 'recorded: the region').toBe(region);
	});

	it('U12 (card 2684): the open-questions and open-talks boxes are unticked whenever how many are open changes (code review C-E-L6)', () => {
		const props = $state({ decisionId: 7, title: 'Which plan?', revision: 'rev-1', options: OPTIONS, mostChosen: [11], voted: 3, early: false, cutOff: [], openQuestions: 1, openTalks: 1, onRuled: async () => {} });
		const target = draw(RulingForm, props);
		const questions = () => target.querySelector<HTMLInputElement>('[data-check="open-questions"]')!;
		const talks = () => target.querySelector<HTMLInputElement>('[data-check="open-talks"]')!;
		const rule = target.querySelector<HTMLButtonElement>('[data-action="rule"]')!;
		choose(target.querySelector<HTMLInputElement>('input[type="radio"]')!);
		typeInto(target.querySelector<HTMLTextAreaElement>('textarea')!, 'Plan A.');
		questions().click();
		talks().click();
		flushSync();
		expect(rule.disabled).toBe(false);

		// Another request to talk arrives: its box is unticked, the questions' kept.
		props.openTalks = 2;
		flushSync();
		expect([questions().checked, talks().checked], 'a talk more').toEqual([true, false]);
		expect(rule.disabled).toBe(true);
		talks().click();
		flushSync();
		expect(rule.disabled).toBe(false);

		// Another question: its box is unticked, the talks' kept.
		props.openQuestions = 2;
		flushSync();
		expect([questions().checked, talks().checked], 'a question more').toEqual([false, true]);
		expect(rule.disabled).toBe(true);

		// Read again with the same numbers: the ticks stay.
		questions().click();
		flushSync();
		props.revision = 'rev-2';
		flushSync();
		expect([questions().checked, talks().checked], 'the same numbers').toEqual([true, true]);
		expect(rule.disabled).toBe(false);
	});
});

// ─── The group breakdown (card 2686, cases U1 to U4) ────────────────────────

describe('GroupBreakdown (card 2686)', () => {
	const NOTE =
		'Each person is counted in every group they were in when they were included; people in no group are under No group, so the groups do not add up to the total. ' +
		"Only the decider and DumpFire's administrators see this, and it is never released.";
	/** A group's figures: none unless given. */
	const group = (name: string | null, more: Partial<GroupTally> = {}): GroupTally => ({
		name,
		consulted: 0,
		responded: 0,
		voted: 0,
		votes: [],
		scores: [],
		abstained: 0,
		noConcerns: 0,
		mostChosen: [],
		...more
	});
	const table = (target: HTMLElement) => target.querySelector<HTMLTableElement>('[data-table="groups"]')!;
	const headersOf = (groups: HTMLTableElement) => [...groups.querySelectorAll('thead th')].map(textOf);
	const rowsOf = (groups: HTMLTableElement) => [...groups.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map(textOf));

	it('U1: a table under the round’s tally and before each response: a row per group and No group, each option’s votes, abstained, no concerns, most chosen with "tied", each cell labelled, and the note', () => {
		const target = draw(ResultsView, {
			results: results({
				groupBreakdown: [
					group('Development', { consulted: 3, responded: 3, voted: 2, votes: [{ optionId: 11, count: 1 }, { optionId: 12, count: 1 }], abstained: 1, mostChosen: [11, 12] }),
					group('<b>Finance</b>', { consulted: 2, responded: 1, voted: 1, votes: [{ optionId: 11, count: 1 }, { optionId: 12, count: 0 }], mostChosen: [11] }),
					group(null, { consulted: 2, responded: 1, votes: [{ optionId: 11, count: 0 }, { optionId: 12, count: 0 }], noConcerns: 1 })
				]
			})
		});
		const groups = table(target);
		expect(textOf(groups.querySelector('caption')!)).toBe('Round 2 by group');
		expect(headersOf(groups)).toEqual(['Group', 'Consulted', 'Responded', 'Votes for A', 'Votes for B', 'Abstained', 'No concerns', 'Most chosen']);
		expect([...groups.querySelectorAll('tbody th')].map((th) => th.getAttribute('scope'))).toEqual(['row', 'row', 'row']);
		expect(rowsOf(groups)).toEqual([
			['Development', '3', '3', '1', '1', '1', '0', 'A, B (tied)'],
			['<b>Finance</b>', '2', '1', '1', '0', '0', '0', 'A'],
			['No group', '2', '1', '0', '0', '0', '1', '–']
		]);
		// A group name is plain text, never markup.
		expect(groups.querySelector('tbody b')).toBeNull();
		// Stacked at phone width: every cell labelled by its own column.
		expect(groups.classList.contains('stacked')).toBe(true);
		for (const row of groups.querySelectorAll('tbody tr')) {
			expect([...row.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(headersOf(groups).slice(1));
		}
		expect(textOf(target.querySelector('[data-note="group-breakdown"]')!)).toBe(NOTE);
		// After the round's tally, before each response.
		const tables = [...target.querySelectorAll('table')].map((each) => each.getAttribute('data-table'));
		expect(tables.slice(0, 3)).toEqual(['tally', 'groups', 'responses']);
	});

	it('U2: score mode gives each option’s total and mean per group', () => {
		const target = draw(ResultsView, {
			results: results({
				decision: { ...results().decision, voteMode: 'score' },
				current: tally(2, { votes: [], scores: [{ optionId: 11, total: 9, mean: 4.5 }, { optionId: 12, total: 3, mean: 1.5 }], rows: [] }),
				earlierRounds: [],
				groupBreakdown: [
					group('Finance', { consulted: 2, responded: 2, voted: 2, scores: [{ optionId: 11, total: 9, mean: 4.5 }, { optionId: 12, total: 3, mean: 1.5 }], mostChosen: [11] }),
					group(null, { consulted: 1, scores: [{ optionId: 11, total: 0, mean: null }, { optionId: 12, total: 0, mean: null }] })
				]
			})
		});
		const groups = table(target);
		expect(headersOf(groups)).toEqual(['Group', 'Consulted', 'Responded', 'Total for A', 'Mean for A', 'Total for B', 'Mean for B', 'Abstained', 'No concerns', 'Most chosen']);
		expect(rowsOf(groups)).toEqual([
			['Finance', '2', '2', '9', '4.5', '3', '1.5', '0', '0', 'A'],
			['No group', '1', '0', '0', '–', '0', '–', '0', '0', '–']
		]);
	});

	it('U3: a survey round gives answered the survey and abstained per group, with no option column', () => {
		const target = draw(ResultsView, {
			results: results({
				options: [],
				current: tally(2, { voted: 0, votes: [], rows: [] }),
				earlierRounds: [],
				releasePreview: null,
				mostChosen: [],
				groupBreakdown: [group('Finance', { consulted: 3, responded: 2, abstained: 1 }), group(null, { consulted: 1, responded: 1 })]
			})
		});
		const groups = table(target);
		expect(headersOf(groups)).toEqual(['Group', 'Consulted', 'Responded', 'Answered the survey', 'Abstained']);
		expect(rowsOf(groups)).toEqual([
			['Finance', '3', '2', '1', '1'],
			['No group', '1', '1', '1', '0']
		]);
	});

	it('U4: an empty breakdown draws no panel', () => {
		const target = draw(ResultsView, { results: results({ groupBreakdown: [] }) });
		expect(target.querySelector('[data-table="groups"]')).toBeNull();
		expect(target.querySelector('[data-block="group-breakdown"]')).toBeNull();
		expect(target.querySelector('[data-note="group-breakdown"]')).toBeNull();
	});
});
