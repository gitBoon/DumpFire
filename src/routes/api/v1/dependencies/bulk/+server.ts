import { error } from '@sveltejs/kit';
import { json } from '$lib/server/v1-json';
import { db } from '$lib/server/db';
import { cards, columns, subtasks } from '$lib/server/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { getBoardRole } from '$lib/server/board-access';
import {
	validateDependencyBatch,
	createDependencyBatch,
	chainToLinks,
	type BatchRejection,
	type DependencyLink,
	type WorkRef,
	type WorkKind
} from '$lib/server/planning';
import { ACTIONS, actorOf, logActivity } from '$lib/server/logActivity';
import { describeWork } from '$lib/server/work-access';
import { emit } from '$lib/server/events';
import { asObject, readBody, readChoice, readId, readList, readObjects } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** What each end of a link may be. */
const WORK_KINDS = ['card', 'subtask'] as const;

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
 *   - Access is asked first (card 2719): an end on a board the caller cannot
 *     open is reported as one that does not exist, and only the links whose
 *     ends the caller can edit are checked for duplicates and loops. A loop's
 *     node the caller cannot open is withheld: `id` null, `withheld` true.
 *   - Each link written is recorded as the single add records one: one
 *     `api:dependency_added` on the board of the card that waits, naming it,
 *     "#12 now waits on subtask #45" (card 2291). A link skipped as already
 *     stored is not. `dependencies_bulk_added`, one entry with no card on the
 *     first board alone, is no longer written; its label stays for old rows.
 *
 * `links` is a list of objects, and an entry that is not one is
 * `400 links[<n>] must be an object` (decision 18), where it was a 500.
 * `blockedType` and `blockerType` are `card` or `subtask`: another word was
 * reported in the 409 as a link to nothing. A batch is on no one board, so
 * its fields are read before the boards of its ends are looked at.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	requireUser(locals.user);
	const body = await readBody(request);
	const rawLinks = readObjects(body, 'links', { nullable: true, min: 1, says: { empty: 'links is empty' } });
	const chain = readList(body, 'chain', { nullable: true });

	if (rawLinks && chain) throw error(400, 'Provide either links or chain, not both');

	/**
	 * An entry is a bare id (a card — the long-standing shape), the string
	 * "subtask:42", or an object {kind, id}. Bare numbers keep meaning cards, so
	 * every caller written before subtasks existed is untouched.
	 *
	 * The id is read as `readId` reads one (card 2117, decision 18): a whole
	 * number of 1 or more, or one written as text. `1.5`, `"1e3"`, `0` and `-1`
	 * were taken as ids and reported in the 409 as links to nothing; each is
	 * `400` naming the entry. An object's `kind` is `card` or `subtask`, as a
	 * link's `blockedType` is: another word was read as a card.
	 */
	const asRef = (v: unknown, what: string): WorkRef => {
		const refused = `${what} must be a card id, "subtask:<id>", or {kind, id}`;
		const idOf = (id: unknown) => readId({ id }, 'id', { required: true, says: refused });
		if (typeof v === 'number') return { kind: 'card', id: idOf(v) };
		if (typeof v === 'string') {
			const parts = v.split(':');
			if (parts.length === 2 && (parts[0] === 'card' || parts[0] === 'subtask')) {
				return { kind: parts[0] as WorkKind, id: idOf(parts[1]) };
			}
			return { kind: 'card', id: idOf(v) };
		}
		const entry = asObject(v);
		if (entry) {
			const kind = readChoice(entry, 'kind', { from: WORK_KINDS, nullable: true, says: refused }) ?? 'card';
			return { kind, id: readId(entry, 'id', { required: true, says: refused }) };
		}
		throw error(400, refused);
	};

	let links: DependencyLink[];
	if (chain) {
		if (chain.length < 2) throw error(400, 'chain needs at least two entries');
		links = chainToLinks(chain.map((v, i) => asRef(v, `chain[${i}]`)));
	} else if (rawLinks) {
		links = rawLinks.map((item, i) => {
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
			// "subtask:42" spelling. Each is `card` or `subtask`, and nothing else.
			const blockedType = readChoice(item, 'blockedType', {
				nullable: true,
				from: WORK_KINDS,
				says: `links[${i}].blockedType must be one of: card, subtask`
			});
			const blockerType = readChoice(item, 'blockerType', {
				nullable: true,
				from: WORK_KINDS,
				says: `links[${i}].blockerType must be one of: card, subtask`
			});
			return {
				blocked: blocked.id,
				blockedType: blockedType ?? blocked.kind,
				blocker: blocker.id,
				blockerType: blockerType ?? blocker.kind
			};
		});
	} else {
		throw error(400, 'Provide links: [{blocked, blocker}] or chain: [id, id, …]');
	}

	if (links.length > 500) throw error(400, 'Batch too large (max 500 links)');

	// One transaction from the validation to the activity entries. The graph the
	// batch is checked against is read in it, so a link written by another
	// request cannot close a loop between the check and the write, and the
	// links are recorded with the entries that say so or not at all. It asks
	// first whether the key or session is still open, and who its account is
	// now (card 2253): once for the whole batch, so a refusal writes none of it.
	const outcome = writeAs(locals, (caller) => {
		const user = requireUser(caller);

		// ── Access first (card 2719, D12): resolve every referenced node's board
		//    once, not once per link, before the batch is validated. A subtask has
		//    no board of its own — it inherits its parent card's.
		const boardByNode = new Map<string, number>();
		// The card each node is, or belongs to: the card a link's entry is on.
		const cardByNode = new Map<string, number>();
		{
			const keyed = new Map<string, WorkRef>();
			for (const link of links) {
				for (const ref of [{ kind: link.blockedType ?? 'card', id: link.blocked }, { kind: link.blockerType ?? 'card', id: link.blocker }] as WorkRef[]) {
					keyed.set(`${ref.kind}:${ref.id}`, ref);
				}
			}
			const referencedNodes = [...keyed.values()];
			const cardIds = referencedNodes.filter((r) => r.kind === 'card').map((r) => r.id);
			const subtaskIds = referencedNodes.filter((r) => r.kind === 'subtask').map((r) => r.id);

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
				cardByNode.set(`card:${id}`, id);
			}
			for (const sp of subtaskParents) {
				const b = cardBoards.get(sp.cardId);
				if (b !== undefined) boardByNode.set(`subtask:${sp.subtaskId}`, b);
				cardByNode.set(`subtask:${sp.subtaskId}`, sp.cardId);
			}
		}

		// The caller's role on each board, read once.
		const roles = new Map<number, ReturnType<typeof getBoardRole>>();
		const roleOn = (boardId: number) => {
			if (!roles.has(boardId)) roles.set(boardId, getBoardRole(user, boardId));
			return roles.get(boardId)!;
		};
		const opens = (boardId: number) => roleOn(boardId) !== null;
		const mayEdit = (boardId: number) => {
			const role = roleOn(boardId);
			return role === 'admin' || role === 'owner' || role === 'editor';
		};

		// A link with an end that is not there, or is on a board the caller
		// cannot open, is answered in the very words a missing end gets, and
		// goes no further: it is never judged a duplicate or part of a loop,
		// which would tell that the end exists (card 2719, D12). A link that
		// names one end twice is the validation's `self`, which reads nothing.
		// A link with both ends openable and one not editable is `forbidden`.
		// Only the links whose ends the caller can edit are validated.
		const unseen: BatchRejection[] = [];
		const forbidden: { link: DependencyLink; message: string }[] = [];
		const editableLinks: DependencyLink[] = [];
		for (const link of links) {
			const ends = [
				{ ref: { kind: link.blockedType ?? 'card', id: link.blocked } as WorkRef, role: 'blocked' as const },
				{ ref: { kind: link.blockerType ?? 'card', id: link.blocker } as WorkRef, role: 'blocker' as const }
			];
			const keys = ends.map((end) => `${end.ref.kind}:${end.ref.id}`);
			if (keys[0] === keys[1]) {
				editableLinks.push(link);
				continue;
			}
			const hidden = ends.find((end, i) => {
				const boardId = boardByNode.get(keys[i]);
				return boardId === undefined || !opens(boardId);
			});
			if (hidden) {
				unseen.push({
					link,
					reason: hidden.role === 'blocked' ? 'missing-blocked' : 'missing-blocker',
					message: `${describeWork(hidden.ref)} does not exist or is archived`
				});
				continue;
			}
			const locked = ends.findIndex((_end, i) => !mayEdit(boardByNode.get(keys[i])!));
			if (locked !== -1) {
				forbidden.push({ link, message: `No edit access to the board holding the ${ends[locked].role} ${keys[locked]}` });
				continue;
			}
			editableLinks.push(link);
		}

		const validation = validateDependencyBatch(editableLinks, { opens });
		const rejected = [...unseen, ...validation.rejected];

		// ── All-or-nothing: report everything wrong, write nothing.
		if (rejected.length > 0 || forbidden.length > 0) {
			return { rejected: true as const, validation, rejections: rejected, forbidden };
		}

		// The links written, each by its own insert: the entries and the live
		// updates below are made from this one list, so a link already stored
		// has neither (card 2291).
		const created = createDependencyBatch(validation.valid, user.id);

		// One `dependency_added` per link, as the single add writes it: on the
		// board of the card that waits (a subtask's card), naming that card, in
		// its words. That is the board whose work is held back, and the one a
		// removal writes on. Every board a link touches is told once, after.
		const touchedBoards = new Set<number>();
		for (const link of created) {
			const blocked: WorkRef = { kind: link.blockedType ?? 'card', id: link.blocked };
			const blocker: WorkRef = { kind: link.blockerType ?? 'card', id: link.blocker };
			const waitingKey = `${blocked.kind}:${blocked.id}`;
			const boardId = boardByNode.get(waitingKey);
			const cardId = cardByNode.get(waitingKey);
			if (boardId !== undefined && cardId !== undefined) {
				logActivity({
					boardId,
					cardId,
					...actorOf(user),
					action: ACTIONS.dependencyAdded,
					detail: `${describeWork(blocked)} now waits on ${describeWork(blocker)}`,
					source: 'api'
				});
			}
			for (const key of [waitingKey, `${blocker.kind}:${blocker.id}`]) {
				const b = boardByNode.get(key);
				if (b !== undefined) touchedBoards.add(b);
			}
		}
		for (const boardId of touchedBoards) emit(boardId, 'update', { type: 'card' });

		return { rejected: false as const, validation, created: created.length, touchedBoards };
	});

	if (outcome.rejected) {
		const { validation, rejections, forbidden } = outcome;
		return json(
			{
				message: 'Batch rejected — nothing was written',
				written: 0,
				rejected: rejections,
				forbidden,
				wouldSkipAsDuplicate: validation.duplicates.length,
				// Only the links whose ends the caller can edit are validated, so each valid one would be written.
				wouldCreate: validation.valid.length
			},
			{ status: 409 }
		);
	}
	const { validation, created, touchedBoards } = outcome;

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
