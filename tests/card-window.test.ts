/**
 * What the card window saves, and what a card made from a template carries
 * (cards 2147 and 2163).
 *
 *   - Saving in the card window cleared a card's colour tag. The window has
 *     no control for one, and sent `colorTag: ""` with every save, so a tag
 *     set through the API (or the tracking wrapper's `update-card -ColorTag`)
 *     went at the next save on the board or the plan page. It sends none now.
 *   - A template saved from a labelled card stored the labels, and a card
 *     made from it got none. The New Task window keeps the template's labels
 *     that are labels of the board (`templateLabelIds` in `$lib/templates.ts`)
 *     and the board page puts them on the card once it is created, reading
 *     each answer (`saveCard` in `$lib/board/card-actions.ts`).
 *   - A create that was refused, or got no answer, came back from `saveCard`
 *     as made, and the board page said "Created". It comes back as a
 *     `failure`, which the page says, and nothing more is sent.
 *   - A card window open on the board page stayed open after a navigation
 *     to another board, and after Back on the same board left it over an
 *     address that named no card. `navigationClosesWindow` says when the
 *     page closes it.
 *
 * A page cannot be run here: no browser, no DOM. So the object the window's
 * `save()` hands to the page is built by the window's own code, read from
 * its source and run with the window's variables given (`windowSaves`); the
 * page's `saveCard` is called with it, with `fetch` standing in for the
 * browser's, and each request is answered by the route itself through
 * `api()`. What the card window and the board page do with the answers is
 * read from their source in `tests/page-failures.test.ts`.
 *
 * The plan is `docs/planning/cards-2143-2146-2147-2148-2163-2164-2167-pages.md`
 * (decisions 8 and 14, section 6).
 *
 * The board page's card window is opened, kept in step with the board, saved
 * and archived by one controller, `src/lib/board/card-window.svelte.ts`
 * (card 2280, slice B2c of card 2012's part B; decision 10). Its save sends
 * only the fields changed since the window opened, so a change someone else
 * made meanwhile is not sent back (found nearby B3 there, the lost update
 * card 2183 noted). Its cases are at the end, run against a real board state
 * whose reads are answered by the contents route.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, cardLabels, cards, labels, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import * as cardActions from '$lib/board/card-actions';
import { BoardState } from '$lib/board/board-state.svelte';
import { CARD_GONE, CardWindow, changedFields, windowFields, WINDOW_FIELDS, WindowEdits, type WindowFields } from '$lib/board/card-window.svelte';
import type { BoardContentsData } from '$lib/board/contents-answer';
import { templateLabelIds } from '$lib/templates';
import type { CardType, ColumnType } from '$lib/types';
import { api } from './helpers/api';
import { makeBoard, makeCard, makeLabel, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

const MODAL = 'src/lib/components/CardModal.svelte';

let owner: SessionUser;
let A: BoardFixture;

beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	A = makeBoard({ owner, name: 'A' });
});
afterEach(() => vi.unstubAllGlobals());

/** The card window's variables, as they are in the New Task window with a title typed and nothing else. */
const NEW_TASK = {
	card: null as Record<string, unknown> | null,
	title: 'A card',
	description: '',
	priority: 'medium',
	categoryId: null as number | null,
	dueDate: '',
	onHoldNote: '',
	businessValue: '',
	summary: '',
	theme: '',
	customerImpact: '',
	closeReason: '',
	releaseState: '',
	pendingSubtasks: [] as unknown[],
	cardAssignees: [] as { id: number }[],
	pendingSubBoardNames: [] as string[],
	templateLabels: [] as number[]
};

/** The window's variables for a card it was opened on: each field filled from the card, as the window fills them. */
const openedOn = (card: Card) => ({
	...NEW_TASK,
	card: card as unknown as Record<string, unknown>,
	title: card.title,
	description: card.description ?? '',
	priority: card.priority ?? 'medium',
	categoryId: card.categoryId,
	dueDate: card.dueDate ?? ''
});

/**
 * The object the card window's `save()` hands to `onSave`, built by the
 * window's own code: the object it is written as, read from the source,
 * compiled, and run with `state` as the window's variables.
 */
function windowSaves(state: typeof NEW_TASK): Parameters<typeof cardActions.saveCard>[4] {
	const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
	const script = ts.createSourceFile(MODAL, /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1], ts.ScriptTarget.Latest, true);
	const save = script.statements.find(
		(statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'save'
	)!;
	const calls: ts.CallExpression[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.getText() === 'onSave') calls.push(node);
		ts.forEachChild(node, visit);
	};
	visit(save);
	expect(calls).toHaveLength(1);

	const built = ts.transpile(`(${calls[0].arguments[0].getText()})`, { target: ts.ScriptTarget.ES2022 });
	return new Function(...Object.keys(state), `return ${built}`)(...Object.values(state));
}

type Sent = { method: string; url: string; body: Record<string, unknown> };

/**
 * `fetch` as the page calls it, each request answered by its route for
 * `owner`, unless `instead` answers it first: a `Response`, or 'no answer'
 * for a request that gets none. Returns the requests, as they are sent.
 */
function replay(instead: (request: Sent) => Response | 'no answer' | undefined = () => undefined): Sent[] {
	const sent: Sent[] = [];
	vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
		const request = { method: String(init.method), url, body: JSON.parse(String(init.body)) };
		sent.push(request);
		const answered = instead(request);
		if (answered === 'no answer') throw new TypeError('fetch failed');
		if (answered) return answered;
		const res = await api(init.method as Parameters<typeof api>[0], url, { user: owner, body: request.body });
		return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
	});
	return sent;
}

const cardRow = (id: number) => db.select().from(cards).where(eq(cards.id, id)).get()!;
const labelsOn = (cardId: number) =>
	db.select({ labelId: cardLabels.labelId }).from(cardLabels).where(eq(cardLabels.cardId, cardId)).all().map((row) => row.labelId).sort((a, b) => a - b);
/** The board's columns as the page holds them, each with its cards. */
const onThePage = (fixture: BoardFixture) =>
	Object.values(fixture.cols).map((col) => ({ ...col, cards: db.select().from(cards).where(eq(cards.columnId, col.id)).all() })) as unknown as ColumnType[];

describe('saving in the card window keeps the colour tag (card 2147)', () => {
	it('sends no colour tag when a saved card is saved, and a tag set through the API is still there, unnamed in the entry', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Tagged', colorTag: '#ef4444' });
		const sent = replay();

		const saved = windowSaves({ ...openedOn(card), title: 'Tagged, renamed' });
		await cardActions.saveCard(card as unknown as CardType, card.columnId, A.board.id, onThePage(A), saved);

		expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([`PUT /api/cards/${card.id}`]);
		expect(sent[0].body).not.toHaveProperty('colorTag');
		expect([cardRow(card.id).title, cardRow(card.id).colorTag]).toEqual(['Tagged, renamed', '#ef4444']);

		const [entry] = db.select().from(activityLog).where(eq(activityLog.cardId, card.id)).all();
		expect(entry.action).toBe('card_updated');
		expect(entry.detail).toMatch(/^Updated fields: /);
		expect(entry.detail).not.toContain('colorTag');
	});

	it('makes a new card with no colour tag, as before', async () => {
		const sent = replay();

		const result = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), windowSaves({ ...NEW_TASK, title: 'Fresh' }));

		expect(sent[0]).toMatchObject({ method: 'POST', url: '/api/cards' });
		expect(sent[0].body).not.toHaveProperty('colorTag');
		expect(cardRow(result.cardId!).colorTag).toBe('');
	});

	it('still copies the tag when a card is duplicated, which the window does not send', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Tagged', colorTag: '#ef4444' });
		const sent = replay();

		expect(await cardActions.duplicateCard(card as unknown as CardType, onThePage(A), A.board.id, [])).toEqual({ title: 'Tagged', failure: null });

		expect(sent[0].body).toMatchObject({ colorTag: '#ef4444' });
		const copy = db.select().from(cards).where(eq(cards.title, 'Tagged (Copy)')).get()!;
		expect(copy.colorTag).toBe('#ef4444');
	});
});

describe('the labels a template holds, templateLabelIds in src/lib/templates.ts (card 2163)', () => {
	const board = [{ id: 4 }, { id: 7 }, { id: 9 }];

	it('keeps the ids that are labels of this board, in the order stored, each once', () => {
		expect(templateLabelIds('[9, 4, 9, 7, 4]', board)).toEqual([9, 4, 7]);
		expect(templateLabelIds('[]', board)).toEqual([]);
	});

	it('leaves out a label deleted since, another board’s, and anything that is no id', () => {
		// 5: deleted since. 12: another board's. Then a number that is not whole,
		// an id written as text, null, and a list inside the list.
		expect(templateLabelIds('[5, 7, 12, 1.5, "3", null, [4], {"id": 9}]', board)).toEqual([7]);
	});

	it('gives none for stored text that is not a list', () => {
		for (const stored of ['not json', '', 'null', '4', '"[4]"', '{"labels": [4]}', null, undefined]) {
			expect(templateLabelIds(stored, board), String(stored)).toEqual([]);
		}
	});

	it('gives none on a board with no labels', () => {
		expect(templateLabelIds('[4, 7]', [])).toEqual([]);
	});
});

describe('a card made from a template carries its labels (card 2163)', () => {
	it('posts the card without them, then puts each on it, and the card has them', async () => {
		const bug = makeLabel(A.board, 'Bug');
		const urgent = makeLabel(A.board, 'Urgent');
		const sent = replay();

		const saved = windowSaves({ ...NEW_TASK, title: 'From a template', templateLabels: [urgent.id, bug.id] });
		const result = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), saved);

		// No pending subtask failed either (card 2280, slice B2b reads each subtask's answer).
		expect(result).toEqual({ isNew: true, title: 'From a template', cardId: expect.any(Number), labelFailures: [], subtaskFailures: [] });
		expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual(['POST /api/cards', 'PUT /api/labels', 'PUT /api/labels']);
		expect(sent[0].body).not.toHaveProperty('pendingLabelIds');
		expect(sent.slice(1).map((request) => request.body)).toEqual([
			{ cardId: result.cardId, labelId: urgent.id, boardId: A.board.id },
			{ cardId: result.cardId, labelId: bug.id, boardId: A.board.id }
		]);
		expect(labelsOn(result.cardId!)).toEqual([bug.id, urgent.id].sort((a, b) => a - b));
	});

	it('sends no labels for a card saved again, nor for a new card with no template', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Saved' });
		const label = makeLabel(A.board, 'Bug');
		const sent = replay();

		// A saved card's labels are the picker's: the window sends none of a template's.
		await cardActions.saveCard(card as unknown as CardType, card.columnId, A.board.id, onThePage(A), windowSaves({ ...openedOn(card), templateLabels: [label.id] }));
		await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), windowSaves({ ...NEW_TASK, title: 'Plain' }));

		expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual([`PUT /api/cards/${card.id}`, 'POST /api/cards']);
		expect(sent.every((request) => !('pendingLabelIds' in request.body))).toBe(true);
	});

	it('keeps the card when a label is refused, and gives back the refusal in the server’s words', async () => {
		const bug = makeLabel(A.board, 'Bug');
		const gone = makeLabel(A.board, 'Urgent');
		const elsewhere = makeLabel(makeBoard({ owner, name: 'B' }).board, 'Theirs');
		// Deleted in another tab after the template was applied.
		db.delete(labels).where(eq(labels.id, gone.id)).run();
		replay();

		const saved = windowSaves({ ...NEW_TASK, title: 'Kept', templateLabels: [gone.id, bug.id, elsewhere.id] });
		const result = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), saved);

		expect(result.labelFailures).toEqual([
			{ labelId: gone.id, message: 'Label not found' },
			{ labelId: elsewhere.id, message: 'That label belongs to a different board' }
		]);
		expect(cardRow(result.cardId!).title).toBe('Kept');
		expect(labelsOn(result.cardId!)).toEqual([bug.id]);
	});

	it('says so when a label gets no answer, or an answer that is not DumpFire’s, and goes on to the next', async () => {
		const first = makeLabel(A.board, 'First');
		const second = makeLabel(A.board, 'Second');
		const third = makeLabel(A.board, 'Third');
		replay((request) => {
			if (request.body.labelId === first.id) return 'no answer';
			if (request.body.labelId === second.id) return new Response('<html>Bad gateway</html>', { status: 502 });
			return undefined;
		});

		const saved = windowSaves({ ...NEW_TASK, title: 'Partly', templateLabels: [first.id, second.id, third.id] });
		const result = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), saved);

		expect(result.labelFailures).toEqual([
			{ labelId: first.id, message: 'No answer from the server, so it may be on the card after all.' },
			{ labelId: second.id, message: 'It was refused.' }
		]);
		expect(labelsOn(result.cardId!)).toEqual([third.id]);
	});

	it('sends each label once, since a second toggle would take it off', async () => {
		const bug = makeLabel(A.board, 'Bug');
		const sent = replay();

		const result = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), {
			...windowSaves({ ...NEW_TASK, title: 'Twice' }),
			pendingLabelIds: [bug.id, bug.id]
		});

		expect(sent.filter((request) => request.url === '/api/labels')).toHaveLength(1);
		expect(labelsOn(result.cardId!)).toEqual([bug.id]);
	});
});

describe('a new card the server does not make (the review of cards 2147 and 2163)', () => {
	// It came back as made, `isNew: true`, and the board page said "Created"
	// for a card that was not there.
	it('gives back a create the server refused, or that got no answer, as a failure, and sends nothing more', async () => {
		const bug = makeLabel(A.board, 'Bug');
		const sent = replay();

		// A title over the 500 characters a card's may have.
		const saved = windowSaves({ ...NEW_TASK, title: 'x'.repeat(501), templateLabels: [bug.id] });
		const refused = await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), saved);

		expect(refused).toEqual({ isNew: false, title: 'x'.repeat(501), failure: 'title must be at most 500 characters' });
		// No label sent for a card that is not there.
		expect(sent.map((request) => `${request.method} ${request.url}`)).toEqual(['POST /api/cards']);
		expect(db.select().from(cards).all()).toEqual([]);

		replay(() => 'no answer');
		expect(await cardActions.saveCard(null, A.cols['To Do'].id, A.board.id, onThePage(A), windowSaves({ ...NEW_TASK, title: 'Lost' }))).toEqual({
			isNew: false,
			title: 'Lost',
			failure: 'No answer from the server. The card may not have been created.'
		});
	});
});

describe('which navigations close the board page’s card window, navigationClosesWindow (the review of card 2164)', () => {
	const at = (id: string, query = '') => ({ params: { id }, url: new URL(`http://dumpfire.test/board/${id}${query}`) });
	const closes = cardActions.navigationClosesWindow;

	it('closes it for a navigation to another board, a card named or not, whatever is open', () => {
		// Back from a dependency link left board Q's card open over board P.
		for (const open of [true, false]) {
			expect(closes(at('7'), at('3'), open), String(open)).toBe(true);
			expect(closes(at('7'), at('3', '?card=12'), open), String(open)).toBe(true);
		}
	});

	it('closes a saved card’s window on the same board when the address names no card, as after Back', () => {
		expect(closes(at('3'), at('3'), true)).toBe(true);
	});

	it('leaves the window to the card the address names, and a New Task window on the same board alone', () => {
		// The card named is opened in its place by openCardFromAddress.
		expect(closes(at('3'), at('3', '?card=12'), true)).toBe(false);
		expect(closes(at('3'), at('3'), false)).toBe(false);
	});

	it('says close on a first load, which comes from nowhere: no window is open yet, so none is lost', () => {
		expect(closes(null, at('3', '?card=12'), false)).toBe(true);
	});
});

/**
 * The card window's variables as the window fills them when it opens on
 * `card`: each of CardModal's `let x = $state(...)` initialisers, read from
 * its source and run with `card` given. The window fills its fields from its
 * card once, as it is made, and never again.
 */
function windowOpenedOn(card: Record<string, unknown> | null): typeof NEW_TASK {
	const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
	const script = ts.createSourceFile(MODAL, /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1], ts.ScriptTarget.Latest, true);
	const state: Record<string, unknown> = { ...NEW_TASK, card };
	const filled: string[] = [];
	for (const statement of script.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declared of statement.declarationList.declarations) {
			const name = declared.name.getText();
			const initial = declared.initializer;
			if (name === 'card' || !(name in NEW_TASK) || !initial || !ts.isCallExpression(initial) || initial.expression.getText() !== '$state') continue;
			const built = ts.transpile(`(${initial.arguments[0].getText()})`, { target: ts.ScriptTarget.ES2022 });
			state[name] = new Function('card', `return ${built}`)(card);
			filled.push(name);
		}
	}
	// Each field a save sends is one the window fills from its card.
	expect(filled).toEqual(expect.arrayContaining([...WINDOW_FIELDS]));
	return state as typeof NEW_TASK;
}

/**
 * CardModal's follow `$effect` (card 2280, slice B5d), read from its source
 * and compiled: the one that hands `edits.follow` the fields shown. Where
 * there is none it is `() => {}`, so the window is run as one whose fields
 * are filled once; the case "no $effect of the window sets a typed field but
 * the follow's" holds that it is there.
 */
function followEffect(): string {
	const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
	const script = ts.createSourceFile(MODAL, /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1], ts.ScriptTarget.Latest, true);
	let found: string | null = null;
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && node.expression.getText() === '$effect' && node.arguments[0]?.getText().includes('edits.follow(')) found = node.arguments[0].getText();
		ts.forEachChild(node, visit);
	};
	visit(script);
	return found ? ts.transpile(`(${found})`, { target: ts.ScriptTarget.ES2022 }) : '(() => {});';
}

describe('the board’s card window, src/lib/board/card-window.svelte.ts (card 2280, slice B2c)', () => {
	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

	/** A board state's reads, answered by the contents route for `user`, as the board page's are. */
	const readsAs = (user: SessionUser) => async (input: RequestInfo | URL) => {
		const res = await api('GET', String(input), { user });
		return json(res.status, res.body);
	};

	let made: BoardState[] = [];
	afterEach(() => {
		for (const state of made) state.dispose();
		made = [];
	});

	/** The board page's board state and card window, made from the board's contents as the route gives them. */
	async function boardPage(fixture: BoardFixture, user = owner) {
		const read = readsAs(user);
		const first = (await (await read(`/api/boards/${fixture.board.id}/contents`)).json()) as BoardContentsData;
		const boardState = new BoardState(first, { invalidate: async () => {}, fetch: read });
		made.push(boardState);
		return { boardState, cardWindow: new CardWindow(boardState, fixture.board.id) };
	}

	/** A board state made from `contents` alone, whose reads are counted and never answered. */
	function standIn(contents: Partial<BoardContentsData>) {
		const reads: string[] = [];
		const boardState = new BoardState(
			{
				board: { id: 9, name: 'Board', emoji: null, parentCardId: null },
				breadcrumbs: [],
				columns: [],
				categories: [],
				labels: [],
				linkableBoards: [],
				canEdit: true,
				canManage: true,
				userBoardRole: 'owner',
				boardUsers: [],
				blockedState: {},
				cardTokens: {},
				boardTokenSummary: null,
				milestones: [],
				...contents
			} as BoardContentsData,
			{
				invalidate: async () => {},
				fetch: (input) => {
					reads.push(String(input));
					return new Promise<Response>(() => {});
				}
			}
		);
		made.push(boardState);
		return { boardState, reads, cardWindow: new CardWindow(boardState, 9) };
	}

	const shown = (boardState: BoardState, id: number) => boardState.columns.flatMap((c) => c.cards).find((c) => c.id === id);
	const asCard = (card: CardType | null) => card as unknown as Record<string, unknown>;

	/** `fetch` as the page calls it, each request kept and answered when the test says: a `Response`, or 'none' for no answer. */
	function heldAnswers() {
		const asked: { what: string; body: Record<string, unknown>; answer: (res: Response | 'none') => void }[] = [];
		vi.stubGlobal(
			'fetch',
			(url: string, init: RequestInit) =>
				new Promise<Response>((resolve, reject) =>
					asked.push({
						what: `${init.method} ${url}`,
						body: JSON.parse(String(init.body)),
						answer: (res) => (res === 'none' ? reject(new TypeError('Failed to fetch')) : resolve(res))
					})
				)
		);
		return asked;
	}

	it('sends only the fields changed since the window opened: a description someone else changed meanwhile is not sent back (the lost update)', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes', priority: 'low' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		const typing = windowOpenedOn(asCard(cardWindow.card));

		// Someone else changes the description while the window is open, and the
		// board reads it: the window's card follows the board.
		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { description: 'Their notes' } })).status).toBe(200);
		await boardState.refreshNow();
		expect(cardWindow.card?.description).toBe('Their notes');

		// The user changes the title alone.
		const sent = replay();
		const saved = await cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card), title: 'Plan, renamed' }));

		expect(saved).toEqual({ ok: true, told: [{ message: 'Card updated', failed: false }] });
		expect(sent).toEqual([{ method: 'PUT', url: `/api/cards/${card.id}`, body: { title: 'Plan, renamed', boardId: A.board.id } }]);
		expect([cardRow(card.id).title, cardRow(card.id).description, cardRow(card.id).priority]).toEqual(['Plan, renamed', 'Their notes', 'low']);
		expect(shown(boardState, card.id)).toMatchObject({ title: 'Plan, renamed', description: 'Their notes' });
		expect(cardWindow.open).toBe(false);
	});

	it('keeps what the user typed when the board is read meanwhile: the window’s card follows the board, and the field typed is the one sent', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan', priority: 'low' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		const typing = { ...windowOpenedOn(asCard(cardWindow.card)), title: 'Mine' };

		// Someone else renames the card and raises its priority as the user types.
		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { title: 'Theirs', priority: 'high' } })).status).toBe(200);
		await boardState.refreshNow();
		expect(cardWindow.card).toMatchObject({ title: 'Theirs', priority: 'high' });

		const sent = replay();
		await cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card) }));
		// The title typed is sent, the priority not touched is not: a field both changed is the last save's.
		expect(sent.map((request) => request.body)).toEqual([{ title: 'Mine', boardId: A.board.id }]);
		expect([cardRow(card.id).title, cardRow(card.id).priority]).toEqual(['Mine', 'high']);
	});

	it('is a window whose typed fields no read can overwrite: no $effect of the window sets one but the follow’s, which sets each only to what edits.follow brought (card 2280, slice B5d)', () => {
		const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
		const script = ts.createSourceFile(MODAL, /<script lang="ts">([\s\S]*?)<\/script>/.exec(source)![1], ts.ScriptTarget.Latest, true);
		// The names an expression assigns to: one, or each in a destructuring.
		const targets = (node: ts.Expression): string[] => {
			if (ts.isIdentifier(node)) return [node.text];
			if (ts.isParenthesizedExpression(node)) return targets(node.expression);
			if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((element) => targets(ts.isSpreadElement(element) ? element.expression : element));
			if (ts.isObjectLiteralExpression(node)) {
				return node.properties.flatMap((property) =>
					ts.isShorthandPropertyAssignment(property) ? [property.name.text] : ts.isPropertyAssignment(property) ? targets(property.initializer) : ts.isSpreadAssignment(property) ? targets(property.expression) : []
				);
			}
			// A default in a destructuring: `[title = 'x'] = ...`.
			if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return targets(node.left);
			return [];
		};
		// The names a node assigns to: `=`, a compound assignment (`+=`, `??=` and
		// the rest), a destructuring one, `++` and `--` (the B5d review).
		const assigns = (node: ts.Node): string[] => {
			if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return targets(node.left);
			if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) return targets(node.operand);
			return [];
		};
		const isTyped = (name: string) => (WINDOW_FIELDS as readonly string[]).includes(name);
		// Each assignment made inside an $effect, with the $effect it is in; and
		// each name used inside an $effect, to find a function of the window's
		// called (or handed on) from one.
		const assigned: { name: string; node: ts.Node; effect: ts.CallExpression }[] = [];
		const used: { name: string; effect: ts.CallExpression }[] = [];
		const visit = (node: ts.Node, inEffect: ts.CallExpression | null) => {
			const effect = inEffect ?? (ts.isCallExpression(node) && /^\$effect(\.pre)?$/.test(node.expression.getText()) ? node : null);
			if (effect) {
				for (const name of assigns(node)) assigned.push({ name, node, effect });
				if (ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) used.push({ name: node.text, effect });
			}
			ts.forEachChild(node, (child) => visit(child, effect));
		};
		visit(script, null);

		// No $effect calls a function of the window's that sets a typed field,
		// itself or through another (the B5d review): `applyTemplate` and
		// `createCategoryInline` do, and are called from the window's controls.
		const functions = new Map<string, ts.Node>();
		for (const statement of script.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement);
			if (!ts.isVariableStatement(statement)) continue;
			for (const declared of statement.declarationList.declarations) {
				if (declared.initializer && (ts.isArrowFunction(declared.initializer) || ts.isFunctionExpression(declared.initializer))) functions.set(declared.name.getText(), declared.initializer);
			}
		}
		const settingTyped = new Set<string>();
		for (let grew = true; grew; ) {
			grew = false;
			for (const [name, fn] of functions) {
				if (settingTyped.has(name)) continue;
				let sets = false;
				const look = (node: ts.Node) => {
					if (assigns(node).some(isTyped) || (ts.isIdentifier(node) && settingTyped.has(node.text))) sets = true;
					ts.forEachChild(node, look);
				};
				look(fn);
				if (sets) settingTyped.add(name), (grew = true);
			}
		}
		expect([...settingTyped].sort()).toEqual(['applyTemplate', 'createCategoryInline']);
		expect(used.filter(({ name }) => settingTyped.has(name)).map(({ name }) => name)).toEqual([]);
		// And its sections (card 2280, slice B4), which are handed the fields bound:
		// none sets one in an $effect, or has an $effect or onMount at all, so
		// none fills a field, a list or the cost again when a read hands the
		// window its card afresh. Each of their scripts, the module one too.
		const sections = (readdirSync(join(process.cwd(), 'src/lib/components/card')) as string[]).filter((file) => file.endsWith('.svelte'));
		expect(sections.length).toBeGreaterThan(0);
		for (const file of sections) {
			const text = readFileSync(join(process.cwd(), 'src/lib/components/card', file), 'utf8');
			for (const block of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
				const tree = ts.createSourceFile(file, block[1], ts.ScriptTarget.Latest, true);
				visit(tree, null);
				expect(block[1], file).not.toMatch(/\$effect|\bonMount\b/);
			}
		}

		// The one $effect that sets a typed field is the window's follow (card
		// 2280, slice B5d): on the board page, given `edits`, it hands
		// `edits.follow` the fields as shown and the card's as the board has it
		// now, and sets each field, once, to what that brought back, and only
		// when it brought one. `follow` brings back only fields the user has not
		// touched (its cases are below), so no effect sets a field typed in.
		// Given no `edits` (All Tasks, All To Do, the plan page) it sets nothing.
		const typed = assigned.filter(({ name }) => isTyped(name));
		const follows = [...new Set(typed.map(({ effect }) => effect))];
		expect(follows).toHaveLength(1);
		const [follow] = follows;
		const body = (follow.arguments[0] as ts.ArrowFunction).body as ts.Block;
		// The field whose box has the focus is held (the B5d review): not brought
		// until it is left, so a read does not move the caret in it.
		expect(body.statements.map((statement) => statement.getText().replace(/\s+/g, ' ')).slice(0, 3)).toEqual([
			'if (!edits) return;',
			`const shown: WindowFields = { ${WINDOW_FIELDS.join(', ')} };`,
			'const brought = edits.follow(shown, card ? windowFields(card) : null, focusedField);'
		]);
		expect(typed.map(({ name }) => name)).toEqual([...WINDOW_FIELDS]);
		for (const { name, node } of typed) {
			// A plain `=` to the field alone.
			expect(ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left), name).toBe(true);
			const set = node as ts.BinaryExpression;
			expect(set.right.getText().replace(/ as \w+( \| null)?$/, ''), name).toBe(`brought.${name}`);
			const guard = set.parent.parent;
			expect(ts.isIfStatement(guard) && guard.thenStatement === set.parent ? guard.expression.getText() : null, name).toBe(`brought.${name} !== undefined`);
		}
		// And it sets nothing else.
		expect(assigned.filter(({ effect }) => effect === follow).map(({ name }) => name)).toEqual([...WINDOW_FIELDS]);
		expect(body.statements).toHaveLength(3 + WINDOW_FIELDS.length);
		// Its subtasks are filled, and its cost read, for the card, keyed by the
		// card's id alone, and not again for every read of the board: a read sent
		// before a tick was answered would untick it.
		const flat = source.replace(/\s+/g, ' ');
		expect(flat).toContain('const windowCardId = $derived(card?.id);');
		expect(flat).toContain('$effect(() => { if (!windowCardId) return; untrack(() => { if (card) cardSubtasks = (card.subtasks || []).map((s) => ({ ...s })); }); });');
		expect(flat).toContain('const id = windowCardId;');
		expect(assigned.filter(({ name }) => name === 'cardSubtasks')).toHaveLength(1);

		// The subtasks are copies, filled from the card in both places: a tick in
		// the window changes its own list, not the board state's card (the B2c review).
		expect(flat).toContain('let cardSubtasks = $state<SubtaskType[]>((card?.subtasks || []).map((s) => ({ ...s })));');
		const declared = script.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => [...statement.declarationList.declarations])
			.find((declaration) => declaration.name.getText() === 'cardSubtasks')!;
		const fill = new Function('card', `return ${ts.transpile(`(${(declared.initializer as ts.CallExpression).arguments[0].getText()})`, { target: ts.ScriptTarget.ES2022 })}`);
		const onBoard = { subtasks: [{ id: 1, title: 'One', completed: false }] };
		const filled = fill(onBoard);
		expect(filled).toEqual(onBoard.subtasks);
		filled[0].completed = true;
		expect(onBoard.subtasks[0].completed).toBe(false);
	});

	it('shows the On Hold box from the window’s own note: a note someone else wrote meanwhile neither shows a blank box nor takes the box away mid-edit (the B2c review)', () => {
		const source = readFileSync(join(process.cwd(), MODAL), 'utf8');
		const before = source.slice(0, source.indexOf('<div class="on-hold-note-display">'));
		const opened = before.lastIndexOf('{#if ');
		const condition = before.slice(opened + '{#if '.length, before.indexOf('}', opened));
		const shows = (card: { onHoldNote: string }, onHoldNote: string, editingOnHold: boolean) =>
			Boolean(new Function('card', 'onHoldNote', 'editingOnHold', `return (${condition});`)(card, onHoldNote, editingOnHold));

		// Opened with no note; someone else moves the card into On Hold with one, and the board reads it.
		expect(shows({ onHoldNote: 'Theirs' }, '', false)).toBe(false);
		// Opened on a note the user is editing; someone else drags the card out, which clears it.
		expect(shows({ onHoldNote: '' }, 'Waiting on the supplier, typed', true)).toBe(true);
		// Emptied while being edited: kept, to be typed in.
		expect(shows({ onHoldNote: '' }, '', true)).toBe(true);
		expect(shows({ onHoldNote: 'Waiting' }, 'Waiting', false)).toBe(true);
		expect(shows({ onHoldNote: '' }, '', false)).toBe(false);
	});

	it('takes back only its own fields when the save is refused, keeps the window open, and gives the server’s words', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes', priority: 'low' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		const typing = windowOpenedOn(asCard(cardWindow.card));
		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { description: 'Their notes' } })).status).toBe(200);
		await boardState.refreshNow();

		const asked = heldAnswers();
		const saving = cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card), title: 'Plan, renamed', priority: 'high' }));
		// Shown on the board at once, and the board's reads held while it is out.
		expect(shown(boardState, card.id)).toMatchObject({ title: 'Plan, renamed', priority: 'high', description: 'Their notes' });
		expect(boardState.holds).toBe(1);
		expect(asked.map((a) => [a.what, a.body])).toEqual([[`PUT /api/cards/${card.id}`, { title: 'Plan, renamed', priority: 'high', boardId: A.board.id }]]);
		asked[0].answer(json(403, { message: 'Viewers cannot change cards' }));

		expect(await saving).toEqual({ ok: false, failure: 'Viewers cannot change cards' });
		// Its two fields back; the description someone else changed is not put back to what the window opened on.
		expect(shown(boardState, card.id)).toMatchObject({ title: 'Plan', priority: 'low', description: 'Their notes' });
		expect(cardWindow.open).toBe(true);
		expect(cardWindow.cardId).toBe(card.id);
		expect(boardState.holds).toBe(0);

		// Sent again with no answer: the same, in the no-answer words.
		const again = cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card), title: 'Plan, renamed' }));
		asked[1].answer('none');
		expect(await again).toEqual({ ok: false, failure: 'No answer from the server. The card may not have been saved.' });
		expect(shown(boardState, card.id)?.title).toBe('Plan');
		expect(cardWindow.open).toBe(true);
	});

	it('sends nothing for a window saved as it opened, every field filled or none, and closes it', async () => {
		const full = makeCard(A.cols['To Do'], {
			title: 'Full',
			description: 'Notes',
			priority: 'high',
			dueDate: '2026-11-02',
			onHoldNote: 'Waiting on the supplier',
			businessValue: 'Saves an hour a day',
			summary: 'Faster invoices',
			theme: 'maintenance',
			customerImpact: 'internal',
			closeReason: 'delivered',
			releaseState: 'live'
		});
		const bare = makeCard(A.cols['To Do'], { title: 'Bare' });
		const { boardState, cardWindow } = await boardPage(A);
		const sent = replay();
		for (const card of [full, bare]) {
			cardWindow.openCard(shown(boardState, card.id)!);
			const untouched = windowOpenedOn(asCard(cardWindow.card));
			expect(changedFields(windowFields(cardWindow.card!), windowSaves(untouched)), card.title).toEqual({});
			expect(await cardWindow.save(windowSaves(untouched))).toEqual({ ok: true, told: [] });
			expect(cardWindow.open).toBe(false);
		}
		expect(sent).toEqual([]);
	});

	it('sends a field emptied in the window as the window sends it, so it is cleared', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Held', onHoldNote: 'Waiting', summary: 'Short', dueDate: '2026-11-02' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		const sent = replay();
		await cardWindow.save(windowSaves({ ...windowOpenedOn(asCard(cardWindow.card)), onHoldNote: '', summary: '', dueDate: '' }));
		expect(sent.map((request) => request.body)).toEqual([{ onHoldNote: '', summary: null, dueDate: null, boardId: A.board.id }]);
		expect([cardRow(card.id).onHoldNote, cardRow(card.id).summary, cardRow(card.id).dueDate]).toEqual(['', null, null]);
	});

	it('names each subtask, assignee, label and sub-board of a new card that was refused, keeps the card, and reads the board once', async () => {
		const { boardState, cardWindow } = standIn({
			columns: [{ id: 3, boardId: 9, title: 'To Do', position: 0, color: '#888888', showAddCard: true, wipLimit: 0, cards: [] }] as unknown as ColumnType[],
			labels: [{ id: 4, boardId: 9, name: 'Bug', color: '#ff0000' }] as BoardContentsData['labels'],
			boardUsers: [
				{ id: 1, username: 'owner', emoji: '👤' },
				{ id: 2, username: 'editor', emoji: '🦊' }
			] as BoardContentsData['boardUsers']
		});
		const sent: string[] = [];
		vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			sent.push(`${init.method} ${url}`);
			if (url === '/api/cards') return json(201, { id: 50 });
			if (url === '/api/subtasks') return body.title === 'Two' ? json(400, { message: 'A subtask title is at most 500 characters' }) : json(201, { id: 1 });
			if (url === '/api/labels') return json(400, { message: 'That label belongs to a different board' });
			if (url === '/api/cards/50/assignees') return body.userId === 1 ? json(201, {}) : json(403, { message: 'That user cannot open this board' });
			if (url === '/api/boards' && body.name === 'Lost') throw new TypeError('Failed to fetch');
			if (url === '/api/boards') return body.name === 'Deep' ? json(409, { message: 'Sub-boards can be nested at most 20 levels deep.' }) : json(201, { id: 70 });
			return json(500, {});
		});
		const refresh = vi.spyOn(boardState, 'refresh');
		cardWindow.openNew(3);
		expect([cardWindow.open, cardWindow.cardId, cardWindow.columnId, cardWindow.card]).toEqual([true, null, 3, null]);

		const saved = await cardWindow.save({
			...windowSaves({ ...NEW_TASK, title: 'New' }),
			pendingSubtasks: ['One', 'Two'].map((title) => JSON.stringify({ title })),
			// 4 is the board's; 8 was deleted while the window was open.
			pendingLabelIds: [4, 8],
			// 1 and 2 are the board's; 99 is no longer on it.
			pendingAssigneeIds: [1, 2, 99],
			pendingSubBoards: ['Plans', 'Deep', 'Lost']
		});

		expect(saved).toEqual({
			ok: true,
			told: [
				{ message: 'Created "New"', failed: false },
				{ message: 'The template\'s label "Bug" was not put on "New". That label belongs to a different board', failed: true },
				{ message: 'A label of the template that no longer exists was not put on "New". That label belongs to a different board', failed: true },
				{ message: 'Subtask "Two" was not added to "New". A subtask title is at most 500 characters', failed: true },
				{ message: '"editor" was not assigned to "New". That user cannot open this board', failed: true },
				{ message: 'Someone no longer on this board was not assigned to "New". That user cannot open this board', failed: true },
				{ message: 'Sub-board "Plans" created', failed: false },
				{ message: 'Sub-board "Deep" was not made. Sub-boards can be nested at most 20 levels deep.', failed: true },
				{ message: 'No answer from the server. Sub-board "Lost" may not have been made.', failed: true }
			]
		});
		expect(sent).toEqual([
			'POST /api/cards',
			'POST /api/subtasks',
			'POST /api/subtasks',
			'PUT /api/labels',
			'PUT /api/labels',
			'POST /api/cards/50/assignees',
			'POST /api/cards/50/assignees',
			'POST /api/cards/50/assignees',
			'POST /api/boards',
			'POST /api/boards',
			'POST /api/boards'
		]);
		// Closed, and the board read once for the new card, which is the reader's to draw.
		expect(cardWindow.open).toBe(false);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(boardState.holds).toBe(0);
	});

	it('keeps the New Task window open with what was typed when no card is made, and sends nothing more', async () => {
		const { boardState, cardWindow } = standIn({ columns: [{ id: 3, boardId: 9, title: 'To Do', position: 0, cards: [] }] as unknown as ColumnType[] });
		const asked = heldAnswers();
		cardWindow.openNew(3);
		const saving = cardWindow.save({ ...windowSaves({ ...NEW_TASK, title: 'New' }), pendingAssigneeIds: [1], pendingSubBoards: ['Plans'] });
		// The board's reads are held while the card is made.
		expect(boardState.holds).toBe(1);
		asked[0].answer(json(403, { message: 'Viewers cannot add cards' }));
		expect(await saving).toEqual({ ok: false, failure: 'Viewers cannot add cards' });
		expect(asked.map((a) => a.what)).toEqual(['POST /api/cards']);
		expect([cardWindow.open, cardWindow.columnId]).toEqual([true, 3]);
		expect(boardState.holds).toBe(0);
	});

	it('archives a card, held while it is out, and takes it off the board and closes its window only once the server has; a refusal keeps both', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);

		const asked = heldAnswers();
		const refusing = cardWindow.archive(card.id);
		expect(boardState.holds).toBe(1);
		asked[0].answer(json(403, { message: 'Viewers cannot archive cards' }));
		expect(await refusing).toBe('Viewers cannot archive cards');
		expect([cardWindow.open, shown(boardState, card.id)?.id]).toEqual([true, card.id]);

		const archiving = cardWindow.archive(card.id);
		expect(asked.map((a) => a.what)).toEqual([`DELETE /api/cards/${card.id}`, `DELETE /api/cards/${card.id}`]);
		asked[1].answer(json(200, { success: true }));
		expect(await archiving).toBeNull();
		expect([cardWindow.open, shown(boardState, card.id)]).toEqual([false, undefined]);
		expect(boardState.holds).toBe(0);
	});

	it('opens on the board’s own copy of a card by its id, keeps it if the board loses it, and forgets it on close', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan' });
		const { boardState, cardWindow } = await boardPage(A);
		// A copy kept from earlier (a drag's, the blocked window's) is not what the window shows.
		const stale = { ...shown(boardState, card.id)!, title: 'As the drag found it' };
		cardWindow.openCard(stale);
		expect(cardWindow.card?.title).toBe('Plan');
		expect([cardWindow.open, cardWindow.cardId, cardWindow.columnId]).toEqual([true, card.id, A.cols['To Do'].id]);

		// Archived by someone else: the window keeps the card it opened on.
		expect((await api('DELETE', `/api/cards/${card.id}`, { user: owner })).status).toBe(200);
		await boardState.refreshNow();
		expect(shown(boardState, card.id)).toBeUndefined();
		expect(cardWindow.card?.title).toBe('Plan');

		cardWindow.close();
		expect([cardWindow.open, cardWindow.cardId, cardWindow.columnId, cardWindow.card]).toEqual([false, null, null, null]);
	});

	// The B2c review: the window showed the card as it opened once the board
	// lost it, and a save sent a PUT for a card no longer there.
	it('keeps the last copy of a card the board loses, says it is gone, and refuses a save with no request; a sub-board linked meanwhile stays shown', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan' });
		const sub = makeBoard({ owner, name: 'Sub' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		const typing = windowOpenedOn(asCard(cardWindow.card));
		expect(cardWindow.gone).toBe(false);

		// A board linked under the card, and the board read: the window shows it.
		expect((await api('PUT', `/api/boards/${sub.board.id}`, { user: owner, body: { parentCardId: card.id } })).status).toBe(200);
		await boardState.refreshNow();
		expect(cardWindow.card?.subBoards.map((board) => board.id)).toEqual([sub.board.id]);

		// Someone else archives the card, and the read takes it off the board.
		expect((await api('DELETE', `/api/cards/${card.id}`, { user: owner })).status).toBe(200);
		await boardState.refreshNow();
		expect(shown(boardState, card.id)).toBeUndefined();
		expect(cardWindow.gone).toBe(true);
		expect(cardWindow.card?.subBoards.map((board) => board.id)).toEqual([sub.board.id]);

		const sent = replay();
		expect(await cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card), title: 'Plan, renamed' }))).toEqual({ ok: false, failure: CARD_GONE });
		expect(sent).toEqual([]);
		expect([cardWindow.open, cardWindow.cardId]).toEqual([true, card.id]);
		expect(CARD_GONE).toBe('This card is no longer on this board.');
	});

	// The B2c review: the fields a save is compared with were taken as the
	// window was opened, and a read drawn before the window was made filled it
	// with newer ones; a later save then sent them over a third change.
	it('compares a save with the fields the window was filled with, though a read lands between opening it and making it', async () => {
		const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes' });
		const { boardState, cardWindow } = await boardPage(A);
		cardWindow.openCard(shown(boardState, card.id)!);
		// A read drawn before the window is made.
		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { description: 'Their notes' } })).status).toBe(200);
		await boardState.refreshNow();
		// The window is made, and fills its fields from the card it is handed.
		const typing = windowOpenedOn(asCard(cardWindow.card));
		expect(typing.description).toBe('Their notes');

		// A third change, read; the user changes the title alone.
		expect((await api('PUT', `/api/cards/${card.id}`, { user: owner, body: { description: 'Third notes' } })).status).toBe(200);
		await boardState.refreshNow();
		const sent = replay();
		await cardWindow.save(windowSaves({ ...typing, card: asCard(cardWindow.card), title: 'Plan, renamed' }));
		expect(sent.map((request) => request.body)).toEqual([{ title: 'Plan, renamed', boardId: A.board.id }]);
		expect(cardRow(card.id).description).toBe('Third notes');
	});

	// Card 2280, slice B5d (the B2c review's note 4): in the board page's
	// window, a field the user has not touched shows the board's value as
	// each read brings it; one touched stays as typed. The window was all
	// frozen at open: a field someone else changed showed its old value, and
	// picking that old value again sent nothing.
	describe('untouched fields follow the board; touched ones stay as typed (card 2280, slice B5d)', () => {
		/** Someone else's change to a card, as the board will read it. */
		const theirs = async (id: number, body: Record<string, unknown>) =>
			expect((await api('PUT', `/api/cards/${id}`, { user: owner, body })).status).toBe(200);

		/**
		 * The board page's window on `cardWindow`'s card: its fields as CardModal
		 * fills them (`windowOpenedOn`), and CardModal's own follow `$effect`
		 * (`followEffect`), run with them as Svelte runs it, once the window is
		 * made and again after each read of the board and each change typed
		 * (`draw`). What the user types is set on `fields`, then drawn.
		 */
		function windowOnBoard(cardWindow: CardWindow) {
			const fields: Record<string, unknown> = { ...windowOpenedOn(asCard(cardWindow.card)) };
			const effect = followEffect();
			const draw = () => {
				// No box has the focus: a focused one is held (the jsdom file's case).
				Object.assign(fields, { card: cardWindow.card, edits: cardWindow.edits, windowFields, focusedField: null });
				(new Function('scope', `with (scope) { return ${effect} }`)(fields) as () => void)();
			};
			draw();
			return { fields, draw, saves: () => windowSaves({ ...fields, card: asCard(cardWindow.card) } as unknown as typeof NEW_TASK) };
		}

		it('shows the board’s new priority where it was not touched, and a save sends nothing for it', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', priority: 'low' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);
			expect(window.fields.priority).toBe('low');

			await theirs(card.id, { priority: 'high' });
			await boardState.refreshNow();
			window.draw();
			expect(window.fields.priority).toBe('high');

			// Saved as it shows: nothing is sent, and the window closes.
			const sent = replay();
			expect(await cardWindow.save(window.saves())).toEqual({ ok: true, told: [] });
			expect(sent).toEqual([]);

			// Opened again; someone else changes the priority again; the user renames the card.
			cardWindow.openCard(shown(boardState, card.id)!);
			const again = windowOnBoard(cardWindow);
			await theirs(card.id, { priority: 'critical' });
			await boardState.refreshNow();
			again.draw();
			again.fields.title = 'Plan, renamed';
			again.draw();
			expect(again.fields.priority).toBe('critical');
			await cardWindow.save(again.saves());
			expect(sent.map((request) => request.body)).toEqual([{ title: 'Plan, renamed', boardId: A.board.id }]);
			expect([cardRow(card.id).title, cardRow(card.id).priority]).toEqual(['Plan, renamed', 'critical']);
		});

		it('sends a value picked again after someone else changed it away: it is a change from what the window shows', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', priority: 'low' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);

			await theirs(card.id, { priority: 'high' });
			await boardState.refreshNow();
			window.draw();
			expect(window.fields.priority).toBe('high');
			// The user picks low again, the value the window opened on.
			window.fields.priority = 'low';
			window.draw();

			const sent = replay();
			expect(await cardWindow.save(window.saves())).toEqual({ ok: true, told: [{ message: 'Card updated', failed: false }] });
			expect(sent.map((request) => request.body)).toEqual([{ priority: 'low', boardId: A.board.id }]);
			expect(cardRow(card.id).priority).toBe('low');
		});

		it('keeps a title the user typed when a read brings someone else’s, and follows the fields not touched', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);
			window.fields.title = 'Mine';
			window.draw();

			await theirs(card.id, { title: 'Theirs', description: 'Their notes', summary: 'Their summary' });
			await boardState.refreshNow();
			window.draw();
			expect([window.fields.title, window.fields.description, window.fields.summary]).toEqual(['Mine', 'Their notes', 'Their summary']);
			expect(cardWindow.edits.touched).toEqual(new Set(['title']));

			// Typed back to what it opened on, it is still the user's: a read does not take it.
			window.fields.title = 'Plan';
			window.draw();
			await theirs(card.id, { title: 'Theirs again' });
			await boardState.refreshNow();
			window.draw();
			expect(window.fields.title).toBe('Plan');

			// Typed back to the title it started from ('Plan'), while the board's has
			// moved on: what the window shows is the user's choice, and is sent
			// (the B5d review: it was taken as no change, and silently not saved).
			// Nothing not touched is sent.
			const sent = replay();
			expect(await cardWindow.save(window.saves())).toEqual({ ok: true, told: [{ message: 'Card updated', failed: false }] });
			expect(sent.map((request) => request.body)).toEqual([{ title: 'Plan', boardId: A.board.id }]);
			expect([cardRow(card.id).title, cardRow(card.id).description]).toEqual(['Plan', 'Their notes']);
		});

		// The B5d review: a touched field set back to the value it started from
		// was compared with that value alone, so after someone else changed it
		// the save sent nothing, and the window had shown the user's choice.
		it('sends a touched field set back to its start when someone else has changed it since: the choice shown wins', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', priority: 'medium' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);
			window.fields.priority = 'high';
			window.draw();
			window.fields.priority = 'medium';
			window.draw();
			await theirs(card.id, { priority: 'low' });
			await boardState.refreshNow();
			window.draw();
			expect(window.fields.priority).toBe('medium');

			const sent = replay();
			await cardWindow.save(window.saves());
			expect(sent.map((request) => request.body)).toEqual([{ priority: 'medium', boardId: A.board.id }]);
			expect(cardRow(card.id).priority).toBe('medium');

			// Set back to its start with the board's value unchanged: no change, nothing sent.
			cardWindow.openCard(shown(boardState, card.id)!);
			const again = windowOnBoard(cardWindow);
			again.fields.priority = 'high';
			again.draw();
			again.fields.priority = 'medium';
			again.draw();
			expect(await cardWindow.save(again.saves())).toEqual({ ok: true, told: [] });
			expect(sent).toHaveLength(1);
		});

		it('sends a typed title over a read that brought someone else’s, and nothing it did not touch', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);
			window.fields.title = 'Mine';
			window.draw();
			await theirs(card.id, { title: 'Theirs', description: 'Their notes' });
			await boardState.refreshNow();
			window.draw();
			expect([window.fields.title, window.fields.description]).toEqual(['Mine', 'Their notes']);

			const sent = replay();
			await cardWindow.save(window.saves());
			expect(sent.map((request) => request.body)).toEqual([{ title: 'Mine', boardId: A.board.id }]);
			expect([cardRow(card.id).title, cardRow(card.id).description]).toEqual(['Mine', 'Their notes']);
		});

		it('keeps the touched fields after a refused save, and still follows the untouched ones', async () => {
			const card = makeCard(A.cols['To Do'], { title: 'Plan', description: 'Old notes', priority: 'low' });
			const { boardState, cardWindow } = await boardPage(A);
			cardWindow.openCard(shown(boardState, card.id)!);
			const window = windowOnBoard(cardWindow);
			Object.assign(window.fields, { title: 'Plan, renamed', priority: 'high' });
			window.draw();
			await theirs(card.id, { description: 'Their notes' });
			await boardState.refreshNow();
			window.draw();

			const asked = heldAnswers();
			const saving = cardWindow.save(window.saves());
			// Shown on the board at once: the window, drawn, keeps what was typed.
			window.draw();
			expect(asked.map((a) => a.body)).toEqual([{ title: 'Plan, renamed', priority: 'high', boardId: A.board.id }]);
			asked[0].answer(json(403, { message: 'Viewers cannot change cards' }));
			expect(await saving).toEqual({ ok: false, failure: 'Viewers cannot change cards' });

			// The board takes its two fields back; the window, drawn, keeps them as typed.
			expect(shown(boardState, card.id)).toMatchObject({ title: 'Plan', priority: 'low' });
			window.draw();
			expect([window.fields.title, window.fields.priority, window.fields.description]).toEqual(['Plan, renamed', 'high', 'Their notes']);

			// Someone else changes the description and the title; the read follows the one not touched.
			await theirs(card.id, { description: 'Third notes', title: 'Theirs' });
			await boardState.refreshNow();
			window.draw();
			expect([window.fields.title, window.fields.priority, window.fields.description]).toEqual(['Plan, renamed', 'high', 'Third notes']);

			const sent = replay();
			expect(await cardWindow.save(window.saves())).toEqual({ ok: true, told: [{ message: 'Card updated', failed: false }] });
			expect(sent.map((request) => request.body)).toEqual([{ title: 'Plan, renamed', priority: 'high', boardId: A.board.id }]);
			expect([cardRow(card.id).title, cardRow(card.id).priority, cardRow(card.id).description]).toEqual(['Plan, renamed', 'high', 'Third notes']);
		});

		it('edits.follow: takes what the window started from on its first call, marks a field touched once it shows another value, and never brings back a touched one', () => {
			const opened = windowFields({ title: 'Plan', priority: 'low' } as CardType);
			const edits = new WindowEdits();
			expect(edits.follow({ ...opened }, opened)).toEqual({});
			expect(edits.started).toEqual(opened);

			// The board changes two fields; the user has touched neither: both brought, and started from.
			const board: WindowFields = { ...opened, title: 'Theirs', priority: 'high' };
			expect(edits.follow({ ...opened }, board)).toEqual({ title: 'Theirs', priority: 'high' });
			expect(edits.started).toEqual(board);

			// The user types a title; the board changes title and description: only the description is brought.
			const shownNow: WindowFields = { ...board, title: 'Mine' };
			expect(edits.follow(shownNow, { ...board, title: 'Theirs again', description: 'Their notes' })).toEqual({ description: 'Their notes' });
			expect(edits.touched).toEqual(new Set(['title']));
			// The title started from what the window showed when it was touched.
			expect(edits.started?.title).toBe('Theirs');

			// Typed back to that, still touched: never brought.
			expect(edits.follow({ ...board, description: 'Their notes' }, { ...board, title: 'Fourth', description: 'Their notes' })).toEqual({});
			expect(edits.touched).toEqual(new Set(['title']));
			// No card (a New Task window): nothing brought, a change still marked.
			expect(edits.follow({ ...board, description: 'Their notes', priority: 'critical' }, null)).toEqual({});
			expect(edits.touched).toEqual(new Set(['title', 'priority']));
		});

		// The B5d review: the window holds the field whose box has the focus, so a
		// read does not move the caret in it.
		it('edits.follow holds the field whose box has the focus: neither brought nor started from until it is left; the focus alone is no touch', () => {
			const opened = windowFields({ title: 'Plan', description: 'Old notes' } as CardType);
			const edits = new WindowEdits();
			expect(edits.follow({ ...opened }, opened, 'description')).toEqual({});
			const board: WindowFields = { ...opened, title: 'Theirs', description: 'Their notes' };
			expect(edits.follow({ ...opened }, board, 'description')).toEqual({ title: 'Theirs' });
			expect(edits.started?.description).toBe('Old notes');
			expect(edits.touched.size).toBe(0);
			// Left: brought on the next follow, and started from.
			expect(edits.follow({ ...opened, title: 'Theirs' }, board, null)).toEqual({ description: 'Their notes' });
			expect(edits.started?.description).toBe('Their notes');
			expect(edits.touched.size).toBe(0);
			// Typed in while it has the focus: touched, as any field.
			expect(edits.follow({ ...board, title: 'Mine' }, { ...board, title: 'Fourth' }, 'title')).toEqual({});
			expect(edits.touched).toEqual(new Set(['title']));
		});

		it('is given on the board page alone: the board page hands its window the controller’s edits, and All Tasks, All To Do and the plan page hand theirs none', () => {
			const page = readFileSync(join(process.cwd(), 'src/routes/board/[id]/+page.svelte'), 'utf8').replace(/\s+/g, ' ');
			expect(page).toContain('edits={cardWindow.edits}');
			// A new edits is a new window (the B5d review): what one window typed is
			// never taken by another's edits as what it started from.
			expect(page).toContain('{#if cardWindow.open} {#key cardWindow.edits} <CardModal card={cardWindow.card}');
			expect(page).toMatch(/milestones=\{boardState\.milestones\} \/> \{\/key\} \{\/if\}/);
			for (const file of ['src/routes/all/+page.svelte', 'src/routes/todo/+page.svelte', 'src/routes/plan/[id]/+page.svelte']) {
				const text = readFileSync(join(process.cwd(), file), 'utf8');
				const opened = text.slice(text.indexOf('<CardModal'));
				expect(opened.slice(0, opened.indexOf('/>')), file).not.toMatch(/\bedits\b/);
			}
			// A new window is a new edits: what one window started from is not another's.
			const { cardWindow } = standIn({});
			const first = cardWindow.edits;
			cardWindow.openNew(3);
			expect(cardWindow.edits).not.toBe(first);
			const second = cardWindow.edits;
			cardWindow.close();
			expect(cardWindow.edits).not.toBe(second);
		});
	});
});
