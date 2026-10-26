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
import { and, eq, inArray, like, max } from 'drizzle-orm';
import { isUpstreamColumn } from '$lib/column-role';
import { ACTIONS, storedActions } from '$lib/server/logActivity';
import { optionsAging } from '$lib/board/board-view';
import { toStamp } from '$lib/timestamps';

/**
 * How a `column_converted_to_options` entry's detail ends: ` (column <id>)`.
 * The activity log has no column of its own for a column, so the conversion
 * names it here, at the end of the detail, after the quoted title, where no
 * title can put it; `optionsSince` looks for it there (milestone 22, the S1b
 * review's B2). A `card_committed` entry ends with it too, naming the column
 * the card was committed into, for the cycle time (the S2 review's C3).
 */
export function conversionSuffix(columnId: number): string {
	return ` (column ${columnId})`;
}

/**
 * When each of these cards, all in the Options column `column`, became an
 * option, for the strip's aging (milestone 22, ruling g, amended by the S1b
 * review's B2): the latest of its creation, its latest
 * `card_returned_to_options` entry, and the latest conversion of the column,
 * each in either spelling. A card converted with its column is an option from
 * the conversion, not from its creation; a card sent here from an ideas board
 * keeps its age. Two reads, and none for no cards. Stored moments share one
 * form, so the latest is the greatest text.
 */
export function optionsSince(column: { id: number; boardId: number }, cards: readonly { id: number; createdAt: string }[]): Map<number, string> {
	const since = new Map<number, string>();
	if (cards.length === 0) return since;
	const returned = new Map(
		db
			.select({ cardId: activityLog.cardId, at: max(activityLog.createdAt) })
			.from(activityLog)
			.where(and(inArray(activityLog.cardId, cards.map((c) => c.id)), inArray(activityLog.action, storedActions('card_returned_to_options'))))
			.groupBy(activityLog.cardId)
			.all()
			.map((r) => [r.cardId, r.at])
	);
	const converted =
		db
			.select({ at: max(activityLog.createdAt) })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.boardId, column.boardId),
					inArray(activityLog.action, storedActions(ACTIONS.columnConvertedToOptions)),
					like(activityLog.detail, `%${conversionSuffix(column.id)}`)
				)
			)
			.get()?.at ?? null;
	for (const card of cards) {
		const moments = [card.createdAt, returned.get(card.id), converted].filter((m): m is string => typeof m === 'string');
		since.set(card.id, moments.reduce((latest, m) => (m > latest ? m : latest)));
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
 * `card_moved_away` (ruling b). Card 2463 writes it; it is counted here
 * already so that the figures need no change when it does.
 */
const CARD_SENT = 'card_sent';

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

/** The end of a conversion entry's detail, ` (column <id>)` (`conversionSuffix`), read back. */
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
 * options and the latest conversion of its column (the rule of
 * `optionsSince`, the S1b review's B2), in whole days, as the Options strip
 * shows it. Four reads in all, however many boards and columns (the S3
 * review's E3). `now` is for tests.
 */
export function upstreamFigures(boardIds: readonly number[], from: string, to: string, now: number = Date.now()): UpstreamFigures {
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
	const ids = [...new Set(boardIds)];
	if (ids.length === 0) return figures;
	const inBoards = `(${ids.map(() => '?').join(', ')})`;

	// The acts in the window, oldest first, but a Send into a board in scope.
	const acts = storedActions(...Object.keys(ACTS), ACTIONS.cardAbandoned);
	const sent = storedActions(CARD_SENT);
	const movedIn = storedActions(ACTIONS.cardMovedIn);
	const rows = sqlite
		.prepare(
			`SELECT a.id AS id, a.card_id AS cardId, a.action AS action FROM activity_log a
			WHERE a.board_id IN ${inBoards} AND a.created_at BETWEEN ? AND ?
				AND a.action IN (${acts.map(() => '?').join(', ')})
				AND NOT (a.action IN (?, ?) AND a.card_id IS NOT NULL AND EXISTS (
					SELECT 1 FROM activity_log m WHERE m.card_id = a.card_id AND m.created_at = a.created_at
						AND m.action IN (?, ?) AND m.board_id IN ${inBoards}))
			ORDER BY a.created_at, a.id`
		)
		.all(...ids, lower, upper, ...acts, ...sent, ...movedIn, ...ids) as { id: number; cardId: number | null; action: string }[];
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
	// its latest return to options and its column's latest conversion, as
	// `optionsSince` reads for one column, here for all of them at once, so
	// that the reads do not grow with the boards (the S3 review's E3).
	const optionCards = `SELECT c.id FROM cards c JOIN columns col ON col.id = c.column_id JOIN boards b ON b.id = col.board_id
		WHERE col.board_id IN ${inBoards} AND c.archived_at IS NULL AND ${UPSTREAM}`;
	const options = sqlite
		.prepare(
			`SELECT c.id AS id, c.created_at AS createdAt, col.id AS columnId
			FROM cards c JOIN columns col ON col.id = c.column_id JOIN boards b ON b.id = col.board_id
			WHERE col.board_id IN ${inBoards} AND c.archived_at IS NULL AND ${UPSTREAM}`
		)
		.all(...ids) as { id: number; createdAt: string; columnId: number }[];
	figures.options = options.length;
	if (options.length === 0) return figures;
	const returnedActions = storedActions(ACTIONS.cardReturnedToOptions);
	const returned = new Map(
		(
			sqlite
				.prepare(
					`SELECT card_id AS cardId, MAX(created_at) AS at FROM activity_log
					WHERE action IN (?, ?) AND card_id IN (${optionCards}) GROUP BY card_id`
				)
				.all(...returnedActions, ...ids) as { cardId: number; at: string }[]
		).map((r) => [r.cardId, r.at])
	);
	const converted = new Map<number, string>();
	const conversions = sqlite
		.prepare(`SELECT detail, created_at AS at FROM activity_log WHERE board_id IN ${inBoards} AND action IN (?, ?)`)
		.all(...ids, ...storedActions(ACTIONS.columnConvertedToOptions)) as { detail: string; at: string }[];
	for (const { detail, at } of conversions) {
		const columnId = Number(CONVERTED_COLUMN.exec(detail)?.[1]);
		if (columnId && at > (converted.get(columnId) ?? '')) converted.set(columnId, at);
	}
	const aged = options.map((card) => {
		const moments = [card.createdAt, returned.get(card.id), converted.get(card.columnId)].filter((m): m is string => typeof m === 'string');
		return { createdAt: card.createdAt, optionSince: moments.reduce((latest, m) => (m > latest ? m : latest)) };
	});
	const { oldestDays, over } = optionsAging(aged, now);
	figures.oldestOptionDays = oldestDays;
	figures.agingOptions = over;
	return figures;
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
