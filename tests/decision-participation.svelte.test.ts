// @vitest-environment jsdom
/**
 * The participant page, in the page (card 2677, slice 3: the plan's cases 25
 * to 34). Each component and page is mounted alone with Svelte's client
 * runtime, as the decision editor's file mounts them, `fetch` a stand-in that
 * keeps every request sent and answers what the case gives it.
 *
 *   - `DecisionView`: its sections in design 4.7's order, the closed ones
 *     closed, the agent label, and nothing of a snippet not given (D6); who
 *     sees a response, said to a consulted participant alone (decision 15).
 *   - `MarkdownBlock`: the text, escaped, before it is mounted, as the server
 *     draws it; `renderMarkdown`'s output once mounted (decision 17).
 *   - `ResponseForm`: what Send sends in single and score mode, the answer to
 *     a refusal, and the form a preview draws, which sends nothing (D4).
 *   - Both pages: the earlier round's response, the banner's words (D8), and
 *     the seen watch, which posts once after the first trusted action while
 *     the page is visible (R2), on `/decisions/[id]` for a participant alone
 *     (D7), and never from a preview.
 *
 *   - The shared parts (card 2707, plan cases 2707-1 to 2707-3): both pages,
 *     from the same data, draw the same banner and response, the link page
 *     adding only its two personal-link lines; handed every signed-in-only
 *     field, the link page draws none of them; Reload, on either page, reads
 *     the page again and draws the form afresh. The plan is
 *     `docs/planning/card-2707-shared-participant-snippets.md`.
 *
 *   - The signed-in note (card 2735, case 2735-1): in each status and role,
 *     the link page says exactly what is recorded with a signed-in account.
 *     The plan is `docs/planning/card-2735-link-signed-in-note.md`.
 *
 *   - The seen claim (card 2736, cases 2736-3 and 2736-4): where the
 *     participant's seen already exists, the signed-in note names no seen,
 *     and neither page draws the seen note or arms the watch. The plan is
 *     `docs/planning/card-2736-seen-claim.md`.
 *
 * jsdom cannot make a trusted event, so the watch's trust test is stood in:
 * `watchForSeen` is the real one, handed a test that trusts the events this
 * file marks. What the server answers, and to whom, is in
 * `tests/decision-participation.test.ts`. The plan is
 * `docs/planning/card-2677-participant-page.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { DecisionPageData, OwnResponse, RulingView, ViewContent, ViewOption, ViewSurveyQuestion } from '$lib/decision-view-types';

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
/** The events this file says a person made: the stand-in for `event.isTrusted`. */
const trust = vi.hoisted(() => ({ events: new WeakSet<Event>() }));
vi.mock('$lib/decision-seen', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/decision-seen')>();
	return {
		...real,
		watchForSeen: (url: string, body: Record<string, unknown>) => real.watchForSeen(url, body, { trusted: (event) => trust.events.has(event) })
	};
});
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import DecisionView from '$lib/components/decision/DecisionView.svelte';
import MarkdownBlock from '$lib/components/decision/MarkdownBlock.svelte';
import ResponseForm from '$lib/components/decision/ResponseForm.svelte';
import { FLAG_TEXT_NOTE, flagWhoSees, STALE_REVISION, SURVEY_TEXT_NOTE, signedInNoteWords, surveyWhoSees, TALK_OPEN, whoSeesStatement, type ToldMail } from '$lib/decision-words';
import { renderMarkdown } from '$lib/markdown';
import DecisionPage from '../src/routes/decisions/[id]/+page.svelte';
import LinkPage from '../src/routes/decision-link/[token]/+page.svelte';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { createRawSnippet, flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

type Json = any;

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];
/** Each request sent, as `METHOD url`, with its body read as JSON. */
let sent: { what: string; body: Json }[] = [];
/** What the next request to each `METHOD url` is answered; anything else is `{}`. */
let answers: Record<string, { status: number; body: unknown }[]> = {};
/** What `document.visibilityState` says. */
let visibility: DocumentVisibilityState = 'visible';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	sent = [];
	answers = {};
	visibility = 'visible';
	navigation.invalidateAll.mockClear();
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
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

/** Unmounts everything drawn, so that no page's watch is left listening. */
function clear() {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	sent = [];
}

afterEach(() => {
	clear();
	document.body.replaceChildren();
	vi.unstubAllGlobals();
});

function draw(component: unknown, props: Record<string, unknown>, flush = true): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	if (flush) flushSync();
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
/** Each paragraph within, as its text. */
const linesOf = (el: Element) => [...el.querySelectorAll('p')].map(textOf);
const button = (within: ParentNode, text: string) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => textOf(b) === text)!;
const radio = (within: ParentNode, value: string) => within.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
const field = (within: ParentNode, label: string) =>
	[...within.querySelectorAll<HTMLLabelElement>('label')].find((l) => textOf(l.querySelector('span')!) === label)!.querySelector<HTMLTextAreaElement>('textarea')!;
const requests = (what: string) => sent.filter((r) => r.what === what).map((r) => r.body);
const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

/** Types into a field as a person does: its value, then the input event its binding listens for. */
function type(input: HTMLTextAreaElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

/** An action on the page, which the stand-in trusts unless told otherwise. */
function act(kind: 'pointerdown' | 'keydown' | 'touchstart' | 'wheel' | 'scroll', trusted = true) {
	const event = new Event(kind, { bubbles: true });
	if (trusted) trust.events.add(event);
	window.dispatchEvent(event);
}

// ─── What the page is given ─────────────────────────────────────────────────

const OPTIONS: ViewOption[] = [
	{ optionId: 11, label: 'A', title: 'Rent', summary: 'Pay monthly.', pros: ['Cheap now'], cons: ['Dear later'], commercial: '£10 a month', agentDrafted: false },
	{ optionId: 12, label: 'B', title: 'Buy', summary: 'Pay once.', pros: [], cons: [], commercial: '', agentDrafted: true }
];
const CONTENT: ViewContent = {
	situation: 'Money is short.',
	question: 'Which plan?',
	ask: 'Choose one.',
	unknowns: 'The exact price.',
	alreadyRuled: 'The budget.',
	technicalDetail: 'Two servers.',
	stories: [{ title: 'As a buyer', body: 'I pay less.' }],
	agentDrafted: { situation: true }
};
const AUDIENCES = [
	{ heading: 'Finance', body: 'A smaller bill.', own: true, open: true },
	{ heading: 'Sales', body: 'Fewer calls.', own: false, open: false }
];
const DECISION = { title: 'Pick a plan', shownStatus: 'open', voteMode: 'single', closesAt: '2099-12-01 12:00:00', deciderName: 'Dee Cider' } as const;

/** A page's data, a consulted participant's on an open decision, invited by a mail that was delivered. */
function pageData(more: Partial<DecisionPageData> = {}): DecisionPageData & { user: null } {
	return {
		via: 'session',
		decision: { id: 5, ...DECISION, boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
		draft: false,
		version: { number: 1, publishedAt: '2026-11-01 09:00:00', content: CONTENT },
		options: OPTIONS,
		surveyQuestions: [],
		audiences: AUDIENCES,
		participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: '2026-11-01 09:05:00', delivered: true, sentAs: 'consulted' } },
		ownResponse: null,
		earlierResponse: null,
		mayRespond: true,
		stage: 'question',
		seenRecorded: false,
		mayEdit: false,
		signedInAs: null,
		// Card 2679 (decision 23): nothing ruled, released, raised or superseded.
		ruling: null,
		released: null,
		concerns: [],
		mayRaiseConcern: false,
		supersedes: null,
		laterDecision: null,
		// Card 2678: no question, and none may be asked, so no questions section is drawn (tests/decision-questions.svelte.test.ts, case 31).
		questions: [],
		mayAsk: false,
		// Card 2684 (R22): nothing raised, and neither form offered.
		flags: [],
		mayObject: false,
		mayAskToTalk: false,
		user: null,
		...more
	};
}
/** A link holder's page data: no decision id and no board's name (code review C5). */
const linkData = (more: Partial<DecisionPageData> = {}) =>
	pageData({ via: 'link', decision: { ...DECISION, boardName: null, withdrawnAt: null, withdrawnReason: null }, ...more });

const response = (more: Partial<OwnResponse> = {}): OwnResponse => ({
	versionNumber: 1,
	round: 1,
	kind: 'vote',
	optionId: 11,
	scores: null,
	comment: null,
	optionComments: {},
	answers: {},
	createdAt: '2026-11-02 10:00:00',
	...more
});

const drawForm = (more: Record<string, unknown> = {}) =>
	draw(ResponseForm, { voteMode: 'single', options: OPTIONS, versionNumber: 1, url: '/api/decisions/5/responses', ...more });

// ─── DecisionView (cases 25 and 26) ─────────────────────────────────────────

describe('DecisionView', () => {
	it('25: draws its sections in design 4.7’s order, stories and technical detail closed, a flagged section labelled, and no linked cards when none are given', () => {
		const target = draw(DecisionView, {
			decision: DECISION,
			content: CONTENT,
			options: OPTIONS,
			audiences: AUDIENCES,
			participant: { role: 'consulted' },
			mode: 'participant',
			banner: html('<p>The banner</p>'),
			response: html('<p>The form</p>'),
			questions: html('<p>The questions</p>')
		});

		expect([...target.querySelectorAll<HTMLElement>('[data-section]')].map((s) => s.dataset.section)).toEqual([
			'banner',
			'situation',
			'question',
			'ask',
			'who-sees',
			'options',
			'audiences',
			'stories',
			'unknowns',
			'already-ruled',
			'technical-detail',
			'response',
			'questions'
		]);
		expect(textOf(target.querySelector('h1')!)).toBe('Pick a plan');
		expect(textOf(target.querySelector('[data-section="ask"]')!)).toContain('By 2099-12-01 12:00 UTC.');
		expect(target.querySelector<HTMLDetailsElement>('[data-section="stories"] details')!.open).toBe(false);
		expect(target.querySelector<HTMLDetailsElement>('[data-section="technical-detail"] details')!.open).toBe(false);
		expect([...target.querySelectorAll<HTMLDetailsElement>('.audience')].map((d) => [textOf(d.querySelector('summary')!), d.open])).toEqual([
			['Finance', true],
			['Sales', false]
		]);
		expect([...target.querySelectorAll<HTMLElement>('.agent-label')].map((l) => [l.dataset.flag, textOf(l)])).toEqual([
			['situation', 'Drafted by an agent and not yet reviewed by a person'],
			['options.12', 'Drafted by an agent and not yet reviewed by a person']
		]);
		expect(target.querySelector('[data-section="linked-cards"]')).toBeNull();
		expect(textOf(target)).not.toContain('Linked cards');
	});

	it('26: tells a consulted participant who sees their response, the decider and the administrators, and gives them the form; an informed one neither', () => {
		const consulted = draw(DecisionPage, { data: pageData() });
		expect(textOf(consulted.querySelector('[data-section="who-sees"]')!)).toBe(
			"Who sees your response While this decision is open, only Dee Cider, who decides, sees your response. DumpFire's administrators can also see it in the record. No other participant sees it, or any totals. " +
				'After the ruling, the decider may show the totals and the comments, without names, to everyone who can see this decision.'
		);
		expect(consulted.querySelector('.response-form')).not.toBeNull();

		clear();
		const informed = draw(DecisionPage, {
			data: pageData({ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: null }, mayRespond: false })
		});
		expect(informed.querySelector('[data-section="who-sees"]')).toBeNull();
		expect(informed.querySelector('.response-form')).toBeNull();
		expect(informed.querySelector('[data-section="response"]')).toBeNull();
	});
});

// ─── MarkdownBlock (case 27) ────────────────────────────────────────────────

describe('MarkdownBlock', () => {
	it('27: draws the text escaped until it is mounted, as the server draws it, and renderMarkdown’s output once it is', () => {
		const text = '**Money** is short <i>now</i>.';
		// Not flushed: the block as it is drawn before its mount runs, which is what the server drew and hydration keeps.
		const target = draw(MarkdownBlock, { text }, false);
		expect(target.querySelector('.plain')!.textContent).toBe(text);
		expect(target.querySelector('strong, i')).toBeNull();

		flushSync();
		const block = target.querySelector('.markdown-body')!;
		expect(target.querySelector('.plain')).toBeNull();
		expect(block.innerHTML).toBe(renderMarkdown(text));
		expect(textOf(block.querySelector('strong')!)).toBe('Money');
	});
});

// ─── ResponseForm (cases 28 to 30 and 33) ───────────────────────────────────

describe('ResponseForm', () => {
	it('28: in single mode sends the option chosen with the comments, and "I have no concerns" with no option', async () => {
		const target = drawForm();
		radio(target, 'option-12').click();
		flushSync();
		type(field(target, 'Your comment (optional)'), 'Fine by me');
		type(field(target, 'Comment on option A'), 'Too dear');
		answer('POST /api/decisions/5/responses', { response: response({ optionId: 12, comment: 'Fine by me', optionComments: { '11': 'Too dear' } }), unchanged: false });
		button(target, 'Send my response').click();
		await settle();

		expect(requests('POST /api/decisions/5/responses')).toEqual([
			{ versionNumber: 1, statement: 2, kind: 'vote', optionId: 12, comment: 'Fine by me', optionComments: { '11': 'Too dear' } }
		]);
		expect(linesOf(target.querySelector('.recorded')!)).toEqual([
			'Your response was recorded on 2026-11-02 10:00 UTC:',
			'You chose option B: Buy.',
			'Your comment: Fine by me',
			'On option A: Too dear'
		]);

		radio(target, 'no_concerns').click();
		flushSync();
		answer('POST /api/decisions/5/responses', { response: response({ kind: 'no_concerns', optionId: null }), unchanged: false });
		button(target, 'Send my response').click();
		await settle();
		expect(requests('POST /api/decisions/5/responses')[1]).toEqual({ versionNumber: 1, statement: 2, kind: 'no_concerns', comment: 'Fine by me', optionComments: { '11': 'Too dear' } });
	});

	it('29: in score mode keeps Send disabled until every option is scored, then sends the scores', async () => {
		const target = drawForm({ voteMode: 'score' });
		const send = button(target, 'Send my response');
		expect(send.disabled).toBe(true);
		target.querySelector<HTMLButtonElement>('[aria-label="3 for option A"]')!.click();
		flushSync();
		expect(send.disabled).toBe(true);
		target.querySelector<HTMLButtonElement>('[aria-label="5 for option B"]')!.click();
		flushSync();
		expect(send.disabled).toBe(false);
		expect(target.querySelector('[aria-label="5 for option B"]')!.getAttribute('aria-checked')).toBe('true');

		answer('POST /api/decisions/5/responses', { response: response({ optionId: null, scores: { '11': 3, '12': 5 } }), unchanged: false });
		send.click();
		await settle();
		expect(requests('POST /api/decisions/5/responses')).toEqual([{ versionNumber: 1, statement: 2, kind: 'vote', scores: { '11': 3, '12': 5 }, comment: '', optionComments: {} }]);
		expect(linesOf(target.querySelector('.recorded')!)[1]).toBe('Your scores: A 3, B 5.');
	});

	it('30: offers Reload on a 409 in STALE_REVISION’s words alone; any other refusal says the server’s words and keeps what was typed', async () => {
		const onReload = vi.fn();
		const target = drawForm({ onReload });
		radio(target, 'option-11').click();
		flushSync();
		type(field(target, 'Your comment (optional)'), 'My view');

		answer('POST /api/decisions/5/responses', { message: STALE_REVISION }, 409);
		button(target, 'Send my response').click();
		await settle();
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe(STALE_REVISION);
		button(target, 'Reload').click();
		expect(onReload).toHaveBeenCalledTimes(1);

		answer('POST /api/decisions/5/responses', { message: 'comment holds a character that cannot be shown' }, 400);
		button(target, 'Send my response').click();
		await settle();
		expect(textOf(target.querySelector('[role="alert"]')!)).toBe('comment holds a character that cannot be shown');
		expect(button(target, 'Reload')).toBeUndefined();
		expect(field(target, 'Your comment (optional)').value).toBe('My view');
		expect(radio(target, 'option-11').checked).toBe(true);
	});

	it('33: with disabled, draws its choices and sends nothing, whatever is chosen or pressed, with no version or address given (code review C9)', async () => {
		// As card 2697's preview draws it: no version number and nowhere to send.
		const target = draw(ResponseForm, { voteMode: 'single', options: OPTIONS, disabled: true });
		expect([...target.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => [r.value, r.disabled])).toEqual([
			['option-11', true],
			['option-12', true],
			['abstain', true],
			['no_concerns', true]
		]);
		radio(target, 'option-11').click();
		flushSync();
		const send = button(target, 'Send my response');
		expect(send.disabled).toBe(true);
		send.click();
		target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(sent).toEqual([]);
	});
});

// ─── The pages (cases 31, 32 and 34) ────────────────────────────────────────

describe('the participant pages', () => {
	it('31: give the response of an earlier round, for its version, where there is none in this one', () => {
		const target = draw(DecisionPage, {
			data: pageData({ version: { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT }, earlierResponse: response({ comment: 'Cheaper' }) })
		});

		expect(linesOf(target.querySelector('.earlier')!)).toEqual([
			'This decision changed on 2026-11-02 09:00 UTC. Your earlier response was for version 1:',
			'You chose option A: Rent.',
			'Your comment: Cheaper'
		]);
	});

	it('32: post seen once, after the first trusted action while visible, from a participant alone and never from a preview; each page sends its response to its own route', async () => {
		// (a) The link page: nothing on mount, nothing for an untrusted action, once for the first trusted one.
		draw(LinkPage, { data: linkData() });
		await settle();
		expect(sent, '(a) mounted').toEqual([]);
		act('pointerdown', false);
		await settle();
		expect(sent, '(a) untrusted').toEqual([]);
		act('pointerdown');
		act('keydown');
		await settle();
		expect(sent, '(a)').toEqual([{ what: 'POST /api/decision-by-link/seen', body: { token: 'tok-page', versionNumber: 1, stage: 'question' } }]);

		// (b) Hidden, a trusted action sends nothing; a scroll, which is trusted whoever caused it, is not watched (code review C3); a turn of the wheel once visible sends it.
		clear();
		draw(LinkPage, { data: linkData() });
		visibility = 'hidden';
		act('keydown');
		await settle();
		expect(sent, '(b) hidden').toEqual([]);
		visibility = 'visible';
		act('scroll');
		await settle();
		expect(sent, '(b) scroll').toEqual([]);
		act('wheel');
		await settle();
		expect(sent.map((r) => r.what), '(b)').toEqual(['POST /api/decision-by-link/seen']);

		// (c) A caller of /decisions/[id] who is no participant posts nothing at any action.
		clear();
		draw(DecisionPage, { data: pageData({ participant: null, mayRespond: false }) });
		for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) act(kind);
		await settle();
		expect(sent, '(c)').toEqual([]);

		// (d) A preview, with its form drawn disabled, makes no request at all.
		clear();
		const preview = draw(DecisionView, {
			decision: DECISION,
			content: CONTENT,
			options: OPTIONS,
			audiences: AUDIENCES,
			participant: { role: 'consulted' },
			mode: 'preview',
			response: html('<p>The preview’s form</p>')
		});
		const previewForm = draw(ResponseForm, { voteMode: 'single', options: OPTIONS, disabled: true });
		radio(previewForm, 'option-11').click();
		for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) act(kind);
		await settle();
		expect(preview.querySelector('[data-mode="preview"]')).not.toBeNull();
		expect(sent, '(d)').toEqual([]);

		// (e) The account page sends its response to its route; the link page to the link's, the token in the body.
		clear();
		const account = draw(DecisionPage, { data: pageData() });
		radio(account, 'option-11').click();
		flushSync();
		answer('POST /api/decisions/5/responses', { response: response(), unchanged: false });
		button(account, 'Send my response').click();
		await settle();
		expect(requests('POST /api/decisions/5/responses'), '(e) account').toEqual([{ versionNumber: 1, statement: 2, kind: 'vote', optionId: 11, comment: '', optionComments: {} }]);

		clear();
		const link = draw(LinkPage, { data: linkData() });
		radio(link, 'option-12').click();
		flushSync();
		answer('POST /api/decision-by-link/responses', { response: response({ optionId: 12 }), unchanged: false });
		button(link, 'Send my response').click();
		await settle();
		const responses = sent.filter((r) => r.what.includes('/responses'));
		expect(responses, '(e) link').toEqual([
			{ what: 'POST /api/decision-by-link/responses', body: { token: 'tok-page', versionNumber: 1, statement: 2, kind: 'vote', optionId: 12, comment: '', optionComments: {} } }
		]);
		expect(responses[0].what).not.toContain('tok-page');
	});

	it('34: say when the participant was told, "by email" only for a mail recorded as delivered, and that a withdrawn decision was withdrawn and why', () => {
		const told = (kind: 'asked_again' | 'told_of_change'): ToldMail => ({ kind, at: '2026-11-01 09:05:00', delivered: true });
		/** An invitation sent for `sentAs` (card 2742), whatever the participant's role now. */
		const invited = (sentAs: 'consulted' | 'informed' | null, delivered = true): ToldMail => ({ kind: 'invited', at: '2026-11-01 09:05:00', delivered, sentAs });
		const rows: [string, Partial<DecisionPageData>, string][] = [
			['(a) consulted, invited', {}, 'You were asked for your view on this decision on 2026-11-01 09:05 UTC, by email.'],
			[
				'(b) informed, invited',
				{ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: invited('informed') }, mayRespond: false },
				'You were told of this decision on 2026-11-01 09:05 UTC, by email, to keep you informed.'
			],
			[
				'(c) asked again',
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: told('asked_again') } },
				'This decision changed, and you were asked for your view again on 2026-11-01 09:05 UTC, by email.'
			],
			[
				'(d) told of a change',
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: told('told_of_change') } },
				'You were told of a change to this decision on 2026-11-01 09:05 UTC, by email.'
			],
			[
				'(e) invited, not delivered',
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: invited('consulted', false) } },
				'You were included in this decision on 2026-11-01 09:00 UTC.'
			],
			[
				'(f) withdrawn',
				{
					decision: { id: 5, ...DECISION, shownStatus: 'withdrawn', boardName: 'Website', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
					mayRespond: false,
					stage: 'withdrawal'
				},
				'This decision was withdrawn on 2026-11-03 10:00 UTC: The budget went.'
			],
			// Card 2742: the invitation in the role it was sent for, never the role now, both ways; with no role recorded, no purpose claimed.
			[
				'(g) consulted now, invited while informed',
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: invited('informed') } },
				'You were told of this decision on 2026-11-01 09:05 UTC, by email, to keep you informed.'
			],
			[
				'(h) informed now, invited while consulted',
				{ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: invited('consulted') }, mayRespond: false },
				'You were asked for your view on this decision on 2026-11-01 09:05 UTC, by email.'
			],
			[
				'(i) invited, no role recorded',
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: invited(null) } },
				'You were told of this decision on 2026-11-01 09:05 UTC, by email.'
			]
		];

		for (const [name, more, words] of rows) {
			clear();
			const target = draw(DecisionPage, { data: pageData(more) });
			const banner = [...target.querySelectorAll<HTMLElement>('[data-section="banner"] .banner-line')].map(textOf);
			expect(banner[0], name).toBe(words);
			if (name.startsWith('(e)')) expect(textOf(target.querySelector('[data-section="banner"]')!), name).not.toContain('by email');
		}
	});

	it('2708-4: on both pages, name the ruling mail with no moment and the withdrawal mail with its own, after the withdrawn line; either undelivered, the neutral words', () => {
		const ruled: Partial<DecisionPageData> = {
			decision: { id: 5, ...DECISION, shownStatus: 'ruled', closesAt: null, boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
			ruling: { label: 'B', title: 'Buy', noneOfThese: false, reason: 'It lasts.', conditions: null, ruledByName: 'Dee Cider' },
			mayRespond: false,
			stage: 'ruling'
		};
		const withdrawn: Partial<DecisionPageData> = {
			decision: { id: 5, ...DECISION, shownStatus: 'withdrawn', boardName: 'Website', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
			mayRespond: false,
			stage: 'withdrawal'
		};
		const toldBy = (told: ToldMail, role: 'consulted' | 'informed' = 'informed') => ({ participant: { role, includedAt: '2026-11-01 09:00:00', told } });
		const WITHDRAWN = 'This decision was withdrawn on 2026-11-03 10:00 UTC: The budget went.';
		const NEUTRAL = 'You were included in this decision on 2026-11-01 09:00 UTC.';
		const rows: [string, Partial<DecisionPageData>, string[]][] = [
			['(a) told of the ruling', { ...ruled, ...toldBy({ kind: 'told_ruling', delivered: true }) }, ['You were told of the ruling on this decision by email.']],
			['(b) the ruling mail not delivered', { ...ruled, ...toldBy({ kind: 'told_ruling', delivered: false }) }, [NEUTRAL]],
			[
				'(c) told of the withdrawal',
				{ ...withdrawn, ...toldBy({ kind: 'told_withdrawn', at: '2026-11-03 10:05:00', delivered: true }) },
				[WITHDRAWN, 'You were told this decision was withdrawn on 2026-11-03 10:05 UTC, by email.']
			],
			['(d) the withdrawal mail not delivered', { ...withdrawn, ...toldBy({ kind: 'told_withdrawn', at: '2026-11-03 10:05:00', delivered: false }) }, [WITHDRAWN, NEUTRAL]],
			// D4: the same words for both roles, as both mails go to every participant (card 2708's code review).
			['(e) told of the ruling, consulted', { ...ruled, ...toldBy({ kind: 'told_ruling', delivered: true }, 'consulted') }, ['You were told of the ruling on this decision by email.']],
			[
				'(f) told of the withdrawal, consulted',
				{ ...withdrawn, ...toldBy({ kind: 'told_withdrawn', at: '2026-11-03 10:05:00', delivered: true }, 'consulted') },
				[WITHDRAWN, 'You were told this decision was withdrawn on 2026-11-03 10:05 UTC, by email.']
			]
		];

		for (const [name, more, lines] of rows) {
			// The link page's decision as its loader gives it: no id and no board's name (code review C5).
			const { shownStatus, closesAt, withdrawnAt, withdrawnReason } = more.decision!;
			for (const [page, component, data] of [
				['signed in', DecisionPage, pageData(more)],
				['by link', LinkPage, linkData({ ...more, decision: { ...DECISION, shownStatus, closesAt, boardName: null, withdrawnAt, withdrawnReason } })]
			] as const) {
				clear();
				const target = draw(component, { data });
				const banner = target.querySelector<HTMLElement>('[data-section="banner"]')!;
				expect([...banner.querySelectorAll<HTMLElement>('.banner-line')].map(textOf), `${name}, ${page}`).toEqual(lines);
				if (name.includes('not delivered')) expect(textOf(banner), `${name}, ${page}`).not.toContain('by email');
			}
		}
	});

	it('arm the seen watch again and draw the form afresh when the data changes to another version, and leave both be for the same data read again (code review C2)', async () => {
		const props = $state({ data: pageData() });
		const target = draw(DecisionPage, props);
		act('pointerdown');
		await settle();
		expect(requests('POST /api/decisions/5/seen'), 'version 1').toEqual([{ versionNumber: 1, stage: 'question' }]);
		radio(target, 'option-12').click();
		flushSync();

		// The same decision, version and stage read again: no new watch, and the form keeps what was chosen.
		props.data = pageData();
		flushSync();
		act('pointerdown');
		await settle();
		expect(requests('POST /api/decisions/5/seen'), 'read again').toHaveLength(1);
		expect(radio(target, 'option-12').checked, 'read again').toBe(true);

		// Version 2: the watch is armed for it, and the form starts again from nothing.
		props.data = pageData({ version: { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT } });
		flushSync();
		expect(radio(target, 'option-12').checked, 'version 2').toBe(false);
		act('keydown');
		await settle();
		expect(requests('POST /api/decisions/5/seen'), 'version 2').toEqual([
			{ versionNumber: 1, stage: 'question' },
			{ versionNumber: 2, stage: 'question' }
		]);

		// Another decision: its own watch, at its own route.
		props.data = pageData({ decision: { id: 6, ...DECISION, boardName: 'Website', withdrawnAt: null, withdrawnReason: null } });
		flushSync();
		act('touchstart');
		await settle();
		expect(requests('POST /api/decisions/6/seen'), 'decision 6').toEqual([{ versionNumber: 1, stage: 'question' }]);
	});

	it('label a response given on an older version, and on a ruled, superseded or withdrawn decision say responses are closed, with the last response where there is one (code review C1, C7, C8)', async () => {
		// (a) Open, after a re-publish that only told: the form's recorded response is labelled with its version.
		const open = draw(DecisionPage, {
			data: pageData({ version: { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT }, ownResponse: response() })
		});
		expect(linesOf(open.querySelector('.recorded')!), '(a)').toEqual([
			'Your response was recorded on 2026-11-02 10:00 UTC:',
			'You chose option A: Rent.',
			'Given on version 1. Send it again to give it on version 2.'
		]);

		const closed = (shownStatus: 'ruled' | 'superseded' | 'withdrawn', more: Partial<DecisionPageData>) =>
			pageData({
				decision: { id: 5, ...DECISION, shownStatus, boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
				mayRespond: false,
				stage: shownStatus === 'withdrawn' ? 'withdrawal' : null,
				...more
			});
		const rows: [string, DecisionPageData, string[]][] = [
			[
				'(b) ruled, a response on an older version',
				closed('ruled', { version: { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT }, ownResponse: response() }),
				['Responses are closed.', 'Your last response:', 'You chose option A: Rent.', 'Given on version 1.']
			],
			['(c) superseded, a response on this version', closed('superseded', { ownResponse: response({ kind: 'abstain', optionId: null }) }), ['Responses are closed.', 'Your last response:', 'You abstained.']],
			['(d) withdrawn, no response', closed('withdrawn', {}), ['Responses are closed.']]
		];
		for (const [name, data, lines] of rows) {
			clear();
			const target = draw(DecisionPage, { data });
			expect(linesOf(target.querySelector('[data-section="response"]')!), name).toEqual(lines);
			expect(target.querySelector('.response-form'), name).toBeNull();
		}

		// (e) A ruled decision, on either page, arms the watch with the ruling stage, says so, and posts it once (card 2679, decision 9).
		for (const [page, data, seen] of [
			[DecisionPage, closed('ruled', { stage: 'ruling' }), { what: 'POST /api/decisions/5/seen', body: { versionNumber: 1, stage: 'ruling' } }],
			[
				LinkPage,
				{ ...closed('ruled', { stage: 'ruling' }), via: 'link', decision: { ...DECISION, shownStatus: 'ruled', boardName: null, withdrawnAt: null, withdrawnReason: null } },
				{ what: 'POST /api/decision-by-link/seen', body: { token: 'tok-page', versionNumber: 1, stage: 'ruling' } }
			]
		] as const) {
			clear();
			const target = draw(page, { data });
			expect(textOf(target.querySelector('[data-note="seen"]')!), '(e)').toBe(
				'Your first tap, click, key press or turn of the mouse wheel on this page is recorded as your having seen the ruling.'
			);
			for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) act(kind);
			await settle();
			expect(sent, '(e)').toEqual([seen]);
		}
	});
});

// ─── The shared parts (card 2707, plan cases 2707-1 to 2707-3) ──────────────

describe('the parts both participant pages share (card 2707)', () => {
	const RULING: RulingView = { label: 'B', title: 'Buy', noneOfThese: false, reason: 'It lasts.', conditions: 'Review in a year.', ruledByName: 'Dee Cider' };
	type DecisionMore = Partial<Pick<DecisionPageData['decision'], 'shownStatus' | 'closesAt' | 'withdrawnAt' | 'withdrawnReason'>>;
	/** The same data for both pages: the signed-in page's with the decision's id and board, the link page's with neither, as each is given. */
	const both = (decision: DecisionMore, more: Partial<DecisionPageData>) => ({
		session: pageData({ ...more, decision: { id: 5, ...DECISION, boardName: 'Website', withdrawnAt: null, withdrawnReason: null, ...decision } }),
		link: linkData({ ...more, decision: { ...DECISION, boardName: null, withdrawnAt: null, withdrawnReason: null, ...decision } })
	});
	/** Each element of a section, as markup; the form's radio group name is drawn from a per-mount id and set aside. */
	const partsOf = (target: Element, section: string) =>
		[...(target.querySelector(`[data-section="${section}"]`)?.children ?? [])].map((el) => el.outerHTML.replace(/name="response-[^"]*"/g, 'name="response"'));

	it('2707-1: draw the same banner and response from the same data on either page, the link page adding only its two personal-link lines', () => {
		const version2 = { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT };
		const asked = 'You were asked for your view on this decision on 2026-11-01 09:05 UTC, by email.';
		/**
		 * Each state, with what both pages must draw for it (code review, 2026-11-04): the banner's opening
		 * line, and the response section's lines below its heading, all of them where no form is drawn and
		 * its opening lines where one is, so that a branch of `ParticipantResponse` gone fails here.
		 */
		const rows: {
			name: string;
			decision: DecisionMore;
			more: Partial<DecisionPageData>;
			bannerOpens: string;
			responseLines: string[];
			form: boolean;
		}[] = [
			{
				name: '(a) open, an earlier round’s response, the form',
				decision: {},
				more: { version: version2, earlierResponse: response({ comment: 'Cheaper' }) },
				bannerOpens: asked,
				responseLines: ['This decision changed on 2026-11-02 09:00 UTC. Your earlier response was for version 1:', 'You chose option A: Rent.', 'Your comment: Cheaper'],
				form: true
			},
			{
				name: '(b) awaiting the ruling, a response given',
				decision: { shownStatus: 'awaiting_ruling' },
				more: { mayRespond: false, ownResponse: response() },
				bannerOpens: asked,
				responseLines: ['Responses closed on 2099-12-01 12:00 UTC.', 'Your response:', 'You chose option A: Rent.'],
				form: false
			},
			{
				name: '(c) awaiting the ruling, no response given',
				decision: { shownStatus: 'awaiting_ruling' },
				more: { mayRespond: false },
				bannerOpens: asked,
				responseLines: ['Responses closed on 2099-12-01 12:00 UTC.', 'You gave no response in this round.'],
				form: false
			},
			{
				name: '(d) ruled, a response on an older version, the ruling',
				decision: { shownStatus: 'ruled', closesAt: null },
				more: { version: version2, mayRespond: false, ownResponse: response(), ruling: RULING, stage: 'ruling' },
				bannerOpens: 'Ruled by Dee Cider: Option B: Buy',
				responseLines: ['Responses are closed.', 'Your last response:', 'You chose option A: Rent.', 'Given on version 1.'],
				form: false
			},
			{
				name: '(e) withdrawn',
				decision: { shownStatus: 'withdrawn', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
				more: { mayRespond: false, stage: 'withdrawal' },
				bannerOpens: 'This decision was withdrawn on 2026-11-03 10:00 UTC: The budget went.',
				responseLines: ['Responses are closed.'],
				form: false
			}
		];

		for (const { name, decision, more, bannerOpens, responseLines, form } of rows) {
			// The signed-in page is handed the account name too, and still draws no personal-link line.
			const data = both(decision, { ...more, signedInAs: 'Sam' });
			clear();
			const session = draw(DecisionPage, { data: data.session });
			const link = draw(LinkPage, { data: data.link });

			const sessionBanner = partsOf(session, 'banner');
			const linkBanner = partsOf(link, 'banner');
			expect(sessionBanner.length, name).toBeGreaterThan(0);
			expect(linkBanner.slice(0, -2), name).toEqual(sessionBanner);
			// The link page's two lines: the personal address, then the signed-in note, whose words are 2735-1's to hold.
			const [personal, signedIn] = [...link.querySelectorAll('[data-section="banner"] > p')].slice(-2);
			expect(textOf(personal), name).toBe('This address is personal to you: do not share it.');
			expect(signedIn.classList.contains('signed-in'), name).toBe(true);
			expect(textOf(session.querySelector('[data-section="banner"]')!), name).not.toMatch(/personal to you|signed in as/);

			// Each page, against the words expected rather than only against the other page.
			for (const [page, target] of [
				['signed in', session],
				['link', link]
			] as const) {
				expect(textOf(target.querySelector('[data-section="banner"] p')!), `${name}, ${page}`).toBe(bannerOpens);
				// `linesOf` reads paragraphs alone, so DecisionView's own `<h2>Your response</h2>` is never counted here.
				const lines = linesOf(target.querySelector('[data-section="response"]')!);
				expect(form ? lines.slice(0, responseLines.length) : lines, `${name}, ${page}`).toEqual(responseLines);
				expect(target.querySelector('.response-form') !== null, `${name}, ${page}: the form`).toBe(form);
			}

			const sessionResponse = partsOf(session, 'response');
			expect(partsOf(link, 'response'), name).toEqual(sessionResponse);
		}
	});

	it('2735-1: in a signed-in browser, the link page says what is recorded with the account in each state and role, and no more', () => {
		const informed: DecisionPageData['participant'] = { role: 'informed', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: '2026-11-01 09:05:00', delivered: true, sentAs: 'informed' } };
		const ruled = { ruling: RULING, stage: 'ruling' as const, mayRespond: false };
		/**
		 * Each state the server can give the link page, with the flags it gives and the words the note must
		 * say (plan section 3): each write clause follows its flag, so a per-person limit drops it too.
		 */
		const rows: { name: string; decision: DecisionMore; more: Partial<DecisionPageData>; says: string }[] = [
			{ name: 'open, consulted', decision: {}, more: { mayAsk: true }, says: 'with your response, with your questions and with your having seen this version.' },
			{ name: 'open, consulted, at the questions limit', decision: {}, more: { mayAsk: false }, says: 'with your response and with your having seen this version.' },
			{ name: 'open, informed: no response', decision: {}, more: { participant: informed, mayRespond: false, mayAsk: true }, says: 'with your questions and with your having seen this version.' },
			{ name: 'awaiting the ruling, consulted', decision: { shownStatus: 'awaiting_ruling' }, more: { mayRespond: false, mayAsk: true }, says: 'with your questions and with your having seen this version.' },
			{ name: 'awaiting the ruling, informed', decision: { shownStatus: 'awaiting_ruling' }, more: { participant: informed, mayRespond: false, mayAsk: true }, says: 'with your questions and with your having seen this version.' },
			{ name: 'ruled, consulted', decision: { shownStatus: 'ruled', closesAt: null }, more: { ...ruled, mayRaiseConcern: true }, says: 'with your concern and with your having seen the ruling.' },
			{ name: 'ruled, informed', decision: { shownStatus: 'ruled', closesAt: null }, more: { ...ruled, mayRaiseConcern: true, participant: informed }, says: 'with your concern and with your having seen the ruling.' },
			{ name: 'ruled, past the concern limit', decision: { shownStatus: 'ruled', closesAt: null }, more: { ...ruled, mayRaiseConcern: false }, says: 'with your having seen the ruling.' },
			{ name: 'superseded', decision: { shownStatus: 'superseded', closesAt: null }, more: ruled, says: 'with your having seen the ruling.' },
			{
				name: 'withdrawn',
				decision: { shownStatus: 'withdrawn', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
				more: { mayRespond: false, stage: 'withdrawal' },
				says: 'with your having seen this version.'
			}
		];

		for (const { name, decision, more, says } of rows) {
			const data = both(decision, more);
			clear();
			const signedIn = draw(LinkPage, { data: { ...data.link, signedInAs: 'Sam' } });
			expect([...signedIn.querySelectorAll('.signed-in')].map(textOf), name).toEqual([`You are signed in as Sam; this is recorded ${says}`]);
			// The same state signed out draws no such line.
			clear();
			const signedOut = draw(LinkPage, { data: data.link });
			expect(signedOut.querySelector('.signed-in'), `${name}, signed out`).toBeNull();
		}

		// With no participant or no stage the note claims nothing, whatever the flags say (fail closed).
		const every = { mayRespond: true, mayAsk: true, mayObject: true, mayAskToTalk: true, mayRaiseConcern: true, seenRecorded: false };
		expect(signedInNoteWords('Sam', false, 'question', every)).toBe('You are signed in as Sam.');
		expect(signedInNoteWords('Sam', true, null, every)).toBe('You are signed in as Sam.');
	});

	it('2736-3: where the participant’s seen already exists, the signed-in note claims no seen in any state, and claims nothing where the seen was all it named', () => {
		const informed: DecisionPageData['participant'] = { role: 'informed', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: '2026-11-01 09:05:00', delivered: true, sentAs: 'informed' } };
		const ruled = { ruling: RULING, stage: 'ruling' as const, mayRespond: false };
		/** 2735-1's states, each with the seen already recorded: the write clauses stay, the seen clause goes. */
		const rows: { name: string; decision: DecisionMore; more: Partial<DecisionPageData>; says: string }[] = [
			{ name: 'open, consulted', decision: {}, more: { mayAsk: true }, says: '; this is recorded with your response and with your questions.' },
			{ name: 'open, informed', decision: {}, more: { participant: informed, mayRespond: false, mayAsk: true }, says: '; this is recorded with your questions.' },
			{ name: 'awaiting the ruling', decision: { shownStatus: 'awaiting_ruling' }, more: { mayRespond: false, mayAsk: true }, says: '; this is recorded with your questions.' },
			{ name: 'ruled, under the concern limit', decision: { shownStatus: 'ruled', closesAt: null }, more: { ...ruled, mayRaiseConcern: true }, says: '; this is recorded with your concern.' },
			{ name: 'ruled, past the concern limit', decision: { shownStatus: 'ruled', closesAt: null }, more: { ...ruled, mayRaiseConcern: false }, says: '.' },
			{ name: 'superseded', decision: { shownStatus: 'superseded', closesAt: null }, more: ruled, says: '.' },
			{
				name: 'withdrawn',
				decision: { shownStatus: 'withdrawn', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
				more: { mayRespond: false, stage: 'withdrawal' },
				says: '.'
			}
		];

		for (const { name, decision, more, says } of rows) {
			clear();
			const page = draw(LinkPage, { data: { ...both(decision, { ...more, seenRecorded: true }).link, signedInAs: 'Sam' } });
			expect([...page.querySelectorAll('.signed-in')].map(textOf), name).toEqual([`You are signed in as Sam${says}`]);
		}

		// The clause follows the flag alone: the same state, not yet seen, keeps it.
		const flags = { mayRespond: false, mayAsk: false, mayObject: false, mayAskToTalk: false, mayRaiseConcern: false };
		expect(signedInNoteWords('Sam', true, 'ruling', { ...flags, seenRecorded: false })).toBe('You are signed in as Sam; this is recorded with your having seen the ruling.');
		expect(signedInNoteWords('Sam', true, 'ruling', { ...flags, seenRecorded: true })).toBe('You are signed in as Sam.');
	});

	it('2736-4: on either page, signed in or out, a first visit draws the seen note and posts the seen once; a repeat visit draws no seen note and arms no watch', async () => {
		const SEEN_NOTE = 'Your first tap, click, key press or turn of the mouse wheel on this page is recorded as your having seen this version.';
		const ruled: DecisionMore = { shownStatus: 'ruled', closesAt: null };
		for (const [state, decision, more, stage] of [
			['open', {}, {}, 'question'],
			['ruled', ruled, { ruling: RULING, stage: 'ruling', mayRespond: false }, 'ruling']
		] as const) {
			for (const [page, component, data, url] of [
				['signed in', DecisionPage, (seenRecorded: boolean) => both(decision, { ...more, seenRecorded }).session, 'POST /api/decisions/5/seen'],
				['by link, signed out', LinkPage, (seenRecorded: boolean) => both(decision, { ...more, seenRecorded }).link, 'POST /api/decision-by-link/seen'],
				['by link, signed in', LinkPage, (seenRecorded: boolean) => ({ ...both(decision, { ...more, seenRecorded }).link, signedInAs: 'Sam' }), 'POST /api/decision-by-link/seen']
			] as const) {
				const name = `${state}, ${page}`;
				const token = component === LinkPage ? { token: 'tok-page' } : {};

				// A first visit: the note, and the seen posted once at the first action.
				clear();
				const first = draw(component, { data: data(false) });
				expect([...first.querySelectorAll('[data-note="seen"]')].map(textOf), `${name}, first visit`).toEqual([
					stage === 'ruling' ? SEEN_NOTE.replace('this version', 'the ruling') : SEEN_NOTE
				]);
				for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) act(kind);
				await settle();
				expect(sent, `${name}, first visit`).toEqual([{ what: url, body: { ...token, versionNumber: 1, stage } }]);

				// A repeat visit: the seen exists, so no note and no watch, whatever the person does.
				clear();
				const repeat = draw(component, { data: data(true) });
				expect(repeat.querySelector('[data-note="seen"]'), `${name}, repeat visit`).toBeNull();
				expect(repeat.querySelector('[data-section="banner"] .banner-line'), `${name}, repeat visit: the told line stays`).not.toBeNull();
				for (const kind of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) act(kind);
				await settle();
				expect(sent, `${name}, repeat visit`).toEqual([]);
			}
		}
	});

	it('2707-2: handed every field only the signed-in page has, the link page draws none of them, where the signed-in page draws each', () => {
		const everything: Partial<DecisionPageData> = {
			decision: { id: 5, ...DECISION, shownStatus: 'ruled', closesAt: null, boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
			mayRespond: false,
			stage: 'ruling',
			ruling: RULING,
			supersedes: { id: 4, title: 'Plan A first' },
			laterDecision: { superseded: false, id: 7, title: 'Plan C' },
			mayEdit: true,
			mayReadResults: true,
			maySupersede: true,
			mayReadRecord: true,
			mayAnswer: true,
			linkedCards: [{ id: 21, title: 'Build the site', boardId: 3, boardName: 'Shop', archived: false, relation: 'relates' }],
			mayLinkCards: true,
			mayUnlinkCards: true,
			mayMarkWaiting: true
		};

		// The signed-in page draws each, so the link page's absences below are not empty checks.
		const session = draw(DecisionPage, { data: pageData(everything) });
		expect([...session.querySelectorAll('[data-section="banner"] a')].map((a) => a.getAttribute('href'))).toEqual(['/decisions/7', '/decisions/4']);
		// Card 2688 (R14, E-M1): and the decision as a PDF, the shareable copy and the full record.
		expect([...session.querySelectorAll<HTMLElement>('.page-actions [data-action]')].map((a) => a.dataset.action)).toEqual([
			'results',
			'record',
			'supersede',
			'export-shareable',
			'export-full'
		]);
		expect(session.querySelector('.edit-link')).not.toBeNull();
		expect(textOf(session.querySelector('.crumb')!)).toBe('Website');
		expect(session.querySelector('[data-section="linked-cards"]')).not.toBeNull();
		// Card 2687: the toggle that marks a card as waiting.
		const toggle = session.querySelector('button[data-action="wait"]')!;
		expect([toggle.textContent, toggle.getAttribute('aria-pressed'), toggle.getAttribute('aria-label')]).toEqual([
			'Waits on this decision',
			'false',
			'Waits on this decision: #21 Build the site'
		]);

		// The same data on the link page, as a loader handing it too much would.
		clear();
		const link = draw(LinkPage, { data: { ...pageData(everything), via: 'link' } });
		expect(link.querySelector('[data-section="banner"]')).not.toBeNull();
		expect(link.querySelectorAll('[href]')).toHaveLength(0);
		expect(link.innerHTML).not.toContain('/decisions/');
		expect(link.querySelector('.page-actions, [data-panel="supersede"], .edit-link, .crumb, [data-section="linked-cards"]')).toBeNull();
		expect(textOf(link.querySelector('[data-line="later"]')!)).toBe('A later decision was ruled on without superseding this one');
		expect(textOf(link.querySelector('[data-line="earlier"]')!)).toBe('This decision supersedes an earlier decision');
		const text = textOf(link);
		for (const word of [
			'Plan A first',
			'Plan C',
			'Website',
			'Build the site',
			'Shop',
			'Results and ruling',
			'Record',
			'Supersede',
			'Edit',
			'Waits on this decision',
			// Card 2688 (R14): no export from the personal link's page.
			'Shareable copy (PDF)',
			'Full record (PDF)'
		]) {
			expect(text, word).not.toContain(word);
		}
		expect(link.querySelector('button[data-action="wait"]')).toBeNull();
		// Card 3075 (A4): the bare frame draws no Theme menu, and the side column is drawn, so the checks above cover it too.
		expect(link.querySelector('button[title="Change theme"]')).toBeNull();
		expect(link.querySelector('aside [data-rail="facts"]')).not.toBeNull();
	});

	it('T4 (card 3075): the decision page draws its side column: the facts and the actions in the aside, the decision in the main column', () => {
		const target = draw(DecisionPage, { data: pageData({ mayReadResults: true, mayReadRecord: true, maySupersede: true }) });
		const main = target.querySelector('main.ui-shell-grid')!;
		expect(main).not.toBeNull();
		const aside = main.querySelector('aside[aria-label="About this decision"]')!;
		expect(aside.querySelector('[data-rail="facts"]')).not.toBeNull();
		expect(aside.querySelector('.page-actions')).not.toBeNull();
		expect(main.querySelector('.ui-shell-content .page-actions')).toBeNull();
		expect(main.querySelector('.ui-shell-content .decision-view')).not.toBeNull();
		expect(aside.querySelector('.decision-view')).toBeNull();
	});

	it('T5 (card 3075): the facts in order, before the actions; the response row links to #response, DecisionView’s response section; none for an informed participant', () => {
		const consulted = draw(DecisionPage, { data: pageData({ mayReadResults: true }) });
		const facts = consulted.querySelector('[data-rail="facts"]')!;
		expect([...facts.querySelectorAll<HTMLElement>('[data-fact]')].map((row) => row.dataset.fact)).toEqual(['closes', 'decider', 'part', 'response']);
		expect([...facts.querySelectorAll('[data-fact]')].map(textOf)).toEqual([
			'Closes 2099-12-01 12:00 UTC',
			'Decider Dee Cider',
			'Your part Consulted',
			'Your response Not given yet Go to the form'
		]);
		const actions = consulted.querySelector('[data-rail="actions"]')!;
		expect(facts.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		const toForm = facts.querySelector('[data-fact="response"] a')!;
		expect(toForm.getAttribute('href')).toBe('#response');
		expect(consulted.querySelector('#response')).toBe(consulted.querySelector('[data-section="response"]'));

		clear();
		const informed = draw(DecisionPage, {
			data: pageData({ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: null }, mayRespond: false })
		});
		expect([...informed.querySelectorAll<HTMLElement>('[data-rail="facts"] [data-fact]')].map((row) => row.dataset.fact)).toEqual(['closes', 'decider', 'part']);
	});

	it('T7 (card 3075, review M1): on either page, a response recorded reads the page again once, and the side column then says it was given', async () => {
		for (const [name, page, data, route, given] of [
			['signed in', DecisionPage, pageData, 'POST /api/decisions/5/responses', 'Your response Given 2026-11-02 10:00 UTC; you can change it Go to the form'],
			['link', LinkPage, linkData, 'POST /api/decision-by-link/responses', 'Your response Given 2026-11-02 10:00 UTC; you can change it']
		] as const) {
			clear();
			navigation.invalidateAll.mockClear();
			const target = draw(page, { data: data() });
			expect(textOf(target.querySelector('[data-fact="response"]')!), name).toBe(name === 'link' ? 'Your response Not given yet' : 'Your response Not given yet Go to the form');
			radio(target, 'option-12').click();
			flushSync();
			answer(route, { response: response({ optionId: 12 }), unchanged: false });
			button(target, 'Send my response').click();
			await settle();
			expect(navigation.invalidateAll, name).toHaveBeenCalledTimes(1);

			// The page's data read again holds the response: the side column says so.
			clear();
			const readAgain = draw(page, { data: data({ ownResponse: response({ optionId: 12 }) }) });
			expect(textOf(readAgain.querySelector('[data-fact="response"]')!), name).toBe(given);
		}
	});

	it('2707-3: on either page, Reload after the stale-version 409 reads the page again once and draws the form afresh', async () => {
		for (const [name, page, data, route] of [
			['signed in', DecisionPage, pageData(), 'POST /api/decisions/5/responses'],
			['link', LinkPage, linkData(), 'POST /api/decision-by-link/responses']
		] as const) {
			clear();
			navigation.invalidateAll.mockClear();
			const target = draw(page, { data });
			radio(target, 'option-12').click();
			flushSync();
			answer(route, { message: STALE_REVISION }, 409);
			button(target, 'Send my response').click();
			await settle();
			expect(textOf(target.querySelector('[role="alert"]')!), name).toBe(STALE_REVISION);

			button(target, 'Reload').click();
			await settle();
			expect(navigation.invalidateAll, name).toHaveBeenCalledTimes(1);
			expect(radio(target, 'option-12').checked, name).toBe(false);
			expect(target.querySelector('[role="alert"]'), name).toBeNull();
		}
	});
});

// ─── Survey questions (card 2683, slice S3b: cases U1 to U3 and U8) ─────────

describe('survey questions (card 2683)', () => {
	const SURVEY: ViewSurveyQuestion[] = [
		{ questionId: 41, kind: 'choice', prompt: 'Where do you ship from?', help: 'The **main** site.', required: true, choices: ['Leeds', 'York'], agentDrafted: false },
		{ questionId: 42, kind: 'scale', prompt: 'How busy are you?', help: '', required: false, scale: { max: 5, lowLabel: 'Quiet', highLabel: 'Flat out' }, agentDrafted: true },
		{ questionId: 43, kind: 'text', prompt: 'Anything else?', help: '', required: true, agentDrafted: false }
	];
	const question = (within: ParentNode, id: number) => within.querySelector<HTMLFieldSetElement>(`fieldset[data-question="${id}"]`)!;
	const pick = (within: ParentNode, id: number, value: string) => {
		question(within, id).querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!.click();
		flushSync();
	};
	const writtenIn = (within: ParentNode, id: number) => question(within, id).querySelector<HTMLTextAreaElement>('textarea')!;
	const survey = (more: Partial<DecisionPageData> = {}) => pageData({ options: [], surveyQuestions: SURVEY, ...more });

	it('U1: a survey offers "I answer the questions" and "I abstain" alone, and sends the answers keyed by question id, said back by prompt', async () => {
		const target = drawForm({ options: [], surveyQuestions: SURVEY, deciderName: 'Dee Cider' });
		expect([...target.querySelectorAll<HTMLInputElement>('fieldset.choices input[type="radio"]')].map((r) => r.value)).toEqual(['answered', 'abstain']);
		expect(target.querySelector('input[value="no_concerns"], input[value^="option-"]')).toBeNull();
		expect(target.querySelector('.option-comments')).toBeNull();

		// Answering chooses "I answer the questions" where nothing is chosen yet.
		pick(target, 41, '1');
		expect(radio(target, 'answered').checked).toBe(true);
		pick(target, 42, '4');
		type(writtenIn(target, 43), 'We ship on Tuesdays');
		const given = { '41': 1, '42': 4, '43': 'We ship on Tuesdays' };
		answer('POST /api/decisions/5/responses', { response: response({ kind: 'answered', optionId: null, answers: given }), unchanged: false });
		button(target, 'Send my response').click();
		await settle();

		expect(requests('POST /api/decisions/5/responses')).toEqual([{ versionNumber: 1, statement: 2, kind: 'answered', comment: '', optionComments: {}, answers: given }]);
		expect(linesOf(target.querySelector('.recorded')!)).toEqual([
			'Your response was recorded on 2026-11-02 10:00 UTC:',
			'You answered the survey questions.',
			'Where do you ship from?: York',
			'How busy are you?: 4 of 5',
			'Anything else?: We ship on Tuesdays'
		]);
	});

	it('U2: Send is held until every required question is answered, spaces alone being no answer; abstaining is not held', async () => {
		const target = drawForm({ surveyQuestions: SURVEY });
		const send = button(target, 'Send my response');
		radio(target, 'option-11').click();
		flushSync();
		expect(send.disabled).toBe(true);
		expect(target.querySelector('[data-note="required"]')).not.toBeNull();
		pick(target, 41, '0');
		type(writtenIn(target, 43), '   ');
		expect(send.disabled, 'spaces alone').toBe(true);
		type(writtenIn(target, 43), 'Tuesdays');
		expect(send.disabled).toBe(false);
		expect(target.querySelector('[data-note="required"]')).toBeNull();
		answer('POST /api/decisions/5/responses', { response: response({ answers: { '41': 0, '43': 'Tuesdays' } }), unchanged: false });
		send.click();
		await settle();
		expect(requests('POST /api/decisions/5/responses')).toEqual([
			{ versionNumber: 1, statement: 2, kind: 'vote', optionId: 11, comment: '', optionComments: {}, answers: { '41': 0, '43': 'Tuesdays' } }
		]);

		clear();
		const abstaining = drawForm({ options: [], surveyQuestions: SURVEY });
		radio(abstaining, 'abstain').click();
		flushSync();
		expect(button(abstaining, 'Send my response').disabled).toBe(false);
		radio(abstaining, 'answered').click();
		flushSync();
		expect(button(abstaining, 'Send my response').disabled).toBe(true);
	});

	it('F8: an optional choice or scale answer can be cleared, and is not sent; a required one has no Clear; each scale point is described by the words at its ends', async () => {
		const target = drawForm({ options: [], surveyQuestions: SURVEY });
		const clearIn = (id: number) => question(target, id).querySelector<HTMLButtonElement>('[data-action="clear-answer"]');
		const points = [...question(target, 42).querySelectorAll<HTMLInputElement>('input[type="radio"]')];
		const ends = document.getElementById(points[0].getAttribute('aria-describedby')!)!;
		expect(textOf(ends)).toBe('A number from 1 (Quiet) to 5 (Flat out).');
		expect(points.map((point) => point.getAttribute('aria-describedby'))).toEqual(points.map(() => ends.id));
		expect(points.map((point) => point.getAttribute('aria-label'))).toEqual(['1 of 5, Quiet', '2 of 5', '3 of 5', '4 of 5', '5 of 5, Flat out']);

		expect(clearIn(42)).toBeNull();
		pick(target, 41, '0');
		pick(target, 42, '4');
		expect(clearIn(41), 'required').toBeNull();
		expect(clearIn(42)!.getAttribute('aria-label')).toBe('Clear the answer to question 2');
		clearIn(42)!.click();
		flushSync();
		expect(points.filter((point) => point.checked)).toEqual([]);
		expect(clearIn(42)).toBeNull();

		type(writtenIn(target, 43), 'Tuesdays');
		answer('POST /api/decisions/5/responses', { response: response({ kind: 'answered', optionId: null, answers: { '41': 0, '43': 'Tuesdays' } }), unchanged: false });
		button(target, 'Send my response').click();
		await settle();
		expect(requests('POST /api/decisions/5/responses')).toEqual([
			{ versionNumber: 1, statement: 2, kind: 'answered', comment: '', optionComments: {}, answers: { '41': 0, '43': 'Tuesdays' } }
		]);
	});

	it('U3: an informed participant reads the questions with no input, and who sees the answers; a consulted one answers them in the form, each box with the note', () => {
		const informed = draw(DecisionPage, { data: survey({ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: null }, mayRespond: false }) });
		const section = informed.querySelector('[data-section="survey"]')!;
		expect(section.querySelector('input, textarea')).toBeNull();
		expect([...section.querySelectorAll('legend')].map(textOf)).toEqual(['1. Where do you ship from? (required)', '2. How busy are you?', '3. Anything else? (required)']);
		expect([...section.querySelectorAll('li')].map(textOf)).toEqual(['Leeds', 'York']);
		expect(textOf(question(section, 42).querySelector('.scale-ends')!)).toBe('A number from 1 (Quiet) to 5 (Flat out).');
		expect(textOf(question(section, 41).querySelector('.markdown-body strong')!)).toBe('main');
		expect([...section.querySelectorAll<HTMLElement>('.agent-label')].map((l) => l.dataset.flag)).toEqual(['survey.42']);
		const whoSees = textOf(section.querySelector('[data-note="survey-who-sees"]')!);
		expect(whoSees).toBe(surveyWhoSees('Dee Cider'));
		expect(whoSees).toContain('whoever decides (now Dee Cider)');
		expect(whoSees).toContain('releases nothing');
		expect(section.querySelector('[data-note="survey-text"]')).toBeNull();

		clear();
		const consulted = draw(DecisionPage, { data: survey() });
		expect(consulted.querySelector('[data-section="survey"]'), 'drawn once, in the form').toBeNull();
		const form = consulted.querySelector('[data-section="response"] .response-form')!;
		expect(textOf(form.querySelector('[data-note="survey-who-sees"]')!)).toBe(surveyWhoSees('Dee Cider'));
		expect([...form.querySelectorAll('[data-note="survey-text"]')].map(textOf)).toEqual([SURVEY_TEXT_NOTE]);
		expect(writtenIn(form, 43).getAttribute('aria-describedby')).toBe(form.querySelector('[data-note="survey-text"]')!.id);
	});

	it('U8: on a survey round who sees a response is said without its release sentence; on a round with options it is whole', () => {
		const surveyed = draw(DecisionPage, { data: survey() });
		const words = textOf(surveyed.querySelector('[data-section="who-sees"] p')!);
		expect(words).toBe(whoSeesStatement('Dee Cider', false));
		expect(words).not.toContain('After the ruling');
		expect(words).toContain('No other participant sees it, or any totals.');

		clear();
		const voting = draw(DecisionPage, { data: pageData({ surveyQuestions: SURVEY }) });
		expect(textOf(voting.querySelector('[data-section="who-sees"] p')!)).toBe(whoSeesStatement('Dee Cider'));
		expect(textOf(voting.querySelector('[data-section="who-sees"] p')!)).toContain('After the ruling, the decider may show the totals');
	});

	it('S3b: a response of this round is said back with its answers by prompt; one of an earlier round says how many, not what', () => {
		const closed = draw(DecisionPage, {
			data: survey({
				decision: { id: 5, ...DECISION, shownStatus: 'awaiting_ruling', boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
				mayRespond: false,
				ownResponse: response({ kind: 'answered', optionId: null, answers: { '41': 0, '43': 'Tuesdays' } })
			})
		});
		const section = closed.querySelector('[data-section="response"]')!;
		expect(section.querySelector('input, textarea')).toBeNull();
		expect(section.querySelectorAll('fieldset[data-question]')).toHaveLength(3);
		expect([...section.querySelectorAll('.response-line')].map(textOf)).toEqual(['You answered the survey questions.', 'Where do you ship from?: Leeds', 'Anything else?: Tuesdays']);

		clear();
		const later = draw(DecisionPage, {
			data: survey({
				version: { number: 2, publishedAt: '2026-11-02 09:00:00', content: CONTENT },
				earlierResponse: response({ kind: 'answered', optionId: null, answers: { '41': 0, '43': 'Tuesdays' } })
			})
		});
		expect(linesOf(later.querySelector('.earlier')!)).toEqual([
			'This decision changed on 2026-11-02 09:00 UTC. Your earlier response was for version 1:',
			'You answered the survey questions.',
			'You also answered 2 survey questions as that version asked them.'
		]);
		expect(textOf(later.querySelector('.earlier')!)).not.toContain('Tuesdays');
	});
});

// ─── Objections and requests to talk (card 2684, slice S3: U1 to U3) ────────

describe('objections and requests to talk on the participant pages (card 2684)', () => {
	const flagsOf = (target: HTMLElement) => target.querySelector<HTMLElement>('[data-section="flags"]');
	const formOf = (target: HTMLElement, kind: 'objection' | 'talk') => target.querySelector<HTMLFormElement>(`form[data-form="${kind}"]`);
	const boxOf = (form: HTMLFormElement) => {
		const area = form.querySelector<HTMLTextAreaElement>('textarea')!;
		expect(form.querySelector(`label[for="${area.id}"]`), 'labelled').not.toBeNull();
		return area;
	};
	const sendOf = (form: HTMLFormElement) => form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
	const said = (target: HTMLElement) => textOf(target.querySelector('[data-said="flag"]')!);
	const own = (more: Partial<DecisionPageData['flags'][number]> = {}): DecisionPageData['flags'][number] => ({
		kind: 'objection',
		reason: 'The cost is not covered.',
		raisedAt: '2026-11-02 10:00:00',
		versionNumber: 1,
		reply: null,
		repliedAt: null,
		...more
	});

	it('U1: the objection form needs a reason, sends { kind, reason } each way in, says who sees it, and says the server’s refusal, the reason kept', async () => {
		const signedIn = draw(DecisionPage, { data: pageData({ mayObject: true, mayAskToTalk: true }) });
		const section = flagsOf(signedIn)!;
		expect(textOf(section.querySelector('h2')!)).toBe('Objections and requests to talk');
		expect(textOf(section.querySelector('[data-note="flag-who-sees"]')!)).toBe(flagWhoSees('Dee Cider'));
		expect(textOf(section.querySelector('[data-note="flag-who-sees"]')!)).toContain('whoever decides (now Dee Cider)');
		const form = formOf(signedIn, 'objection')!;
		const box = boxOf(form);
		expect(box.maxLength).toBe(4000);
		expect(box.required).toBe(true);
		expect(textOf(form.querySelector('.note')!)).toBe(FLAG_TEXT_NOTE);
		expect(sendOf(form).disabled, 'no reason').toBe(true);
		type(box, '   ');
		expect(sendOf(form).disabled, 'spaces alone').toBe(true);
		type(box, 'The cost is not covered.');
		expect(sendOf(form).disabled).toBe(false);

		// A refusal in the server's words, the reason kept, and the page read again after a 409.
		answer('POST /api/decisions/5/flags', { message: 'You have raised 3 objections on this version of the decision: no more can be raised' }, 409);
		sendOf(form).click();
		await settle();
		expect(said(signedIn)).toBe('You have raised 3 objections on this version of the decision: no more can be raised');
		expect(signedIn.querySelector('[data-said="flag"]')!.getAttribute('role')).toBe('status');
		expect(box.value).toBe('The cost is not covered.');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);

		answer('POST /api/decisions/5/flags', { flag: own() });
		sendOf(form).click();
		await settle();
		expect(requests('POST /api/decisions/5/flags')).toEqual([
			{ kind: 'objection', reason: 'The cost is not covered.' },
			{ kind: 'objection', reason: 'The cost is not covered.' }
		]);
		expect(said(signedIn)).toBe('Your objection was recorded on 2026-11-02 10:00 UTC.');
		expect(box.value, 'emptied once recorded').toBe('');
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(2);

		clear();
		const linked = draw(LinkPage, { data: linkData({ mayObject: true, mayAskToTalk: false }) });
		expect(textOf(flagsOf(linked)!.querySelector('[data-note="flag-who-sees"]')!)).toBe(flagWhoSees('Dee Cider'));
		const byLink = formOf(linked, 'objection')!;
		type(boxOf(byLink), 'By my link.');
		answer('POST /api/decision-by-link/flags', { flag: own({ reason: 'By my link.' }) });
		sendOf(byLink).click();
		await settle();
		expect(sent.map((request) => request.what)).toEqual(['POST /api/decision-by-link/flags']);
		expect(requests('POST /api/decision-by-link/flags')).toEqual([{ token: 'tok-page', kind: 'objection', reason: 'By my link.' }]);
	});

	it('U2: the request to talk’s note is optional; the form is gone while a request has no outcome, saying why', async () => {
		const target = draw(DecisionPage, { data: pageData({ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: null }, mayRespond: false, mayAskToTalk: true }) });
		const form = formOf(target, 'talk')!;
		const box = boxOf(form);
		expect(box.maxLength).toBe(2000);
		expect(box.required).toBe(false);
		expect(textOf(form.querySelector('.note')!)).toBe(FLAG_TEXT_NOTE);
		expect(formOf(target, 'objection'), 'not offered').toBeNull();
		expect(sendOf(form).disabled, 'no note is needed').toBe(false);
		answer('POST /api/decisions/5/flags', { flag: own({ kind: 'talk', reason: '' }) });
		sendOf(form).click();
		await settle();
		expect(requests('POST /api/decisions/5/flags')).toEqual([{ kind: 'talk', reason: '' }]);
		expect(said(target)).toBe('Your request to talk was recorded on 2026-11-02 10:00 UTC.');

		clear();
		const waiting = draw(DecisionPage, { data: pageData({ flags: [own({ kind: 'talk', reason: '' })], mayObject: true, mayAskToTalk: false }) });
		expect(formOf(waiting, 'talk'), 'gone while the request has no outcome').toBeNull();
		expect(formOf(waiting, 'objection')).not.toBeNull();
		expect(textOf(waiting.querySelector('[data-note="talk-closed"]')!)).toBe(`${TALK_OPEN}.`);

		clear();
		// Neither offered and nothing raised: no section at all.
		expect(flagsOf(draw(DecisionPage, { data: pageData() }))).toBeNull();
	});

	it('U3: the participant’s own flags show with the decider’s reply, as plain text, never markup', () => {
		const target = draw(LinkPage, {
			data: linkData({
				version: { number: 2, publishedAt: '2026-11-03 09:00:00', content: CONTENT },
				flags: [
					own({ reason: 'It costs **too much** <i>now</i>.', reply: 'We have **budget** <b>set aside</b>.', repliedAt: '2026-11-02 12:00:00' }),
					own({ kind: 'talk', reason: '', raisedAt: '2026-11-03 10:00:00', versionNumber: 2 })
				]
			})
		});
		const items = [...flagsOf(target)!.querySelectorAll('[data-list="own-flags"] li')];
		expect(items.map((item) => item.getAttribute('data-flag-kind'))).toEqual(['objection', 'talk']);
		expect(textOf(items[0].querySelector('.line')!)).toBe('Objection 2026-11-02 10:00 UTC, about version 1');
		expect(textOf(items[0].querySelector('[data-text="reason"]')!)).toBe('It costs **too much** <i>now</i>.');
		expect(textOf(items[0].querySelector('[data-note="replied"]')!)).toBe('Answered by the decider, 2026-11-02 12:00 UTC:');
		expect(textOf(items[0].querySelector('[data-text="reply"]')!)).toBe('We have **budget** <b>set aside</b>.');
		expect(items[0].querySelector('strong:not(:first-child), i, b, .markdown-body'), 'no markup drawn from what was written').toBeNull();
		expect(textOf(items[1].querySelector('.line')!)).toBe('Request to talk 2026-11-03 10:00 UTC');
		expect(items[1].querySelector('[data-text="reason"]'), 'no note').toBeNull();
		expect(textOf(items[1].querySelector('[data-note="no-reply"]')!)).toBe('No outcome recorded yet');
		// Neither form is offered: each says why, and no decider is named as who replied.
		expect(textOf(target.querySelector('[data-note="objection-closed"]')!)).toBe('You cannot object to this decision now.');
		expect(textOf(flagsOf(target)!)).not.toContain('Dee Cider,');
	});

	it('U8 (card 2684, F5): in a signed-in browser, the link page says an objection and a request to talk are recorded with the account, each only where its form is offered', () => {
		const signedIn = (more: Partial<DecisionPageData>) => {
			clear();
			const page = draw(LinkPage, { data: { ...linkData(more), signedInAs: 'Sam' } });
			return [...page.querySelectorAll('.signed-in')].map(textOf);
		};
		expect(signedIn({ mayAsk: true, mayObject: true, mayAskToTalk: true })).toEqual([
			'You are signed in as Sam; this is recorded with your response, with your questions, with your objection, with your request to talk and with your having seen this version.'
		]);
		expect(signedIn({ mayRespond: false, mayObject: false, mayAskToTalk: true }), 'a request to talk alone').toEqual([
			'You are signed in as Sam; this is recorded with your request to talk and with your having seen this version.'
		]);
		expect(signedIn({ mayRespond: false, mayObject: true, mayAskToTalk: false, seenRecorded: true }), 'an objection alone').toEqual([
			'You are signed in as Sam; this is recorded with your objection.'
		]);
		expect(signedIn({ mayRespond: false, mayObject: false, mayAskToTalk: false, seenRecorded: true }), 'neither offered').toEqual(['You are signed in as Sam.']);
		// The signed-in page draws no such line, whatever it is offered.
		clear();
		const session = draw(DecisionPage, { data: { ...pageData({ mayObject: true, mayAskToTalk: true }), signedInAs: 'Sam' } as DecisionPageData });
		expect(session.querySelector('.signed-in')).toBeNull();
	});

	it('U10 (card 2684): once a flag is recorded, the status region takes the focus, as the form used may then be gone (code review C-E-L4)', async () => {
		const target = draw(DecisionPage, { data: pageData({ mayObject: true }) });
		const form = formOf(target, 'objection')!;
		type(boxOf(form), 'The cost is not covered.');
		sendOf(form).focus();
		answer('POST /api/decisions/5/flags', { flag: own() });
		sendOf(form).click();
		await settle();
		const region = target.querySelector<HTMLElement>('[data-said="flag"]')!;
		expect(said(target)).toBe('Your objection was recorded on 2026-11-02 10:00 UTC.');
		expect(region.getAttribute('tabindex')).toBe('-1');
		expect(document.activeElement).toBe(region);
	});
});
