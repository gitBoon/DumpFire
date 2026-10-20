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
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, cardLabels, cards, labels, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import * as cardActions from '$lib/board/card-actions';
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
