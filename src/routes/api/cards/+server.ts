import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { cards } from '$lib/server/db/schema';
import { requireColumn, requireUser } from '$lib/server/route-guards';
import { announceCardCreated, recordCardCreated } from '$lib/server/card-create';
import { linkBaseUrl } from '$lib/server/email';
import { normaliseReportingFields } from '$lib/server/reporting-fields';
import { PRIORITIES, requireCardCategory } from '$lib/server/card-fields';
import {
	readBody,
	readChoice,
	readColour,
	readDate,
	readId,
	readNumber,
	readText
} from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * POST /api/cards — raise a card in a column.
 *
 * `columnId` names the row guarded, so it is read first: the column is
 * looked for and the caller checked (404, then 403). Then every field is read
 * (card 2117, R1), as `POST /api/v1/boards/:boardId/cards` reads them, and
 * then the category the body names is looked for: one of the card's board,
 * or one that belongs to no board (R3), `404 Category not found on this
 * board` otherwise. A create is checked as new: a value copied from another
 * card, as a duplicate is, is held to the rules (R6).
 *
 * A title over 500 characters was refused before the column was looked for;
 * every other field was stored as sent, and a reporting field outside its
 * vocabulary was a 500.
 *
 * A card created in a Complete column is completed as it is created, as a
 * card moved into one is (card 2134): see `$lib/server/card-create`. The
 * answer is the card as written, with its `completedAt`.
 */
export const POST: RequestHandler = async ({ request, locals, url }) => {
	const user = requireUser(locals.user);
	const body = await readBody(request);
	const baseUrl = linkBaseUrl(url);

	// One transaction: the column is read and the caller checked in the one
	// that creates the card and writes its entries. A failure between the
	// writes used to leave a card that nobody was recorded as having raised.
	const card = inTransaction(() => {
		// The board is the one the target column is on. A `boardId` in the body is
		// ignored: it used to be trusted ahead of the column, so naming a board you
		// could edit let you create a card in a column on a board you could not.
		const columnId = readId(body, 'columnId', { required: true, says: 'Invalid column ID' });
		const { column, boardId: resolvedBoardId } = requireColumn(user, columnId, 'edit');

		const title = readText(body, 'title', {
			required: true,
			trim: true,
			min: 1,
			max: 500,
			says: { missing: 'title is required', empty: 'title is required', invalid: 'Title too long (max 500 chars)' }
		});
		const description = readText(body, 'description', { max: 50000, says: { invalid: 'Description too long (max 50000 chars)' } });
		const priority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true });
		const colorTag = readColour(body, 'colorTag', { allowEmpty: true });
		const categoryId = readId(body, 'categoryId', { nullable: true });
		const dueDate = readDate(body, 'dueDate', { nullable: true });
		const businessValue = readText(body, 'businessValue', { max: 10000, says: { invalid: 'Business value too long (max 10000 chars)' } });
		const position = readNumber(body, 'position', {});
		// The five reporting fields, each in its own vocabulary, with its own 400.
		const reporting = normaliseReportingFields(body);

		if (categoryId != null) requireCardCategory(categoryId, resolvedBoardId);

		const card = db
			.insert(cards)
			.values({
				columnId,
				categoryId: categoryId ?? null,
				title,
				description: description ?? '',
				position: position ?? 0,
				priority: priority ?? 'medium',
				colorTag: colorTag ?? '',
				dueDate: dueDate ?? null,
				businessValue: businessValue ?? '',
				createdBy: user.id,
				...reporting
			})
			.returning()
			.get();

		// The `card_created` entry, which once never appeared in ~2,500 scanned
		// entries, and in a Complete column the completion; then the live update
		// and, for a completion, the celebration, after the commit.
		const creation = recordCardCreated({ card, column, actor: user, source: 'ui' });
		announceCardCreated(creation, user, baseUrl);
		return creation.card;
	});
	return json(card, { status: 201 });
};
