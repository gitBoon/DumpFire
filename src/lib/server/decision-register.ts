/**
 * decision-register.ts — the reads of card 2680: the register of every
 * decision the caller may view, across boards (`/decisions`), one person's
 * record of what they were asked and what they said
 * (`/decisions/people/[personId]`), and a decision's record view
 * (`/decisions/[id]/record`).
 *
 * The register lists exactly the decisions `requireDecision(…, 'view')` lets
 * through, worked out in one SQL predicate (`visibleWhere`), and held to it
 * by tests/decision-register.test.ts, case 3. `visibleDecisionIdsOf` is built
 * on it for every other list that must filter decisions by `view` (the card
 * window's, card 2687's plan view). A board is named by its current name and
 * id only to a caller who can open it; anyone else is given the name it had
 * when the decision was made, with no id (S1), and a board filter naming a
 * board the caller cannot open matches nothing, as an id of no board does
 * (D1). The person filter matches only the participations the caller's
 * person record of that person shows (decision 8), and nothing otherwise.
 *
 * The person record is the administrator's, the decider's (of their own
 * decisions, with `record`) or the person's own (rows of their person and
 * their account alone, S6). For anyone but an administrator the scope is
 * worked out first, and the person row read only on a hit (S5): a person who
 * is not there, a deleted one and one outside the caller's scope are the same
 * 404, with the same words. A removed participation the person may no longer
 * view shows nothing of the decision (S2).
 *
 * The record view is `record`'s: administrators and the decider. Each event's
 * detail is a new object built from `RECORD_DETAIL` (decision-record.ts)
 * alone, by `recordEntryOf`: no key ending in `Id` at any depth, a nested
 * object or array at a key the table does not name refused, another decision
 * named through `namedFor` only, and an address and the signed-in account to
 * an administrator alone (S3).
 *
 * A plain read module, not a service: it takes the signed-in account, `user:
 * SessionUser`, never `caller`, imports no `inWrite` and writes nothing, so
 * that a page load may call it (tests/check-at-the-write.test.ts, rule 4).
 * Every value reaches SQL as a bound parameter through Drizzle.
 */
import { error } from '@sveltejs/kit';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, max, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from './db';
import { foldsTo } from './db/fold-case';
import {
	boards,
	decisionOptions,
	decisionParticipants,
	decisions,
	people,
	peopleGroupMembers,
	peopleGroups,
	type Decision,
	type DecisionFlag,
	type DecisionParticipant,
	type DecisionResponse
} from './db/schema';
import type { SessionUser } from './auth';
import { editableBoardIds, getAccessibleBoardIds, isAdmin, isDisabledActor, ownedBoardIds, type Actor } from './board-access';
import { flagsOfParticipants } from './decision-flags';
import { questionsOfParticipations } from './decision-questions';
import {
	concernsOfParticipants,
	countedInRound,
	eventsOfParticipants,
	IDS_AT_ONCE,
	KEY_HIDDEN_EVENTS,
	OWN_RECORD_EVENTS,
	ownResponseOf,
	personOfAccount,
	RECORD_DETAIL,
	recordEventsOf,
	responsesOfParticipants,
	roundsOf,
	surveysAskedIn,
	type AskedSurveys,
	type DetailSpec,
	type EventKind,
	type RecordEventRow
} from './decision-record';
import { namedFor } from './decision-naming';
import { awaitingRulingSql, decisionStatus, listedStatusOf, shownStatusSql } from './decision-status';
import { readQueryId, readQueryIdOrNone } from './request-body';
import { requireDecision, requireUser } from './route-guards';
import {
	REGISTER_TABS,
	SHOWN_STATUSES,
	type KeyRecordEntry,
	type KeyRecordPage,
	type ListedBoard,
	type OwnRecordEvent,
	type Participation,
	type ParticipationDecision,
	type PersonHeader,
	type PersonRecord,
	type RecordAnswer,
	type RecordEntry,
	type RecordFlag,
	type RecordPage,
	type RecordResponse,
	type RegisterPage,
	type RegisterQuery,
	type RegisterRow,
	type RegisterTab,
	type RemovedParticipation
} from '$lib/decision-register-types';
import type { OwnFlag, ShownStatus } from '$lib/decision-view-types';
import { stamp, type Stamp } from '$lib/timestamps';

/** Open, Ruled and All: rows a page, newest first by id (decision 6). */
export const REGISTER_PAGE_SIZE = 50;

/** The two waiting tabs: unpaged, at most this many rows, with "Showing the first 200" past it (decision 6). */
export const REGISTER_WAITING_MAX = 200;

/** The board select: at most this many boards (decision 6). */
export const REGISTER_BOARDS_MAX = 500;

/** The person select: at most this many people for a search (decision 6, D13). */
export const PEOPLE_MATCHES_MAX = 25;

/** A person record: participations a page, newest first (decision 15). */
export const PERSON_PAGE_SIZE = 25;

/** A person record: the most events shown for one participation, then "More in the record" (decision 15). */
export const EVENTS_PER_PARTICIPATION = 200;

/** The record view's page: events a page, oldest first (decision 16). */
export const RECORD_PAGE_SIZE = 500;

/** The most events `readRecord` reads in one call, card 2688's PDF among its callers (decision 16). */
export const RECORD_READ_MAX = 5000;

/** How long the title filter may be, and the person search. */
const TITLE_FILTER_MAX = 200;
const PERSON_SEARCH_MAX = 100;

/** The one answer for a person who is not there, deleted, or outside the caller's scope (S5). */
const PERSON_NOT_FOUND = 'Person not found';

/** The 403 for a person record read through any source but the page's (card 2682, code review S3): it is read on the page alone. */
const PERSON_RECORD_PAGE_ONLY = "A person's record is read on the decisions page: an API key cannot";

// ─── The query (decision 7) ──────────────────────────────────────────────────

/**
 * The register's filters, read by allow-list before any query (decision 7):
 * `tab` and `status` one of the fixed values; `board`, `person` and `before`
 * ids; `q` and `who` trimmed and at most 200 and 100 characters. On a page
 * (`mode: 'page'`) a malformed value is dropped, as if not sent; through an
 * API (`mode: 'api'`, card 2682) it is a 400.
 */
export function registerQueryOf(params: URLSearchParams, mode: 'page' | 'api'): RegisterQuery {
	return {
		tab: choiceOf(params, 'tab', REGISTER_TABS, mode),
		status: choiceOf(params, 'status', SHOWN_STATUSES, mode),
		board: idOf(params, 'board', mode),
		person: idOf(params, 'person', mode),
		who: needleOf(params, 'who', PERSON_SEARCH_MAX, mode),
		q: needleOf(params, 'q', TITLE_FILTER_MAX, mode),
		before: idOf(params, 'before', mode)
	};
}

function choiceOf<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[], mode: 'page' | 'api'): T | null {
	const value = params.get(name);
	if (value === null || value === '') return null;
	if ((allowed as readonly string[]).includes(value)) return value as T;
	if (mode === 'api') error(400, `${name} must be one of: ${allowed.join(', ')}`);
	return null;
}

function idOf(params: URLSearchParams, name: string, mode: 'page' | 'api'): number | null {
	const value = params.get(name);
	return (mode === 'api' ? readQueryId(value, name) : readQueryIdOrNone(value)) ?? null;
}

function needleOf(params: URLSearchParams, name: string, max: number, mode: 'page' | 'api'): string | null {
	const value = params.get(name);
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	if (trimmed.length <= max) return trimmed;
	if (mode === 'api') error(400, `${name} must be at most ${max} characters`);
	return null;
}

// ─── Who sees which decisions (decision 1) ───────────────────────────────────

/**
 * What the caller's visibility is made from, read once: every board for an
 * administrator (null); otherwise the boards they can open, own and edit now.
 */
type Scope = { admin: true } | { admin: false; accessible: Set<number>; owned: Set<number>; editable: Set<number> };

function scopeOf(user: Actor): Scope {
	if (isAdmin(user)) return { admin: true };
	return {
		admin: false,
		accessible: new Set(getAccessibleBoardIds(user) ?? []),
		owned: ownedBoardIds(user) ?? new Set(),
		editable: editableBoardIds(user) ?? new Set()
	};
}

/** The decisions on which the account holds exactly one live participant row: `decisionAccess`'s participant role (decision 29). */
function oneLiveRowWhere(userId: number): SQL {
	return inArray(
		decisions.id,
		db
			.select({ id: decisionParticipants.decisionId })
			.from(decisionParticipants)
			.where(and(eq(decisionParticipants.userId, userId), isNull(decisionParticipants.removedAt)))
			.groupBy(decisionParticipants.decisionId)
			.having(sql`count(*) = 1`)
	);
}

/**
 * `mayDo(decisionAccess(user, d), 'view', d)` as one condition on
 * `decisions` (decision 1): nothing for an administrator; otherwise the
 * caller's own decisions as author or decider; one that is not a draft on a
 * board they can open now, or holding exactly one live participant row of
 * theirs; and a draft on a board they own. The board-edit rule never limits
 * `view`.
 */
function visibleWhere(user: Actor, scope: Scope): SQL | undefined {
	if (scope.admin) return undefined;
	return or(
		eq(decisions.authorUserId, user.id),
		eq(decisions.deciderUserId, user.id),
		and(ne(decisions.status, 'draft'), or(inArray(decisions.boardId, [...scope.accessible]), oneLiveRowWhere(user.id))),
		and(eq(decisions.status, 'draft'), inArray(decisions.boardId, [...scope.owned]))
	);
}

/**
 * The ids among `ids` of the decisions `user` may view (decision 1): one
 * query per `IDS_AT_ONCE`, by `visibleWhere`, and never `decisionAccess` per
 * row. For every list that must filter decisions by `view`.
 *
 * Card 2687 (E-M1, S-L1): it takes any `Actor`, as the plan's viewer is one,
 * and answers 401 to none, as it did. A disabled account, an administrator's
 * included, may view no decision (card 2671's rule): it is given the empty
 * set before its role is asked.
 */
export function visibleDecisionIdsOf(user: Actor | null | undefined, ids: readonly number[]): Set<number> {
	if (!user) error(401, 'Not authenticated');
	if (isDisabledActor(user)) return new Set();
	const visible = visibleWhere(user, scopeOf(user));
	const unique = [...new Set(ids)];
	const found = new Set<number>();
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ id: decisions.id })
			.from(decisions)
			.where(and(inArray(decisions.id, unique.slice(from, from + IDS_AT_ONCE)), visible))
			.all();
		for (const row of rows) found.add(row.id);
	}
	return found;
}

/**
 * The decisions the caller decides and may read the record of now (decision
 * 11): `mayDo(access, 'record', d)` for a caller whose only granting role is
 * `decider`, the decision's board deleted or one they can edit.
 */
function deciderScopeWhere(user: SessionUser, scope: Scope): SQL {
	const decided = eq(decisions.deciderUserId, user.id);
	if (scope.admin) return decided;
	return and(decided, or(isNull(decisions.boardId), inArray(decisions.boardId, [...scope.editable])))!;
}

/** A decision that has been opened: never a draft, and never one withdrawn as a draft. */
const openedWhere = (): SQL => and(ne(decisions.status, 'draft'), isNotNull(decisions.openedAt))!;

/**
 * The decisions holding a participation of `personId` that the caller's
 * person record of that person shows (decision 8): an administrator's, every
 * one; a decider's, those on decisions they decide with `record`; the
 * person's own, rows of their person and their account (S6). Nothing for
 * anyone else, and never a draft.
 */
function personScopeWhere(user: SessionUser, scope: Scope, personId: number): SQL {
	const rowsOf = (extra?: SQL) =>
		inArray(
			decisions.id,
			db
				.select({ id: decisionParticipants.decisionId })
				.from(decisionParticipants)
				.where(and(eq(decisionParticipants.personId, personId), extra))
		);
	if (scope.admin) return and(openedWhere(), rowsOf())!;
	const own = personOfAccount(user.id)?.id === personId;
	return and(openedWhere(), or(and(deciderScopeWhere(user, scope), rowsOf()), own ? rowsOf(eq(decisionParticipants.userId, user.id)) : undefined))!;
}

/**
 * The people a decider's person records reach (decisions 8 and 10), each by
 * the name the newest participation in their scope was given under (code
 * review S2): the snapshot their own decisions recorded, never the
 * directory's name now, which a decider is not told. One row a person, from a
 * grouped read of the newest participant row per person; `nameMatch` narrows
 * by that name, `personId` to one person.
 */
function deciderPeopleOf(user: SessionUser, scope: Scope, opts: { nameMatch?: string; personId?: number; limit: number }): { id: number; name: string }[] {
	const newest = db
		.select({ personId: decisionParticipants.personId, newestId: max(decisionParticipants.id).as('newest_id') })
		.from(decisionParticipants)
		.innerJoin(decisions, eq(decisions.id, decisionParticipants.decisionId))
		.where(
			and(
				isNotNull(decisionParticipants.personId),
				openedWhere(),
				deciderScopeWhere(user, scope),
				opts.personId === undefined ? undefined : eq(decisionParticipants.personId, opts.personId)
			)
		)
		.groupBy(decisionParticipants.personId)
		.as('newest');
	return db
		.select({ id: newest.personId, name: decisionParticipants.name })
		.from(newest)
		.innerJoin(decisionParticipants, eq(decisionParticipants.id, newest.newestId))
		.where(opts.nameMatch === undefined ? undefined : foldsTo(decisionParticipants.name, opts.nameMatch))
		.orderBy(asc(decisionParticipants.name), asc(newest.personId))
		.limit(opts.limit)
		.all()
		.flatMap((row) => (row.id === null ? [] : [{ id: row.id, name: row.name }]));
}

/**
 * The participant rows `reachOf` still reaches through their account, as a
 * join on `people` (decision 3): the person there and active, the row's
 * account the person's account still, and the row's address the person's.
 * `reachedParticipantOf`'s account branch, held to it by case 19.
 */
const accountReachOn = (): SQL =>
	and(
		eq(people.id, decisionParticipants.personId),
		eq(people.status, 'active'),
		eq(people.userId, decisionParticipants.userId),
		eq(people.email, decisionParticipants.email)
	)!;

// ─── The register (decisions 2 to 7) ─────────────────────────────────────────

/** What a row of the register is read from. */
const rowColumns = {
	id: decisions.id,
	title: decisions.title,
	status: decisions.status,
	closesAt: decisions.closesAt,
	openedAt: decisions.openedAt,
	boardId: decisions.boardId,
	boardName: decisions.boardName,
	authorUserId: decisions.authorUserId,
	authorName: decisions.authorName,
	deciderUserId: decisions.deciderUserId,
	deciderName: decisions.deciderName,
	currentBoardName: boards.name
};

type ReadRow = {
	id: number;
	title: string;
	status: string;
	closesAt: Stamp | null;
	openedAt: Stamp | null;
	boardId: number | null;
	boardName: string;
	authorUserId: number | null;
	authorName: string;
	deciderUserId: number | null;
	deciderName: string | null;
	currentBoardName: string | null;
};

/** The board as a list names it (S1): current name and id where the caller can open it, else the name kept, with no id. */
function listedBoardOf(row: { boardId: number | null; boardName: string; currentBoardName: string | null }, scope: Scope): ListedBoard {
	if (row.boardId === null) return { id: null, name: row.boardName, gone: true };
	if (scope.admin || scope.accessible.has(row.boardId)) return { id: row.boardId, name: row.currentBoardName ?? row.boardName, gone: false };
	return { id: null, name: row.boardName, gone: false };
}

/** The filters every tab shares (decision 7): the board, the person and the title. */
function filtersWhere(user: SessionUser, scope: Scope, query: RegisterQuery): SQL | undefined {
	const parts: (SQL | undefined)[] = [];
	// D1: a board the caller cannot open matches nothing, as an id of no board does; dropping it would widen the list.
	if (query.board !== null) parts.push(scope.admin || scope.accessible.has(query.board) ? eq(decisions.boardId, query.board) : sql`false`);
	if (query.person !== null) parts.push(personScopeWhere(user, scope, query.person));
	// Card 2843: any case of any letter, both sides folded by `fold_case` (`lower()` folds A to Z alone).
	if (query.q !== null) parts.push(foldsTo(decisions.title, query.q));
	return and(...parts);
}

/** The decider's own decisions awaiting a ruling they may make now (decision 4): the board deleted, or one they can edit. */
function waitingRulingWhere(user: SessionUser, scope: Scope, now: Stamp): SQL {
	return and(deciderScopeWhere(user, scope), awaitingRulingSql(now))!;
}

/** Open, Ruled and All (decision 5): `status` narrows All alone. */
function tabWhere(tab: 'open' | 'ruled' | 'all', status: ShownStatus | null, now: Stamp): SQL | undefined {
	if (tab === 'open') return or(shownStatusSql('open', now), shownStatusSql('awaiting_ruling', now));
	if (tab === 'ruled') return inArray(decisions.status, ['ruled', 'superseded']);
	return status === null ? undefined : shownStatusSql(status, now);
}

/**
 * The decisions whose response the caller owes now, soonest closing first
 * (decision 3): their one live row consulted and reached through their
 * account, the decision shown open, and no counted response in the current
 * round. Rounds and responses are read set-based, never per row.
 */
function waitingResponseIds(user: SessionUser, now: Stamp, where: SQL | undefined): number[] {
	const candidates = db
		.select({ decisionId: decisions.id, participantId: decisionParticipants.id, closesAt: decisions.closesAt })
		.from(decisionParticipants)
		.innerJoin(decisions, eq(decisions.id, decisionParticipants.decisionId))
		.innerJoin(people, accountReachOn())
		.where(
			and(
				eq(decisionParticipants.userId, user.id),
				isNull(decisionParticipants.removedAt),
				eq(decisionParticipants.role, 'consulted'),
				shownStatusSql('open', now),
				oneLiveRowWhere(user.id),
				where
			)
		)
		.all();
	const rounds = roundsOf(candidates.map((row) => row.decisionId));
	const answered = countedInRound(candidates.map((row) => ({ participantId: row.participantId, round: rounds.get(row.decisionId) ?? 0 })));
	return candidates
		.filter((row) => !answered.has(row.participantId))
		.sort((a, b) => closingOrder(a.closesAt, b.closesAt) || a.decisionId - b.decisionId)
		.map((row) => row.decisionId);
}

/** Soonest closing first, with no closing time last. */
function closingOrder(a: Stamp | null, b: Stamp | null): number {
	if (a === b) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return a < b ? -1 : 1;
}

/** The rows of these ids, in their order. */
function rowsByIds(ids: readonly number[]): ReadRow[] {
	if (ids.length === 0) return [];
	const found = new Map<number, ReadRow>();
	for (let from = 0; from < ids.length; from += IDS_AT_ONCE) {
		const rows = db
			.select(rowColumns)
			.from(decisions)
			.leftJoin(boards, eq(boards.id, decisions.boardId))
			.where(inArray(decisions.id, ids.slice(from, from + IDS_AT_ONCE)))
			.all();
		for (const row of rows) found.set(row.id, row);
	}
	return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

/** The caller's own live participation on each decision, where they hold exactly one row. */
function ownRolesOf(user: SessionUser, decisionIds: readonly number[]): Map<number, 'consulted' | 'informed'> {
	const counts = new Map<number, number>();
	const roles = new Map<number, 'consulted' | 'informed'>();
	for (let from = 0; from < decisionIds.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ decisionId: decisionParticipants.decisionId, role: decisionParticipants.role })
			.from(decisionParticipants)
			.where(
				and(
					eq(decisionParticipants.userId, user.id),
					isNull(decisionParticipants.removedAt),
					inArray(decisionParticipants.decisionId, decisionIds.slice(from, from + IDS_AT_ONCE))
				)
			)
			.all();
		for (const row of rows) {
			counts.set(row.decisionId, (counts.get(row.decisionId) ?? 0) + 1);
			roles.set(row.decisionId, row.role === 'informed' ? 'informed' : 'consulted');
		}
	}
	for (const [decisionId, n] of counts) if (n !== 1) roles.delete(decisionId);
	return roles;
}

/**
 * One row as the register gives it (decision 2): `authorName` only where the
 * caller holds a role other than participant, `waiting` only where it holds.
 */
function registerRowOf(
	row: ReadRow,
	user: SessionUser,
	scope: Scope,
	ctx: { roles: Map<number, 'consulted' | 'informed'>; waiting: Map<number, 'response' | 'ruling'>; now: Stamp }
): RegisterRow {
	const listed = listedStatusOf(row, ctx.now);
	const otherRole =
		scope.admin ||
		row.authorUserId === user.id ||
		row.deciderUserId === user.id ||
		(row.boardId !== null && scope.accessible.has(row.boardId));
	const waiting = ctx.waiting.get(row.id);
	return {
		id: row.id,
		title: row.title,
		shownStatus: listed.shownStatus,
		board: listedBoardOf(row, scope),
		deciderName: row.deciderName,
		authorName: otherRole ? row.authorName : null,
		closesAt: listed.closesAt,
		openedAt: row.openedAt,
		role: ctx.roles.get(row.id) ?? null,
		...(waiting === undefined ? {} : { waiting })
	};
}

/**
 * The register (decisions 1 to 8): the rows of the tab, the waiting tabs'
 * counts, the board select and the person select, and the caller's own
 * person for "My record". The default tab is Waiting for my response where
 * its count is above 0, else Open. Writes nothing.
 *
 * `opts.source` decides the marking (card 2682, D16): through any source but
 * the page's, card 2682's v1 register among them, each row and the page carry
 * `untrusted: true`, as titles and names are people's and agents' words.
 */
export function readRegister(user: SessionUser, query: RegisterQuery, opts: { source: 'ui' | 'api' }): RegisterPage {
	const caller = requireUser(user);
	const now = stamp();
	const scope = scopeOf(caller);
	const where = and(visibleWhere(caller, scope), filtersWhere(caller, scope, query));

	const owed = waitingResponseIds(caller, now, where);
	const rulingWhere = and(waitingRulingWhere(caller, scope, now), where);
	const waitingRuling = db.select({ n: count() }).from(decisions).where(rulingWhere).get()?.n ?? 0;
	const tab: RegisterTab = query.tab ?? (owed.length > 0 ? 'waiting-response' : 'open');

	let read: ReadRow[];
	let next: number | null = null;
	let capped = false;
	if (tab === 'waiting-response') {
		capped = owed.length > REGISTER_WAITING_MAX;
		read = rowsByIds(owed.slice(0, REGISTER_WAITING_MAX));
	} else if (tab === 'waiting-ruling') {
		capped = waitingRuling > REGISTER_WAITING_MAX;
		read = db
			.select(rowColumns)
			.from(decisions)
			.leftJoin(boards, eq(boards.id, decisions.boardId))
			.where(rulingWhere)
			.orderBy(sql`${decisions.closesAt} IS NULL`, asc(decisions.closesAt), asc(decisions.id))
			.limit(REGISTER_WAITING_MAX)
			.all();
	} else {
		const rows = db
			.select(rowColumns)
			.from(decisions)
			.leftJoin(boards, eq(boards.id, decisions.boardId))
			.where(and(where, tabWhere(tab, query.status, now), query.before === null ? undefined : lt(decisions.id, query.before)))
			.orderBy(desc(decisions.id))
			.limit(REGISTER_PAGE_SIZE + 1)
			.all();
		read = rows.slice(0, REGISTER_PAGE_SIZE);
		next = rows.length > REGISTER_PAGE_SIZE ? read[read.length - 1].id : null;
	}

	const ids = read.map((row) => row.id);
	const waiting = new Map<number, 'response' | 'ruling'>();
	// D6: worked out for this page's rows alone, set-based, by the waiting tabs' own predicates.
	if (ids.length > 0) {
		for (const id of tab === 'waiting-response' ? ids : waitingResponseIds(caller, now, and(where, inArray(decisions.id, ids)))) waiting.set(id, 'response');
		const ruling = tab === 'waiting-ruling' ? ids : db.select({ id: decisions.id }).from(decisions).where(and(rulingWhere, inArray(decisions.id, ids))).all().map((row) => row.id);
		for (const id of ruling) waiting.set(id, 'ruling');
	}
	const roles = ownRolesOf(caller, ids);
	// Code review F1: the caller's own person, for the "My record" link; the person record lets them in as `self` for it.
	const own = personOfAccount(caller.id);

	const rows = read.map((row) => registerRowOf(row, caller, scope, { roles, waiting, now }));
	// Card 2682 (D10, D16): through any source but the page's, each row and the page are marked as data. Fail closed.
	const marked = opts.source !== 'ui';
	return {
		tab,
		query,
		rows: marked ? rows.map((row) => ({ ...row, untrusted: true as const })) : rows,
		next,
		counts: { waitingResponse: owed.length, waitingRuling },
		capped,
		boards: boardSelectOf(caller, scope),
		people: personSelectOf(caller, scope, query, own),
		myPersonId: own?.id ?? null,
		...(marked ? { untrusted: true as const } : {})
	};
}

/** The board select (decision 6, S1): accessible boards holding a decision the caller may view, by current name, at most 500. */
function boardSelectOf(user: SessionUser, scope: Scope): { id: number; name: string }[] {
	return db
		.selectDistinct({ id: boards.id, name: boards.name })
		.from(decisions)
		.innerJoin(boards, eq(boards.id, decisions.boardId))
		.where(and(visibleWhere(user, scope), scope.admin ? undefined : inArray(boards.id, [...scope.accessible])))
		.orderBy(asc(boards.name), asc(boards.id))
		.limit(REGISTER_BOARDS_MAX)
		.all();
}

/**
 * The person select (decision 6, D13): a search, never a silent cap. `who`
 * answers at most 25 people of the caller's scope by name; with no `who`, the
 * person already chosen, where they are in scope; nothing else.
 *
 * Code review S2: an administrator searches the directory and is given its
 * names. Anyone else is given, and searches, the name the newest
 * participation in their decider scope was given under (`deciderPeopleOf`),
 * so that a person renamed in the directory is not told to a decider by the
 * select; and their own person by the directory's name, which is theirs.
 */
function personSelectOf(user: SessionUser, scope: Scope, query: RegisterQuery, own: { id: number; fullName: string } | null): { id: number; name: string }[] {
	if (query.who === null && query.person === null) return [];
	// Card 2843: matched in any case of any letter, by `fold_case` in SQL and `toLowerCase` here, the same rule.
	const needle = query.who ?? undefined;
	if (scope.admin) {
		return db
			.select({ id: people.id, name: people.fullName })
			.from(people)
			.where(needle !== undefined ? foldsTo(people.fullName, needle) : eq(people.id, query.person!))
			.orderBy(asc(people.fullName), asc(people.id))
			.limit(PEOPLE_MATCHES_MAX)
			.all();
	}
	const ownRow = own !== null && (needle !== undefined ? own.fullName.toLowerCase().includes(needle.toLowerCase()) : own.id === query.person) ? [{ id: own.id, name: own.fullName }] : [];
	const decided = deciderPeopleOf(user, scope, {
		...(needle !== undefined ? { nameMatch: needle } : { personId: query.person! }),
		limit: PEOPLE_MATCHES_MAX + 1
	}).filter((person) => person.id !== own?.id);
	const found = [...ownRow, ...decided];
	return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id)).slice(0, PEOPLE_MATCHES_MAX);
}

// ─── The person record (decisions 9 to 15) ───────────────────────────────────

/**
 * The labels of each decision's options, by decision id and then option id,
 * in as few queries as `IDS_AT_ONCE` allows (code review F2): a label once
 * published is never issued again. A decision with no options has an empty
 * map.
 */
function labelsOfDecisions(decisionIds: readonly number[]): Map<number, Map<number, string>> {
	const unique = [...new Set(decisionIds)];
	const found = new Map<number, Map<number, string>>(unique.map((id) => [id, new Map()]));
	for (let from = 0; from < unique.length; from += IDS_AT_ONCE) {
		const rows = db
			.select({ decisionId: decisionOptions.decisionId, id: decisionOptions.id, label: decisionOptions.label })
			.from(decisionOptions)
			.where(inArray(decisionOptions.decisionId, unique.slice(from, from + IDS_AT_ONCE)))
			.all();
		for (const option of rows) found.get(option.decisionId)?.set(option.id, option.label);
	}
	return found;
}

/** The labels of one decision's options, by option id. */
const labelsOf = (decisionId: number): Map<number, string> => labelsOfDecisions([decisionId]).get(decisionId) ?? new Map();

/**
 * A response as a person record shows it: by option label, never by id; `via` where `withVia`. Card 2683: its
 * answers by prompt, as the version it was given under asked them (`asked`, read once for the page), in that
 * version's order (`recordAnswersOf`).
 */
function recordResponseOf(
	row: DecisionResponse,
	all: readonly DecisionResponse[],
	labels: ReadonlyMap<number, string>,
	withVia: boolean,
	asked: AskedSurveys
): RecordResponse {
	const own = ownResponseOf(row, asked);
	const byLabel = <T>(keyed: Record<string, T>): Record<string, T> =>
		Object.fromEntries(Object.entries(keyed).flatMap(([key, value]) => (labels.has(Number(key)) ? [[labels.get(Number(key))!, value] as const] : [])));
	return {
		versionNumber: own.versionNumber,
		round: own.round,
		kind: own.kind,
		option: own.optionId === null ? null : (labels.get(own.optionId) ?? null),
		scores: own.scores === null ? null : byLabel(own.scores),
		optionComments: byLabel(own.optionComments),
		comment: own.comment,
		answers: recordAnswersOf(row, own.answers, asked),
		...(withVia ? { via: row.via } : {}),
		createdAt: own.createdAt,
		current: !all.some((other) => other.replacesId === row.id)
	};
}

/**
 * A response's answers by prompt (card 2683, R17): each question the version it was given under asked, in that
 * version's order, that `answers` (already read by `answersOf`) answers: a choice by its words, a scale's number with
 * its top, a written answer's text.
 */
function recordAnswersOf(row: DecisionResponse, answers: Record<string, number | string>, asked: AskedSurveys): RecordAnswer[] {
	const questions = asked.get(row.decisionId)?.get(row.versionNumber);
	if (questions === undefined) return [];
	return [...questions.values()].flatMap((question): RecordAnswer[] => {
		const value = answers[`${question.questionId}`];
		if (value === undefined) return [];
		if (question.kind === 'choice' && typeof value === 'number') return [{ prompt: question.prompt, kind: 'choice', choice: question.choices[value] ?? '' }];
		if (question.kind === 'scale' && typeof value === 'number') return [{ prompt: question.prompt, kind: 'scale', value, max: question.scale?.max ?? value }];
		if (question.kind === 'text' && typeof value === 'string') return [{ prompt: question.prompt, kind: 'text', text: value }];
		return [];
	});
}

/** One of the person's own events (decision 13): its kind, moment and version, and `seen`'s stage. */
function ownEventOf(event: RecordEventRow): OwnRecordEvent {
	return {
		kind: event.kind,
		at: event.at,
		versionNumber: event.versionNumber,
		...(event.kind === 'seen' && typeof event.detail.stage === 'string' ? { stage: event.detail.stage } : {})
	};
}

/** The events a removed participation the person may no longer view shows: when they were included and removed (decision 14). */
const REMOVED_EVENTS: readonly EventKind[] = ['included', 're_included', 'removed'];

/**
 * One person's record, as the caller's audience is given it (decisions 9 to
 * 15): 25 participations a page, newest first, `before` the keyset. Only
 * participations of decisions that have been opened: a draft is in nobody's
 * record.
 *
 * Who is let in (decision 10, S5): a path that is not a whole number above 0
 * is 404 before anything is read. An administrator is given anyone's record,
 * and 404 for a person who is not there. Anyone else's scope is worked out
 * first: their own person, the person of their account, or a participation of
 * this person on a decision they decide with `record`, which is the list's
 * own predicate. The person row is read only on a hit. Anything else is the
 * same 404, with the same words.
 *
 * The page's alone (card 2682, D19, code review S3): `opts.source` is
 * required, so that the v1 read scan (`V1_READS`'s completeness rule) holds
 * any v1 import of it to a finding, and any source but `'ui'` is refused
 * before anything is read: an administrator is given the person's address
 * here, which no key is ever given (D9).
 *
 * Card 2684 (R11): each participation's objections and requests to talk,
 * read once over the page's ids through the tolerant reader, with the
 * replies: to the person as their own (`OwnFlag`), and of a participation
 * they may no longer view only the replies given up to their removal (or now,
 * for a live row), as their questions' answers (S-M2); to an administrator
 * and the decider of that decision also how each was raised and who replied,
 * by name. Since the decider's scope is the decisions they decide now, a
 * former decider is given none (S-M1).
 */
export function readPersonRecord(user: SessionUser, personId: number, query: { before: number | null }, opts: { source: 'ui' }): PersonRecord {
	if (opts.source !== 'ui') error(403, PERSON_RECORD_PAGE_ONLY);
	const caller = requireUser(user);
	if (!Number.isSafeInteger(personId) || personId < 1) error(404, PERSON_NOT_FOUND);
	const scope = scopeOf(caller);

	let audience: 'admin' | 'decider' | 'self';
	let rowsWhere: SQL;
	if (scope.admin) {
		audience = 'admin';
		rowsWhere = eq(decisionParticipants.personId, personId);
	} else if (personOfAccount(caller.id)?.id === personId) {
		// S6: rows of their person and of their account alike, so that one given by personal link is not theirs here.
		audience = 'self';
		rowsWhere = and(eq(decisionParticipants.personId, personId), eq(decisionParticipants.userId, caller.id))!;
	} else {
		audience = 'decider';
		rowsWhere = and(eq(decisionParticipants.personId, personId), deciderScopeWhere(caller, scope))!;
		const hit = db
			.select({ id: decisionParticipants.id })
			.from(decisionParticipants)
			.innerJoin(decisions, eq(decisions.id, decisionParticipants.decisionId))
			.where(and(rowsWhere, openedWhere()))
			.limit(1)
			.get();
		if (hit === undefined) error(404, PERSON_NOT_FOUND);
	}
	const person = db.select().from(people).where(eq(people.id, personId)).get();
	if (person === undefined) error(404, PERSON_NOT_FOUND);

	const listed = (extra?: SQL) =>
		db
			.select({ participant: decisionParticipants, decision: decisions, currentBoardName: boards.name })
			.from(decisionParticipants)
			.innerJoin(decisions, eq(decisions.id, decisionParticipants.decisionId))
			.leftJoin(boards, eq(boards.id, decisions.boardId))
			.where(and(rowsWhere, openedWhere(), extra))
			.orderBy(desc(decisionParticipants.id));
	const rows = listed(query.before === null ? undefined : lt(decisionParticipants.id, query.before))
		.limit(PERSON_PAGE_SIZE + 1)
		.all();
	const page = rows.slice(0, PERSON_PAGE_SIZE);
	const next = rows.length > PERSON_PAGE_SIZE ? page[page.length - 1].participant.id : null;
	const now = stamp();

	const participationDecisionOf = (decision: Decision, currentBoardName: string | null): ParticipationDecision => {
		const status = listedStatusOf(decision, now);
		return {
			id: decision.id,
			title: decision.title,
			shownStatus: status.shownStatus,
			board: listedBoardOf({ boardId: decision.boardId, boardName: decision.boardName, currentBoardName }, scope),
			closesAt: status.closesAt
		};
	};
	// Code review F2: the page's labels, responses and concerns, each read once over the page's ids, never per row.
	const participantIds = page.map((row) => row.participant.id);
	const labelsByDecision = labelsOfDecisions(page.map((row) => row.decision.id));
	const responsesBy = responsesOfParticipants(participantIds);
	// Card 2683 (R22): the survey questions each version of the page's decisions asked, read once, as the answers are read against them.
	const asked = surveysAskedIn(page.map((row) => row.decision.id));
	const concernsBy = concernsOfParticipants(participantIds);
	const concernsFor = (participantId: number) =>
		(concernsBy.get(participantId) ?? []).map((row) => ({ comment: row.comment ?? '', createdAt: row.createdAt }));
	// Card 2684 (R11): the page's flags, read once over its ids, never per row.
	const flagsBy = flagsOfParticipants(participantIds);
	/** One flag as its raiser is given it; with `upTo`, its reply only where given at or before that moment (S-M2). */
	const ownFlagOf = (flag: DecisionFlag, upTo?: Stamp): OwnFlag => {
		const inTime = upTo === undefined || (flag.repliedAt !== null && flag.repliedAt <= upTo);
		return {
			kind: flag.kind === 'talk' ? 'talk' : 'objection',
			reason: flag.reason,
			raisedAt: flag.raisedAt,
			versionNumber: flag.versionNumber,
			reply: inTime ? flag.reply : null,
			repliedAt: inTime ? flag.repliedAt : null
		};
	};
	const ownFlagsFor = (participantId: number, upTo?: Stamp): OwnFlag[] => (flagsBy.get(participantId) ?? []).map((flag) => ownFlagOf(flag, upTo));
	const privilegedFlagsFor = (participantId: number): RecordFlag[] =>
		(flagsBy.get(participantId) ?? []).map((flag) => ({ ...ownFlagOf(flag), via: flag.via, repliedByName: flag.reply === null ? null : flag.repliedByName }));
	const groupsOf = (participant: DecisionParticipant): string[] => {
		try {
			const read = JSON.parse(participant.groups) as unknown;
			return Array.isArray(read) ? read.filter((name): name is string => typeof name === 'string') : [];
		} catch {
			return [];
		}
	};

	if (audience === 'self') {
		const events = eventsOfParticipants(participantIds, { kinds: OWN_RECORD_EVENTS, perParticipant: EVENTS_PER_PARTICIPATION });
		// F2: whether each decision may be viewed now, by `visibleWhere` in one read, never `decisionAccess` per row.
		const viewable = visibleDecisionIdsOf(
			caller,
			page.map((row) => row.decision.id)
		);
		// S2: a decision the person may no longer view shows nothing of itself, and answers only up to the removal (or now).
		const questions = questionsOfParticipations(
			page.map(({ participant, decision }) => ({
				decision,
				participantId: participant.id,
				...(viewable.has(decision.id) ? {} : { upTo: participant.removedAt ?? now })
			})),
			'own',
			opts.source
		);
		const participations = page.map(({ participant, decision, currentBoardName }): Participation<OwnRecordEvent> | RemovedParticipation => {
			const labels = labelsByDecision.get(decision.id) ?? new Map<number, string>();
			const all = responsesBy.get(participant.id) ?? [];
			const responses = all.map((row) => recordResponseOf(row, all, labels, false, asked));
			const own = events.get(participant.id) ?? [];
			if (!viewable.has(decision.id)) {
				// S2: nothing of the decision as it is now; their own words, and answers given up to their removal. F4: a live
				// row they may not view has this shape too, with `removedAt` null, and the page does not call it removed.
				return {
					kind: 'removed',
					includedAt: participant.includedAt,
					removedAt: participant.removedAt,
					responses,
					questions: questions.get(participant.id) ?? [],
					concerns: concernsFor(participant.id),
					// Card 2684 (S-M2): replies given up to the removal (or now), as the questions' answers.
					flags: ownFlagsFor(participant.id, participant.removedAt ?? now),
					events: own.filter((event) => (REMOVED_EVENTS as readonly string[]).includes(event.kind)).map(ownEventOf)
				};
			}
			return {
				kind: 'full',
				decision: participationDecisionOf(decision, currentBoardName),
				role: participant.role === 'informed' ? 'informed' : 'consulted',
				includedAt: participant.includedAt,
				removedAt: participant.removedAt,
				name: participant.name,
				jobTitle: participant.jobTitle,
				groups: groupsOf(participant),
				responses,
				questions: questions.get(participant.id) ?? [],
				concerns: concernsFor(participant.id),
				// Card 2684 (R11): a removed participant's replies up to the removal, though they may still view the decision.
				flags: ownFlagsFor(participant.id, participant.removedAt ?? undefined),
				events: own.map(ownEventOf),
				moreEvents: false
			};
		});
		return { audience, person: { name: person.fullName, jobTitle: person.jobTitle }, participations, next };
	}

	// One more event than is shown, to know that the record holds more (decision 15), bounded in SQL (F2).
	const events = eventsOfParticipants(participantIds, { perParticipant: EVENTS_PER_PARTICIPATION + 1 });
	const questions = questionsOfParticipations(
		page.map(({ participant, decision }) => ({ decision, participantId: participant.id })),
		'privileged',
		opts.source
	);
	const participations = page.map(({ participant, decision, currentBoardName }): Participation<RecordEntry> => {
		const labels = labelsByDecision.get(decision.id) ?? new Map<number, string>();
		const all = responsesBy.get(participant.id) ?? [];
		const named = events.get(participant.id) ?? [];
		const ctx = { user: caller, labels, participants: new Map([[participant.id, participant.name]]), source: 'ui' as const };
		return {
			kind: 'full',
			id: participant.id,
			decision: participationDecisionOf(decision, currentBoardName),
			role: participant.role === 'informed' ? 'informed' : 'consulted',
			includedAt: participant.includedAt,
			removedAt: participant.removedAt,
			name: participant.name,
			jobTitle: participant.jobTitle,
			groups: groupsOf(participant),
			responses: all.map((row) => recordResponseOf(row, all, labels, true, asked)),
			questions: questions.get(participant.id) ?? [],
			concerns: concernsFor(participant.id),
			flags: privilegedFlagsFor(participant.id),
			events: named.slice(0, EVENTS_PER_PARTICIPATION).map((event) => recordEntryOf(event, ctx)),
			moreEvents: named.length > EVENTS_PER_PARTICIPATION
		};
	});

	let header: PersonHeader;
	if (audience === 'admin') {
		const groups = db
			.select({ name: peopleGroups.name })
			.from(peopleGroupMembers)
			.innerJoin(peopleGroups, eq(peopleGroups.id, peopleGroupMembers.groupId))
			.where(eq(peopleGroupMembers.personId, person.id))
			.orderBy(asc(peopleGroups.name))
			.all()
			.map((group) => group.name);
		header = { name: person.fullName, jobTitle: person.jobTitle, groups, email: person.email, status: person.status === 'left' ? 'left' : 'active' };
	} else {
		// The decider is told the person as their own decisions recorded them: the newest participation in scope.
		const newest = listed().limit(1).get();
		header = {
			name: newest?.participant.name ?? person.fullName,
			jobTitle: newest?.participant.jobTitle ?? '',
			status: person.status === 'left' ? 'left' : 'active'
		};
	}
	return { audience, person: header, participations, next };
}

// ─── The record view (decision 16) ───────────────────────────────────────────

/**
 * What `recordEntryOf` projects an event for: who the reader is (for
 * `namedFor`, and whether they are an administrator, which `recordEntryOf`
 * works out from the account itself so that no caller can hand it a wrong
 * flag: code review S5), the decision's option labels by id, and its
 * participants' snapshot names by participant id. `source` is the tree the
 * read came through (card 2682, D9, D31): administrator-only detail is
 * shown on the page alone, and an API key is given the question events with
 * no asker.
 *
 * Card 2688 (R3.11, S-M2): `adminDetail: false` takes the administrator-only
 * detail away for an administrator too, for the full record's PDF, which can
 * be forwarded anywhere. It can only take detail away: left out, the account
 * decides, as before.
 */
export type RecordContext = {
	user: SessionUser;
	labels: ReadonlyMap<number, string>;
	participants: ReadonlyMap<number, string>;
	source: 'ui' | 'api';
	adminDetail?: false;
};

/** A key that names an id, which is never shown, at any depth (S3). */
const NAMES_AN_ID = /Id$/;

const isPrimitive = (value: unknown): value is string | number | boolean | null =>
	value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the named primitive fields of an object, as a new object; undefined for anything that is no object. */
function fieldsOf(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) return undefined;
	const picked: Record<string, unknown> = {};
	for (const field of fields) {
		if (NAMES_AN_ID.test(field) || !Object.hasOwn(value, field)) continue;
		const shown = value[field];
		if (isPrimitive(shown)) picked[field] = shown;
	}
	return picked;
}

/**
 * An event's detail as `RECORD_DETAIL` shows it (decision 16, S3): a new
 * object, each key named by the kind's spec built by its rule, and nothing
 * of the stored detail copied whole. A kind with no spec shows nothing.
 */
function detailOf(kind: string, stored: Record<string, unknown>, ctx: RecordContext, admin: boolean): Record<string, unknown> {
	const spec: DetailSpec | undefined = Object.hasOwn(RECORD_DETAIL, kind) ? RECORD_DETAIL[kind as EventKind] : undefined;
	const shown: Record<string, unknown> = {};
	if (spec === undefined) return shown;
	for (const [key, rule] of Object.entries(spec)) {
		if (NAMES_AN_ID.test(key)) continue;
		if (rule === 'value' || rule === 'admin') {
			if (rule === 'admin' && !admin) continue;
			if (Object.hasOwn(stored, key) && isPrimitive(stored[key])) shown[key] = stored[key];
		} else if (rule === 'option') {
			if (!Object.hasOwn(stored, 'optionId')) continue;
			const optionId = stored.optionId;
			shown[key] = typeof optionId === 'number' ? (ctx.labels.get(optionId) ?? null) : null;
		} else if ('decision' in rule) {
			const otherId = stored[rule.decision];
			if (typeof otherId !== 'number' || !Number.isSafeInteger(otherId)) continue;
			const other = db.select().from(decisions).where(eq(decisions.id, otherId)).get();
			shown[key] = other === undefined ? {} : namedFor(ctx.user, other);
		} else if ('fields' in rule) {
			if (rule.admin === true && !admin) continue;
			const picked = fieldsOf(stored[key], rule.fields);
			if (picked !== undefined) shown[key] = picked;
		} else {
			const list = stored[key];
			if (!Array.isArray(list)) continue;
			shown[key] = list.flatMap((item) => {
				const picked = fieldsOf(item, rule.each);
				return picked === undefined ? [] : [picked];
			});
		}
	}
	return shown;
}

/**
 * One event as the record view shows it (decision 16): its kind, moment and
 * version, the participant it names by their snapshot name, who did it by
 * name and tree, and its detail through `RECORD_DETAIL` alone. Exported for
 * card 2688's PDF. Whether the reader is an administrator is asked of their
 * account here, `isAdmin(ctx.user)`, never taken from the caller (S5).
 *
 * Card 2682: through any source but the page's (D9, D31; fail closed), no
 * administrator-only detail is shown, an administrator's key included, and
 * each entry is marked `untrusted` (D10). Card 2678's four question events
 * and card 2684's four flag events (`KEY_HIDDEN_EVENTS`, R13) are never given
 * to a key: `readRecord` leaves them out in the query (code review S1), and
 * one handed here under any source but the page's is a caller's fault,
 * thrown, never shown. `GET …/questions` is the asker-free way a key reads
 * questions; no key reads a flag. The page's callers are typed as before.
 */
export function recordEntryOf(event: RecordEventRow, ctx: RecordContext & { source: 'ui' }): RecordEntry;
export function recordEntryOf(event: RecordEventRow, ctx: RecordContext & { source: 'api' }): KeyRecordEntry;
export function recordEntryOf(event: RecordEventRow, ctx: RecordContext): RecordEntry | KeyRecordEntry {
	const page = ctx.source === 'ui';
	if (!page && (KEY_HIDDEN_EVENTS as readonly string[]).includes(event.kind)) {
		throw new Error(`recordEntryOf: ${event.kind} could name who asked, objected or asked to talk, and is never given to an API key`);
	}
	// Card 2688 (S-M2): `adminDetail: false` only takes the administrator's detail away.
	const detail = detailOf(event.kind, event.detail, ctx, page && ctx.adminDetail !== false && isAdmin(ctx.user));
	const participant = event.participantId === null ? null : (ctx.participants.get(event.participantId) ?? null);
	const entry = { kind: event.kind, at: event.at, versionNumber: event.versionNumber, participant, actor: { name: event.actorName, source: event.source }, detail };
	return page ? entry : { ...entry, untrusted: true };
}

/**
 * A decision's record view (decision 16): every event, oldest first, at most
 * `opts.limit` (a whole number from 1 to `RECORD_READ_MAX`, else a plain
 * `Error`: a caller's fault), after `query.after`, naming `query.participant`
 * alone where it is given, which must be one of this decision's participant
 * rows (else 404). `requireDecision(…, 'record')`: administrators and the
 * decider, with board edit while the board exists; 403 for anyone else who
 * may view it, 404 for anyone else.
 *
 * `opts.source` decides what is shown (card 2682, D9, D15, D31): through any
 * source but the page's, card 2682's v1 record among them, each entry is
 * `recordEntryOf`'s key shape and the page is marked `untrusted`; and the
 * four question events and card 2684's four flag events
 * (`KEY_HIDDEN_EVENTS`) are left out, in the query, filtered or not (code
 * review S1), as each could name who asked, objected or asked to talk.
 *
 * Card 2688 (R3.11, S-M2): `opts.adminDetail: false`, on the page's source,
 * gives no administrator-only detail to an administrator either, for the full
 * record's PDF (`recordEntryOf`). Left out, the account decides, as before.
 */
export function readRecord(
	user: SessionUser,
	decisionId: number,
	query: { participant: number | null; after: number | null },
	opts: { source: 'ui'; limit: number; adminDetail?: false }
): RecordPage;
export function readRecord(
	user: SessionUser,
	decisionId: number,
	query: { participant: number | null; after: number | null },
	opts: { source: 'api'; limit: number }
): KeyRecordPage;
export function readRecord(
	user: SessionUser,
	decisionId: number,
	query: { participant: number | null; after: number | null },
	opts: { source: 'ui' | 'api'; limit: number; adminDetail?: false }
): RecordPage | KeyRecordPage {
	if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > RECORD_READ_MAX) {
		throw new Error(`readRecord: limit must be a whole number from 1 to ${RECORD_READ_MAX}, and it is ${opts.limit}`);
	}
	const caller = requireUser(user);
	const { decision } = requireDecision(caller, decisionId, 'record');

	const rowsOfParticipants = db
		.select({ id: decisionParticipants.id, name: decisionParticipants.name, personId: decisionParticipants.personId })
		.from(decisionParticipants)
		.where(eq(decisionParticipants.decisionId, decision.id))
		.orderBy(asc(decisionParticipants.name), asc(decisionParticipants.id))
		.all();
	if (query.participant !== null && !rowsOfParticipants.some((row) => row.id === query.participant)) error(404, 'Participant not found');
	// Code review F1: each participant's person, for a link to their person record, which this reader (the decider with
	// `record`, or an administrator) is let into exactly where the decision has been opened: never a draft's, and never one
	// by address alone, whose person is not there.
	const opened = decision.status !== 'draft' && decision.openedAt !== null;
	const participants = rowsOfParticipants.map((row) => ({
		id: row.id,
		name: row.name,
		...(opened && row.personId !== null ? { personId: row.personId } : {})
	}));

	// Card 2682 (D31): fail closed, any source but the page's.
	const page = opts.source === 'ui';
	const rows = recordEventsOf(decision.id, {
		...(query.participant === null ? {} : { participantId: query.participant }),
		...(query.after === null ? {} : { afterId: query.after }),
		...(page ? {} : { withoutKinds: KEY_HIDDEN_EVENTS }),
		limit: opts.limit + 1
	});
	const shown = rows.slice(0, opts.limit);
	const ctx = {
		user: caller,
		labels: labelsOf(decision.id),
		participants: new Map(participants.map((row) => [row.id, row.name])),
		...(opts.adminDetail === false ? { adminDetail: false as const } : {})
	};
	const heading = { id: decision.id, title: decision.title, shownStatus: decisionStatus(decision) };
	const next = rows.length > opts.limit ? shown[shown.length - 1].id : null;
	if (page) {
		return { decision: heading, entries: shown.map((event) => recordEntryOf(event, { ...ctx, source: 'ui' })), participants, participant: query.participant, next };
	}
	return {
		decision: heading,
		entries: shown.map((event) => recordEntryOf(event, { ...ctx, source: 'api' })),
		participants,
		participant: query.participant,
		next,
		untrusted: true
	};
}
