// @vitest-environment jsdom
/**
 * The register, a person's record and a decision's record view, in the page
 * (card 2680, slice 3a: the plan's cases 114 to 129). Each page and
 * component is mounted alone with Svelte's client runtime, as the other
 * decision files mount them, given the data its load gives; the live stream
 * is a stand-in `EventSource` that records its listeners and is handed
 * events by the test.
 *
 *   - The register: the tabs as a labelled navigation of links, the table
 *     with its caption and column headers, the filter form's labelled fields
 *     (no `before`, `status` on All alone), the tab links with no `status`,
 *     the polite count line, each tab's empty words, No matches and Clear
 *     filters, and Older and Back to newest.
 *   - A person's record: the person's own with no actor and no record link,
 *     an administrator's with `RecordEvents` and a Record link to each
 *     participation, and a removed participation with nothing of its
 *     decision.
 *   - The record view: each entry and the participant select.
 *   - `DecisionActions`' Record link, and the dashboard's Decisions entry.
 *   - `connectLiveRefresh`'s options: the events it listens to, a board's own
 *     `decision` events alone, and one re-read for a burst.
 *
 * What the server answers, and to whom, is in `tests/decision-register.test.ts`.
 * The plan is `docs/planning/card-2680-register-records-links.md`. It is named
 * `.svelte.test.ts` so that a page's data can be `$state`, and changed.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Svelte from 'svelte';
import type { OwnRecordEvent, Participation, PersonRecord, RecordEntry, RecordPage, RegisterPage, RegisterRow, RegisterTab } from '$lib/decision-register-types';

const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}), goto: vi.fn(async (_to: string) => {}) }));
vi.mock('$app/navigation', () => ({
	goto: navigation.goto,
	invalidateAll: navigation.invalidateAll,
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
// The dashboard's header reads who is signed in from the page store, which only a running SvelteKit app has.
vi.mock('$app/stores', () => {
	const value = () => ({ data: { user: { id: 1, username: 'alice', role: 'user' } } });
	return { page: { subscribe: (run: (v: ReturnType<typeof value>) => void) => (run(value()), () => {}) } };
});
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

import DashboardHeader from '$lib/components/dashboard/DashboardHeader.svelte';
import DecisionActions from '$lib/components/decision/DecisionActions.svelte';
import { connectLiveRefresh } from '$lib/live-refresh';
import RegisterPageView from '../src/routes/decisions/+page.svelte';
import PersonPage from '../src/routes/decisions/people/[personId]/+page.svelte';
import RecordView from '../src/routes/decisions/[id]/record/+page.svelte';

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

// ─── The live stream's stand-in ──────────────────────────────────────────────

/** An `EventSource` that keeps its listeners, and is handed each event by `send`. */
class StandInSource {
	static made: StandInSource[] = [];
	readonly url: string;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closed = false;
	private listeners = new Map<string, ((e: { data: string }) => void)[]>();
	constructor(url: string) {
		this.url = url;
		StandInSource.made.push(this);
	}
	addEventListener(name: string, listener: (e: { data: string }) => void) {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
	}
	close() {
		this.closed = true;
	}
	/** The events listened for, by name. */
	get names(): string[] {
		return [...this.listeners.keys()].sort();
	}
	send(name: string, data: unknown) {
		for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) });
	}
}

const latestSource = () => StandInSource.made.at(-1)!;

// ─── Drawing ─────────────────────────────────────────────────────────────────

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

beforeEach(() => {
	StandInSource.made = [];
	navigation.invalidateAll.mockClear();
	vi.stubGlobal('EventSource', StandInSource);
	vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
	for (const { component, target } of drawn) {
		unmount(component);
		target.remove();
	}
	drawn = [];
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function draw(component: unknown, props: Record<string, unknown>): HTMLElement {
	const target = document.createElement('div');
	document.body.appendChild(target);
	drawn.push({ component: mount(component as never, { target, props: props as never }), target });
	flushSync();
	return target;
}

async function settle() {
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const textOf = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
const searchOf = (link: Element) => new URL(link.getAttribute('href')!, 'http://localhost').searchParams;

// ─── The data each load gives ────────────────────────────────────────────────

const NO_QUERY = { tab: null, status: null, board: null, person: null, who: null, q: null, before: null };

const row = (id: number, extra: Partial<RegisterRow> = {}): RegisterRow => ({
	id,
	title: `Decision ${id}`,
	shownStatus: 'open',
	board: { id: 7, name: 'Board A', gone: false },
	deciderName: 'Dana',
	authorName: null,
	closesAt: '2099-01-01 12:00:00',
	openedAt: '2026-01-01 09:00:00',
	role: null,
	...extra
});

const register = (extra: Partial<RegisterPage> = {}): RegisterPage => ({
	tab: 'open',
	query: NO_QUERY,
	rows: [row(3), row(2, { board: { id: null, name: 'Old name', gone: false }, waiting: 'response', role: 'consulted' })],
	next: null,
	counts: { waitingResponse: 2, waitingRuling: 1 },
	capped: false,
	boards: [{ id: 7, name: 'Board A' }],
	people: [],
	myPersonId: null,
	...extra
});

const drawRegister = (page: RegisterPage) => draw(RegisterPageView, { data: page });

const entry = (kind: string, extra: Partial<RecordEntry> = {}): RecordEntry => ({
	kind,
	at: '2026-11-01 09:00:00',
	versionNumber: 1,
	participant: 'Pat Doe',
	actor: { name: 'Dana', source: 'ui' },
	detail: {},
	...extra
});

const fullParticipation = <E>(id: number | undefined, events: E[]): Participation<E> => ({
	kind: 'full',
	...(id === undefined ? {} : { id }),
	decision: { id: 5, title: 'Pick a plan', shownStatus: 'open', board: { id: 7, name: 'Board A', gone: false }, closesAt: '2099-01-01 12:00:00' },
	role: 'consulted',
	includedAt: '2026-11-01 09:00:00',
	removedAt: null,
	name: 'Pat Doe',
	jobTitle: 'Engineer',
	groups: ['Team'],
	responses: [
		{ versionNumber: 1, round: 1, kind: 'vote', option: 'A', scores: null, optionComments: {}, comment: 'Cheaper.', answers: [], createdAt: '2026-11-01 10:00:00', current: true }
	],
	questions: [],
	concerns: [],
	flags: [],
	events,
	moreEvents: false
});

const drawPerson = (record: PersonRecord, extra: { before?: number | null } = {}) =>
	draw(PersonPage, { data: { ...record, personId: 9, before: extra.before ?? null } });

// ─── The register (cases 114 to 121) ─────────────────────────────────────────

describe('the register', () => {
	it('draws the tabs as a labelled navigation of links, the current one aria-current, the waiting tabs with counts (114)', () => {
		const target = drawRegister(register());
		const nav = target.querySelector('nav[aria-label="Decision lists"]')!;
		const tabs = [...nav.querySelectorAll('a')];
		expect(tabs.map(textOf)).toEqual(['Waiting for my response (2)', 'Waiting on me (1)', 'Open', 'Ruled', 'All']);
		expect(tabs.map((tab) => tab.getAttribute('aria-current'))).toEqual([null, null, 'page', null, null]);
		expect(tabs.map((tab) => searchOf(tab).get('tab'))).toEqual(['waiting-response', 'waiting-ruling', 'open', 'ruled', 'all']);
	});

	it('draws the rows as a table with a caption and column headers, each linking to its decision (115)', () => {
		const target = drawRegister(register());
		const table = target.querySelector('table')!;
		expect(textOf(table.querySelector('caption')!)).toBe('Open');
		const headers = [...table.querySelectorAll('thead th')];
		expect(headers.map((th) => th.getAttribute('scope'))).toEqual(['col', 'col', 'col', 'col', 'col', 'col']);
		expect(headers.map(textOf)).toEqual(['Title', 'Status', 'Board', 'Decider', 'Closes', 'Your part']);
		const rows = [...table.querySelectorAll('tbody tr')];
		expect(rows.map((tr) => tr.querySelector('td.title a')!.getAttribute('href'))).toEqual(['/decisions/3', '/decisions/2']);
		// Every cell is labelled, for the stacked rows at phone width.
		expect(rows.flatMap((tr) => [...tr.querySelectorAll('td')].map((td) => td.dataset.label))).toEqual([
			...['Title', 'Status', 'Board', 'Decider', 'Closes', 'Your part'],
			...['Title', 'Status', 'Board', 'Decider', 'Closes', 'Your part']
		]);
		// A board the caller can open is a link; the snapshot of one they cannot is plain text (S1).
		expect(rows[0].querySelector('td[data-label="Board"] a')!.getAttribute('href')).toBe('/board/7');
		expect(rows[1].querySelector('td[data-label="Board"] a')).toBeNull();
		expect(textOf(rows[1].querySelector('td[data-label="Board"]')!)).toBe('Old name');
		expect(textOf(rows[1].querySelector('td[data-label="Your part"]')!)).toBe('Your response is awaited');
	});

	it('T3 (card 3075): draws each status cell as a kit badge coloured by its status, with its data-status', () => {
		const target = drawRegister(register({ rows: [row(3), row(4, { shownStatus: 'awaiting_ruling' })] }));
		const badges = [...target.querySelectorAll<HTMLElement>('tbody td[data-label="Status"] [data-status]')];
		expect(badges.map((badge) => badge.dataset.status)).toEqual(['open', 'awaiting_ruling']);
		expect(badges[0].classList.contains('ui-badge-info')).toBe(true);
		expect(badges[1].classList.contains('ui-badge-warning')).toBe(true);
		expect(badges.map(textOf)).toEqual(['Open', 'Awaiting ruling']);
		expect(target.querySelector('.status-chip')).toBeNull();
	});

	it('labels every filter, and sends tab, board, person, who, status on All alone and q, never before (116)', () => {
		const fieldsOf = (target: HTMLElement) => {
			const form = target.querySelector<HTMLFormElement>('form[data-form="filters"]')!;
			expect(form.getAttribute('method')).toBe('GET');
			for (const field of form.querySelectorAll<HTMLElement>('select, input:not([type="hidden"])')) {
				const label = form.querySelector(`label[for="${field.id}"]`);
				expect(label, field.getAttribute('name') ?? '').not.toBeNull();
				expect(textOf(label!)).not.toBe('');
			}
			return [...form.querySelectorAll<HTMLInputElement>('[name]')].map((field) => field.name);
		};
		const query = { ...NO_QUERY, before: 90, status: 'ruled' as const };
		expect(fieldsOf(drawRegister(register({ query })))).toEqual(['tab', 'board', 'who', 'person', 'q']);
		expect(fieldsOf(drawRegister(register({ tab: 'all', query })))).toEqual(['tab', 'board', 'who', 'person', 'status', 'q']);
	});

	it('gives no tab link a status, and keeps the board, person and title filters (117)', () => {
		const target = drawRegister(register({ tab: 'all', query: { ...NO_QUERY, tab: 'all', status: 'ruled', board: 7, person: 4, q: 'plan', before: 90 } }));
		for (const tab of target.querySelectorAll('nav[aria-label="Decision lists"] a')) {
			const search = searchOf(tab);
			expect(search.has('status')).toBe(false);
			expect(search.has('before')).toBe(false);
			expect([search.get('board'), search.get('person'), search.get('q')]).toEqual(['7', '4', 'plan']);
		}
	});

	it('says how many rows are shown in a polite status line, after a filter and after a live re-read (118)', async () => {
		const props = $state({ data: register() });
		const target = draw(RegisterPageView, props);
		const line = target.querySelector('[role="status"]')!;
		expect(line.getAttribute('aria-live')).toBe('polite');
		expect(textOf(line)).toBe('Showing 2 decisions.');
		// Code review F5: the register listens to `decision` events alone, not the board's `update` and `xp-update`.
		expect(latestSource().names).toEqual(['decision']);

		// A `decision` event re-reads, and the line says what the new read shows.
		vi.useFakeTimers();
		latestSource().send('decision', { decisionId: 3, status: 'awaiting_ruling', boardId: 7 });
		vi.advanceTimersByTime(250);
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		props.data = register({ rows: [row(3)] });
		flushSync();
		expect(textOf(line)).toBe('Showing 1 decision.');

		props.data = register({ tab: 'waiting-response', capped: true, rows: Array.from({ length: 200 }, (_, i) => row(i + 1)) });
		flushSync();
		expect(textOf(line)).toBe('Showing the first 200 decisions.');
	});

	it('gives each tab its own empty words (119)', () => {
		const tabs: RegisterTab[] = ['waiting-response', 'waiting-ruling', 'open', 'ruled', 'all'];
		const said = tabs.map((tab) => {
			const target = drawRegister(register({ tab, rows: [] }));
			// Card 3075 (A2): the kit's empty state, the tab's words its heading.
			const empty = target.querySelector(`[data-empty="${tab}"] h2`)!;
			expect(target.querySelector('table')).toBeNull();
			return textOf(empty);
		});
		expect(new Set(said).size).toBe(5);
		expect(said[0]).toBe('Nothing is waiting for your response.');
	});

	it('says No matches with Clear filters where a filter is set and nothing matches (120)', () => {
		const target = drawRegister(register({ tab: 'ruled', rows: [], query: { ...NO_QUERY, q: 'nothing like it' } }));
		// Card 3075 (A3): the kit's empty state, "No matches." its heading and Clear filters its action.
		const empty = target.querySelector('[data-empty="filtered"]')!;
		expect(textOf(empty.querySelector('h2')!)).toBe('No matches.');
		expect(empty.querySelector('a')!.getAttribute('href')).toBe('/decisions?tab=ruled');
		expect(textOf(empty.querySelector('a')!)).toBe('Clear filters');
		// A status on a tab that does not read it is no filter.
		const unfiltered = drawRegister(register({ tab: 'open', rows: [], query: { ...NO_QUERY, status: 'ruled' } }));
		expect(unfiltered.querySelector('[data-empty="open"]')).not.toBeNull();
	});

	it('carries before on Older, and offers Back to newest past the first page (121)', () => {
		const first = drawRegister(register({ tab: 'all', next: 40, query: { ...NO_QUERY, status: 'open', q: 'plan' } }));
		const older = first.querySelector('[data-page="next"]')!;
		expect(Object.fromEntries(searchOf(older))).toEqual({ tab: 'all', status: 'open', q: 'plan', before: '40' });
		expect(first.querySelector('[data-page="newest"]')).toBeNull();

		const later = drawRegister(register({ tab: 'all', next: null, query: { ...NO_QUERY, status: 'open', before: 41 } }));
		const newest = later.querySelector('[data-page="newest"]')!;
		expect(textOf(newest)).toBe('Back to newest');
		expect(Object.fromEntries(searchOf(newest))).toEqual({ tab: 'all', status: 'open' });
		expect(later.querySelector('[data-page="next"]')).toBeNull();
	});

	it('links My record to the caller’s own person record, and draws no link without one (code review F1)', () => {
		const link = drawRegister(register({ myPersonId: 9 })).querySelector('[data-action="my-record"]')!;
		expect(textOf(link)).toBe('My record');
		expect(link.getAttribute('href')).toBe('/decisions/people/9');
		expect(drawRegister(register()).querySelector('[data-action="my-record"]')).toBeNull();
	});

	it('offers the status filter by SHOWN_STATUSES and the tabs by REGISTER_TABS, the lists the server reads (code review F6)', async () => {
		const { REGISTER_TABS, SHOWN_STATUSES } = await import('$lib/decision-register-types');
		const target = drawRegister(register({ tab: 'all' }));
		const statuses = [...target.querySelectorAll<HTMLOptionElement>('select[name="status"] option')].map((option) => option.value).filter((value) => value !== '');
		expect(statuses).toEqual([...SHOWN_STATUSES]);
		expect([...target.querySelectorAll('nav[aria-label="Decision lists"] a')].map((tab) => tab.getAttribute('data-tab'))).toEqual([...REGISTER_TABS]);
		const roles = drawRegister(register({ rows: [row(4, { role: 'informed' })] }));
		expect(textOf(roles.querySelector('td[data-label="Your part"]')!)).toBe('Informed');
	});
});

// ─── A person's record (cases 122 to 124) ────────────────────────────────────

describe('a person’s record', () => {
	it('draws the person’s own with their moments, no one named as who did it, and no record link (122)', () => {
		const events: OwnRecordEvent[] = [
			{ kind: 'invited', at: '2026-11-01 09:00:00', versionNumber: 1 },
			{ kind: 'seen', at: '2026-11-01 09:30:00', versionNumber: 1, stage: 'question' }
		];
		const target = drawPerson({ audience: 'self', person: { name: 'Pat Doe', jobTitle: 'Engineer' }, participations: [fullParticipation(undefined, events)], next: null });
		expect(textOf(target.querySelector('h1')!)).toBe('Your record');
		expect(target.querySelector('[data-action="record"]')).toBeNull();
		expect(target.querySelector('.record-events')).toBeNull();
		expect(target.querySelector('[data-field="actor"]')).toBeNull();
		expect([...target.querySelectorAll('.own-event')].map(textOf)).toEqual(['Invited: 2026-11-01 09:00 UTC, version 1', 'Seen (question): 2026-11-01 09:30 UTC, version 1']);
		expect(textOf(target)).not.toContain('Dana');
		expect(textOf(target)).toContain('Your responses');
	});

	it('draws an administrator’s with RecordEvents and a Record link for each participation (123)', () => {
		const target = drawPerson({
			audience: 'admin',
			person: { name: 'Pat Doe', jobTitle: 'Engineer', groups: ['Team'], email: 'pat@example.test', status: 'left' },
			participations: [fullParticipation(11, [entry('invited'), entry('mail_outcome', { detail: { mail: 'invitation', delivered: true } })]), { ...fullParticipation(12, []), moreEvents: true }],
			next: 30
		});
		const articles = [...target.querySelectorAll('article')];
		expect(articles.map((article) => article.querySelector('[data-action="record"]')!.getAttribute('href'))).toEqual([
			'/decisions/5/record?participant=11',
			'/decisions/5/record?participant=12'
		]);
		expect([...articles[0].querySelectorAll('.record-event')].map((li) => li.getAttribute('data-kind'))).toEqual(['invited', 'mail_outcome']);
		// Code review F8: each detail key in words, never its stored name.
		expect(textOf(articles[0].querySelector('[data-kind="mail_outcome"]')!)).toContain('Delivered: yes');
		expect(articles[1].querySelector('[data-action="more"]')!.getAttribute('href')).toBe('/decisions/5/record?participant=12');
		expect(textOf(target.querySelector('[data-field="email"]')!)).toBe('pat@example.test');
		expect(target.querySelector('[data-page="next"]')!.getAttribute('href')).toBe('/decisions/people/9?before=30');
		expect(target.querySelector('[data-page="newest"]')).toBeNull();
	});

	it('draws a removed participation as “A decision you were removed from”, with no link (124)', () => {
		const target = drawPerson(
			{
				audience: 'self',
				person: { name: 'Sam', jobTitle: '' },
				participations: [
					{
						kind: 'removed',
						includedAt: '2026-11-01 09:00:00',
						removedAt: '2026-11-02 09:00:00',
						responses: [],
						questions: [],
						concerns: [{ comment: 'I was not asked.', createdAt: '2026-11-01 12:00:00' }],
						flags: [],
						events: [{ kind: 'removed', at: '2026-11-02 09:00:00', versionNumber: null }]
					}
				],
				next: null
			},
			{ before: 50 }
		);
		const article = target.querySelector('article[data-participation="removed"]')!;
		expect(textOf(article.querySelector('h2')!)).toBe('A decision you were removed from');
		expect(article.querySelectorAll('a')).toHaveLength(0);
		expect(textOf(article)).toContain('I was not asked.');
		expect(target.querySelector('[data-page="newest"]')!.getAttribute('href')).toBe('/decisions/people/9');
	});

	it('draws a live participation the person may not open as “A decision you can no longer open”, never as removed (code review F4)', () => {
		const target = drawPerson({
			audience: 'self',
			person: { name: 'Pat', jobTitle: '' },
			participations: [{ kind: 'removed', includedAt: '2026-11-01 09:00:00', removedAt: null, responses: [], questions: [], concerns: [], flags: [], events: [] }],
			next: null
		});
		expect(target.querySelector('article[data-participation="removed"]')).toBeNull();
		const article = target.querySelector('article[data-participation="unviewable"]')!;
		expect(textOf(article.querySelector('h2')!)).toBe('A decision you can no longer open');
		expect(textOf(article)).not.toContain('removed');
		expect(article.querySelectorAll('a')).toHaveLength(0);
	});

	it('U6 (card 2684): shows each objection and request to talk with its reply, as plain text; the replier named to an administrator alone; their events in the record’s words', () => {
		const raised = [
			{ kind: 'objection' as const, reason: 'Too **dear** <i>now</i>.', raisedAt: '2026-11-02 09:00:00', versionNumber: 1, reply: 'We have budget.', repliedAt: '2026-11-02 11:00:00' },
			{ kind: 'talk' as const, reason: '', raisedAt: '2026-11-03 09:00:00', versionNumber: 2, reply: null, repliedAt: null }
		];
		const flagsIn = (target: HTMLElement) => [...target.querySelectorAll<HTMLElement>('[data-list="flags"] li')];

		const self = drawPerson({ audience: 'self', person: { name: 'Pat Doe', jobTitle: '' }, participations: [{ ...fullParticipation<OwnRecordEvent>(undefined, []), flags: raised }], next: null });
		expect(textOf(self.querySelector('[data-list="flags"]')!.previousElementSibling!)).toBe('Your objections and requests to talk');
		const [objection, talk] = flagsIn(self);
		expect(textOf(objection.querySelector('.line')!)).toBe('Objection version 1, 2026-11-02 09:00 UTC');
		expect(textOf(objection.querySelector('[data-text="reason"]')!)).toBe('Too **dear** <i>now</i>.');
		expect(objection.querySelector('[data-text="reason"] i'), 'plain text').toBeNull();
		expect(textOf(objection.querySelector('[data-text="reply"]')!)).toBe('We have budget.');
		expect(textOf(objection.querySelector('[data-note="replied"]')!)).toBe('Answered by the decider, 2026-11-02 11:00 UTC');
		expect(textOf(talk.querySelector('.line')!)).toBe('Request to talk version 2, 2026-11-03 09:00 UTC');
		expect(textOf(talk.querySelector('[data-note="no-reply"]')!)).toBe('No outcome recorded yet');

		// A removed participation: the replies the server gave, up to the removal.
		const removed = drawPerson({
			audience: 'self',
			person: { name: 'Sam', jobTitle: '' },
			participations: [{ kind: 'removed', includedAt: '2026-11-01 09:00:00', removedAt: '2026-11-02 10:00:00', responses: [], questions: [], concerns: [], flags: [{ ...raised[0], reply: null, repliedAt: null }], events: [] }],
			next: null
		});
		expect(flagsIn(removed).map((item) => textOf(item.querySelector('[data-note="no-reply"]')!))).toEqual(['Not answered yet']);

		const admin = drawPerson({
			audience: 'admin',
			person: { name: 'Pat Doe', jobTitle: '' },
			participations: [
				{
					...fullParticipation(11, [entry('objection_raised', { detail: { notice: 'asked' } }), entry('objection_answered', { participant: null, detail: { notice: 'asked' } })]),
					flags: [
						{ ...raised[0], via: 'link', repliedByName: 'Dana' },
						{ ...raised[1], via: 'session', repliedByName: null }
					]
				}
			],
			next: null
		});
		const [byLink, bySession] = flagsIn(admin);
		expect(textOf(admin.querySelector('[data-list="flags"]')!.previousElementSibling!)).toBe('Objections and requests to talk');
		expect(textOf(byLink.querySelector('.line')!)).toBe('Objection version 1, 2026-11-02 09:00 UTC, by link');
		expect(textOf(byLink.querySelector('[data-note="replied"]')!)).toBe('Answered by Dana, 2026-11-02 11:00 UTC');
		expect(textOf(bySession.querySelector('.line')!)).toBe('Request to talk version 2, 2026-11-03 09:00 UTC');
		expect([...admin.querySelectorAll('.record-event')].map((li) => textOf(li.querySelector('.event-kind')!))).toEqual(['Objection raised', 'Objection answered']);
	});
});

// ─── The record view (case 125) ──────────────────────────────────────────────

describe('the record view', () => {
	it('draws each entry and the participant select (125)', () => {
		const page: RecordPage & { after: number | null } = {
			decision: { id: 5, title: 'Pick a plan', shownStatus: 'awaiting_ruling' },
			entries: [entry('opened', { participant: null, detail: { closesAt: '2026-11-03 09:00:00' } }), entry('cut_off'), entry('ruled', { detail: { option: 'A', early: true } })],
			participants: [
				{ id: 11, name: 'Pat Doe' },
				{ id: 12, name: 'Lin Holder' }
			],
			participant: 12,
			next: 900,
			after: 400
		};
		const target = draw(RecordView, { data: page });
		const items = [...target.querySelectorAll('.record-event')];
		expect(items.map((li) => li.getAttribute('data-kind'))).toEqual(['opened', 'cut_off', 'ruled']);
		expect(textOf(items[1])).toContain('Cut off by an early ruling');
		expect(textOf(items[1])).toContain('Participant: Pat Doe');
		expect(textOf(items[2])).toContain('Early: yes');
		expect(textOf(items[0])).toContain('Closes: 2026-11-03 09:00:00');
		expect(textOf(target)).not.toMatch(/closesAt/);

		const select = target.querySelector<HTMLSelectElement>('select[name="participant"]')!;
		expect(textOf(target.querySelector(`label[for="${select.id}"]`)!)).toBe('Participant');
		expect([...select.options].map((option) => [option.value, textOf(option)])).toEqual([
			['', 'Every participant and event'],
			['11', 'Pat Doe'],
			['12', 'Lin Holder']
		]);
		expect(select.value).toBe('12');
		expect(Object.fromEntries(searchOf(target.querySelector('[data-page="next"]')!))).toEqual({ participant: '12', after: '900' });
		expect(Object.fromEntries(searchOf(target.querySelector('[data-page="start"]')!))).toEqual({ participant: '12' });
		// No participant carries a person id: no person record is linked.
		expect(target.querySelector('[data-action="person-record"]')).toBeNull();
	});

	it('links each participant the server gave a person id to their person record, and no other (code review F1)', () => {
		const page: RecordPage & { after: number | null } = {
			decision: { id: 5, title: 'Pick a plan', shownStatus: 'open' },
			entries: [],
			participants: [
				{ id: 11, name: 'Pat Doe', personId: 40 },
				{ id: 12, name: 'Ann Address' }
			],
			participant: null,
			next: null,
			after: null
		};
		const links = [...draw(RecordView, { data: page }).querySelectorAll('[data-action="person-record"]')];
		expect(links.map((link) => [textOf(link), link.getAttribute('href')])).toEqual([['Pat Doe', '/decisions/people/40']]);
	});
});

// ─── The Record links and the menu (cases 126 and 127) ───────────────────────

describe('where the record and the register are reached', () => {
	it('draws DecisionActions’ Record link only with mayReadRecord (126)', () => {
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
		expect(draw(DecisionActions, props).querySelector('[data-action="record"]')).toBeNull();
		const link = draw(DecisionActions, { ...props, mayReadRecord: true }).querySelector('[data-action="record"]')!;
		expect(textOf(link)).toBe('Record');
		expect(link.getAttribute('href')).toBe('/decisions/7/record');
	});

	it('gives the dashboard’s Views menu a Decisions entry to /decisions (127)', async () => {
		const target = draw(DashboardHeader, { inboxCount: 0, showCreate: false });
		target.querySelector<HTMLButtonElement>('#nav-views-btn')!.click();
		await settle();
		const item = document.querySelector('[role="menu"][aria-label="Views"] #decisions-link')!;
		expect(textOf(item)).toBe('Decisions');
		expect(item.getAttribute('href')).toBe('/decisions');
	});
});

// ─── Live listening (cases 128 and 129) ──────────────────────────────────────

describe('connectLiveRefresh’s options', () => {
	it('re-reads on decision and not on update with { events: [decision] }; with no options, as before (128)', () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn();
		const close = connectLiveRefresh(onRefresh, undefined, { events: ['decision'] });
		const source = latestSource();
		expect(source.names).toEqual(['decision']);
		source.send('update', { boardId: 7 });
		vi.advanceTimersByTime(250);
		expect(onRefresh).not.toHaveBeenCalled();
		source.send('decision', { decisionId: 3, status: 'open', boardId: 7 });
		vi.advanceTimersByTime(250);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		close();
		expect(source.closed).toBe(true);

		// Every caller from before: update and xp-update, and no decision.
		const before = vi.fn();
		const closeBefore = connectLiveRefresh(before);
		const plain = latestSource();
		expect(plain.names).toEqual(['update', 'xp-update']);
		plain.send('decision', { decisionId: 3, status: 'open', boardId: 7 });
		vi.advanceTimersByTime(250);
		expect(before).not.toHaveBeenCalled();
		plain.send('xp-update', {});
		vi.advanceTimersByTime(250);
		expect(before).toHaveBeenCalledTimes(1);
		closeBefore();
	});

	it('with boardId, re-reads on that board’s decision events alone, once for each 250 ms burst (129)', () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn();
		const close = connectLiveRefresh(onRefresh, undefined, { events: ['decision'], boardId: 7 });
		const source = latestSource();
		source.send('decision', { decisionId: 3, status: 'open', boardId: 8 });
		vi.advanceTimersByTime(250);
		expect(onRefresh).not.toHaveBeenCalled();

		for (let i = 0; i < 5; i++) {
			source.send('decision', { decisionId: 3 + i, status: 'open', boardId: 7 });
			vi.advanceTimersByTime(100);
		}
		expect(onRefresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(250);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		close();
	});

	it('is never called by the editor, whose re-read would throw away unsaved edits (decision 26; code review F5)', () => {
		const dir = join(process.cwd(), 'src/routes/decisions/[id]/edit');
		const files = (readdirSync(dir, { recursive: true }) as string[]).filter((file) => /\.(ts|js|svelte)$/.test(file));
		expect(files.length).toBeGreaterThan(0);
		expect(files.filter((file) => /\bconnectLiveRefresh\b/.test(readFileSync(join(dir, file), 'utf8')))).toEqual([]);
		// The scan reads what it should: the register's page does call it.
		expect(readFileSync(join(process.cwd(), 'src/routes/decisions/+page.svelte'), 'utf8')).toMatch(/\bconnectLiveRefresh\(/);
	});
});

// ─── Survey answers on a person's record (card 2683, slice S3b) ─────────────

describe('survey answers on a person’s record (card 2683)', () => {
	it('S3b: says a survey answered as such, never as an option, and each answer by its prompt, a written one as plain text', () => {
		const answered = {
			...fullParticipation<OwnRecordEvent>(undefined, []),
			responses: [
				{
					versionNumber: 1,
					round: 1,
					kind: 'answered' as const,
					option: null,
					scores: null,
					optionComments: {},
					comment: null,
					answers: [
						{ prompt: 'Where do you ship from?', kind: 'choice' as const, choice: 'Leeds' },
						{ prompt: 'How busy are you?', kind: 'scale' as const, value: 4, max: 5 },
						{ prompt: 'Anything else?', kind: 'text' as const, text: '**Tuesdays** <i>only</i>' }
					],
					createdAt: '2026-11-01 10:00:00',
					current: true
				}
			]
		};
		for (const audience of ['self', 'admin'] as const) {
			const target = drawPerson({ audience, person: { name: 'Pat Doe', jobTitle: 'Engineer' }, participations: [answered], next: null } as PersonRecord);
			const item = target.querySelector('[data-response="current"]')!;
			expect(textOf(item.querySelector('strong')!), audience).toBe('Answered the survey');
			expect([...item.querySelectorAll('[data-answer]')].map(textOf), audience).toEqual([
				'Where do you ship from?: Leeds',
				'How busy are you?: 4 of 5',
				'Anything else?: **Tuesdays** <i>only</i>'
			]);
			expect(item.querySelector('[data-answer] strong, [data-answer] i'), audience).toBeNull();
		}
	});
});
