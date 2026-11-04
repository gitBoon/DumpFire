/**
 * Who may do what to a decision (card 2675, slice 1): the roles
 * `decisionAccess` reads, the table `DECISION_RULES`, `mayDo`'s two further
 * rules (drafts, and board edit access for an author's, a decider's or a
 * board owner's writes), and `requireDecision`, which answers 404 for a decision the caller
 * may not view.
 *
 * The modules are `src/lib/server/decision-access.ts` and `requireDecision`
 * in `src/lib/server/route-guards.ts`. `getBoardRole`'s own branches are the
 * board access tests'; they are not repeated here. The cases are the plan's,
 * `docs/planning/card-2675-decision-service.md`, section 6, by number.
 */
import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { sqlite } from '$lib/server/db';
import type { SessionUser } from '$lib/server/auth';
import type { Board, Decision } from '$lib/server/db/schema';
import { DECISION_RULES, DRAFT_VIEWERS, decisionAccess, mayDo } from '$lib/server/decision-access';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { DECISION_ACTION_WORDS, type DecisionAction } from '$lib/server/decision-status';
import { requireDecision } from '$lib/server/route-guards';
import { addBoardMember, makeBoard, makeDecision, makeParticipant, makeUser, resetDb } from './helpers/fixtures';

/** Every action but `view`: each is a write, or the record. */
const WRITES = (Object.keys(DECISION_RULES) as DecisionAction[]).filter((action) => action !== 'view');

let creator: SessionUser;
let board: Board;

beforeEach(() => {
	resetDb();
	creator = makeUser({ username: 'creator' });
	board = makeBoard({ owner: creator, name: 'The board' }).board;
});

/** The roles a caller holds on the decision, in the order read. */
const rolesOf = (user: SessionUser, decision: Decision) => [...decisionAccess(user, decision).roles];

/** What `requireDecision` answered: 'passed', or the refusal's status and words. */
function guard(user: SessionUser | null, decisionId: number, action: DecisionAction): 'passed' | { status: number; message: string } {
	try {
		requireDecision(user, decisionId, action);
		return 'passed';
	} catch (err) {
		if (isHttpError(err)) return { status: err.status, message: err.body.message };
		throw err;
	}
}

const NOT_FOUND = { status: 404, message: 'Decision not found' };
const refused = (action: DecisionAction) => ({ status: 403, message: `You cannot ${DECISION_ACTION_WORDS[action].verb} this decision` });

/** A decision whose board still exists, a draft unless told otherwise. */
const decisionOn = (opts: Parameters<typeof makeDecision>[0] = {}) => makeDecision({ board, ...opts });

describe('decisionAccess', () => {
	it('gives an administrator { admin }, the author { author } and the decider { decider }, on a board none of them shares (9)', () => {
		const admin = makeUser({ role: 'admin' });
		const author = makeUser();
		const decider = makeUser();
		const decision = decisionOn({ status: 'open', author, decider });

		expect(rolesOf(admin, decision)).toEqual(['admin']);
		expect(rolesOf(author, decision)).toEqual(['author']);
		expect(rolesOf(decider, decision)).toEqual(['decider']);
		expect(decisionAccess(admin, decision)).toMatchObject({ participantId: null, canEditBoard: true });
		expect(decisionAccess(author, decision)).toMatchObject({ participantId: null, canEditBoard: false });
	});

	it('gives a member shared as owner { boardOwner }, who may view someone else’s draft (10)', () => {
		const owner = makeUser();
		addBoardMember(board, owner, 'owner');
		const draft = decisionOn({ author: makeUser() });

		expect(rolesOf(owner, draft)).toEqual(['boardOwner']);
		expect(decisionAccess(owner, draft).canEditBoard).toBe(true);
		expect(mayDo(decisionAccess(owner, draft), 'view', draft)).toBe(true);
		expect(guard(owner, draft.id, 'view')).toBe('passed');
	});

	it('gives an editor member { boardEditor }, who cannot see a draft and can see an open decision (11)', () => {
		const editor = makeUser();
		addBoardMember(board, editor, 'editor');
		const draft = decisionOn({ author: makeUser() });
		const open = decisionOn({ status: 'open', author: makeUser() });

		expect(rolesOf(editor, draft)).toEqual(['boardEditor']);
		expect(guard(editor, draft.id, 'view')).toEqual(NOT_FOUND);
		expect(guard(editor, open.id, 'view')).toBe('passed');
	});

	it('gives a viewer member { boardReader } (12)', () => {
		const viewer = makeUser();
		addBoardMember(board, viewer, 'viewer');
		const open = decisionOn({ status: 'open' });

		expect(rolesOf(viewer, open)).toEqual(['boardReader']);
		expect(decisionAccess(viewer, open).canEditBoard).toBe(false);
	});

	it('gives the account on a live participant row { participant } and that row’s id (13)', () => {
		const account = makeUser();
		const open = decisionOn({ status: 'open' });
		const row = makeParticipant(open, { userId: account.id });

		expect(decisionAccess(account, open)).toEqual({ roles: new Set(['participant']), participantId: row.id, canEditBoard: false });
		expect(guard(account, open.id, 'view')).toBe('passed');
	});

	it('gives a removed participant no role, and the decision is not found for them (14)', () => {
		const account = makeUser();
		const open = decisionOn({ status: 'open' });
		makeParticipant(open, { userId: account.id, removedAt: '2026-11-02 09:00:00' });

		expect(decisionAccess(account, open)).toEqual({ roles: new Set(), participantId: null, canEditBoard: false });
		expect(guard(account, open.id, 'view')).toEqual(NOT_FOUND);
	});

	it('gives no board role once the board is deleted, and the author keeps withdraw with no board to edit (15)', () => {
		const owner = makeUser();
		addBoardMember(board, owner, 'owner');
		const admin = makeUser({ role: 'admin' });
		const author = makeUser();
		const decider = makeUser();
		const account = makeUser();
		const made = decisionOn({ status: 'open', author, decider });
		const row = makeParticipant(made, { userId: account.id });

		sqlite.prepare('DELETE FROM boards WHERE id = ?').run(board.id);
		const decision = sqlite.prepare('SELECT board_id AS boardId FROM decisions WHERE id = ?').get(made.id) as { boardId: number | null };
		expect(decision.boardId).toBeNull();
		const orphan = { ...made, boardId: null };

		expect(rolesOf(owner, orphan)).toEqual([]);
		expect(guard(owner, made.id, 'view')).toEqual(NOT_FOUND);
		expect(rolesOf(author, orphan)).toEqual(['author']);
		expect(rolesOf(decider, orphan)).toEqual(['decider']);
		expect(decisionAccess(account, orphan)).toMatchObject({ roles: new Set(['participant']), participantId: row.id });
		expect(rolesOf(admin, orphan)).toEqual(['admin']);
		expect(decisionAccess(author, orphan).canEditBoard).toBe(false);
		expect(mayDo(decisionAccess(author, orphan), 'withdraw', orphan)).toBe(true);
		expect(guard(author, made.id, 'withdraw')).toBe('passed');
	});
});

describe('requireDecision', () => {
	it('answers 404 in the same words for a decision not there and one not visible, and 400 for an id that is no id (16)', () => {
		const outsider = makeUser();
		const open = decisionOn({ status: 'open' });

		expect(guard(outsider, 999_999, 'view')).toEqual(NOT_FOUND);
		expect(guard(outsider, open.id, 'view')).toEqual(NOT_FOUND);
		expect(guard(outsider, 1.5, 'view')).toEqual({ status: 400, message: 'Invalid decision ID' });
		expect(guard(null, open.id, 'view')).toEqual({ status: 401, message: 'Not authenticated' });
	});

	it('answers 403 naming the action to a caller who may view and may not do it (17)', () => {
		const viewer = makeUser();
		addBoardMember(board, viewer, 'viewer');
		const open = decisionOn({ status: 'open' });

		expect(guard(viewer, open.id, 'withdraw')).toEqual({ status: 403, message: 'You cannot withdraw this decision' });
	});
});

describe('DECISION_RULES', () => {
	it('is the table of plan section 4.3, whole (18)', () => {
		expect(DECISION_RULES).toEqual({
			view: ['admin', 'author', 'decider', 'boardOwner', 'boardEditor', 'boardReader', 'participant'],
			edit: ['admin', 'author', 'decider', 'boardOwner'],
			setDecider: ['admin', 'author', 'boardOwner'],
			// Card 2676 (R3, decision 9).
			include: ['author', 'decider'],
			review: ['author', 'decider'],
			open: ['author', 'decider'],
			republish: ['author', 'decider'],
			close: ['author', 'decider'],
			extend: ['decider'],
			withdraw: ['admin', 'author', 'decider'],
			delete: ['admin', 'author'],
			resend: ['admin', 'author', 'decider'],
			participantAccount: ['admin'],
			participantAddress: ['admin'],
			rule: ['decider'],
			record: ['admin', 'decider'],
			// Card 2677 (decision 10).
			respond: ['participant'],
			// Card 2697 (decision 5).
			dryRun: ['author', 'decider'],
			// Card 2679 (decisions 1, 4 and 5, S2).
			results: ['admin', 'decider'],
			release: ['decider'],
			concern: ['participant'],
			supersede: ['admin', 'decider', 'productOwner'],
			// Card 2678 (decisions 1 and 2).
			ask: ['participant'],
			answer: ['author', 'decider'],
			questions: ['admin', 'author', 'decider', 'participant'],
			askers: ['admin', 'author', 'decider']
		});
		expect(DRAFT_VIEWERS).toEqual(['admin', 'author', 'decider', 'boardOwner']);
	});

	it('gives the board’s Product Owner as the ruling recorded them { productOwner }, which lets them supersede it only while they can edit the board (card 2679, decision 5, S1)', () => {
		const productOwner = makeUser({ username: 'po' });
		addBoardMember(board, productOwner, 'editor');
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(productOwner.id, board.id);
		const ruled = decisionOn({ status: 'ruled', author: makeUser(), decider: makeUser() });

		// Code review S1: the board naming them is not enough; the ruling's record of them is.
		expect(rolesOf(productOwner, ruled), 'no ruling recorded').toEqual(['boardEditor']);
		appendEvent({ decisionId: ruled.id, kind: 'ruled', detail: { optionId: null, early: false, againstResponses: false, productOwnerUserId: productOwner.id } }, SYSTEM_ACTOR);
		expect(rolesOf(productOwner, ruled)).toEqual(['boardEditor', 'productOwner']);
		// One the board names after the ruling holds nothing, and the one recorded keeps it.
		const later = makeUser({ username: 'po2' });
		addBoardMember(board, later, 'editor');
		sqlite.prepare('UPDATE boards SET product_owner_user_id = ? WHERE id = ?').run(later.id, board.id);
		expect(rolesOf(later, ruled), 'named after the ruling').toEqual(['boardEditor']);
		expect(guard(later, ruled.id, 'supersede'), 'named after the ruling').toEqual(refused('supersede'));
		expect(rolesOf(productOwner, ruled), 'recorded').toEqual(['boardEditor', 'productOwner']);
		expect(guard(productOwner, ruled.id, 'supersede')).toBe('passed');
		// The role grants supersede alone.
		expect(guard(productOwner, ruled.id, 'results')).toEqual(refused('results'));

		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, productOwner.id);
		expect(rolesOf(productOwner, ruled)).toEqual(['boardReader', 'productOwner']);
		expect(guard(productOwner, ruled.id, 'supersede')).toEqual(refused('supersede'));
	});

	it('lets an author, a decider or a board owner write only while they can edit the board (19)', () => {
		const author = makeUser();
		addBoardMember(board, author, 'viewer');
		const open = decisionOn({ status: 'open', author });

		expect(rolesOf(author, open)).toEqual(['author', 'boardReader']);
		expect(guard(author, open.id, 'view')).toBe('passed');
		for (const action of ['edit', 'setDecider', 'open', 'republish', 'close', 'withdraw', 'delete', 'resend'] as const) {
			expect(guard(author, open.id, action), action).toEqual(refused(action));
		}

		// Made the decider as well, the decider's writes, the ruling among them, need the board too (S8); able to edit it, they pass.
		sqlite.prepare('UPDATE decisions SET decider_user_id = ? WHERE id = ?').run(author.id, open.id);
		for (const action of ['open', 'close', 'extend', 'rule'] as const) expect(guard(author, open.id, action), action).toEqual(refused(action));
		sqlite.prepare("UPDATE board_members SET role = 'editor' WHERE board_id = ? AND user_id = ?").run(board.id, author.id);
		for (const action of ['open', 'close', 'extend', 'rule'] as const) expect(guard(author, open.id, action), action).toBe('passed');

		// A board owner whose share is changed to viewer is a reader, and every write is refused.
		const owner = makeUser();
		addBoardMember(board, owner, 'owner');
		const other = decisionOn({ status: 'open', author: makeUser() });
		expect(guard(owner, other.id, 'edit')).toBe('passed');
		sqlite.prepare("UPDATE board_members SET role = 'viewer' WHERE board_id = ? AND user_id = ?").run(board.id, owner.id);
		expect(rolesOf(owner, other)).toEqual(['boardReader']);
		for (const action of WRITES) expect(guard(owner, other.id, action), action).toEqual(refused(action));
	});
});
