import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cardDependencies, cards, columns } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import type { RequestHandler } from './$types';

/** Resolve board access from a card ID. */
function getCardBoard(cardId: number) {
	const card = db.select({ columnId: cards.columnId, title: cards.title })
		.from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const col = db.select({ boardId: columns.boardId })
		.from(columns).where(eq(columns.id, card.columnId)).get();
	return col ? { boardId: col.boardId, cardTitle: card.title } : null;
}

/** GET /api/v1/cards/:cardId/dependencies — List dependencies for a card. */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	const ctx = getCardBoard(cardId);
	if (!ctx) throw error(404, 'Card not found');

	const role = getBoardRole(locals.user, ctx.boardId);
	if (!role) throw error(403, 'No access');

	const deps = db.select({
		id: cardDependencies.id,
		cardId: cardDependencies.cardId,
		dependsOnCardId: cardDependencies.dependsOnCardId,
		createdAt: cardDependencies.createdAt,
		depTitle: cards.title,
		depColumnId: cards.columnId,
	})
	.from(cardDependencies)
	.innerJoin(cards, eq(cardDependencies.dependsOnCardId, cards.id))
	.where(eq(cardDependencies.cardId, cardId))
	.all();

	// Enrich with column name to determine if dependency is resolved
	const enriched = deps.map(d => {
		const col = db.select({ title: columns.title, boardId: columns.boardId })
			.from(columns).where(eq(columns.id, d.depColumnId)).get();
		const isComplete = col?.title?.toLowerCase().includes('complete') ||
			col?.title?.toLowerCase().includes('done') || false;
		return {
			id: d.id,
			dependsOnCardId: d.dependsOnCardId,
			title: d.depTitle,
			columnName: col?.title || 'Unknown',
			resolved: isComplete,
			createdAt: d.createdAt
		};
	});

	return json(enriched);
};

/** POST /api/v1/cards/:cardId/dependencies — Add a dependency. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	const ctx = getCardBoard(cardId);
	if (!ctx) throw error(404, 'Card not found');

	const role = getBoardRole(locals.user, ctx.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');

	const { dependsOnCardId } = await request.json();
	if (!dependsOnCardId) throw error(400, 'dependsOnCardId is required');

	// Prevent self-dependency
	if (dependsOnCardId === cardId) throw error(400, 'Card cannot depend on itself');

	// Prevent duplicates
	const existing = db.select().from(cardDependencies)
		.where(and(
			eq(cardDependencies.cardId, cardId),
			eq(cardDependencies.dependsOnCardId, dependsOnCardId)
		)).get();
	if (existing) throw error(409, 'Dependency already exists');

	// Verify target card exists
	const target = db.select({ id: cards.id, title: cards.title })
		.from(cards).where(eq(cards.id, dependsOnCardId)).get();
	if (!target) throw error(404, 'Target card not found');

	const dep = db.insert(cardDependencies)
		.values({ cardId, dependsOnCardId })
		.returning()
		.get();

	return json({ ...dep, title: target.title }, { status: 201 });
};

/** DELETE /api/v1/cards/:cardId/dependencies — Remove a dependency. */
export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const cardId = Number(params.cardId);
	const ctx = getCardBoard(cardId);
	if (!ctx) throw error(404, 'Card not found');

	const role = getBoardRole(locals.user, ctx.boardId);
	if (!role || role === 'viewer') throw error(403, 'No edit access');

	const { dependsOnCardId } = await request.json();
	if (!dependsOnCardId) throw error(400, 'dependsOnCardId is required');

	db.delete(cardDependencies)
		.where(and(
			eq(cardDependencies.cardId, cardId),
			eq(cardDependencies.dependsOnCardId, dependsOnCardId)
		))
		.run();

	return json({ success: true });
};
