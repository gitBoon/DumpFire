/**
 * The one-off changes to data that migration files make: every file, from 0053
 * on, that deletes rows, drops a table or replaces rows (card 2106, decision 3),
 * and every one that rewrites a column in the rows it keeps (`keepsRows`: 0055,
 * card 2158, which gives every task request a new link; 0057, card 2155, which
 * takes cards out of a milestone of another board; 0060, milestone 22, which
 * commits every card that is not upstream).
 *
 * The rehearsal (copy.rehearsal.ts) fails on any table that has fewer rows
 * after the runner than before. A file named here is allowed to take rows from
 * its table, in a run that applied that file and in no other, and the
 * rehearsal says so as a note. Anything else that loses rows still fails it.
 * One marked `keepsRows` takes no row: the rehearsal still fails its table if
 * it loses one, and notes the change in a run that applied the file.
 *
 * tests/migrations.test.ts reads every migration file from 0053 on, and fails
 * if one of them holds a statement that can lose rows and is not named here,
 * or if an entry here names a file or a table that does not exist. An entry
 * marked `keepsRows` must name a file that loses no row and updates its table;
 * any other, a file that can lose rows.
 *
 * A one-off runs once, when its file is applied, and that is what is declared
 * here. A file's change can also be repeated at start-up and after a restore,
 * as a backfill (`runBackfills` in src/lib/server/db/migrate.ts): 0057's and
 * 0060's are both, the backfill holding the file's own statement, so that a
 * restored older backup is repaired as the deploy was. Such a file is still
 * declared here, for the run that applies it; the backfill's repeats are the
 * runner's to report, not the rehearsal's.
 *
 * One backfill is no file's: every delivery board's Options column (card
 * 2527), which the first start of its image gives to every board made before.
 * It takes no row, and adds one to `columns` for each such board, which the
 * rehearsal notes as that (`compare`), not as a migration's doing.
 */
export type OneOff = {
	/** The migration file, as it is named in drizzle/. */
	file: string;
	/** The table it takes rows from. */
	table: string;
	/** What it does to them, as the rehearsal's note says it. */
	change: string;
	/**
	 * It rewrites values in the rows it keeps, and takes none: the rehearsal
	 * expects the table to keep every row, and notes the change.
	 */
	keepsRows?: true;
};

export const ONE_OFFS: readonly OneOff[] = Object.freeze([
	{ file: '0053_index_foreign_keys_end_sessions.sql', table: 'sessions', change: 'every row deleted' },
	{ file: '0054_index_user_time_end_unused_invites.sql', table: 'invite_tokens', change: 'every unused invite deleted' },
	{ file: '0055_replace_request_links.sql', table: 'task_requests', change: 'every access_token replaced', keepsRows: true },
	{
		file: '0057_cards_leave_other_boards_milestones.sql',
		table: 'cards',
		change: 'milestone_id cleared where it named a milestone of another board',
		keepsRows: true
	},
	{
		file: '0060_add_upstream_options.sql',
		table: 'cards',
		change: 'committed_at and committed_by filled from created_at and created_by for every card not upstream',
		keepsRows: true
	}
]);

/** The first file the rule covers. Files before it were written before the rule. */
export const ONE_OFFS_FROM = '0053';
