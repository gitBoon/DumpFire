import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { cards, columns, subtasks } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { canEditBoard } from '$lib/server/board-access';
import {
	validateDependencyBatch,
	createDependencyBatch,
	chainToLinks,
	type DependencyLink,
	type WorkRef,
	type WorkKind
} from '$lib/server/planning';
import { logActivity } from '$lib/server/logActivity';
import { emit } from '$lib/server/events';
import type { RequestHandler } from './$types';

/**
 * POST /api/v1/dependencies/bulk — record many dependencies in one call.
 *
 * Deliberately not nested under a card: a batch spans many, and pretending it
 * belongs to one of them would make the direction harder to reason about, which
 * is already the easiest thing to get wrong here.
 *
 * Body, one of:
 *   { "links": [{ "blocked": 1559, "blocker": 1686 }, …] }
 *   { "chain": [1686, 1559, 1444, 1201] }   — each waits on the one before it
 *
 * `chain` is sugar for the common case. Recording a critical path is exactly a
 * linear chain, and writing it out as pairs is where transcription mistakes
 * come from.
 *
 * Semantics:
 *   - The whole batch is validated before anything is written. If any link is
 *     rejected, nothing is written and every problem is reported at once.
 *   - Links that already exist are skipped and counted, not treated as errors,
 *     so running the same list twice is safe.
 *   - Cycle detection considers the batch as a whole — two links that are each
 *     fine against the stored graph can still close a loop between themselves.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const body = await request.json();
	const { links: rawLinks, chain } = body;

	if (rawLinks && chain) throw error(400, 'Provide either links or chain, not both');

	/**
	 * An entry is a bare id (a card — the long-standing shape), the string
	 * "subtask:42", or an object {kind, id}. Bare numbers keep meaning cards, so
	 * every caller written before subtasks existed is untouched.
	 */
	const asRef = (v: unknown, what: string): WorkRef => {
		if (typeof v === 'number' && !isNaN(v)) return { kind: 'card', id: v };
		if (typeof v === 'string') {
			const parts = v.split(':');
			if (parts.length === 2 && (parts[0] === 'card' || parts[0] === 'subtask')) {
				const n = Number(parts[1]);
				if (!isNaN(n)) return { kind: parts[0] as WorkKind, id: n };
			}
			const n = Number(v);
			if (v.trim() !== '' && !isNaN(n)) return { kind: 'card', id: n };
		}
		if (v && typeof v === 'object') {
			const o = v as { kind?: unknown; id?: unknown };
			const id = Number(o.id);
			if (!isNaN(id)) return { kind: o.kind === 'subtask' ? 'subtask' : 'card', id };
		}
		throw error(400, `${what} must be a card id, "subtask:<id>", or {kind, id}`);
	};

	let links: DependencyLink[];
	if (Array.isArray(chain)) {
		if (chain.length < 2) throw error(400, 'chain needs at least two entries');
		links = chainToLinks(chain.map((v, i) => asRef(v, `chain[${i}]`)));
	} else if (Array.isArray(rawLinks)) {
		if (rawLinks.length === 0) throw error(400, 'links is empty');
		links = rawLinks.map((l: unknown, i: number) => {
			const item = l as {
				blocked?: unknown;
				blocker?: unknown;
				cardId?: unknown;
				dependsOnCardId?: unknown;
				blockedType?: unknown;
				blockerType?: unknown;
			};
			// Accept the single-endpoint spelling too, so a caller moving from the
			// per-card route does not have to relearn the field names.
			const blockedRaw = item.blocked ?? item.cardId;
			const blockerRaw = item.blocker ?? item.dependsOnCardId;
			if (blockedRaw === undefined || blockerRaw === undefined) {
				throw error(400, `links[${i}] needs a blocked and a blocker`);
			}
			const blocked = asRef(blockedRaw, `links[${i}].blocked`);
			const blocker = asRef(blockerRaw, `links[${i}].blocker`);
			// Explicit *Type fields win, for callers that prefer them to the
			// "subtask:42" spelling.
			return {
				blocked: blocked.id,
				blockedType: (item.blockedType as WorkKind) ?? blocked.kind,
				blocker: blocker.id,
				blockerType: (item.blockerType as WorkKind) ?? blocker.kind
			};
		});
	} else {
		throw error(400, 'Provide links: [{blocked, blocker}] or chain: [id, id, …]');
	}

	if (links.length > 500) throw error(400, 'Batch too large (max 500 links)');

	const validation = validateDependencyBatch(links);

	// ── Access: resolve every referenced node's board once, not once per link.
	//    A subtask has no board of its own — it inherits its parent card's.
	const boardByNode = new Map<string, number>();
	{
		const cardIds = validation.referencedNodes.filter((r) => r.kind === 'card').map((r) => r.id);
		const subtaskIds = validation.referencedNodes.filter((r) => r.kind === 'subtask').map((r) => r.id);

		const subtaskParents = subtaskIds.length
			? db
					.select({ subtaskId: subtasks.id, cardId: subtasks.cardId })
					.from(subtasks)
					.where(inArray(subtasks.id, subtaskIds))
					.all()
			: [];

		const allCardIds = [...new Set([...cardIds, ...subtaskParents.map((sp) => sp.cardId)])];
		const cardBoards = new Map<number, number>();
		if (allCardIds.length > 0) {
			for (const r of db
				.select({ cardId: cards.id, boardId: columns.boardId })
				.from(cards)
				.innerJoin(columns, eq(cards.columnId, columns.id))
				.where(inArray(cards.id, allCardIds))
				.all()) {
				cardBoards.set(r.cardId, r.boardId);
			}
		}

		for (const id of cardIds) {
			const b = cardBoards.get(id);
			if (b !== undefined) boardByNode.set(`card:${id}`, b);
		}
		for (const sp of subtaskParents) {
			const b = cardBoards.get(sp.cardId);
			if (b !== undefined) boardByNode.set(`subtask:${sp.subtaskId}`, b);
		}
	}

	const editable = new Map<number, boolean>();
	const mayEdit = (boardId: number) => {
		if (!editable.has(boardId)) editable.set(boardId, canEditBoard(locals.user!, boardId));
		return editable.get(boardId)!;
	};

	const forbidden: { link: DependencyLink; message: string }[] = [];
	for (const link of validation.valid) {
		const ends = [
			{ key: `${link.blockedType ?? 'card'}:${link.blocked}`, role: 'blocked' },
			{ key: `${link.blockerType ?? 'card'}:${link.blocker}`, role: 'blocker' }
		];
		for (const end of ends) {
			const boardId = boardByNode.get(end.key);
			if (boardId === undefined || !mayEdit(boardId)) {
				forbidden.push({ link, message: `No edit access to the board holding the ${end.role} ${end.key}` });
				break;
			}
		}
	}

	// ── All-or-nothing: report everything wrong, write nothing.
	if (validation.rejected.length > 0 || forbidden.length > 0) {
		return json(
			{
				error: 'Batch rejected — nothing was written',
				written: 0,
				rejected: validation.rejected,
				forbidden,
				wouldSkipAsDuplicate: validation.duplicates.length,
				wouldCreate: validation.valid.length - forbidden.length
			},
			{ status: 409 }
		);
	}

	const created = createDependencyBatch(validation.valid, locals.user.id);

	// Refresh every board the batch touched so blocked chips update.
	const touchedBoards = new Set<number>();
	for (const link of validation.valid) {
		for (const k of [
			`${link.blockedType ?? 'card'}:${link.blocked}`,
			`${link.blockerType ?? 'card'}:${link.blocker}`
		]) {
			const b = boardByNode.get(k);
			if (b !== undefined) touchedBoards.add(b);
		}
	}
	for (const boardId of touchedBoards) emit(boardId, 'update', { type: 'card' });

	if (created > 0) {
		const firstBoard = [...touchedBoards][0];
		if (firstBoard !== undefined) {
			logActivity({
				boardId: firstBoard,
				userId: locals.user.id,
				action: 'api:dependencies_bulk_added',
				detail: `Recorded ${created} dependenc${created === 1 ? 'y' : 'ies'} across ${touchedBoards.size} board(s)`,
				userName: locals.user.username,
				userEmoji: locals.user.emoji || '👤'
			});
		}
	}

	return json(
		{
			created,
			skippedAsDuplicate: validation.duplicates.length,
			boardsTouched: [...touchedBoards],
			links: validation.valid
		},
		{ status: 201 }
	);
};
