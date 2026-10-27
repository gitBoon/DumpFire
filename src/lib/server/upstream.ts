/**
 * upstream.ts — which cards are upstream of the commitment point, asked on the
 * server (milestone 22).
 *
 * A card is upstream, an option rather than committed work, when its column is
 * the board's Options column (`columns.role = 'options'`) or its board is an
 * ideas board (`boards.kind = 'ideas'`). The rule itself is
 * `isUpstreamColumn` in `$lib/column-role`, shared with the browser; this
 * module reads what that rule needs from the database: the kinds of boards,
 * for code that already holds column rows, and one column's verdict, for a
 * write on one card. `UPSTREAM` is the same rule as SQL, for the readers that
 * write their own. `upstreamFigures` counts what happened upstream over a
 * window, commitments, returns, discards, sends and abandoned work, and the
 * options held now and how long they have waited.
 *
 * Nothing here takes a NULL `committed_at` to mean upstream. The column and
 * the board decide it, and `committed_at` records what they decided.
 */
import { db, sqlite } from '$lib/server/db';
import { activityLog, boards, columns } from '$lib/server/db/schema';
import { and, eq, inArray, like, max, or, sql, type SQL } from 'drizzle-orm';
import { isOptionsColumn, isQueueColumn, isUpstreamColumn } from '$lib/column-role';
import { ACTIONS, storedActions } from '$lib/server/logActivity';
import { optionsAging } from '$lib/board/board-view';
import { parseStamp, toStamp } from '$lib/timestamps';

/**
 * How a `column_converted_to_options` entry's detail ended: ` (column <id>)`.
 * The activity log has no column of its own for a column, so the conversion
 * named it here, at the end of the detail, after the quoted title, where no
 * title can put it; `optionsSince` looks for it there (milestone 22, the S1b
 * review's B2). Nothing writes a column conversion now: it went before
 * release, when every delivery board was given its Options column (card
 * 2527), but the entries a milestone 22 build wrote are still read. A
 * `card_committed` entry ends with `commitmentSuffix` instead, which names
 * two columns.
 */
export function conversionSuffix(columnId: number): string {
	return ` (column ${columnId})`;
}

/**
 * How a `board_converted_to_ideas` entry's detail ends: ` (board <id>)`, the
 * board made an ideas board (milestone 22, card 2463), after the quoted name,
 * where no name can put it, as `conversionSuffix` names a column. Its cards
 * are options from then, and the aging reads it back (`optionsSince`,
 * `upstreamFigures`, `timeInOptions`).
 */
export function boardConversionSuffix(boardId: number): string {
	return ` (board ${boardId})`;
}

/** The end of a board conversion's detail, ` (board <id>)` (`boardConversionSuffix`), read back. */
const CONVERTED_BOARD = / \(board (\d+)\)$/;

/**
 * How a `card_committed` entry's detail ends: ` (column <to>, from column
 * <from>)`, the column the card was committed into, for the cycle time (the
 * S2 review's C3), and the column it left, for its time in options (the S4a
 * review's H3). Read back by `commitmentColumns`.
 */
export function commitmentSuffix(toColumnId: number, fromColumnId: number): string {
	return ` (column ${toColumnId}, from column ${fromColumnId})`;
}

/** The end of a `card_committed` entry's detail, read back: the column it went into and the one it left; null where it does not say. */
const COMMITMENT_COLUMNS = / \(column (\d+)(?:, from column (\d+))?\)$/;

/**
 * The two columns a `card_committed` entry's detail names (`commitmentSuffix`):
 * `to`, the column the card was committed into, and `from`, the column it
 * left, each null where the detail does not say. An entry written before the
 * S4a review names only `to`, as ` (column <to>)`.
 */
export function commitmentColumns(detail: string | null): { to: number | null; from: number | null } {
	const found = COMMITMENT_COLUMNS.exec(detail ?? '');
	return { to: found ? Number(found[1]) : null, from: found?.[2] ? Number(found[2]) : null };
}

/** The later of two stored moments, either of which may be missing. Stored moments share one form, so the later is the greater text. */
const later = (a: string | null | undefined, b: string | null | undefined): string | undefined => (a && b ? (a > b ? a : b) : (a ?? b ?? undefined));

/**
 * When each of these cards, all upstream on board `scope.boardId`, became an
 * option, for the aging (milestone 22, ruling g, amended by the S1b review's
 * B2): the latest of its creation, its latest `card_returned_to_options`
 * entry, and the latest conversion that made it one, each in either
 * spelling. The conversions are the column's, `scope.columnId`, made the
 * Options column, which only a milestone 22 build recorded (nothing has
 * since card 2527), and the board's made an ideas board (card 2463). A card
 * converted where it stood is an option from the conversion, not from its
 * creation.
 *
 * A Send keeps the age (decision M22-20), and so does any move from another
 * board's upstream: a conversion counts only if the card was on the board
 * when it happened, that is with no `card_moved_in` to this board after it,
 * as `timeInOptions` reads it (the S4a review's H3). Without that, a card
 * sent into a column converted earlier would have looked as young as the
 * conversion. Two reads, and none for no cards.
 */
export function optionsSince(scope: { boardId: number; columnId?: number }, cards: readonly { id: number; createdAt: string }[]): Map<number, string> {
	const since = new Map<number, string>();
	if (cards.length === 0) return since;
	const returnedActions = storedActions(ACTIONS.cardReturnedToOptions);
	const returned = new Map<number, string>();
	const arrived = new Map<number, string>();
	const acts = db
		.select({ cardId: activityLog.cardId, action: activityLog.action, at: max(activityLog.createdAt) })
		.from(activityLog)
		.where(
			and(
				inArray(activityLog.cardId, cards.map((c) => c.id)),
				or(
					inArray(activityLog.action, returnedActions),
					and(inArray(activityLog.action, storedActions(ACTIONS.cardMovedIn)), eq(activityLog.boardId, scope.boardId))
				)
			)
		)
		.groupBy(activityLog.cardId, activityLog.action)
		.all();
	for (const { cardId, action, at } of acts) {
		if (cardId === null) continue;
		const into = returnedActions.includes(action) ? returned : arrived;
		const latest = later(into.get(cardId), at);
		if (latest) into.set(cardId, latest);
	}
	const conversions = [inArray(activityLog.action, storedActions(ACTIONS.boardConvertedToIdeas))];
	if (scope.columnId !== undefined) {
		conversions.push(
			and(inArray(activityLog.action, storedActions(ACTIONS.columnConvertedToOptions)), like(activityLog.detail, `%${conversionSuffix(scope.columnId)}`))!
		);
	}
	const converted =
		db
			.select({ at: max(activityLog.createdAt) })
			.from(activityLog)
			.where(and(eq(activityLog.boardId, scope.boardId), or(...conversions)))
			.get()?.at ?? null;
	for (const card of cards) {
		const arrivedSince = converted !== null && (arrived.get(card.id) ?? '') > converted;
		since.set(card.id, later(later(card.createdAt, returned.get(card.id)), arrivedSince ? null : converted)!);
	}
	return since;
}

/**
 * The rule as an SQL condition, over a column and its board under the aliases
 * given: true for a card in the Options column or on an ideas board, and false,
 * never NULL, for every other card. `IS` and not `=`: an ordinary column's role
 * is NULL, and `NULL = 'options'` is NULL, so `NOT` the condition would drop
 * every committed card too (the S1a review's R1). A card with no column or no
 * board, under a LEFT JOIN, is not upstream either.
 */
export function upstreamCondition(columnAlias = 'col', boardAlias = 'b'): string {
	return `(${columnAlias}.role IS 'options' OR ${boardAlias}.kind IS 'ideas')`;
}

/** The rule over `columns` as `col` joined to `boards` as `b`: `(col.role IS 'options' OR b.kind IS 'ideas')`. */
export const UPSTREAM = upstreamCondition();

/**
 * The rule's complement for Drizzle, over the `columns` and `boards` tables
 * joined under their own names: true for a card in a committed column of a
 * delivery board, which is what every delivery measure counts (card 2462).
 * `IS`, as above, so that an ordinary column's NULL role is not upstream.
 */
export function notUpstream(): SQL {
	return sql`NOT (${columns.role} IS 'options' OR ${boards.kind} IS 'ideas')`;
}

/** The kind of each board in `boardIds` that exists, by id, in one query. */
export function boardKinds(boardIds: readonly number[]): Map<number, string> {
	const kinds = new Map<number, string>();
	const ids = [...new Set(boardIds)];
	if (ids.length === 0) return kinds;
	const rows = db.select({ id: boards.id, kind: boards.kind }).from(boards).where(inArray(boards.id, ids)).all();
	for (const row of rows) kinds.set(row.id, row.kind);
	return kinds;
}

/**
 * The ids of the columns, among these rows, that are upstream: the Options
 * column, and every column of an ideas board. The boards' kinds are read in
 * one query.
 */
export function upstreamColumnIds(rows: readonly { id: number; boardId: number; role: string | null }[]): Set<number> {
	const kinds = boardKinds(rows.map((c) => c.boardId));
	return new Set(rows.filter((c) => isUpstreamColumn(c, kinds.get(c.boardId) ?? null)).map((c) => c.id));
}

/**
 * What a card just created in `column` by user `actorId` records of its
 * commitment (the S1a review's R2): created outside an upstream column, it is
 * committed as it is created, at its `createdAt` and by its creator, so the
 * start-up backfill finds nothing to fill; created in an Options column or on
 * an ideas board, it is an option and records nothing. One read, of the
 * board's kind. Every creation path asks this, through `recordCardCreated`.
 */
export function commitmentOnCreation(
	column: { id: number; boardId: number; role: string | null },
	card: { createdAt: string },
	actorId: number
): { committedAt: string; committedBy: number } | null {
	return upstreamColumnIds([column]).has(column.id) ? null : { committedAt: card.createdAt, committedBy: actorId };
}

/**
 * What happened upstream on some boards over a window, and the options they
 * hold now (milestone 22, card 2461; read by the measures, reports and API
 * of cards 2462 and 2464).
 */
export type UpstreamFigures = {
	/** "Options now": live (not archived) cards in an upstream column of these boards. */
	options: number;
	/** Distinct cards whose last upstream act in the window was a commitment out of upstream (`card_committed`). */
	committedFromOptions: number;
	/** … a return into upstream (`card_returned_to_options`), a figure of its own, not taken off the commitments. */
	returnedToOptions: number;
	/** … a discard, archived or deleted from upstream (`card_discarded`). */
	discarded: number;
	/** … a Send to another board (`card_sent`), not counted when the board it went to is among these boards. */
	sentOn: number;
	/**
	 * Distinct cards of committed work archived unfinished in the window
	 * (`card_abandoned`), counted on their own: abandonment is downstream, so a
	 * card committed and then abandoned counts here and as committed (the S3
	 * review's E1). Not in the discard rate.
	 */
	abandoned: number;
	/** discarded / (discarded + committed from options + sent on); null when all three are 0. */
	discardRate: number | null;
	/** Whole days the oldest option now has waited, from when it became an option; null with no options. */
	oldestOptionDays: number | null;
	/** How many options now have waited more than `OPTION_AGING_DAYS` (30). */
	agingOptions: number;
};

/**
 * `card_sent`, written on the board a card is sent from, in place of
 * `card_moved_away` (ruling b), at the same moment as the `card_moved_in` on
 * the board it went to (card 2463), so that the two pair by their time.
 */
const CARD_SENT = ACTIONS.cardSent;

/**
 * The upstream acts, each a figure, by canonical action (ruling c): of these a
 * card counts under its last in the window. Abandonment is not among them: it
 * is downstream, and counted on its own (the S3 review's E1).
 */
const ACTS: Record<string, keyof Pick<UpstreamFigures, 'committedFromOptions' | 'returnedToOptions' | 'discarded' | 'sentOn'>> = {
	[ACTIONS.cardCommitted]: 'committedFromOptions',
	[ACTIONS.cardReturnedToOptions]: 'returnedToOptions',
	[ACTIONS.cardDiscarded]: 'discarded',
	[CARD_SENT]: 'sentOn'
};

/** The end of a column conversion entry's detail, ` (column <id>)` (`conversionSuffix`), read back from the entries written before card 2527. */
const CONVERTED_COLUMN = / \(column (\d+)\)$/;

/**
 * The upstream figures of `boardIds` for the window `from` to `to`, each a
 * date or a moment. **Both ends are included**, as in `reports.ts`: a bare
 * date as `to` is the whole of that day (`toStamp`'s rule), and a caller that
 * passes a moment as the end passes the end of the day it means, never the
 * next midnight (the S3 review's E4). A bound that cannot be read is a fault
 * in the caller and is thrown. Access is the caller's: every board named is
 * read.
 *
 * Acts are counted when they happened, from the activity log, which is never
 * pruned. Each card counts once, under its **last** upstream act in the
 * window, among commitment, return, discard and Send (ruling c, which
 * replaces decision M22-10's "count every act"): a card committed, returned
 * and committed again in one window is one commitment. A discard later
 * restored still happened. Abandoned work is counted apart, each card with a
 * `card_abandoned` in the window once, whatever else it did (the S3 review's
 * E1), and is not in the discard rate. Entries stored with no card id, a
 * deleted card's, cannot be told apart, and each counts once. A Send whose
 * target board is also in scope is dropped (ruling b): the card stayed in
 * scope. Its target is the `card_moved_in` of the same card at the same
 * moment; a deleted card's Send cannot be paired and is counted.
 *
 * Options now and their aging are read as they stand, whatever the window:
 * an option's age runs from the latest of its creation, its latest return to
 * options and the latest conversion of its column (recorded only before card
 * 2527) or of its board to an ideas board, a conversion counting only if the card has not arrived from another
 * board since (the rule of `optionsSince`, the S1b review's B2 and decision
 * M22-20), in whole days, as the Options strip shows it. Four reads in all,
 * however many boards and columns (the S3 review's E3). `now` is for tests.
 *
 * `boardIds` null is every board (the S4a review's H9): no list of every
 * board's id is bound, which past SQLite's limit on bound values would fail,
 * and no read of the boards is made for one. The conversions are read only on
 * the boards that hold options now, by the index that leads on the board, so
 * that the read never scans the whole log.
 */
export function upstreamFigures(boardIds: readonly number[] | null, from: string, to: string, now: number = Date.now()): UpstreamFigures {
	const lower = toStamp(from, 'lower');
	const upper = toStamp(to, 'upper');
	if (lower === null || upper === null) throw new Error(`Not a window: ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
	const figures: UpstreamFigures = {
		options: 0,
		committedFromOptions: 0,
		returnedToOptions: 0,
		discarded: 0,
		sentOn: 0,
		abandoned: 0,
		discardRate: null,
		oldestOptionDays: null,
		agingOptions: 0
	};
	const ids = boardIds === null ? null : [...new Set(boardIds)];
	if (ids !== null && ids.length === 0) return figures;
	// `<column> IN (?, …)` for the boards, or true for every board, and its values.
	const onBoards = (column: string) => (ids === null ? '1' : `${column} IN (${ids.map(() => '?').join(', ')})`);
	const boardValues = ids ?? [];

	// The acts in the window, oldest first, but a Send into a board in scope.
	const acts = storedActions(...Object.keys(ACTS), ACTIONS.cardAbandoned);
	const sent = storedActions(CARD_SENT);
	const movedIn = storedActions(ACTIONS.cardMovedIn);
	const rows = sqlite
		.prepare(
			`SELECT a.id AS id, a.card_id AS cardId, a.action AS action FROM activity_log a
			WHERE ${onBoards('a.board_id')} AND a.created_at BETWEEN ? AND ?
				AND a.action IN (${acts.map(() => '?').join(', ')})
				AND NOT (a.action IN (?, ?) AND a.card_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM activity_log m WHERE m.card_id = a.card_id AND m.created_at = a.created_at
						AND m.action IN (?, ?) AND ${onBoards('m.board_id')}))
			ORDER BY a.created_at, a.id`
		)
		.all(...boardValues, lower, upper, ...acts, ...sent, ...movedIn, ...boardValues) as { id: number; cardId: number | null; action: string }[];
	const last = new Map<string, string>();
	const abandoned = new Set<string>();
	for (const row of rows) {
		const key = row.cardId === null ? `entry ${row.id}` : `card ${row.cardId}`;
		const action = row.action.replace(/^api:/, '');
		if (action === ACTIONS.cardAbandoned) abandoned.add(key);
		else last.set(key, action);
	}
	for (const action of last.values()) figures[ACTS[action]]++;
	figures.abandoned = abandoned.size;
	const outcomes = figures.discarded + figures.committedFromOptions + figures.sentOn;
	figures.discardRate = outcomes === 0 ? null : figures.discarded / outcomes;

	// The options now, and when each became one: the latest of its creation,
	// its latest return to options and its column's latest conversion, if one
	// was recorded before card 2527, as
	// `optionsSince` reads for one column, here for all of them at once, so
	// that the reads do not grow with the boards (the S3 review's E3).
	const optionsFrom = `FROM cards c JOIN columns col ON col.id = c.column_id JOIN boards b ON b.id = col.board_id
		WHERE ${onBoards('col.board_id')} AND c.archived_at IS NULL AND ${UPSTREAM}`;
	const optionCards = `SELECT c.id ${optionsFrom}`;
	const options = sqlite
		.prepare(`SELECT c.id AS id, c.created_at AS createdAt, col.id AS columnId, col.board_id AS boardId ${optionsFrom}`)
		.all(...boardValues) as { id: number; createdAt: string; columnId: number; boardId: number }[];
	figures.options = options.length;
	if (options.length === 0) return figures;
	// Each option's latest return to options, on any board, and its latest
	// arrival on each board, in one read.
	const returnedActions = storedActions(ACTIONS.cardReturnedToOptions);
	const returned = new Map<number, string>();
	const arrived = new Map<string, string>();
	const optionActs = sqlite
		.prepare(
			`SELECT card_id AS cardId, action, board_id AS boardId, MAX(created_at) AS at FROM activity_log
			WHERE action IN (?, ?, ?, ?) AND card_id IN (${optionCards}) GROUP BY card_id, action, board_id`
		)
		.all(...returnedActions, ...storedActions(ACTIONS.cardMovedIn), ...boardValues) as { cardId: number; action: string; boardId: number; at: string }[];
	for (const { cardId, action, boardId, at } of optionActs) {
		if (returnedActions.includes(action)) returned.set(cardId, later(returned.get(cardId), at)!);
		else arrived.set(`${cardId}:${boardId}`, later(arrived.get(`${cardId}:${boardId}`), at)!);
	}
	// Only on the boards that hold options now, whose columns are the ones asked
	// about: each column's latest conversion to the Options column, as
	// recorded before card 2527, and each board's to an ideas board (card 2463).
	const converted = new Map<number, string>();
	const convertedBoards = new Map<number, string>();
	const conversions = sqlite
		.prepare(
			`SELECT detail, created_at AS at FROM activity_log
			WHERE action IN (?, ?, ?, ?) AND board_id IN (SELECT DISTINCT col.board_id ${optionsFrom})`
		)
		.all(...storedActions(ACTIONS.columnConvertedToOptions, ACTIONS.boardConvertedToIdeas), ...boardValues) as { detail: string; at: string }[];
	for (const { detail, at } of conversions) {
		const columnId = Number(CONVERTED_COLUMN.exec(detail)?.[1]);
		if (columnId && at > (converted.get(columnId) ?? '')) converted.set(columnId, at);
		const boardId = Number(CONVERTED_BOARD.exec(detail)?.[1]);
		if (boardId && at > (convertedBoards.get(boardId) ?? '')) convertedBoards.set(boardId, at);
	}
	const aged = options.map((card) => {
		const conversion = later(converted.get(card.columnId), convertedBoards.get(card.boardId));
		const arrivedSince = conversion !== undefined && (arrived.get(`${card.id}:${card.boardId}`) ?? '') > conversion;
		return { createdAt: card.createdAt, optionSince: later(later(card.createdAt, returned.get(card.id)), arrivedSince ? undefined : conversion)! };
	});
	const { oldestDays, over } = optionsAging(aged, now);
	figures.oldestOptionDays = oldestDays;
	figures.agingOptions = over;
	return figures;
}

/** A window's two ends in the stored form, both included (the S3 review's E4); thrown if either cannot be read. */
function windowOf(from: string, to: string): { lower: string; upper: string } {
	const lower = toStamp(from, 'lower');
	const upper = toStamp(to, 'upper');
	if (lower === null || upper === null) throw new Error(`Not a window: ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
	return { lower, upper };
}

/**
 * "Committed (all)" (milestone 22, ruling d): how many cards arrived as
 * committed work on these boards in the window, the arrival figure beside
 * throughput. Two kinds of arrival, each card counted once: a card committed
 * out of upstream (a `card_committed` entry in the window, either spelling),
 * and a card created in the window straight into a committed column, whose
 * `committed_at` is its `created_at`. An entry of a card since deleted has no
 * card id and counts once. The window is `upstreamFigures`'s: both ends
 * included. Two reads.
 */
export function committedAll(boardIds: readonly number[], from: string, to: string): number {
	const { lower, upper } = windowOf(from, to);
	const ids = [...new Set(boardIds)];
	if (ids.length === 0) return 0;
	const inBoards = `(${ids.map(() => '?').join(', ')})`;
	const committed = storedActions(ACTIONS.cardCommitted);
	const entries = sqlite
		.prepare(
			`SELECT card_id AS cardId FROM activity_log
			WHERE board_id IN ${inBoards} AND created_at BETWEEN ? AND ? AND action IN (?, ?)`
		)
		.all(...ids, lower, upper, ...committed) as { cardId: number | null }[];
	const created = sqlite
		.prepare(
			`SELECT c.id AS cardId FROM cards c JOIN columns col ON col.id = c.column_id
			WHERE col.board_id IN ${inBoards} AND c.committed_at = c.created_at AND c.created_at BETWEEN ? AND ?`
		)
		.all(...ids, lower, upper) as { cardId: number }[];
	const cards = new Set<number>();
	let deleted = 0;
	for (const { cardId } of [...entries, ...created]) {
		if (cardId === null) deleted++;
		else cards.add(cardId);
	}
	return cards.size + deleted;
}

/** One card's time in options, as `timeInOptions` finds it: when it became an option, and when it was committed out of upstream. */
export type TimeInOptions = { cardId: number; optionSince: string; committedAt: string };

/**
 * "Time in options" (milestone 22, ruling e): for each card committed from
 * options on these boards in the window, when it became an option and when it
 * was committed. A card counts when its last upstream act in the window is a
 * commitment, as `upstreamFigures` counts "Committed from options" (ruling
 * c), and the commitment measured is that last one.
 *
 * It became an option at the latest of the moments `optionsSince` reads for
 * the Options strip (the S1b review's B2), each taken before the commitment:
 * its creation, its latest return to options, and the latest conversion of
 * the column it left (recorded only before card 2527), which the
 * commitment's detail names
 * (`commitmentSuffix`; the S4a review's H3), or of that column's board to an
 * ideas board (card 2463). The conversion counts only if
 * the card was on that column's board when it happened: a `card_moved_in`
 * there between the conversion and the commitment means it arrived later,
 * from another board's upstream, keeping its age (decision M22-20), and then
 * its latest return or its creation stands. A commitment whose detail names
 * no column it left, or a column since deleted, has no conversion. A card
 * since deleted cannot be measured and is left out. Five reads, and one for
 * no commitment.
 */
export function timeInOptions(boardIds: readonly number[], from: string, to: string): TimeInOptions[] {
	const { lower, upper } = windowOf(from, to);
	const ids = [...new Set(boardIds)];
	if (ids.length === 0) return [];
	const inBoards = `(${ids.map(() => '?').join(', ')})`;
	const acts = storedActions(...Object.keys(ACTS));
	const rows = sqlite
		.prepare(
			`SELECT card_id AS cardId, action, detail, created_at AS at FROM activity_log
			WHERE board_id IN ${inBoards} AND created_at BETWEEN ? AND ? AND card_id IS NOT NULL
				AND action IN (${acts.map(() => '?').join(', ')})
			ORDER BY created_at, id`
		)
		.all(...ids, lower, upper, ...acts) as { cardId: number; action: string; detail: string | null; at: string }[];
	const last = new Map<number, { action: string; detail: string | null; at: string }>();
	for (const row of rows) last.set(row.cardId, { action: row.action.replace(/^api:/, ''), detail: row.detail, at: row.at });
	const committed = [...last.entries()]
		.filter(([, act]) => act.action === ACTIONS.cardCommitted)
		.map(([cardId, act]) => ({ cardId, at: act.at, left: commitmentColumns(act.detail).from }));
	if (committed.length === 0) return [];
	const cardIds = committed.map((c) => c.cardId);
	const inCards = `(${cardIds.map(() => '?').join(', ')})`;
	const created = new Map(
		(sqlite.prepare(`SELECT id, created_at AS at FROM cards WHERE id IN ${inCards}`).all(...cardIds) as { id: number; at: string }[]).map((r) => [r.id, r.at])
	);
	const returns = sqlite
		.prepare(`SELECT card_id AS cardId, created_at AS at FROM activity_log WHERE card_id IN ${inCards} AND action IN (?, ?)`)
		.all(...cardIds, ...storedActions(ACTIONS.cardReturnedToOptions)) as { cardId: number; at: string }[];
	// The conversions on the boards of the columns the cards left, by the
	// index that leads on the board, each with the column it made an option of:
	// the column it converted (an entry written before card 2527), or, for a
	// board made an ideas board (card 2463),
	// each of the columns left that are on that board.
	const left = [...new Set(committed.map((c) => c.left).filter((id): id is number => id !== null))];
	const conversions =
		left.length === 0
			? []
			: (
					sqlite
						.prepare(
							`SELECT a.board_id AS boardId, a.detail AS detail, a.created_at AS at, col.id AS leftId FROM activity_log a
							JOIN columns col ON col.board_id = a.board_id
							WHERE a.action IN (?, ?, ?, ?) AND col.id IN (${left.map(() => '?').join(', ')})`
						)
						.all(...storedActions(ACTIONS.columnConvertedToOptions, ACTIONS.boardConvertedToIdeas), ...left) as {
						boardId: number;
						detail: string;
						at: string;
						leftId: number;
					}[]
				).map((c) => ({ ...c, columnId: CONVERTED_BOARD.test(c.detail) ? c.leftId : Number(CONVERTED_COLUMN.exec(c.detail)?.[1]) || null }));
	const arrivals = sqlite
		.prepare(`SELECT card_id AS cardId, board_id AS boardId, created_at AS at FROM activity_log WHERE card_id IN ${inCards} AND action IN (?, ?)`)
		.all(...cardIds, ...storedActions(ACTIONS.cardMovedIn)) as { cardId: number; boardId: number; at: string }[];
	const measured: TimeInOptions[] = [];
	for (const { cardId, at, left: leftColumn } of committed) {
		const createdAt = created.get(cardId);
		if (createdAt === undefined) continue;
		// Stored moments share one form, so the latest is the greatest text.
		let since = createdAt;
		for (const r of returns) if (r.cardId === cardId && r.at <= at && r.at > since) since = r.at;
		let conversion: { boardId: number; at: string } | null = null;
		for (const c of conversions) if (c.columnId === leftColumn && c.at <= at && (conversion === null || c.at > conversion.at)) conversion = c;
		const arrivedSince =
			conversion !== null && arrivals.some((m) => m.cardId === cardId && m.boardId === conversion!.boardId && m.at > conversion!.at && m.at <= at);
		if (conversion !== null && !arrivedSince && conversion.at > since) since = conversion.at;
		measured.push({ cardId, optionSince: since, committedAt: at });
	}
	return measured;
}

/**
 * When work started on each of these cards, for the cycle time (milestone 22,
 * ruling a), by card id; a card with no start has no entry.
 *
 * Work starts at the earliest of two entries **at or after the card's current
 * commitment** (`committedAt`, or `createdAt` where nothing is recorded) and
 * **not after its completion** (`completedAt`): a `card_moved`, or a
 * `card_committed` into a column that is not a queue (the S4a review's H1).
 * A queue is the board's first committed column, a To Do or On Hold column,
 * or a column whose title names one (`isQueueColumn`: Backlog, Ready and the
 * like). A card committed into a queue starts when it is next moved; one
 * committed straight into In Progress, or into Complete, starts as it is
 * committed. An entry before the current commitment, from before a return to
 * options, is not the start of this round of work, and a move after the
 * completion, from one Complete column to another, is not a start at all
 * (the S4a review's H5). The column a commitment went into is read by its id,
 * from the end of the entry's detail (the S2 review's C3); one since deleted
 * cannot be told, and is not a start. Every entry in either spelling. Two
 * reads, and one with no commitment among them.
 *
 * For a card made before milestone 22 the commitment is its creation and no
 * entry is a commitment, so its start is its first `card_moved`, as it was.
 */
export function cycleStarts(
	cards: readonly { id: number; createdAt: string; committedAt: string | null; completedAt?: string | null }[]
): Map<number, string> {
	const starts = new Map<number, string>();
	if (cards.length === 0) return starts;
	const committedActions = storedActions(ACTIONS.cardCommitted);
	const rows = db
		.select({ cardId: activityLog.cardId, action: activityLog.action, at: activityLog.createdAt, detail: activityLog.detail })
		.from(activityLog)
		.where(and(inArray(activityLog.cardId, cards.map((c) => c.id)), inArray(activityLog.action, [...storedActions(ACTIONS.cardMoved), ...committedActions])))
		.orderBy(activityLog.createdAt, activityLog.id)
		.all();
	const targetOf = (detail: string | null) => commitmentColumns(detail).to;
	const targetIds = [...new Set(rows.filter((r) => committedActions.includes(r.action)).map((r) => targetOf(r.detail)).filter((id): id is number => id !== null))];
	// Every column of the boards those columns are on, in one read, for which
	// is each board's first committed column.
	const boardColumns =
		targetIds.length === 0
			? []
			: db
					.select({ id: columns.id, boardId: columns.boardId, title: columns.title, role: columns.role, position: columns.position })
					.from(columns)
					.where(inArray(columns.boardId, db.select({ boardId: columns.boardId }).from(columns).where(inArray(columns.id, targetIds))))
					.all();
	const firstCommitted = new Map<number, number>();
	for (const col of [...boardColumns].sort((a, b) => a.position - b.position || a.id - b.id)) {
		if (!isOptionsColumn(col) && !firstCommitted.has(col.boardId)) firstCommitted.set(col.boardId, col.id);
	}
	const targets = new Map(boardColumns.map((c) => [c.id, c]));
	const since = new Map(cards.map((c) => [c.id, c.committedAt ?? c.createdAt]));
	const until = new Map(cards.map((c) => [c.id, c.completedAt ?? null]));
	for (const row of rows) {
		if (row.cardId === null || starts.has(row.cardId) || row.at < since.get(row.cardId)!) continue;
		const completedAt = until.get(row.cardId);
		if (completedAt && row.at > completedAt) continue;
		if (committedActions.includes(row.action)) {
			const target = targets.get(targetOf(row.detail) ?? 0);
			if (!target || isQueueColumn(target) || firstCommitted.get(target.boardId) === target.id) continue;
		}
		starts.set(row.cardId, row.at);
	}
	return starts;
}

/**
 * A card's stage, as the exports name it (milestone 22, card 2462):
 * "Discarded" for a card discarded from upstream, "Option" for one in an
 * upstream column, `upstream` as its column's verdict, and "Committed" for
 * every other card. The exports list live cards, so "Discarded" is there for
 * a reader that lists archived ones.
 */
export function stageOf(card: { discardedAt: string | null }, upstream: boolean): 'Discarded' | 'Option' | 'Committed' {
	if (card.discardedAt !== null) return 'Discarded';
	return upstream ? 'Option' : 'Committed';
}

/**
 * A completed card's lead time and cycle time, in whole hours (milestone 22).
 * Lead time runs from the commitment, `committedAt` (or `createdAt` where
 * none is recorded), to completion: "Lead time (commitment to done)". Cycle
 * time runs from `started`, as `cycleStarts` finds it, to completion, null
 * with no start, and is clamped between 0 and the lead time (ruling a; the
 * S4a review's H5): work does not start before the card was committed to,
 * nor after it was done. `cycleStarts` gives no start outside those, so the
 * clamp is a backstop. Every moment is read as UTC (card 2095).
 */
export function flowTimes(
	card: { createdAt: string; committedAt: string | null; completedAt: string },
	started: string | undefined
): { leadTimeHours: number; cycleTimeHours: number | null } {
	const ms = (value: string) => parseStamp(value)?.getTime() ?? NaN;
	const completedMs = ms(card.completedAt);
	const leadMs = completedMs - ms(card.committedAt ?? card.createdAt);
	return {
		leadTimeHours: Math.round(leadMs / 3600000),
		cycleTimeHours: started === undefined ? null : Math.round(Math.max(0, Math.min(completedMs - ms(started), leadMs)) / 3600000)
	};
}

/** True if column `columnId` is upstream; false for a column that is not there. */
export function isUpstreamColumnId(columnId: number): boolean {
	const row = db
		.select({ role: columns.role, kind: boards.kind })
		.from(columns)
		.innerJoin(boards, eq(boards.id, columns.boardId))
		.where(eq(columns.id, columnId))
		.get();
	return row ? isUpstreamColumn(row, row.kind) : false;
}
