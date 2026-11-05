// @vitest-environment jsdom
/**
 * Clarification questions and the agent-drafted label, in the page (card
 * 2678: slice 2a, the plan's cases 26 and 27; slice 2b, cases 28 to 31). Each component is mounted
 * alone with Svelte's client runtime, as the other decision page files mount
 * them, `fetch` a stand-in that keeps every request sent and answers what the
 * case gives it.
 *
 *   - `AgentLabel` (card 2712, decision 20): the two labels' words from
 *     `decision-words.ts`; `DecisionView`'s flags and options and
 *     `DecisionEditor`'s sections drawn through it with their class, element
 *     and data attribute as before; and the unreviewed label's sentence
 *     written in `src` only in `decision-words.ts`.
 *   - `ResultsView`'s open questions (decision 9, F11): the text as typed,
 *     `AgentLabel` on an agent's unpublished draft, and the link to answer on
 *     the decision's page only for a viewer who may answer now.
 *   - `QuestionForm` (decisions 13 and 21, F4, F5): who sees a question,
 *     what it sends each way in, its one status region, which stays when the
 *     form closes, the focus on the section heading, and no list of its own.
 *   - `QuestionsPanel` (decisions 2, 8, 19 and 21, F4, F6): what a
 *     participant is shown, and an answerer's controls, each named after its
 *     question and described by it, with the literal bodies they send, the
 *     focus on the new answer, and a 409 that keeps what was typed.
 *   - Both pages: the questions drawn only with a question or `mayAsk`, and
 *     no answer, publish or replace control ever on the link page.
 *
 * What the server answers, and to whom, is in `tests/decision-questions.test.ts`.
 * The plan is `docs/planning/card-2678-clarification-questions.md`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { DecisionPageData, QuestionView, ResultsData, ShownStatus, ViewContent, ViewOption } from '$lib/decision-view-types';

const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	goto: async () => {},
	invalidateAll: navigation.invalidateAll,
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
// The link page reads its token from the page's address.
vi.mock('$app/state', () => ({ page: { params: { token: 'tok-page' } } }));
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import AgentLabel from '$lib/components/decision/AgentLabel.svelte';
import DecisionView from '$lib/components/decision/DecisionView.svelte';
import QuestionForm from '$lib/components/decision/QuestionForm.svelte';
import QuestionsPanel from '$lib/components/decision/QuestionsPanel.svelte';
import ResultsView from '$lib/components/decision/ResultsView.svelte';
import { DECISION_TEXT_MAX, QUESTION_TEXT_MAX } from '$lib/decision-rules';
import {
	AGENT_REVIEWED,
	AGENT_UNREVIEWED,
	ANSWERED,
	ASKED_BY_AGENT,
	DRAFT_PENDING,
	QUESTION_WHO_SEES,
	RESULTS_ANSWER_ELSEWHERE,
	questionsClosedWords,
	questionsLimitWords
} from '$lib/decision-words';
import DecisionPage from '../src/routes/decisions/[id]/+page.svelte';
import LinkPage from '../src/routes/decision-link/[token]/+page.svelte';

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
	navigation.invalidateAll.mockReset();
	navigation.invalidateAll.mockImplementation(async () => {});
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

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const answer = (what: string, status: number, body: unknown) => (answers[what] ??= []).push({ status, body });
/** Types into a field as a person does: its value, then the input event its binding listens for. */
function typeInto(field: HTMLTextAreaElement, value: string) {
	field.value = value;
	field.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}
/** The field a `<label>` with these words names. */
function fieldNamed(within: ParentNode, words: string): HTMLTextAreaElement {
	const label = [...within.querySelectorAll<HTMLLabelElement>('label')].find((l) => textOf(l) === words);
	expect(label, words).toBeDefined();
	return document.getElementById(label!.htmlFor) as HTMLTextAreaElement;
}
/** The button whose accessible name is these words: its aria-label, or its text. */
const buttonNamed = (within: ParentNode, words: string) =>
	[...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => (b.getAttribute('aria-label') ?? textOf(b)) === words);
function submit(form: HTMLFormElement) {
	form.requestSubmit();
	flushSync();
}

// ─── AgentLabel (case 26) ───────────────────────────────────────────────────

const OPTIONS: ViewOption[] = [
	{ optionId: 11, label: 'A', title: 'Rent', summary: '', pros: [], cons: [], commercial: '', agentDrafted: false },
	{ optionId: 12, label: 'B', title: 'Buy', summary: '', pros: [], cons: [], commercial: '', agentDrafted: true }
];
const CONTENT: ViewContent = {
	situation: 'Money is short.',
	question: 'Which plan?',
	ask: '',
	unknowns: '',
	alreadyRuled: '',
	technicalDetail: '',
	stories: [],
	agentDrafted: { situation: true }
};
const DECISION = { title: 'Pick a plan', shownStatus: 'open', voteMode: 'single', closesAt: null, deciderName: 'Dee Cider' } as const;

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

describe('AgentLabel (26)', () => {
	it('26 (a): draws the two words from decision-words.ts, and the three earlier uses keep their class, element and data attribute', () => {
		expect(AGENT_UNREVIEWED).toBe('Drafted by an agent and not yet reviewed by a person');
		expect(AGENT_REVIEWED).toBe('Drafted by an agent and reviewed by a person');

		const unreviewed = draw(AgentLabel, {}).querySelector<HTMLElement>('.agent-label')!;
		expect([unreviewed.tagName, textOf(unreviewed)]).toEqual(['SPAN', AGENT_UNREVIEWED]);
		const reviewed = draw(AgentLabel, { reviewed: true, tag: 'p' }).querySelector<HTMLElement>('.agent-label')!;
		expect([reviewed.tagName, textOf(reviewed)]).toEqual(['P', AGENT_REVIEWED]);

		// DecisionView: a flagged section and a flagged option, each a <p> found by its data-flag.
		const view = draw(DecisionView, { decision: DECISION, content: CONTENT, options: OPTIONS, audiences: [], participant: null, mode: 'participant' });
		expect([...view.querySelectorAll<HTMLElement>('.agent-label')].map((l) => [l.tagName, l.dataset.flag, textOf(l)])).toEqual([
			['P', 'situation', AGENT_UNREVIEWED],
			['P', 'options.12', AGENT_UNREVIEWED]
		]);

		// DecisionEditor: a <span> found by its data-section, the attribute passed through as the editor passes it.
		const editorLabel = draw(AgentLabel, { 'data-section': 'options.101' }).querySelector<HTMLElement>('.agent-label')!;
		expect([editorLabel.tagName, editorLabel.dataset.section, textOf(editorLabel)]).toEqual(['SPAN', 'options.101', AGENT_UNREVIEWED]);
		const editor = readFileSync(join(process.cwd(), 'src/lib/components/decision/DecisionEditor.svelte'), 'utf8');
		expect(editor.match(/<AgentLabel[^>]*\/>/g)).toEqual(['<AgentLabel data-section={k} />']);
		const viewSource = readFileSync(join(process.cwd(), 'src/lib/components/decision/DecisionView.svelte'), 'utf8');
		expect(viewSource.match(/<AgentLabel[^>]*\/>/g)).toEqual(['<AgentLabel tag="p" data-flag={key} />', '<AgentLabel tag="p" data-flag="options.{option.optionId}" />']);
		// No parent styles a label it no longer draws.
		expect(editor).not.toContain('.agent-label');
		expect(viewSource).not.toContain('.agent-label');
	});

	it('26 (b): the unreviewed label’s sentence is written in src only in decision-words.ts', () => {
		const root = join(process.cwd(), 'src');
		const writers = filesUnder(root)
			.filter((path) => readFileSync(path, 'utf8').includes(AGENT_UNREVIEWED))
			.map((path) => relative(root, path).split(sep).join('/'));
		expect(writers).toEqual(['lib/decision-words.ts']);
	});
});

// ─── ResultsView's open questions (case 27) ─────────────────────────────────

function results(more: Partial<ResultsData> = {}): ResultsData {
	const round = { round: 1, responded: 0, voted: 0, votes: [], scores: [], abstained: 0, noConcerns: 0, rows: [] };
	return {
		decision: {
			id: 7,
			title: 'Which plan?',
			shownStatus: 'open',
			voteMode: 'single',
			closesAt: '2099-11-02 09:00:00',
			deciderName: 'Dee Cider',
			boardId: 3,
			boardName: 'The board',
			currentVersion: 1
		},
		revision: 'rev-1',
		round: 1,
		options: [{ optionId: 11, label: 'A', title: 'Plan A' }],
		current: round,
		earlierRounds: [],
		notResponded: [],
		removed: [],
		openQuestions: [
			{ askerName: 'Ann Asker', question: 'What does B cost?\n  Per year, please.', askedAt: '2026-11-03 10:00:00', agentAnswered: false },
			{ askerName: 'Bo Asker', question: 'When does it start?', askedAt: '2026-11-03 11:00:00', agentAnswered: true }
		],
		mayAnswerQuestions: true,
		concerns: [],
		ruling: null,
		released: null,
		releasePreview: null,
		mayRule: true,
		rulesEarly: false,
		mayRelease: false,
		releaseRefusal: null,
		mostChosen: [],
		...more
	};
}

describe('ResultsView’s open questions (27)', () => {
	it('27 (a): for a decider who may answer: who asked and when, the text as typed, the label on an agent’s draft, and the link to the questions', () => {
		const target = draw(ResultsView, { results: results() });
		const items = [...target.querySelectorAll<HTMLElement>('[data-list="questions"] li')];
		expect(items.map((li) => li.querySelector('strong')!.textContent)).toEqual(['Ann Asker', 'Bo Asker']);
		expect(textOf(items[0])).toContain('2026-11-03 10:00 UTC');
		// The text as typed: its own line breaks and spaces kept, never read as markup.
		const text = items[0].querySelector<HTMLElement>('[data-text="question"]')!;
		expect(text.textContent).toBe('What does B cost?\n  Per year, please.');
		expect(text.classList.contains('comment')).toBe(true);
		expect(items.map((li) => li.querySelector('.agent-label')?.textContent ?? null)).toEqual([null, AGENT_UNREVIEWED]);

		const link = target.querySelector<HTMLAnchorElement>('[data-action="answer-questions"]')!;
		expect([textOf(link), link.getAttribute('href')]).toEqual(["Answer on the decision's page", '/decisions/7#questions']);
		expect(target.querySelector('[data-note="answer-elsewhere"]')).toBeNull();
	});

	it('27 (b): for an administrator who may not answer: the neutral words, and no link', () => {
		const target = draw(ResultsView, { results: results({ mayAnswerQuestions: false }) });
		expect(target.querySelector('[data-action="answer-questions"]')).toBeNull();
		expect(target.querySelector('a[href*="#questions"]')).toBeNull();
		expect(textOf(target.querySelector('[data-note="answer-elsewhere"]')!)).toBe(RESULTS_ANSWER_ELSEWHERE);
	});

	it('27 (c): once ruled, superseded or withdrawn: why they took no answer, and neither the link nor the neutral words (code review F3)', () => {
		const rows: [ShownStatus, string][] = [
			['ruled', 'Not answered before the ruling'],
			['superseded', 'Not answered before the ruling'],
			['withdrawn', 'Not answered before the withdrawal'],
			['draft', 'Questions are closed']
		];
		for (const [shownStatus, words] of rows) {
			// Given the link as well, to hold that the status decides first.
			const target = draw(ResultsView, { results: results({ decision: { ...results().decision, shownStatus }, mayAnswerQuestions: true }) });
			expect(textOf(target.querySelector('[data-note="questions-closed"]')!), shownStatus).toBe(words);
			expect(target.querySelector('[data-action="answer-questions"]'), shownStatus).toBeNull();
			expect(target.querySelector('[data-note="answer-elsewhere"]'), shownStatus).toBeNull();
		}
		for (const shownStatus of ['open', 'awaiting_ruling'] as const) {
			const target = draw(ResultsView, { results: results({ decision: { ...results().decision, shownStatus } }) });
			expect(target.querySelector('[data-note="questions-closed"]'), shownStatus).toBeNull();
			expect(target.querySelector('[data-action="answer-questions"]'), shownStatus).not.toBeNull();
		}
	});
});

// ─── The pages' questions (cases 28 to 31, slice 2b) ────────────────────────

/** A page's data, a consulted participant's on an open decision, who may ask and has asked nothing. */
function pageData(more: Partial<DecisionPageData> = {}): DecisionPageData & { user: null } {
	return {
		via: 'session',
		decision: { id: 5, ...DECISION, boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
		draft: false,
		version: { number: 2, publishedAt: '2026-11-01 09:00:00', content: { ...CONTENT, agentDrafted: {} } },
		options: OPTIONS,
		audiences: [],
		participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: null },
		ownResponse: null,
		earlierResponse: null,
		mayRespond: false,
		stage: null,
		seenRecorded: false,
		mayEdit: false,
		signedInAs: null,
		ruling: null,
		released: null,
		concerns: [],
		mayRaiseConcern: false,
		supersedes: null,
		laterDecision: null,
		questions: [],
		mayAsk: true,
		mayAnswer: false,
		user: null,
		...more
	};
}
/** A link holder's page data: no decision id, no board's name, and no `mayAnswer`. */
const linkData = (more: Partial<DecisionPageData> = {}) => {
	const { mayAnswer: _, ...data } = pageData({ via: 'link', decision: { ...DECISION, boardName: null, withdrawnAt: null, withdrawnReason: null }, ...more });
	return data;
};

const ANN = { answererName: 'Ann', answererRole: 'author' as const, answeredAt: '2026-11-03 12:00:00' };
/** A question as the page gives it, open and someone else's unless told otherwise. */
const question = (more: Partial<QuestionView> = {}): QuestionView => ({
	question: 'What does B cost?',
	askedInVersion: 2,
	own: false,
	answer: null,
	closedUnanswered: null,
	...more
});

describe('QuestionForm (28)', () => {
	it('28 (a): signed in: says who sees a question, sends { question } as JSON, says so, reads the data again, moves the focus to the heading, and lists nothing', async () => {
		const target = draw(DecisionPage, { data: pageData() });
		const section = target.querySelector<HTMLElement>('[data-section="questions"]')!;
		expect(section.id).toBe('questions');
		const form = section.querySelector<HTMLElement>('[data-block="ask"]')!;
		expect(textOf(form.querySelector('[data-note="question-who-sees"]')!)).toBe(QUESTION_WHO_SEES);
		expect(QUESTION_WHO_SEES).toContain('In a decision with only a few people, others may be able to guess who asked.');

		const field = fieldNamed(form, 'Your question');
		expect(field.maxLength).toBe(QUESTION_TEXT_MAX);
		const count = document.getElementById(field.getAttribute('aria-describedby')!)!;
		expect(textOf(count)).toBe('0 of 2,000 characters');
		typeInto(field, 'What does B cost?');
		expect(textOf(count)).toBe('17 of 2,000 characters');

		answer('POST /api/decisions/5/questions', 200, { question: { question: 'What does B cost?', askedInVersion: 2, askedAt: '2026-11-03 10:00:00' } });
		submit(form.querySelector('form')!);
		await settle();
		expect(sent.map((request) => [request.what, request.headers, request.body])).toEqual([
			['POST /api/decisions/5/questions', JSON_TYPE, JSON.stringify({ question: 'What does B cost?' })]
		]);
		expect(textOf(form.querySelector('[role="status"]')!)).toBe('Your question was sent.');
		expect(field.value).toBe('');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(document.activeElement).toBe(section.querySelector('h2#questions-heading'));
		// F5: the form lists nothing; the panel is the one list.
		expect(form.querySelector('li, ol, ul')).toBeNull();
		expect(section.querySelectorAll('[data-block="questions"]')).toHaveLength(1);
	});

	it('28 (b): by link: sends { token, question } to the link route', async () => {
		const target = draw(LinkPage, { data: linkData() });
		const form = target.querySelector<HTMLElement>('[data-section="questions"] [data-block="ask"]')!;
		typeInto(fieldNamed(form, 'Your question'), 'When does it start?');
		submit(form.querySelector('form')!);
		await settle();
		expect(sent.filter((request) => request.what.includes('questions')).map((request) => [request.what, request.body])).toEqual([
			['POST /api/decision-by-link/questions', JSON.stringify({ token: 'tok-page', question: 'When does it start?' })]
		]);
	});

	it('28 (c): with mayAsk false no textarea and the reason, its status region still drawn; a 429 said there in the server’s words, the text kept; a 409 reads the data again', async () => {
		// The reason is the form's own, from the page's questions and the shown status (code review F5).
		const tenOwn = Array.from({ length: 10 }, () => question({ own: true }));
		const closed = draw(QuestionForm, { url: '/api/decisions/5/questions', mayAsk: false, questions: [...tenOwn, question()], shownStatus: 'open' });
		expect(closed.querySelector('textarea')).toBeNull();
		expect(textOf(closed.querySelector('[data-note="questions-closed"]')!)).toBe(`${questionsLimitWords(10)}.`);
		expect(closed.querySelector('[role="status"][data-said="ask"]')).not.toBeNull();
		const ruled = draw(QuestionForm, { url: '/api/decisions/5/questions', mayAsk: false, questions: tenOwn.slice(0, 2), shownStatus: 'ruled' });
		expect(textOf(ruled.querySelector('[data-note="questions-closed"]')!)).toBe('Questions on this decision are closed.');
		expect(questionsClosedWords(2, 10, 'ruled')).toBe('Questions on this decision are closed.');

		const props = $state({ url: '/api/decisions/5/questions', mayAsk: true, questions: tenOwn.slice(0, 9), shownStatus: 'open' });
		const open = draw(QuestionForm, props);
		const field = fieldNamed(open, 'Your question');
		typeInto(field, 'And another?');
		const rest = 'You asked a question less than 10 minutes ago: ask again from 2026-11-03 10:10 UTC';
		answer('POST /api/decisions/5/questions', 429, { message: rest });
		submit(open.querySelector('form')!);
		await settle();
		expect(textOf(open.querySelector('[role="status"]')!)).toBe(rest);
		expect(field.value).toBe('And another?');
		expect(navigation.invalidateAll).not.toHaveBeenCalled();

		// A 409 (code review F6): said in the region, the text kept, and the page's data read again, so the form shows why it closed.
		answer('POST /api/decisions/5/questions', 409, { message: questionsLimitWords(10) });
		submit(open.querySelector('form')!);
		await settle();
		expect(textOf(open.querySelector('[role="status"]')!)).toBe(questionsLimitWords(10));
		expect(field.value).toBe('And another?');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);

		// The form closes, its region stays, and what it said with it (F4).
		props.mayAsk = false;
		flushSync();
		expect(open.querySelector('textarea')).toBeNull();
		expect(textOf(open.querySelector('[role="status"]')!)).toBe(questionsLimitWords(10));
	});
});

describe('QuestionsPanel (29 to 31)', () => {
	it('29: for a participant: text as typed, "Your question", no name and no draft, the labels where given, the version and the unanswered words', () => {
		const target = draw(QuestionsPanel, {
			shownVersion: 2,
			questions: [
				question({ question: '<b>x</b>', askedInVersion: 1, own: true, askedAt: '2026-11-03 10:00:00', askedByAgent: true, answer: { ...ANN, text: 'About 10k.', agentDrafted: false } }),
				question({ answer: { ...ANN, answererRole: 'decider', text: 'From May.', agentDrafted: true } }),
				question({ closedUnanswered: 'ruling' })
			]
		});
		const items = [...target.querySelectorAll<HTMLElement>('[data-list="questions"] > li')];
		expect(items).toHaveLength(3);
		const [mine, published, unanswered] = items;
		expect(mine.querySelector('[data-text="question"]')!.textContent).toBe('<b>x</b>');
		expect(mine.querySelector('b')).toBeNull();
		expect(textOf(mine.querySelector('[data-note="own"]')!)).toBe('Your question');
		expect(textOf(mine)).toContain('2026-11-03 10:00 UTC');
		expect(target.querySelector('[data-note="asker"]')).toBeNull();
		expect(items.map((li) => li.querySelector('[data-note="asked-by-agent"]')?.textContent ?? null)).toEqual([ASKED_BY_AGENT, null, null]);
		expect(items.map((li) => li.querySelector('[data-note="asked-in"]')?.textContent ?? null)).toEqual(['Asked about version 1', null, null]);
		expect(textOf(mine.querySelector('.answer-by')!)).toBe('Answered by Ann, the author, 2026-11-03 12:00 UTC');
		expect(mine.querySelector('.agent-label')).toBeNull();
		expect(textOf(published.querySelector('.answer-by')!)).toContain('Answered by Ann, the decider');
		expect(textOf(published.querySelector('.agent-label')!)).toBe(AGENT_REVIEWED);
		expect(textOf(unanswered.querySelector('[data-note="unanswered"]')!)).toBe('Not answered before the ruling');
		expect(target.querySelector('[data-block="draft"]')).toBeNull();
		expect(target.querySelector('textarea, button')).toBeNull();
	});

	it('30 (a): for an answerer: names and moments; a textarea named after its question, described by it, with its count; { answer } to the literal route; the focus on the new answer', async () => {
		const props = $state({
			decisionId: 5,
			mayAnswer: true,
			questions: [question({ id: 41, askerName: 'Pat Person', askedAt: '2026-11-03 10:00:00' })]
		});
		const target = draw(QuestionsPanel, props);
		expect(textOf(target.querySelector('[data-note="asker"]')!)).toBe('Asked by Pat Person');
		expect(textOf(target.querySelector('li')!)).toContain('2026-11-03 10:00 UTC');

		const field = fieldNamed(target, 'Answer to question 1');
		expect(field.maxLength).toBe(DECISION_TEXT_MAX);
		const [describedBy, countId] = field.getAttribute('aria-describedby')!.split(' ');
		expect(document.getElementById(describedBy)!.textContent).toBe('What does B cost?');
		expect(textOf(document.getElementById(countId)!)).toBe('0 of 4,000 characters');
		const send = buttonNamed(target, 'Send answer to question 1')!;
		expect(send.getAttribute('aria-describedby')).toBe(describedBy);
		typeInto(field, 'About 10k a year.');

		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.questions = [question({ id: 41, askerName: 'Pat Person', askedAt: '2026-11-03 10:00:00', answer: { ...ANN, text: 'About 10k a year.', agentDrafted: false } })];
		});
		answer('POST /api/decisions/5/questions/41/answer', 200, { question: {} });
		submit(field.form!);
		await settle();
		expect(sent.map((request) => [request.what, request.headers, request.body])).toEqual([
			['POST /api/decisions/5/questions/41/answer', JSON_TYPE, JSON.stringify({ answer: 'About 10k a year.' })]
		]);
		expect(textOf(target.querySelector('[role="status"]')!)).toBe('Your answer was saved.');
		expect((document.activeElement as HTMLElement).dataset.block).toBe('answer');
		expect(textOf(document.activeElement!)).toContain('About 10k a year.');
		expect(target.querySelector('textarea')).toBeNull();
	});

	it('30 (b): an agent’s draft: its label, Publish sending {} to …/publish, and Replace sending { answer, replacesDraft: true }, each named after its question, each said and the focus on the new answer', async () => {
		const MAY = { text: 'An agent says May.', drafterName: 'decider', draftedAt: '2026-11-03 11:00:00' };
		const JULY = { text: 'An agent says July.', drafterName: 'decider', draftedAt: '2026-11-03 11:05:00' };
		const props = $state({
			decisionId: 5,
			mayAnswer: true,
			questions: [question({ id: 41, askerName: 'Pat Person' }), question({ id: 42, askerName: 'Quin Person', draft: MAY }), question({ id: 43, askerName: 'Rae Person', draft: JULY })]
		});
		const target = draw(QuestionsPanel, props);
		const draft = target.querySelectorAll<HTMLElement>('li')[1];
		expect(textOf(draft.querySelector('[data-block="draft"] .agent-label')!)).toBe(AGENT_UNREVIEWED);
		expect(draft.querySelector('[data-text="draft"]')!.textContent).toBe('An agent says May.');
		// A draft takes no plain answer: only Publish or Replace.
		expect(buttonNamed(draft, 'Send answer to question 2')).toBeUndefined();

		// Publish, with a replacement half typed for the same draft: published, that text is no longer taken and is not kept (code review F1).
		typeInto(fieldNamed(draft, "Your answer in place of the agent's, to question 2"), 'Half typed.');
		const publish = buttonNamed(draft, "Publish the agent's answer to question 2")!;
		expect(document.getElementById(publish.getAttribute('aria-describedby')!)!.textContent).toBe('What does B cost?');
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.questions = [props.questions[0], question({ id: 42, askerName: 'Quin Person', answer: { ...ANN, text: MAY.text, agentDrafted: true } }), props.questions[2]];
		});
		answer('POST /api/decisions/5/questions/42/publish', 200, { question: {} });
		publish.click();
		await settle();
		// Code review F7: what was done said in the region, and the focus on the answer now published.
		expect(textOf(target.querySelector('[role="status"][data-said="questions"]')!)).toBe("The agent's answer was published.");
		expect((document.activeElement as HTMLElement).dataset.block).toBe('answer');
		expect(textOf(document.activeElement!)).toContain('An agent says May.');
		expect(target.querySelector('[data-block="unsent"]')).toBeNull();

		// Replace the other draft.
		const other = target.querySelectorAll<HTMLElement>('li')[2];
		typeInto(fieldNamed(other, "Your answer in place of the agent's, to question 3"), 'June, in fact.');
		const replace = buttonNamed(other, "Replace the agent's answer to question 3")!;
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.questions = [props.questions[0], props.questions[1], question({ id: 43, askerName: 'Rae Person', answer: { ...ANN, text: 'June, in fact.', agentDrafted: false } })];
		});
		answer('POST /api/decisions/5/questions/43/answer', 200, { question: {} });
		submit(replace.form!);
		await settle();
		expect(textOf(target.querySelector('[role="status"][data-said="questions"]')!)).toBe("Your answer replaced the agent's.");
		expect((document.activeElement as HTMLElement).dataset.block).toBe('answer');
		expect(textOf(document.activeElement!)).toContain('June, in fact.');
		expect(target.querySelector('[data-block="unsent"]')).toBeNull();

		expect(sent.map((request) => [request.what, request.headers, request.body])).toEqual([
			['POST /api/decisions/5/questions/42/publish', JSON_TYPE, JSON.stringify({})],
			['POST /api/decisions/5/questions/43/answer', JSON_TYPE, JSON.stringify({ answer: 'June, in fact.', replacesDraft: true })]
		]);
		// The publish and replace controls are a draft's alone.
		expect(buttonNamed(target.querySelectorAll('li')[0], "Publish the agent's answer to question 1")).toBeUndefined();
	});

	it('30 (c): a 409 "This question has been answered": said in the panel’s region, the data read again, the typed text kept, and the focus on it (code review F1)', async () => {
		const props = $state({ decisionId: 5, mayAnswer: true, questions: [question({ id: 41, askerName: 'Pat Person' }), question({ id: 42, question: 'And when?' })] });
		const target = draw(QuestionsPanel, props);
		const field = fieldNamed(target, 'Answer to question 1');
		typeInto(field, 'My answer.');
		// The data read again holds the other answer: the typed text stays beside it, read-only, so nothing is lost, and the focus goes to it.
		navigation.invalidateAll.mockImplementationOnce(async () => {
			props.questions = [question({ id: 41, askerName: 'Pat Person', answer: { ...ANN, text: 'Their answer.', agentDrafted: false } }), props.questions[1]];
		});
		answer('POST /api/decisions/5/questions/41/answer', 409, { message: ANSWERED });
		submit(field.form!);
		await settle();
		expect(textOf(target.querySelector('[role="status"][data-said="questions"]')!)).toBe(ANSWERED);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		const kept = fieldNamed(target, 'Your answer to question 1, not sent');
		expect([kept.value, kept.readOnly]).toEqual(['My answer.', true]);
		expect(document.activeElement).toBe(kept);

		// A 409 that leaves the question open (another refusal of the state): the text kept in its own field, and the focus on the question's text.
		const second = fieldNamed(target, 'Answer to question 2');
		typeInto(second, 'Soon.');
		answer('POST /api/decisions/5/questions/42/answer', 409, { message: DRAFT_PENDING });
		submit(second.form!);
		await settle();
		expect(textOf(target.querySelector('[role="status"]')!)).toBe(DRAFT_PENDING);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(2);
		expect(second.value).toBe('Soon.');
		expect((document.activeElement as HTMLElement).dataset.text).toBe('question');
		expect(textOf(document.activeElement!)).toBe('And when?');
	});

	it('31: both pages draw the questions only with a question or mayAsk, and the link page never draws an answer, publish or replace control', () => {
		const none = { questions: [], mayAsk: false };
		const draft = question({ id: 42, draft: { text: 'A draft.', drafterName: 'decider', draftedAt: '2026-11-03 11:00:00' } });
		expect(draw(DecisionPage, { data: pageData(none) }).querySelector('[data-section="questions"]')).toBeNull();
		expect(draw(LinkPage, { data: linkData(none) }).querySelector('[data-section="questions"]')).toBeNull();

		const signedIn = draw(DecisionPage, { data: pageData({ questions: [question({ id: 41 }), draft], mayAsk: false, mayAnswer: true, participant: null }) });
		expect(signedIn.querySelector('[data-section="questions"] [data-block="questions"]')).not.toBeNull();
		expect(buttonNamed(signedIn, 'Send answer to question 1')).toBeDefined();
		expect(buttonNamed(signedIn, "Publish the agent's answer to question 2")).toBeDefined();
		// Not a participant: no form to ask.
		expect(signedIn.querySelector('[data-block="ask"]')).toBeNull();

		// Even given ids and `mayAnswer`, the link page offers nothing to answer with.
		const byLink = draw(LinkPage, { data: { ...linkData({ questions: [question({ id: 41 }), draft], mayAsk: false }), mayAnswer: true } });
		const section = byLink.querySelector('[data-section="questions"]')!;
		expect(section.querySelectorAll('[data-list="questions"] > li')).toHaveLength(2);
		expect(section.querySelectorAll('[data-action="answer"], [data-action="publish"], [data-action="replace"]')).toHaveLength(0);
		expect(section.querySelector('[data-block="ask"] textarea')).toBeNull();
	});
});
