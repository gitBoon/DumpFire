/**
 * card-labels.ts — a label put on a card and taken off it (card 2012, part A,
 * slice A2).
 *
 * The two trees do this differently, and each keeps its own way (R2 of
 * `docs/planning/card-2012-service-layer-and-pages.md`): the card window
 * toggles a label with `PUT /api/labels` (`toggleCardLabel`, the card and the
 * label in the body), and v1 adds one with `POST` and removes one with
 * `DELETE /api/v1/cards/:cardId/labels` (`addCardLabel`, `removeCardLabel`),
 * each with its own words for what it refuses. What they share is the write
 * and the live update, `putOn` and `takeOff` below.
 *
 * Each write has the one shape of a service (`ServiceOptions` in
 * `write-as.ts`): `inWrite()` first, then `requireUser(caller)` (401), the
 * card's guard (404, then 403), then the label read from the body (400) and
 * looked for (404); but `toggleCardLabel` reads the card's id from the body
 * before the guard, as the row the guard is asked of, so its `400 Invalid
 * card ID` comes before a 404. No label write records an entry, in either tree. Every
 * event waits for the commit. Refusals are kit `error()`s.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import { cardLabels, labels } from './db/schema';
import type { SessionUser } from './auth';
import { requireCard, requireLabel, requireUser } from './route-guards';
import { emit } from './events';
import { readId, type RequestBody } from './request-body';
import { inWrite, type ServiceOptions } from './write-as';

/** The functions here that only read. None: every export but this list is a write, and starts with `inWrite()`. */
export const READS: readonly string[] = [];

/**
 * What `PUT /api/labels` hands `toggleCardLabel`, and so does a new card's
 * label (`createCard`, card 2296): one constant, so the two cannot drift
 * (the card 2296 review). Written out, as every service's options are
 * (tests/check-at-the-write.test.ts).
 */
export const TOGGLE_LABEL_PAGE_OPTIONS = { source: 'ui' } as const satisfies ServiceOptions;

/** Whether the label is on the card. */
function isOn(cardId: number, labelId: number): boolean {
	return !!db
		.select()
		.from(cardLabels)
		.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
		.get();
}

/** Put the label on the card, and tell the board after the commit. */
function putOn(cardId: number, labelId: number, boardId: number): void {
	db.insert(cardLabels).values({ cardId, labelId }).run();
	emit(boardId, 'update', { type: 'label' });
}

/** Take the label off the card: how many rows went (0 or 1). The board is told only if one did. */
function takeOff(cardId: number, labelId: number, boardId: number): number {
	const removed = db
		.delete(cardLabels)
		.where(and(eq(cardLabels.cardId, cardId), eq(cardLabels.labelId, labelId)))
		.run();
	if (removed.changes > 0) emit(boardId, 'update', { type: 'label' });
	return removed.changes;
}

/**
 * Toggle a label on a card (`PUT /api/labels`, the card window). `cardId`
 * and `labelId` are ids (card 2117), read from the body: `cardId` first, as
 * the row the guard is asked of. The label is looked for and the caller asked
 * for view access to its board, and it can only go on a card of its own board
 * (400). The answer is whether the label is on the card now.
 */
export function toggleCardLabel(caller: SessionUser | null, at: Record<string, never>, body: RequestBody, opts: ServiceOptions): boolean {
	inWrite();
	const user = requireUser(caller);
	const cardId = readId(body, 'cardId', { required: true, says: 'Invalid card ID' });

	// The board is the card's. A `boardId` in the body is ignored.
	const { boardId } = requireCard(user, cardId, 'edit', opts.says);

	// A label belongs to one board and can only go on that board's cards.
	const labelId = readId(body, 'labelId', { required: true, says: 'Invalid label ID' });
	const { label } = requireLabel(user, labelId, 'view');
	if (label.boardId !== boardId) throw error(400, 'That label belongs to a different board');

	if (isOn(cardId, labelId)) {
		takeOff(cardId, labelId, boardId);
		return false;
	}
	putOn(cardId, labelId, boardId);
	return true;
}

/**
 * Put a label on a card (`POST /api/v1/cards/:cardId/labels`). Body:
 * `{ labelId }`. A label of another board is a 400. One already on the card
 * is left as it is, with nobody told; the answer says whether it was.
 */
export function addCardLabel(
	caller: SessionUser | null,
	at: { cardId: number },
	body: RequestBody,
	opts: ServiceOptions
): { already: boolean; labelId: number } {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { boardId } = requireCard(user, cardId, 'edit', opts.says);

	const labelId = readId(body, 'labelId', { required: true, says: { missing: 'labelId is required' } });

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) throw error(404, 'Label not found');
	if (label.boardId !== boardId) throw error(400, "Label does not belong to this card's board");

	if (isOn(cardId, labelId)) return { already: true, labelId };
	putOn(cardId, labelId, boardId);
	return { already: false, labelId };
}

/**
 * Take a label off a card (`DELETE /api/v1/cards/:cardId/labels`). Body:
 * `{ labelId }`. A label that is not on the card is 404: it was answered 200,
 * as if it had been taken off.
 */
export function removeCardLabel(caller: SessionUser | null, at: { cardId: number }, body: RequestBody, opts: ServiceOptions): void {
	inWrite();
	const user = requireUser(caller);
	const { cardId } = at;
	const { boardId } = requireCard(user, cardId, 'edit', opts.says);

	const labelId = readId(body, 'labelId', { required: true, says: { missing: 'labelId is required' } });

	if (takeOff(cardId, labelId, boardId) === 0) throw error(404, 'Label not found on this card');
}
