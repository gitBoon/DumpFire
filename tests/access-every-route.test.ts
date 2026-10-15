/**
 * Every API route refuses a caller who may not use it.
 *
 * tests/access-control.test.ts holds the requests that used to succeed and
 * must not, one by one. This file is the other half: a table with an entry for
 * every route and method under `src/routes/api`, each saying what kind of
 * access its handler requires and how to make a real request to it. The tests
 * are made from the table, the same ones for every entry of a kind:
 *
 *   - nobody (no session, no API key) is refused, by the handler itself and
 *     through the gate;
 *   - a signed-in caller the rule does not let in is refused;
 *   - the caller the rule does let in is answered with a success.
 *
 * "Refused" is a 401, 403 or 404, with not one row changed, no file written
 * and nothing sent: a handler that answers 403 after writing has refused
 * nothing. A refused caller makes the request the allowed caller makes, so a
 * refusal is never a body the handler could not read. For most entries that
 * request succeeds for the allowed caller. For some it does not, and the entry
 * says so: where it carries `answers`, the allowed caller is turned down by
 * another rule, after the access check, with a status no refusal is taken for;
 * and the holder of a link or of a form token sends it, which a refused caller
 * has not got.
 *
 * What a caller is answered is read as well as its status. Everything on board
 * A has `MARK` in its name and everything on board B has `MARK_B`: an answer
 * to a caller who cannot open the board has neither.
 *
 * The first test fails if a route or a method has no entry, so a new route
 * cannot be added without saying who may call it.
 *
 * The cast, on two boards:
 *
 *   owner     owns board A
 *   editor    editor on board A
 *   viewer    viewer on board A
 *   guest     a member of a team that board A is shared with, to view
 *   outsider  owns board B and has no access to board A. They had it once:
 *             a comment, an assigned card and an activity entry of theirs
 *             are still on board A
 *   both      editor on board A and on board B
 *   editsB    editor on board B, and a viewer on board A
 *   editsA    editor on board A, and a viewer on board B
 *   admin     an administrator
 *   chief     the superadmin
 *
 * One more is made for the tests of who may manage which account, below the
 * table, and is in no other: `admin2`, a second administrator.
 *
 * Where a route takes a second thing in the body (a column to move a card to,
 * the other end of a dependency, a card for a milestone), the kind is
 * `across`: the request names something of board B in the path and something
 * of board A in the body. `outsider` may edit the first and `editor` the
 * second, and each is refused. So are `editsB` and `editsA`, who can edit one
 * of the two and see the other: a check of the second board that asks for no
 * more than view access lets one of them in. Only `both` is let in.
 *
 * A handler that does not refuse a caller it should is a fault in the
 * application, not in this table. It is not fixed here and its test is not
 * weakened: the case carries a `fault`, which names the callers who get in and
 * runs their test with `it.fails`. When the handler is put right that test
 * fails, and the `fault` is taken out. An answer that tells a caller of a
 * board they cannot open is recorded the same way, with `shows`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSync } from 'bcryptjs';
import { and, eq, inArray } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import {
	activityLog,
	apiKeys,
	boardCategories,
	boards,
	cardComments,
	cardDependencies,
	cardLabels,
	cards,
	cardTemplates,
	categories,
	inviteTokens,
	reportSchedules,
	sessions,
	taskRequests,
	teamMembers,
	tokenUsage,
	users,
	type Board,
	type BoardCategory,
	type Card,
	type CardAttachment,
	type CardComment,
	type Category,
	type Column,
	type Label,
	type Milestone,
	type Subtask,
	type TaskRequest,
	type Team
} from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { canEditBoard, canViewBoard, getBoardRole } from '$lib/server/board-access';
import { emit } from '$lib/server/events';
import { resetAllRateLimits } from '$lib/server/rate-limit';
import { generateCategoryReport } from '$lib/server/reports';
import { issueFormToken } from '$lib/server/request-tokens';
import { linkableBoards, tooDeepToLink } from '$lib/server/sub-boards';
import { recentActivityFor } from '$lib/server/list-access';
import { WITHHELD_BOARD_NAME, WITHHELD_CARD_TITLE, WITHHELD_SUBTASK_TITLE } from '$lib/server/planning';
import { api, routeMethods, routePatterns, serverFilesNotServed, type ApiResult } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import {
	addBoardMember,
	assignCard,
	makeApiKey,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSession,
	makeSmtp,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	testUploadsDir
} from './helpers/fixtures';
import { gate } from './helpers/gate';
import { watchReads } from './helpers/reads';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';
import { loadKeys, pageLoad } from './helpers/actions';

// ─── The cast and what is on each board ────────────────────────────────────

/**
 * In the name of everything on board A. An answer given to a caller who cannot
 * open board A must not contain it.
 */
const MARK = 'kept-to-board-A';

/** The same for board B: in the name of everything on it. */
const MARK_B = 'kept-to-board-B';

/** Every user's password. Hashed cheaply: the application hashes at a cost of 12. */
const PASSWORD = 'correct horse battery';
const PASSWORD_HASH = hashSync(PASSWORD, 4);

/**
 * The secret in the link of the request that is waiting for an answer, of the
 * one not yet confirmed and of the one addressed to a team.
 */
const LINK = 'a'.repeat(64);
const UNCONFIRMED_LINK = 'b'.repeat(64);
const TEAM_LINK = 'c'.repeat(64);

type Who =
	| 'nobody'
	| 'owner'
	| 'editor'
	| 'viewer'
	| 'guest'
	| 'outsider'
	| 'both'
	| 'editsB'
	| 'editsA'
	| 'admin'
	| 'chief';

const CALLED: Record<Who, string> = {
	nobody: 'a caller who is not signed in',
	owner: 'the owner of board A',
	editor: 'an editor of board A',
	viewer: 'a viewer of board A',
	guest: 'a member of a team that board A is shared with, to view',
	outsider: 'a signed-in caller with no access to board A',
	both: 'an editor of both boards',
	editsB: 'an editor of board B who can only view board A',
	editsA: 'an editor of board A who can only view board B',
	admin: 'an administrator',
	chief: 'the superadmin'
};

/** Who can open each board. An answer to anyone else has nothing of it. */
const OPENS_A: Who[] = ['owner', 'editor', 'viewer', 'guest', 'both', 'editsB', 'editsA', 'admin', 'chief'];
const OPENS_B: Who[] = ['outsider', 'both', 'editsB', 'editsA', 'admin', 'chief'];

/** A board and one of everything that can be on it. */
type Side = {
	board: Board;
	cols: Record<string, Column>;
	/** In To Do, in the board's milestone, with a subtask, a comment, an attachment and a token entry. */
	card: Card;
	/** In To Do. It waits on `card`. */
	other: Card;
	/** In To Do, with no link to anything and in no milestone. */
	loose: Card;
	archived: Card;
	/** A subtask of `card`. */
	sub: Subtask;
	/** A subtask of `other`. */
	otherSub: Subtask;
	label: Label;
	category: Category;
	/** On `card`, written by the board's own member. */
	comment: CardComment;
	attachment: CardAttachment;
	milestone: Milestone;
	webhookId: number;
	templateId: number;
	/** A token entry on `card`. */
	tokenEntryId: number;
};

type World = Record<Exclude<Who, 'nobody'>, SessionUser> & {
	A: Side;
	B: Side;
	/**
	 * A comment on board A's card by `outsider`, written before they lost the
	 * board. A card of board A is still assigned to them too.
	 */
	formerComment: CardComment;
	/** A template `outsider` saved on board A, before they lost the board. */
	formerTemplateId: number;
	/** A template `outsider` saved on no board: it is shared with everyone, and has no mark in it. */
	sharedTemplateId: number;
	/** A card of board B that board A's `card` waits on. */
	awaited: Card;
	/** A dashboard grouping with board A and board B filed under it. */
	grouping: BoardCategory;
	/**
	 * A second board of `owner`, with nothing on it. `viewer` can view it and
	 * `outsider` cannot open it.
	 */
	alone: Board;
	/**
	 * A dashboard grouping with `alone` filed under it and no other board: there
	 * is nothing in it that `outsider` can open. It has `MARK` in its name.
	 */
	groupingOfA: BoardCategory;
	/** A public board of `owner`, with one card. Anyone signed in may read it and only `owner` may change it. */
	publicBoard: { board: Board; cols: Record<string, Column>; card: Card };
	/** A milestone that belongs to no board, with no card in it. `owner` made it. */
	goal: Milestone;
	/** A card category that belongs to no board. */
	sharedCategory: Category;
	/**
	 * `owner` owns it, and `editor` and `guest` are members. Board A is shared
	 * with it, to view: that is all the access `guest` has.
	 */
	team: Team;
	/** The id of an API key of `owner`. */
	keyId: number;
	/** The id of a report schedule `owner` made, of board A. */
	scheduleId: number;
	/** Addressed to `owner`, waiting for an answer. Its link is `LINK`. */
	request: TaskRequest;
	/** Addressed to `owner`, not yet confirmed by its requester. Its link is `UNCONFIRMED_LINK`. */
	unconfirmed: TaskRequest;
	/** Addressed to `team`, waiting for an answer. Its link is `TEAM_LINK`. */
	teamRequest: TaskRequest;
};

const COLUMNS = ['To Do', 'On Hold', 'In Progress', 'Complete', 'Spare'];

function side(owner: SessionUser, member: SessionUser, name: string): Side {
	const { board, cols } = makeBoard({ owner, name: `${name} board`, columns: COLUMNS });
	const card = makeCard(cols['To Do'], { title: `${name} card`, position: 0 });
	const other = makeCard(cols['To Do'], { title: `${name} other card`, position: 1 });
	const loose = makeCard(cols['To Do'], { title: `${name} loose card`, position: 2 });
	const archived = makeCard(cols['To Do'], { title: `${name} archived card`, archivedAt: new Date().toISOString() });
	const sub = makeSubtask(card, { title: `${name} subtask` });
	const otherSub = makeSubtask(other, { title: `${name} other subtask` });
	const label = makeLabel(board, `${name} label`);
	const category = db.insert(categories).values({ boardId: board.id, name: `${name} category` }).returning().get();
	const comment = makeComment(card, member, `${name} comment`);
	const attachment = makeAttachment(card, { name: 'notes.txt', content: `${name} file`, uploadedBy: member });
	const milestone = makeMilestone({ board, name: `${name} milestone`, createdBy: owner, cards: [card] });
	makeDependency({ blocked: other, blocker: card, createdBy: owner });
	assignCard(card, member);
	const webhook = makeWebhook(board, { secret: 's3cret' });
	const template = db
		.insert(cardTemplates)
		.values({ boardId: board.id, name: `${name} template`, title: `${name} template title`, createdBy: member.id })
		.returning()
		.get();
	const entry = db
		.insert(tokenUsage)
		.values({ cardId: card.id, tokens: 1000, model: 'claude-opus-5-5', reportedByUserId: member.id })
		.returning()
		.get();
	db.insert(activityLog)
		.values({
			boardId: board.id,
			cardId: card.id,
			userId: member.id,
			action: 'card_created',
			detail: `Created "${name} card"`,
			userName: member.username,
			source: 'ui'
		})
		.run();
	return {
		board,
		cols,
		card,
		other,
		loose,
		archived,
		sub,
		otherSub,
		label,
		category,
		comment,
		attachment,
		milestone,
		webhookId: webhook.id,
		templateId: template.id,
		tokenEntryId: entry.id
	};
}

function world(): World {
	const owner = makeUser({ username: 'owner' });
	const editor = makeUser({ username: 'editor' });
	const viewer = makeUser({ username: 'viewer' });
	const guest = makeUser({ username: 'guest' });
	const outsider = makeUser({ username: 'outsider' });
	const both = makeUser({ username: 'both' });
	const editsB = makeUser({ username: 'editsB' });
	const editsA = makeUser({ username: 'editsA' });
	const admin = makeUser({ username: 'admin', role: 'admin' });
	// The last user made, so that nobody else's id moves for there being one.
	const chief = makeUser({ username: 'chief', role: 'superadmin' });
	db.update(users).set({ passwordHash: PASSWORD_HASH }).run();

	const A = side(owner, editor, MARK);
	addBoardMember(A.board, editor, 'editor');
	addBoardMember(A.board, viewer, 'viewer');
	addBoardMember(A.board, both, 'editor');
	addBoardMember(A.board, editsB, 'viewer');
	addBoardMember(A.board, editsA, 'editor');
	const B = side(outsider, outsider, MARK_B);
	addBoardMember(B.board, both, 'editor');
	addBoardMember(B.board, editsB, 'editor');
	addBoardMember(B.board, editsA, 'viewer');

	// One link between the boards: board A's card waits on a card of board B.
	// A viewer of board A who cannot open board B is not told what it is.
	const awaited = makeCard(B.cols['To Do'], { title: `${MARK_B} card that board A waits on`, position: 3 });
	makeDependency({ blocked: A.card, blocker: awaited, createdBy: both });

	// What `outsider` left on board A when they were a member of it: a comment,
	// a card assigned to them and an entry in the activity log. None of it lets
	// them back in.
	const formerComment = makeComment(A.card, outsider, `${MARK} comment by a former member`);
	const formerTemplateId = db
		.insert(cardTemplates)
		.values({ boardId: A.board.id, name: `${MARK} template by a former member`, title: `${MARK} template title`, createdBy: outsider.id })
		.returning()
		.get().id;
	// And one they saved on no board, which no board's access can take from them.
	const sharedTemplateId = db
		.insert(cardTemplates)
		.values({ boardId: null, name: 'A template of no board', title: 'A card', createdBy: outsider.id })
		.returning()
		.get().id;
	assignCard(A.other, outsider);
	db.insert(activityLog)
		.values({
			boardId: A.board.id,
			cardId: A.other.id,
			userId: outsider.id,
			action: 'card_updated',
			detail: `Updated "${MARK} other card"`,
			userName: outsider.username,
			source: 'ui'
		})
		.run();

	// Both boards under one grouping. It belongs to neither, so its name has no mark.
	const grouping = db.insert(boardCategories).values({ name: 'Projects' }).returning().get();
	db.update(boards).set({ categoryId: grouping.id }).where(inArray(boards.id, [A.board.id, B.board.id])).run();
	A.board.categoryId = grouping.id;
	B.board.categoryId = grouping.id;

	// And a grouping that is board A's side alone: the one board under it is
	// another of the owner's, which `outsider` cannot open.
	const groupingOfA = db.insert(boardCategories).values({ name: `${MARK} grouping` }).returning().get();
	const alone = makeBoard({ owner, name: `${MARK} second board` }).board;
	addBoardMember(alone, viewer, 'viewer');
	db.update(boards).set({ categoryId: groupingOfA.id }).where(eq(boards.id, alone.id)).run();
	alone.categoryId = groupingOfA.id;

	// A public board. Anyone signed in may read what is on it, so nothing on it has a mark.
	const made = makeBoard({ owner, name: 'Public board', isPublic: true });
	const publicBoard = { ...made, card: makeCard(made.cols['To Do'], { title: 'A card anyone may read' }) };

	const goal = makeMilestone({ name: `${MARK} goal with no board`, createdBy: owner });

	const sharedCategory = db.insert(categories).values({ boardId: null, name: 'Shared category' }).returning().get();

	const team = makeTeam([editor, guest], `${MARK} team`);
	db.insert(teamMembers).values({ teamId: team.id, userId: owner.id, role: 'owner' }).run();
	shareBoardWithTeam(A.board, team, 'viewer');

	makeApiKey(owner, `${MARK} key of the owner`);
	const keyId = db.select({ id: apiKeys.id }).from(apiKeys).get()!.id;

	const scheduleId = db
		.insert(reportSchedules)
		.values({ userId: owner.id, name: `${MARK} weekly report`, scope: 'board', scopeId: A.board.id, frequency: 'weekly' })
		.returning()
		.get().id;

	const asked = (status: string, accessToken: string, to: { targetType: 'user' | 'team'; targetId: number }) =>
		db
			.insert(taskRequests)
			.values({
				...to,
				requesterName: 'Rita',
				requesterEmail: 'rita@example.test',
				title: `${MARK} request`,
				desiredBoardId: A.board.id,
				status,
				accessToken
			})
			.returning()
			.get();
	const request = asked('pending', LINK, { targetType: 'user', targetId: owner.id });
	const unconfirmed = asked('unverified', UNCONFIRMED_LINK, { targetType: 'user', targetId: owner.id });
	const teamRequest = asked('pending', TEAM_LINK, { targetType: 'team', targetId: team.id });

	return {
		owner,
		editor,
		viewer,
		guest,
		outsider,
		both,
		editsB,
		editsA,
		admin,
		chief,
		A,
		B,
		formerComment,
		formerTemplateId,
		sharedTemplateId,
		awaited,
		grouping,
		alone,
		groupingOfA,
		publicBoard,
		goal,
		sharedCategory,
		team,
		keyId,
		scheduleId,
		request,
		unconfirmed,
		teamRequest
	};
}

// ─── The table ─────────────────────────────────────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** A request: its path, with any query, and what it sends. A string is a path alone. */
type Req = string | { path: string; body?: unknown; headers?: Record<string, string> };

/**
 * What a handler requires of its caller.
 *
 *   public     nothing: it answers a caller who is not signed in
 *   signed-in  a session or an API key, whoever's
 *   view       view access to the board of what the request names
 *   edit       edit access to that board
 *   owner      to own that board, or to be an administrator
 *   across     edit access to two boards: the one of what the path names and
 *              the one of what the body names
 *   admin      to be an administrator
 *   superadmin to be the superadmin: an administrator is refused. What acts on
 *              the whole installation, by which an administrator could make
 *              themselves anybody: the export, the import, the reset, the
 *              backup schedule and its destinations, and the mail and App URL
 *              settings
 *   own        to be the one the thing belongs to: who made it, or whom it is
 *              addressed to
 *   link       to hold the secret link a task request was made with
 *   form       a session, or the token the public request form was given when
 *              it was rendered: a caller with neither is refused, and so is
 *              one whose token is forged or has expired
 */
type Kind = 'public' | 'signed-in' | 'view' | 'edit' | 'owner' | 'across' | 'admin' | 'superadmin' | 'own' | 'link' | 'form';

type Case = {
	kind: Kind;
	/** Which request this is, where a route and method has more than one. */
	of?: string;
	/** The request the allowed caller makes. A refused caller makes the same one. */
	req: (w: World) => Req;
	/** Rows the request needs that are not in every world. */
	setup?: (w: World) => void;

	/** `own`: whose it is. */
	mine?: Who;
	/** `own`: signed-in callers whose it is not. */
	notMine?: Who[];
	/** `link`: the request as the holder of the link makes it, signed in as nobody. */
	withLink?: (w: World) => Req;
	/** `link`: the one the request is addressed to is let in too, with no link. */
	addressee?: true;
	/** `form`: the request as the form makes it, signed in as nobody, with the token it is given. */
	withToken?: (w: World, token: string) => Req;

	/**
	 * The allowed caller is answered this, and not a success, for a reason that
	 * has nothing to do with who they are: `because` says what. Used where a
	 * success would reach outside the tests, and where a request the access rule
	 * lets through is refused by another rule. The refused callers are still
	 * refused first, which shows the access check comes before it: this status
	 * is never taken for a refusal.
	 */
	answers?: number;
	because?: string;
	/**
	 * A fault in the handler: the allowed caller should be answered `answers`
	 * and is not. That test runs with `it.fails`.
	 */
	answersOtherwise?: { card?: number; what: string };
	/** The allowed caller's request is not made at all, and why. */
	notMade?: string;
	/** The answer is a stream with no end. The allowed caller's request goes through the gate and is cancelled. */
	stream?: true;
	/**
	 * A refusal may also be this: a bulk endpoint refuses with a 409 that names
	 * every entry at fault, the ones the caller may not touch among them. A 409
	 * is taken for a refusal only when it says so: "No edit access to ...".
	 */
	refusedAs?: number;
	/**
	 * `view`, for a list that takes a board as a filter: a caller who cannot
	 * open the board is not refused. They are answered with nothing of it.
	 */
	filtered?: true;
	/**
	 * What the handler does with a caller who is not signed in, where it does
	 * not answer 401 or 403. The gate turns such a caller away before the
	 * handler is reached, and that is tested for every route below.
	 *   empty    it answers 200 with an empty list
	 *
	 * Four handlers read `locals.user!` unchecked and threw a TypeError, and
	 * were marked `crashes` and run with `it.fails`, until card 2117 gave each
	 * a check of its own.
	 */
	nobody?: 'empty';
	/**
	 * The answer names things of boards the caller cannot open, and is meant
	 * to: the handler says so, and this says why. The test expects the mark in
	 * the answer, so that this goes when the handler stops telling.
	 */
	tellsEveryone?: string;
	/**
	 * `own`, on a route the holder of a request's link may also use: the handler
	 * is reached with no session, and a caller there who holds no link is
	 * answered 404, as for a request that is not there (card 2132), as the
	 * route's `link` case is.
	 */
	opensByLink?: true;
	/**
	 * A fault in the handler, not in the table: these callers should be refused
	 * and are not. Their tests run with `it.fails`. With `filtered`, where
	 * nobody is refused: they are answered with something of board A.
	 */
	fault?: { card?: number; lets: Who[]; what: string };
	/**
	 * A fault of the other kind: the answer given to the allowed caller has in
	 * it something of a board they cannot open, and is not meant to. That test
	 * runs with `it.fails`.
	 */
	shows?: { card?: number; what: string };
};

type More = Omit<Case, 'kind' | 'req'>;

const of =
	(kind: Kind) =>
	(req: (w: World) => Req, more: More = {}): Case => ({ kind, req, ...more });

const open = of('public');
const signedIn = of('signed-in');
const view = of('view');
const edit = of('edit');
const owns = of('owner');
const across = of('across');
const admin = of('admin');
const superadmin = of('superadmin');
const link = of('link');
const form = of('form');
const own = (mine: Who, notMine: Who[], req: (w: World) => Req, more: More = {}): Case => ({
	kind: 'own',
	mine,
	notMine,
	req,
	...more
});

const json = (path: string, body: unknown): Req => ({ path, body });

/** The cookie `withSession` puts on a request, which `asCaller` makes the caller's own. */
const CALLERS_COOKIE = `${SESSION_COOKIE_NAME}=a-session-of-the-caller`;

/**
 * The same, with the session cookie a signed-in caller's request carries. The
 * routes that ask for a current password count wrong ones against it. `api()`
 * gives the handler its caller as it is, so the cookie names no session row;
 * through the gate it is a session that is not there, and so no session.
 */
const withSession = (path: string, body: unknown): Req => ({ path, body, headers: { cookie: CALLERS_COOKIE } });

/**
 * A request's headers as `who` sends them: `withSession`'s cookie names a
 * session of that caller's own, so that each caller is counted apart, as two
 * people signed in are, and not on one count shared by every caller.
 */
function asCaller(headers: Record<string, string> | undefined, who: Who): Record<string, string> | undefined {
	if (headers?.cookie !== CALLERS_COOKIE || who === 'nobody') return headers;
	return { ...headers, cookie: `${SESSION_COOKIE_NAME}=a-session-of-${who}` };
}

/**
 * What the public request form sends. It names no board: the form offers
 * someone without an account none, and a signed-in caller may name only one
 * they can open (card 2128).
 */
const asking = (w: World) => ({
	targetType: 'user',
	targetId: w.owner.id,
	title: 'Please add an export',
	requesterName: 'Pat',
	requesterEmail: 'pat@example.test'
});

/** A file as the card modal uploads one. Made for each request: a body is read once. */
const upload = (): FormData => {
	const form = new FormData();
	form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
	return form;
};

const WEEK = { periodStart: '2026-10-01', periodEnd: '2026-10-08' };
const TOKENS = { tokens: 1200, model: 'claude-opus-5-5' };

/**
 * Why any signed-in caller, and whoever has the public request form, is told
 * the name of every team, board A's among them (card 2128, decision 2). The
 * team keeps its mark, so that the table notices if that changes. Who is in
 * it is not told: see "what the lists give" below the table.
 */
const TEAM_NAMES =
	"a team's name is listed to every signed-in caller and to the public form, as a username is: the share dialog and the form need it; its members are not";

/** Why the allowed caller of a route that reaches a backup destination is not sent there. */
const NO_DESTINATION = 'the request names no destination: a success would connect to a backup destination';

/** Put cards in the milestone that belongs to no board. It is then a goal across the boards those cards are on. */
const intoGoal =
	(pick: (w: World) => Card[]) =>
	(w: World): void =>
		void db
			.update(cards)
			.set({ milestoneId: w.goal.id })
			.where(
				inArray(
					cards.id,
					pick(w).map((card) => card.id)
				)
			)
			.run();

/**
 * The card board A is put under, in the case of `PUT /api/boards/[id]` that
 * links it: on a third board, which `owner` may edit and does not own. Made by
 * `aCardToGoUnder`, which each test of the case runs before its request.
 */
let underCard: Card | undefined;
const aCardToGoUnder = (w: World): void => {
	const third = makeBoard({ owner: w.both, name: 'A third board' });
	addBoardMember(third.board, w.owner, 'editor');
	underCard = makeCard(third.cols['To Do'], { title: 'The card board A goes under' });
};

/**
 * Removing a link between the two boards, the same three cases for each of the
 * four routes that remove one. The end that waits is on board B and the end it
 * waits on is on board A.
 *
 * A link is its waiting end's board's to remove, whichever end's address the
 * request is made to: `outsider` and `editsB` edit board B and are let in,
 * and `editor`, `editsA` and `owner` edit board A alone and are refused at
 * both addresses. That is not `across`, which asks for both boards and is the
 * rule for adding one.
 *
 * An address is of something the caller can open, as it is for reading its
 * links: `outsider` cannot open board A, and removes the link at the address
 * of their own end.
 *
 *   fromWaiting   the request to the address of the end that waits
 *   fromBlocking  the request to the address of the end it waits on
 *   linked        makes the link, or the two of them
 */
const unlinking = (fromWaiting: (w: World) => Req, fromBlocking: (w: World) => Req, linked: (w: World) => void): Case[] => [
	own('outsider', ['editor', 'editsA', 'owner', 'viewer'], fromWaiting, {
		of: "a link to another board's card, at the address of the end that waits",
		setup: linked
	}),
	own('editsB', ['editor', 'editsA', 'owner', 'outsider'], fromBlocking, {
		of: "a link to another board's card, at the address of the end it waits on",
		setup: linked
	}),
	own('admin', ['editor', 'editsA'], fromBlocking, {
		of: "a link to another board's card, by an administrator",
		setup: linked
	})
];

const TABLE: Record<string, Case | Case[]> = {
	// ── The caller's own account ──────────────────────────────────────────
	'GET /api/account/api-keys': signedIn(() => '/api/account/api-keys'),
	// A key is made with the caller's current password, which every user here has.
	'POST /api/account/api-keys': signedIn(() => withSession('/api/account/api-keys', { name: 'A new key', password: PASSWORD })),
	'DELETE /api/account/api-keys/[id]': own('owner', ['outsider', 'editor'], (w) => `/api/account/api-keys/${w.keyId}`),
	'PUT /api/account/email': signedIn(() =>
		withSession('/api/account/email', { newEmail: 'somewhere-else@example.test', password: PASSWORD })
	),
	'PUT /api/account/emoji': signedIn(() => json('/api/account/emoji', { emoji: '🦊' })),
	'GET /api/account/notifications': signedIn(() => '/api/account/notifications'),
	'PUT /api/account/notifications': signedIn(() => json('/api/account/notifications', { cardAssigned: false })),
	'PUT /api/account/password': signedIn(() =>
		withSession('/api/account/password', { currentPassword: PASSWORD, newPassword: 'another long password' })
	),

	// ── Activity and audit ────────────────────────────────────────────────
	'GET /api/activity': [
		signedIn(() => '/api/activity', { of: 'every board the caller can open' }),
		view((w) => `/api/activity?boardId=${w.A.board.id}`, { of: 'one board' })
	],
	'GET /api/audit': admin(() => '/api/audit'),

	// ── Administration ────────────────────────────────────────────────────
	// The superadmin's alone: everything that acts on the whole installation.
	// Clearing a board, purging, vacuuming, XP, the log and the audit trail stay
	// with administrators.
	'GET /api/admin/backup': superadmin(() => '/api/admin/backup'),
	'PUT /api/admin/backup': superadmin(() => json('/api/admin/backup', { schedule: 'disabled', destinations: [] })),
	// With no destination configured it answers that there is none and copies nothing.
	'POST /api/admin/backup': superadmin(() => json('/api/admin/backup', {})),
	'GET /api/admin/backup/gdrive/auth': superadmin(() => '/api/admin/backup/gdrive/auth', {
		answers: 400,
		because: NO_DESTINATION
	}),
	'POST /api/admin/backup/gdrive/auth': superadmin(() => json('/api/admin/backup/gdrive/auth', {}), {
		answers: 400,
		because: NO_DESTINATION
	}),
	'POST /api/admin/backup/test': superadmin(() => json('/api/admin/backup/test', {}), {
		answers: 400,
		because: NO_DESTINATION
	}),
	'POST /api/admin/boards/[id]/clear-cards': admin((w) => `/api/admin/boards/${w.A.board.id}/clear-cards`),
	'POST /api/admin/boards/[id]/clear-categories': admin((w) => `/api/admin/boards/${w.A.board.id}/clear-categories`),
	// What the file holds, and what it does not, is in tests/backups.test.ts.
	'GET /api/admin/export': superadmin(() => '/api/admin/export'),
	'POST /api/admin/import': superadmin(() => json('/api/admin/import', { notABackup: true }), {
		answers: 400,
		because: 'the body is JSON and not a .db backup, which is refused before it is read: a success would replace the database'
	}),
	'POST /api/admin/purge-archived': admin(() => '/api/admin/purge-archived'),
	'POST /api/admin/reset-xp': admin(() => '/api/admin/reset-xp'),
	'POST /api/admin/reset': superadmin(() => '/api/admin/reset'),
	'GET /api/admin/smtp': superadmin(() => '/api/admin/smtp'),
	'PUT /api/admin/smtp': superadmin(() =>
		json('/api/admin/smtp', { host: 'smtp.example.test', port: 587, fromAddress: 'dumpfire@example.test' })
	),
	'POST /api/admin/smtp': superadmin(() => json('/api/admin/smtp', { to: 'someone@example.test' }), { setup: makeSmtp }),
	'POST /api/admin/vacuum': admin(() => '/api/admin/vacuum'),
	'GET /api/logs': admin(() => '/api/logs'),
	'GET /api/logs/stream': admin(() => '/api/logs/stream', { stream: true }),

	// ── Dashboard groupings ───────────────────────────────────────────────
	// The groupings that hold a board the caller can open, and the empty ones:
	// `outsider` is not given `groupingOfA` (card 2128). See "what the lists give".
	'GET /api/board-categories': signedIn(() => '/api/board-categories'),
	'POST /api/board-categories': signedIn(() => json('/api/board-categories', { name: 'A grouping' })),
	// Both boards are filed under it, so changing it needs edit access to both:
	// the path names the grouping and nothing of either board, and the callers
	// who can edit one of the two are the ones `across` refuses.
	'PUT /api/board-categories/[id]': across((w) => json(`/api/board-categories/${w.grouping.id}`, { name: 'Renamed' })),
	'DELETE /api/board-categories/[id]': across((w) => `/api/board-categories/${w.grouping.id}`),

	// ── Boards ────────────────────────────────────────────────────────────
	'GET /api/boards': signedIn(() => '/api/boards'),
	'POST /api/boards': [
		signedIn(() => json('/api/boards', { name: 'A new board' })),
		edit((w) => json('/api/boards', { name: 'A sub-board', parentCardId: w.A.card.id }), {
			of: 'a sub-board of a card'
		})
	],
	'PUT /api/boards/[id]': [
		edit((w) => json(`/api/boards/${w.A.board.id}`, { name: 'Renamed' })),
		owns((w) => json(`/api/boards/${w.A.board.id}`, { isPublic: true }), {
			of: 'making the board public'
		}),
		// Linking hands the board's deletion to the parent board's editors: its
		// owner is asked, and `editor`, who edits it, is refused.
		owns((w) => json(`/api/boards/${w.A.board.id}`, { parentCardId: underCard?.id }), {
			of: 'linking it under a card',
			setup: aCardToGoUnder
		}),
		// Public means anyone may read it. Nobody but its owner may change it.
		own('owner', ['outsider', 'editor', 'viewer'], (w) => json(`/api/boards/${w.publicBoard.board.id}`, { name: 'Renamed' }), {
			of: 'a public board'
		})
	],
	'DELETE /api/boards/[id]': owns((w) => `/api/boards/${w.A.board.id}`),
	'GET /api/boards/[id]/archive': view((w) => `/api/boards/${w.A.board.id}/archive`),
	'POST /api/boards/[id]/archive': edit((w) => json(`/api/boards/${w.A.board.id}/archive`, { cardId: w.A.archived.id })),
	'GET /api/boards/[id]/cards': [
		view((w) => `/api/boards/${w.A.board.id}/cards`),
		// The two other ways to a board: a team it is shared with, and its being public.
		own('guest', ['outsider'], (w) => `/api/boards/${w.A.board.id}/cards`, {
			of: 'through a team the board is shared with'
		}),
		signedIn((w) => `/api/boards/${w.publicBoard.board.id}/cards`, { of: 'a public board' })
	],
	'GET /api/boards/[id]/cfd': view((w) => `/api/boards/${w.A.board.id}/cfd`),
	'GET /api/boards/[id]/events': view((w) => `/api/boards/${w.A.board.id}/events`, { stream: true }),
	'GET /api/boards/[id]/export/csv': view((w) => `/api/boards/${w.A.board.id}/export/csv`),
	'POST /api/boards/[id]/favourite': view((w) => `/api/boards/${w.A.board.id}/favourite`),
	'GET /api/boards/[id]/metrics': view((w) => `/api/boards/${w.A.board.id}/metrics`),
	'GET /api/boards/[id]/share': view((w) => `/api/boards/${w.A.board.id}/share`),
	'POST /api/boards/[id]/share': [
		owns((w) => json(`/api/boards/${w.A.board.id}/share`, { type: 'user', targetId: w.outsider.id, role: 'viewer' })),
		// The team can view the board already. This would let every member of it edit.
		owns((w) => json(`/api/boards/${w.A.board.id}/share`, { type: 'team', targetId: w.team.id, role: 'editor' }), {
			of: 'with a team'
		})
	],
	'PATCH /api/boards/[id]/share': owns((w) => json(`/api/boards/${w.A.board.id}/share`, { isPublic: true })),
	'DELETE /api/boards/[id]/share': owns((w) =>
		json(`/api/boards/${w.A.board.id}/share`, { type: 'user', targetId: w.viewer.id })
	),

	// ── Figures ───────────────────────────────────────────────────────────
	'GET /api/burndown': [
		signedIn(() => '/api/burndown', { of: 'every board the caller can open' }),
		view((w) => `/api/burndown?boardIds=${w.A.board.id}`, { of: 'one board' }),
		view((w) => `/api/burndown?milestoneId=${w.A.milestone.id}`, { of: 'one milestone' }),
		// Both boards are under the grouping, and each caller is charted the one they can open.
		view((w) => `/api/burndown?boardCategoryId=${w.grouping.id}`, { of: 'a grouping of boards', filtered: true }),
		// Refused, as a report of it is (card 2128): it was charted empty, with its name.
		view((w) => `/api/burndown?boardCategoryId=${w.groupingOfA.id}`, { of: 'a grouping with no board the caller can open' })
	],
	'GET /api/velocity': signedIn(() => '/api/velocity'),
	'GET /api/graph': [
		signedIn(() => '/api/graph', { of: 'every board the caller can open' }),
		view((w) => `/api/graph?boardId=${w.A.board.id}`, { of: "one board's columns" }),
		view((w) => `/api/graph?columnId=${w.A.cols['To Do'].id}`, { of: "one column's cards" }),
		// The column says which board it is. A board the caller can open, named beside it, does not.
		view((w) => `/api/graph?columnId=${w.A.cols['To Do'].id}&boardId=${w.B.board.id}`, {
			of: "one column's cards, with another board named beside it"
		})
	],
	'GET /api/my-tasks': signedIn(() => '/api/my-tasks'),
	'GET /api/xp': signedIn(() => '/api/xp'),

	// ── Cards ─────────────────────────────────────────────────────────────
	'POST /api/cards': edit((w) => json('/api/cards', { columnId: w.A.cols['To Do'].id, title: 'A new card' })),
	'PUT /api/cards/[id]': [
		edit((w) => json(`/api/cards/${w.A.card.id}`, { title: 'Renamed' })),
		across((w) => json(`/api/cards/${w.B.card.id}`, { columnId: w.A.cols['To Do'].id }), {
			of: "a move to another board's column"
		}),
		own('owner', ['outsider', 'editor'], (w) => json(`/api/cards/${w.publicBoard.card.id}`, { title: 'Renamed' }), {
			of: 'a card on a public board'
		})
	],
	'DELETE /api/cards/[id]': [
		edit((w) => `/api/cards/${w.A.card.id}`, { of: 'an archive' }),
		edit((w) => `/api/cards/${w.A.card.id}?permanent=true`, { of: 'a permanent delete' })
	],
	'POST /api/cards/[id]/assignees': edit((w) => json(`/api/cards/${w.A.card.id}/assignees`, { userId: w.viewer.id })),
	'DELETE /api/cards/[id]/assignees': edit((w) => json(`/api/cards/${w.A.card.id}/assignees`, { userId: w.editor.id })),
	'GET /api/cards/[id]/attachments': view((w) => `/api/cards/${w.A.card.id}/attachments`),
	'POST /api/cards/[id]/attachments': edit((w) => ({ path: `/api/cards/${w.A.card.id}/attachments`, body: upload() })),
	'GET /api/cards/[id]/attachments/[attachmentId]': view(
		(w) => `/api/cards/${w.A.card.id}/attachments/${w.A.attachment.id}`
	),
	'DELETE /api/cards/[id]/attachments/[attachmentId]': edit(
		(w) => `/api/cards/${w.A.card.id}/attachments/${w.A.attachment.id}`
	),
	'GET /api/cards/[id]/comments': view((w) => `/api/cards/${w.A.card.id}/comments`),
	'POST /api/cards/[id]/comments': edit((w) => json(`/api/cards/${w.A.card.id}/comments`, { content: 'A comment' })),
	'PUT /api/cards/[id]/comments/[commentId]': [
		// The owner can edit the board and did not write the comment.
		own('editor', ['outsider', 'viewer', 'owner'], (w) =>
			json(`/api/cards/${w.A.card.id}/comments/${w.A.comment.id}`, { content: 'Edited' })
		),
		own('admin', ['outsider'], (w) => json(`/api/cards/${w.A.card.id}/comments/${w.formerComment.id}`, { content: 'Edited' }), {
			of: 'a comment whose author has lost the board'
		})
	],
	'DELETE /api/cards/[id]/comments/[commentId]': [
		own('editor', ['outsider', 'viewer', 'owner'], (w) => `/api/cards/${w.A.card.id}/comments/${w.A.comment.id}`),
		own('admin', ['outsider'], (w) => `/api/cards/${w.A.card.id}/comments/${w.formerComment.id}`, {
			of: 'a comment whose author has lost the board'
		})
	],
	// The context is what the card's modal draws its pickers from. Its card
	// categories are those of the boards the caller can open and the shared
	// ones (card 2128): board B's is not in it for `viewer`.
	'GET /api/cards/[id]/context': view((w) => `/api/cards/${w.A.card.id}/context`),
	// The card waits on a card of board B: it is listed withheld to a caller who
	// cannot open board B (card 2129), and the same in every answer below.
	'GET /api/cards/[id]/dependencies': view((w) => `/api/cards/${w.A.card.id}/dependencies`),
	'POST /api/cards/[id]/dependencies': [
		// The answer is the card's links as GET /api/cards/[id]/dependencies gives them.
		edit((w) => json(`/api/cards/${w.A.card.id}/dependencies`, { dependsOnCardId: w.A.loose.id })),
		across((w) => json(`/api/cards/${w.B.card.id}/dependencies`, { dependsOnCardId: w.A.card.id }), {
			of: "a link to another board's card"
		})
	],
	'DELETE /api/cards/[id]/dependencies': [
		edit((w) => json(`/api/cards/${w.A.other.id}/dependencies`, { dependsOnCardId: w.A.card.id })),
		...unlinking(
			(w) => json(`/api/cards/${w.B.loose.id}/dependencies`, { dependsOnCardId: w.A.loose.id }),
			(w) => json(`/api/cards/${w.A.loose.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			(w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.loose })
		)
	],
	'POST /api/cards/[id]/restore': edit((w) => `/api/cards/${w.A.archived.id}/restore`),
	'GET /api/cards/[id]/tokens': view((w) => `/api/cards/${w.A.card.id}/tokens`),
	'GET /api/cards/archived': signedIn(() => '/api/cards/archived', { nobody: 'empty' }),
	'GET /api/cards/export/csv': [
		signedIn(() => '/api/cards/export/csv', { of: 'every board the caller can open' }),
		view((w) => `/api/cards/export/csv?boardId=${w.A.board.id}`, { of: 'one board', filtered: true })
	],
	'PUT /api/cards/reorder': [
		edit((w) =>
			json('/api/cards/reorder', { updates: [{ id: w.A.card.id, columnId: w.A.cols['In Progress'].id, position: 0 }] })
		),
		across(
			(w) => json('/api/cards/reorder', { updates: [{ id: w.B.card.id, columnId: w.A.cols['To Do'].id, position: 0 }] }),
			{
				of: "a drop on another board's column",
				answers: 400,
				because: 'a reorder stays within one board, whoever makes it'
			}
		)
	],
	// "kept-to-board" is in the title of every card and subtask of both boards.
	// Whoever asks is answered, with the ones on a board they can open.
	'GET /api/cards/search': [
		view(() => '/api/cards/search?q=kept-to-board', { of: 'cards', filtered: true }),
		view(() => '/api/cards/search?q=kept-to-board&kinds=subtask', { of: 'subtasks', filtered: true }),
		view(() => '/api/cards/search?q=kept-to-board&kinds=card,subtask', { of: 'cards and subtasks', filtered: true })
	],

	// ── Card categories ───────────────────────────────────────────────────
	// Of no board, and of the boards the caller can open (card 2128).
	'GET /api/categories': signedIn(() => '/api/categories'),
	'POST /api/categories': [
		edit((w) => json('/api/categories', { boardId: w.A.board.id, name: 'A category' })),
		admin(() => json('/api/categories', { name: 'Belongs to no board' }), { of: 'one that belongs to no board' })
	],
	'PUT /api/categories/[id]': [
		edit((w) => json(`/api/categories/${w.A.category.id}`, { name: 'Renamed' })),
		admin((w) => json(`/api/categories/${w.sharedCategory.id}`, { name: 'Renamed' }), {
			of: 'one that belongs to no board'
		})
	],
	'DELETE /api/categories/[id]': [
		edit((w) => `/api/categories/${w.A.category.id}`),
		admin((w) => `/api/categories/${w.sharedCategory.id}`, { of: 'one that belongs to no board' })
	],

	// ── Columns ───────────────────────────────────────────────────────────
	'POST /api/columns': edit((w) => json('/api/columns', { boardId: w.A.board.id, title: 'A column' })),
	'PUT /api/columns/[id]': edit((w) => json(`/api/columns/${w.A.cols['Spare'].id}`, { title: 'Renamed' })),
	'DELETE /api/columns/[id]': edit((w) => `/api/columns/${w.A.cols['Spare'].id}`),
	'PUT /api/columns/reorder': edit((w) =>
		json('/api/columns/reorder', { updates: [{ id: w.A.cols['Spare'].id, position: 9 }] })
	),

	// ── Live events ───────────────────────────────────────────────────────
	// Every signed-in caller may listen. What they are sent is filtered event by event.
	'GET /api/events': signedIn(() => '/api/events', { stream: true }),

	// ── Labels ────────────────────────────────────────────────────────────
	'GET /api/labels': view((w) => `/api/labels?boardId=${w.A.board.id}`),
	'POST /api/labels': edit((w) => json('/api/labels', { boardId: w.A.board.id, name: 'A label', color: '#6366f1' })),
	'PUT /api/labels': [
		edit((w) => json('/api/labels', { cardId: w.A.card.id, labelId: w.A.label.id })),
		// Not `across`: the label is only looked at, so it asks for edit access to
		// the card's board and view access to the label's. `editsB` has just that.
		own('editsB', ['outsider', 'editor', 'editsA'], (w) => json('/api/labels', { cardId: w.B.card.id, labelId: w.A.label.id }), {
			of: "another board's label",
			answers: 400,
			because: 'a card takes only the labels of its own board, whoever asks'
		})
	],
	// Rename and recolour, as the card window's label picker does (card 2010).
	'PATCH /api/labels': edit((w) => json('/api/labels', { id: w.A.label.id, name: 'Renamed' })),
	'DELETE /api/labels': edit((w) => json('/api/labels', { id: w.A.label.id })),

	// ── Milestones ────────────────────────────────────────────────────────
	'GET /api/milestones': [
		signedIn(() => '/api/milestones', { of: 'every milestone the caller can see' }),
		view((w) => `/api/milestones?boardId=${w.A.board.id}`, { of: 'one board', filtered: true }),
		view((w) => `/api/milestones?forBoard=${w.A.board.id}`, { of: 'the ones a card of one board can join', filtered: true })
	],
	'POST /api/milestones': [
		signedIn(() => json('/api/milestones', { name: 'A goal across boards' }), { of: 'one that belongs to no board' }),
		edit((w) => json('/api/milestones', { name: 'A goal', boardId: w.A.board.id }))
	],
	'GET /api/milestones/[id]': [
		view((w) => `/api/milestones/${w.A.milestone.id}`),
		// One that belongs to no board is its maker's until it has cards, and then
		// it is for whoever can open every board those cards are on.
		own('owner', ['outsider', 'editor'], (w) => `/api/milestones/${w.goal.id}`, {
			of: 'one with no board and no card'
		}),
		view((w) => `/api/milestones/${w.goal.id}`, {
			of: 'one with no board, whose cards are on board A',
			setup: intoGoal((w) => [w.A.loose])
		}),
		own('both', ['outsider', 'editor', 'viewer'], (w) => `/api/milestones/${w.goal.id}`, {
			of: 'one with no board, whose cards are on both boards',
			setup: intoGoal((w) => [w.A.loose, w.B.loose])
		})
	],
	'PATCH /api/milestones/[id]': [
		edit((w) => json(`/api/milestones/${w.A.milestone.id}`, { name: 'Renamed' })),
		edit((w) => json(`/api/milestones/${w.A.milestone.id}`, { cardId: w.A.loose.id, attach: true }), {
			of: 'attaching a card'
		}),
		across((w) => json(`/api/milestones/${w.B.milestone.id}`, { cardId: w.A.loose.id, attach: true }), {
			of: "attaching another board's card",
			answers: 400,
			because: 'a milestone of one board takes no card of another, whoever asks'
		}),
		across((w) => json(`/api/milestones/${w.B.milestone.id}`, { boardId: w.A.board.id }), {
			of: 'moving it to another board'
		}),
		// `editor` can see it, its card being on board A, and did not make it.
		own('owner', ['outsider', 'editor', 'viewer'], (w) => json(`/api/milestones/${w.goal.id}`, { name: 'Renamed' }), {
			of: 'one with no board',
			setup: intoGoal((w) => [w.A.loose])
		}),
		// Taking a card out looks at the milestone in the path: whether the caller
		// may change it, whether it is there, and whether the card is in it (card
		// 2117, R5). It was never looked at, and the card was taken out of its own.
		across((w) => json(`/api/milestones/${w.B.milestone.id}`, { cardId: w.A.card.id, attach: false }), {
			of: "taking a card out through another board's milestone",
			answers: 404,
			because: 'the card is not in the milestone the path names, whoever asks'
		}),
		// A milestone that is not there is 404 to everyone signed in, before
		// anything else is looked at.
		signedIn((w) => json('/api/milestones/999999', { cardId: w.A.card.id, attach: false }), {
			of: 'taking a card out through a milestone that is not there',
			answers: 404,
			because: 'there is no such milestone, whoever asks'
		})
	],
	'DELETE /api/milestones/[id]': [
		edit((w) => `/api/milestones/${w.A.milestone.id}`),
		own('owner', ['outsider', 'editor', 'viewer'], (w) => `/api/milestones/${w.goal.id}`, {
			of: 'one with no board',
			setup: intoGoal((w) => [w.A.loose])
		})
	],
	'GET /api/milestones/[id]/pdf': view((w) => `/api/milestones/${w.A.milestone.id}/pdf`),
	'GET /api/milestones/[id]/summary': view((w) => `/api/milestones/${w.A.milestone.id}/summary`),

	// ── Reports ───────────────────────────────────────────────────────────
	'GET /api/report-schedules': signedIn(() => '/api/report-schedules'),
	'POST /api/report-schedules': [
		view((w) =>
			json('/api/report-schedules', { name: 'Weekly', scope: 'board', scopeId: w.A.board.id, frequency: 'weekly' })
		),
		// A grouping is for whoever can open a board under it, to be reported the boards they can open.
		view(
			(w) => json('/api/report-schedules', { name: 'Weekly', scope: 'category', scopeId: w.groupingOfA.id, frequency: 'weekly' }),
			{ of: 'a grouping of boards' }
		),
		signedIn(
			(w) => json('/api/report-schedules', { name: 'Weekly', scope: 'category', scopeId: w.grouping.id, frequency: 'weekly' }),
			{ of: 'a grouping with a board the caller can open' }
		),
		admin(() => json('/api/report-schedules', { name: 'Everything', scope: 'all', frequency: 'weekly' }), {
			of: 'every board'
		})
	],
	// An administrator is not let in either: a schedule is its maker's alone.
	'PUT /api/report-schedules/[id]': own('owner', ['outsider', 'editor', 'admin'], (w) =>
		json(`/api/report-schedules/${w.scheduleId}`, { name: 'Renamed' })
	),
	'DELETE /api/report-schedules/[id]': own(
		'owner',
		['outsider', 'editor', 'admin'],
		(w) => `/api/report-schedules/${w.scheduleId}`
	),
	'POST /api/reports': [
		view((w) => json('/api/reports', { scope: 'board', scopeId: w.A.board.id, ...WEEK })),
		view((w) => json('/api/reports', { scope: 'category', scopeId: w.groupingOfA.id, ...WEEK }), {
			of: 'a grouping of boards'
		}),
		// The answer is a PDF. What is in it for each caller is tested below the
		// table, where the report is read before it is drawn.
		signedIn((w) => json('/api/reports', { scope: 'category', scopeId: w.grouping.id, ...WEEK }), {
			of: 'a grouping with a board the caller can open'
		}),
		admin(() => json('/api/reports', { scope: 'all', ...WEEK }), { of: 'every board' })
	],
	'POST /api/reports/email': [
		view(
			(w) =>
				json('/api/reports/email', { scope: 'board', scopeId: w.A.board.id, ...WEEK, recipients: ['someone@example.test'] }),
			{ setup: makeSmtp }
		),
		view(
			(w) =>
				json('/api/reports/email', { scope: 'category', scopeId: w.groupingOfA.id, ...WEEK, recipients: ['someone@example.test'] }),
			{ of: 'a grouping of boards', setup: makeSmtp }
		),
		signedIn(
			(w) =>
				json('/api/reports/email', { scope: 'category', scopeId: w.grouping.id, ...WEEK, recipients: ['someone@example.test'] }),
			{ of: 'a grouping with a board the caller can open', setup: makeSmtp }
		),
		admin(() => json('/api/reports/email', { scope: 'all', ...WEEK, recipients: ['someone@example.test'] }), {
			of: 'every board',
			setup: makeSmtp
		})
	],

	// ── Task requests ─────────────────────────────────────────────────────
	'GET /api/requests': signedIn(() => '/api/requests'),
	// The public form. A caller who is signed in needs nothing more, and one
	// who is not sends the token the form was given when it was rendered.
	'POST /api/requests': form((w) => json('/api/requests', asking(w)), {
		withToken: (w, token) => ({ path: '/api/requests', headers: { 'x-form-token': token }, body: asking(w) })
	}),
	'GET /api/requests/targets': form(() => '/api/requests/targets', {
		withToken: (_w, token) => ({ path: '/api/requests/targets', headers: { 'x-form-token': token } }),
		// Its boards are the ones a signed-in caller can open, and none to a
		// holder of the token (card 2128): what is left of board A is the team.
		tellsEveryone: TEAM_NAMES
	}),
	'GET /api/requests/[id]': [
		link((w) => `/api/requests/${w.request.id}`, {
			withLink: (w) => `/api/requests/${w.request.id}?token=${LINK}`,
			addressee: true
		}),
		// `editor` is a member of the team and `viewer` is not.
		own('editor', ['outsider', 'viewer'], (w) => `/api/requests/${w.teamRequest.id}`, {
			of: 'one addressed to a team',
			opensByLink: true
		})
	],
	'PATCH /api/requests/[id]': [
		own('owner', ['outsider', 'editor'], (w) =>
			json(`/api/requests/${w.request.id}`, { action: 'reject', reason: 'Not this quarter' })
		),
		own(
			'editor',
			['outsider', 'viewer'],
			(w) => json(`/api/requests/${w.teamRequest.id}`, { action: 'reject', reason: 'Not this quarter' }),
			{ of: 'one addressed to a team' }
		),
		// Accepting makes a card, on the board and in the column the body names.
		// `guest` is a member of the team too, and can only view board A.
		own(
			'editor',
			['outsider', 'viewer', 'guest'],
			(w) =>
				json(`/api/requests/${w.teamRequest.id}`, {
					action: 'accept',
					boardId: w.A.board.id,
					columnId: w.A.cols['To Do'].id
				}),
			{ of: 'accepting one onto a board' }
		)
	],
	'DELETE /api/requests/[id]': admin((w) => `/api/requests/${w.request.id}`),
	'POST /api/requests/[id]/confirm': link((w) => json(`/api/requests/${w.unconfirmed.id}/confirm`, {}), {
		withLink: (w) => json(`/api/requests/${w.unconfirmed.id}/confirm`, { token: UNCONFIRMED_LINK })
	}),
	'GET /api/requests/[id]/messages': [
		link((w) => `/api/requests/${w.request.id}/messages`, {
			withLink: (w) => `/api/requests/${w.request.id}/messages?token=${LINK}`,
			addressee: true
		}),
		own('editor', ['outsider', 'viewer'], (w) => `/api/requests/${w.teamRequest.id}/messages`, {
			of: 'of one addressed to a team',
			opensByLink: true
		})
	],
	'POST /api/requests/[id]/messages': [
		own('owner', ['outsider', 'editor'], (w) => json(`/api/requests/${w.request.id}/messages`, { message: 'On it' }), {
			of: 'an answer from the one it is addressed to'
		}),
		own(
			'editor',
			['outsider', 'viewer'],
			(w) => json(`/api/requests/${w.teamRequest.id}/messages`, { message: 'On it' }),
			{ of: 'an answer from a member of the team it is addressed to' }
		),
		link((w) => json(`/api/requests/${w.request.id}/messages`, { message: 'Thanks', senderType: 'requester' }), {
			of: 'a reply from the requester',
			withLink: (w) =>
				json(`/api/requests/${w.request.id}/messages`, { message: 'Thanks', senderType: 'requester', token: LINK })
		})
	],

	// ── Subtasks ──────────────────────────────────────────────────────────
	'GET /api/subtasks': view((w) => `/api/subtasks?cardId=${w.A.card.id}`),
	'POST /api/subtasks': edit((w) => json('/api/subtasks', { cardId: w.A.card.id, title: 'A subtask' })),
	'PUT /api/subtasks/[id]': edit((w) => json(`/api/subtasks/${w.A.sub.id}`, { title: 'Renamed' })),
	'DELETE /api/subtasks/[id]': edit((w) => `/api/subtasks/${w.A.sub.id}`),
	'GET /api/subtasks/[id]/dependencies': view((w) => `/api/subtasks/${w.A.sub.id}/dependencies`),
	'POST /api/subtasks/[id]/dependencies': [
		edit((w) => json(`/api/subtasks/${w.A.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id })),
		across((w) => json(`/api/subtasks/${w.B.sub.id}/dependencies`, { dependsOnCardId: w.A.card.id }), {
			of: "a link to another board's card"
		})
	],
	'DELETE /api/subtasks/[id]/dependencies': [
		edit((w) => json(`/api/subtasks/${w.A.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id }), {
			setup: (w) => void makeDependency({ blocked: w.A.sub, blocker: w.A.loose })
		}),
		// Board B's subtask waits on a card of board A, and a card of board B waits on board A's subtask.
		...unlinking(
			(w) => json(`/api/subtasks/${w.B.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id }),
			(w) => json(`/api/subtasks/${w.A.otherSub.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			(w) => {
				makeDependency({ blocked: w.B.sub, blocker: w.A.loose });
				makeDependency({ blocked: w.B.loose, blocker: w.A.otherSub });
			}
		)
	],

	// ── Teams ─────────────────────────────────────────────────────────────
	// Its members only to the team's own and to an administrator (card 2128).
	'GET /api/teams': signedIn(() => '/api/teams', { tellsEveryone: TEAM_NAMES }),
	'POST /api/teams': signedIn(() => json('/api/teams', { name: 'A team' })),
	// `editor` is a member of the team and does not own it.
	'PUT /api/teams/[id]': own('owner', ['outsider', 'editor'], (w) => json(`/api/teams/${w.team.id}`, { name: 'Renamed' })),
	'DELETE /api/teams/[id]': own('owner', ['outsider', 'editor'], (w) => `/api/teams/${w.team.id}`),
	'POST /api/teams/[id]/members/[userId]': own('owner', ['outsider', 'editor'], (w) =>
		json(`/api/teams/${w.team.id}/members/${w.viewer.id}`, { userId: w.viewer.id })
	),
	'DELETE /api/teams/[id]/members/[userId]': own(
		'owner',
		['outsider', 'editor'],
		(w) => `/api/teams/${w.team.id}/members/${w.editor.id}`
	),

	// ── Card templates ────────────────────────────────────────────────────
	'GET /api/templates': [
		signedIn(() => '/api/templates', { of: 'every template the caller can see' }),
		view((w) => `/api/templates?boardId=${w.A.board.id}`, { of: 'one board' })
	],
	'POST /api/templates': [
		signedIn(() => json('/api/templates', { name: 'A template for every board', title: 'A card' }), {
			of: 'one that belongs to no board'
		}),
		edit((w) => json('/api/templates', { boardId: w.A.board.id, name: 'A template', title: 'A card' }))
	],
	// `editor` made board A's template. The owner can edit the board and did not make it.
	'DELETE /api/templates/[id]': [
		own('editor', ['outsider', 'owner'], (w) => `/api/templates/${w.A.templateId}`),
		// `outsider` saved it on board A when they could open it. Having made it
		// does not let them back in, and an administrator deletes it as before.
		own('admin', ['outsider', 'owner'], (w) => `/api/templates/${w.formerTemplateId}`, {
			of: 'one whose maker has lost the board'
		}),
		// `viewer` saved it when they could edit board A, and can now only view
		// it. Saving a template on a board asks for edit access, and so does
		// deleting one: they may not delete what they may no longer save.
		own('admin', ['viewer'], (w) => `/api/templates/${w.A.templateId}`, {
			of: 'one whose maker can now only view the board',
			setup: (w) =>
				void db.update(cardTemplates).set({ createdBy: w.viewer.id }).where(eq(cardTemplates.id, w.A.templateId)).run()
		}),
		// Saved on no board, it has no board to ask about: its maker's, and nobody else's.
		own('outsider', ['editor', 'owner'], (w) => `/api/templates/${w.sharedTemplateId}`, {
			of: 'one that belongs to no board'
		})
	],

	// ── Users ─────────────────────────────────────────────────────────────
	'GET /api/users': signedIn(() => '/api/users'),
	'POST /api/users': admin(() =>
		json('/api/users', { username: 'newcomer', email: 'newcomer@example.test', password: 'a long password' })
	),
	'PUT /api/users/[id]': admin((w) => json(`/api/users/${w.viewer.id}`, { emoji: '🦊' })),
	'DELETE /api/users/[id]': admin((w) => `/api/users/${w.viewer.id}`),
	'POST /api/users/[id]/invite': admin((w) => `/api/users/${w.viewer.id}/invite`, { setup: makeSmtp }),
	// The path names `owner`. Their own password is changed at /api/account/password,
	// which asks for the one they have: here they are refused, as anyone is
	// who names their own account.
	'PUT /api/users/[id]/password': admin((w) => json(`/api/users/${w.owner.id}/password`, { password: 'a long password' })),

	// ── The documented API ────────────────────────────────────────────────
	'GET /api/v1/openapi.json': open(() => '/api/v1/openapi.json'),
	'GET /api/v1/me': signedIn(() => '/api/v1/me'),
	// `outsider`'s entry on board A, from when they could open it, is not in
	// recentActivity (card 2126): see "recent activity" below the table.
	'GET /api/v1/me/stats': signedIn(() => '/api/v1/me/stats'),
	'GET /api/v1/audit-log': admin(() => '/api/v1/audit-log'),
	'GET /api/v1/burndown': [
		signedIn(() => '/api/v1/burndown', { of: 'every board the caller can open' }),
		view((w) => `/api/v1/burndown?boardIds=${w.A.board.id}`, { of: 'one board' }),
		view((w) => `/api/v1/burndown?milestoneId=${w.A.milestone.id}`, { of: 'one milestone' }),
		view((w) => `/api/v1/burndown?boardCategoryId=${w.grouping.id}`, { of: 'a grouping of boards', filtered: true }),
		view((w) => `/api/v1/burndown?boardCategoryId=${w.groupingOfA.id}`, { of: 'a grouping with no board the caller can open' })
	],
	'GET /api/v1/reports/activity': [
		signedIn(() => '/api/v1/reports/activity', { of: "the caller's own activity" }),
		view((w) => `/api/v1/reports/activity?boardIds=${w.A.board.id}`, { of: 'one board', filtered: true }),
		admin((w) => `/api/v1/reports/activity?userId=${w.editor.id}`, { of: "another user's activity" })
	],

	'GET /api/v1/board-categories': signedIn(() => '/api/v1/board-categories'),
	'POST /api/v1/board-categories': signedIn(() => json('/api/v1/board-categories', { name: 'A grouping' })),
	'GET /api/v1/board-categories/[categoryId]': [
		signedIn((w) => `/api/v1/board-categories/${w.grouping.id}`, { of: 'one with a board the caller can open' }),
		view((w) => `/api/v1/board-categories/${w.groupingOfA.id}`, { of: 'one with no board the caller can open' })
	],
	// Both boards are filed under it: see PUT /api/board-categories/[id].
	'PUT /api/v1/board-categories/[categoryId]': across((w) =>
		json(`/api/v1/board-categories/${w.grouping.id}`, { name: 'Renamed' })
	),
	'DELETE /api/v1/board-categories/[categoryId]': across((w) => `/api/v1/board-categories/${w.grouping.id}`),

	'GET /api/v1/boards': signedIn(() => '/api/v1/boards'),
	'POST /api/v1/boards': [
		signedIn(() => json('/api/v1/boards', { name: 'A new board' })),
		edit((w) => json('/api/v1/boards', { name: 'A sub-board', parentCardId: w.A.card.id }), {
			of: 'a sub-board of a card'
		})
	],
	'GET /api/v1/boards/[boardId]': [
		view((w) => `/api/v1/boards/${w.A.board.id}`),
		own('guest', ['outsider'], (w) => `/api/v1/boards/${w.A.board.id}`, {
			of: 'through a team the board is shared with'
		}),
		signedIn((w) => `/api/v1/boards/${w.publicBoard.board.id}`, { of: 'a public board' })
	],
	'PUT /api/v1/boards/[boardId]': [
		edit((w) => json(`/api/v1/boards/${w.A.board.id}`, { name: 'Renamed' })),
		owns((w) => json(`/api/v1/boards/${w.A.board.id}`, { isPublic: true }), {
			of: 'making the board public'
		})
	],
	'DELETE /api/v1/boards/[boardId]': owns((w) => `/api/v1/boards/${w.A.board.id}`),
	'GET /api/v1/boards/[boardId]/cards': view((w) => `/api/v1/boards/${w.A.board.id}/cards`),
	'POST /api/v1/boards/[boardId]/cards': edit((w) =>
		json(`/api/v1/boards/${w.A.board.id}/cards`, { title: 'A new card', columnId: w.A.cols['To Do'].id })
	),
	'GET /api/v1/boards/[boardId]/categories': view((w) => `/api/v1/boards/${w.A.board.id}/categories`),
	'POST /api/v1/boards/[boardId]/categories': edit((w) =>
		json(`/api/v1/boards/${w.A.board.id}/categories`, { name: 'A category' })
	),
	'GET /api/v1/boards/[boardId]/columns': view((w) => `/api/v1/boards/${w.A.board.id}/columns`),
	'POST /api/v1/boards/[boardId]/columns': edit((w) => json(`/api/v1/boards/${w.A.board.id}/columns`, { title: 'A column' })),
	'GET /api/v1/boards/[boardId]/labels': view((w) => `/api/v1/boards/${w.A.board.id}/labels`),
	'POST /api/v1/boards/[boardId]/labels': edit((w) =>
		json(`/api/v1/boards/${w.A.board.id}/labels`, { name: 'A label', color: '#6366f1' })
	),
	'GET /api/v1/boards/[boardId]/webhooks': view((w) => `/api/v1/boards/${w.A.board.id}/webhooks`),
	'POST /api/v1/boards/[boardId]/webhooks': edit((w) =>
		json(`/api/v1/boards/${w.A.board.id}/webhooks`, { url: 'https://hooks.example.test/new' })
	),

	'GET /api/v1/cards/[cardId]': view((w) => `/api/v1/cards/${w.A.card.id}`),
	'PUT /api/v1/cards/[cardId]': [
		edit((w) => json(`/api/v1/cards/${w.A.card.id}`, { title: 'Renamed' })),
		across((w) => json(`/api/v1/cards/${w.B.card.id}`, { milestoneId: w.A.milestone.id }), {
			of: "joining another board's milestone",
			answers: 400,
			because: 'a milestone of one board takes no card of another, whoever asks'
		}),
		own('owner', ['outsider', 'editor'], (w) => json(`/api/v1/cards/${w.publicBoard.card.id}`, { title: 'Renamed' }), {
			of: 'a card on a public board'
		})
	],
	'DELETE /api/v1/cards/[cardId]': [
		edit((w) => `/api/v1/cards/${w.A.card.id}`, { of: 'an archive' }),
		edit((w) => `/api/v1/cards/${w.A.card.id}?permanent=true`, { of: 'a permanent delete' })
	],
	'GET /api/v1/cards/[cardId]/assignees': view((w) => `/api/v1/cards/${w.A.card.id}/assignees`),
	'POST /api/v1/cards/[cardId]/assignees': edit((w) =>
		json(`/api/v1/cards/${w.A.card.id}/assignees`, { userId: w.viewer.id })
	),
	'DELETE /api/v1/cards/[cardId]/assignees': edit((w) =>
		json(`/api/v1/cards/${w.A.card.id}/assignees`, { userId: w.editor.id })
	),
	'GET /api/v1/cards/[cardId]/board-history': view((w) => `/api/v1/cards/${w.A.card.id}/board-history`),
	'GET /api/v1/cards/[cardId]/comments': view((w) => `/api/v1/cards/${w.A.card.id}/comments`),
	'POST /api/v1/cards/[cardId]/comments': edit((w) =>
		json(`/api/v1/cards/${w.A.card.id}/comments`, { content: 'A comment' })
	),
	'GET /api/v1/cards/[cardId]/dependencies': view((w) => `/api/v1/cards/${w.A.card.id}/dependencies`),
	'POST /api/v1/cards/[cardId]/dependencies': [
		edit((w) => json(`/api/v1/cards/${w.A.card.id}/dependencies`, { dependsOnCardId: w.A.loose.id })),
		across((w) => json(`/api/v1/cards/${w.B.card.id}/dependencies`, { dependsOnCardId: w.A.card.id }), {
			of: "a link to another board's card"
		})
	],
	'DELETE /api/v1/cards/[cardId]/dependencies': [
		edit((w) => json(`/api/v1/cards/${w.A.other.id}/dependencies`, { dependsOnCardId: w.A.card.id })),
		...unlinking(
			(w) => json(`/api/v1/cards/${w.B.loose.id}/dependencies`, { dependsOnCardId: w.A.loose.id }),
			(w) => json(`/api/v1/cards/${w.A.loose.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			(w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.loose })
		)
	],
	'GET /api/v1/cards/[cardId]/labels': view((w) => `/api/v1/cards/${w.A.card.id}/labels`),
	'POST /api/v1/cards/[cardId]/labels': edit((w) => json(`/api/v1/cards/${w.A.card.id}/labels`, { labelId: w.A.label.id })),
	'DELETE /api/v1/cards/[cardId]/labels': edit((w) => json(`/api/v1/cards/${w.A.card.id}/labels`, { labelId: w.A.label.id }), {
		setup: (w) => void db.insert(cardLabels).values({ cardId: w.A.card.id, labelId: w.A.label.id }).run()
	}),
	'PUT /api/v1/cards/[cardId]/move': [
		edit((w) => json(`/api/v1/cards/${w.A.card.id}/move`, { columnId: w.A.cols['In Progress'].id })),
		across((w) => json(`/api/v1/cards/${w.B.card.id}/move`, { columnId: w.A.cols['To Do'].id }), {
			of: "a move to another board's column"
		})
	],
	'GET /api/v1/cards/[cardId]/subtasks': view((w) => `/api/v1/cards/${w.A.card.id}/subtasks`),
	'POST /api/v1/cards/[cardId]/subtasks': edit((w) => json(`/api/v1/cards/${w.A.card.id}/subtasks`, { title: 'A subtask' })),
	'GET /api/v1/cards/[cardId]/tokens': view((w) => `/api/v1/cards/${w.A.card.id}/tokens`),
	'POST /api/v1/cards/[cardId]/tokens': edit((w) => json(`/api/v1/cards/${w.A.card.id}/tokens`, TOKENS)),

	// A category is its board's to read, and one of no board everybody's (card 2128).
	'GET /api/v1/categories/[categoryId]': [
		view((w) => `/api/v1/categories/${w.A.category.id}`),
		signedIn((w) => `/api/v1/categories/${w.sharedCategory.id}`, { of: 'one that belongs to no board' })
	],
	'PUT /api/v1/categories/[categoryId]': [
		edit((w) => json(`/api/v1/categories/${w.A.category.id}`, { name: 'Renamed' })),
		admin((w) => json(`/api/v1/categories/${w.sharedCategory.id}`, { name: 'Renamed' }), {
			of: 'one that belongs to no board'
		})
	],
	'DELETE /api/v1/categories/[categoryId]': [
		edit((w) => `/api/v1/categories/${w.A.category.id}`),
		admin((w) => `/api/v1/categories/${w.sharedCategory.id}`, { of: 'one that belongs to no board' })
	],

	'GET /api/v1/columns/[columnId]': view((w) => `/api/v1/columns/${w.A.cols['Spare'].id}`),
	'PUT /api/v1/columns/[columnId]': edit((w) => json(`/api/v1/columns/${w.A.cols['Spare'].id}`, { title: 'Renamed' })),
	'DELETE /api/v1/columns/[columnId]': edit((w) => `/api/v1/columns/${w.A.cols['Spare'].id}`),

	'GET /api/v1/comments/[commentId]': view((w) => `/api/v1/comments/${w.A.comment.id}`),
	'PUT /api/v1/comments/[commentId]': [
		own('editor', ['outsider', 'viewer', 'owner'], (w) => json(`/api/v1/comments/${w.A.comment.id}`, { content: 'Edited' })),
		own('admin', ['outsider'], (w) => json(`/api/v1/comments/${w.formerComment.id}`, { content: 'Edited' }), {
			of: 'a comment whose author has lost the board'
		}),
		// `viewer` wrote it when they could edit board A, and can now only view
		// it. Posting a comment asks for edit access, and so does changing one,
		// here as on PUT /api/cards/[id]/comments/[commentId]: this route asked
		// for view access, and an author made a viewer could rewrite through it
		// what the other route refused them.
		own('admin', ['viewer'], (w) => json(`/api/v1/comments/${w.A.comment.id}`, { content: 'Edited' }), {
			of: 'a comment whose author can now only view the board',
			setup: (w) => void db.update(cardComments).set({ userId: w.viewer.id }).where(eq(cardComments.id, w.A.comment.id)).run()
		})
	],

	'POST /api/v1/dependencies/bulk': [
		edit((w) => json('/api/v1/dependencies/bulk', { links: [{ blocked: w.A.loose.id, blocker: w.A.card.id }] }), {
			refusedAs: 409
		}),
		across((w) => json('/api/v1/dependencies/bulk', { links: [{ blocked: w.B.card.id, blocker: w.A.card.id }] }), {
			of: 'a link between two boards',
			refusedAs: 409
		})
	],

	'GET /api/v1/labels/[labelId]': view((w) => `/api/v1/labels/${w.A.label.id}`),
	'PUT /api/v1/labels/[labelId]': edit((w) => json(`/api/v1/labels/${w.A.label.id}`, { name: 'Renamed' })),
	'DELETE /api/v1/labels/[labelId]': edit((w) => `/api/v1/labels/${w.A.label.id}`),

	'GET /api/v1/milestones': [
		signedIn(() => '/api/v1/milestones', { of: 'every milestone the caller can see' }),
		view((w) => `/api/v1/milestones?boardId=${w.A.board.id}`, { of: 'one board', filtered: true })
	],
	'POST /api/v1/milestones': [
		signedIn(() => json('/api/v1/milestones', { name: 'A goal across boards' }), { of: 'one that belongs to no board' }),
		edit((w) => json('/api/v1/milestones', { name: 'A goal', boardId: w.A.board.id }))
	],
	'GET /api/v1/milestones/[milestoneId]': [
		view((w) => `/api/v1/milestones/${w.A.milestone.id}`),
		// As for GET /api/milestones/[id]: its maker's until it has cards, and
		// then for whoever can open every board those cards are on.
		own('owner', ['outsider', 'editor'], (w) => `/api/v1/milestones/${w.goal.id}`, {
			of: 'one with no board and no card'
		}),
		view((w) => `/api/v1/milestones/${w.goal.id}`, {
			of: 'one with no board, whose cards are on board A',
			setup: intoGoal((w) => [w.A.loose])
		}),
		own('both', ['outsider', 'editor', 'viewer'], (w) => `/api/v1/milestones/${w.goal.id}`, {
			of: 'one with no board, whose cards are on both boards',
			setup: intoGoal((w) => [w.A.loose, w.B.loose])
		})
	],
	'PATCH /api/v1/milestones/[milestoneId]': [
		edit((w) => json(`/api/v1/milestones/${w.A.milestone.id}`, { name: 'Renamed' })),
		across((w) => json(`/api/v1/milestones/${w.B.milestone.id}`, { boardId: w.A.board.id }), {
			of: 'moving it to another board'
		}),
		own('owner', ['outsider', 'editor', 'viewer'], (w) => json(`/api/v1/milestones/${w.goal.id}`, { name: 'Renamed' }), {
			of: 'one with no board',
			setup: intoGoal((w) => [w.A.loose])
		})
	],
	'DELETE /api/v1/milestones/[milestoneId]': [
		edit((w) => `/api/v1/milestones/${w.A.milestone.id}`),
		own('owner', ['outsider', 'editor', 'viewer'], (w) => `/api/v1/milestones/${w.goal.id}`, {
			of: 'one with no board',
			setup: intoGoal((w) => [w.A.loose])
		})
	],
	'POST /api/v1/milestones/[milestoneId]/cards': [
		edit((w) => json(`/api/v1/milestones/${w.A.milestone.id}/cards`, { cardId: w.A.loose.id })),
		across((w) => json(`/api/v1/milestones/${w.B.milestone.id}/cards`, { cardId: w.A.loose.id }), {
			of: "another board's card",
			answers: 400,
			because: 'a milestone of one board takes no card of another, whoever asks'
		})
	],
	'DELETE /api/v1/milestones/[milestoneId]/cards': [
		edit((w) => json(`/api/v1/milestones/${w.A.milestone.id}/cards`, { cardId: w.A.card.id })),
		// The card is in board A's milestone, and not in the one named. It was
		// taken out of its own (card 2117, R5).
		across((w) => json(`/api/v1/milestones/${w.B.milestone.id}/cards`, { cardId: w.A.card.id }), {
			of: "another board's card",
			answers: 404,
			because: 'the card is not in the milestone the path names, whoever asks'
		})
	],
	'POST /api/v1/milestones/[milestoneId]/cards/bulk': [
		edit((w) => json(`/api/v1/milestones/${w.A.milestone.id}/cards/bulk`, { cardIds: [w.A.loose.id] })),
		// A milestone of one board takes no card of another, so the card of a
		// second board goes into the one that belongs to none. `owner` made that
		// milestone and may change it, and cannot edit board B: the 409 says so.
		// Asked of board B's own milestone, the caller who may do everything is
		// answered 409 as well, for the other reason, and a refusal that is the
		// same status as the allowed answer shows nothing.
		own('admin', ['outsider', 'owner'], (w) => json(`/api/v1/milestones/${w.goal.id}/cards/bulk`, { cardIds: [w.B.loose.id] }), {
			of: "a card of a board the caller cannot edit",
			refusedAs: 409
		})
	],
	'DELETE /api/v1/milestones/[milestoneId]/cards/bulk': [
		edit((w) => json(`/api/v1/milestones/${w.A.milestone.id}/cards/bulk`, { cardIds: [w.A.card.id] })),
		across((w) => json(`/api/v1/milestones/${w.B.milestone.id}/cards/bulk`, { cardIds: [w.A.card.id] }), {
			of: "another board's card",
			refusedAs: 409
		})
	],
	'GET /api/v1/milestones/[milestoneId]/pdf': view((w) => `/api/v1/milestones/${w.A.milestone.id}/pdf`),
	'GET /api/v1/milestones/[milestoneId]/summary': view((w) => `/api/v1/milestones/${w.A.milestone.id}/summary`),

	'PUT /api/v1/subtasks/[subtaskId]': edit((w) => json(`/api/v1/subtasks/${w.A.sub.id}`, { title: 'Renamed' })),
	'DELETE /api/v1/subtasks/[subtaskId]': edit((w) => `/api/v1/subtasks/${w.A.sub.id}`),
	'GET /api/v1/subtasks/[subtaskId]/dependencies': view((w) => `/api/v1/subtasks/${w.A.sub.id}/dependencies`),
	'POST /api/v1/subtasks/[subtaskId]/dependencies': [
		edit((w) => json(`/api/v1/subtasks/${w.A.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id })),
		across((w) => json(`/api/v1/subtasks/${w.B.sub.id}/dependencies`, { dependsOnCardId: w.A.card.id }), {
			of: "a link to another board's card"
		})
	],
	'DELETE /api/v1/subtasks/[subtaskId]/dependencies': [
		edit((w) => json(`/api/v1/subtasks/${w.A.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id }), {
			setup: (w) => void makeDependency({ blocked: w.A.sub, blocker: w.A.loose })
		}),
		...unlinking(
			(w) => json(`/api/v1/subtasks/${w.B.sub.id}/dependencies`, { dependsOnCardId: w.A.loose.id }),
			(w) => json(`/api/v1/subtasks/${w.A.otherSub.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			(w) => {
				makeDependency({ blocked: w.B.sub, blocker: w.A.loose });
				makeDependency({ blocked: w.B.loose, blocker: w.A.otherSub });
			}
		)
	],
	'POST /api/v1/subtasks/[subtaskId]/tokens': edit((w) => json(`/api/v1/subtasks/${w.A.sub.id}/tokens`, TOKENS)),

	'DELETE /api/v1/tokens/[entryId]': edit((w) => `/api/v1/tokens/${w.A.tokenEntryId}`),
	'POST /api/v1/tokens/bulk': edit((w) => json('/api/v1/tokens/bulk', { entries: [{ cardId: w.A.card.id, ...TOKENS }] }), {
		refusedAs: 409
	}),

	'GET /api/v1/webhooks/[webhookId]': view((w) => `/api/v1/webhooks/${w.A.webhookId}`),
	'PUT /api/v1/webhooks/[webhookId]': edit((w) => json(`/api/v1/webhooks/${w.A.webhookId}`, { active: false })),
	'DELETE /api/v1/webhooks/[webhookId]': edit((w) => `/api/v1/webhooks/${w.A.webhookId}`)
};

// ─── Who each kind refuses and lets in ─────────────────────────────────────

/** For each kind: the signed-in callers it refuses, and the one it lets in. */
const RULES: Record<Exclude<Kind, 'public' | 'own' | 'link' | 'form'>, { refuses: Who[]; allows: Who }> = {
	'signed-in': { refuses: [], allows: 'outsider' },
	view: { refuses: ['outsider'], allows: 'viewer' },
	// `guest` can view the board, as `viewer` can, and by another way: a team.
	edit: { refuses: ['outsider', 'viewer', 'guest'], allows: 'editor' },
	owner: { refuses: ['outsider', 'viewer', 'guest', 'editor'], allows: 'owner' },
	// `outsider` can edit what the path names and `editor` what the body names.
	// `editsB` and `editsA` can each edit one of the two and view the other.
	across: { refuses: ['outsider', 'editor', 'editsB', 'editsA'], allows: 'both' },
	// `owner` owns a board and is no administrator.
	admin: { refuses: ['outsider', 'owner'], allows: 'admin' },
	// An administrator is refused with everybody else: only the one account is let in.
	superadmin: { refuses: ['outsider', 'owner', 'admin'], allows: 'chief' }
};

function refusedBy(c: Case): Who[] {
	if (c.kind === 'public') return [];
	if (c.kind === 'own') return ['nobody', ...(c.notMine ?? [])];
	if (c.kind === 'link') return ['nobody', 'outsider'];
	// With no token. A token that is wrong has tests of its own.
	if (c.kind === 'form') return ['nobody'];
	return ['nobody', ...RULES[c.kind].refuses];
}

function allowedBy(c: Case): Who {
	if (c.kind === 'public') return 'nobody';
	if (c.kind === 'own') return c.mine!;
	if (c.kind === 'link') return 'owner';
	// Signed in, the form's routes ask for nothing more.
	if (c.kind === 'form') return 'outsider';
	return RULES[c.kind].allows;
}

// ─── Making the requests ───────────────────────────────────────────────────

let w: World;
let sent: Effects;

beforeEach(() => {
	resetDb();
	// The public form's routes count requests by address, and every request here has one address.
	resetAllRateLimits();
	w = world();
	// Nothing leaves the tests: a webhook delivery and a mail are recorded and not sent.
	sent = effects();
});

afterEach(() => sent.restore());

const parts = (req: Req): Exclude<Req, string> => (typeof req === 'string' ? { path: req } : req);

/**
 * A world in which every id is undefined, for reading the shape of a request
 * while the tests are being made, before there is a database to make one from.
 */
const HOLLOW: World = new Proxy({} as World, {
	get: function hollow(): unknown {
		return new Proxy(() => {}, { get: hollow });
	}
});

/** The route's own pattern must be the one the path reaches, or the entry tests another route. */
function expectPathOf(pattern: string, path: string): void {
	const shape = new RegExp(`^${pattern.replace(/\[[^\]]+\]/g, '[^/]+')}$`);
	expect(path.split('?')[0], `the request made for ${pattern}`).toMatch(shape);
}

function call(method: Method, pattern: string, req: Req, who: Who): Promise<ApiResult> {
	const { path, body, headers } = parts(req);
	expectPathOf(pattern, path);
	return api(method, path, { user: who === 'nobody' ? null : w[who], body, headers: asCaller(headers, who) });
}

/** Every file in the tests' uploads folder, the trash included. */
function uploadedFiles(): string[] {
	const dir = testUploadsDir();
	return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : [];
}

/**
 * The request, refused: one of `statuses`, no row changed, no file written
 * and nothing sent. `made` is the request, where it is not the case's own.
 */
async function expectRefused(
	method: Method,
	pattern: string,
	c: Case,
	who: Who,
	statuses: number[],
	made: (w: World) => Req = c.req
): Promise<void> {
	c.setup?.(w);
	const req = made(w);
	const before = snapshotDb();
	const filesBefore = uploadedFiles();
	// An upload is not read for a caller who is going to be refused. A handler
	// that read it, wrote the file and took it away again on finding the caller
	// had no access would leave the folder as it was: this is how it is seen.
	const read = parts(req).body instanceof FormData ? vi.spyOn(Request.prototype, 'formData') : undefined;

	try {
		const res = await call(method, pattern, req, who);
		await sent.settle();

		expect(statuses, `answered ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
		// A bulk endpoint answers 409 for a batch it will not write, whatever is
		// wrong with it. It is a refusal only when it says the caller has no access.
		if (res.status === 409) expect(asText(res), 'a 409 that refuses says so').toMatch(/No (edit )?access/);
		expectUnchanged(before);
		expect(uploadedFiles(), 'the files in the uploads folder').toEqual(filesBefore);
		if (read) expect(read, 'the upload was read').not.toHaveBeenCalled();
		expect(sent.all).toEqual([]);
	} finally {
		read?.mockRestore();
	}
}

/**
 * What a refused caller is answered: 403 or 404 if signed in, 401 or 403 if
 * not. Never the status the allowed caller is answered: a case that carries
 * `answers` would then pass with no access check in the handler at all.
 */
function refusals(c: Case, who: Who): number[] {
	const statuses =
		who !== 'nobody'
			? [403, 404, ...(c.refusedAs ? [c.refusedAs] : [])]
			: c.kind === 'link' || c.kind === 'form' || c.opensByLink
				? [401, 403, 404]
				: [401, 403];
	return statuses.filter((status) => status !== c.answers);
}

/**
 * The request the holder of a link makes, with the link of another request in
 * the place of its own: a real link, and the wrong one.
 */
function withAnotherLink(req: Req): Req {
	const swap = (text: string) =>
		text.replaceAll(LINK, TEAM_LINK).replaceAll(UNCONFIRMED_LINK, LINK).replaceAll(TEAM_LINK, UNCONFIRMED_LINK);
	const { path, body, headers } = parts(req);
	return { path: swap(path), body: body === undefined ? undefined : JSON.parse(swap(JSON.stringify(body))), headers };
}

/**
 * Tokens for the public form that are not good, by what is wrong with each.
 * Each is made in the test that sends it: the first is a real one, signed with
 * the key the application keeps, for a form rendered three hours ago.
 */
const WRONG_TOKENS: Record<string, () => string> = {
	'that has expired': () => issueFormToken(Date.now() - 3 * 60 * 60 * 1000),
	'signed with another key': () => `${Date.now() + 60 * 60 * 1000}.${'0'.repeat(16)}.${'0'.repeat(64)}`,
	'that is not a token at all': () => 'let-me-in'
};

const titled = (c: Case, text: string) => (c.of ? `${c.of}: ${text}` : text);

/**
 * True for a request that `outsider` is refused and that carries a JSON body
 * with no board id of its own: the request to which a `boardId` can be added.
 * The world is not needed to tell, only the shape of the request, so it is
 * asked of a world made of nothing.
 */
function spoofable(c: Case): boolean {
	// An administrator's route is not asked: the board it would name is the request itself.
	if (!['view', 'edit', 'owner', 'own'].includes(c.kind)) return false;
	if (!refusedBy(c).includes('outsider') || c.filtered) return false;
	const body = parts(c.req(HOLLOW)).body;
	return typeof body === 'object' && body !== null && !(body instanceof FormData) && !('boardId' in body);
}

/** How a test of a fault begins its name, with the card the fault is on if it has one. */
const known = (fault: { card?: number }) => `KNOWN FAULT${fault.card ? ` (card ${fault.card})` : ''}`;

/** An answer as the text a caller reads. */
const asText = (res: ApiResult) => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body));

// ─── The tests ─────────────────────────────────────────────────────────────

describe('the table', () => {
	// It loads every route's module to ask its methods, which is slow the first
	// time, with every other file loading too: `docker build` runs this.
	it('has an entry for every route and method, and none for a route or method that is not there', { timeout: 60_000 }, async () => {
		const tree: string[] = [];
		const unspoken: string[] = [];
		for (const pattern of routePatterns()) {
			for (const method of await routeMethods(pattern)) {
				// `fallback` answers every method its route has no export for, and
				// OPTIONS and HEAD are answered for a route by SvelteKit unless it
				// exports its own. The table has no way to say who may call one.
				(['fallback', 'OPTIONS', 'HEAD'].includes(method) ? unspoken : tree).push(`${method} ${pattern}`);
			}
		}

		const missing = tree.filter((key) => !(key in TABLE));
		const stale = Object.keys(TABLE).filter((key) => !tree.includes(key));

		// Each message ends with the names: vitest shortens a long list to its
		// length in the line that says what failed.
		const named = (what: string, names: string[]) => `${what}: ${names.join(', ')}`;

		// A route with no entry is a route nobody has said who may call.
		expect(missing, named('routes and methods with no entry in TABLE', missing)).toEqual([]);
		expect(stale, named('entries in TABLE for a route or method that is not there', stale)).toEqual([]);
		expect(unspoken, named('handlers the table cannot describe, a fallback, an OPTIONS or a HEAD', unspoken)).toEqual([]);
		// SvelteKit serves a `+server.js` as it serves a `+server.ts`, and serves
		// one outside `src/routes/api`. Neither is in the tree read above.
		const stray = serverFilesNotServed();
		expect(
			stray,
			named('+server files the table does not cover, being outside src/routes/api or not a .ts file', stray)
		).toEqual([]);
		// It looked: the tree is the size it was when this was written, or larger.
		expect(tree.length).toBeGreaterThanOrEqual(215);
	});

	it('names a card or says what is wrong for every fault it carries', () => {
		for (const [key, entry] of Object.entries(TABLE)) {
			for (const c of [entry].flat()) {
				for (const mark of [c.fault, c.shows, c.answersOtherwise]) {
					if (mark) expect(mark.what, key).not.toBe('');
				}
				// Each caller a fault lets in is one the kind refuses: otherwise the mark does nothing.
				for (const who of c.fault?.lets ?? []) expect(refusedBy(c), key).toContain(who);
				// A mark on the allowed caller's test has to have such a test to be on.
				if (c.answersOtherwise) expect(c.answers, key).toBeDefined();
			}
		}
	});

	it('gives each case of an entry a name of its own, and no case a refusal that is its allowed answer', () => {
		for (const [key, entry] of Object.entries(TABLE)) {
			const cases = [entry].flat();
			// Two cases with one name would make two tests with one name.
			const names = cases.map((c) => c.of ?? '');
			expect(new Set(names).size, `${key}: ${JSON.stringify(names)}`).toBe(names.length);

			for (const c of cases) {
				// The case would pass with no access check in the handler at all.
				if (c.answers !== undefined) expect(c.refusedAs, key).not.toBe(c.answers);
				expect([401, 403], `${key}: answers is a status a refusal has`).not.toContain(c.answers);
				if (c.kind === 'link') expect(c.withLink, key).toBeDefined();
				if (c.kind === 'form') expect(c.withToken, key).toBeDefined();
				// A route a link opens has a `link` case beside the `own` one.
				if (c.opensByLink) expect([c.kind, cases.some((other) => other.kind === 'link')], key).toEqual(['own', true]);
			}
		}
	});
});

for (const [key, entry] of Object.entries(TABLE)) {
	const [method, pattern] = key.split(' ') as [Method, string];
	const cases = [entry].flat();

	describe(key, () => {
		for (const c of cases) {
			for (const who of refusedBy(c)) {
				if (who === 'nobody' && c.nobody === 'empty') {
					it(titled(c, 'answers a caller who is not signed in with an empty list'), async () => {
						const before = snapshotDb();
						const res = await call(method, pattern, c.req(w), 'nobody');
						expect(res.status).toBe(200);
						expect(res.body).toEqual([]);
						expectUnchanged(before);
					});
					continue;
				}

				const letIn = c.fault?.lets.includes(who);

				if (who !== 'nobody' && c.filtered) {
					const name = letIn
						? `${known(c.fault!)}: answers ${CALLED[who]} with something of board A: ${c.fault!.what}`
						: `answers ${CALLED[who]} with nothing of board A`;
					(letIn ? it.fails : it)(titled(c, name), async () => {
						c.setup?.(w);
						const before = snapshotDb();
						const res = await call(method, pattern, c.req(w), who);
						expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
						expect(asText(res)).not.toContain(MARK);
						expectUnchanged(before);
					});
					continue;
				}

				const name = letIn ? `${known(c.fault!)}: does not refuse ${CALLED[who]}: ${c.fault!.what}` : `refuses ${CALLED[who]}`;
				(letIn ? it.fails : it)(titled(c, name), async () => {
					await expectRefused(method, pattern, c, who, refusals(c, who));
				});
			}

			// The fault this suite began with: a handler that judged the caller
			// against the board the body named. `outsider` owns board B, and names
			// it beside a request for something of board A.
			if (spoofable(c)) {
				const letIn = c.fault?.lets.includes('outsider');
				(letIn ? it.fails : it)(
					titled(
						c,
						`${letIn ? `${known(c.fault!)}: does not refuse` : 'refuses'} that caller when the body also names a board they can edit`
					),
					async () => {
						c.setup?.(w);
						const before = snapshotDb();
						const req = parts(c.req(w));
						const body = { ...(req.body as Record<string, unknown>), boardId: w.B.board.id };

						const res = await call(method, pattern, { ...req, body }, 'outsider');
						await sent.settle();

						expect(refusals(c, 'outsider'), `answered ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
						expectUnchanged(before);
						expect(sent.all).toEqual([]);
					}
				);
			}

			if (c.kind === 'link') {
				it(titled(c, 'refuses a caller who holds the link of another request'), async () => {
					const wrong = (w: World) => withAnotherLink(c.withLink!(w));
					// It is another link: the case's own is in the request it was made from.
					expect(wrong(w)).not.toEqual(parts(c.withLink!(w)));
					await expectRefused(method, pattern, c, 'nobody', refusals(c, 'nobody'), wrong);
				});
				it(titled(c, 'answers whoever holds the link, signed in or not'), async () => {
					c.setup?.(w);
					const res = await call(method, pattern, c.withLink!(w), 'nobody');
					expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
				});
				if (!c.addressee) continue;
			}

			if (c.kind === 'form') {
				for (const [what, token] of Object.entries(WRONG_TOKENS)) {
					it(titled(c, `refuses ${CALLED.nobody} with a token ${what}`), async () => {
						// The key tokens are signed with is made, and kept in the settings,
						// the first time one is needed. Made now, so that it is not taken
						// for a row the refused request wrote.
						issueFormToken();
						await expectRefused(method, pattern, c, 'nobody', refusals(c, 'nobody'), (w) => c.withToken!(w, token()));
					});
				}
				it(titled(c, `answers ${CALLED.nobody} who holds the token the form was given`), async () => {
					c.setup?.(w);
					const res = await call(method, pattern, c.withToken!(w, issueFormToken()), 'nobody');
					expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
				});
			}

			const who = allowedBy(c);

			if (c.notMade) {
				it.skip(titled(c, `answers ${CALLED[who]} (not made: ${c.notMade})`), () => {});
				continue;
			}

			if (c.stream) {
				it(titled(c, `answers ${CALLED[who]} with a stream`), async () => {
					c.setup?.(w);
					const { path } = parts(c.req(w));
					expectPathOf(pattern, path);
					const res = await gate(method, path, {
						headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(w[who as Exclude<Who, 'nobody'>])}` }
					});
					try {
						expect(res.status).toBe(200);
						expect(res.headers.get('content-type')).toBe('text/event-stream');
					} finally {
						// It never ends by itself: cancelling is what stops its heartbeat.
						await res.body?.cancel();
					}
				});
				continue;
			}

			if (c.answers) {
				const wrong = c.answersOtherwise;
				(wrong ? it.fails : it)(
					titled(
						c,
						wrong
							? `${known(wrong)}: does not answer ${CALLED[who]} ${c.answers} (${c.because}): ${wrong.what}`
							: `lets ${CALLED[who]} past the access check, to be answered ${c.answers}: ${c.because}`
					),
					async () => {
						c.setup?.(w);
						const before = snapshotDb();
						const res = await call(method, pattern, c.req(w), who);
						expect(res.status, JSON.stringify(res.body)).toBe(c.answers);
						// Turned down, by whichever rule: nothing was written.
						expectUnchanged(before);
					}
				);
				continue;
			}

			/** An answer to a caller who cannot open a board has nothing of that board in it. */
			const expectNothingKept = (text: string) => {
				if (!OPENS_A.includes(who)) expect(text).not.toContain(MARK);
				if (!OPENS_B.includes(who)) expect(text).not.toContain(MARK_B);
			};

			it(titled(c, `answers ${CALLED[who]}`), async () => {
				c.setup?.(w);
				const res = await call(method, pattern, c.req(w), who);
				await sent.settle();

				expect(res.status, JSON.stringify(res.body)).toBeLessThan(400);
				const text = asText(res);
				if (c.tellsEveryone) {
					// It is meant to tell of a board the caller cannot open, and it
					// does: the mark goes when it stops.
					const kept = [...(OPENS_A.includes(who) ? [] : [MARK]), ...(OPENS_B.includes(who) ? [] : [MARK_B])];
					expect(kept, `${who} can open both boards, and is told nothing by being told of them`).not.toEqual([]);
					expect(
						kept.filter((mark) => text.includes(mark)),
						'the marks of the boards the caller cannot open that are in the answer'
					).not.toEqual([]);
				} else if (!c.shows) {
					expectNothingKept(text);
				}
				// The filter leaves out what the caller cannot open, and not everything.
				if (c.filtered) expect(text).toContain(MARK);
			});

			// A test of its own, so that the one above still says the caller is answered.
			if (c.shows) {
				it.fails(
					titled(
						c,
						`${known(c.shows)}: answers ${CALLED[who]} with something of a board they cannot open: ${c.shows.what}`
					),
					async () => {
						c.setup?.(w);
						const res = await call(method, pattern, c.req(w), who);
						expectNothingKept(asText(res));
					}
				);
			}
		}

		for (const c of cases) {
			// A public route answers a request that has neither.
			if (c.kind === 'public') continue;

			it(titled(c, 'through the gate, refuses a request with no session and no API key'), async () => {
				c.setup?.(w);
				const { path, body, headers } = parts(c.req(w));
				const before = snapshotDb();

				const res = await gate(method, path, { body, headers });
				const text = await res.text();

				if (pattern.startsWith('/api/v1/')) {
					// The gate's own answer: no handler is reached without a key.
					expect(res.status).toBe(401);
					expect(JSON.parse(text)).toEqual({ message: 'Missing or invalid Authorization header. Use: Bearer <api_key>' });
				} else if (pattern.startsWith('/api/requests')) {
					// The public form's paths are let through the gate, and the handler refuses.
					expect([401, 403, 404]).toContain(res.status);
				} else {
					// The gate's own answer to a script: 401, and not the login
					// page, which `fetch` would follow and hand back as a 200.
					expect(res.status).toBe(401);
					expect(res.headers.get('location')).toBeNull();
					expect(JSON.parse(text)).toEqual({ message: 'Not authenticated' });
				}
				expectUnchanged(before);
				expect(sent.all).toEqual([]);
			});
		}
	});
}

// ─── What the table cannot say ─────────────────────────────────────────────

describe('GET /api/events, the stream itself', () => {
	// The table shows that the stream opens for whoever is signed in. This is
	// what it then sends. The handler subscribes to every board and passes on
	// what the listener may see, one event at a time, so the stream is read: an
	// event is sent for each board, the listener's own last, and the reading
	// stops at that one. Were the other board's sent, it would have arrived
	// before it.
	const listeners: { who: Exclude<Who, 'nobody'>; expected: string; kept: string }[] = [
		{ who: 'outsider', expected: MARK_B, kept: MARK },
		{ who: 'viewer', expected: MARK, kept: MARK_B }
	];

	for (const { who, expected, kept } of listeners) {
		it(`sends ${CALLED[who]} the events of the board they can open, and not the other board's`, async () => {
			const res = await gate('GET', '/api/events', {
				headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(w[who])}` }
			});
			expect(res.status).toBe(200);
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();

			try {
				const order = expected === MARK_B ? [w.A, w.B] : [w.B, w.A];
				for (const side of order) emit(side.board.id, 'update', { type: 'card', title: side.card.title });

				let received = '';
				while (!received.includes(expected)) {
					const { done, value } = await reader.read();
					if (done) break;
					received += decoder.decode(value, { stream: true });
				}

				expect(received).toContain('event: update');
				expect(received).toContain(expected);
				expect(received).not.toContain(kept);
			} finally {
				// It never ends by itself: cancelling is what stops its heartbeat.
				await reader.cancel();
			}
		});
	}
});

describe('a report of a grouping of boards', () => {
	// POST /api/reports answers with a PDF, and POST /api/reports/email mails
	// one: neither answer can be read for a card's title. Both draw what
	// `generateCategoryReport` gives them, so that is read here. Both boards are
	// under the grouping, and each caller can open one of them.
	const readers: { who: Exclude<Who, 'nobody'>; theirs: string; kept: string }[] = [
		{ who: 'outsider', theirs: MARK_B, kept: MARK },
		{ who: 'viewer', theirs: MARK, kept: MARK_B }
	];

	for (const { who, theirs, kept } of readers) {
		it(`is of the board ${CALLED[who]} can open, and has nothing of the other`, () => {
			const today = new Date().toISOString().slice(0, 10);
			const report = JSON.stringify(generateCategoryReport(w.grouping.id, '2026-01-01', today, w[who]));

			expect(report).toContain(theirs);
			expect(report).not.toContain(kept);
		});
	}
});

describe('who may manage which account', () => {
	// The table has one administrator, the superadmin and the ordinary users.
	// The rule needs one more in the cast, made here: a second administrator. An administrator manages ordinary
	// users, only the superadmin manages an administrator, and nobody but the
	// superadmin touches the superadmin's account. Setting a password, changing
	// an account, deleting one and sending it an invite all ask the same guard,
	// and used not to: an administrator could not delete another and could set
	// their password, and could send anyone an invite, which sets one.
	let admin2: SessionUser;
	let chief: SessionUser;

	beforeEach(() => {
		admin2 = makeUser({ username: 'admin2', role: 'admin' });
		chief = w.chief;
		// An invite is mailed, and is refused where there is no mail to send it by.
		makeSmtp();
	});

	const MANAGES: { route: string; send: (by: SessionUser, account: SessionUser) => Promise<ApiResult> }[] = [
		{
			route: 'PUT /api/users/[id]/password',
			send: (by, account) => api('PUT', `/api/users/${account.id}/password`, { user: by, body: { password: 'a long password' } })
		},
		{
			route: 'PUT /api/users/[id]',
			send: (by, account) => api('PUT', `/api/users/${account.id}`, { user: by, body: { emoji: '🦊' } })
		},
		{
			route: 'DELETE /api/users/[id]',
			send: (by, account) => api('DELETE', `/api/users/${account.id}`, { user: by })
		},
		// Whoever holds the invite sets the account's password with it.
		{
			route: 'POST /api/users/[id]/invite',
			send: (by, account) => api('POST', `/api/users/${account.id}/invite`, { user: by })
		}
	];

	/** The request, answered `status` with not a row changed and nothing sent. Returns what it said. */
	async function turnedDown(request: () => Promise<ApiResult>, status: number): Promise<string> {
		const before = snapshotDb();
		const res = await request();
		await sent.settle();
		expect(res.status, JSON.stringify(res.body)).toBe(status);
		expectUnchanged(before);
		// No invite was mailed: the token it would carry is a row, and there is none.
		expect(sent.all).toEqual([]);
		return res.body.message;
	}

	/** The request, answered 403 with not a row changed and nothing sent. Returns what it said. */
	const refused = (request: () => Promise<ApiResult>) => turnedDown(request, 403);

	const roleOf = (account: SessionUser) => db.select().from(users).where(eq(users.id, account.id)).get()!.role;

	for (const { route, send } of MANAGES) {
		describe(route, () => {
			it('refuses an administrator who names another administrator', async () => {
				expect(await refused(() => send(w.admin, admin2))).toMatch(/Only superadmin/);
				expect(await refused(() => send(admin2, w.admin))).toMatch(/Only superadmin/);
			});

			it('lets an administrator manage an ordinary user', async () => {
				const res = await send(admin2, w.viewer);
				expect(res.status, JSON.stringify(res.body)).toBe(200);
			});

			it('lets the superadmin manage an administrator', async () => {
				const res = await send(chief, admin2);
				expect(res.status, JSON.stringify(res.body)).toBe(200);
			});

			it('refuses everyone else who names the superadmin', async () => {
				for (const by of [w.admin, admin2, w.owner]) await refused(() => send(by, chief));
			});

			it('refuses a superadmin who names another: were there a second, neither would manage the other', async () => {
				// No route makes a second superadmin, so this one is put in the table.
				// "Nobody else" is not "no administrator": being a superadmin is not
				// what lets a caller at the superadmin's account. Being that one is.
				const second = makeUser({ username: 'chief2', role: 'superadmin' });

				await refused(() => send(second, chief));
				await refused(() => send(chief, second));
			});
		});
	}

	it('answers the superadmin who names their own account as each route answers anyone who does', async () => {
		const [password, change, remove, invite] = MANAGES;

		// A password is changed on the Account page, by everyone.
		expect(await refused(() => password.send(chief, chief))).toContain('Account page');
		// And is not set by an invite sent to oneself, which asks for no password.
		expect(await refused(() => invite.send(chief, chief))).toContain('Account page');
		// An account is not deleted by whoever is signed in to it.
		const before = snapshotDb();
		expect((await remove.send(chief, chief)).status).toBe(400);
		expectUnchanged(before);
		// And the superadmin's account is the superadmin's to change.
		expect((await change.send(chief, chief)).status).toBe(200);
	});

	it('refuses whoever names their own account on the invite route, which would set their password and ask for none', async () => {
		const invite = MANAGES[3];
		// `owner` is no administrator, and is refused for that before anything else.
		expect(await refused(() => invite.send(w.owner, w.owner))).toBe('Forbidden');
		for (const by of [w.admin, admin2, chief]) {
			expect(await refused(() => invite.send(by, by))).toBe(
				'An invite sets a password. Change your own password on the Account page, which asks for your current password'
			);
		}
		expect(db.select().from(inviteTokens).all()).toEqual([]);
	});

	it('mails an invite to the account an administrator may manage, and to no other', async () => {
		const invite = MANAGES[3];

		// Refused: no token is made for another administrator or for the superadmin.
		expect(await refused(() => invite.send(w.admin, admin2))).toBe(
			"Only superadmin can reset an admin's password, which an invite does"
		);
		expect(await refused(() => invite.send(w.admin, chief))).toBe(
			'Only superadmin can reset superadmin password, which an invite does'
		);
		expect(db.select().from(inviteTokens).all()).toEqual([]);

		// Allowed: an administrator invites an ordinary user, and the superadmin an administrator.
		for (const [by, account] of [
			[w.admin, w.viewer],
			[chief, admin2]
		]) {
			sent.clear();
			const res = await invite.send(by, account);
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			const tokens = db.select().from(inviteTokens).where(eq(inviteTokens.userId, account.id)).all();
			expect(tokens).toHaveLength(1);
			// The link mailed is the token that was saved, and it goes to the account's own address.
			expect(sent.emails.map((mail) => mail.to)).toEqual([account.email]);
			expect(sent.emails[0].html).toContain(`/invite/${tokens[0].token}`);
		}
		expect(db.select().from(inviteTokens).all()).toHaveLength(2);
	});

	// ── What a role may be ────────────────────────────────────────────────
	// Both routes that write a role compared it with 'admin' and 'superadmin'
	// and then bound it as it was sent. An array of one string is neither
	// string, and the database driver binds it as the string: an administrator
	// sent `["superadmin"]` as their own role and was the superadmin.

	const NEWCOMER = { username: 'newcomer', email: 'newcomer@example.test', password: 'a long password' };
	const create = (by: SessionUser, more: Record<string, unknown>) =>
		api('POST', '/api/users', { user: by, body: { ...NEWCOMER, ...more } });
	const change = (by: SessionUser, account: SessionUser, body: unknown) =>
		api('PUT', `/api/users/${account.id}`, { user: by, body });

	/** What PUT /api/users/[id] says to whoever sends a role for their own account, whatever it is (card 2117, decision 13). */
	const OWN_ROLE = {
		superadmin: "The superadmin's role cannot be changed",
		admin: 'Your own role is not changed here: the superadmin can change it'
	};
	const ownRole = (by: SessionUser) => (by.role === 'superadmin' ? OWN_ROLE.superadmin : OWN_ROLE.admin);

	/** What neither route takes for a role, and what each says of it. */
	const NOT_A_ROLE: { sent: unknown; put: string; post: string }[] = [
		{ sent: ['admin'], put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' },
		{ sent: ['superadmin'], put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' },
		{ sent: 'superadmin', put: 'Cannot assign superadmin role', post: 'Cannot create additional superadmin accounts' },
		{ sent: 'Admin', put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' },
		{ sent: 1, put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' },
		{ sent: {}, put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' },
		{ sent: null, put: 'role must be "user" or "admin"', post: 'role must be "user" or "admin"' }
	];

	for (const { sent: role, put, post } of NOT_A_ROLE) {
		it(`answers 400 for the role ${JSON.stringify(role)}, from an administrator and from the superadmin, and writes nothing`, async () => {
			for (const by of [w.admin, chief]) {
				// Somebody else's role. Their own is refused for sending one at all, before it is read.
				expect(await turnedDown(() => change(by, w.viewer, { role }), 400)).toBe(put);
				expect(await turnedDown(() => change(by, by, { role }), 403)).toBe(ownRole(by));
				// With something the route would otherwise save: that is not saved either.
				expect(await turnedDown(() => change(by, w.viewer, { emoji: '🦊', role }), 400)).toBe(put);
				// And nobody is made with it.
				expect(await turnedDown(() => create(by, { role }), 400)).toBe(post);
			}
			expect(db.select().from(users).all().filter((user) => user.role === 'superadmin')).toHaveLength(1);
		});
	}

	it('lets the superadmin make an administrator, and nobody else, on both routes', async () => {
		for (const by of [w.admin, admin2]) {
			expect(await refused(() => change(by, w.viewer, { role: 'admin' }))).toBe('Only superadmin can assign admin role');
			// Their own, which is the role they have: refused for sending it at all.
			expect(await refused(() => change(by, by, { role: 'admin' }))).toBe(OWN_ROLE.admin);
			expect(await refused(() => create(by, { role: 'admin' }))).toBe('Only superadmin can create admin users');
		}

		const promoted = await change(chief, w.viewer, { role: 'admin' });
		expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
		expect(roleOf(w.viewer)).toBe('admin');

		const made = await create(chief, { role: 'admin' });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body.role).toBe('admin');

		// An administrator still gives the one role that is theirs to give.
		const demoted = await change(w.admin, w.editor, { role: 'user' });
		expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
		expect(roleOf(w.editor)).toBe('user');
	});

	// Card 2117, decision 13 and R16: nobody changes their own role on this
	// route. The superadmin's request to give theirs up was answered 200 and
	// ignored, and an administrator's to make themselves a user was done.
	it("refuses the superadmin's change of their own role, whatever it is, and saves nothing sent with it", async () => {
		// The role they have, sent back, is refused as well: it is refused for sending one at all.
		for (const role of ['user', 'admin', 'superadmin']) {
			expect(await refused(() => change(chief, chief, { role }))).toBe(OWN_ROLE.superadmin);
		}
		// What else came with it is not saved either.
		expect(await refused(() => change(chief, chief, { role: 'user', emoji: '🦊' }))).toBe(OWN_ROLE.superadmin);
		expect(roleOf(chief)).toBe('superadmin');

		// Anyone else is refused before the role is looked at.
		for (const by of [w.admin, admin2]) {
			expect(await refused(() => change(by, chief, { role: 'user' }))).toBe('Cannot modify superadmin account');
		}
	});

	it('refuses an administrator’s change of their own role, the one they have included, and saves nothing sent with it', async () => {
		// Making themselves a user was done, with one request and no way back but the superadmin.
		for (const role of ['user', 'admin']) {
			expect(await refused(() => change(w.admin, w.admin, { role }))).toBe(OWN_ROLE.admin);
		}
		expect(await refused(() => change(w.admin, w.admin, { role: 'user', emoji: '🦊' }))).toBe(OWN_ROLE.admin);
		expect(roleOf(w.admin)).toBe('admin');

		// The superadmin may change it, on the administrator's behalf.
		const demoted = await change(chief, w.admin, { role: 'user' });
		expect(demoted.status, JSON.stringify(demoted.body)).toBe(200);
		expect(roleOf(w.admin)).toBe('user');
	});

	it('answers 400 for a username, an email, an emoji or a password that is not a string, on both routes', async () => {
		for (const field of ['username', 'email', 'emoji', 'password']) {
			for (const value of [['zed@example.test'], 1, {}, true, null]) {
				expect(await turnedDown(() => change(w.admin, w.viewer, { [field]: value }), 400)).toBe(`${field} must be a string`);
				expect(await turnedDown(() => create(w.admin, { [field]: value }), 400)).toBe(`${field} must be a string`);
			}
		}
	});

	// ── The caller's own account, on the route for somebody else's ────────

	it('refuses whoever names their own account with an email, and says where an email is changed', async () => {
		// PUT /api/account/email asks for the password the caller has. This route
		// asks for none, and an email is where an invite to set a new one is sent.
		for (const by of [w.admin, admin2, chief]) {
			expect(await refused(() => change(by, by, { email: 'elsewhere@example.test' }))).toBe(
				'Change your own email on the Account page, which asks for your current password'
			);
			// With something this route would save for them: none of it is saved.
			await refused(() => change(by, by, { emoji: '🦊', email: 'elsewhere@example.test' }));
			// For sending it at all: the address they have is no different.
			await refused(() => change(by, by, { email: by.email }));
		}

		// Their own emoji is theirs to change here, as PUT /api/account/emoji lets them with no password.
		const own = await change(w.admin, w.admin, { emoji: '🦊' });
		expect(own.status, JSON.stringify(own.body)).toBe(200);
		expect(own.body.emoji).toBe('🦊');

		// And the email of an account they manage is theirs to change.
		const other = await change(w.admin, w.viewer, { email: 'Elsewhere@Example.test' });
		expect(other.status, JSON.stringify(other.body)).toBe(200);
		expect(other.body.email).toBe('elsewhere@example.test');
	});

	it('answers a change of nothing with the six columns a change answers, how many invites ended, and no password hash', async () => {
		// It used to answer the row as it was read, password hash included.
		for (const body of [{}, { nickname: 'Vee', passwordHash: 'x', notificationPrefs: '{}', id: 1 }]) {
			const before = snapshotDb();

			const res = await change(w.admin, w.viewer, body);

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'email', 'emoji', 'id', 'invitesEnded', 'role', 'username']);
			expect(res.body).toMatchObject({
				id: w.viewer.id,
				username: 'viewer',
				email: 'viewer@example.test',
				role: 'user',
				invitesEnded: 0
			});
			expect(res.body).not.toHaveProperty('passwordHash');
			expectUnchanged(before);
		}
	});

	it('refuses whoever names their own account on the password route, and says where a password is changed', async () => {
		const [password] = MANAGES;
		for (const by of [w.owner, w.admin, admin2]) {
			expect(await refused(() => password.send(by, by))).toBe(
				'Change your own password on the Account page, which asks for your current password'
			);
		}
	});

	it('ends every session and every API key of the user whose password an administrator sets', async () => {
		const [password] = MANAGES;
		makeSession(w.viewer);
		makeSession(w.viewer);
		const key = makeApiKey(w.viewer, 'the viewer’s key');
		const sessionsOfViewer = () => db.select().from(sessions).where(eq(sessions.userId, w.viewer.id)).all().length;
		const keysOfViewer = () => db.select().from(apiKeys).where(eq(apiKeys.userId, w.viewer.id)).all().length;
		expect(sessionsOfViewer()).toBe(2);
		expect(keysOfViewer()).toBe(1);

		expect((await password.send(w.admin, w.viewer)).status).toBe(200);

		expect(sessionsOfViewer()).toBe(0);
		// A key used to outlive the reset until it was revoked by hand.
		expect(keysOfViewer()).toBe(0);
		expect((await gate('GET', '/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
	});
});

describe('making a board public', () => {
	// The table shows that an editor who sends `isPublic` is refused and the
	// owner is not. This is what is saved, on both routes that change a board.
	const board = () => db.select().from(boards).where(eq(boards.id, w.A.board.id)).get()!;

	for (const route of ['/api/boards/[id]', '/api/v1/boards/[boardId]']) {
		const put = (who: Exclude<Who, 'nobody'>, body: unknown) =>
			api('PUT', `${route.slice(0, route.lastIndexOf('/'))}/${w.A.board.id}`, { user: w[who], body });

		describe(`PUT ${route}`, () => {
			it('saves what else an editor sends, when isPublic is not sent', async () => {
				const res = await put('editor', { name: 'Renamed by an editor', emoji: '🦊' });

				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(board()).toMatchObject({ name: 'Renamed by an editor', emoji: '🦊', isPublic: false });
			});

			it('refuses an editor who sends isPublic, and saves nothing of what came with it', async () => {
				// Refused for sending it at all: the value the board already has is no different.
				for (const isPublic of [true, false]) {
					const before = snapshotDb();

					const res = await put('editor', { name: 'Renamed by an editor', emoji: '🦊', isPublic });
					await sent.settle();

					expect(res.status, JSON.stringify(res.body)).toBe(403);
					expect(res.body.message).toBe('Only board owners and admins can change visibility');
					expectUnchanged(before);
					expect(sent.all).toEqual([]);
				}
			});

			it('lets the owner set it, and an administrator', async () => {
				const made = await put('owner', { isPublic: true });
				expect(made.status, JSON.stringify(made.body)).toBe(200);
				expect(board().isPublic).toBe(true);

				const unmade = await put('admin', { isPublic: false, name: 'Renamed by an administrator' });
				expect(unmade.status, JSON.stringify(unmade.body)).toBe(200);
				expect(board()).toMatchObject({ isPublic: false, name: 'Renamed by an administrator' });
			});

			/** What is sent as `isPublic` and is neither true nor false. */
			const NOT_A_BOOLEAN = [null, 1, 0, '1', 'true', [true], {}];

			it('refuses an editor who sends an isPublic that is no boolean, as it refuses one that is', async () => {
				// Who is sending it is asked before what it is. Asked the other way
				// about, or only of a boolean, an editor's `1`, `"1"` or `[true]`
				// would be saved as true: the driver binds each as one.
				for (const isPublic of NOT_A_BOOLEAN) {
					const before = snapshotDb();

					const res = await put('editor', { name: 'Renamed by an editor', isPublic });
					await sent.settle();

					expect(res.status, `${JSON.stringify(isPublic)}: ${JSON.stringify(res.body)}`).toBe(403);
					expect(res.body.message).toBe('Only board owners and admins can change visibility');
					expectUnchanged(before);
					expect(sent.all).toEqual([]);
				}
			});

			it('answers the owner and an administrator 400 for an isPublic that is no boolean, and saves nothing', async () => {
				// `null` used to reach the column, which takes none, and was a 500.
				for (const who of ['owner', 'admin'] as const) {
					for (const isPublic of NOT_A_BOOLEAN) {
						const before = snapshotDb();

						const res = await put(who, { name: 'Renamed', isPublic });
						await sent.settle();

						expect(res.status, `${JSON.stringify(isPublic)}: ${JSON.stringify(res.body)}`).toBe(400);
						expect(res.body.message).toBe('isPublic must be true or false');
						expectUnchanged(before);
						expect(sent.all).toEqual([]);
					}
				}
			});
		});
	}
});

describe('a sub-board, on both routes that create a board', () => {
	// The table shows who may hang a board under a card. This is that the two
	// routes answer alike, having one guard between them, and write the card
	// that was checked.
	const ROUTES = ['/api/boards', '/api/v1/boards'];
	const post = (route: string, who: Exclude<Who, 'nobody'>, parentCardId: unknown) =>
		api('POST', route, { user: w[who], body: { name: 'A sub-board', parentCardId } });

	for (const route of ROUTES) {
		it(`POST ${route} answers 404 for a parent card that is not there, and makes no board`, async () => {
			const before = snapshotDb();

			const res = await post(route, 'admin', 999999);

			expect(res.status, JSON.stringify(res.body)).toBe(404);
			expect(res.body.message).toBe('Parent card not found');
			expectUnchanged(before);
		});

		// Both read it as an id (card 2117). The guard parsed it with Number(),
		// and looked for `"1e3"` as card 1000, and for the rest found none.
		it(`POST ${route} refuses a parent card that is no id, and makes no board`, async () => {
			for (const parentCardId of ['not a card', true, '1e3', 1.5]) {
				const before = snapshotDb();

				const res = await post(route, 'admin', parentCardId);

				expect({ status: res.status, message: res.body.message }, JSON.stringify(parentCardId)).toEqual({
					status: 400,
					message: 'parentCardId must be an id'
				});
				expectUnchanged(before);
			}
		});

		it(`POST ${route} hangs the board under the card that was checked`, async () => {
			const res = await post(route, 'editor', w.A.card.id);

			expect(res.status, JSON.stringify(res.body)).toBe(201);
			expect(db.select().from(boards).where(eq(boards.id, res.body.id)).get()!.parentCardId).toBe(w.A.card.id);
		});
	}

	it('refuses a caller who may not edit the parent card\'s board in the same words on both', async () => {
		for (const who of ['viewer', 'outsider'] as const) {
			const answers: ApiResult[] = [];
			for (const route of ROUTES) answers.push(await post(route, who, w.A.card.id));

			expect(answers.map((res) => res.status)).toEqual([403, 403]);
			expect(answers.map((res) => res.body.message)).toEqual([
				"No edit access to the parent card's board",
				"No edit access to the parent card's board"
			]);
		}
	});
});

describe('linking a board under a card, PUT /api/boards/[id] with parentCardId', () => {
	// The table shows that the board's owner may and its editor may not. This is
	// what is saved and who is told, why each refusal is made, and what the
	// board page offers. A linked board is deleted for good with its parent
	// card, so linking it is asked of whoever may delete it.

	const LINK_REFUSED = "Only the board's owner or an administrator can put it under a card or take it out from under one";
	const loops = (name: string) => `Board "${name}" cannot go under a card on itself or on one of its own sub-boards`;

	/** Board A's row, as it is stored. */
	const boardA = () => db.select().from(boards).where(eq(boards.id, w.A.board.id)).get()!;
	const put = (who: SessionUser, id: number, body: unknown) => api('PUT', `/api/boards/${id}`, { user: who, body });
	const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);
	/** The boards whose pages were told of a change, each once. */
	const told = () => sorted([...new Set(sent.events.map((event) => event.boardId))]);
	/** The ids of what the page offers `who` on the board `boardId`. */
	const offered = (who: SessionUser, boardId: number) => sorted(linkableBoards(who, boardId).map((board) => board.id));

	/** A top-level board that `owner` may edit and does not own, with a card on it. */
	const parentBoard = (name: string) => {
		const made = makeBoard({ owner: w.both, name });
		addBoardMember(made.board, w.owner, 'editor');
		return { board: made.board, card: makeCard(made.cols['To Do'], { title: `A card on ${name}` }) };
	};

	it("puts the board under the card, for its owner with edit access to the card's board, and tells both boards", async () => {
		const P = parentBoard('P');

		const res = await put(w.owner, w.A.board.id, { parentCardId: P.card.id });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.parentCardId).toBe(P.card.id);
		expect(boardA().parentCardId).toBe(P.card.id);
		expect(told()).toEqual(sorted([w.A.board.id, P.board.id]));
		expect(sent.duringTransaction).toEqual([]);
	});

	it('moves a linked board to another card, and takes it out from under one with null, telling every board it left or joined', async () => {
		const P = parentBoard('P');
		const Q = parentBoard('Q');
		expect((await put(w.owner, w.A.board.id, { parentCardId: P.card.id })).status).toBe(200);

		await sent.settle();
		sent.clear();
		const moved = await put(w.owner, w.A.board.id, { parentCardId: Q.card.id });
		await sent.settle();
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		expect(boardA().parentCardId).toBe(Q.card.id);
		expect(told()).toEqual(sorted([w.A.board.id, P.board.id, Q.board.id]));

		sent.clear();
		const detached = await put(w.owner, w.A.board.id, { parentCardId: null });
		await sent.settle();
		expect(detached.status, JSON.stringify(detached.body)).toBe(200);
		expect(boardA().parentCardId).toBeNull();
		expect(told()).toEqual(sorted([w.A.board.id, Q.board.id]));
	});

	it('leaves the card it hangs under alone when that is sent back, by an editor too, and tells no board it did not leave or join', async () => {
		const P = parentBoard('P');
		db.update(boards).set({ parentCardId: P.card.id }).where(eq(boards.id, w.A.board.id)).run();

		const res = await put(w.editor, w.A.board.id, { name: 'Renamed by an editor', parentCardId: P.card.id });
		await sent.settle();

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(boardA()).toMatchObject({ name: 'Renamed by an editor', parentCardId: P.card.id });
		// The board itself is told of the rename, once (card 2143), and P is not.
		expect(sent.events.map((event) => event.boardId)).toEqual([w.A.board.id]);
	});

	it('lets a member shared as Owner link it, and offers it to them', async () => {
		const coOwner = makeUser({ username: 'co-owner' });
		addBoardMember(w.A.board, coOwner, 'owner');
		const P = parentBoard('P');
		addBoardMember(P.board, coOwner, 'editor');

		expect(offered(coOwner, P.board.id)).toContain(w.A.board.id);
		const res = await put(coOwner, w.A.board.id, { parentCardId: P.card.id });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(boardA().parentCardId).toBe(P.card.id);
	});

	it('refuses an editor of the board who does not own it, to link it or to take it out, and saves nothing that came with it', async () => {
		const P = parentBoard('P');
		addBoardMember(P.board, w.editor, 'editor');

		for (const [body, linked] of [
			[{ name: 'Renamed by an editor', parentCardId: P.card.id }, null],
			[{ name: 'Renamed by an editor', parentCardId: null }, P.card.id]
		] as const) {
			db.update(boards).set({ parentCardId: linked }).where(eq(boards.id, w.A.board.id)).run();
			const before = snapshotDb();
			sent.clear();

			const res = await put(w.editor, w.A.board.id, body);
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(403);
			expect(res.body).toEqual({ message: LINK_REFUSED });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		}
	});

	it("refuses the owner who may not edit the card's board, in the words for creating a sub-board", async () => {
		const elsewhere = makeCard(w.B.cols['To Do'], { title: 'A card on board B' });
		const before = snapshotDb();

		const res = await put(w.owner, w.A.board.id, { name: 'Renamed', parentCardId: elsewhere.id });

		expect(res.status, JSON.stringify(res.body)).toBe(403);
		expect(res.body).toEqual({ message: "No edit access to the parent card's board" });
		expectUnchanged(before);
	});

	it('answers 404 for a parent card that is not there, and 400 for one that is not an id', async () => {
		const before = snapshotDb();

		const missing = await put(w.owner, w.A.board.id, { name: 'Renamed', parentCardId: 999999 });
		expect(missing.status).toBe(404);
		expect(missing.body).toEqual({ message: 'Parent card not found' });

		for (const parentCardId of ['a card', 0, 1.5, true, [w.B.card.id]]) {
			const res = await put(w.owner, w.A.board.id, { parentCardId });
			expect(res.status, JSON.stringify(parentCardId)).toBe(400);
			expect(res.body).toEqual({ message: 'parentCardId must be an id' });
		}
		expectUnchanged(before);
	});

	it('refuses 409 a card on the board itself, or on a board beneath it at any depth, and saves nothing', async () => {
		const one = makeSubBoard(w.A.card, { owner: w.owner, name: 'One level down' });
		const two = makeSubBoard(one.cards[0], { owner: w.owner, name: 'Two levels down' });

		for (const card of [w.A.loose, one.cards[0], two.cards[0]]) {
			const before = snapshotDb();
			sent.clear();

			const res = await put(w.owner, w.A.board.id, { name: 'Renamed', parentCardId: card.id });
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(409);
			expect(res.body).toEqual({ message: loops(w.A.board.name) });
			expectUnchanged(before);
			expect(sent.all).toEqual([]);
		}
	});

	it('ends on a loop already in the data: one above the card’s board is no loop of the link, and a board in one can be taken out of it', async () => {
		// L1 hangs under a card on L2, and L2 under a card on L1. P hangs under a card on L1.
		const L1 = makeBoard({ owner: w.owner, name: 'L1' });
		const onL1 = makeCard(L1.cols['To Do']);
		const L2 = makeBoard({ owner: w.owner, name: 'L2', parentCardId: onL1.id });
		const onL2 = makeCard(L2.cols['To Do']);
		db.update(boards).set({ parentCardId: onL2.id }).where(eq(boards.id, L1.board.id)).run();
		const P = makeBoard({ owner: w.owner, name: 'P', parentCardId: onL1.id });
		const onP = makeCard(P.cols['To Do']);

		// The page's list for P is made, and ends. It offers nothing, and the
		// link is refused after the loop check has walked up through the loop
		// and found none of its own: a board below a loop reads as deeper than
		// sub-boards may nest, so nothing goes under a card on it (card 2172).
		// Until card 2172 the link was made.
		expect(offered(w.owner, P.board.id)).toEqual([]);
		const linked = await put(w.owner, w.A.board.id, { parentCardId: onP.id });
		expect(linked.status, JSON.stringify(linked.body)).toBe(409);
		expect(linked.body).toEqual({ message: tooDeepToLink(w.A.board.name) });

		// L2 is in the loop, and goes under a card on a board outside it.
		const outside = makeCard(makeBoard({ owner: w.owner, name: 'Outside the loop' }).cols['To Do']);
		const outOfIt = await put(w.owner, L2.board.id, { parentCardId: outside.id });
		expect(outOfIt.status, JSON.stringify(outOfIt.body)).toBe(200);
		// And L1, still beneath L2, cannot have L2 put back under it.
		const back = await put(w.owner, L2.board.id, { parentCardId: onL1.id });
		expect(back.status, JSON.stringify(back.body)).toBe(409);
		expect(back.body).toEqual({ message: loops('L2') });
	});

	describe('what the board page offers, linkableBoards', () => {
		it('offers the top-level boards the caller owns, but not this board or the top of its own chain of parents', () => {
			const P = parentBoard('P');
			const beneathA = makeSubBoard(w.A.card, { owner: w.owner, name: 'Beneath board A' });

			expect(offered(w.owner, P.board.id)).toEqual(sorted([w.A.board.id, w.alone.id, w.publicBoard.board.id]));
			// On board A, or beneath it, board A would go under a card on itself or beneath itself.
			expect(offered(w.owner, w.A.board.id)).toEqual(sorted([w.alone.id, w.publicBoard.board.id]));
			expect(offered(w.owner, beneathA.board.id)).toEqual(sorted([w.alone.id, w.publicBoard.board.id]));
		});

		it('offers an administrator every top-level board, and nothing to an editor who owns none or to a caller who cannot edit the board', () => {
			const P = parentBoard('P');
			addBoardMember(P.board, w.outsider, 'viewer');

			expect(offered(w.admin, P.board.id)).toEqual(sorted([w.A.board.id, w.B.board.id, w.alone.id, w.publicBoard.board.id]));
			// `editor` edits board A and owns nothing: the button is not shown at all.
			expect(offered(w.editor, w.A.board.id)).toEqual([]);
			// `outsider` owns board B and only views P: no card of P can be linked to.
			expect(offered(w.outsider, P.board.id)).toEqual([]);
		});

		it('reads the database as often with forty more boards as without them, for an owner and for an administrator', () => {
			// It asked getBoardRole of every top-level board in turn, on every
			// load of a board page: one read of `boards` and one or more of the
			// memberships for each board there is.
			const P = parentBoard('P');
			const TABLES = ['boards', 'board_members', 'team_members', 'board_teams'];
			const readsOf = (who: SessionUser) =>
				TABLES.map((table) => {
					const reads = watchReads(table);
					try {
						linkableBoards(who, P.board.id);
					} finally {
						reads.restore();
					}
					return reads.inTransaction.length;
				});
			const before = { owner: readsOf(w.owner), admin: readsOf(w.admin) };
			const offeredBefore = offered(w.owner, P.board.id);

			for (let i = 0; i < 20; i++) {
				const someoneElses = makeBoard({ owner: w.outsider, name: `Someone else's ${i}` });
				addBoardMember(someoneElses.board, w.owner, i % 2 === 0 ? 'editor' : 'viewer');
				makeBoard({ owner: w.both, name: `Not shared ${i}` });
			}

			expect(readsOf(w.owner)).toEqual(before.owner);
			expect(readsOf(w.admin)).toEqual(before.admin);
			// None of the forty is the owner's: the list is as it was.
			expect(offered(w.owner, P.board.id)).toEqual(offeredBefore);
		});

		it('offers a board on which the caller is a member stored as owner, and not one stored with any other text', () => {
			const P = parentBoard('P');
			const coOwned = makeBoard({ owner: w.outsider, name: 'Co-owned' });
			const oddRole = makeBoard({ owner: w.outsider, name: 'Stored as admin' });
			addBoardMember(coOwned.board, w.owner, 'owner');
			// The share routes stored any text as a role until card 2117 read it.
			addBoardMember(oddRole.board, w.owner, 'admin' as 'owner');

			const ids = offered(w.owner, P.board.id);
			expect(ids).toContain(coOwned.board.id);
			expect(ids).not.toContain(oddRole.board.id);
		});
	});

	describe('a member row stored with a role that is not one of the three, getBoardRole', () => {
		// The share routes stored whatever `role` they were sent until card 2117
		// read it. A bare cast handed the text on as the role: `admin` became an
		// administrator's role on that board, which may share, publish, delete
		// and link it.
		it.each(['admin', 'superadmin', 'Owner', 'lead', ''])('reads %j as viewer', (stored) => {
			const B = makeBoard({ owner: w.both, name: 'B' });
			addBoardMember(B.board, w.outsider, stored as 'viewer');

			expect(getBoardRole(w.outsider, B.board.id)).toBe('viewer');
			expect(canViewBoard(w.outsider, B.board.id)).toBe(true);
			expect(canEditBoard(w.outsider, B.board.id)).toBe(false);
		});

		it('reads each of the three as itself', () => {
			for (const stored of ['owner', 'editor', 'viewer'] as const) {
				const B = makeBoard({ owner: w.both, name: `B ${stored}` });
				addBoardMember(B.board, w.outsider, stored);
				expect(getBoardRole(w.outsider, B.board.id)).toBe(stored);
			}
		});

		it('refuses such a member what only an owner may do', async () => {
			const B = makeBoard({ owner: w.both, name: 'B' });
			addBoardMember(B.board, w.outsider, 'admin' as 'viewer');

			const res = await api('PATCH', `/api/boards/${B.board.id}/share`, { user: w.outsider, body: { isPublic: true } });
			expect(res.status).toBe(403);
			expect(db.select().from(boards).where(eq(boards.id, B.board.id)).get()!.isPublic).toBe(false);
		});
	});
});

describe('GET /api/graph, what it lists', () => {
	type Graph = { nodes: { id: string; type: string; label: string }[]; edges: { source: string; target: string; relation: string }[] };
	const graph = async (who: Exclude<Who, 'nobody'>, query = ''): Promise<Graph> => {
		const res = await api('GET', `/api/graph${query}`, { user: w[who] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return res.body;
	};
	const boardsIn = (g: Graph) => g.nodes.filter((node) => node.type === 'board').map((node) => node.id);

	it('lists a card\'s sub-board with the column to a caller who can view it, and not to one who cannot', async () => {
		// Two sub-boards of board A's card. A sub-board is a board of its own:
		// `viewer` has been given one of them and not the other.
		const shared = makeSubBoard(w.A.card, { owner: w.owner, name: `${MARK} sub-board shared with the viewer` });
		const unshared = makeSubBoard(w.A.card, { owner: w.owner, name: `${MARK} sub-board of the owner alone` });
		addBoardMember(shared.board, w.viewer, 'viewer');
		const column = `?columnId=${w.A.cols['To Do'].id}`;

		const forViewer = await graph('viewer', column);
		expect(boardsIn(forViewer)).toEqual([`board:${shared.board.id}`]);
		expect(JSON.stringify(forViewer)).not.toContain(unshared.board.name);
		expect(forViewer.edges.filter((edge) => edge.relation === 'sub_board')).toEqual([
			{ source: `card:${w.A.card.id}`, target: `board:${shared.board.id}`, relation: 'sub_board' }
		]);
		// The column's cards are all there: only the sub-board is left out.
		expect(forViewer.nodes.filter((node) => node.type === 'card').map((node) => node.id).sort()).toEqual(
			[w.A.card, w.A.other, w.A.loose].map((card) => `card:${card.id}`).sort()
		);

		// Whoever can view both is shown both: the owner, and an administrator.
		for (const who of ['owner', 'admin'] as const) {
			expect(boardsIn(await graph(who, column)).sort()).toEqual(
				[`board:${shared.board.id}`, `board:${unshared.board.id}`].sort()
			);
		}

		// And a sub-board the caller is not shown is not expanded for them either.
		const refused = await api('GET', `/api/graph?boardId=${unshared.board.id}`, { user: w.viewer });
		expect(refused.status).toBe(403);
		expect((await graph('viewer', `?boardId=${shared.board.id}`)).nodes.length).toBeGreaterThan(0);
	});

	it('with no board named, lists each caller the boards they can open and no other', async () => {
		const open = (...opened: Board[]) => opened.map((board) => `board:${board.id}`).sort();

		expect(boardsIn(await graph('outsider')).sort()).toEqual(open(w.B.board, w.publicBoard.board));
		expect(boardsIn(await graph('viewer')).sort()).toEqual(open(w.A.board, w.alone, w.publicBoard.board));
		expect(boardsIn(await graph('admin')).sort()).toEqual(open(w.A.board, w.B.board, w.alone, w.publicBoard.board));
	});

	it('draws a dependency between two cards the caller can view, and none to a card of a board they cannot open', async () => {
		// In board A's To Do column: `other` waits on `card`, on the same board,
		// and `card` waits on a card of board B.
		const column = `?columnId=${w.A.cols['To Do'].id}`;
		const waits = (g: Graph) =>
			g.edges.filter((edge) => edge.relation === 'depends_on').sort((a, b) => a.source.localeCompare(b.source));
		const within = { source: `card:${w.A.other.id}`, target: `card:${w.A.card.id}`, relation: 'depends_on' };
		const across = { source: `card:${w.A.card.id}`, target: `card:${w.awaited.id}`, relation: 'depends_on' };
		/** Every id the answer names, as a node or as either end of an edge. */
		const named = (g: Graph) => [...g.nodes.map((node) => node.id), ...g.edges.flatMap((edge) => [edge.source, edge.target])];

		// `viewer` and `owner` cannot open board B: the link into it is not drawn,
		// and the id of the card it reaches is nowhere in the answer.
		for (const who of ['viewer', 'owner'] as const) {
			const g = await graph(who, column);
			expect(waits(g)).toEqual([within]);
			expect(named(g)).not.toContain(`card:${w.awaited.id}`);
			expect(JSON.stringify(g)).not.toContain(MARK_B);
		}

		// Whoever can view both boards is drawn both links.
		for (const who of ['editsA', 'both', 'admin'] as const) {
			expect(waits(await graph(who, column))).toEqual([across, within].sort((a, b) => a.source.localeCompare(b.source)));
		}
	});

	it('draws the dependencies that are recorded now, and no link that has a subtask at an end', async () => {
		const column = `?columnId=${w.A.cols['To Do'].id}`;
		const from = async (card: Card) =>
			(await graph('owner', column)).edges.filter((edge) => edge.relation === 'depends_on' && edge.source === `card:${card.id}`);

		// A row of the table the links were kept in before migration 0043, which
		// nothing has written since. The graph used to draw its edges from it.
		db.insert(cardDependencies).values({ cardId: w.A.loose.id, dependsOnCardId: w.A.card.id }).run();
		// A card that waits on a subtask: the graph has no node for a subtask.
		makeDependency({ blocked: w.A.loose, blocker: w.A.sub });
		expect(await from(w.A.loose)).toEqual([]);

		// A link made as the routes make one is drawn.
		makeDependency({ blocked: w.A.loose, blocker: w.A.other });
		expect(await from(w.A.loose)).toEqual([
			{ source: `card:${w.A.loose.id}`, target: `card:${w.A.other.id}`, relation: 'depends_on' }
		]);
	});
});

describe('removing a dependency, refused', () => {
	// A caller who may not remove a link is refused before the link is looked
	// for. Were it the other way about, the answer would tell them whether a
	// card of a board they cannot edit waits on the one they named.
	const ASKED: { route: string; request: (w: World) => Req; link: (w: World) => void }[] = [
		{
			route: 'DELETE /api/cards/[id]/dependencies',
			request: (w) => json(`/api/cards/${w.A.loose.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			link: (w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.loose })
		},
		{
			route: 'DELETE /api/v1/cards/[cardId]/dependencies',
			request: (w) => json(`/api/v1/cards/${w.A.loose.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			link: (w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.loose })
		},
		{
			route: 'DELETE /api/subtasks/[id]/dependencies',
			request: (w) => json(`/api/subtasks/${w.A.otherSub.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			link: (w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.otherSub })
		},
		{
			route: 'DELETE /api/v1/subtasks/[subtaskId]/dependencies',
			request: (w) => json(`/api/v1/subtasks/${w.A.otherSub.id}/dependencies`, { blocksCardId: w.B.loose.id }),
			link: (w) => void makeDependency({ blocked: w.B.loose, blocker: w.A.otherSub })
		}
	];

	for (const { route, request, link } of ASKED) {
		it(`${route} answers an editor of the blocking end's board the same whether the link is there or not`, async () => {
			const [method, pattern] = route.split(' ') as [Method, string];

			// `editor` edits board A, where the end that is waited on is, and cannot open board B.
			const without = await call(method, pattern, request(w), 'editor');
			link(w);
			const before = snapshotDb();
			const withIt = await call(method, pattern, request(w), 'editor');

			expect(without.status).toBe(403);
			expect(withIt.status).toBe(403);
			expect(withIt.body).toEqual(without.body);
			expectUnchanged(before);

			// And it is there to be found by a caller who may remove it: 404 once it is gone.
			expect((await call(method, pattern, request(w), 'editsB')).status).toBe(200);
			expect((await call(method, pattern, request(w), 'editsB')).status).toBe(404);
		});

		it(`${route} tells both ends' boards that the link is gone`, async () => {
			const [method, pattern] = route.split(' ') as [Method, string];
			link(w);

			// The request is to the address of the end that is waited on, on board
			// A. The end that waits is on board B, and that is the board whose
			// work changed: each route used to tell the board in its address alone.
			const res = await call(method, pattern, request(w), 'editsB');
			await sent.settle();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(sent.events.map((event) => `${event.event} on board ${event.boardId}`).sort()).toEqual(
				[`update on board ${w.A.board.id}`, `update on board ${w.B.board.id}`].sort()
			);
			expect(sent.duringTransaction).toEqual([]);
		});
	}

	it('tells the one board once, where both ends are on it, and both boards from the address of the end that waits', async () => {
		const events = async () => {
			await sent.settle();
			const boards = sent.events.map((event) => event.boardId).sort((a, b) => a - b);
			sent.clear();
			return boards;
		};

		// Board A's `loose` is made to wait on board A's `other`.
		for (const route of ['/api/cards', '/api/v1/cards']) {
			makeDependency({ blocked: w.A.loose, blocker: w.A.other });
			const res = await api('DELETE', `${route}/${w.A.loose.id}/dependencies`, {
				user: w.editor,
				body: { dependsOnCardId: w.A.other.id }
			});
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(await events()).toEqual([w.A.board.id]);
		}

		// Board B's `loose` waits on board A's `loose`, and is asked to stop at its own address.
		for (const route of ['/api/cards', '/api/v1/cards']) {
			makeDependency({ blocked: w.B.loose, blocker: w.A.loose });
			const res = await api('DELETE', `${route}/${w.B.loose.id}/dependencies`, {
				user: w.outsider,
				body: { dependsOnCardId: w.A.loose.id }
			});
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(await events()).toEqual([w.A.board.id, w.B.board.id].sort((a, b) => a - b));
		}
	});

	it('DELETE /api/v1/cards/[cardId]/dependencies writes its activity entry on the board of the end that waits', async () => {
		const entries = () =>
			db
				.select()
				.from(activityLog)
				.where(eq(activityLog.action, 'api:dependency_removed'))
				.all()
				.map(({ boardId, cardId, userId, detail }) => ({ boardId, cardId, userId, detail }));
		const remove = (who: Exclude<Who, 'nobody'>, card: Card, body: unknown) =>
			api('DELETE', `/api/v1/cards/${card.id}/dependencies`, { user: w[who], body });

		// `editsB` edits board B, where the end that waits is, and can only view
		// board A, whose card is in the address. The entry used to be written on
		// board A, and board B's history said nothing of its card being let go.
		makeDependency({ blocked: w.B.loose, blocker: w.A.loose });
		expect((await remove('editsB', w.A.loose, { blocksCardId: w.B.loose.id })).status).toBe(200);
		expect(entries()).toEqual([
			{
				boardId: w.B.board.id,
				cardId: w.B.loose.id,
				userId: w.editsB.id,
				detail: `#${w.B.loose.id} no longer waits on #${w.A.loose.id}`
			}
		]);

		// A subtask that waits: the entry is on its card's board, and names its card.
		db.delete(activityLog).run();
		makeDependency({ blocked: w.B.sub, blocker: w.A.loose });
		expect((await remove('editsB', w.A.loose, { blocksSubtaskId: w.B.sub.id })).status).toBe(200);
		expect(entries()).toEqual([
			{
				boardId: w.B.board.id,
				cardId: w.B.card.id,
				userId: w.editsB.id,
				detail: `subtask #${w.B.sub.id} no longer waits on #${w.A.loose.id}`
			}
		]);

		// Both ends on one board, removed at the address of the end that is waited
		// on: the entry names the card in the address, as it always did.
		db.delete(activityLog).run();
		makeDependency({ blocked: w.A.loose, blocker: w.A.other });
		expect((await remove('editor', w.A.other, { blocksCardId: w.A.loose.id })).status).toBe(200);
		expect(entries()).toEqual([
			{
				boardId: w.A.board.id,
				cardId: w.A.other.id,
				userId: w.editor.id,
				detail: `#${w.A.loose.id} no longer waits on #${w.A.other.id}`
			}
		]);
	});
});

describe('the routes under /api/users and /api/account, what they answer', () => {
	// A password hash is nobody's to be told: not the account's own user, and
	// not an administrator. PUT /api/users/[id] used to answer the whole row
	// when there was nothing to change. Every route of the two trees is asked
	// here, by each kind of caller, with the request the table makes for it:
	// the table has an entry for every route, so a new one is asked too.
	const ASKED = Object.keys(TABLE).filter((key) => /^[A-Z]+ \/api\/(users|account)(\/|$)/.test(key));
	const CALLERS = ['nobody', 'owner', 'admin', 'chief'] as const;

	/** A change of nothing, which is where the whole row used to be answered. */
	const MORE: Record<string, ((w: World) => Req)[]> = {
		'PUT /api/users/[id]': [(w) => json(`/api/users/${w.viewer.id}`, {}), (w) => json(`/api/users/${w.admin.id}`, {})]
	};

	it('asks every route of the two trees', () => {
		const patterns = new Set(ASKED.map((key) => key.split(' ')[1]));
		const tree = routePatterns().filter((pattern) => /^\/api\/(users|account)(\/|$)/.test(pattern));
		expect([...patterns].sort()).toEqual(tree.sort());
		expect(tree.length).toBeGreaterThanOrEqual(10);
	});

	for (const key of ASKED) {
		const [method, pattern] = key.split(' ') as [Method, string];
		const requests = [...[TABLE[key]].flat().map((c) => c.req), ...(MORE[key] ?? [])];

		for (const who of CALLERS) {
			it(`${key} answers ${CALLED[who]} with no password hash`, async () => {
				for (const c of [TABLE[key]].flat()) c.setup?.(w);
				// A real hash for everyone, the superadmin included: it is what is looked for.
				db.update(users).set({ passwordHash: PASSWORD_HASH }).run();
				const by = who === 'nobody' ? null : w[who];

				for (const request of requests) {
					const { path, body, headers } = parts(request(w));
					expectPathOf(pattern, path);

					const res = await api(method, path, { user: by, body, headers: asCaller(headers, who) });

					const text = asText(res);
					expect(text, `${method} ${path}`).not.toMatch(/password_?hash/i);
					// How every bcrypt hash begins.
					expect(text, `${method} ${path}`).not.toContain('$2');
					expect(text, `${method} ${path}`).not.toContain(PASSWORD_HASH);
				}
			});
		}
	}
});

describe('recent activity, on the boards the caller can open (card 2126)', () => {
	type Entry = { boardId: number; detail: string | null };

	/** A moment `minutes` before noon on 2026-10-14, written as SQLite writes `datetime('now')`. */
	const before = (minutes: number) =>
		new Date(Date.parse('2026-10-14T12:00:00Z') - minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);

	const logged = (who: SessionUser, board: Board, detail: string, minutes: number) =>
		db
			.insert(activityLog)
			.values({ boardId: board.id, userId: who.id, action: 'card_updated', detail, userName: who.username, source: 'ui', createdAt: before(minutes) })
			.run();

	const stats = async (who: Exclude<Who, 'nobody'>): Promise<Entry[]> => {
		const res = await api('GET', '/api/v1/me/stats', { user: w[who] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return res.body.recentActivity;
	};
	const dashboard = async (who: Exclude<Who, 'nobody'>): Promise<Entry[]> =>
		((await pageData('/', who)).analytics as { recentActivity: Entry[] }).recentActivity;

	beforeEach(() => {
		// `outsider`'s entry on board A, from when they could open it, is their
		// newest. The fixture's entry of theirs on board B is a minute older, and
		// 25 more on board B a minute older each than the one before. Set here,
		// not left to the clock: written in one second, which of them came first
		// is down to how SQLite breaks a tie, and board A's could fall outside the
		// 20 by chance.
		const ofOutsider = (board: Board) => and(eq(activityLog.userId, w.outsider.id), eq(activityLog.boardId, board.id));
		db.update(activityLog).set({ createdAt: before(0) }).where(ofOutsider(w.A.board)).run();
		db.update(activityLog).set({ createdAt: before(1) }).where(ofOutsider(w.B.board)).run();
		for (let n = 1; n <= 25; n++) logged(w.outsider, w.B.board, `On board B, ${n}`, 1 + n);
	});

	it('gives a former member their 20 newest on the boards they can open, and none of a board they lost, in both places', async () => {
		// Twenty-six on board B, and the newest of all on board A. Filtered
		// after the limit, the 20 newest would be board A's and 19 of board B's,
		// and board A's taken out would leave 19.
		const expected = ['Created "kept-to-board-B card"', ...Array.from({ length: 19 }, (_, i) => `On board B, ${i + 1}`)];

		const fromStats = await stats('outsider');
		expect(fromStats.map((entry) => entry.detail)).toEqual(expected);
		expect(fromStats.every((entry) => entry.boardId === w.B.board.id)).toBe(true);

		const fromDashboard = await dashboard('outsider');
		expect(fromDashboard.map((entry) => entry.detail)).toEqual(expected.slice(0, 10));
		expect(JSON.stringify([fromStats, fromDashboard])).not.toContain(MARK);
	});

	it('still lists a member their entries on the board, and an administrator theirs on every board', async () => {
		// `editor` wrote the fixture's entry on board A, which they can open.
		expect((await stats('editor')).map((entry) => entry.boardId)).toEqual([w.A.board.id]);

		// An administrator opens every board, the ones they are no member of among them.
		logged(w.admin, w.A.board, `${MARK} by an administrator`, 0);
		logged(w.admin, w.B.board, `${MARK_B} by an administrator`, 1);
		logged(w.admin, w.alone, `${MARK} on the second board, by an administrator`, 2);
		const everyBoard = [w.A.board.id, w.B.board.id, w.alone.id];

		expect((await stats('admin')).map((entry) => entry.boardId)).toEqual(everyBoard);
		expect((await dashboard('admin')).map((entry) => entry.boardId)).toEqual(everyBoard);
	});

	it('reads the log newest first by its index of time and stops at the limit, rather than sort every entry on the boards', () => {
		// The board is asked as `+board_id`. Asked plainly, SQLite took the index
		// of board and time and sorted every entry the caller had on those
		// boards: 55 ms against 2.9 ms on 200,000 entries (card 2126's review).
		const prepared: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		const spy = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			prepared.push(source);
			return prepare(source);
		}) as typeof sqlite.prepare);
		try {
			expect(recentActivityFor(w.outsider, 20)).toHaveLength(20);
		} finally {
			spy.mockRestore();
		}

		const read = prepared.filter((source) => source.includes('activity_log'));
		expect(read).toHaveLength(1);
		const bound = Array.from({ length: (read[0].match(/\?/g) ?? []).length }, () => w.outsider.id);
		const plan = (sqlite.prepare(`EXPLAIN QUERY PLAN ${read[0]}`).all(...bound) as { detail: string }[]).map((row) => row.detail);
		expect(plan).toEqual([expect.stringMatching(/^SCAN activity_log USING INDEX idx_activity_log_created_at$/)]);
	});
});

/** What the page at `path` gives `who`, its load called as SvelteKit calls it. It must give its data. */
async function pageData(path: string, who: Exclude<Who, 'nobody'>): Promise<Record<string, unknown>> {
	const res = await pageLoad(path, { user: w[who] });
	if (res.type !== 'data') throw new Error(`${path} gave ${CALLED[who]} no data: ${JSON.stringify(res)}`);
	return res.data;
}

describe('what the lists give (card 2128)', () => {
	type Row = { id: number; name?: string; username?: string; carried?: true; members?: { userId: number }[] };

	const answered = async (path: string, who: Exclude<Who, 'nobody'>): Promise<Row[]> => {
		const res = await api('GET', path, { user: w[who] });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		return res.body;
	};

	const ids = (rows: { id: number }[]) => rows.map((row) => row.id).sort((a, b) => a - b);

	describe('people and teams', () => {
		it('lists every user to an ordinary caller by id, name and emoji, and with the address, role and creation date to an administrator', async () => {
			const everyone = ids(db.select({ id: users.id }).from(users).all());

			for (const who of ['outsider', 'viewer', 'owner'] as const) {
				const listed = await answered('/api/users', who);
				expect(ids(listed), who).toEqual(everyone);
				for (const user of listed) expect(Object.keys(user).sort(), who).toEqual(['emoji', 'id', 'username']);
				expect(JSON.stringify(listed), who).not.toContain('@');
			}
			for (const who of ['admin', 'chief'] as const) {
				const listed = await answered('/api/users', who);
				expect(ids(listed), who).toEqual(everyone);
				for (const user of listed) {
					expect(Object.keys(user).sort(), who).toEqual(['createdAt', 'email', 'emoji', 'id', 'role', 'username']);
				}
			}
		});

		it("lists every team by name, and its members only to the team's own and to an administrator", async () => {
			const inTheTeam = ids([w.owner, w.editor, w.guest]);

			for (const who of ['outsider', 'viewer'] as const) {
				const team = (await answered('/api/teams', who)).find((row) => row.id === w.team.id)!;
				expect(team.name, who).toBe(`${MARK} team`);
				expect(team, who).not.toHaveProperty('members');
			}
			for (const who of ['editor', 'guest', 'owner', 'admin', 'chief'] as const) {
				const team = (await answered('/api/teams', who)).find((row) => row.id === w.team.id)!;
				expect(team.members!.map((m) => m.userId).sort((a, b) => a - b), who).toEqual(inTheTeam);
			}
		});

		it("gives the teams page no other user's address, but to an administrator", async () => {
			const everyone = ids(db.select({ id: users.id }).from(users).all());

			const data = await pageData('/teams', 'outsider');
			expect(ids(data.users as Row[])).toEqual(everyone);
			// The caller's own account is in the page as theirs; nobody else's address is.
			expect(JSON.stringify({ ...data, currentUser: null })).not.toContain('@');

			const asAdmin = await pageData('/teams', 'admin');
			expect((asAdmin.users as { email?: string }[]).map((u) => u.email)).toContain(w.viewer.email);
		});
	});

	describe('dashboard groupings', () => {
		/** A grouping made in Manage Categories, with no board filed under it yet. */
		let empty: BoardCategory;
		beforeEach(() => {
			empty = db.insert(boardCategories).values({ name: 'Nothing filed yet' }).returning().get();
		});

		/** Every list of groupings a caller is given: the two routes and three pages. */
		const everyList = async (who: Exclude<Who, 'nobody'>): Promise<Record<string, Row[]>> => ({
			'GET /api/board-categories': await answered('/api/board-categories', who),
			'GET /api/v1/board-categories': await answered('/api/v1/board-categories', who),
			dashboard: (await pageData('/', who)).allCategories as Row[],
			'All Tasks': (await pageData('/all', who)).boardCategories as Row[],
			Reports: (await pageData('/reports', who)).categories as Row[]
		});

		it('lists a caller the groupings that hold a board they can open and the empty ones, and not one of boards they cannot open', async () => {
			for (const [where, listed] of Object.entries(await everyList('outsider'))) {
				expect(ids(listed), where).toEqual(ids([w.grouping, empty]));
				expect(JSON.stringify(listed), where).not.toContain(MARK);
			}
			// `viewer` can open the one board under `groupingOfA`.
			for (const [where, listed] of Object.entries(await everyList('viewer'))) {
				expect(ids(listed), where).toEqual(ids([w.grouping, w.groupingOfA, empty]));
			}
			const every = ids(db.select({ id: boardCategories.id }).from(boardCategories).all());
			for (const [where, listed] of Object.entries(await everyList('admin'))) expect(ids(listed), where).toEqual(every);
		});

		it('gives one by its id to a caller it is listed to, an empty one included, and refuses the rest', async () => {
			expect((await api('GET', `/api/v1/board-categories/${empty.id}`, { user: w.outsider })).status).toBe(200);

			const refused = await api('GET', `/api/v1/board-categories/${w.groupingOfA.id}`, { user: w.outsider });
			expect([refused.status, refused.body]).toEqual([403, { message: 'No access to this board category' }]);
			for (const path of ['/api/burndown', '/api/v1/burndown']) {
				const chart = await api('GET', `${path}?boardCategoryId=${w.groupingOfA.id}`, { user: w.outsider });
				expect([chart.status, chart.body], path).toEqual([403, { message: `No access to board category ${w.groupingOfA.id}` }]);
			}
		});

		it('refuses to file a board under a grouping the caller is not listed, in both trees and on a new board, and writes nothing', async () => {
			const before = snapshotDb();
			const refusals = [
				await api('PUT', `/api/boards/${w.B.board.id}`, { user: w.outsider, body: { categoryId: w.groupingOfA.id } }),
				await api('PUT', `/api/v1/boards/${w.B.board.id}`, { user: w.outsider, body: { categoryId: w.groupingOfA.id } }),
				await api('POST', '/api/boards', { user: w.outsider, body: { name: 'A new board', categoryId: w.groupingOfA.id } })
			];
			for (const res of refusals) expect([res.status, res.body]).toEqual([403, { message: 'No access to this board category' }]);
			expectUnchanged(before);
		});

		it('files a board under a grouping the caller is listed, an empty one included, and lets an administrator file one under any', async () => {
			// A second board of `outsider`'s, under no grouping. `grouping` is listed
			// to them for board B, which is under it.
			const theirs = makeBoard({ owner: w.outsider, name: 'Another board' }).board;
			const filedUnder = () => db.select({ categoryId: boards.categoryId }).from(boards).where(eq(boards.id, theirs.id)).get()!.categoryId;

			expect((await api('PUT', `/api/boards/${theirs.id}`, { user: w.outsider, body: { categoryId: w.grouping.id } })).status).toBe(200);
			expect(filedUnder()).toBe(w.grouping.id);
			expect((await api('PUT', `/api/v1/boards/${theirs.id}`, { user: w.outsider, body: { categoryId: empty.id } })).status).toBe(200);
			expect(filedUnder()).toBe(empty.id);
			const made = await api('POST', '/api/boards', { user: w.outsider, body: { name: 'A new board', categoryId: w.grouping.id } });
			expect([made.status, made.body.categoryId]).toEqual([201, w.grouping.id]);

			expect((await api('PUT', `/api/v1/boards/${theirs.id}`, { user: w.admin, body: { categoryId: w.groupingOfA.id } })).status).toBe(200);
			expect(filedUnder()).toBe(w.groupingOfA.id);
		});
	});

	describe('card categories', () => {
		const names = (rows: Row[]) => rows.map((row) => row.name).sort();

		it('lists a caller the categories of no board and of the boards they can open', async () => {
			expect(names(await answered('/api/categories', 'outsider'))).toEqual([`${MARK_B} category`, 'Shared category'].sort());
			expect(names(await answered('/api/categories', 'viewer'))).toEqual([`${MARK} category`, 'Shared category'].sort());
			expect(names(await answered('/api/categories', 'admin'))).toEqual([`${MARK} category`, `${MARK_B} category`, 'Shared category'].sort());

			const refused = await api('GET', `/api/v1/categories/${w.A.category.id}`, { user: w.outsider });
			expect([refused.status, refused.body]).toEqual([403, { message: 'No access to this category' }]);
		});

		it('names a category a card carries from a board the caller cannot open, on purpose, marked carried, where the card is shown', async () => {
			// Given before a card was held to its own board's categories.
			db.update(cards).set({ categoryId: w.B.category.id }).where(eq(cards.id, w.A.card.id)).run();
			const carried = { id: w.B.category.id, name: `${MARK_B} category`, carried: true };

			const boardPage = (await pageData(`/board/${w.A.board.id}`, 'viewer')).categories as Row[];
			const allTasks = (await pageData('/all', 'viewer')).categories as Row[];
			const context = (await api('GET', `/api/cards/${w.A.card.id}/context`, { user: w.viewer })).body.categories as Row[];
			for (const [where, listed] of Object.entries({ boardPage, allTasks, context })) {
				expect(listed.find((row) => row.id === w.B.category.id), where).toMatchObject(carried);
				// The board's own and the shared one are the caller's, and not marked.
				expect(names(listed.filter((row) => !row.carried)), where).toEqual([`${MARK} category`, 'Shared category'].sort());
			}
			// Nowhere else: the list of what may be picked does not have it.
			expect(names(await answered('/api/categories', 'viewer'))).not.toContain(`${MARK_B} category`);
			// An administrator can open board B, and is given it as any other.
			const asAdmin = (await pageData(`/board/${w.A.board.id}`, 'admin')).categories as Row[];
			expect(asAdmin.find((row) => row.id === w.B.category.id)).not.toHaveProperty('carried');
		});

		// Card 2117 (R3) already holds a card to its own board's categories and
		// the shared ones, which the caller can always open: a category of a
		// board they cannot open is refused there, as one of any other board is,
		// 404 "Category not found on this board", and needs no check of its own.
		it("refuses to give a card a category of a board the caller cannot open on the four card writes, and keeps one a card carries", async () => {
			const before = snapshotDb();
			const toDo = w.B.cols['To Do'].id;
			const refusals = [
				await api('POST', '/api/cards', { user: w.outsider, body: { columnId: toDo, title: 'A card', categoryId: w.A.category.id } }),
				await api('PUT', `/api/cards/${w.B.card.id}`, { user: w.outsider, body: { categoryId: w.A.category.id } }),
				await api('POST', `/api/v1/boards/${w.B.board.id}/cards`, { user: w.outsider, body: { columnId: toDo, title: 'A card', categoryId: w.A.category.id } }),
				await api('PUT', `/api/v1/cards/${w.B.card.id}`, { user: w.outsider, body: { categoryId: w.A.category.id } })
			];
			for (const res of refusals) expect([res.status, res.body]).toEqual([404, { message: 'Category not found on this board' }]);
			expectUnchanged(before);

			for (const categoryId of [w.B.category.id, w.sharedCategory.id]) {
				expect((await api('PUT', `/api/cards/${w.B.card.id}`, { user: w.outsider, body: { categoryId } })).status).toBe(200);
				expect((await api('PUT', `/api/v1/cards/${w.B.card.id}`, { user: w.outsider, body: { categoryId } })).status).toBe(200);
			}

			// One it carries, sent back with a new title as the card window sends it, is kept.
			db.update(cards).set({ categoryId: w.A.category.id }).where(eq(cards.id, w.B.card.id)).run();
			for (const [path, title] of [[`/api/cards/${w.B.card.id}`, 'Renamed'], [`/api/v1/cards/${w.B.card.id}`, 'Renamed again']]) {
				const res = await api('PUT', path, { user: w.outsider, body: { title, categoryId: w.A.category.id } });
				expect(res.status, JSON.stringify(res.body)).toBe(200);
				expect(db.select().from(cards).where(eq(cards.id, w.B.card.id)).get()).toMatchObject({ title, categoryId: w.A.category.id });
			}
		});
	});

	describe('the public request form', () => {
		it('lists every user and team to a holder of the form token, and no board', async () => {
			const res = await api('GET', '/api/requests/targets', { headers: { 'x-form-token': issueFormToken() } });
			expect(res.status).toBe(200);
			const listed = (type: string) => ids(res.body.targets.filter((t: { type: string }) => t.type === type));
			expect(listed('user')).toEqual(ids(db.select({ id: users.id }).from(users).all()));
			expect(listed('team')).toEqual([w.team.id]);
			expect(res.body.boards).toEqual([]);
		});

		it('lists a signed-in caller the boards they can open', async () => {
			const listed = await api('GET', '/api/requests/targets', { user: w.outsider });
			expect(ids(listed.body.boards)).toEqual(ids([w.B.board, w.publicBoard.board]));

			const asAdmin = await api('GET', '/api/requests/targets', { user: w.admin });
			expect(ids(asAdmin.body.boards)).toEqual(ids(db.select({ id: boards.id }).from(boards).all()));
		});
	});

	describe('email addresses, to a signed-in caller who is no member of a public board (R1)', () => {
		beforeEach(() => {
			addBoardMember(w.publicBoard.board, w.viewer, 'viewer');
			addBoardMember(w.publicBoard.board, w.editor, 'editor');
		});

		it('are in neither the board page nor the card context: no screen reads one', async () => {
			const page = await pageData(`/board/${w.publicBoard.board.id}`, 'outsider');
			// Every administrator can be assigned the card, and is in the page by name.
			expect((page.boardUsers as Row[]).map((u) => u.username)).toContain('admin');
			expect(JSON.stringify(page)).not.toContain('@');

			const context = await api('GET', `/api/cards/${w.publicBoard.card.id}/context`, { user: w.outsider });
			expect(context.status).toBe(200);
			expect(JSON.stringify(context.body)).not.toContain('@');
		});

		it("are in the board's share list for its owner and an administrator only", async () => {
			for (const who of ['outsider', 'editor'] as const) {
				const res = await api('GET', `/api/boards/${w.publicBoard.board.id}/share`, { user: w[who] });
				expect(res.status, who).toBe(200);
				expect(res.body.members.map((m: { userId: number }) => m.userId).sort(), who).toEqual(ids([w.viewer, w.editor]));
				expect(JSON.stringify(res.body), who).not.toContain('@');
			}
			for (const who of ['owner', 'admin'] as const) {
				const res = await api('GET', `/api/boards/${w.publicBoard.board.id}/share`, { user: w[who] });
				expect(res.body.members.map((m: { email: string }) => m.email).sort(), who).toEqual([w.editor.email, w.viewer.email].sort());
			}
		});
	});
});

// ─── The other end of a dependency (card 2129) ─────────────────────────────

/**
 * The text a PDF draws: every string of every compressed content stream, in
 * order, run together. Enough to ask whether a name is in it, which the bytes
 * themselves do not say: the streams are compressed.
 */
function pdfText(bytes: Uint8Array): string {
	const raw = Buffer.from(bytes).toString('latin1');
	let text = '';
	for (const [, data] of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
		let content: string;
		try {
			content = inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
		} catch {
			continue; // not a compressed stream of drawing
		}
		for (const [, run] of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
			for (const [, hex] of run.matchAll(/<([0-9a-fA-F]*)>/g)) text += Buffer.from(hex, 'hex').toString('latin1');
		}
	}
	return text;
}

describe('the other end of a dependency, to a caller who cannot open its board (card 2129)', () => {
	/** An answer as it is read: its shape is what is being tested. */
	type Json = any;
	type Caller = Exclude<Who, 'nobody'>;

	// From the world, `A.card` waits on `awaited`, a card of board B. Here
	// `A.sub` waits on `B.loose` as well, so that the subtask routes have such
	// an end. What the writes add and remove is a link to `A.loose`, and the
	// answer to each still lists the end on board B.
	beforeEach(() => {
		makeDependency({ blocked: w.A.sub, blocker: w.B.loose, createdBy: w.both });
	});

	/**
	 * What an answer gives: all of it as text, every place in it where an end on
	 * board B is, every title it gives one, and whether what waits on it is
	 * blocked.
	 */
	type Read = { text: string; ends: Json[]; titles: string[]; blocked: boolean };

	/** The card `id` among a list of ends or nodes. */
	const ofCard = (list: Json[] | undefined, id: number): Json[] =>
		(list ?? []).filter((end: Json) => end.kind === 'card' && (end.cardId ?? end.id) === id);

	const answer = async (method: Method, path: string, who: Caller, body?: unknown): Promise<Json> => {
		const res = await api(method, path, { user: w[who], body });
		expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
		return res.body;
	};

	const read = (text: unknown, ends: Json[], blocked: boolean, titles: string[] = []): Read => ({
		text: JSON.stringify(text),
		ends,
		titles: [...ends.map((end) => end.title), ...titles],
		blocked
	});

	/** A list of a card's or a subtask's links, and the end on board B in it. */
	const links = (body: Json, id: number): Read => read(body, ofCard(body.blockedBy, id), body.isBlocked);

	/** A plan: both ends on board B, as nodes and as blockers, and whether board A's card waits on one. */
	const plan = (summary: Json, titles: string[] = []): Read => {
		const blockers = (summary.blocked as Json[]).flatMap((b: Json) => b.blockers);
		const waiting = (summary.blocked as Json[]).find((b: Json) => b.card.kind === 'card' && b.card.id === w.A.card.id);
		const ends = [w.awaited.id, w.B.loose.id].flatMap((id) => [...ofCard(summary.graph?.nodes, id), ...ofCard(blockers, id)]);
		return read(summary, ends, ofCard(waiting?.blockers, w.awaited.id).length === 1, titles);
	};

	/** A page's open blockers by card: the one of board A's card. */
	const chips = (data: Record<string, unknown>): Read => {
		const open = (data.blockedState as Record<number, Json[]>)[w.A.card.id];
		return read(data, ofCard(open, w.awaited.id), (open ?? []).length > 0);
	};

	/** The other end of the link the writes add and remove: their answer lists the end on board B beside it. */
	const toLoose = () => ({ dependsOnCardId: w.A.loose.id });

	/**
	 * Every answer that lists the other end of a link, and who asks for it who
	 * can open board A and not board B: a viewer, or an editor where the
	 * request is a write.
	 */
	const READS: { what: string; hidden: 'viewer' | 'editor'; read: (who: Caller) => Promise<Read> }[] = [
		{
			what: 'GET /api/cards/[id]/dependencies',
			hidden: 'viewer',
			read: async (who) => links(await answer('GET', `/api/cards/${w.A.card.id}/dependencies`, who), w.awaited.id)
		},
		{
			what: 'POST /api/cards/[id]/dependencies, its answer',
			hidden: 'editor',
			read: async (who) => links(await answer('POST', `/api/cards/${w.A.card.id}/dependencies`, who, toLoose()), w.awaited.id)
		},
		{
			what: 'DELETE /api/cards/[id]/dependencies, its answer',
			hidden: 'editor',
			read: async (who) => {
				makeDependency({ blocked: w.A.card, blocker: w.A.loose });
				return links(await answer('DELETE', `/api/cards/${w.A.card.id}/dependencies`, who, toLoose()), w.awaited.id);
			}
		},
		{
			what: 'GET /api/v1/cards/[cardId]/dependencies',
			hidden: 'viewer',
			read: async (who) => links(await answer('GET', `/api/v1/cards/${w.A.card.id}/dependencies`, who), w.awaited.id)
		},
		{
			what: 'GET /api/v1/cards/[cardId]',
			hidden: 'viewer',
			read: async (who) => links(await answer('GET', `/api/v1/cards/${w.A.card.id}`, who), w.awaited.id)
		},
		...(['/api/subtasks/[id]', '/api/v1/subtasks/[subtaskId]'] as const).flatMap((route) => {
			const path = () => `${route.replace(/\[[^\]]+\]$/, String(w.A.sub.id))}/dependencies`;
			return [
				{
					what: `GET ${route}/dependencies`,
					hidden: 'viewer' as const,
					read: async (who: Caller) => links(await answer('GET', path(), who), w.B.loose.id)
				},
				{
					what: `POST ${route}/dependencies, its answer`,
					hidden: 'editor' as const,
					read: async (who: Caller) => links(await answer('POST', path(), who, toLoose()), w.B.loose.id)
				},
				{
					what: `DELETE ${route}/dependencies, its answer`,
					hidden: 'editor' as const,
					read: async (who: Caller) => {
						makeDependency({ blocked: w.A.sub, blocker: w.A.loose });
						return links(await answer('DELETE', path(), who, toLoose()), w.B.loose.id);
					}
				}
			];
		}),
		{
			what: 'GET /api/milestones/[id]/summary',
			hidden: 'viewer',
			read: async (who) => plan(await answer('GET', `/api/milestones/${w.A.milestone.id}/summary`, who))
		},
		{
			what: 'GET /api/v1/milestones/[milestoneId]/summary',
			hidden: 'viewer',
			read: async (who) => plan(await answer('GET', `/api/v1/milestones/${w.A.milestone.id}/summary`, who))
		},
		{
			what: 'GET /api/v1/milestones/[milestoneId]/summary?compact=true',
			hidden: 'viewer',
			read: async (who) => {
				const summary = await answer('GET', `/api/v1/milestones/${w.A.milestone.id}/summary?compact=true`, who);
				return plan(summary, [summary.cardTitles[w.awaited.id], summary.cardTitles[w.B.loose.id]]);
			}
		},
		{
			what: 'the board page',
			hidden: 'viewer',
			read: async (who) => chips(await pageData(`/board/${w.A.board.id}`, who))
		},
		{
			what: 'All Tasks',
			hidden: 'viewer',
			read: async (who) => chips(await pageData('/all', who))
		},
		{
			what: 'the plan page',
			hidden: 'viewer',
			read: async (who) => plan((await pageData(`/plan/${w.A.milestone.id}`, who)).summary)
		}
	];

	for (const { what, hidden, read: reading } of READS) {
		it(`${what}: lists it to ${CALLED[hidden]}, who cannot open board B, by its id, what it is and whether it is finished, and nothing more`, async () => {
			const seen = await reading(hidden);

			expect(seen.ends.length).toBeGreaterThan(0);
			for (const end of seen.ends) {
				expect(end.withheld).toBe(true);
				expect(end.title).toBe(WITHHELD_CARD_TITLE);
				expect(end.boardName).toBe(WITHHELD_BOARD_NAME);
				expect(end.boardId).toBeNull();
				expect(end.columnName ?? end.columnTitle).toBe('');
				for (const key of ['priority', 'columnId', 'milestoneId', 'parentCardId']) if (key in end) expect(end[key], key).toBeNull();
				expect(end.resolved ?? end.isComplete).toBe(false);
			}
			expect(seen.titles.filter((title) => title !== WITHHELD_CARD_TITLE)).toEqual([]);
			expect(seen.text).not.toContain(MARK_B);
			// It is still there, and what waits on it is still blocked.
			expect(seen.blocked).toBe(true);
		});

		for (const who of ['editsA', 'both', 'admin'] as const) {
			it(`${what}: names it to ${CALLED[who]}`, async () => {
				const seen = await reading(who);

				expect(seen.ends.length).toBeGreaterThan(0);
				for (const end of seen.ends) {
					expect(end.withheld).toBe(false);
					expect(end.boardId).toBe(w.B.board.id);
					expect(end.boardName).toBe(`${MARK_B} board`);
				}
				expect(seen.titles.filter((title) => !title.startsWith(MARK_B))).toEqual([]);
				expect(seen.blocked).toBe(true);
			});
		}
	}

	describe('a card of the milestone moved to board B, which keeps the milestone (R4)', () => {
		// `A.other`, which waits on `A.card`, and `A.loose` are put in the
		// milestone. `A.loose` has two steps, the second waiting on the first,
		// and `A.card` waits on the second. Then `A.loose` is moved to board B,
		// as an editor of both boards may move it: it keeps the milestone (found
		// nearby 9). Written straight to the table, so that this stands when a
		// move stops keeping it.
		beforeEach(() => {
			db.update(cards).set({ milestoneId: w.A.milestone.id }).where(inArray(cards.id, [w.A.other.id, w.A.loose.id])).run();
			const first = makeSubtask(w.A.loose, { title: `${MARK} first step` });
			const second = makeSubtask(w.A.loose, { title: `${MARK} second step` });
			makeDependency({ blocked: second, blocker: first });
			makeDependency({ blocked: w.A.card, blocker: second });
			db.update(cards).set({ columnId: w.B.cols['To Do'].id }).where(eq(cards.id, w.A.loose.id)).run();
		});

		const summaries = async (who: Caller): Promise<Record<string, Json>> => ({
			'GET /api/milestones/[id]/summary': await answer('GET', `/api/milestones/${w.A.milestone.id}/summary`, who),
			'GET /api/v1/milestones/[milestoneId]/summary': await answer('GET', `/api/v1/milestones/${w.A.milestone.id}/summary`, who),
			'and with ?compact=true': await answer('GET', `/api/v1/milestones/${w.A.milestone.id}/summary?compact=true`, who),
			'the plan page': (await pageData(`/plan/${w.A.milestone.id}`, who)).summary
		});

		/** The longest chain runs through the moved card's two steps: its number stands in for them, as for any subtask. */
		const chain = () => [w.A.loose.id, w.A.card.id, w.A.other.id];

		it('gives a viewer of board A nothing of board B in the summary, whole and compact, or the plan page: the moved card is withheld', async () => {
			for (const [name, summary] of Object.entries(await summaries('viewer'))) {
				expect(JSON.stringify(summary), name).not.toContain(MARK_B);
				expect(summary.progress.boards, name).toContainEqual({ id: null, name: WITHHELD_BOARD_NAME, cardCount: 1 });
				expect(summary.progress.byColumn, name).toContainEqual({ columnTitle: '', count: 1 });
				expect(summary.progress.total, name).toBe(3);
				// Worked out from the work as it is: card ids only, and the same chain an administrator is given.
				expect(summary.criticalPath, name).toEqual(chain());
				expect(summary.criticalPathNodes.map((n: Json) => n.withheld), name).toEqual([true, true, false, false]);
				const moved = ofCard(summary.graph?.nodes ?? summary.nextActionable, w.A.loose.id);
				for (const node of moved) expect(node, name).toMatchObject({ withheld: true, title: WITHHELD_CARD_TITLE, boardId: null });
			}
		});

		it('gives a caller who can open board B its name, and the same chain', async () => {
			for (const [name, summary] of Object.entries(await summaries('editsA'))) {
				expect(summary.progress.boards, name).toContainEqual({ id: w.B.board.id, name: `${MARK_B} board`, cardCount: 1 });
				expect(summary.criticalPath, name).toEqual(chain());
				expect(summary.criticalPathNodes.map((n: Json) => n.withheld), name).toEqual([false, false, false, false]);
			}
		});

		/** The plan's PDF as `who` is given it, from either tree, as text. */
		const drawn = async (who: Caller, tree: 'session' | 'v1') => {
			const res =
				tree === 'session'
					? await gate('GET', `/api/milestones/${w.A.milestone.id}/pdf`, {
							headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(w[who])}` }
						})
					: await gate('GET', `/api/v1/milestones/${w.A.milestone.id}/pdf`, {
							headers: { authorization: `Bearer ${makeApiKey(w[who])}` }
						});
			expect(res.status).toBe(200);
			return pdfText(new Uint8Array(await res.arrayBuffer()));
		};

		it("gives a viewer of board A nothing of board B in the plan's PDF, from either tree", async () => {
			for (const tree of ['session', 'v1'] as const) {
				// Read as the pages draw it: an administrator's names board B.
				expect(await drawn('admin', tree), tree).toContain(MARK_B);
				const text = await drawn('viewer', tree);
				expect(text, tree).toContain(MARK);
				expect(text, tree).not.toContain(MARK_B);
			}
		});

		it("says in the plan's PDF what a withheld step is, and puts no separator after a withheld card's board", async () => {
			// `A.card` waits on the moved card's second step, which `viewer` is
			// given with no card: it was "step of #?". The moved card itself has
			// its board in words and no column: it was "A board you cannot open · ".
			for (const tree of ['session', 'v1'] as const) {
				const text = await drawn('viewer', tree);
				expect(text, tree).toContain(`waiting on a step of a card on a board you cannot open  ${WITHHELD_SUBTASK_TITLE}`);
				expect(text, tree).not.toContain('#?');
				expect(text, tree).toContain(WITHHELD_BOARD_NAME);
				expect(text, tree).not.toContain(`${WITHHELD_BOARD_NAME} ·`);
				// A step that is shown still names its card.
				expect(await drawn('editsA', tree), tree).toContain(`waiting on step of #${w.A.loose.id}`);
			}
		});

		it('lists the moved card withheld in the milestone to a viewer of board A, and by its board to one who can open board B', async () => {
			const listed = async (who: Caller) =>
				((await answer('GET', `/api/v1/milestones/${w.A.milestone.id}`, who)).cards as Json[]).sort((a, b) => a.id - b.id);
			const onA = (card: Card) => ({
				id: card.id,
				title: card.title,
				priority: card.priority,
				columnId: w.A.cols['To Do'].id,
				columnTitle: 'To Do',
				boardId: w.A.board.id,
				withheld: false
			});

			expect(await listed('viewer')).toEqual([
				onA(w.A.card),
				onA(w.A.other),
				{ id: w.A.loose.id, title: WITHHELD_CARD_TITLE, priority: null, columnId: null, columnTitle: '', boardId: null, withheld: true }
			]);
			expect(await listed('editsA')).toEqual([
				onA(w.A.card),
				onA(w.A.other),
				{ ...onA(w.A.loose), columnId: w.B.cols['To Do'].id, boardId: w.B.board.id }
			]);
		});

		it('charts the milestone for a viewer of board A on board A alone, in both trees, and says a card is left out', async () => {
			for (const path of ['/api/burndown', '/api/v1/burndown']) {
				const hiddenFrom = await answer('GET', `${path}?milestoneId=${w.A.milestone.id}`, 'viewer');
				expect(JSON.stringify(hiddenFrom), path).not.toContain(MARK_B);
				expect(hiddenFrom.scope.boards.map((b: Json) => b.id), path).toEqual([w.A.board.id]);
				expect(hiddenFrom.meta.cardCount, path).toBe(2);
				expect(hiddenFrom.meta.notes, path).toContain('1 card in this milestone is on a board not visible to you and is left out.');

				const opensB = await answer('GET', `${path}?milestoneId=${w.A.milestone.id}`, 'editsA');
				expect(opensB.scope.boards.map((b: Json) => b.name).sort(), path).toEqual([`${MARK} board`, `${MARK_B} board`]);
				expect(opensB.meta.cardCount, path).toBe(3);
				expect(opensB.meta.notes.join(' '), path).not.toContain('not visible to you');
			}
		});
	});
});

// ─── Every page load (card 2130) ───────────────────────────────────────────

describe('every page load, to a caller who cannot open a board (card 2130)', () => {
	/** An answer as it is read: its shape is what is being tested. */
	type Json = any;
	type Caller = Exclude<Who, 'nobody'>;

	/** The date `days` from today, as a card's due date is written. */
	const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

	/**
	 * A sub-board of board A's card, made by `outsider` when they were a member
	 * of board A. They own it, and nobody else but an administrator can open
	 * it: a sub-board inherits nothing from the board above it. `MARK_B` is in
	 * its name and its card's title, and the card has 7000 tokens of theirs.
	 */
	let hidden: { board: Board; cols: Record<string, Column>; cards: Card[] };

	beforeEach(() => {
		hidden = makeSubBoard(w.A.card, { owner: w.outsider, name: `${MARK_B} sub-board of board A's card` });
		db.update(cards).set({ title: `${MARK_B} card on the sub-board` }).where(eq(cards.id, hidden.cards[0].id)).run();
		db.insert(tokenUsage).values({ cardId: hidden.cards[0].id, tokens: 7000, model: 'claude-opus-5-5', reportedByUserId: w.outsider.id }).run();
		// The card of board A that is still assigned to `outsider`, due next
		// week: its title would be in their Upcoming Deadlines.
		db.update(cards).set({ dueDate: inDays(7) }).where(eq(cards.id, w.A.other.id)).run();
		// A request accepted onto board A's card, from someone with no account:
		// their address would be on the card for every viewer of the board.
		db.update(taskRequests).set({ status: 'accepted', resolvedCardId: w.A.card.id }).where(eq(taskRequests.id, w.request.id)).run();
	});

	/**
	 * Every `+page.server.ts` and `+layout.server.ts`, as `page <path>` or
	 * `layout <path>`: the paths its load is called for, or why it is not
	 * called. The first test fails for one with no entry, so a page cannot be
	 * added without being asked what it gives.
	 */
	const PAGES: Record<string, { paths: (w: World) => string[] } | { none: string }> = {
		'layout /': { none: "gives the caller's own account" },
		'page /': { paths: () => ['/'] },
		'page /account': { none: "gives the caller's own account" },
		'page /admin': { paths: () => ['/admin'] },
		'page /all': { paths: () => ['/all'] },
		'page /archived': { paths: () => ['/archived'] },
		'page /audit': { paths: () => ['/audit'] },
		'page /board/[id]': { paths: (w) => [w.A.board.id, w.B.board.id, hidden.board.id].map((id) => `/board/${id}`) },
		'page /burndown': { paths: (w) => ['/burndown', `/burndown?boardCategoryId=${w.groupingOfA.id}`] },
		'page /graph': { none: "gives the caller's own account: the graph is drawn from GET /api/graph, which the table asks" },
		'page /inbox': { paths: () => ['/inbox'] },
		'page /invite/[token]': { none: "gives the name of the account an invite is for, to the holder of the invite's link" },
		'page /login': { none: 'gives nothing, and sends a signed-in caller on' },
		'page /logout': { none: 'gives nothing: it sends every caller on' },
		'page /plan': { paths: (w) => ['/plan', `/plan?board=${w.A.board.id}`, `/plan?board=${w.B.board.id}`] },
		'page /plan/[id]': { paths: (w) => [`/plan/${w.A.milestone.id}`, `/plan/${w.B.milestone.id}`] },
		'page /reports': { paths: () => ['/reports'] },
		'page /request': { none: 'gives a token for the form, or none to a signed-in caller' },
		'page /setup': { none: 'gives nothing, and sends every caller on once there is an account' },
		'page /teams': { paths: () => ['/teams'] }
	};

	/** What each caller of the sweep cannot open: `outsider` board A, and `viewer` board B and the sub-board. */
	const NOT_THEIRS = { outsider: MARK, viewer: MARK_B } as const;

	it('has an entry for every page and layout with a server load, and none for one that is not there', () => {
		expect(Object.keys(PAGES).sort()).toEqual(loadKeys());
	});

	for (const [key, entry] of Object.entries(PAGES)) {
		if (!('paths' in entry)) continue;
		const [kind, pattern] = key.split(' ');

		for (const who of ['outsider', 'viewer'] as const) {
			it(`${key}: refuses ${CALLED[who]}, or gives them nothing of a board they cannot open`, async () => {
				for (const path of entry.paths(w)) {
					expectPathOf(pattern, path);
					const res = await pageLoad(path, { user: w[who], layout: kind === 'layout' });
					expect(JSON.stringify(res), path).not.toContain(NOT_THEIRS[who]);
				}
			});

			// Every address in the fixture is at example.test: the users', and the
			// requester's of the request accepted onto board A's card.
			it(`${key}: gives ${CALLED[who]} no address but their own`, async () => {
				for (const path of entry.paths(w)) {
					const res = await pageLoad(path, { user: w[who], layout: kind === 'layout' });
					const addresses = JSON.stringify(res).match(/[\w.+-]+@example\.test/g) ?? [];
					expect(addresses.filter((address) => address !== w[who].email), path).toEqual([]);
				}
			});
		}
	}

	it('still gives each caller what they can open: the filters do not empty the pages', async () => {
		expect(JSON.stringify(await pageData('/', 'viewer'))).toContain(MARK);
		expect(JSON.stringify(await pageData(`/board/${w.A.board.id}`, 'viewer'))).toContain(MARK);
		expect(JSON.stringify(await pageData('/', 'outsider'))).toContain(MARK_B);
		const asAdmin = JSON.stringify(await pageData('/', 'admin'));
		expect(asAdmin).toContain(MARK);
		expect(asAdmin).toContain(MARK_B);
	});

	describe('the sub-board, where its card is shown', () => {
		const ids = (card: Json): number[] => (card.subBoards as { id: number }[]).map((sb) => sb.id);
		const WHERE: Record<string, (who: Caller) => Promise<number[]>> = {
			'the board page': async (who) => {
				const columns = (await pageData(`/board/${w.A.board.id}`, who)).columns as Json[];
				return ids(columns.flatMap((col) => col.cards).find((card: Json) => card.id === w.A.card.id));
			},
			'the card context': async (who) => {
				const res = await api('GET', `/api/cards/${w.A.card.id}/context`, { user: w[who] });
				expect(res.status).toBe(200);
				return ids(res.body.card);
			},
			'the dashboard tile': async (who) =>
				ids(((await pageData('/', who)).boards as Json[]).find((board: Json) => board.id === w.A.board.id))
		};

		it('is left off the card for a viewer of board A who cannot open it', async () => {
			for (const [where, subBoards] of Object.entries(WHERE)) expect(await subBoards('viewer'), where).toEqual([]);
		});

		it("is counted on the board page's card, with no name, while it has open cards, so that a drop onto Complete is stopped before the server refuses it", async () => {
			const counts = async (who: Caller) =>
				Object.fromEntries(
					((await pageData(`/board/${w.A.board.id}`, who)).columns as Json[])
						.flatMap((col) => col.cards)
						.map((card: Json) => [card.id, card.hiddenOpenCount])
				);
			const none = { [w.A.card.id]: 0, [w.A.other.id]: 0, [w.A.loose.id]: 0 };

			// Its one card is in To Do. `editor` may drop the card onto Complete, and is refused it.
			for (const who of ['viewer', 'editor'] as const) expect(await counts(who), who).toEqual({ ...none, [w.A.card.id]: 1 });
			const refused = await api('PUT', '/api/cards/reorder', {
				user: w.editor,
				body: { boardId: w.A.board.id, updates: [{ id: w.A.card.id, columnId: w.A.cols.Complete.id, position: 0 }] }
			});
			expect(refused.status).toBe(409);

			// An administrator, and the viewer once given it, see it on the card, where it is counted.
			expect(await counts('admin')).toEqual(none);
			addBoardMember(hidden.board, w.viewer, 'viewer');
			expect(await counts('viewer')).toEqual(none);

			// Finished, it holds nothing back.
			db.update(cards).set({ columnId: hidden.cols.Complete.id }).where(eq(cards.id, hidden.cards[0].id)).run();
			expect(await counts('editor')).toEqual(none);
		});

		it('is on the card for an administrator, and for the viewer once they are given it', async () => {
			for (const [where, subBoards] of Object.entries(WHERE)) expect(await subBoards('admin'), where).toEqual([hidden.board.id]);

			addBoardMember(hidden.board, w.viewer, 'viewer');
			for (const [where, subBoards] of Object.entries(WHERE)) expect(await subBoards('viewer'), where).toEqual([hidden.board.id]);
		});
	});

	describe("the dashboard's figures", () => {
		const figures = async (who: Caller) => {
			const data = (await pageData('/', who)) as Json;
			return {
				subBoards: data.analytics.totalSubBoards,
				cards: data.allTasksTotals.cards,
				tokens: data.allTasksTotals.tokenTotal,
				spentBy: (data.spendByUser.all as { userId: number }[]).map((row) => row.userId).sort((a, b) => a - b)
			};
		};

		it('count, walk into and cost only the sub-boards the caller can open', async () => {
			// Board A's token entry is `editor`'s, 1000. The sub-board's 7000 are `outsider`'s.
			const hiddenFrom = await figures('viewer');
			expect(hiddenFrom).toMatchObject({ subBoards: 0, tokens: 1000, spentBy: [w.editor.id] });

			addBoardMember(hidden.board, w.viewer, 'viewer');
			expect(await figures('viewer')).toEqual({
				subBoards: 1,
				cards: hiddenFrom.cards + 1,
				tokens: 8000,
				spentBy: [w.editor.id, w.outsider.id].sort((a, b) => a - b)
			});

			// Board B's 1000 as well.
			expect(await figures('admin')).toMatchObject({ subBoards: 1, tokens: 9000 });
		});

		it("count only the caller's cards on boards they can open, and name none of a board they were taken off", async () => {
			// `outsider` is assigned board B's card, due in five days, and board
			// A's other card, due next week.
			db.update(cards).set({ dueDate: inDays(5) }).where(eq(cards.id, w.B.card.id)).run();
			const analytics = async () => ((await pageData('/', 'outsider')) as Json).analytics;

			const lost = await analytics();
			expect(lost).toMatchObject({ totalAssigned: 1, active: 1 });
			expect(lost.upcomingDeadlines.map((d: Json) => d.title)).toEqual([`${MARK_B} card`]);

			// Given board A again, they are counted its card again.
			addBoardMember(w.A.board, w.outsider, 'viewer');
			const given = await analytics();
			expect(given).toMatchObject({ totalAssigned: 2, active: 2 });
			expect(given.upcomingDeadlines.map((d: Json) => d.title)).toEqual([`${MARK_B} card`, `${MARK} other card`]);
		});
	});

	describe('the breadcrumbs of a sub-board', () => {
		const crumb = (board: Board) => ({ label: board.name, emoji: board.emoji || '📋', href: `/board/${board.id}` });
		const WITHHELD = { label: WITHHELD_BOARD_NAME, emoji: '🔒', href: null };

		it('show a board above that the caller cannot open with no name and no link, and keep it, so that the page still offers Delete Sub-board', async () => {
			expect((await pageData(`/board/${hidden.board.id}`, 'outsider')).breadcrumbs).toEqual([WITHHELD]);
			expect((await pageData(`/board/${hidden.board.id}`, 'admin')).breadcrumbs).toEqual([crumb(w.A.board)]);
		});

		it('keep the name and link of a board above that the caller can open, beneath one they cannot', async () => {
			const deeper = makeSubBoard(hidden.cards[0], { owner: w.outsider, name: 'Two levels down' });

			expect((await pageData(`/board/${deeper.board.id}`, 'outsider')).breadcrumbs).toEqual([WITHHELD, crumb(hidden.board)]);
			expect((await pageData(`/board/${deeper.board.id}`, 'admin')).breadcrumbs).toEqual([crumb(w.A.board), crumb(hidden.board)]);
		});
	});

	it('offers to link under a card only boards the caller can open, as card 2139 already holds it to the boards they own', () => {
		let offered = 0;
		for (const who of Object.keys(CALLED).filter((c) => c !== 'nobody') as Caller[]) {
			for (const board of [w.A.board, w.B.board, w.alone, w.publicBoard.board, hidden.board]) {
				for (const linkable of linkableBoards(w[who], board.id)) {
					offered++;
					expect(canViewBoard(w[who], linkable.id), `${who} on ${board.name}: ${linkable.name}`).toBe(true);
				}
			}
		}
		expect(offered).toBeGreaterThan(0);
	});
});
