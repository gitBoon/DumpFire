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
import type { DecisionPageData, OwnResponse, RulingView, ViewContent, ViewOption } from '$lib/decision-view-types';

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
import { STALE_REVISION, type ToldMail } from '$lib/decision-words';
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
		audiences: AUDIENCES,
		participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: { kind: 'invited', at: '2026-11-01 09:05:00', delivered: true } },
		ownResponse: null,
		earlierResponse: null,
		mayRespond: true,
		stage: 'question',
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
		const told = (kind: 'invited' | 'asked_again' | 'told_of_change', delivered = true) => ({ kind, at: '2026-11-01 09:05:00', delivered });
		const rows: [string, Partial<DecisionPageData>, string][] = [
			['(a) consulted, invited', {}, 'You were asked for your view on this decision on 2026-11-01 09:05 UTC, by email.'],
			[
				'(b) informed, invited',
				{ participant: { role: 'informed', includedAt: '2026-11-01 09:00:00', told: told('invited') }, mayRespond: false },
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
				{ participant: { role: 'consulted', includedAt: '2026-11-01 09:00:00', told: told('invited', false) } },
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
			recorded: string;
			bannerOpens: string;
			responseLines: string[];
			form: boolean;
		}[] = [
			{
				name: '(a) open, an earlier round’s response, the form',
				decision: {},
				more: { version: version2, earlierResponse: response({ comment: 'Cheaper' }) },
				recorded: 'with your response and with your having seen this version.',
				bannerOpens: asked,
				responseLines: ['This decision changed on 2026-11-02 09:00 UTC. Your earlier response was for version 1:', 'You chose option A: Rent.', 'Your comment: Cheaper'],
				form: true
			},
			{
				name: '(b) awaiting the ruling, a response given',
				decision: { shownStatus: 'awaiting_ruling' },
				more: { mayRespond: false, ownResponse: response() },
				recorded: 'with your response and with your having seen this version.',
				bannerOpens: asked,
				responseLines: ['Responses closed on 2099-12-01 12:00 UTC.', 'Your response:', 'You chose option A: Rent.'],
				form: false
			},
			{
				name: '(c) awaiting the ruling, no response given',
				decision: { shownStatus: 'awaiting_ruling' },
				more: { mayRespond: false },
				recorded: 'with your response and with your having seen this version.',
				bannerOpens: asked,
				responseLines: ['Responses closed on 2099-12-01 12:00 UTC.', 'You gave no response in this round.'],
				form: false
			},
			{
				name: '(d) ruled, a response on an older version, the ruling',
				decision: { shownStatus: 'ruled', closesAt: null },
				more: { version: version2, mayRespond: false, ownResponse: response(), ruling: RULING, stage: 'ruling' },
				recorded: 'with your concern and with your having seen the ruling.',
				bannerOpens: 'Ruled by Dee Cider: Option B: Buy',
				responseLines: ['Responses are closed.', 'Your last response:', 'You chose option A: Rent.', 'Given on version 1.'],
				form: false
			},
			{
				name: '(e) withdrawn',
				decision: { shownStatus: 'withdrawn', withdrawnAt: '2026-11-03 10:00:00', withdrawnReason: 'The budget went.' },
				more: { mayRespond: false, stage: 'withdrawal' },
				recorded: 'with your response and with your having seen this version.',
				bannerOpens: 'This decision was withdrawn on 2026-11-03 10:00 UTC: The budget went.',
				responseLines: ['Responses are closed.'],
				form: false
			}
		];

		for (const { name, decision, more, recorded, bannerOpens, responseLines, form } of rows) {
			// The signed-in page is handed the account name too, and still draws no personal-link line.
			const data = both(decision, { ...more, signedInAs: 'Sam' });
			clear();
			const session = draw(DecisionPage, { data: data.session });
			const link = draw(LinkPage, { data: data.link });

			const sessionBanner = partsOf(session, 'banner');
			const linkBanner = partsOf(link, 'banner');
			expect(sessionBanner.length, name).toBeGreaterThan(0);
			expect(linkBanner.slice(0, -2), name).toEqual(sessionBanner);
			expect([...link.querySelectorAll('[data-section="banner"] > p')].slice(-2).map(textOf), name).toEqual([
				'This address is personal to you: do not share it.',
				`You are signed in as Sam; this is recorded ${recorded}`
			]);
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
			linkedCards: [{ id: 21, title: 'Build the site', boardId: 3, boardName: 'Shop', archived: false }],
			mayLinkCards: true,
			mayUnlinkCards: true
		};

		// The signed-in page draws each, so the link page's absences below are not empty checks.
		const session = draw(DecisionPage, { data: pageData(everything) });
		expect([...session.querySelectorAll('[data-section="banner"] a')].map((a) => a.getAttribute('href'))).toEqual(['/decisions/7', '/decisions/4']);
		expect([...session.querySelectorAll<HTMLElement>('.page-actions [data-action]')].map((a) => a.dataset.action)).toEqual(['results', 'record', 'supersede']);
		expect(session.querySelector('.edit-link')).not.toBeNull();
		expect(textOf(session.querySelector('.crumb')!)).toBe('Website');
		expect(session.querySelector('[data-section="linked-cards"]')).not.toBeNull();

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
		for (const word of ['Plan A first', 'Plan C', 'Website', 'Build the site', 'Shop', 'Results and ruling', 'Record', 'Supersede', 'Edit']) expect(text, word).not.toContain(word);
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
