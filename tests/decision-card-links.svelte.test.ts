// @vitest-environment jsdom
/**
 * Card links in the page (card 2680, slice 3b: the plan's cases 130 to 136,
 * and 138 to 140 found in the build). Each component is mounted alone with
 * Svelte's client runtime, as the other decision files mount them, `fetch`
 * stood in for and every request recorded.
 *
 *   - `LinkedCards`, on the decision page: a found card linked with a `PUT`
 *     that says it is JSON and carries no body, unlinked with a `DELETE`,
 *     each answer drawn and the page's data read again; a refusal said in
 *     the server's words in the status region that stays drawn; the list
 *     alone without `mayLinkCards`, Unlink alone with `mayUnlinkCards`; the
 *     focus back in the search box after a link and on the next card's
 *     Unlink after an unlink; labelled controls.
 *   - `CardDecisions`, in the card window: the card's decisions, each to its
 *     page; nothing for none, one line for a failed read, and no read of its
 *     own (the window's sections have no `onMount`: tests/card-window.test.ts).
 *   - `CardModal` reads them once as it opens, and not again on a tab
 *     change; draws them for a saved card on its details tab, after the
 *     subtasks; and never for a new card.
 *
 * What the server answers, and to whom, is in `tests/decision-card-links.test.ts`.
 * The plan is `docs/planning/card-2680-register-records-links.md`. It is
 * named `.svelte.test.ts` so that a component's props can be `$state`.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type * as Svelte from 'svelte';
import type { LinkedCardView, LinkedDecisionView } from '$lib/decision-register-types';
import type { CardType } from '$lib/types';

const navigation = vi.hoisted(() => ({ invalidateAll: vi.fn(async () => {}) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(async () => {}),
	invalidateAll: navigation.invalidateAll,
	afterNavigate: () => {},
	onNavigate: () => {},
	beforeNavigate: () => {}
}));
vi.mock('$app/stores', () => {
	const value = { data: { user: { id: 1, username: 'alice', role: 'user' } } };
	return { page: { subscribe: (run: (v: typeof value) => void) => (run(value), () => {}) } };
});
// A bare 'svelte' gives the server's runtime, whose tick and onMount the components cannot use in a browser: the client's, by its path.
vi.mock('svelte', async () => {
	const { join } = await import('node:path');
	const { pathToFileURL } = await import('node:url');
	return await import(/* @vite-ignore */ pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href);
});

const LinkedCards = (await import('$lib/components/decision/LinkedCards.svelte')).default;
const CardDecisions = (await import('$lib/components/card/CardDecisions.svelte')).default;
const CardModal = (await import('$lib/components/CardModal.svelte')).default;

const clientEntry = pathToFileURL(join(process.cwd(), 'node_modules/svelte/src/index-client.js')).href;
const { flushSync, mount, unmount }: typeof Svelte = await import(/* @vite-ignore */ clientEntry);

// ─── The server's stand-in ───────────────────────────────────────────────────

type Sent = { method: string; url: string; init?: RequestInit };
let sent: Sent[];
/** What a request is answered with, by `METHOD url`, else an empty list. */
let answers: Map<string, () => Response>;
let fetched: Mock<(url: string, init?: RequestInit) => Promise<Response>>;

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
	sent = [];
	answers = new Map();
	navigation.invalidateAll.mockClear();
	fetched = vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		sent.push({ method, url, init });
		const answer = answers.get(`${method} ${url.split('?')[0]}`);
		if (answer) return answer();
		if (url.includes('/dependencies')) return respond({ blockedBy: [], blocks: [] });
		if (url.includes('/tokens')) return respond(null);
		return respond([]);
	});
	vi.stubGlobal('fetch', fetched);
	Element.prototype.scrollIntoView = () => {};
});

let drawn: { component: ReturnType<typeof mount>; target: HTMLElement }[] = [];

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

/** Lets the answers already given be read, and draws what they changed. */
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	for (let i = 0; i < 8; i++) await Promise.resolve();
	flushSync();
}

const button = (target: HTMLElement, action: string, card: number) => target.querySelector<HTMLButtonElement>(`button[data-action="${action}"][data-card="${card}"]`);
const statusWords = (target: HTMLElement) => target.querySelector('[role="status"][data-said="link"]')!.textContent!.trim();
const rows = (target: HTMLElement) => [...target.querySelectorAll('.cards > li')].map((row) => row.querySelector('.card-title')!.textContent!.trim());

const plan: LinkedCardView = { id: 12, title: 'Plan the move', boardId: 3, boardName: 'Board A', archived: false };
const build: LinkedCardView = { id: 14, title: 'Build it', boardId: 3, boardName: 'Board A', archived: true };
const found = { id: 21, title: 'Ship it', priority: 'low', columnName: 'To Do', boardId: 3, boardName: 'Board A', boardEmoji: '📋', milestoneId: null, kind: 'card' };

/** Types `text` into the search box and waits out its 250 ms, the answer read. */
async function search(target: HTMLElement, text: string) {
	const box = target.querySelector<HTMLInputElement>('input[type="search"]')!;
	box.value = text;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await new Promise((resolve) => setTimeout(resolve, 300));
	await settle();
}

// ─── LinkedCards ─────────────────────────────────────────────────────────────

describe('LinkedCards on the decision page', () => {
	it('links a found card with a PUT that says it is JSON and carries no body, and unlinks with a DELETE, each then reading the page again (130)', async () => {
		answers.set('GET /api/cards/search', () => respond([found]));
		answers.set('PUT /api/decisions/5/cards/21', () => respond({ outcome: 'linked', linkedCards: [plan, { ...found, archived: false }] }));
		answers.set('DELETE /api/decisions/5/cards/12', () => respond({ linkedCards: [{ ...found, archived: false }] }));
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan], mayLink: true, mayUnlink: true });
		expect(rows(target)).toEqual(['Plan the move']);
		expect(target.querySelector<HTMLAnchorElement>('.card-link')!.getAttribute('href')).toBe('/board/3?card=12');

		await search(target, 'ship');
		expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /api/cards/search?q=ship&editable=1']);
		button(target, 'link', 21)!.click();
		await settle();

		const put = sent.find((s) => s.method === 'PUT')!;
		expect(put.url).toBe('/api/decisions/5/cards/21');
		expect(put.init).toEqual({ method: 'PUT', headers: { 'Content-Type': 'application/json' } });
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(1);
		expect(rows(target)).toEqual(['Plan the move', 'Ship it']);
		expect(statusWords(target)).toBe('Linked #21 Ship it.');
		// The search is emptied, and the focus is back in it.
		const box = target.querySelector<HTMLInputElement>('input[type="search"]')!;
		expect(box.value).toBe('');
		expect(document.activeElement).toBe(box);

		button(target, 'unlink', 12)!.click();
		await settle();
		const del = sent.find((s) => s.method === 'DELETE')!;
		expect(del.url).toBe('/api/decisions/5/cards/12');
		expect(del.init).toEqual({ method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
		expect(navigation.invalidateAll).toHaveBeenCalledTimes(2);
		expect(rows(target)).toEqual(['Ship it']);
		expect(statusWords(target)).toBe('Unlinked #12 Plan the move.');
		// The focus goes to the next card's Unlink.
		expect(document.activeElement).toBe(button(target, 'unlink', 21));
	});

	it('…says a refusal in the server’s words, the list as it was (131)', async () => {
		answers.set('GET /api/cards/search', () => respond([found]));
		answers.set('PUT /api/decisions/5/cards/21', () => respond({ message: 'No edit access to this board' }, 403));
		answers.set('DELETE /api/decisions/5/cards/12', () => respond({ message: 'Link not found' }, 404));
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan], mayLink: true, mayUnlink: true });
		const status = target.querySelector('[role="status"][data-said="link"]');

		await search(target, 'ship');
		button(target, 'link', 21)!.click();
		await settle();
		expect(statusWords(target)).toBe('No edit access to this board');
		expect(target.querySelector('[role="status"]')!.classList.contains('refused')).toBe(true);

		button(target, 'unlink', 12)!.click();
		await settle();
		expect(statusWords(target)).toBe('Link not found');
		expect(rows(target)).toEqual(['Plan the move']);
		expect(navigation.invalidateAll).not.toHaveBeenCalled();
		// The same region throughout: it stays drawn, only its words changing.
		expect(target.querySelector('[role="status"][data-said="link"]')).toBe(status);
	});

	it('without mayLinkCards or mayUnlinkCards, the list and no controls; archived cards marked (132)', () => {
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan, build], mayLink: false, mayUnlink: false });
		expect(rows(target)).toEqual(['Plan the move', 'Build it']);
		expect(target.querySelectorAll('button')).toHaveLength(0);
		expect(target.querySelector('input')).toBeNull();
		expect([...target.querySelectorAll('[data-mark="archived"]')].map((mark) => mark.closest('li')!.querySelector('.card-title')!.textContent)).toEqual(['Build it']);
	});

	it('with mayUnlinkCards alone (at the cap, or on a withdrawn decision), Unlink and no search (138)', () => {
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan], mayLink: false, mayUnlink: true });
		expect(button(target, 'unlink', 12)).not.toBeNull();
		expect(target.querySelector('input[type="search"]')).toBeNull();
	});

	it('labels its controls: the search by a visible label, each Link and Unlink by the card it acts on; a card already linked is not offered (139)', async () => {
		answers.set('GET /api/cards/search', () => respond([found, { ...found, id: 12, title: 'Plan the move' }]));
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan], mayLink: true, mayUnlink: true });
		const box = target.querySelector<HTMLInputElement>('input[type="search"]')!;
		const label = target.querySelector<HTMLLabelElement>(`label[for="${box.id}"]`)!;
		expect(label.textContent).toContain('Find a card to link');
		expect(button(target, 'unlink', 12)!.getAttribute('aria-label')).toBe('Unlink #12 Plan the move');

		await search(target, 'p');
		expect(button(target, 'link', 21)!.getAttribute('aria-label')).toBe('Link #21 Ship it');
		expect(button(target, 'link', 12)).toBeNull();
		expect(target.querySelector('.results .already')!.textContent).toBe('Linked');
	});

	it('after unlinking the last card, the focus goes to the search box (140)', async () => {
		answers.set('DELETE /api/decisions/5/cards/12', () => respond({ linkedCards: [] }));
		const target = draw(LinkedCards, { decisionId: 5, cards: [plan], mayLink: true, mayUnlink: true });
		button(target, 'unlink', 12)!.click();
		await settle();
		expect(rows(target)).toEqual([]);
		expect(target.querySelector('.none')!.textContent).toBe('No cards are linked to this decision.');
		expect(document.activeElement).toBe(target.querySelector('input[type="search"]'));
	});
});

// ─── CardDecisions ───────────────────────────────────────────────────────────

const open: LinkedDecisionView = { id: 5, title: 'Which database', shownStatus: 'open', closesAt: '2026-11-10 12:00:00', relation: 'relates' };
const ruled: LinkedDecisionView = { id: 3, title: 'Which host', shownStatus: 'ruled', closesAt: null, relation: 'relates' };

describe('CardDecisions in the card window', () => {
	it('lists the card’s decisions, each linking to its page, with its status and its closing time while open (133)', () => {
		const target = draw(CardDecisions, { cardId: 7, decisions: [open, ruled] });
		const links = [...target.querySelectorAll<HTMLAnchorElement>('.decision-link')];
		expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
			['Which database', '/decisions/5'],
			['Which host', '/decisions/3']
		]);
		expect([...target.querySelectorAll('.status')].map((s) => s.textContent)).toEqual(['Open', 'Ruled']);
		expect([...target.querySelectorAll('.closes')].map((s) => s.textContent)).toEqual(['Closes 2026-11-10 12:00 UTC']);
		expect(target.querySelector('section')!.getAttribute('aria-labelledby')).toBe(target.querySelector('h3')!.id);
	});

	it('…draws nothing for none, and one line for a read that failed; it reads nothing itself (134)', () => {
		const none = draw(CardDecisions, { cardId: 7, decisions: [] });
		expect(none.innerHTML.replace(/<!---->/g, '').trim()).toBe('');
		const failed = draw(CardDecisions, { cardId: 7, decisions: [], failed: true });
		expect(failed.querySelector('.note')!.textContent).toBe('The decisions linked to this card could not be loaded.');
		expect(sent).toEqual([]);
	});
});

// ─── CardModal ───────────────────────────────────────────────────────────────

const saved = {
	id: 7, columnId: 1, categoryId: null, title: 'Plan', description: '', position: 0, priority: 'low',
	colorTag: null, dueDate: null, createdAt: '2026-10-20 09:00:00', updatedAt: '2026-10-20 09:00:00',
	subtasks: [], labelIds: [], pinned: false, onHoldNote: '', businessValue: null, subBoards: [],
	assignees: [], archivedAt: null, coverUrl: null, milestoneId: null, summary: null, theme: null
} as unknown as CardType;

describe('CardModal', () => {
	it('reads the card’s decisions once as the window opens, not again when the details tab is left and shown again, and says a refused read in one line (135)', async () => {
		answers.set('GET /api/cards/7/decisions', () => respond([open]));
		const target = draw(CardModal, { card: saved, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {} });
		await settle();
		for (const tab of ['Comments', 'Details', 'Files', 'Details']) {
			[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent!.includes(tab))!.click();
			flushSync();
			await settle();
		}
		expect(target.querySelector('.decision-link')!.textContent).toBe('Which database');
		expect(sent.filter((s) => s.url === '/api/cards/7/decisions').map((s) => s.method)).toEqual(['GET']);

		answers.set('GET /api/cards/8/decisions', () => respond({ message: 'Card not found' }, 404));
		const refused = draw(CardModal, { card: { ...saved, id: 8 }, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {} });
		await settle();
		expect(refused.querySelector('[data-section="card-decisions"] .note')!.textContent).toBe('The decisions linked to this card could not be loaded.');
	});

	it('draws CardDecisions for a saved card on its details tab, under the subtasks, and not on another tab nor for a new card (136)', async () => {
		answers.set('GET /api/cards/7/decisions', () => respond([open]));
		const target = draw(CardModal, { card: saved, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {} });
		await settle();
		const section = target.querySelector('.main-panel [data-section="card-decisions"]');
		expect(section).not.toBeNull();
		expect(section!.textContent).toContain('Which database');
		// After the subtasks, in the main panel, not in More options.
		const subtasks = target.querySelector('.main-panel .subtasks-section')!;
		expect(subtasks.compareDocumentPosition(section!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(target.querySelector('.advanced-section [data-section="card-decisions"]')).toBeNull();

		[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((tab) => tab.textContent!.includes('Comments'))!.click();
		flushSync();
		expect(target.querySelector('[data-section="card-decisions"]')).toBeNull();
		[...target.querySelectorAll<HTMLButtonElement>('.tab')].find((tab) => tab.textContent!.includes('Details'))!.click();
		flushSync();
		expect(target.querySelector('[data-section="card-decisions"]')).not.toBeNull();
		expect(sent.filter((s) => s.url === '/api/cards/7/decisions')).toHaveLength(1);

		const fresh = draw(CardModal, { card: null, categories: [], labels: [], boardId: 1, boardUsers: [], onSave: () => {}, onClose: () => {} });
		await settle();
		expect(fresh.querySelector('[data-section="card-decisions"]')).toBeNull();
		expect(sent.filter((s) => s.url.includes('/decisions'))).toHaveLength(1);
	});
});
