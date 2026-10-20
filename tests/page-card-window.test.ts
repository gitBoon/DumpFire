/**
 * The adapter that puts the card window of All Tasks, All To Do and the plan
 * page on the board page's controller (card 2281, slice C3a-1 of card 2012's
 * part C), `src/lib/board/page-card-window.svelte.ts`, run on its own over a
 * plain list standing in for a page's own:
 *
 *   - `writeCard` shows the change at once, takes the answer's values on
 *     success, and on a refusal or no answer puts back the fields it changed
 *     alone, each only while the card still shows what it set (a newer read
 *     that replaced the card is kept), and gives back the words to say;
 *   - `hold`'s release may be called once or many times;
 *   - the controller over it saves only the fields changed in the window, so
 *     a change someone else made meanwhile is not sent back, and saves a card
 *     the page's list has lost since the window opened, where the board page
 *     refuses one.
 *
 * The three pages mounted with it are in `tests/card-window-pages.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_GONE, type CardWindowSave } from '$lib/board/card-window.svelte';
import { PageCardBoard, PageCardWindow, windowCard } from '$lib/board/page-card-window.svelte';
import type { CardType } from '$lib/types';

const WORDS = { refused: 'The card was not saved.', noAnswer: 'No answer from the server. The card may not have been saved.' };

const card = (id: number, extra: Record<string, unknown> = {}) =>
	({ id, columnId: 1, boardId: 3, position: id, title: `Card ${id}`, description: '', priority: 'low', categoryId: null, dueDate: null, ...extra }) as unknown as CardType;

type Group = { title: string; cards: CardType[] };

/** A page's own list: two groups, read and replaced as a page's `$derived` would be. */
function pageList(groups: Group[]) {
	const list = { groups, sets: 0 };
	return Object.assign(list, {
		cards: {
			get: () => list.groups,
			set: (next: Group[]) => {
				list.sets++;
				list.groups = next;
			}
		}
	});
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const titles = (groups: Group[]) => groups.map((group) => group.cards.map((c) => `${c.id}:${c.title}:${c.priority}`));

/** What the window hands its save: its fields as filled from `from`, with `changes` typed. */
const saved = (from: CardType, changes: Partial<CardWindowSave> = {}): CardWindowSave => ({
	title: from.title,
	description: from.description || '',
	priority: from.priority || 'medium',
	categoryId: from.categoryId ?? null,
	dueDate: from.dueDate || null,
	summary: null,
	theme: null,
	customerImpact: null,
	closeReason: null,
	releaseState: null,
	...changes
});

let sent: { what: string; body: unknown }[] = [];

beforeEach(() => {
	sent = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A `fetch` that keeps each request and answers it with `answer`. */
function answering(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: RequestInit) => {
			sent.push({ what: `${init?.method ?? 'GET'} ${url}`, body: init?.body ? JSON.parse(String(init.body)) : null });
			return answer(url, init);
		})
	);
}

describe('PageCardBoard.writeCard (card 2281, slice C3a-1)', () => {
	const board = (list: ReturnType<typeof pageList>) => new PageCardBoard(list.cards, () => {}, () => null);

	it('shows the change on the page’s card at once, and on success takes the answer’s value of each field sent, and no other', async () => {
		const list = pageList([{ title: 'To Do', cards: [card(1), card(2)] }, { title: 'Done', cards: [card(3)] }]);
		let answer: (res: Response) => void = () => {};
		const writing = board(list).writeCard(2, { title: 'Two' }, () => new Promise((resolve) => (answer = resolve)), WORDS);

		expect(titles(list.groups)).toEqual([['1:Card 1:low', '2:Two:low'], ['3:Card 3:low']]);
		answer(json({ id: 2, title: 'Two, trimmed', priority: 'critical' }));
		const written = await writing;

		expect(written.ok).toBe(true);
		// The answer's title is taken; its priority, not sent, is not.
		expect(titles(list.groups)).toEqual([['1:Card 1:low', '2:Two, trimmed:low'], ['3:Card 3:low']]);
		// Each group's own fields are kept.
		expect(list.groups.map((group) => group.title)).toEqual(['To Do', 'Done']);
	});

	it('puts back the fields it changed alone on a refusal, and gives back the server’s words', async () => {
		const list = pageList([{ title: 'To Do', cards: [card(1), card(2, { description: 'Mine' })] }]);
		const written = await board(list).writeCard(2, { title: 'Two', priority: 'high' }, async () => json({ message: 'Viewers cannot change cards' }, 403), WORDS);

		expect(written).toEqual({ ok: false, failure: 'Viewers cannot change cards' });
		expect(titles(list.groups)).toEqual([['1:Card 1:low', '2:Card 2:low']]);
		expect(list.groups[0].cards[1].description).toBe('Mine');
	});

	it('puts them back for no answer too, and gives back the words for it', async () => {
		const list = pageList([{ title: 'To Do', cards: [card(1)] }]);
		const written = await board(list).writeCard(
			1,
			{ title: 'One' },
			async () => {
				throw new TypeError('Failed to fetch');
			},
			WORDS
		);

		expect(written).toEqual({ ok: false, failure: WORDS.noAnswer });
		expect(titles(list.groups)).toEqual([['1:Card 1:low']]);
	});

	it('keeps a newer read that replaced the card while the save was out: nothing it set is put back over it', async () => {
		const list = pageList([{ title: 'To Do', cards: [card(1)] }]);
		let answer: (res: Response) => void = () => {};
		const writing = board(list).writeCard(1, { title: 'Mine', priority: 'high' }, () => new Promise((resolve) => (answer = resolve)), WORDS);
		// A re-read of the page: someone else renamed it; the priority is still the one this save set.
		list.groups = [{ title: 'To Do', cards: [card(1, { title: 'Theirs', priority: 'high' })] }];
		answer(json({ message: 'Refused' }, 400));
		await writing;

		// Their title stays; the priority this save set and the read still shows is put back.
		expect(titles(list.groups)).toEqual([['1:Theirs:low']]);
	});
});

describe('PageCardBoard.hold and refresh (card 2281, slice C3a-1)', () => {
	it('holds nothing: its release says it is spent once called, and may be called again', () => {
		const board = new PageCardBoard(pageList([]).cards, () => {}, () => null);
		const release = board.hold();
		expect(release.released).toBe(false);
		release();
		expect(release.released).toBe(true);
		expect(() => release()).not.toThrow();
		expect(release.released).toBe(true);
		// Each hold its own.
		expect(board.hold().released).toBe(false);
	});

	it('reads the page again through the page’s own re-read', () => {
		const reread = vi.fn(async () => {});
		new PageCardBoard(pageList([]).cards, reread, () => null).refresh();
		expect(reread).toHaveBeenCalledTimes(1);
	});
});

describe('PageCardWindow, the controller over a page’s list (card 2281, slice C3a-1)', () => {
	it('sends only the field changed in the window: a priority someone else changed meanwhile is kept, not sent back', async () => {
		const opened = card(7, { title: 'Plan' });
		const list = pageList([{ title: 'To Do', cards: [opened] }]);
		const cardWindow = new PageCardWindow(list.cards, () => {});
		cardWindow.openCard(opened, 3);
		// The window is made with the card: what it opened on.
		expect(cardWindow.card?.title).toBe('Plan');
		// A re-read of the page while the window is open: someone else set the priority.
		list.groups = [{ title: 'To Do', cards: [card(7, { title: 'Plan', priority: 'critical' })] }];

		answering(() => json({ id: 7, title: 'Plan the launch' }));
		const written = await cardWindow.save(saved(opened, { title: 'Plan the launch' }));

		expect(written).toEqual({ ok: true, told: [{ message: 'Card updated', failed: false }] });
		expect(sent).toEqual([{ what: 'PUT /api/cards/7', body: { title: 'Plan the launch', boardId: 3 } }]);
		expect(titles(list.groups)).toEqual([['7:Plan the launch:critical']]);
		expect(cardWindow.open).toBe(false);
	});

	it('sends nothing for a save with nothing changed, and closes the window', async () => {
		const opened = card(7);
		const list = pageList([{ title: 'To Do', cards: [opened] }]);
		const cardWindow = new PageCardWindow(list.cards, () => {});
		cardWindow.openCard(opened, 3);
		void cardWindow.card;
		answering(() => json({}));

		expect(await cardWindow.save(saved(opened))).toEqual({ ok: true, told: [] });
		expect(sent).toEqual([]);
		expect(cardWindow.open).toBe(false);
		expect(list.sets).toBe(0);
	});

	it('keeps the window open on a refusal, with the card put back', async () => {
		const opened = card(7);
		const list = pageList([{ title: 'To Do', cards: [opened] }]);
		const cardWindow = new PageCardWindow(list.cards, () => {});
		cardWindow.openCard(opened, 3);
		void cardWindow.card;
		answering(() => json({ message: 'Viewers cannot change cards' }, 403));

		expect(await cardWindow.save(saved(opened, { title: 'Mine' }))).toEqual({ ok: false, failure: 'Viewers cannot change cards' });
		expect(cardWindow.open).toBe(true);
		expect(titles(list.groups)).toEqual([['7:Card 7:low']]);
	});

	it('saves a card the page’s list has lost since the window opened, as before, where the board page says it is gone', async () => {
		const opened = card(7);
		const list = pageList([{ title: 'To Do', cards: [opened] }]);
		const cardWindow = new PageCardWindow(list.cards, () => {});
		cardWindow.openCard(opened, 3);
		void cardWindow.card;
		// A re-read of All To Do after someone moved the card out of To Do.
		list.groups = [{ title: 'To Do', cards: [] }];
		expect(cardWindow.card?.id).toBe(7);
		answering(() => json({ message: 'Refused' }, 400));

		const refused = await cardWindow.save(saved(opened, { title: 'Mine' }));
		expect(refused).toEqual({ ok: false, failure: 'Refused' });
		expect(refused).not.toEqual({ ok: false, failure: CARD_GONE });
		expect(sent).toEqual([{ what: 'PUT /api/cards/7', body: { title: 'Mine', boardId: 3 } }]);
		// The page's list is left as the read gave it; the window still shows the card as it was.
		expect(titles(list.groups)).toEqual([[]]);
		expect(cardWindow.card?.title).toBe('Card 7');
		expect(cardWindow.open).toBe(true);
	});

	it('makes a controller for each card opened, on that card’s board', async () => {
		const list = pageList([{ title: 'To Do', cards: [card(7), card(8, { boardId: 5 })] }]);
		const cardWindow = new PageCardWindow(list.cards, () => {});
		cardWindow.openCard(list.groups[0].cards[1], 5);
		expect([cardWindow.cardId, cardWindow.boardId]).toEqual([8, 5]);
		void cardWindow.card;
		answering(() => json({ success: true }));

		expect(await cardWindow.archive(8)).toBeNull();
		expect(sent).toEqual([{ what: 'DELETE /api/cards/8', body: { boardId: 5 } }]);
		expect(cardWindow.open).toBe(false);
		expect(titles(list.groups)).toEqual([['7:Card 7:low']]);
	});
});

describe('windowCard (card 2186, moved here by card 2281’s slice C3a-1)', () => {
	it('hands the window the row as loaded, with the fall-backs it reads, the same object for the same row', () => {
		const row = { ...card(7), summary: 'Words', requestOrigin: { name: 'Pat' } } as unknown as CardType;
		const shown = windowCard(row);

		expect(shown).toMatchObject({ summary: 'Words', requestOrigin: { name: 'Pat' }, subtasks: [], labelIds: [], assignees: [], subBoards: [], pinned: false, onHoldNote: '', businessValue: '', archivedAt: null, coverUrl: null, milestoneId: null });
		expect(windowCard(row)).toBe(shown);
		expect(windowCard({ ...row })).not.toBe(shown);
	});
});
