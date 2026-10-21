/**
 * A new card made with its subtasks, labels, assignees and sub-boards in one
 * request (card 2296): `POST /api/cards` with `subtasks`, `labelIds`,
 * `assigneeIds` and `subBoards`.
 *
 * The board's New Task window made the card, then sent each subtask, each
 * label of its template, each person chosen and each sub-board in a request
 * of its own, so a refusal or a lost answer part way left half a card. The
 * route now writes them in the card's transaction, each through the service
 * its own route calls (`createSubtask`, `toggleCardLabel`, `assignToCard`,
 * `createBoard`), with that route's options, and any refusal refuses the
 * whole request, in the part's words with its entry named.
 *
 *   - What one request writes, records and sends is what the separate
 *     requests did, entry for entry and effect for effect, in the same order:
 *     the same scene is run both ways on a fresh database and compared.
 *   - Each refusal leaves the database as it was and sends nothing.
 *   - v1's create ignores the four lists (the plan's ruling 2296-2).
 *
 * The plan is `docs/planning/cards-2296-2388.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { activityLog, boards, cardAssignees, cardLabels, cards, subtasks } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { effects, type RecordedEffect } from './helpers/effects';
import { addBoardMember, makeBoard, makeCard, makeLabel, makeSmtp, makeSubBoard, makeUser, makeWebhook, resetDb, type BoardFixture } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

type Scene = {
	owner: SessionUser;
	helper: SessionUser;
	outsider: SessionUser;
	A: BoardFixture;
	bug: { id: number };
	urgent: { id: number };
	theirs: { id: number };
};

/** A board with two labels, an editor beside its owner, a webhook and mail set up; another board, and someone on neither. */
function scene(): Scene {
	resetDb();
	const owner = makeUser({ username: 'owner' });
	const helper = makeUser({ username: 'helper' });
	const outsider = makeUser({ username: 'outsider' });
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, helper, 'editor');
	const bug = makeLabel(A.board, 'Bug');
	const urgent = makeLabel(A.board, 'Urgent');
	const theirs = makeLabel(makeBoard({ owner: outsider, name: 'B' }).board, 'Theirs');
	makeWebhook(A.board);
	makeSmtp();
	return { owner, helper, outsider, A, bug, urgent, theirs };
}

/** What each test's requests send, recorded and never sent: every test makes a card on a board with a webhook and mail set up. */
let sent: ReturnType<typeof effects>;
beforeEach(() => {
	sent = effects();
});
afterEach(() => {
	sent.restore();
});

/** Every entry, as stored, in the order written. */
const entries = () =>
	db
		.select({ boardId: activityLog.boardId, cardId: activityLog.cardId, userId: activityLog.userId, action: activityLog.action, detail: activityLog.detail, source: activityLog.source })
		.from(activityLog)
		.orderBy(activityLog.id)
		.all();

/** An effect as it can be compared across two runs: a webhook by its event and data (its timestamp differs), an event, a mail by its address and subject. */
function shown(effect: RecordedEffect): string {
	if (effect.kind === 'webhook') return `webhook ${effect.event} ${JSON.stringify(effect.body?.data)}`;
	if (effect.kind === 'email') return `email to ${effect.to}: ${effect.subject}`;
	return `event ${effect.event} ${JSON.stringify(effect.data)} on board ${effect.boardId}`;
}

/** What the window gathered, in the scene: two subtasks, two labels, two people (the caller among them) and a sub-board. */
const gathered = (s: Scene) => ({
	subtasks: [{ title: 'One' }, { title: 'Two', description: 'Notes', priority: 'high', colorTag: '#ef4444', dueDate: '2026-11-02' }],
	labelIds: [s.urgent.id, s.bug.id],
	assigneeIds: [s.helper.id, s.owner.id],
	subBoards: [{ name: 'Plans' }]
});

/** The card's own fields, as the window sends them. */
const fields = (s: Scene, title = 'New') => ({ columnId: s.A.cols['To Do'].id, position: 0, boardId: s.A.board.id, title, description: '', priority: 'medium', categoryId: null, dueDate: null });

/** Everything about the scene's cards a run left: the cards, their subtasks, labels, assignees and sub-boards. */
function written() {
	return {
		cards: db.select({ id: cards.id, title: cards.title, columnId: cards.columnId }).from(cards).all(),
		subtasks: db
			.select({ cardId: subtasks.cardId, title: subtasks.title, description: subtasks.description, priority: subtasks.priority, colorTag: subtasks.colorTag, dueDate: subtasks.dueDate, position: subtasks.position })
			.from(subtasks)
			.orderBy(subtasks.id)
			.all(),
		labels: db.select().from(cardLabels).all(),
		assignees: db.select().from(cardAssignees).all(),
		subBoards: db.select({ id: boards.id, name: boards.name, parentCardId: boards.parentCardId, emoji: boards.emoji }).from(boards).where(eq(boards.name, 'Plans')).all()
	};
}

describe('POST /api/cards makes a new card with its subtasks, labels, assignees and sub-boards (card 2296)', () => {
	it('writes each part with the card, in the order sent, the subtasks with their fields', async () => {
		const s = scene();
		const res = await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s), ...gathered(s) } });

		expect(res.status).toBe(201);
		const cardId = (res.body as { id: number }).id;
		const made = written();
		expect(made.cards).toEqual([{ id: cardId, title: 'New', columnId: s.A.cols['To Do'].id }]);
		expect(made.subtasks).toEqual([
			{ cardId, title: 'One', description: '', priority: 'medium', colorTag: '', dueDate: null, position: expect.any(Number) },
			{ cardId, title: 'Two', description: 'Notes', priority: 'high', colorTag: '#ef4444', dueDate: '2026-11-02', position: expect.any(Number) }
		]);
		expect(made.subtasks[0].position).toBeLessThan(made.subtasks[1].position);
		expect(made.labels.map((row) => row.labelId).sort()).toEqual([s.bug.id, s.urgent.id].sort());
		expect(made.assignees).toEqual([
			{ cardId, userId: s.helper.id },
			{ cardId, userId: s.owner.id }
		]);
		expect(made.subBoards).toEqual([{ id: expect.any(Number), name: 'Plans', parentCardId: cardId, emoji: '📋' }]);
	});

	it('records, tells and mails exactly what the separate requests did, in the same order, and nobody about assigning themselves (card 2286)', async () => {
		// Before: the card, then each part in a request of its own, as the window sent them.
		let s = scene();
		const first = await api('POST', '/api/cards', { user: s.owner, body: fields(s) });
		expect(first.status).toBe(201);
		const cardId = (first.body as { id: number }).id;
		const parts = gathered(s);
		for (const subtask of parts.subtasks) {
			expect((await api('POST', '/api/subtasks', { user: s.owner, body: { cardId, ...subtask, completed: false, boardId: s.A.board.id } })).status).toBe(201);
		}
		for (const labelId of parts.labelIds) {
			expect((await api('PUT', '/api/labels', { user: s.owner, body: { cardId, labelId, boardId: s.A.board.id } })).status).toBe(200);
		}
		for (const userId of parts.assigneeIds) {
			expect((await api('POST', `/api/cards/${cardId}/assignees`, { user: s.owner, body: { userId } })).status).toBeLessThan(300);
		}
		for (const subBoard of parts.subBoards) {
			expect((await api('POST', '/api/boards', { user: s.owner, body: { ...subBoard, parentCardId: cardId } })).status).toBe(201);
		}
		await sent.settle();
		const before = { entries: entries(), effects: sent.all.map(shown), written: written() };
		expect(sent.duringTransaction).toEqual([]);

		// After: one request, on the same scene made afresh.
		s = scene();
		sent.clear();
		const one = await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s), ...gathered(s) } });
		expect(one.status).toBe(201);
		expect((one.body as { id: number }).id).toBe(cardId);
		await sent.settle();
		const after = { entries: entries(), effects: sent.all.map(shown), written: written() };
		expect(sent.duringTransaction).toEqual([]);

		expect(after).toEqual(before);
		// What that is: the card, two subtasks, two labels, two people, a board.
		expect(after.entries.map((entry) => entry.action)).toEqual(['card_created', 'subtask_created', 'subtask_created', 'assignee_added', 'assignee_added', 'board_created']);
		// The helper is mailed; the owner, who assigned themselves, is not.
		expect(after.effects.filter((effect) => effect.startsWith('email'))).toEqual([expect.stringMatching(/^email to helper@example\.test: /)]);
		expect(after.effects.filter((effect) => effect.startsWith('webhook'))).toEqual([expect.stringMatching(/^webhook card\.created /)]);
	});

	it('takes a label or a person sent twice once: a label toggled twice would come off again', async () => {
		const s = scene();
		const res = await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s), labelIds: [s.bug.id, s.bug.id], assigneeIds: [s.helper.id, s.helper.id] } });

		expect(res.status).toBe(201);
		expect(written().labels).toEqual([{ cardId: (res.body as { id: number }).id, labelId: s.bug.id }]);
		expect(written().assignees).toEqual([{ cardId: (res.body as { id: number }).id, userId: s.helper.id }]);
		expect(entries().filter((entry) => entry.action === 'assignee_added')).toHaveLength(1);
	});

	it('makes a plain card as before when no list is sent, or each is empty', async () => {
		const s = scene();
		expect((await api('POST', '/api/cards', { user: s.owner, body: fields(s, 'Plain') })).status).toBe(201);
		expect((await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s, 'Empty lists'), subtasks: [], labelIds: [], assigneeIds: [], subBoards: [] } })).status).toBe(201);
		expect(written().cards.map((card) => card.title)).toEqual(['Plain', 'Empty lists']);
		expect(entries().map((entry) => entry.action)).toEqual(['card_created', 'card_created']);
	});
});

describe('POST /api/cards refuses the whole card when any part is refused, in the part’s words (card 2296)', () => {
	type Case = { name: string; body: (s: Scene) => Record<string, unknown>; status: number; message: string | ((s: Scene) => string) };
	const many = (n: number, entry: unknown) => Array.from({ length: n }, () => entry);
	const CASES: Case[] = [
		{ name: 'a subtask with no title', body: () => ({ subtasks: [{ title: 'Fine' }, { title: '  ' }] }), status: 400, message: 'subtasks[1]: title is required' },
		{ name: 'a subtask title too long', body: () => ({ subtasks: [{ title: 'x'.repeat(501) }] }), status: 400, message: 'subtasks[0]: title must be at most 500 characters' },
		{ name: 'a subtask priority not one of the four', body: () => ({ subtasks: [{ title: 'One', priority: 'urgent' }] }), status: 400, message: 'subtasks[0]: priority must be one of: low, medium, high, critical' },
		{ name: 'a subtask that is no object', body: () => ({ subtasks: ['One'] }), status: 400, message: 'subtasks[0] must be an object' },
		{ name: 'a label not found', body: (s) => ({ labelIds: [s.bug.id, 999999] }), status: 404, message: 'labelIds[1]: Label not found' },
		{ name: 'a label of a board the caller cannot open', body: (s) => ({ labelIds: [s.theirs.id] }), status: 403, message: (s) => `labelIds[0]: ${theirsRefusal(s)}` },
		{ name: 'a label id that is no id', body: () => ({ labelIds: ['bug'] }), status: 400, message: 'labelIds[0] must be an id' },
		{ name: 'someone who cannot open the board', body: (s) => ({ assigneeIds: [s.helper.id, s.outsider.id] }), status: 400, message: 'assigneeIds[1]: User does not have access to this board' },
		{ name: 'someone who is not there', body: () => ({ assigneeIds: [999999] }), status: 404, message: 'assigneeIds[0]: User not found' },
		// Named by where it was sent, not by where it is once the repeat is taken out (the review).
		{ name: 'a label not found after one sent twice', body: (s) => ({ labelIds: [s.bug.id, s.bug.id, 999999] }), status: 404, message: 'labelIds[2]: Label not found' },
		{ name: 'someone not there after someone sent twice', body: (s) => ({ assigneeIds: [s.helper.id, s.helper.id, 999999] }), status: 404, message: 'assigneeIds[2]: User not found' },
		{ name: 'a sub-board with no name', body: () => ({ subBoards: [{ name: '' }] }), status: 400, message: 'subBoards[0]: name is required' },
		{ name: 'a sub-board name too long', body: () => ({ subBoards: [{ name: 'Plans' }, { name: 'x'.repeat(201) }] }), status: 400, message: 'subBoards[1]: name must be at most 200 characters' },
		{ name: 'a list of 101', body: () => ({ subtasks: many(101, { title: 'One' }) }), status: 400, message: 'subtasks must have at most 100 entries' },
		{ name: 'a list that is no list', body: () => ({ assigneeIds: 3 }), status: 400, message: 'assigneeIds must be a list' }
	];

	/** What the label route says of a label on a board the caller cannot open: whatever `requireBoard` says, read from that route. */
	let theirsWords = '';
	const theirsRefusal = (_s: Scene) => theirsWords;

	it.each(CASES)('$name: nothing written, nothing sent', async ({ body, status, message }) => {
		const s = scene();
		if (!theirsWords) {
			// The separate route's own words, which the part's must be.
			const card = makeCard(s.A.cols['To Do']);
			const alone = await api('PUT', '/api/labels', { user: s.owner, body: { cardId: card.id, labelId: s.theirs.id } });
			theirsWords = (alone.body as { message: string }).message;
			expect(alone.status).toBe(403);
			db.delete(cards).where(eq(cards.id, card.id)).run();
		}
		// A subtask, a label, a person and a sub-board that would each be written, before the part refused.
		const sound = { subtasks: [{ title: 'Kept?' }], labelIds: [s.urgent.id], assigneeIds: [s.helper.id], subBoards: [{ name: 'Kept?' }] };
		const snapshot = snapshotDb();
		sent.clear();
		const res = await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s), ...sound, ...body(s) } });
		await sent.settle();

		expect(res.status).toBe(status);
		expect((res.body as { message: string }).message).toBe(typeof message === 'function' ? message(s) : message);
		expectUnchanged(snapshot, 'after the refusal');
		expect(sent.all).toEqual([]);
	});

	it('a sub-board under a card on a board as deep as sub-boards may be: 409 in createBoard’s words, and no card', async () => {
		const s = scene();
		// A chain of 20 sub-boards below A: the last is at the limit.
		let deepest = makeBoard({ owner: s.owner, name: 'Level 0' });
		let card = makeCard(deepest.cols['To Do']);
		for (let level = 1; level <= 20; level++) {
			deepest = makeSubBoard(card, { owner: s.owner, name: `Level ${level}` });
			card = makeCard(deepest.cols['To Do']);
		}
		const snapshot = snapshotDb();
		const res = await api('POST', '/api/cards', {
			user: s.owner,
			body: { columnId: deepest.cols['To Do'].id, title: 'Too deep', subtasks: [{ title: 'One' }], subBoards: [{ name: 'Deeper' }] }
		});
		await sent.settle();

		expect(res.status).toBe(409);
		expect((res.body as { message: string }).message).toBe(
			'subBoards[0]: Sub-boards can be nested at most 20 levels deep, and a board under this card would be deeper.'
		);
		expectUnchanged(snapshot, 'after the refusal');
		expect(sent.all).toEqual([]);
	});

	it('reads the lists’ shapes with the card’s fields, before the category is looked for', async () => {
		const s = scene();
		const res = await api('POST', '/api/cards', { user: s.owner, body: { ...fields(s), categoryId: 999999, subBoards: 'Plans' } });
		expect(res.status).toBe(400);
		expect((res.body as { message: string }).message).toBe('subBoards must be a list');
	});

	it('a viewer is refused 403 for the column first, whatever the lists hold', async () => {
		const s = scene();
		const viewer = makeUser({ username: 'viewer' });
		addBoardMember(s.A.board, viewer, 'viewer');
		const res = await api('POST', '/api/cards', { user: viewer, body: { ...fields(s), subtasks: ['not an object'] } });
		expect(res.status).toBe(403);
		expect(db.select().from(cards).all()).toEqual([]);
	});
});

describe('POST /api/v1/boards/{id}/cards ignores the four lists (card 2296, ruling 2)', () => {
	it('makes the card and none of the parts, as it ignores any field it does not read', async () => {
		const s = scene();
		const res = await api('POST', `/api/v1/boards/${s.A.board.id}/cards`, {
			user: s.owner,
			body: { columnId: s.A.cols['To Do'].id, title: 'Through the API', ...gathered(s) }
		});

		expect(res.status).toBe(201);
		const made = written();
		expect(made.cards.map((card) => card.title)).toEqual(['Through the API']);
		expect([made.subtasks, made.labels, made.assignees, made.subBoards]).toEqual([[], [], [], []]);
	});
});
