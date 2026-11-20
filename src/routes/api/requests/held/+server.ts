/**
 * /api/requests/held — the requests whose mail to their requester is held, for
 * an administrator's review (card 3020, its plan's R2, R4 and R11).
 *
 * A restore of a backup whose seal did not verify holds the mail of each
 * request it brought in with an address that this server did not hold as it
 * is (`holdUnsealedRequestMail`, restore.ts): `mail_held_because` is set, and
 * no mail, link or report goes to its requester (`requesterMailAddress`) until
 * an administrator releases it here.
 *
 * GET — an administrator's: every held request, whatever it was addressed to,
 * with its address as stored (`requesterAddress`; the page shows it with
 * `asciiShown`), its card's title and board, and whether it may be released
 * (`releasable`: an unconfirmed one may not, R11, nor one with no address, its
 * code review's FP3). `mayRelease` is kept for the shape of `settings/held`,
 * and is true: every administrator may release. Answered with no-store.
 *
 *     { held: [{ id, title, status, unconfirmed, releasable, requesterName, address,
 *                card: { id, title, board } | null, heldBecause, createdAt }], mayRelease: true }
 *
 * POST — an administrator, with their current password and a code
 * (`STEP_UP_ACTIONS`): `{ requestId, address, cardId, cardTitle, cardBoard }`,
 * each as the GET gave it, the card's three null where it gave no card (R4;
 * its code review's FP4). 404 for a request that is not there; 409 for one not
 * held now, one not yet confirmed (R11), one with no address, which stays held
 * (FP3), or one whose address, card, card title or board has changed since the
 * list was read (`MOVED`). The refusals are asked before the password and
 * again in the transaction that writes, and a write that changes no row is a
 * 409 too.
 * Release clears the hold and records who released it and when, in the row's
 * own columns: never in the thread, which the requester reads. Nothing is
 * mailed; the next mail to the requester carries a link.
 *
 *     { success: true, released: requestId }
 */
import { error, json } from '@sveltejs/kit';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { boards, cards, columns, taskRequests } from '$lib/server/db/schema';
import { createLogger } from '$lib/server/logger';
import { awaitsConfirmation, requesterAddress } from '$lib/server/request-access';
import { readBody, readId, readText } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const log = createLogger('REQUESTS');

/** What a request that is not there is told. */
const NOT_FOUND = 'Request not found';
/** What a request whose mail is not held now is told. */
const NOT_HELD = "That request's mail is not held now: it was released since the list was read. Nothing was changed.";
/** What an unconfirmed held request is told (R11): it is never released, and lapses. */
const UNCONFIRMED = 'An unconfirmed request cannot be released: it lapses 7 days after it was made. Nothing was changed.';
/** What a request whose address or card is not the one reviewed is told (R4; its code review, FP4). */
const MOVED = "That request's address or card has changed since the list was read: read it again and review it as it is now. Nothing was changed.";
/** What a held request with no address is told (its code review, FP3): there is nobody to release its mail to, so it stays held. */
const NO_ADDRESS = 'A request with no address cannot be released: it stays held. Nothing was changed.';

/** The request and what the review shows of its card, as read now. */
function heldRows(requestId?: number) {
	return db
		.select({
			id: taskRequests.id,
			title: taskRequests.title,
			status: taskRequests.status,
			requesterName: taskRequests.requesterName,
			requesterEmail: taskRequests.requesterEmail,
			requesterUserId: taskRequests.requesterUserId,
			mailHeldBecause: taskRequests.mailHeldBecause,
			createdAt: taskRequests.createdAt,
			cardId: cards.id,
			cardTitle: cards.title,
			boardName: boards.name
		})
		.from(taskRequests)
		.leftJoin(cards, eq(cards.id, taskRequests.resolvedCardId))
		.leftJoin(columns, eq(columns.id, cards.columnId))
		.leftJoin(boards, eq(boards.id, columns.boardId))
		.where(requestId === undefined ? isNotNull(taskRequests.mailHeldBecause) : eq(taskRequests.id, requestId))
		.orderBy(asc(taskRequests.id))
		.all();
}

/** The card a held row is reviewed with, as the GET answers it and the POST compares it (FP4). */
function cardShown(row: ReturnType<typeof heldRows>[number]): { id: number; title: string; board: string } | null {
	return row.cardId === null ? null : { id: row.cardId, title: row.cardTitle ?? '', board: row.boardName ?? '' };
}

export const GET: RequestHandler = async ({ locals }) => {
	requireAdmin(locals.user);
	const held = heldRows().map((row) => {
		const unconfirmed = awaitsConfirmation(row);
		const address = requesterAddress(row);
		return {
			id: row.id,
			title: row.title,
			status: row.status,
			unconfirmed,
			releasable: !unconfirmed && address !== null,
			requesterName: row.requesterName,
			address,
			card: cardShown(row),
			heldBecause: row.mailHeldBecause,
			createdAt: row.createdAt
		};
	});
	// Kept by nothing on the way: requesters' addresses.
	return json({ held, mayRelease: true }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);
	const requestId = readId(body, 'requestId', { required: true });
	// As the GET gave it: null where the request has no address now, which is refused below (FP3).
	const address = readText(body, 'address', { required: true, nullable: true, max: 1000 });
	// The card reviewed, as the GET gave it: all three null where it gave none (FP4).
	const cardId = readId(body, 'cardId', { required: true, nullable: true });
	const cardTitle = readText(body, 'cardTitle', { required: true, nullable: true });
	const cardBoard = readText(body, 'cardBoard', { required: true, nullable: true });

	/**
	 * Every refusal, read only: the caller an administrator as their account is
	 * now, the request there, held, confirmed, with an address, and at the
	 * address and on the card reviewed. Asked before the password, and again in
	 * the transaction that writes.
	 */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);
		const row = heldRows(requestId)[0];
		if (row === undefined) throw error(404, NOT_FOUND);
		if (row.mailHeldBecause === null) throw error(409, NOT_HELD);
		if (awaitsConfirmation(row)) throw error(409, UNCONFIRMED);
		const now = requesterAddress(row);
		if (now === null) throw error(409, NO_ADDRESS);
		const card = cardShown(row);
		const sameCard =
			card === null
				? cardId === null && cardTitle === null && cardBoard === null
				: card.id === cardId && card.title === cardTitle && card.board === cardBoard;
		if (now !== address || !sameCard) throw error(409, MOVED);
		return { actor };
	};

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/requests/held', (caller) => refusals(caller));

	const actor = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor } = refusals(caller);
			const { changes } = db
				.update(taskRequests)
				.set({ mailHeldBecause: null, mailReleasedAt: stamp(), mailReleasedBy: actor.id, mailReleasedByName: actor.username })
				.where(and(eq(taskRequests.id, requestId), isNotNull(taskRequests.mailHeldBecause)))
				.run();
			// Released by another between the read and the write.
			if (changes === 0) throw error(409, NOT_HELD);
			return actor;
		})
	);
	// The request and who released it, never the address (card 2896).
	log.info(`Mail to the requester of request ${requestId} released by ${actor.username}`, undefined, { userId: actor.id });
	return json({ success: true, released: requestId });
};
