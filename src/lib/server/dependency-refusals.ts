/**
 * dependency-refusals.ts — how one dependency link that cannot be made, or
 * cannot be removed, is answered.
 *
 * Four routes add and remove a single link: the card route and the subtask
 * route, each under /api/v1/ and under /api/. All of them validate with
 * `validateDependencyBatch`, and they used to turn what it found into an
 * answer in three different ways. This is the one way.
 *
 *     an end that waits on itself          400 { message }
 *     an end that is archived              400 { message }
 *     a link that is already recorded      409 { message }
 *     a link that would close a loop       409 { message, cycle }
 *     removing a link that is not there    404 { message }
 *
 * A duplicate and a cycle are both 409. A cycle is the one with `cycle` in it.
 *
 * Who may remove a link is decided here too, in `removeDependencyLink`: 403
 * for a caller who may not edit the board of the end that waits, answered
 * before the link is looked for.
 *
 * The link is written, and removed, here as well, by `addDependencyLink` and
 * `removeDependencyLink`, for all four routes: with the activity entry that
 * says so, and the live event to both ends' boards, in one transaction with
 * the check. Card 2114: the v1 card route alone used to write an entry, and
 * the other three checked the graph outside any transaction.
 *
 * Each route answers for the card or subtask in its address before it gets
 * here, in its own words: one that does not exist (404), and a caller who may
 * not edit its board to add a link (403) or cannot open it to remove one
 * (403). Each reads its own body. The bulk endpoint,
 * /api/v1/dependencies/bulk, answers a rejected batch as a whole and does not
 * use this.
 */
import { json, error } from '@sveltejs/kit';
import { sqlite } from './db';
import { inTransaction } from './db/transaction';
import { canEditBoard } from './board-access';
import { emit } from './events';
import { ACTIONS, actorOf, logActivity, type ActivitySource } from './logActivity';
import { createDependencyBatch, validateDependencyBatch, type DependencyLink, type WorkRef } from './planning';
import { describeWork, getCardBoardId, getSubtaskCardId, getWorkBoardId } from './work-access';
import type { SessionUser } from './auth';

/**
 * A link that would close a loop. The one refusal that is returned and not
 * thrown: its answer carries the chain beside the text, and `error()` sends a
 * text alone.
 */
export type CycleRefusal = {
	rejected: true;
	/** The chain the link would close, in order. */
	cycle: WorkRef[];
	/** The chain in words: "#2 waiting on #1 would create a cycle: #2 → #1 → #2". */
	message: string;
};

/** A link that may be written, as `createDependencyBatch` takes it. */
export type AcceptedLink = {
	rejected: false;
	valid: DependencyLink[];
};

/**
 * Check one proposed link, `blocked` waiting on `blocker`, against the stored
 * graph. Writes nothing.
 *
 * Throws 409 if the link is already recorded, and 400 if an end waits on
 * itself or is archived. Returns the cycle if the link would close one, for
 * the caller to answer with `cycleAnswer`, and otherwise the link to write.
 *
 * Safe inside `inTransaction`: what it throws rolls the transaction back and
 * reaches the caller unchanged, and a cycle is returned so that the answer is
 * made once the transaction is over.
 */
export function checkDependencyLink(blocked: WorkRef, blocker: WorkRef): CycleRefusal | AcceptedLink {
	// The validation the bulk endpoint uses, so that one link and a batch can
	// never disagree about what is allowed.
	const v = validateDependencyBatch([
		{ blocked: blocked.id, blockedType: blocked.kind, blocker: blocker.id, blockerType: blocker.kind }
	]);

	if (v.duplicates.length > 0) throw error(409, 'That dependency already exists');
	if (v.rejected.length > 0) {
		const r = v.rejected[0];
		if (r.reason === 'cycle') return { rejected: true, cycle: r.cycle ?? [], message: r.message };
		throw error(400, r.message);
	}
	return { rejected: false, valid: v.valid };
}

/** The answer to a link that would close a loop: 409, with the chain. */
export function cycleAnswer(refusal: CycleRefusal): Response {
	return json({ message: refusal.message, cycle: refusal.cycle }, { status: 409 });
}

/** Where a request to add or remove a link came from, for its activity entry. */
export type LinkRequest = {
	/** The card or subtask in the request's address. */
	at: WorkRef;
	/** `ui` from the two routes under /api/, `api` from the two under /api/v1/. */
	source: ActivitySource;
};

/** Whether two references are the same card, or the same subtask. */
const sameWork = (a: WorkRef, b: WorkRef) => a.kind === b.kind && a.id === b.id;

/**
 * The card a piece of work is, or belongs to, and the board that card is on:
 * a subtask's are its card's. Null if either is not there.
 */
function cardOf(work: WorkRef): { cardId: number; boardId: number } | null {
	const cardId = work.kind === 'card' ? work.id : getSubtaskCardId(work.id);
	const boardId = cardId === null ? null : getCardBoardId(cardId);
	return cardId === null || boardId === null ? null : { cardId, boardId };
}

/**
 * Record that `blocked` waits on `blocker`, for `user`, with its activity
 * entry. One of the two ends is `at`, the card or subtask in the request's
 * address, which the route has already found and checked the caller may edit.
 *
 * In this order, one transaction, a part of the caller's where it has one
 * open, having written nothing where it throws or refuses:
 *
 *     404  the other end is not there
 *     403  the caller may not edit the board the other end is on
 *     409, 400  as `checkDependencyLink` throws them
 *     the cycle, returned for the route to answer with `cycleAnswer`
 *
 * Then the link, and one `dependency_added` entry on the board of the card in
 * the address (a subtask's card), naming that card, as the v1 card route has
 * always written it: "#12 now waits on subtask #45". The live event goes to
 * both ends' boards, once the outermost transaction is committed.
 *
 * The graph the link is checked against is read in the transaction that
 * writes, so a link written by another writer cannot close a loop between the
 * check and the write.
 */
export function addDependencyLink(
	user: SessionUser,
	blocked: WorkRef,
	blocker: WorkRef,
	{ at, source }: LinkRequest
): CycleRefusal | { rejected: false } {
	return inTransaction(() => {
		const here = cardOf(at);
		if (here === null) throw error(404, `${describeWork(at)} not found`);

		const other = sameWork(blocked, at) ? blocker : blocked;
		const otherBoardId = getWorkBoardId(other);
		if (otherBoardId === null) throw error(404, `${describeWork(other)} not found`);
		if (!canEditBoard(user, otherBoardId)) {
			throw error(403, `No edit access to the board holding ${describeWork(other)}`);
		}

		// Throws for a link that is already there (409) and for an end that
		// waits on itself or is archived (400). A cycle is returned: nothing
		// has been written.
		const checked = checkDependencyLink(blocked, blocker);
		if (checked.rejected) return checked;

		createDependencyBatch(checked.valid, user.id);
		logActivity({
			boardId: here.boardId,
			cardId: here.cardId,
			...actorOf(user),
			action: ACTIONS.dependencyAdded,
			detail: `${describeWork(blocked)} now waits on ${describeWork(blocker)}`,
			source
		});

		emit(here.boardId, 'update', { type: 'card' });
		if (otherBoardId !== here.boardId) emit(otherBoardId, 'update', { type: 'card' });
		return { rejected: false };
	});
}

/**
 * Remove the link by which `blocked` waits on `blocker`, for `user`, and
 * return how many rows went.
 *
 * Who may remove a link is decided here and nowhere else, for all four
 * routes: whoever may edit the board of the end that waits, whichever end's
 * address the request came to. An administrator edits every board.
 *
 * Not both boards, which adding a link asks for. A link holds the waiting
 * end back, so taking it away is that end's board's call: its editors must be
 * able to stop waiting on work they can no longer see, or a card stays blocked
 * for ever by a board its owner cannot open. And an editor of the blocking
 * end's board alone cannot unblock another board's work.
 *
 * In this order, having removed nothing where it throws:
 *
 *     404  the end that waits is not there
 *     403  the caller may not edit the board that end is on
 *     404  there is no such link
 *
 * The 403 comes before the link is looked for, so a caller who is refused is
 * answered the same whether the link is there or not. Only a caller who may
 * edit the waiting end's board is told that it is not, and they can read that
 * end's links already.
 *
 * The check, the removal and its activity entry are one transaction, a part
 * of the caller's where it has one open.
 *
 * The entry, `dependency_removed`, goes on the board of the end that waits:
 * that is the board whose work changed, and the one the caller was shown to
 * edit. It names `at`'s card (a subtask's card) where that card is on that
 * board, and otherwise the card that waits: a card of another board is not
 * named in a board's history. The v1 card route wrote it so, and wrote the
 * only one; the other three routes wrote none.
 *
 * Both ends' boards are sent the live event, from here and so by all four
 * routes: the waiting end's, which is the one that changed, and the board of
 * the end it waited on where that is another. Each route used to send one to
 * the board of the card or subtask in its address alone, so a link removed at
 * the address of the end that was waited on told the waiting end's board
 * nothing. Sent once the removal is committed.
 */
export function removeDependencyLink(
	user: SessionUser,
	blocked: WorkRef,
	blocker: WorkRef,
	{ at, source }: LinkRequest
): number {
	return inTransaction(() => {
		const waiting = cardOf(blocked);
		if (waiting === null) throw error(404, `${describeWork(blocked)} not found`);
		const boardId = waiting.boardId;
		if (!canEditBoard(user, boardId)) {
			throw error(403, `No edit access to the board holding ${describeWork(blocked)}, the end that waits`);
		}

		const removed = sqlite
			.prepare(
				`DELETE FROM work_dependencies
				 WHERE blocked_type = ? AND blocked_id = ? AND blocker_type = ? AND blocker_id = ?`
			)
			.run(blocked.kind, blocked.id, blocker.kind, blocker.id).changes;

		if (removed === 0) throw error(404, 'Dependency not found');

		const here = cardOf(at);
		logActivity({
			boardId,
			cardId: here?.boardId === boardId ? here.cardId : waiting.cardId,
			...actorOf(user),
			action: ACTIONS.dependencyRemoved,
			detail: `${describeWork(blocked)} no longer waits on ${describeWork(blocker)}`,
			source
		});

		emit(boardId, 'update', { type: 'card' });
		const blockerBoardId = getWorkBoardId(blocker);
		if (blockerBoardId !== null && blockerBoardId !== boardId) {
			emit(blockerBoardId, 'update', { type: 'card' });
		}
		return removed;
	});
}
