/**
 * decision-place-namers.ts — the one list of the tables that name a decision place (card 2684, R18; its plan review's
 * S-H2, E-H1 and E-M1).
 *
 * A place is a row of `decision_participants`. Every table here holds a foreign key to it with no ON DELETE action, so a
 * place one of them names is never deleted: it is only marked removed. Three writers delete a draft's place where
 * nothing names it, and each asks this list, never a list of its own:
 *
 *   - the restore's `DELETE_DRAFT_PLACE` (db/restore.ts), built from `placeUnnamedSql`: the restore runs with foreign
 *     keys off, so without the guard a place a planted row names would be deleted silently and the row left naming
 *     nothing;
 *   - the start-up pass's `capDecisionRolesAtStart` (startup-checks.ts), through `placeIsNamed`: foreign keys are on
 *     there, so without it the delete would throw and the pass fail;
 *   - setting a draft's participants (`setParticipants`, decision-participant-writes.ts), through `placeIsNamed`.
 *
 * tests/decision-record.test.ts reads every foreign key to `decision_participants` from the migrated schema and holds
 * this list to it, both ways, so that a table added later that names a place cannot be missed.
 *
 * No import but a type: the restore, the start-up pass and the service all read it.
 */
import type Database from 'better-sqlite3';

/** Every table with a foreign key to `decision_participants` (card 2684, R18): the record's, the questions and the flags. */
export const DECISION_PLACE_NAMERS = ['decision_responses', 'decision_questions', 'decision_events', 'decision_flags'] as const;

/**
 * The SQL that holds where no table of `DECISION_PLACE_NAMERS` names the place `param` (a named parameter, `@place`):
 * one `AND NOT EXISTS (…)` per table, to follow a `WHERE` that names the place.
 */
export function placeUnnamedSql(param: string): string {
	if (!/^[@:$][A-Za-z_]\w*$/.test(param)) throw new Error(`placeUnnamedSql: ${param} is not a named parameter`);
	return DECISION_PLACE_NAMERS.map((table) => `AND NOT EXISTS (SELECT 1 FROM ${table} WHERE participant_id = ${param})`).join(' ');
}

/** One statement for each connection, prepared once over `placeUnnamedSql`. */
const statements = new WeakMap<Database.Database, Database.Statement>();

/** Whether any table of `DECISION_PLACE_NAMERS` names the place `placeId` (card 2684, R18). */
export function placeIsNamed(sqlite: Database.Database, placeId: number): boolean {
	let statement = statements.get(sqlite);
	if (statement === undefined) {
		statement = sqlite.prepare(`SELECT CASE WHEN 1 ${placeUnnamedSql('@place')} THEN 0 ELSE 1 END AS named`).pluck();
		statements.set(sqlite, statement);
	}
	return statement.get({ place: placeId }) === 1;
}
