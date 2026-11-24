// @vitest-environment jsdom
/**
 * A decision as a PDF, in the page (card 2688, R14, cases U1 to U3): the two
 * buttons of `DecisionExport` in the signed-in decision page's actions bar,
 * each shown where the caller may take that copy, and what pressing one sends
 * and does with the answer. The page is mounted with Svelte's client runtime,
 * as tests/decision-participation.svelte.test.ts mounts it, `fetch` a stand-in
 * that keeps every request sent and answers what the case gives it; the file
 * is saved through an anchor whose `click` is kept, as jsdom saves nothing.
 *
 * What the server answers, and to whom, is in tests/decision-export.test.ts;
 * that the personal-link page draws neither button is the pin of
 * tests/decision-participation.svelte.test.ts, 2707-2. The plan is
 * `docs/planning/card-2688-decision-pdf-export.md`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { DecisionPageData, RulingView, ViewContent } from '$lib/decision-view-types';

vi.mock('$app/navigation', () => ({
	goto: async () => {},
	invalidateAll: async () => {},
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
vi.mock('$app/state', () => ({ page: { params: {} } }));
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import { EXPORT_BUSY, exportsSpentWords } from '$lib/decision-words';
import DecisionPage from '../src/routes/decisions/[id]/+page.svelte';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

/** Each request sent, as `METHOD url`, with its body read as JSON and its headers. */
let sent: { what: string; body: unknown; headers: Record<string, string> }[] = [];
/** What the next request to each `METHOD url` is answered. */
let answers: Record<string, Response[]> = {};
/** Each file the page saved: the name it gave it and the blob behind its address. */
let saved: { name: string; blob: Blob | undefined }[] = [];
let blobs: Map<string, Blob>;
let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

beforeEach(() => {
	sent = [];
	answers = {};
	saved = [];
	blobs = new Map();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			const what = `${init?.method ?? 'GET'} ${url}`;
			sent.push({ what, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: { ...(init?.headers as Record<string, string>) } });
			return answers[what]?.shift() ?? new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
		})
	);
	// jsdom has no object addresses and saves nothing: each blob is kept by an address of its own, and each click on a link kept.
	URL.createObjectURL = (blob: Blob) => {
		const url = `blob:test/${blobs.size + 1}`;
		blobs.set(url, blob);
		return url;
	};
	URL.revokeObjectURL = () => {};
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
		saved.push({ name: this.download, blob: blobs.get(this.href) });
	});
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function draw(props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(DecisionPage as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

/** Lets every answer in flight arrive, and draws. */
async function settle() {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const actions = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>('.page-actions [data-action]')].map((el) => el.dataset.action);
const pressed = (target: HTMLElement, action: string) => target.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!;
const said = (target: HTMLElement) => textOf(target.querySelector('[data-said="export"]')!);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CONTENT: ViewContent = {
	situation: 'Money is short.',
	question: 'Which plan?',
	ask: 'Choose one.',
	unknowns: '',
	alreadyRuled: '',
	technicalDetail: '',
	stories: [],
	agentDrafted: {}
};
const RULING: RulingView = { label: 'A', title: 'Rent', noneOfThese: false, reason: 'It is cheaper.', conditions: null, ruledByName: 'Dee Cider' };

/** The signed-in page's data for one who is no participant of a ruled decision: a board reader's, unless `more` says otherwise. */
function pageData(more: Partial<DecisionPageData> = {}): DecisionPageData & { user: null } {
	return {
		via: 'session',
		decision: { id: 5, title: 'Pick a plan', shownStatus: 'ruled', voteMode: 'single', closesAt: null, deciderName: 'Dee Cider', boardName: 'Website', withdrawnAt: null, withdrawnReason: null },
		draft: false,
		version: { number: 1, publishedAt: '2026-11-01 09:00:00', content: CONTENT },
		options: [{ optionId: 11, label: 'A', title: 'Rent', summary: '', pros: [], cons: [], commercial: '', agentDrafted: false }],
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
		questions: [],
		mayAsk: false,
		flags: [],
		mayObject: false,
		mayAskToTalk: false,
		mayReadResults: false,
		maySupersede: false,
		mayReadRecord: false,
		user: null,
		...more
	};
}

const PRIVATE_NOTE = 'Private: holds names and views. Taking one is written on the record.';

describe('a decision as a PDF, on its page (card 2688)', () => {
	it('offers a board reader of a ruled decision the shareable copy alone, in the actions bar (U1)', () => {
		const target = draw({ data: pageData() });
		expect(actions(target)).toEqual(['export-shareable']);
		expect(textOf(pressed(target, 'export-shareable'))).toBe('Shareable copy (PDF)');
		expect(target.querySelector('[data-action="export-full"]')).toBeNull();
		expect(target.textContent).not.toContain('Full record (PDF)');
		expect(target.textContent).not.toContain(PRIVATE_NOTE);
	});

	it('offers the decider both, the full record with its private note; and on a draft, neither (U2)', () => {
		const decider = { mayReadResults: true, mayReadRecord: true, maySupersede: true };
		const target = draw({ data: pageData(decider) });
		expect(actions(target)).toEqual(['results', 'record', 'supersede', 'export-shareable', 'export-full']);
		const full = pressed(target, 'export-full');
		expect(textOf(full)).toBe('Full record (PDF)');
		const note = target.querySelector(`#${full.getAttribute('aria-describedby')}`)!;
		expect(textOf(note)).toBe(PRIVATE_NOTE);

		for (const [name, more] of [
			['the decider', decider],
			['a board reader', {}]
		] as const) {
			const draft = draw({ data: pageData({ ...more, draft: true, version: null, ruling: null }) });
			expect(draft.querySelector('[data-action^="export-"]'), name).toBeNull();
			expect(draft.textContent, name).not.toContain('(PDF)');
		}
	});

	it('posts { copy } as JSON, saves the answer under the name it gives, and says a 429 and a 503 in the server’s words (U3)', async () => {
		const target = draw({ data: pageData({ mayReadRecord: true }) });
		const name = 'decision-5-pick-a-plan-full-record-2026-11-24.pdf';
		answers['POST /api/decisions/5/pdf'] = [
			new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}"` } }),
			// An answer naming no file this page would make is saved under the page's own name.
			new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="../evil.html"' } }),
			json({ message: exportsSpentWords(20, '2026-11-24 11:00:00') }, 429),
			json({ message: EXPORT_BUSY }, 503)
		];

		pressed(target, 'export-full').click();
		await settle();
		expect(sent).toEqual([{ what: 'POST /api/decisions/5/pdf', body: { copy: 'full' }, headers: { 'Content-Type': 'application/json' } }]);
		expect(saved.map((file) => file.name)).toEqual([name]);
		expect(saved[0].blob?.type).toBe('application/pdf');
		expect(saved[0].blob?.size).toBe(4);
		expect(said(target)).toBe(`The full record was downloaded as ${name}.`);

		pressed(target, 'export-shareable').click();
		await settle();
		expect(sent[1].body).toEqual({ copy: 'shareable' });
		expect(saved.map((file) => file.name)).toEqual([name, 'decision-5.pdf']);

		pressed(target, 'export-shareable').click();
		await settle();
		expect(said(target)).toBe(exportsSpentWords(20, '2026-11-24 11:00:00'));
		expect(target.querySelector('[data-said="export"]')!.classList.contains('refused')).toBe(true);

		pressed(target, 'export-full').click();
		await settle();
		expect(said(target)).toBe(EXPORT_BUSY);
		expect(saved, 'nothing saved for a refusal').toHaveLength(2);
		expect(sent.map((request) => request.body)).toEqual([{ copy: 'full' }, { copy: 'shareable' }, { copy: 'shareable' }, { copy: 'full' }]);
	});

	// Card 2688's code review (E-L5): the pressed button is disabled while its export runs, which takes the focus off it.
	it('gives the pressed button the focus back once its export ends, where the focus was left on nothing (U4)', async () => {
		const target = draw({ data: pageData({ mayReadRecord: true }) });
		answers['POST /api/decisions/5/pdf'] = [json({ message: EXPORT_BUSY }, 503), json({ message: EXPORT_BUSY }, 503)];

		const full = pressed(target, 'export-full');
		full.focus();
		full.click();
		// As a browser does with a focused button that is disabled; jsdom blurs no disabled element, so before it is drawn so.
		full.blur();
		flushSync();
		expect(full.disabled).toBe(true);
		expect(document.activeElement).toBe(document.body);
		await settle();
		expect(full.disabled).toBe(false);
		expect(document.activeElement, 'the pressed button has it again').toBe(full);

		// Focus moved elsewhere while the export ran is left there.
		const elsewhere = document.body.appendChild(document.createElement('input'));
		const shareable = pressed(target, 'export-shareable');
		shareable.focus();
		shareable.click();
		flushSync();
		elsewhere.focus();
		await settle();
		expect(document.activeElement).toBe(elsewhere);
	});
});
