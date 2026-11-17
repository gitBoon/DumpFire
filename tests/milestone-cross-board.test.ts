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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cards, type Card } from '$lib/server/db/schema';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { makeBoard, makeCard, makeMilestone, makeUser, resetDb, type BoardFixture } from './helpers/fixtures';

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
