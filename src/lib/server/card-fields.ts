/**
 * card-fields.ts — what a card's and a subtask's fields may hold, where more
 * than one handler writes them (card 2117).
 *
 * The readers of `request-body.ts` say what type a field is. What is here is
 * what the field is for: the four priorities every page draws, and which
 * categories a card may be filed under. The handlers of both API trees that
 * create or change a card or a subtask read their fields against these.
 *
 * And the field reads both trees made of a card, word for word, before card
 * 2012 moved them here for `cards.ts`: `readNewCardFields` for a new card,
 * `readCardPatch` for a change to one.
 */
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { categories, type Card, type cards } from './db/schema';
import { normaliseReportingFields } from './reporting-fields';
import {
	readBoolean,
	readChoice,
	readColour,
	readCover,
	readDate,
	readId,
	readNumber,
	readText,
	type RequestBody
} from './request-body';

/**
 * The priorities a card, a subtask and a template may have, in the order a
 * refusal lists them. A page draws these four; anything else it draws as
 * none. Read in any case, and stored in lower case, as the reporting fields
 * are.
 */
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * The category a card is to be filed under, if it is one of the card's board's
 * or one that belongs to no board (card 2117, R3): a shared category, made by
 * an administrator, is everybody's. Anything else is
 * `404 Category not found on this board`, a category that is not there
 * among them, which the foreign key refused with a 500.
 *
 * A handler that changes a card asks this only of a category that is not the
 * one the card already holds: one sent back unchanged is kept (decision 8).
 */
export function requireCardCategory(categoryId: number, boardId: number): void {
	const category = db.select({ boardId: categories.boardId }).from(categories).where(eq(categories.id, categoryId)).get();
	if (!category || (category.boardId !== null && category.boardId !== boardId)) {
		error(404, 'Category not found on this board');
	}
}

/**
 * A new card's fields, each read against its rule (card 2117, R1), in the
 * order both trees read them, so that the first field wrong is the one a 400
 * names. A create is checked as new: a value copied from another card, as a
 * duplicate is, is held to the rules (R6). The column and the category are
 * the caller's to look for.
 */
export function readNewCardFields(body: RequestBody) {
	const title = readText(body, 'title', {
		required: true,
		trim: true,
		min: 1,
		max: 500,
		says: { missing: 'title is required', empty: 'title is required' }
	});
	const description = readText(body, 'description', { max: 50000 });
	const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true });
	const colorTag = readColour(body, 'colorTag', { allowEmpty: true });
	const categoryId = readId(body, 'categoryId', { nullable: true });
	const dueDate = readDate(body, 'dueDate', { nullable: true });
	const businessValue = readText(body, 'businessValue', { max: 10000 });
	const position = readNumber(body, 'position', {});
	// The five reporting fields, each in its own vocabulary, with its own 400.
	const reporting = normaliseReportingFields(body);
	return { title, description, priority, colorTag, categoryId, dueDate, businessValue, position, reporting };
}

/**
 * A change to a card's own fields, each read against its rule and the value
 * the card holds (decision 8: one sent back unchanged is accepted as stored),
 * in the order both trees read them. Only what was sent is in the answer.
 * `position` is read, between `pinned` and `coverUrl`, only where the route
 * takes it (the internal card update).
 *
 * `coverUrl` is a colour, one of the preset gradients, or null: it is drawn
 * on the board for every viewer, so nothing else is taken (card 2010,
 * decision 14). The reporting fields carry fixed vocabularies, and answer
 * their own 400: a bad value dropped silently would read as "not recorded",
 * which is a different and misleading answer.
 */
export function readCardPatch(body: RequestBody, card: Card, take: { position: boolean }): Partial<typeof cards.$inferInsert> {
	const patch: Partial<typeof cards.$inferInsert> = {};
	const title = readText(body, 'title', {
		trim: true,
		min: 1,
		max: 500,
		keep: card.title,
		says: { empty: 'title cannot be empty' }
	});
	if (title !== undefined) patch.title = title;
	const description = readText(body, 'description', { max: 50000, keep: card.description });
	if (description !== undefined) patch.description = description;
	const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true, keep: card.priority });
	if (priority !== undefined) patch.priority = priority;
	const colorTag = readColour(body, 'colorTag', { allowEmpty: true, keep: card.colorTag });
	if (colorTag !== undefined) patch.colorTag = colorTag;
	const categoryId = readId(body, 'categoryId', { nullable: true, keep: card.categoryId });
	if (categoryId !== undefined) patch.categoryId = categoryId;
	const dueDate = readDate(body, 'dueDate', { nullable: true, keep: card.dueDate });
	if (dueDate !== undefined) patch.dueDate = dueDate;
	const onHoldNote = readText(body, 'onHoldNote', { max: 50000, keep: card.onHoldNote });
	if (onHoldNote !== undefined) patch.onHoldNote = onHoldNote;
	const businessValue = readText(body, 'businessValue', { max: 10000, keep: card.businessValue });
	if (businessValue !== undefined) patch.businessValue = businessValue;
	const pinned = readBoolean(body, 'pinned', { keep: card.pinned });
	if (pinned !== undefined) patch.pinned = pinned;
	if (take.position) {
		const position = readNumber(body, 'position', { keep: card.position });
		if (position !== undefined) patch.position = position;
	}
	const coverUrl = readCover(body, 'coverUrl', { nullable: true, keep: card.coverUrl });
	if (coverUrl !== undefined) patch.coverUrl = coverUrl;
	Object.assign(patch, normaliseReportingFields(body));
	return patch;
}
