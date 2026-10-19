/**
 * route-guards.ts — the access decision for a route, made from the database row.
 *
 * Every guard here answers "may this caller touch this thing" by looking up
 * which board the thing is on and checking the caller against that board. None
 * of them takes a board id from the request: a board id in a request body says
 * which board the caller would like to be judged against, and a caller who may
 * edit board A could name it while changing a card on board B.
 *
 * Each guard throws the HTTP error itself and returns what it looked up, so a
 * handler cannot check one board and then act on another:
 *
 *     const { card, boardId } = requireCard(locals.user, id, 'edit');
 *
 * 401 not signed in, 404 no such row, 403 the row exists but is not yours.
 *
 * Two rules keep the row a guard checked the row that is written:
 *
 *   - A handler that reads a body reads it first, and calls its guard after.
 *     Called before the body is awaited, a guard decides on a row that another
 *     request can change, or delete, while the body is still arriving.
 *     tests/check-at-the-write.test.ts holds every handler under
 *     src/routes/api to this, from the source.
 *   - Nothing is awaited between a guard and the write it allows, and the
 *     database calls are synchronous, so no other request runs between them.
 *     Where the guard is called inside `inTransaction`, as in every handler
 *     card 2115 moved, the helper refuses an async function, so no `await`
 *     can be put there. A DELETE that reads no body checks and writes with no
 *     transaction, which is as safe, for the same reason: nothing is awaited
 *     between the two.
 */
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from './db';
import {
	boardCategories,
	boards,
	cards,
	categories,
	columns,
	labels,
	subtasks,
	teamMembers,
	teams,
	users,
	type Board,
	type BoardCategory,
	type Card,
	type Category,
	type Column,
	type Label,
	type Subtask,
	type Team,
	type User
} from './db/schema';
import { canEditBoard, canViewBoard, getBoardRole, isAdmin } from './board-access';
import { boardCategoryRule, categoryRule } from './list-access';
import { linkTooDeep, tooDeepToLink, wouldLoop } from './sub-boards';
import type { SessionUser } from './auth';
import { mayManageAccount } from '$lib/account-rule';

/** What the caller needs to be able to do to the board. */
export type Need = 'view' | 'edit';

/** The signed-in caller, or a 401. */
export function requireUser(user: SessionUser | null | undefined): SessionUser {
	if (!user) error(401, 'Not authenticated');
	return user;
}

/**
 * The caller, if they are an administrator or the superadmin; otherwise 403,
 * in the route's own words (`Forbidden` unless it says other), a caller who
 * is not signed in included, as the routes that ask it have always answered.
 *
 * It reads no row, so a route may ask it before its body as a quick refusal
 * that binds no name (`requireAdmin(locals.user);`), and asks it again of the
 * caller its `writeAs` hands it, which decides (card 2253).
 */
export function requireAdmin(user: SessionUser | null | undefined, says = 'Forbidden'): SessionUser {
	if (!user || !isAdmin(user)) error(403, says);
	return user;
}

/**
 * A 403, in the route's words, when the account the path names is the
 * caller's own; nothing when it is not, or when nobody is signed in. For the
 * routes that refuse a caller their own account before anything else, and so
 * before their body. Like `requireAdmin`, it reads no row.
 *
 * Not a guard on its own: it lets a null caller through. Ask `requireUser`
 * (or `requireAdmin`) first.
 */
export function refuseOwnAccount(user: SessionUser | null | undefined, userId: number, says: string): void {
	if (user && user.id === userId) error(403, says);
}

/**
 * The board, if it exists and the caller may view or edit it.
 *
 * Existence is checked first and separately: an administrator passes every
 * access check without the board being looked up, so without this an admin
 * asking about a board that does not exist would be told "yes".
 *
 * `says` is the 403's text where a route has words of its own for it, which
 * it keeps (card 2012, R2): the v1 card routes say "this card's board".
 */
export function requireBoard(
	user: SessionUser | null | undefined,
	boardId: number,
	need: Need,
	says?: string
): Board {
	const caller = requireUser(user);
	if (!Number.isInteger(boardId)) error(400, 'Invalid board ID');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) error(404, 'Board not found');

	const allowed = need === 'edit' ? canEditBoard(caller, boardId) : canViewBoard(caller, boardId);
	if (!allowed) {
		error(403, says ?? (need === 'edit' ? 'No edit access to this board' : 'No access to this board'));
	}
	return board;
}

/**
 * The board, if the caller may change who can see it: its owner, or an
 * administrator.
 *
 * Sharing a board and taking a share away already ask for this. Making a board
 * public shows it to everyone who is signed in, which is the widest share
 * there is, so `isPublic` asks for it too, on whichever route it is sent to.
 * An editor may change what is on a board and not who can open it.
 *
 * `says` is the refusal's text. The three share routes each had words of
 * their own for it and keep them; making a board public is the default.
 */
export function requireBoardOwner(
	user: SessionUser | null | undefined,
	boardId: number,
	says = 'Only board owners and admins can change visibility'
): Board {
	const caller = requireUser(user);
	if (!Number.isInteger(boardId)) error(400, 'Invalid board ID');

	const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
	if (!board) error(404, 'Board not found');

	const role = getBoardRole(caller, boardId);
	if (role !== 'owner' && role !== 'admin') error(403, says);
	return board;
}

/**
 * The team, if the caller may change it: renaming it, deleting it, and adding
 * and removing its members. That is the team's owner, or an administrator.
 *
 * A team is on no board, so this looks at none. The four team routes each
 * asked it of a copy of their own, and before the team was looked up, so an
 * administrator was let through for a team that is not there and was
 * answered 200 for doing nothing, or a 500 from the database.
 */
export function requireTeamManager(user: SessionUser | null | undefined, teamId: number): Team {
	const caller = requireUser(user);
	if (!Number.isInteger(teamId)) error(400, 'Invalid team ID');

	const team = db.select().from(teams).where(eq(teams.id, teamId)).get();
	if (!team) error(404, 'Team not found');

	if (!isAdmin(caller)) {
		const membership = db
			.select({ role: teamMembers.role })
			.from(teamMembers)
			.where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, caller.id)))
			.get();
		if (membership?.role !== 'owner') error(403, 'Forbidden');
	}
	return team;
}

/** The column and the board it is on. */
export function requireColumn(
	user: SessionUser | null | undefined,
	columnId: number,
	need: Need
): { column: Column; boardId: number } {
	requireUser(user);
	if (!Number.isInteger(columnId)) error(400, 'Invalid column ID');

	const column = db.select().from(columns).where(eq(columns.id, columnId)).get();
	if (!column) error(404, 'Column not found');

	requireBoard(user, column.boardId, need);
	return { column, boardId: column.boardId };
}

/** The card and the board it is on, resolved through its column; `says` as for `requireBoard`. */
export function requireCard(
	user: SessionUser | null | undefined,
	cardId: number,
	need: Need,
	says?: string
): { card: Card; boardId: number } {
	requireUser(user);
	if (!Number.isInteger(cardId)) error(400, 'Invalid card ID');

	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) error(404, 'Card not found');

	const column = db
		.select({ boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();
	if (!column) error(404, 'Card not found');

	requireBoard(user, column.boardId, need, says);
	return { card, boardId: column.boardId };
}

/**
 * The card a new board is to hang under as a sub-board, if the caller may
 * edit the board that card is on.
 *
 * A sub-board is shown on its parent card, so making one changes that card
 * for everybody who can open its board: it asks for what editing the card
 * asks for. Both routes that create a board answer from here, so that they
 * cannot differ, and write the id of the card that was checked.
 *
 * The id is one the route has read with `readId` (card 2117): one that is no
 * id is the route's `400 parentCardId must be an id`. It was parsed here with
 * `Number()`, which read `"1e3"` as card 1000, and answered anything else 404.
 */
export function requireParentCard(user: SessionUser | null | undefined, parentCardId: number): Card {
	const caller = requireUser(user);

	const card = db.select().from(cards).where(eq(cards.id, parentCardId)).get();
	if (!card) error(404, 'Parent card not found');

	const column = db
		.select({ boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get();
	if (!column) error(404, 'Parent card column not found');

	if (!canEditBoard(caller, column.boardId)) {
		error(403, "No edit access to the parent card's board");
	}
	return card;
}

/** What a caller who may not link a board is told, for a link and for taking one away. */
export const SUB_BOARD_LINK_REFUSAL =
	"Only the board's owner or an administrator can put it under a card or take it out from under one";

/**
 * The card an existing board is to be put under, and the board that card is
 * on, if the caller may put it there; null for taking it out from under its
 * card, which puts it back on the dashboard.
 *
 * Linking a board hands its deletion to another board's editors: a sub-board
 * is deleted for good with its parent card, that card's column and the
 * parent board, and any editor of the parent board may delete a card there.
 * So the board's owner, by `getBoardRole` (its creator, or a member shared as
 * Owner), or an administrator, is asked, and edit access to the board being
 * linked is not enough. That is who may delete the board itself. Taking it
 * out from under its card, or moving it to another, asks the same.
 *
 * Then, as for creating a sub-board, edit access to the parent card's board
 * (`requireParentCard`). And the card may not be on the board itself, or on a
 * board beneath it: that would make a loop, 409. Nor may it, or a board
 * beneath it, end up nested deeper than sub-boards may be, and deeper than it
 * is now (card 2172): 409 too.
 */
export function requireSubBoardLink(
	user: SessionUser | null | undefined,
	boardId: number,
	parentCardId: number | null
): { card: Card; boardId: number } | null {
	const board = requireBoardOwner(user, boardId, SUB_BOARD_LINK_REFUSAL);
	if (parentCardId === null) return null;

	const card = requireParentCard(user, parentCardId);
	const parentBoardId = db
		.select({ boardId: columns.boardId })
		.from(columns)
		.where(eq(columns.id, card.columnId))
		.get()!.boardId;
	if (wouldLoop(boardId, parentBoardId)) {
		error(409, `Board "${board.name}" cannot go under a card on itself or on one of its own sub-boards`);
	}
	if (linkTooDeep(boardId, parentBoardId)) error(409, tooDeepToLink(board.name));
	return { card, boardId: parentBoardId };
}

/** The subtask, its parent card and the board that card is on. */
export function requireSubtask(
	user: SessionUser | null | undefined,
	subtaskId: number,
	need: Need
): { subtask: Subtask; card: Card; boardId: number } {
	requireUser(user);
	if (!Number.isInteger(subtaskId)) error(400, 'Invalid subtask ID');

	const subtask = db.select().from(subtasks).where(eq(subtasks.id, subtaskId)).get();
	if (!subtask) error(404, 'Subtask not found');

	const { card, boardId } = requireCard(user, subtask.cardId, need);
	return { subtask, card, boardId };
}

/** The label and the board it belongs to. */
export function requireLabel(
	user: SessionUser | null | undefined,
	labelId: number,
	need: Need
): { label: Label; boardId: number } {
	requireUser(user);
	if (!Number.isInteger(labelId)) error(400, 'Invalid label ID');

	const label = db.select().from(labels).where(eq(labels.id, labelId)).get();
	if (!label) error(404, 'Label not found');

	requireBoard(user, label.boardId, need);
	return { label, boardId: label.boardId };
}

/**
 * A card category the caller may read: one that belongs to no board, or one of
 * a board they can open (card 2128, decision 5, by `categoryRule`). Any key
 * could read any category by its id, with the id of the board it is on.
 */
export function requireCategory(user: SessionUser | null | undefined, categoryId: number): Category {
	const caller = requireUser(user);
	if (!Number.isInteger(categoryId)) error(400, 'Invalid category ID');

	const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
	if (!category) error(404, 'Category not found');

	if (!categoryRule(caller)(category)) error(403, 'No access to this category');
	return category;
}

/**
 * A card category the caller may change or delete.
 *
 * Categories are listed on every board, but each belongs to the board it was
 * created on, and changing or deleting one changes every card that uses it.
 * So the caller needs edit access to the owning board. A category with no
 * board — created that way, or left behind when its board was deleted — has
 * no owner to ask, so only an administrator may change it.
 */
export function requireCategoryEdit(
	user: SessionUser | null | undefined,
	categoryId: number
): Category {
	const caller = requireUser(user);
	if (!Number.isInteger(categoryId)) error(400, 'Invalid category ID');

	const category = db.select().from(categories).where(eq(categories.id, categoryId)).get();
	if (!category) error(404, 'Category not found');

	if (category.boardId !== null) {
		requireBoard(caller, category.boardId, 'edit');
	} else if (!isAdmin(caller)) {
		error(403, 'Only an administrator can change a category that belongs to no board');
	}
	return category;
}

/**
 * The board a new card category is to be created on, or null for a shared one.
 *
 * Naming a board requires edit access to it. Naming none creates a category
 * that belongs to nobody, which is an administrator's call.
 *
 * The board id is one the route has read with `readId` (card 2117), or null
 * or undefined for none. `''` and `0` were taken for none as well, and any
 * other value was parsed with `Number()`.
 */
export function requireCategoryCreate(
	user: SessionUser | null | undefined,
	boardId: number | null | undefined
): number | null {
	const caller = requireUser(user);
	if (boardId !== null && boardId !== undefined) {
		return requireBoard(caller, boardId, 'edit').id;
	}
	if (!isAdmin(caller)) {
		error(403, 'Only an administrator can create a category that belongs to no board');
	}
	return null;
}

/**
 * A dashboard grouping the caller is listed, by `boardCategoryRule` (card
 * 2128, decision 4): one that holds a board they can open, or no board. Asked
 * to read one, and to file a board under one that it is not filed under: a
 * board filed under another team's grouping put that grouping in the filer's
 * lists, and kept the team from renaming or deleting it.
 */
export function requireBoardCategory(user: SessionUser | null | undefined, categoryId: number): BoardCategory {
	const caller = requireUser(user);
	if (!Number.isInteger(categoryId)) error(400, 'Invalid category ID');

	const grouping = db.select().from(boardCategories).where(eq(boardCategories.id, categoryId)).get();
	if (!grouping) error(404, 'Board category not found');

	if (!boardCategoryRule(caller)(categoryId)) error(403, 'No access to this board category');
	return grouping;
}

/**
 * A dashboard grouping the caller may rename or delete.
 *
 * A grouping is not on a board; boards are filed under it. Renaming or
 * deleting one changes how every board filed under it is shown to everybody,
 * so the caller must be able to edit each of those boards. An empty grouping
 * affects no one and any signed-in user may tidy it up.
 */
export function requireBoardCategoryEdit(
	user: SessionUser | null | undefined,
	categoryId: number
): BoardCategory {
	const caller = requireUser(user);
	if (!Number.isInteger(categoryId)) error(400, 'Invalid category ID');

	const category = db
		.select()
		.from(boardCategories)
		.where(eq(boardCategories.id, categoryId))
		.get();
	if (!category) error(404, 'Board category not found');

	if (!isAdmin(caller)) {
		const filed = db
			.select({ id: boards.id })
			.from(boards)
			.where(eq(boards.categoryId, categoryId))
			.all();
		if (filed.some((b) => !canEditBoard(caller, b.id))) {
			error(403, 'This category groups boards you cannot edit');
		}
	}
	return category;
}

/** What everybody but the superadmin is told by a route that is the superadmin's. */
export const SUPERADMIN_ONLY =
	'This belongs to the superadmin. Exporting, importing and resetting the database, the backup schedule and ' +
	'its destinations, and the mail and App URL settings can be used by the superadmin account only';

/**
 * The caller, if they are the superadmin. Like `requireManagedAccount`, it
 * looks at no board.
 *
 * It is asked by every route that acts on the whole installation: the export,
 * the import and the reset, everything under `/api/admin/backup`, and the mail
 * and App URL settings. Each of those is the user list by another way. An
 * export holds every password hash, an import replaces every account, a reset
 * leaves the installation to whoever sets it up next, a backup destination is
 * sent the whole database, and the mail settings and the App URL decide where
 * an invite goes and what its link points at. An administrator could do all
 * of it, and so could get round the rule above, that only the superadmin
 * manages an administrator.
 *
 * An administrator is told why, in the one message, and so is everybody else
 * who is signed in.
 */
export function requireSuperadmin(user: SessionUser | null | undefined): SessionUser {
	const caller = requireUser(user);
	if (caller.role !== 'superadmin') error(403, SUPERADMIN_ONLY);
	return caller;
}

/** Whose account the caller was refused: the superadmin's, or an administrator's. */
export type AccountRefusal = 'superadmin' | 'admin';

/**
 * The account, if the caller may manage it: set its password, change it or
 * delete it. An account is on no board, and this is the one guard here that
 * looks at none.
 *
 *   an ordinary user's account    any administrator
 *   an administrator's account    the superadmin
 *   the superadmin's account      nobody else
 *
 * The three routes that manage an account all ask here. They used to ask each
 * for itself, and differed: an administrator could not delete another
 * administrator and could set their password, which is the same account taken
 * another way.
 *
 * The caller's own account passes, for an administrator: what a caller may do
 * to their own account through these routes is each route's to say, and two
 * of the three refuse it before they get here.
 *
 * The table is `mayManageAccount`'s, in `$lib/account-rule.ts`, which the
 * admin page asks too, to show on each row only what this would let through.
 *
 * `says` is what each refusal is answered with. The routes had words of their
 * own for the refusals they already made, and keep them.
 */
export function requireManagedAccount(
	user: SessionUser | null | undefined,
	userId: number,
	says: Record<AccountRefusal, string>
): User {
	const caller = requireUser(user);
	if (!isAdmin(caller)) error(403, 'Forbidden');

	const target = db.select().from(users).where(eq(users.id, userId)).get();
	if (!target) error(404, 'User not found');

	// Refused for one of two reasons, told apart by whose account it is.
	if (!mayManageAccount(caller, target)) {
		if (target.role === 'superadmin') error(403, says.superadmin);
		error(403, says.admin);
	}
	return target;
}