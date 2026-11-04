/**
 * Card links (card 2680, slice 2a): `linkCard` and `unlinkCard` in
 * `src/lib/server/decisions.ts`, and the deletion entries `deleteDecision`
 * writes; the reads of both sides in `src/lib/server/decision-cards.ts`
 * (`linkedCardsFor`, `readCardDecisions`, `decisionLinksOfCardsUnchecked`);
 * and what the decision page gains (`linkedCards`, `mayLinkCards`).
 *
 * Each write is called as a route will call it, inside `writeAs` and handed
 * its `caller`, with `effects()` installed. The cases are the plan's,
 * `docs/planning/card-2680-register-records-links.md`, section 7.2, by
 * number; 112 and 113 are slice 2b's, through the routes with `api()`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import { cards, decisionCardLinks, decisions, type Board, type Card, type Column, type Decision } from '$lib/server/db/schema';
import { revisionFor } from '$lib/server/decision-authoring';
import { decisionLinksOfCardsUnchecked, linkedCardsFor, LINKS_PER_CARD, LINKS_PER_DECISION, readCardDecisions } from '$lib/server/decision-cards';
import { resultsRevisionFor } from '$lib/server/decision-results';
import { deleteDecision, linkCard, unlinkCard } from '$lib/server/decisions';
import { removeCard } from '$lib/server/cards';
import { readDecisionPage, readLinkPage } from '$lib/server/decision-view';
import { requireCard } from '$lib/server/route-guards';
import { writeAs, type ServiceOptions } from '$lib/server/write-as';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	makeBoard,
	makeCard,
	makeCardLink,
	makeDecision,
	makePerson,
	makeParticipant,
	makeUser,
	makeVersion,
	makeWebhook,
	resetDb
} from './helpers/fixtures';

const UI: ServiceOptions = { source: 'ui' };
const FUTURE = '2099-01-01 12:00:00';
const OPENED = '2026-01-01 09:00:00';
const ROOT = process.cwd();

let sent: Effects;
let dana: SessionUser;
let A: Board;
let B: Board;
let todoA: Column;
let todoB: Column;

beforeEach(() => {
	resetDb();
	sent = effects();
	dana = makeUser({ username: 'dana' });
	const a = makeBoard({ owner: makeUser({ username: 'owner-a' }), name: 'Board A' });
	const b = makeBoard({ owner: makeUser({ username: 'owner-b' }), name: 'Board B' });
	A = a.board;
	B = b.board;
	todoA = a.cols['To Do'];
	todoB = b.cols['To Do'];
	addBoardMember(A, dana, 'editor');
});

afterEach(() => sent.restore());

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Call a write as `user`, as a route calls it inside its writeAs callback. */
const as = <T>(user: SessionUser, write: (caller: SessionUser | null) => T): T => writeAs({ user } as App.Locals, write as never) as T;

/** What a call was answered with: 'passed', or the refusal's status and words. */
function outcome(run: () => unknown): 'passed' | { status: number; message: string } {
	try {
		run();
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

/** A decision as its service leaves one: a draft never opened; any other status opened, an open one closing in the future. */
function decisionOn(board: Board | null, opts: { status?: string; author?: SessionUser | null; decider?: SessionUser | null; title?: string } = {}): Decision {
	const status = opts.status ?? 'open';
	return makeDecision({
		board,
		author: opts.author ?? null,
		decider: opts.decider ?? null,
		status,
		closesAt: status === 'open' ? FUTURE : null,
		openedAt: status === 'draft' ? null : OPENED,
		...(opts.title === undefined ? {} : { title: opts.title })
	});
}

const link = (user: SessionUser, decision: Decision, card: Card) =>
	as(user, (caller) => linkCard(caller, { decisionId: decision.id, cardId: card.id, relation: 'relates' }, null, UI));
const unlink = (user: SessionUser, decision: Decision, card: Card) => as(user, (caller) => unlinkCard(caller, { decisionId: decision.id, cardId: card.id }, null, UI));
const linksOf = (decision: Decision) =>
	db.select().from(decisionCardLinks).where(eq(decisionCardLinks.decisionId, decision.id)).all();
const activity = () =>
	sqlite.prepare('SELECT board_id AS boardId, card_id AS cardId, action, detail FROM activity_log ORDER BY id').all() as {
		boardId: number;
		cardId: number | null;
		action: string;
		detail: string;
	}[];
const linkActivity = () => activity().filter((row) => row.action.startsWith('decision_card_'));
const decisionRow = (id: number) => db.select().from(decisions).where(eq(decisions.id, id)).get()!;
const deleteBoard = (board: Board) => sqlite.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
const page = (user: SessionUser, decision: Decision) => readDecisionPage(user, decision.id);

// ─── Linking and unlinking ───────────────────────────────────────────────────

describe('linkCard', () => {
	it('links a card for an editor of the decision’s board who can edit the card’s: one row, one entry on the card’s board naming no decision, nothing else (76)', async () => {
		addBoardMember(B, dana, 'editor');
		makeWebhook(B);
		makeWebhook(A);
		const decision = decisionOn(A, { title: 'A secret decision' });
		const card = makeCard(todoB);
		sent.clear();

		expect(link(dana, decision, card)).toEqual({ outcome: 'linked' });
		await sent.settle();

		expect(linksOf(decision)).toEqual([{ decisionId: decision.id, cardId: card.id, relation: 'relates', createdBy: dana.id, createdAt: expect.any(String) }]);
		expect(linkActivity()).toEqual([{ boardId: B.id, cardId: card.id, action: 'decision_card_linked', detail: 'a decision' }]);
		expect(JSON.stringify(activity())).not.toContain('A secret decision');
		expect(sent.events).toEqual([]);
		expect(sent.emails).toEqual([]);
		expect(sent.webhooks).toEqual([]);
	});

	it('leaves the decision’s updated_at, revision and results revision unchanged (77)', () => {
		const decision = decisionOn(A);
		makeVersion(decision);
		const before = { updatedAt: decisionRow(decision.id).updatedAt, revision: revisionFor(decision.id), results: resultsRevisionFor(decision.id) };
		const card = makeCard(todoA);

		link(dana, decision, card);
		expect({ updatedAt: decisionRow(decision.id).updatedAt, revision: revisionFor(decision.id), results: resultsRevisionFor(decision.id) }).toEqual(before);
		unlink(dana, decision, card);
		expect({ updatedAt: decisionRow(decision.id).updatedAt, revision: revisionFor(decision.id), results: resultsRevisionFor(decision.id) }).toEqual(before);
	});

	it('answers a link again with the same relation unchanged, writing nothing (78)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		link(dana, decision, card);
		const rows = linksOf(decision);
		const entries = activity().length;

		expect(link(dana, decision, card)).toEqual({ outcome: 'unchanged' });
		expect(linksOf(decision)).toEqual(rows);
		expect(activity()).toHaveLength(entries);
	});

	it('changes a stored waits link PUT as relates: the relation updated, one entry, relation_changed, no second row (79)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		makeCardLink(decision, card, { relation: 'waits' });

		expect(link(dana, decision, card)).toEqual({ outcome: 'relation_changed' });
		expect(linksOf(decision).map((row) => row.relation)).toEqual(['relates']);
		expect(linkActivity()).toEqual([{ boardId: A.id, cardId: card.id, action: 'decision_card_linked', detail: 'a decision' }]);
	});

	it('answers 404 to a board editor for a draft (80)', () => {
		const draft = decisionOn(A, { status: 'draft' });
		expect(outcome(() => link(dana, draft, makeCard(todoA)))).toEqual({ status: 404, message: 'Decision not found' });
	});

	it('answers 409 to its author, an editor of the board, for a draft (81)', () => {
		const draft = decisionOn(A, { status: 'draft', author: dana });
		expect(outcome(() => link(dana, draft, makeCard(todoA)))).toEqual({ status: 409, message: 'This decision is a draft: a card cannot be linked to it' });
	});

	it('answers 409 for a withdrawn decision (82)', () => {
		const withdrawn = decisionOn(A, { status: 'withdrawn' });
		expect(outcome(() => link(dana, withdrawn, makeCard(todoA)))).toEqual({ status: 409, message: 'This decision is withdrawn: a card cannot be linked to it' });
	});

	it('answers 403 to a board reader of the decision’s board (83)', () => {
		const reader = makeUser();
		addBoardMember(A, reader, 'viewer');
		addBoardMember(B, reader, 'editor');
		expect(outcome(() => link(reader, decisionOn(A), makeCard(todoB)))).toEqual({ status: 403, message: 'You cannot link a card to this decision' });
	});

	it('answers 403 to an author who lost board edit (84)', () => {
		const author = makeUser();
		addBoardMember(A, author, 'viewer');
		addBoardMember(B, author, 'editor');
		expect(outcome(() => link(author, decisionOn(A, { author }), makeCard(todoB)))).toEqual({ status: 403, message: 'You cannot link a card to this decision' });
	});

	it('answers 403 to its author for a decision whose board was deleted (85)', () => {
		const gone = makeBoard({ owner: makeUser() }).board;
		const decision = decisionOn(gone, { author: dana, decider: dana });
		deleteBoard(gone);
		expect(outcome(() => link(dana, decision, makeCard(todoA)))).toEqual({ status: 403, message: 'You cannot link a card to this decision' });
	});

	it('…links one for an administrator (86)', () => {
		const admin = makeUser({ role: 'admin' });
		const gone = makeBoard({ owner: makeUser() }).board;
		const decision = decisionOn(gone);
		deleteBoard(gone);
		expect(link(admin, decision, makeCard(todoA))).toEqual({ outcome: 'linked' });
	});

	it('answers 403 for a card on a board the caller can only view (87)', () => {
		addBoardMember(B, dana, 'viewer');
		expect(outcome(() => link(dana, decisionOn(A), makeCard(todoB)))).toEqual({ status: 403, message: 'No edit access to this board' });
	});

	it('answers 404 for a card that is not there (88)', () => {
		const decision = decisionOn(A);
		expect(outcome(() => as(dana, (caller) => linkCard(caller, { decisionId: decision.id, cardId: 999_999, relation: 'relates' }, null, UI)))).toEqual({
			status: 404,
			message: 'Card not found'
		});
	});

	it('answers 409 for an archived card (89)', () => {
		const card = makeCard(todoA, { archivedAt: OPENED });
		expect(outcome(() => link(dana, decisionOn(A), card))).toEqual({ status: 409, message: 'This card is archived: it cannot be linked to a decision' });
	});

	it('answers 409, not the idempotent 200, for an existing link on an archived card linked again (90)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		link(dana, decision, card);
		db.update(cards).set({ archivedAt: OPENED }).where(eq(cards.id, card.id)).run();

		expect(outcome(() => link(dana, decision, card))).toEqual({ status: 409, message: 'This card is archived: it cannot be linked to a decision' });
	});

	it('answers 409 for the 101st link on a decision (91)', () => {
		const decision = decisionOn(A);
		for (let i = 0; i < LINKS_PER_DECISION; i++) makeCardLink(decision, makeCard(todoA));
		expect(outcome(() => link(dana, decision, makeCard(todoA)))).toEqual({ status: 409, message: 'This decision is linked to 100 cards, the most it may be' });
		expect(linksOf(decision)).toHaveLength(100);
	});

	it('answers 409 for the 21st link on a card, in words that state no count (92; code review S3)', () => {
		const card = makeCard(todoA);
		// Some of the card's links are to decisions Dana cannot view: the refusal must not say how many links there are.
		for (let i = 0; i < LINKS_PER_CARD; i++) makeCardLink(decisionOn(i % 2 === 0 ? A : B), card);
		const refused = outcome(() => link(dana, decisionOn(A), card));
		expect(refused).toEqual({ status: 409, message: 'This card has reached its limit of linked decisions' });
		expect(refused !== 'passed' && refused.message).not.toMatch(/\d/);
	});

	it('answers 400 for a relation outside CARD_LINK_RELATIONS, writing nothing (code review S-tests)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		const unknown = () =>
			as(dana, (caller) => linkCard(caller, { decisionId: decision.id, cardId: card.id, relation: 'blocks' as never }, null, UI));
		expect(outcome(unknown)).toEqual({ status: 400, message: 'relation must be one of: relates' });
		expect(linksOf(decision)).toEqual([]);
		expect(linkActivity()).toEqual([]);
	});
});

describe('unlinkCard', () => {
	it('removes the row and writes decision_card_unlinked on the card’s board (93)', () => {
		addBoardMember(B, dana, 'editor');
		const decision = decisionOn(A);
		const card = makeCard(todoB);
		makeCardLink(decision, card);

		unlink(dana, decision, card);
		expect(linksOf(decision)).toEqual([]);
		expect(linkActivity()).toEqual([{ boardId: B.id, cardId: card.id, action: 'decision_card_unlinked', detail: 'a decision' }]);
	});

	it('answers 404 for a link that is not there (94)', () => {
		expect(outcome(() => unlink(dana, decisionOn(A), makeCard(todoA)))).toEqual({ status: 404, message: 'Link not found' });
	});

	it('answers 403 to a board reader of the decision’s board (95)', () => {
		const reader = makeUser();
		addBoardMember(A, reader, 'viewer');
		addBoardMember(B, reader, 'editor');
		const decision = decisionOn(A);
		const card = makeCard(todoB);
		makeCardLink(decision, card);
		expect(outcome(() => unlink(reader, decision, card))).toEqual({ status: 403, message: 'You cannot unlink a card from this decision' });
	});

	it('answers 403 to a viewer of the card’s board (96)', () => {
		addBoardMember(B, dana, 'viewer');
		const decision = decisionOn(A);
		const card = makeCard(todoB);
		makeCardLink(decision, card);
		expect(outcome(() => unlink(dana, decision, card))).toEqual({ status: 403, message: 'No edit access to this board' });
	});

	it('answers 403 to the author once the decision’s board is deleted (97)', () => {
		const gone = makeBoard({ owner: makeUser() }).board;
		const decision = decisionOn(gone, { author: dana });
		const card = makeCard(todoA);
		makeCardLink(decision, card);
		deleteBoard(gone);
		expect(outcome(() => unlink(dana, decision, card))).toEqual({ status: 403, message: 'You cannot unlink a card from this decision' });
		expect(linksOf(decision)).toHaveLength(1);
	});

	it('unlinks an archived card at the service (code review S-tests)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA, { archivedAt: OPENED });
		makeCardLink(decision, card);
		unlink(dana, decision, card);
		expect(linksOf(decision)).toEqual([]);
		expect(linkActivity()).toEqual([{ boardId: A.id, cardId: card.id, action: 'decision_card_unlinked', detail: 'a decision' }]);
	});

	it('unlinks a card from a withdrawn decision at the service (code review S-tests)', () => {
		const decision = decisionOn(A, { status: 'withdrawn' });
		const card = makeCard(todoA);
		makeCardLink(decision, card);
		unlink(dana, decision, card);
		expect(linksOf(decision)).toEqual([]);
	});

	it('refuses to unlink from a draft at the service, with the link left (code review S-tests)', () => {
		const draft = decisionOn(A, { status: 'draft', author: dana });
		const card = makeCard(todoA);
		makeCardLink(draft, card);
		expect(outcome(() => unlink(dana, draft, card))).toEqual({ status: 409, message: 'This decision is a draft: a card cannot be unlinked from it' });
		expect(linksOf(draft)).toHaveLength(1);
		expect(linkActivity()).toEqual([]);
	});
});

// ─── Deletion, archiving, moves ──────────────────────────────────────────────

describe('what happens to a link', () => {
	it('goes with a deleted card, with no entry beyond the card’s own (98)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		makeCardLink(decision, card);

		as(dana, (caller) => removeCard(caller, { cardId: card.id }, null, { source: 'ui', permanent: true }));
		expect(linksOf(decision)).toEqual([]);
		expect(linkActivity()).toEqual([]);
	});

	it('goes with a deleted withdrawn decision, leaving one entry on the linked card’s other board (99)', () => {
		const author = makeUser({ username: 'author' });
		addBoardMember(A, author, 'editor');
		const decision = decisionOn(A, { status: 'withdrawn', author, title: 'A withdrawn decision' });
		const card = makeCard(todoB);
		makeCardLink(decision, card);

		as(author, (caller) => deleteDecision(caller, { decisionId: decision.id }, null, UI));
		expect(db.select().from(decisionCardLinks).all()).toEqual([]);
		expect(linkActivity()).toEqual([{ boardId: B.id, cardId: card.id, action: 'decision_card_link_deleted', detail: 'a linked decision was deleted' }]);
		expect(activity().filter((row) => row.boardId === B.id).map((row) => row.detail).join()).not.toContain('A withdrawn decision');
	});

	it('stays when the decision’s board is deleted (100)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoB);
		makeCardLink(decision, card);
		deleteBoard(A);
		expect(linksOf(decision)).toHaveLength(1);
	});

	it('is no longer listed to a viewer once its card moves to a board they cannot open (101)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA);
		makeCardLink(decision, card);
		expect(page(dana, decision).linkedCards!.map((c) => c.id)).toEqual([card.id]);

		db.update(cards).set({ columnId: todoB.id }).where(eq(cards.id, card.id)).run();
		expect(page(dana, decision).linkedCards).toEqual([]);
		expect(linksOf(decision)).toHaveLength(1);
	});
});

// ─── The decision page's side ────────────────────────────────────────────────

describe('the decision page’s linked cards', () => {
	it('lists linked cards only on boards the viewer can open, with no count of the rest (102)', () => {
		const decision = decisionOn(A);
		const seen = makeCard(todoA, { title: 'On A' });
		makeCardLink(decision, seen);
		makeCardLink(decision, makeCard(todoB, { title: 'Hidden on B' }));

		const read = page(dana, decision);
		expect(read.linkedCards).toEqual([{ id: seen.id, title: 'On A', boardId: A.id, boardName: 'Board A', archived: false }]);
		expect(JSON.stringify(read)).not.toContain('Hidden on B');
		expect(JSON.stringify(read)).not.toContain('Board B');
	});

	it('…marking archived cards (103)', () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA, { archivedAt: OPENED });
		makeCardLink(decision, card);
		expect(page(dana, decision).linkedCards).toEqual([expect.objectContaining({ id: card.id, archived: true })]);
	});

	it('gives mayLinkCards true to a board editor and false to a board reader (104)', () => {
		const reader = makeUser();
		addBoardMember(A, reader, 'viewer');
		const decision = decisionOn(A);
		expect(page(dana, decision).mayLinkCards).toBe(true);
		expect(page(reader, decision).mayLinkCards).toBe(false);
	});

	it('…false on a withdrawn decision (105)', () => {
		expect(page(dana, decisionOn(A, { status: 'withdrawn' })).mayLinkCards).toBe(false);
		expect(page(dana, decisionOn(A, { status: 'ruled' })).mayLinkCards).toBe(true);
	});

	it('…false at the cap (106)', () => {
		const decision = decisionOn(A);
		for (let i = 0; i < LINKS_PER_DECISION - 1; i++) makeCardLink(decision, makeCard(todoA));
		expect(page(dana, decision).mayLinkCards).toBe(true);
		makeCardLink(decision, makeCard(todoA));
		expect(page(dana, decision).mayLinkCards).toBe(false);
	});

	it('gives the page by personal link no linkedCards key (107)', () => {
		const decision = decisionOn(A);
		makeVersion(decision);
		makeCardLink(decision, makeCard(todoA, { title: 'Linked card' }));
		makeParticipant(decision, { person: makePerson(), token: 'token-link' });

		const read = readLinkPage('token-link', null);
		expect(read).not.toBeNull();
		expect(read).not.toHaveProperty('linkedCards');
		expect(read).not.toHaveProperty('mayLinkCards');
		expect(read).not.toHaveProperty('mayUnlinkCards');
		expect(JSON.stringify(read)).not.toContain('Linked card');
	});

	it('gives mayUnlinkCards where unlinkCard would let the caller in: at the cap and on a withdrawn decision too, never to a board reader (slice 3b, 137)', () => {
		const reader = makeUser();
		addBoardMember(A, reader, 'viewer');
		const full = decisionOn(A);
		for (let i = 0; i < LINKS_PER_DECISION; i++) makeCardLink(full, makeCard(todoA));
		expect(page(dana, full)).toMatchObject({ mayLinkCards: false, mayUnlinkCards: true });
		expect(page(dana, decisionOn(A, { status: 'withdrawn' }))).toMatchObject({ mayLinkCards: false, mayUnlinkCards: true });
		expect(page(reader, decisionOn(A)).mayUnlinkCards).toBe(false);
		expect(page(dana, decisionOn(A, { status: 'draft', author: dana })).mayUnlinkCards).toBe(false);
	});
});

// ─── The card window's side ──────────────────────────────────────────────────

describe('the card’s linked decisions', () => {
	it('lists only decisions the viewer may view, withdrawn ones with their status, closesAt null once ruled (108)', () => {
		const card = makeCard(todoA);
		const open = decisionOn(A, { title: 'Open one' });
		const withdrawn = decisionOn(A, { status: 'withdrawn' });
		const ruled = makeDecision({ board: A, status: 'ruled', closesAt: OPENED, openedAt: OPENED });
		const hidden = decisionOn(B, { title: 'Hidden on B' });
		for (const decision of [open, withdrawn, ruled, hidden]) makeCardLink(decision, card);

		const read = readCardDecisions(dana, card.id, { source: 'ui' });
		expect(read).toEqual([
			{ id: ruled.id, title: ruled.title, shownStatus: 'ruled', closesAt: null, relation: 'relates' },
			{ id: withdrawn.id, title: withdrawn.title, shownStatus: 'withdrawn', closesAt: null, relation: 'relates' },
			{ id: open.id, title: 'Open one', shownStatus: 'open', closesAt: FUTURE, relation: 'relates' }
		]);
		expect(JSON.stringify(read)).not.toContain('Hidden on B');
	});

	it('refuses a card on a board the caller cannot open as requireCard refuses (109)', () => {
		const card = makeCard(todoB);
		makeCardLink(decisionOn(B), card);
		const refused = outcome(() => readCardDecisions(dana, card.id, { source: 'ui' }));
		expect(refused).not.toBe('passed');
		expect(refused).toEqual(outcome(() => requireCard(dana, card.id, 'view')));
		expect(outcome(() => readCardDecisions(dana, 999_999, { source: 'ui' }))).toEqual({ status: 404, message: 'Card not found' });
	});

	it('answers decisionLinksOfCardsUnchecked with every link of the cards asked past 500 ids, through listedStatusOf (110)', () => {
		const ruled = makeDecision({ board: A, status: 'ruled', closesAt: OPENED, openedAt: OPENED });
		const open = decisionOn(B);
		const made = Array.from({ length: 600 }, (_, i) => {
			const card = makeCard(i % 2 === 0 ? todoA : todoB);
			makeCardLink(i % 2 === 0 ? ruled : open, card, { relation: i === 0 ? 'waits' : 'relates' });
			return card;
		});

		const read = decisionLinksOfCardsUnchecked([...made.map((card) => card.id), 999_999]);
		expect(read).toHaveLength(600);
		expect(read[0]).toEqual({ cardId: made[0].id, decisionId: ruled.id, title: ruled.title, relation: 'relates', shownStatus: 'ruled', closesAt: null });
		expect(read.find((row) => row.cardId === made[1].id)).toEqual({
			cardId: made[1].id,
			decisionId: open.id,
			title: open.title,
			relation: 'relates',
			shownStatus: 'open',
			closesAt: FUTURE
		});
	});

	it('is named from decision-cards.ts alone, in src: no call, import or alias anywhere else (111; code review S4)', () => {
		const files = (readdirSync(join(ROOT, 'src'), { recursive: true }) as string[])
			.map((file) => file.split('\\').join('/'))
			.filter((file) => /\.(ts|js|svelte)$/.test(file));
		// Any mention at all, not only a call: `import { decisionLinksOfCardsUnchecked as links }` is caught here too.
		const mentions = /\bdecisionLinksOfCardsUnchecked\b/;
		const callers = files.filter((file) => mentions.test(readFileSync(join(ROOT, 'src', file), 'utf8')));
		expect(callers).toEqual(['lib/server/decision-cards.ts']);
		// The match catches an import under another name, which a call pattern would miss.
		expect(mentions.test("import { decisionLinksOfCardsUnchecked as links } from '$lib/server/decision-cards';\nlinks([1]);")).toBe(true);
		expect(/\bdecisionLinksOfCardsUnchecked\s*\(/.test("import { decisionLinksOfCardsUnchecked as links } from '$lib/server/decision-cards';\nlinks([1]);")).toBe(false);
		// Something was read: linkedCardsFor is found the same way, in the page's read too, and in card 2682's v1 twin of the routes.
		expect(files.filter((file) => /\blinkedCardsFor\s*\(/.test(readFileSync(join(ROOT, 'src', file), 'utf8'))).sort()).toEqual([
			'lib/server/decision-cards.ts',
			'lib/server/decision-view.ts',
			'routes/api/decisions/[id]/cards/[cardId]/+server.ts',
			'routes/api/v1/decisions/[decisionId]/cards/[cardId]/+server.ts'
		]);
	});
});

// ─── The routes (slice 2b) ───────────────────────────────────────────────────

describe('the link routes', () => {
	it('answers PUT /api/decisions/:id/cards/:cardId with the outcome and the linked cards as linkedCardsFor gives them (112)', async () => {
		const decision = decisionOn(A);
		const card = makeCard(todoA, { title: 'Linked by the route' });
		makeCardLink(decision, makeCard(todoB, { title: 'Hidden on B' }));

		const res = await api('PUT', `/api/decisions/${decision.id}/cards/${card.id}`, { user: dana });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ outcome: 'linked', linkedCards: [{ id: card.id, title: 'Linked by the route', boardId: A.id, boardName: 'Board A', archived: false }] });
		expect(res.body).toEqual({ outcome: 'linked', linkedCards: linkedCardsFor(dana, decision) });
		expect(linksOf(decision)).toHaveLength(2);

		const again = await api('PUT', `/api/decisions/${decision.id}/cards/${card.id}`, { user: dana });
		expect(again.body).toEqual({ outcome: 'unchanged', linkedCards: linkedCardsFor(dana, decision) });
	});

	it('answers DELETE /api/decisions/:id/cards/:cardId with the linked cards left (113)', async () => {
		const decision = decisionOn(A);
		const kept = makeCard(todoA, { title: 'Kept' });
		const gone = makeCard(todoA, { title: 'Unlinked' });
		makeCardLink(decision, kept);
		makeCardLink(decision, gone);

		const res = await api('DELETE', `/api/decisions/${decision.id}/cards/${gone.id}`, { user: dana });
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ linkedCards: [{ id: kept.id, title: 'Kept', boardId: A.id, boardName: 'Board A', archived: false }] });
		expect(linksOf(decision).map((row) => row.cardId)).toEqual([kept.id]);
		expect((await api('DELETE', `/api/decisions/${decision.id}/cards/${gone.id}`, { user: dana })).status).toBe(404);
	});
});
