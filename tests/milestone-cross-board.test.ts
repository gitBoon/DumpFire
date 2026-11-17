/**
 * An existing milestone can be made cross-board (card 2860).
 *
 * The bulk attach stays all or nothing. Its refusal of a card on another
 * board than a single-board goal's names a remedy that exists: `boardId`
 * null on the milestone's PATCH, or Spans every board on its plan page. The
 * second case takes that remedy and sends the same batch again.
 *
 * Kept out of `bulk-endpoints.test.ts` and `access-every-route.test.ts`
 * (card 2771 changed both while this card was planned). The rules the PATCH
 * applies to `boardId` are tested there and are not repeated here.
 *
 * The plan is `docs/planning/card-2860-milestone-cross-board.md` (section 5).
 *
 * The list of a board's milestones can also list the cross-board goals that
 * hold its cards, with `touching=true` (card 2891): the last block. Its plan
 * is `docs/planning/card-2891-milestones-touching.md` (section 5).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { addBoardMember, makeBoard, makeCard, makeMilestone, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

let owner: SessionUser;
let A: BoardFixture;
let B: BoardFixture;
let onA: Card;
let onB: Card;
let goalId: number;

/** A goal of board A, empty; a card on A and one on B, both boards the owner's. */
beforeEach(() => {
	resetDb();
	owner = makeUser({ username: 'owner' });
	A = makeBoard({ owner, name: 'A' });
	B = makeBoard({ owner, name: 'B' });
	onA = makeCard(A.cols['To Do'], { title: 'On A' });
	onB = makeCard(B.cols['To Do'], { title: 'On B' });
	goalId = makeMilestone({ board: A.board, name: 'Goal of A', createdBy: owner }).id;
});

const milestoneOf = (card: Card) => db.select({ milestoneId: cards.milestoneId }).from(cards).where(eq(cards.id, card.id)).get()!.milestoneId;
const attachBoth = () => api('POST', `/api/v1/milestones/${goalId}/cards/bulk`, { user: owner, body: { cardIds: [onA.id, onB.id] } });

describe('a single-board goal made cross-board to take a card of another board (card 2860)', () => {
	it('refuses the batch, attaching nothing, and the reason names the PATCH and the plan page', async () => {
		const res = await attachBoth();

		expect(res.status).toBe(409);
		expect(res.body.message).toBe('Batch rejected — nothing was written');
		expect(res.body.problems).toHaveLength(1);
		expect(res.body.problems[0]).toEqual({
			cardId: onB.id,
			reason: `This milestone belongs to a single board; card #${onB.id} is on another. Make the milestone cross-board (boardId null on PATCH /api/v1/milestones/${goalId}, or Spans every board on its plan page), or move the card.`
		});
		expect(milestoneOf(onA)).toBeNull();
		expect(milestoneOf(onB)).toBeNull();
	});

	it('takes the batch once the goal is made cross-board with boardId null, as the reason says', async () => {
		const made = await api('PATCH', `/api/v1/milestones/${goalId}`, { user: owner, body: { boardId: null } });
		expect(made.status, JSON.stringify(made.body)).toBe(200);
		expect(made.body.boardId).toBeNull();

		const res = await attachBoth();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.attached).toBe(2);
		expect([...res.body.boardsTouched].sort((x: number, y: number) => x - y)).toEqual([A.board.id, B.board.id].sort((x, y) => x - y));
		expect(milestoneOf(onA)).toBe(goalId);
		expect(milestoneOf(onB)).toBe(goalId);
	});
});

describe('the list of a board\'s milestones with touching=true (card 2891)', () => {
	// Board N is A and board M is B, both the owner's; the editor opens N alone.
	let editor: SessionUser;
	let goalOfN: number;

	beforeEach(() => {
		editor = makeUser({ username: 'editor' });
		addBoardMember(A.board, editor, 'editor');
		goalOfN = goalId;
		makeMilestone({ board: B.board, name: 'Goal of M', createdBy: owner });
	});

	/** The ids the list answers, in its order, for `query` asked by `user`. */
	const listed = async (user: SessionUser, query: string) => {
		const res = await api('GET', `/api/v1/milestones?${query}`, { user });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return (res.body as { id: number }[]).map((m) => m.id);
	};

	it('adds the cross-board goals with a live card on N, and without touching the list is as before', async () => {
		const across = makeMilestone({ name: 'Across, on N', createdBy: owner, cards: [onA] }).id;

		expect(await listed(owner, `boardId=${A.board.id}`)).toEqual([goalOfN]);
		expect(await listed(owner, `boardId=${A.board.id}&touching=false`)).toEqual([goalOfN]);
		// Undated and open alike: the newer goal first.
		expect(await listed(owner, `boardId=${A.board.id}&touching=true`)).toEqual([across, goalOfN]);
	});

	it('does not add a cross-board goal whose only card on N is archived', async () => {
		const archivedOnA = makeCard(A.cols['To Do'], { title: 'Archived on A', archivedAt: '2026-11-01 09:00:00' });
		const across = makeMilestone({ name: 'Across, archived on N', createdBy: owner, cards: [archivedOnA, onB] }).id;

		expect(await listed(owner, `boardId=${A.board.id}&touching=true`)).toEqual([goalOfN]);
		// The owner can see it: it is listed through M, where its card is live.
		expect(await listed(owner, `boardId=${B.board.id}&touching=true`)).toContain(across);
	});

	it('does not list a cross-board goal with a card on a board the caller cannot open, though it has a live card on N', async () => {
		const onlyN = makeMilestone({ name: 'Across, on N alone', createdBy: owner, cards: [makeCard(A.cols['To Do'])] }).id;
		makeMilestone({ name: 'Across N and M', createdBy: owner, cards: [onA, onB] });

		expect(await listed(editor, `boardId=${A.board.id}&touching=true`)).toEqual([onlyN, goalOfN]);
	});

	it('lists nothing more for a board the caller cannot open', async () => {
		makeMilestone({ name: 'Across N and M', createdBy: owner, cards: [onA, onB] });
		makeMilestone({ name: 'Across, on M alone', createdBy: owner, cards: [makeCard(B.cols['To Do'])] });

		expect(await listed(editor, `boardId=${B.board.id}&touching=true`)).toEqual([]);
	});

	it.each([
		{ query: () => `boardId=${A.board.id}&touching=yes`, message: 'touching must be true or false' },
		{ query: () => 'touching=true', message: 'touching needs boardId' }
	])('refuses $message with 400', async ({ query, message }) => {
		const res = await api('GET', `/api/v1/milestones?${query()}`, { user: owner });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(message);
	});
});
