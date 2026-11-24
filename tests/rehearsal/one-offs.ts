/**
 * The one-off changes to data that migration files make: every file, from 0053
 * on, that deletes rows, drops a table or replaces rows (card 2106, decision 3),
 * and every one that rewrites a column in the rows it keeps (`keepsRows`: 0055,
 * card 2158, which gives every task request a new link; 0057, card 2155, which
 * takes cards out of a milestone of another board; 0060, milestone 22, which
 * commits every card that is not upstream; 0066, card 2769, which lets the
 * accounts there at the release set up two-step sign-in on their password;
 * 0069, card 2772, which gives every API key made before that card a deadline;
 * 0068, card 2849, which replaces the token of every used invite; 0084, card
 * 3064, which hashes in place what a server from before two-step sign-in
 * holds and takes back the data lines of 0066, 0069 and 0071). A file may
 * keep the rows of some tables and lose rows of another: 0084 also deletes two
 * settings, declared as that, and writes nine (the release moment, the six
 * first-run flags, the one-shot leave to keep a plain seal key and the scrub's
 * marker: its code review, CS-M2 and CS-L4), which take no row and need no
 * declaration. Card 3064 took the deletes of every session out
 * of 0067, of every unused invite out of 0068, and the end of every plain
 * requester link out of 0070, which now declares nothing.
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
 * marked `keepsRows` must name a file that loses no row of its table and
 * updates it; any other, a file that can lose rows.
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
	},
	// Card 2769: the release of two-step sign-in.
	{
		file: '0066_add_mfa_password_enrol.sql',
		table: 'users',
		change: 'mfa_password_enrol set to 1 for every account with no second factor and no enrolment link',
		keepsRows: true
	},
	// Its delete of every session taken out by card 3064.
	{ file: '0067_end_sessions_for_two_step.sql', table: 'settings', change: 'the remembered-browser secret deleted' },
	// Card 2849: invite tokens stored as hashes, in the release of two-step sign-in; its delete of every unused invite
	// taken out by card 3064.
	{
		file: '0068_end_plain_invite_tokens.sql',
		table: 'invite_tokens',
		change: "every used invite's token replaced",
		keepsRows: true
	},
	// Card 2772: a deadline for every API key made before this release.
	{
		file: '0069_add_api_key_deadline.sql',
		table: 'api_keys',
		change: 'deadline_at set for every key with no expiry or one later than the deadline',
		keepsRows: true
	},
	// Card 3064: the compatibility release, which keeps what a server from before two-step sign-in holds. 0070's end of
	// every plain requester link is taken out by it, and declares nothing now.
	{
		file: '0084_compatibility_release.sql',
		table: 'sessions',
		change: 'every session held in plain hashed in place and marked kept',
		keepsRows: true
	},
	{
		file: '0084_compatibility_release.sql',
		table: 'invite_tokens',
		change: 'every unused invite held in plain hashed in place',
		keepsRows: true
	},
	{
		file: '0084_compatibility_release.sql',
		table: 'task_requests',
		change: 'every access_token moved into request_links as its hash',
		keepsRows: true
	},
	{ file: '0084_compatibility_release.sql', table: 'api_keys', change: 'every deadline_at cleared', keepsRows: true },
	{ file: '0084_compatibility_release.sql', table: 'users', change: 'every mfa_password_enrol set to 0', keepsRows: true },
	{
		file: '0084_compatibility_release.sql',
		table: 'webhooks',
		change: 'set_with_key set to 0 where it was NULL',
		keepsRows: true
	},
	{
		file: '0084_compatibility_release.sql',
		table: 'settings',
		change: 'the API key deadline and the release of two-step sign-in deleted'
	}
]);

/** The first file the rule covers. Files before it were written before the rule. */
export const ONE_OFFS_FROM = '0053';
