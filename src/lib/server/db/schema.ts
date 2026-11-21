import {
	customType,
	sqliteTable,
	text,
	integer,
	real,
	primaryKey,
	index,
	uniqueIndex,
	check,
	type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// The indexes declared in this file are the ones the migrations in `drizzle/`
// already create, under the same names. They are declared so that the model
// describes the database that exists; `tests/migrations.test.ts` compares the
// two. Declaring one here does not create it anywhere: only a migration does.
//
// Every foreign key column is the first column of some index (card 2106,
// migration 0053), so that deleting a row does not read the whole of each
// table that refers to it. A new foreign key needs its index declared here and
// created by its migration; tests/migrations.test.ts fails on one that has none.
//
// A column's name says what it holds (card 2095). A TEXT column named `*_at`,
// and `system_logs.timestamp`, is a moment, stored as `YYYY-MM-DD HH:MM:SS` in
// UTC: what `datetime('now')` writes, and what `stamp()` in
// src/lib/timestamps.ts writes from code. A column named `*_date` (or `date`)
// is a day, `YYYY-MM-DD`. The rule is how the conversion at every start finds
// the timestamp columns (`timestampColumns`, in timestamps.ts beside this
// file), so a new moment is named `*_at` and needs no list kept by hand.
// A `time_of_day` is a wall-clock time, read in the row's `time_zone`; neither
// is a moment (card 2159).

/**
 * A column declared TEXT whose values are bytes: a BLOB in each row, read and
 * written as a Buffer. SQLite keeps a BLOB as a BLOB in a column of any
 * affinity, and never takes one to equal text (card 2849). Declared before
 * the first table that uses it (`sessions`, card 2775): a `const` is not
 * there before its line.
 */
const bytesInText = customType<{ data: Buffer; driverData: Buffer }>({
	dataType: () => 'text'
});

// ─── Users & Auth ────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	emoji: text('emoji').default('👤'),
	role: text('role').notNull().default('user'), // 'superadmin' | 'admin' | 'user'
	notificationPrefs: text('notification_prefs').default('{}'),
	// Never written after the insert: with `id`, which is never reused, it
	// names one account for its whole life, which is how a restore matches an
	// account of a backup to this server's (card 2768).
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	// Two-step sign-in (migration 0065, card 2768; written from card 2769). The
	// consecutive wrong codes in each lane, the remembered browser's and every
	// other, and when each lane's pause ends; the same for recovery codes. A
	// restore sets every one of them back to 0 or NULL.
	mfaKnownWrong: integer('mfa_known_wrong').notNull().default(0),
	mfaOtherWrong: integer('mfa_other_wrong').notNull().default(0),
	mfaKnownResumesAt: text('mfa_known_resumes_at'),
	mfaOtherResumesAt: text('mfa_other_resumes_at'),
	mfaRecoveryWrong: integer('mfa_recovery_wrong').notNull().default(0),
	mfaRecoveryResumesAt: text('mfa_recovery_resumes_at'),
	// The last completed sign-in, when and from where, and the wrong codes
	// sent since it; the banner that tells the owner someone else holds the
	// password, and when it was last raised (at most one an hour).
	lastSignInAt: text('last_sign_in_at'),
	lastSignInFrom: text('last_sign_in_from'),
	failedCodesSinceSignIn: integer('failed_codes_since_sign_in').notNull().default(0),
	securityBanner: text('security_banner'), // null, or the reason it is shown
	securityBannerAt: text('security_banner_at'),
	// 1 when the account may set up its authenticator on its password alone:
	// set by the release migration (0066, card 2769) for every account that had
	// no second factor and no enrolment link then, and honoured only where no
	// mail host is configured and for 14 days from `two_step_released_at`.
	// Set back to 0 by an enrolment, by resetTwoStep and by the host reset
	// script, and by a restore for every account that is not this server's.
	mfaPasswordEnrol: integer('mfa_password_enrol').notNull().default(0),
	// The moment of the latest stolen-password signal, set on every one, where
	// security_banner_at moves at most once an hour: That was me clears the
	// banner only while this (or security_banner_at, where this is NULL) is
	// the moment the page showed. Cleared with the banner (migration 0069,
	// card 2772's code review, CS1).
	securitySignalLastAt: text('security_signal_last_at'),
	// When the account was disabled, and by whom (migration 0072, card 2671):
	// written by disableAccount and cleared together by enableAccount
	// (account-disable.ts). NULL for an account that is enabled. Read by every
	// gate (findSession, keyHolder, createSession, the sign-in, usableInvite).
	// A restore keeps this server's disabled accounts disabled (carryDisabled).
	disabledAt: text('disabled_at'),
	disabledBy: integer('disabled_by').references((): AnySQLiteColumn => users.id, { onDelete: 'set null' })
}, (table) => [
	index('idx_users_disabled_by').on(table.disabledBy)
]);

export const sessions = sqliteTable('sessions', {
	// The SHA-256 of the session's code, its 32 bytes as a BLOB (card 2775, as
	// invite_tokens.token, card 2849). The column keeps its name and declared
	// type, so the model's shape is unchanged; an image from before the card
	// compares it with the cookie, which is text, so no stored hash is a
	// session to it.
	tokenHash: bytesInText('id').primaryKey(),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: text('expires_at').notNull(),
	// When the session was made: it starts the total limit (card 2775,
	// SESSION_LIMITS in auth.ts).
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	// The wrong current passwords and codes this session has sent, counted as
	// each arrives and set back to 0 only by a right password with a right
	// code; at three the session is ended (migration 0062, cards 2701 and
	// 2771; checkCurrentProof in auth.ts).
	wrongPasswordCount: integer('wrong_password_count').notNull().default(0),
	// 1 when the session was made after a second factor (migration 0066, card
	// 2769). createSession writes 1; findSession refuses and deletes a hashed
	// row with 0. An older image's sessions are held in plain, so this image
	// never finds them, and endPlainSessions sweeps them at start (card 2775).
	twoStep: integer('two_step').notNull().default(0)
}, (table) => [
	index('idx_sessions_user_id').on(table.userId)
]);

// ─── Teams ───────────────────────────────────────────────────────────────────

export const teams = sqliteTable('teams', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	emoji: text('emoji').default('🏢'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const teamMembers = sqliteTable('team_members', {
	teamId: integer('team_id')
		.notNull()
		.references(() => teams.id, { onDelete: 'cascade' }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	role: text('role').notNull().default('member') // 'owner' | 'member'
}, (table) => [
	primaryKey({ columns: [table.teamId, table.userId] }),
	index('idx_team_members_user_id').on(table.userId)
]);

// ─── Boards ──────────────────────────────────────────────────────────────────

export const boards = sqliteTable('boards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	emoji: text('emoji').default('📋'),
	// A sub-board belongs to the card it was opened from and is deleted with it.
	// `boards` and `cards` refer to each other, so the reference is written as a
	// callback with its return type stated; without that TypeScript cannot infer
	// either table's type.
	parentCardId: integer('parent_card_id')
		.references((): AnySQLiteColumn => cards.id, { onDelete: 'cascade' }),
	categoryId: integer('category_id'),
	isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
	// 'delivery' (every board until milestone 22) or 'ideas': a board whose
	// every column is upstream, holding options that nobody has committed to
	// (migration 0060). Free text checked in code (`BOARD_KINDS` in
	// src/lib/column-role.ts), not a CHECK: this table is rebuilt from the model,
	// and the rebuild refuses a table with one.
	kind: text('kind').notNull().default('delivery'),
	createdBy: integer('created_by')
		.references(() => users.id, { onDelete: 'set null' }),
	// The board's Product Owner, the default decider of its decisions
	// (migration 0061, card 2673). NULL until somebody sets it. Only an account
	// that can edit the board may be set, by the board's owner or an admin, and
	// both are checked only when the value changes (`updateBoard` in
	// src/lib/server/boards.ts). SET NULL, as `createdBy` is.
	productOwnerUserId: integer('product_owner_user_id')
		.references(() => users.id, { onDelete: 'set null' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_boards_parent_card_id').on(table.parentCardId),
	index('idx_boards_created_by').on(table.createdBy),
	index('idx_boards_product_owner_user_id').on(table.productOwnerUserId)
]);

// ─── Board Categories ────────────────────────────────────────────────────────

export const boardCategories = sqliteTable('board_categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1')
});

// ─── Board Access Control ────────────────────────────────────────────────────

export const boardMembers = sqliteTable('board_members', {
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	role: text('role').notNull().default('viewer') // 'owner' | 'editor' | 'viewer'
}, (table) => [
	primaryKey({ columns: [table.boardId, table.userId] }),
	index('idx_board_members_user_id').on(table.userId)
]);

export const boardTeams = sqliteTable('board_teams', {
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	teamId: integer('team_id')
		.notNull()
		.references(() => teams.id, { onDelete: 'cascade' }),
	role: text('role').notNull().default('viewer') // 'editor' | 'viewer'
}, (table) => [
	primaryKey({ columns: [table.boardId, table.teamId] }),
	index('idx_board_teams_team_id').on(table.teamId)
]);

// ─── Columns & Cards ─────────────────────────────────────────────────────────

export const columns = sqliteTable('columns', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	position: real('position').notNull().default(0),
	color: text('color').notNull().default('#6366f1'),
	showAddCard: integer('show_add_card', { mode: 'boolean' }).notNull().default(false),
	wipLimit: integer('wip_limit').notNull().default(0),
	// NULL: an ordinary column, whose title decides whether it is To Do, On
	// Hold or Complete. 'options': the board's Options column, upstream of the
	// commitment point (migration 0060). Free text checked in code
	// (`COLUMN_ROLES` in src/lib/column-role.ts), for the reason `boards.kind` is.
	role: text('role')
}, (table) => [
	index('idx_columns_board_id').on(table.boardId)
]);

export const categories = sqliteTable('categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.references(() => boards.id, { onDelete: 'set null' }),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1')
}, (table) => [
	index('idx_categories_board_id').on(table.boardId)
]);

export const cards = sqliteTable('cards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	columnId: integer('column_id')
		.notNull()
		.references(() => columns.id, { onDelete: 'cascade' }),
	categoryId: integer('category_id')
		.references(() => categories.id, { onDelete: 'set null' }),
	title: text('title').notNull(),
	description: text('description').default(''),
	position: real('position').notNull().default(0),
	priority: text('priority').notNull().default('medium'),
	colorTag: text('color_tag').default(''),
	dueDate: text('due_date'),
	onHoldNote: text('on_hold_note').default(''),
	businessValue: text('business_value').default(''),
	pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
	/** When the card entered a Complete column. Cleared when it is reopened. */
	completedAt: text('completed_at'),
	/**
	 * When the card was completed for the first time. Never cleared.
	 *
	 * This is what stops XP being awarded again for moving a card out of Complete
	 * and back in. `completedAt` cannot say it, because reopening clears that.
	 */
	firstCompletedAt: text('first_completed_at'),
	archivedAt: text('archived_at'),
	/**
	 * When the card crossed the commitment point, and who moved it across.
	 * NULL while the card is an option: in an Options column or on an ideas
	 * board. A card created in a committed column is committed as it is
	 * created, by its creator; moving it back upstream clears both (migration
	 * 0060). Upstream is decided by the column and the board, never by this
	 * being NULL. `committedBy` is NULL too once that account is deleted, as
	 * `createdBy` is: losing an account must never lose the work.
	 */
	committedAt: text('committed_at'),
	committedBy: integer('committed_by').references(() => users.id, { onDelete: 'set null' }),
	/**
	 * When an archived card was discarded from upstream, and by whom: set with
	 * `archivedAt` when an option is archived, cleared by a restore.
	 */
	discardedAt: text('discarded_at'),
	discardedBy: integer('discarded_by').references(() => users.id, { onDelete: 'set null' }),
	coverUrl: text('cover_url'),
	recurrenceRule: text('recurrence_rule'),
	nextRecurrence: text('next_recurrence'),
	// A card belongs to at most one milestone. Nulled (not cascaded) when the
	// milestone is deleted — losing a goal must never lose the work.
	milestoneId: integer('milestone_id'),
	// Who raised the card. Null for cards created before this was recorded —
	// unknown authorship, not an unattributed guess.
	createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
	// ─── Reporting fields ───────────────────────────────────────────────────
	// What a management report needs and the technical card text cannot give it.
	// All nullable: absent means "not recorded", which is an honest answer.
	/** Plain English, ~12 words. Used verbatim in report appendices. */
	summary: text('summary'),
	/** new capability | customer issue | security & compliance | maintenance */
	theme: text('theme'),
	/** none | internal | live customers — optionally naming them. */
	customerImpact: text('customer_impact'),
	/**
	 * delivered | not needed | superseded | parked.
	 * All four land in a Complete column and are otherwise indistinguishable,
	 * which is what made "145 completed" overstate what was actually built.
	 */
	closeReason: text('close_reason'),
	/** built | on UAT | live */
	releaseState: text('release_state'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_cards_milestone').on(table.milestoneId),
	index('idx_cards_completed_at').on(table.completedAt),
	index('idx_cards_column_id').on(table.columnId),
	index('idx_cards_category_id').on(table.categoryId),
	index('idx_cards_created_by').on(table.createdBy),
	index('idx_cards_committed_by').on(table.committedBy),
	index('idx_cards_discarded_by').on(table.discardedBy)
]);

export const subtasks = sqliteTable('subtasks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	description: text('description').default(''),
	priority: text('priority').notNull().default('medium'),
	colorTag: text('color_tag').default(''),
	dueDate: text('due_date'),
	completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
	position: real('position').notNull().default(0)
}, (table) => [
	index('idx_subtasks_card_id').on(table.cardId)
]);

export const userXp = sqliteTable('user_xp', {
	name: text('name').primaryKey(),
	xp: integer('xp').notNull().default(0),
	emoji: text('emoji').default('👤')
});

export const activityLog = sqliteTable('activity_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	cardId: integer('card_id')
		.references(() => cards.id, { onDelete: 'set null' }),
	userId: integer('user_id')
		.references(() => users.id, { onDelete: 'set null' }),
	action: text('action').notNull(),
	detail: text('detail').default(''),
	userName: text('user_name').default(''),
	userEmoji: text('user_emoji').default('👤'),
	/**
	 * Where the action came from: 'ui' or 'api', or 'system' for an entry
	 * DumpFire wrote itself, with no user (card 2754: image retention).
	 *
	 * Null on rows written before this column existed. Those are not backfilled
	 * — the `api:` prefix on their action name already says which they were, and
	 * readers derive it the same way (see `readSource` in logActivity.ts). A
	 * guessed value would be indistinguishable from a recorded one.
	 */
	source: text('source'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_activity_log_created_at').on(table.createdAt),
	index('idx_activity_log_board_created').on(table.boardId, table.createdAt),
	index('idx_activity_log_card').on(table.cardId),
	// A person's entries, newest first, a page at a time (0054): it leads with
	// user_id, so the foreign key has its index.
	index('idx_activity_log_user_id_created_at').on(table.userId, table.createdAt)
]);

// ─── Daily Snapshots (for the CFD) ───────────────────────────────────────────

export const dailySnapshots = sqliteTable('daily_snapshots', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	columnId: integer('column_id')
		.notNull()
		.references(() => columns.id, { onDelete: 'cascade' }),
	date: text('date').notNull(),
	cardCount: integer('card_count').notNull().default(0)
}, (table) => [
	index('idx_daily_snapshots_board_date').on(table.boardId, table.date),
	index('idx_daily_snapshots_column_id').on(table.columnId)
]);

// ─── Webhooks ────────────────────────────────────────────────────────────────

export const webhooks = sqliteTable('webhooks', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	// The delivery address, sealed under the MFA key, bound to the webhook's id,
	// board and `receiver` (card 2928, stored-secrets.ts `webhookUrlAad`); '' for
	// one a backup left out and a restore could not fill, to be entered again.
	// Never read as it is stored: `openedUrl`.
	url: text('url').notNull(),
	// Sealed under the MFA key, bound to the webhook's id, board and address as
	// opened (card 2898, stored-secrets.ts): '' for none. Never read as it is stored.
	secret: text('secret').notNull().default(''),
	events: text('events').notNull().default('[]'),
	active: integer('active', { mode: 'boolean' }).notNull().default(true),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	// The account that last set the address or the secret (card 2168, migration
	// 0056): the caller of the create, and of an update that changes either.
	// NULL for a webhook made before 0056, and once its setter's account is
	// deleted. Never in an answer: presentWebhook leaves it out.
	setBy: integer('set_by').references(() => users.id, { onDelete: 'set null' }),
	// Why and when the webhook was switched off for good (card 2752, migration
	// 0071): 'setter cannot open' or 'no setter' (switchOffHeld in webhooks.ts),
	// 'setter access ended' (a password reset, a two-step reset (card 2915), an
	// invite used, the holder's own change that ends their keys, or the account
	// disabled or deleted: endAccountAccess, deleteUser, scripts/mfa-reset.mjs;
	// the code review's CS4; and, for one already off whose setter is disabled
	// or not recorded, holdUnheldOfGoneSetters at the first start of card 2923's
	// release and after a restore; card 2935: also for one whose secret an owner
	// or administrator whose access ended, or whose role was lowered, could
	// read, whoever set it, and the start pass's), card 2893's 'key ended', and
	// card 3012's HELD_FROM_UNSEALED_BACKUP ('restored from a backup whose seal
	// did not verify': every restored webhook with an address, its secret
	// discarded, holdUnsealedWebhooks in restore.ts). Set only with
	// `active` off; carried by a restore onto the same webhook (carryHolds,
	// fillSecretGaps); cleared only when the board's owner or an administrator
	// switches it on. NULL for one that is on, and for one switched off without
	// a hold (a PUT, a restore kept apart or a working copy), until its setter's
	// access ends (card 2923). Never in an answer: presentWebhook leaves both out.
	heldBecause: text('held_because'),
	heldAt: text('held_at'),
	// The API key that last set the address or the secret or switched it on,
	// and whether one was used (card 2893, carried by migration 0071). Never in
	// an answer.
	setByKey: integer('set_by_key').references(() => apiKeys.id, { onDelete: 'set null' }),
	setWithKey: integer('set_with_key', { mode: 'boolean' }),
	// The receiver the address sends to, in plain (card 2928, migration 0073):
	// its scheme, host and port (`receiverOf`), '' for an address that is no http
	// or https URL. Written with every address and bound into its seal:
	// recomputed from a plain one (the start's sweep, a restore), never taken
	// from the row or the backup then; kept from a backup where its address is
	// '' or an envelope, whose seal it is bound into. Read where the
	// key is not at hand or not needed: the held-off rule, the host a line, a
	// mail, a list or scripts/mfa-reset.mjs names, a backup's copy. Never in an
	// answer: presentWebhook answers an allowlist of fields, and this is not on it.
	receiver: text('receiver').notNull().default('')
}, (table) => [
	index('idx_webhooks_board_id').on(table.boardId),
	index('idx_webhooks_set_by').on(table.setBy),
	index('idx_webhooks_set_by_key').on(table.setByKey)
]);

// Which API key was given which webhook's signing secret (card 2947, migration
// 0075): written in the transaction of every answer that gives it
// (`answerWebhook`, webhooks.ts); a webhook's rows deleted when a PUT writes a
// new secret; a key's rows held and consumed when it is revoked, expires or
// passes its deadline (`holdRevealed`, `holdRevealsOfEndedKeys`), and by an
// ending of its account's access. `revealedAt` is the first time since the
// secret last changed; NULL for a row the once-only seed wrote. Both foreign
// keys cascade.
export const webhookReveals = sqliteTable('webhook_reveals', {
	webhookId: integer('webhook_id')
		.notNull()
		.references(() => webhooks.id, { onDelete: 'cascade' }),
	keyId: integer('key_id')
		.notNull()
		.references(() => apiKeys.id, { onDelete: 'cascade' }),
	revealedAt: text('revealed_at')
}, (table) => [
	primaryKey({ columns: [table.webhookId, table.keyId] }),
	index('idx_webhook_reveals_key_id').on(table.keyId)
]);

// ─── Card Dependencies ──────────────────────────────────────────────────────
// `cardId` is the card that is BLOCKED; `dependsOnCardId` is its BLOCKER.
// A unique index on the pair (migration 0042) enforces one row per direction.

/**
 * Dependencies between any two pieces of work — card→card, subtask→subtask, or
 * either mixed pair. One polymorphic table so the planning engine walks a single
 * graph regardless of node type; `*Type` is 'card' or 'subtask', and the BLOCKED
 * end waits on the BLOCKER end.
 *
 * The polymorphic ids carry no foreign key, so deleting a card or subtask must
 * clear its edges in code (see `removeWorkNodeEdges` in planning.ts).
 */
export const workDependencies = sqliteTable('work_dependencies', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	blockedType: text('blocked_type').notNull().default('card'),
	blockedId: integer('blocked_id').notNull(),
	blockerType: text('blocker_type').notNull().default('card'),
	blockerId: integer('blocker_id').notNull(),
	createdByUserId: integer('created_by_user_id').references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	// One row per ordering decision per direction.
	uniqueIndex('idx_work_dep_pair').on(
		table.blockedType,
		table.blockedId,
		table.blockerType,
		table.blockerId
	),
	index('idx_work_dep_blocked').on(table.blockedType, table.blockedId),
	index('idx_work_dep_blocker').on(table.blockerType, table.blockerId),
	index('idx_work_dependencies_created_by_user_id').on(table.createdByUserId)
]);

export type WorkDependency = typeof workDependencies.$inferSelect;

/**
 * Superseded by `workDependencies` in migration 0043, which carried every row
 * across as a (card, card) pair. Left in place rather than dropped so the
 * ordering decisions recorded before the change are recoverable. Nothing in the
 * application writes to it any more, so it holds the dependencies as they were
 * at 0043 (or as a restored backup had them), less those of cards deleted
 * since, and no dependency added or removed after that.
 *
 * No route reads it. The graph (`src/routes/api/graph/+server.ts`) was the
 * last that did, and now draws its `depends_on` edges from `workDependencies`.
 * The restore reads it, to refill `work_dependencies` from a backup taken
 * before 0043 (`db/restore.ts`).
 */
export const cardDependencies = sqliteTable('card_dependencies', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	dependsOnCardId: integer('depends_on_card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	createdByUserId: integer('created_by_user_id').references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	uniqueIndex('idx_card_dep_pair').on(table.cardId, table.dependsOnCardId),
	index('idx_card_dep_blocker').on(table.dependsOnCardId),
	index('idx_card_dependencies_created_by_user_id').on(table.createdByUserId)
]);

export const labels = sqliteTable('labels', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1')
}, (table) => [
	index('idx_labels_board_id').on(table.boardId)
]);

export const cardLabels = sqliteTable('card_labels', {
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	labelId: integer('label_id')
		.notNull()
		.references(() => labels.id, { onDelete: 'cascade' })
}, (table) => [
	index('idx_card_labels_card_id').on(table.cardId),
	index('idx_card_labels_label_id').on(table.labelId)
]);

// ─── Settings ────────────────────────────────────────────────────────────────

// The secrets kept here are sealed under the MFA key (card 2898,
// stored-secrets.ts): `smtp_pass`, the secret fields of `backup_config`, and
// `known_browser_secret`, `request_form_secret`, `backup_seal_key` and card
// 2928's `webhook_address_mac_key`.
export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

// ─── Setting Setters ─────────────────────────────────────────────────────────
// Who put the settings that send mail or backups somewhere at each place they
// have been (card 2397, migration 0059): `mail` (every smtp_* row of
// `settings`, as one), `app_url`, and `backup_destination:<name>` (each
// destination of `backup_config`, found by name as everything else finds it).
// `place` is a digest of where the setting sends; its setter is the account
// recorded for the place it is at now, so one changed and changed back is
// its first setter's again (the second code review). Demoting that account to
// user, or deleting it, removes what it set, in the same transaction
// (src/lib/server/setting-setters.ts). No row for its place is a setting
// saved before 0059, or whose setter nobody recorded: it stays in force,
// unattributed. CASCADE, as deleteUser removes the settings themselves first.
export const settingSetters = sqliteTable('setting_setters', {
	setting: text('setting').notNull(),
	place: text('place').notNull(),
	// NULL: a place recorded as nobody's, the one a setting saved before 0059 left when first moved (the third review).
	userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' })
}, (table) => [
	primaryKey({ columns: [table.setting, table.place] }),
	index('idx_setting_setters_user_id').on(table.userId)
]);

// ─── Setting Holds ───────────────────────────────────────────────────────────
// The settings held for the superadmin's review (card 2922, migration 0074):
// when an account's access ends with its API keys, every (setting, place) its
// setter rows record is copied here, and a setting is held while it is at a
// place this table holds (src/lib/server/setting-holds.ts): no mail through
// held mail settings, no link from a held App URL, no backup to a held
// destination. Only the superadmin's Keep deletes a row; a removal leaves it,
// so a setting back at that place is held again. No foreign key: a hold
// outlives the account whose ending made it; `set_by_name` names it then.
export const settingHolds = sqliteTable('setting_holds', {
	setting: text('setting').notNull(),
	place: text('place').notNull(),
	heldBecause: text('held_because').notNull(),
	heldAt: text('held_at').notNull(),
	setBy: integer('set_by'),
	setByName: text('set_by_name')
}, (table) => [
	primaryKey({ columns: [table.setting, table.place] })
]);

// ─── Card Assignees ──────────────────────────────────────────────────────────

export const cardAssignees = sqliteTable('card_assignees', {
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' })
}, (table) => [
	primaryKey({ columns: [table.cardId, table.userId] }),
	index('idx_card_assignees_user_id').on(table.userId)
]);

// ─── Invite Tokens ───────────────────────────────────────────────────────────

// ─── Board Favourites ────────────────────────────────────────────────────────

export const boardFavourites = sqliteTable('board_favourites', {
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	primaryKey({ columns: [table.userId, table.boardId] }),
	index('idx_board_favourites_board_id').on(table.boardId)
]);

export const inviteTokens = sqliteTable('invite_tokens', {
	// The SHA-256 of the token sent, its 32 bytes as a BLOB (card 2849). The
	// column keeps its name and its declared type, so that an older image still
	// reads the table, and the shape the model checks is unchanged. That image
	// compares the column with the address, which is text, so no hash here is
	// ever a link to it (plan decision 1; the code review, CR1).
	tokenHash: bytesInText('token').primaryKey(),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: text('expires_at').notNull(),
	used: integer('used', { mode: 'boolean' }).notNull().default(false),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_invite_tokens_user_id').on(table.userId)
]);

// ─── Two-Step Sign-In ────────────────────────────────────────────────────────
// The second factor of signing in (migration 0065, card 2768). Every table
// here belongs to one account and goes with it (CASCADE). A token is kept only
// as its SHA-256 hash and a recovery code only as an account-bound hash; an
// authenticator's secret only as AES-256-GCM ciphertext under a key that is
// kept in a file outside the database and outside every backup
// (src/lib/server/mfa-key.ts). No CHECK on the kinds and stages: the model
// check cannot see one, and their validity is the code's.

// A link that lets one account set up its authenticator (card 2769 issues and
// takes them). Ended with the account's pending sign-ins on a password set or
// an email or role change; never in a backup and never restored.
export const enrolmentLinks = sqliteTable('enrolment_links', {
	tokenHash: text('token_hash').primaryKey(), // SHA-256 hex of the token sent
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	issuedBy: text('issued_by').notNull(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	expiresAt: text('expires_at').notNull()
}, (table) => [
	index('idx_enrolment_links_user_id').on(table.userId)
]);

// An account's authenticators. `secret_ciphertext` is base64 of the
// ciphertext and its 16-byte GCM tag, `secret_nonce` base64 of the 12 random
// bytes it was sealed with, and `key_id` names the key that sealed it. The
// sealing binds `factor_uid` and the user id, so a row moved to another
// factor or account does not open. `last_step` is the last time step spent,
// so a code is never accepted twice.
export const mfaFactors = sqliteTable('mfa_factors', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	factorUid: text('factor_uid').notNull().unique(), // 128-bit random hex
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	kind: text('kind').notNull(), // 'totp'
	label: text('label').notNull(),
	keyId: text('key_id').notNull(),
	secretCiphertext: text('secret_ciphertext').notNull(),
	secretNonce: text('secret_nonce').notNull(),
	lastStep: integer('last_step'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	lastUsedAt: text('last_used_at')
}, (table) => [
	index('idx_mfa_factors_user_id').on(table.userId)
]);

// An account's single-use recovery codes, each kept only as the SHA-256 hex
// of the code bound to the account's id; `used_at` is set when it is spent.
export const mfaRecoveryCodes = sqliteTable('mfa_recovery_codes', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	codeHash: text('code_hash').notNull().unique(),
	usedAt: text('used_at'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_mfa_recovery_codes_user_id').on(table.userId)
]);

// A sign-in waiting for its second factor (card 2769 issues and takes them).
// Ended on a password set or an email or role change; never in a backup and
// never restored. The enrolment columns hold a secret being set up, sealed as
// a factor's is.
export const signInChallenges = sqliteTable('sign_in_challenges', {
	tokenHash: text('token_hash').primaryKey(), // SHA-256 hex of the token sent
	shortId: text('short_id').notNull(),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	purpose: text('purpose').notNull(),
	stage: text('stage'),
	lane: text('lane').notNull(),
	passwordHash: text('password_hash').notNull(),
	keyId: text('key_id'),
	enrolCiphertext: text('enrol_ciphertext'),
	enrolNonce: text('enrol_nonce'),
	rememberedNonce: text('remembered_nonce'),
	wrongCount: integer('wrong_count').notNull().default(0),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	expiresAt: text('expires_at').notNull(),
	// What lets an enrol challenge set up a factor ('password', 'link',
	// 'invite' or 'setup'), and the hash of the enrolment link it came from,
	// which is taken with the factor (migration 0066, card 2769).
	enrolGrant: text('enrol_grant'),
	enrolmentLinkHash: text('enrolment_link_hash')
}, (table) => [
	index('idx_sign_in_challenges_user_id').on(table.userId)
]);

export type MfaFactor = typeof mfaFactors.$inferSelect;
export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect;

// ─── Type Exports ────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type Board = typeof boards.$inferSelect;
export type BoardCategory = typeof boardCategories.$inferSelect;
export type BoardMember = typeof boardMembers.$inferSelect;
export type BoardTeam = typeof boardTeams.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Subtask = typeof subtasks.$inferSelect;
export type UserXp = typeof userXp.$inferSelect;
export type ActivityLog = typeof activityLog.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type CardAssignee = typeof cardAssignees.$inferSelect;
export type CardComment = typeof cardComments.$inferSelect;
export type InviteToken = typeof inviteTokens.$inferSelect;
export type BoardFavourite = typeof boardFavourites.$inferSelect;

// ─── Card Templates ───────────────────────────────────────────────────────────

export const cardTemplates = sqliteTable('card_templates', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id').references(() => boards.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	title: text('title').notNull().default(''),
	description: text('description').default(''),
	priority: text('priority').notNull().default('medium'),
	subtasksJson: text('subtasks_json').default('[]'),
	labelsJson: text('labels_json').default('[]'),
	createdBy: integer('created_by').references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_card_templates_board_id').on(table.boardId),
	index('idx_card_templates_created_by').on(table.createdBy)
]);


// ─── Milestones ──────────────────────────────────────────────────────────────

/**
 * A goal that spans many cards. `boardId` is nullable so a milestone can cover
 * several projects (a migration touches more than one board). Deliberately has
 * no per-card dates: sequencing comes from card_dependencies, and everything
 * else the planning view shows is computed in `$lib/server/planning`.
 */
export const milestones = sqliteTable('milestones', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id').references(() => boards.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	targetDate: text('target_date'),
	status: text('status').notNull().default('open'), // 'open' | 'closed'
	createdBy: integer('created_by').references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_milestones_board_id').on(table.boardId),
	index('idx_milestones_created_by').on(table.createdBy)
]);

export type Milestone = typeof milestones.$inferSelect;
export type CardDependency = typeof cardDependencies.$inferSelect;

// ─── Card Attachments ────────────────────────────────────────────────────────

export const cardAttachments = sqliteTable('card_attachments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	filename: text('filename').notNull(),
	originalName: text('original_name').notNull(),
	mimeType: text('mime_type').notNull().default('application/octet-stream'),
	sizeBytes: integer('size_bytes').notNull().default(0),
	uploadedBy: integer('uploaded_by').references(() => users.id),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_card_attachments_card_id').on(table.cardId),
	index('idx_card_attachments_uploaded_by').on(table.uploadedBy)
]);

export type CardTemplate = typeof cardTemplates.$inferSelect;
export type CardAttachment = typeof cardAttachments.$inferSelect;

// ─── Card Comments ───────────────────────────────────────────────────────────

export const cardComments = sqliteTable('card_comments', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	content: text('content').notNull(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_card_comments_card_id').on(table.cardId),
	index('idx_card_comments_user_id').on(table.userId)
]);

// ─── Task Requests ───────────────────────────────────────────────────────────

export const taskRequests = sqliteTable('task_requests', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	targetType: text('target_type').notNull().default('team'), // 'user' | 'team'
	targetId: integer('target_id').notNull(),
	requesterName: text('requester_name').notNull().default('Anonymous'),
	requesterEmail: text('requester_email'),
	requesterUserId: integer('requester_user_id').references(() => users.id, { onDelete: 'set null' }),
	title: text('title').notNull(),
	description: text('description').default(''),
	priority: text('priority').notNull().default('medium'),
	/**
	 * 'unverified' | 'pending' | 'accepted' | 'rejected'.
	 *
	 * A request from someone without an account starts 'unverified' and is
	 * invisible to the team until the requester confirms it from the email sent
	 * to the address they gave. Only then does it become 'pending'.
	 */
	status: text('status').notNull().default('pending'),
	/**
	 * Retired by card 2870: always NULL from this image. It held the secret in
	 * the requester's link in plain; the links are now in `request_links`,
	 * each kept only as the SHA-256 of its token. The column is kept so that
	 * an older image still reads the table, and whatever such an image writes
	 * into it is set back to NULL at the next start (`endPlainRequestLinks` in
	 * startup-checks.ts). Named so that no use of the old property type-checks.
	 */
	retiredAccessToken: text('access_token'),
	businessValue: text('business_value').default(''),
	resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
	resolvedCardId: integer('resolved_card_id').references(() => cards.id, { onDelete: 'set null' }),
	desiredBoardId: integer('desired_board_id').references(() => boards.id, { onDelete: 'set null' }),
	rejectReason: text('reject_reason'),
	/**
	 * Card 3020 (migration 0078): NULL for none, otherwise why the requester's
	 * mail is held, in words. A restore of a backup whose seal did not verify
	 * writes it for each request with an address this server did not hold as it
	 * is (`holdUnsealedRequestMail`); while it is set `requesterMailAddress`
	 * answers null and progress mail passes the request by. Cleared by an
	 * administrator's release, recorded in the three columns below.
	 */
	mailHeldBecause: text('mail_held_because'),
	mailReleasedAt: text('mail_released_at'),
	mailReleasedBy: integer('mail_released_by').references(() => users.id, { onDelete: 'set null' }),
	/** The releasing administrator's name as it was, since the account may be deleted. */
	mailReleasedByName: text('mail_released_by_name'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	resolvedAt: text('resolved_at')
}, (table) => [
	// Kept with the retired column (card 2870): it takes any number of NULLs.
	uniqueIndex('task_requests_access_token_idx').on(table.retiredAccessToken),
	index('idx_task_requests_requester_user_id').on(table.requesterUserId),
	index('idx_task_requests_resolved_by').on(table.resolvedBy),
	index('idx_task_requests_resolved_card_id').on(table.resolvedCardId),
	index('idx_task_requests_desired_board_id').on(table.desiredBoardId),
	index('idx_task_requests_mail_released_by').on(table.mailReleasedBy)
]);

export type TaskRequest = typeof taskRequests.$inferSelect;
export type NewTaskRequest = typeof taskRequests.$inferInsert;

// ─── Request Links ───────────────────────────────────────────────────────────

/**
 * A requester's links (card 2870): one per mail that carried one, and one per
 * new link asked for, each kept only as the SHA-256 of its token, in hex. The
 * token is only in the mail. The newest REQUEST_MAIL_LINKS_KEPT of `mail` and
 * REQUEST_ASK_LINKS_KEPT of `ask` are kept per request (request-tokens.ts).
 */
export const requestLinks = sqliteTable('request_links', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	tokenHash: text('token_hash').notNull().unique(),
	requestId: integer('request_id')
		.notNull()
		.references(() => taskRequests.id, { onDelete: 'cascade' }),
	source: text('source').notNull(), // 'mail' | 'ask'
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_request_links_request_id').on(table.requestId)
]);

// ─── Request Messages (conversation thread) ─────────────────────────────────

export const requestMessages = sqliteTable('request_messages', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	requestId: integer('request_id').notNull().references(() => taskRequests.id, { onDelete: 'cascade' }),
	senderType: text('sender_type').notNull().default('admin'), // 'admin' | 'requester'
	senderName: text('sender_name').notNull(),
	message: text('message').notNull(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_request_messages_request_id').on(table.requestId)
]);

export type RequestMessage = typeof requestMessages.$inferSelect;

// ─── API Keys ────────────────────────────────────────────────────────────────

export const apiKeys = sqliteTable('api_keys', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	keyHash: text('key_hash').notNull().unique(),
	keyPrefix: text('key_prefix').notNull(),
	name: text('name').notNull(),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	lastUsedAt: text('last_used_at'),
	expiresAt: text('expires_at'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	// The moment by which a key made before two-step sign-in must be kept, or
	// it stops working as an expired key does (deadlinePassed in auth.ts).
	// Set by migration 0069 and by the restore of a backup made before it;
	// cleared by Keep this key (card 2772). NULL: no deadline.
	deadlineAt: text('deadline_at')
}, (table) => [
	index('idx_api_keys_user_id').on(table.userId)
]);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

// Every API key ended on this server (card 2995, migration 0076): its row id
// and the SHA-256 the gate checks it by, never the key, with when and why.
// Written by `endApiKeys` (key-revocations.ts) in the transaction that deletes
// the key; never deleted, changed or replaced. A seed row has `keyHash` '' and
// names a key by its id where that id is at most the watermark, the row whose
// `keyHash` is 'watermark'. No foreign key: a row outlives its key. A restore
// and Reset Everything keep it; a restore adds the backup's rows.
export const apiKeyRevocations = sqliteTable('api_key_revocations', {
	keyId: integer('key_id').notNull(),
	keyHash: text('key_hash').notNull(),
	revokedAt: text('revoked_at').notNull(),
	revokedBecause: text('revoked_because').notNull()
}, (table) => [
	primaryKey({ columns: [table.keyHash, table.keyId] })
]);

// Every ending of an account on this server (card 2996, migration 0077): by its
// row id and its creation time (`accountCreated`, `users.created_at` in the
// stored form), what happened (`deleted`, `disabled`, `enabled`, `role`), the
// role after for a role row, a SHA-256 fingerprint of the password hash for a
// deleted one (never the hash), when, and whether this server wrote it
// (`here`), a restore brought it (`backup`) or the record's own rule wrote it
// (`belt`, never evidence against a superadmin). `seq` is the order of writing.
// A seed row has `accountCreated` '' and names an account by its id where that
// id is at most the watermark (the row whose `ending` is 'watermark'). Written
// by `recordAccountEnding` (account-endings.ts) in the transaction of the
// change, with a plain INSERT; never deleted, changed or replaced. No foreign
// key: a row outlives its account. A restore and Reset Everything keep it; a
// restore adds the backup's rows.
export const accountEndings = sqliteTable('account_endings', {
	seq: integer('seq').primaryKey(),
	userId: integer('user_id').notNull(),
	accountCreated: text('account_created').notNull(),
	ending: text('ending').notNull(),
	role: text('role').notNull().default(''),
	credential: text('credential').notNull().default(''),
	endedAt: text('ended_at').notNull(),
	// The moment as the row's writer stated it, before any clamp (card 2996's code review, FP5): the union's key.
	statedEnded: text('stated_ended').notNull().default(''),
	origin: text('origin').notNull().default('here')
}, (table) => [
	index('account_endings_account').on(table.userId, table.accountCreated, table.ending, table.statedEnded),
	index('account_endings_credential').on(table.credential).where(sql`credential <> ''`),
	index('account_endings_watermark').on(table.userId).where(sql`ending = 'watermark'`)
]);

// Every change of who may open a board, who is in a team and which account a
// person is linked to (card 3002, migration 0079): one row per change, by the
// identity of what is opened (`subjectId` and `subjectCreated`: a board, team
// or person and its `created_at` in the stored form) and of who gets it
// (`holderId` and `holderCreated`: an account, or a team for a share; 0 and ''
// for none), its `kind`, the `access` after the change, when, and whether this
// server wrote it (`here`) or a restore brought it (`backup`). `seq` is the
// order of writing, and this server's rows rank by it alone. Grants and
// narrowings alike. Written in the transaction of the change with a plain
// INSERT; never deleted, changed or replaced. No foreign key: a row outlives
// what it names. A restore and Reset Everything keep it; a restore adds the
// backup's rows. The creation columns are not `*_at` columns, so the timestamp
// normaliser never rewrites them.
export const accessChanges = sqliteTable('access_changes', {
	seq: integer('seq').primaryKey(),
	kind: text('kind').notNull(),
	subjectId: integer('subject_id').notNull(),
	subjectCreated: text('subject_created').notNull(),
	holderId: integer('holder_id').notNull().default(0),
	holderCreated: text('holder_created').notNull().default(''),
	access: text('access').notNull(),
	changedAt: text('changed_at').notNull(),
	// The moment as the row's writer stated it, in the stored form, or a digest: with `access`, the union's key.
	statedChanged: text('stated_changed').notNull().default(''),
	origin: text('origin').notNull().default('here')
}, (table) => [
	// The latest row of a pair by origin, in seq order (the rowid ends every index entry).
	index('access_changes_pair').on(table.subjectId, table.kind, table.subjectCreated, table.holderId, table.holderCreated, table.origin),
	// The latest row of a subject by origin, any holder.
	index('access_changes_subject').on(table.subjectId, table.kind, table.subjectCreated, table.origin),
	// The restore's union.
	index('access_changes_union').on(table.subjectId, table.kind, table.subjectCreated, table.holderId, table.holderCreated, table.statedChanged, table.access),
	// The start and five-minute pass's one read of whether any row is dated after now (card 3033, migration 0080).
	index('access_changes_changed').on(table.changedAt)
]);

// Every change of where this server sends (card 3004, migration 0081): one row per change of a webhook, a report
// schedule or one of its addresses, a backup destination, the mail server or the App URL, by identity. An item with an
// id is named by `itemId` and `itemCreated` (its `created_at` in the stored form, '' where that does not read); a place
// by `place`, a digest of where it sends (SHA-256 for a destination, the mail and the App URL; keyed for a recipient's
// address); a webhook's address by `address`, a keyed digest. `state` is the item's state after the change, `origin`
// whether this server wrote it (`here`), its once-only seed did (`seed`, marked by one `seeded` row) or a restore
// brought it (`backup`). `seq` is the order of writing, and this server's rows rank by it alone. Written in the
// transaction of the change with a plain INSERT; never deleted, changed or replaced. No foreign key: a row outlives
// what it names. A restore and Reset Everything keep it. The creation column is not an `*_at` column, so the timestamp
// normaliser never rewrites it.
export const outboundChanges = sqliteTable('outbound_changes', {
	seq: integer('seq').primaryKey(),
	kind: text('kind').notNull(),
	itemId: integer('item_id').notNull().default(0),
	itemCreated: text('item_created').notNull().default(''),
	place: text('place').notNull().default(''),
	address: text('address').notNull().default(''),
	state: text('state').notNull(),
	changedAt: text('changed_at').notNull(),
	// The moment as the row's writer stated it, in the stored form, or a digest: with `state` and `address`, the union's key.
	statedChanged: text('stated_changed').notNull().default(''),
	origin: text('origin').notNull().default('here')
}, (table) => [
	// The latest row of an item by origin, in seq order (the rowid ends every index entry).
	index('outbound_changes_item').on(table.kind, table.itemId, table.itemCreated, table.place, table.origin),
	// The restore's union.
	index('outbound_changes_union').on(table.kind, table.itemId, table.itemCreated, table.place, table.statedChanged, table.state, table.address),
	// The start and five-minute pass's one read of whether any row is dated after now.
	index('outbound_changes_changed').on(table.changedAt)
]);

// ─── System Logs (structured application logging) ───────────────────────────

export const systemLogs = sqliteTable('system_logs', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	timestamp: text('timestamp').notNull(),
	level: text('level').notNull(), // 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'
	context: text('context').notNull(),
	message: text('message').notNull(),
	meta: text('meta'), // JSON string of structured fields
	userId: integer('user_id'),
	ip: text('ip')
}, (table) => [
	index('idx_system_logs_timestamp').on(table.timestamp),
	index('idx_system_logs_level').on(table.level)
]);

export type SystemLog = typeof systemLogs.$inferSelect;

// ─── Backup Log ──────────────────────────────────────────────────────────────

export const backupLog = sqliteTable('backup_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	destinationType: text('destination_type').notNull(), // 'sftp' | 's3' | 'gdrive' | 'onedrive'
	destinationName: text('destination_name').notNull(),
	filename: text('filename').notNull(),
	sizeBytes: integer('size_bytes'),
	status: text('status').notNull(), // 'success' | 'failed'
	error: text('error'),
	durationMs: integer('duration_ms'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export type BackupLogEntry = typeof backupLog.$inferSelect;

// ─── Report Schedules ────────────────────────────────────────────────────────

export const reportSchedules = sqliteTable('report_schedules', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	scope: text('scope').notNull().default('board'), // 'board' | 'category' | 'all'
	scopeId: integer('scope_id'),
	frequency: text('frequency').notNull().default('weekly'), // 'weekly' | 'monthly'
	dayOfWeek: integer('day_of_week').notNull().default(1),
	dayOfMonth: integer('day_of_month').notNull().default(1),
	timeOfDay: text('time_of_day').notNull().default('09:00'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	recipients: text('recipients').notNull().default(''), // comma-separated email addresses
	periodDays: integer('period_days').notNull().default(7), // lookback period in days
	detailLevel: text('detail_level').notNull().default('detailed'), // 'summary' | 'detailed'
	statusFilter: text('status_filter').notNull().default('all'), // 'all' | 'completed' | 'in_progress' | 'todo'
	lastRunAt: text('last_run_at'),
	nextRunAt: text('next_run_at'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	// The IANA zone `time_of_day` is read in, such as 'Europe/London' (card
	// 2159, migration 0058). 'UTC' for a schedule made before there was one, and
	// for a caller that sends none: the same literal as 0058's DEFAULT and
	// DEFAULT_SCHEDULE_TIME_ZONE in src/lib/report-schedule-time.ts.
	timeZone: text('time_zone').notNull().default('UTC')
}, (table) => [
	index('idx_report_schedules_user_id').on(table.userId)
]);

export type ReportSchedule = typeof reportSchedules.$inferSelect;
export type NewReportSchedule = typeof reportSchedules.$inferInsert;

// ─── Token Usage ─────────────────────────────────────────────────────────────

/**
 * What a piece of work actually cost, in tokens.
 *
 * A ledger rather than a counter: entries accumulate as the work proceeds, so
 * the total climbs toward completion and the accrual stays visible. A mistake
 * is corrected by writing a negative entry, never by editing history.
 *
 * Exactly one of `cardId` / `subtaskId` is set. A card's reported total is its
 * own entries plus those of every subtask beneath it.
 */
export const tokenUsage = sqliteTable('token_usage', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	cardId: integer('card_id').references(() => cards.id, { onDelete: 'cascade' }),
	subtaskId: integer('subtask_id').references(() => subtasks.id, { onDelete: 'cascade' }),
	/** Signed: a correction is a negative entry. */
	tokens: integer('tokens').notNull(),
	/** Which model spent them — without it a total cannot be turned into cost. */
	model: text('model'),
	/**
	 * Exact split, when the caller knows it. Input and output are priced ~5x
	 * apart, so an entry carrying these is costed exactly; one without falls
	 * back to a stated blend assumption. Never inferred or backfilled.
	 */
	inputTokens: integer('input_tokens'),
	outputTokens: integer('output_tokens'),
	/**
	 * Cache components, which dominate agentic usage — a measured session was
	 * 99.3% cache reads. Priced at 0.1x input (read), 1.25x (5-minute write)
	 * and 2x (1-hour write), so omitting them is an order-of-magnitude error.
	 */
	cacheReadTokens: integer('cache_read_tokens'),
	cacheWrite5mTokens: integer('cache_write_5m_tokens'),
	cacheWrite1hTokens: integer('cache_write_1h_tokens'),
	/**
	 * API calls this entry covers. The total is calls x context size, and only
	 * this separates the two — a figure alone cannot say whether it was many
	 * round trips or a large context, and only one of those is worth acting on.
	 */
	apiCalls: integer('api_calls'),
	note: text('note'),
	reportedByUserId: integer('reported_by_user_id').references(() => users.id, {
		onDelete: 'set null'
	}),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_token_usage_card').on(table.cardId),
	index('idx_token_usage_subtask').on(table.subtaskId),
	index('idx_token_usage_reported_by_user_id').on(table.reportedByUserId),
	// Exactly one owner, never both and never neither. Migration 0044 wrote the
	// constraint without a name; Drizzle requires one, so the name exists only
	// here.
	check(
		'token_usage_one_owner',
		sql`(${table.cardId} IS NULL) <> (${table.subtaskId} IS NULL)`
	)
]);

export type TokenUsage = typeof tokenUsage.$inferSelect;
export type NewTokenUsage = typeof tokenUsage.$inferInsert;

// ─── Decision Records ────────────────────────────────────────────────────────
// Milestone 35, migration 0061 (card 2673). The design is
// docs/planning/card-2625-decision-records.md, section 4.3.
//
// Every reference to `users` is SET NULL with the name kept beside it, so the
// record never depends on an account. Every table under a decision CASCADEs
// from it. The six references from the record (responses, questions, events
// and rulings) to participants and options have no ON DELETE action: the
// database refuses to delete a participant or an option the record mentions.
// After a decision opens, participants are only marked removed and options
// only retired. Status, kind, role, via and source are free text checked in
// code; no CHECK constraint and no trigger, which the start-up model check
// cannot see. `decision_versions`, `decision_responses`, `decision_rulings`
// and `decision_events` are insert-only in code alone.

/** Who can be consulted or informed, with an account or without one. */
export const people = sqliteTable('people', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	fullName: text('full_name').notNull(),
	/** Stored lower-case; the code lower-cases it. */
	email: text('email').notNull().unique(),
	jobTitle: text('job_title').notNull().default(''),
	/** The person's account, if they have one. At most one person per account. */
	userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
	status: text('status').notNull().default('active'), // 'active' | 'left'
	leftAt: text('left_at'),
	createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	uniqueIndex('idx_people_user_id').on(table.userId),
	index('idx_people_created_by').on(table.createdBy)
]);

export const peopleGroups = sqliteTable('people_groups', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull().unique(),
	description: text('description').notNull().default(''),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const peopleGroupMembers = sqliteTable('people_group_members', {
	groupId: integer('group_id')
		.notNull()
		.references(() => peopleGroups.id, { onDelete: 'cascade' }),
	personId: integer('person_id')
		.notNull()
		.references(() => people.id, { onDelete: 'cascade' })
}, (table) => [
	primaryKey({ columns: [table.groupId, table.personId] }),
	index('idx_people_group_members_person_id').on(table.personId)
]);

/**
 * Every change to the people directory and its groups, one row a change, by
 * the People page or an API key (card 2681, migration 0064): what it was and
 * what it became, so that an administrator can put a change back. Insert-only
 * in code (`recordChange` in people.ts, and `switchOffUnsealedPeople` in
 * restore.ts for a person a restore marks left, card 3020), and never pruned:
 * the system log's PEOPLE line beside it is pruned with the log. `subject_id`
 * is a plain integer with no foreign key, so that a person's or a group's
 * delete leaves its rows. `before` and `after` are JSON of names, job titles,
 * descriptions, statuses and ids of groups or people; never an email address
 * or an account id.
 */
export const peopleChanges = sqliteTable('people_changes', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
	actorName: text('actor_name').notNull(),
	/** 'ui' | 'api', or 'restore' for a person an unsealed restore marked left, by DumpFire (card 3020, R13). */
	source: text('source').notNull(),
	subject: text('subject').notNull(), // 'person' | 'group'
	subjectId: integer('subject_id').notNull(),
	kind: text('kind').notNull(), // 'created' | 'updated' | 'deleted' | 'members_set'
	/** JSON, or null for a creation. */
	before: text('before'),
	/** JSON, or null for a delete. */
	after: text('after')
}, (table) => [
	index('idx_people_changes_actor_user_id').on(table.actorUserId),
	index('idx_people_changes_subject_subject_id').on(table.subject, table.subjectId)
]);

export const decisions = sqliteTable('decisions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	/** SET NULL: a decision outlives its board, and keeps its name in `boardName`. */
	boardId: integer('board_id').references(() => boards.id, { onDelete: 'set null' }),
	boardName: text('board_name').notNull(),
	title: text('title').notNull(),
	status: text('status').notNull().default('draft'),
	voteMode: text('vote_mode').notNull().default('single'), // 'single' | 'score'
	/** JSON: the content being written, before it is published. */
	workingContent: text('working_content').notNull().default('{}'),
	currentVersion: integer('current_version').notNull().default(0),
	authorUserId: integer('author_user_id').references(() => users.id, { onDelete: 'set null' }),
	authorName: text('author_name').notNull(),
	deciderUserId: integer('decider_user_id').references(() => users.id, { onDelete: 'set null' }),
	deciderName: text('decider_name'),
	closesAt: text('closes_at'),
	openedAt: text('opened_at'),
	closedAt: text('closed_at'),
	ruledAt: text('ruled_at'),
	withdrawnAt: text('withdrawn_at'),
	withdrawnReason: text('withdrawn_reason'),
	/** No UNIQUE: at most one superseding decision that is not withdrawn, in code. */
	supersedesId: integer('supersedes_id').references((): AnySQLiteColumn => decisions.id, { onDelete: 'set null' }),
	resultsReleasedAt: text('results_released_at'),
	resultsReleasedBy: integer('results_released_by').references(() => users.id, { onDelete: 'set null' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_decisions_board_id').on(table.boardId),
	index('idx_decisions_author_user_id').on(table.authorUserId),
	index('idx_decisions_decider_user_id').on(table.deciderUserId),
	index('idx_decisions_supersedes_id').on(table.supersedesId),
	index('idx_decisions_results_released_by').on(table.resultsReleasedBy)
]);

export const decisionOptions = sqliteTable('decision_options', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	label: text('label').notNull(), // 'A', 'B', ...
	position: real('position').notNull(),
	addedInVersion: integer('added_in_version'),
	retiredInVersion: integer('retired_in_version')
}, (table) => [
	index('idx_decision_options_decision_id').on(table.decisionId)
]);

export const decisionVersions = sqliteTable('decision_versions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	number: integer('number').notNull(),
	/** JSON snapshot of what was published, the options' text included. */
	content: text('content').notNull(),
	changeNote: text('change_note'),
	asksAgain: integer('asks_again', { mode: 'boolean' }).notNull(),
	publishedBy: integer('published_by').references(() => users.id, { onDelete: 'set null' }),
	publishedByName: text('published_by_name').notNull(),
	publishedAt: text('published_at').notNull()
}, (table) => [
	uniqueIndex('idx_decision_versions_decision_id_number').on(table.decisionId, table.number),
	index('idx_decision_versions_published_by').on(table.publishedBy)
]);

export const decisionParticipants = sqliteTable('decision_participants', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
	role: text('role').notNull(), // 'consulted' | 'informed'
	// Snapshots taken at inclusion; directory edits do not reach them.
	name: text('name').notNull(),
	email: text('email').notNull(),
	jobTitle: text('job_title').notNull(),
	/** JSON: the names of the person's groups. */
	groups: text('groups').notNull(),
	includedAt: text('included_at').notNull(),
	includedBy: integer('included_by').references(() => users.id, { onDelete: 'set null' }),
	includedByName: text('included_by_name'),
	removedAt: text('removed_at'),
	removedBy: integer('removed_by').references(() => users.id, { onDelete: 'set null' }),
	/**
	 * A snapshot of `people.user_id` at inclusion: set once, and never made to
	 * follow the person's account. Its key only empties it when that account
	 * is deleted.
	 */
	userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
	linkTokenHash: text('link_token_hash'),
	linkIssuedAt: text('link_issued_at')
}, (table) => [
	index('idx_decision_participants_decision_id').on(table.decisionId),
	index('idx_decision_participants_person_id').on(table.personId),
	index('idx_decision_participants_included_by').on(table.includedBy),
	index('idx_decision_participants_removed_by').on(table.removedBy),
	index('idx_decision_participants_user_id').on(table.userId),
	uniqueIndex('idx_decision_participants_link_token_hash').on(table.linkTokenHash)
]);

export const decisionResponses = sqliteTable('decision_responses', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	participantId: integer('participant_id')
		.notNull()
		.references(() => decisionParticipants.id),
	versionNumber: integer('version_number').notNull(),
	round: integer('round').notNull(),
	kind: text('kind').notNull(), // 'vote' | 'abstain' | 'no_concerns' | 'concern'
	optionId: integer('option_id').references(() => decisionOptions.id),
	scores: text('scores'),
	comment: text('comment'),
	optionComments: text('option_comments'),
	replacesId: integer('replaces_id').references((): AnySQLiteColumn => decisionResponses.id, { onDelete: 'set null' }),
	via: text('via').notNull(), // 'session' | 'link'
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_decision_responses_decision_id').on(table.decisionId),
	index('idx_decision_responses_participant_id').on(table.participantId),
	index('idx_decision_responses_option_id').on(table.optionId),
	index('idx_decision_responses_replaces_id').on(table.replacesId)
]);

export const decisionQuestions = sqliteTable('decision_questions', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	participantId: integer('participant_id').references(() => decisionParticipants.id),
	askerName: text('asker_name').notNull(),
	question: text('question').notNull(),
	askedInVersion: integer('asked_in_version').notNull(),
	via: text('via').notNull(),
	askedAt: text('asked_at').notNull(),
	answer: text('answer'),
	answeredBy: integer('answered_by').references(() => users.id, { onDelete: 'set null' }),
	answeredByName: text('answered_by_name'),
	answeredAt: text('answered_at'),
	answerAgentDrafted: integer('answer_agent_drafted', { mode: 'boolean' }).notNull().default(false),
	answerReviewedBy: integer('answer_reviewed_by').references(() => users.id, { onDelete: 'set null' }),
	answerReviewedAt: text('answer_reviewed_at')
}, (table) => [
	index('idx_decision_questions_decision_id').on(table.decisionId),
	index('idx_decision_questions_participant_id').on(table.participantId),
	index('idx_decision_questions_answered_by').on(table.answeredBy),
	index('idx_decision_questions_answer_reviewed_by').on(table.answerReviewedBy)
]);

export const decisionRulings = sqliteTable('decision_rulings', {
	decisionId: integer('decision_id')
		.primaryKey()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	/** NULL: none of the options. */
	optionId: integer('option_id').references(() => decisionOptions.id),
	reason: text('reason').notNull(),
	conditions: text('conditions'),
	/** The chosen option was not the most chosen. */
	againstResponses: integer('against_responses', { mode: 'boolean' }).notNull(),
	early: integer('early', { mode: 'boolean' }).notNull(),
	versionNumber: integer('version_number').notNull(),
	ruledBy: integer('ruled_by').references(() => users.id, { onDelete: 'set null' }),
	ruledByName: text('ruled_by_name').notNull(),
	ruledAt: text('ruled_at').notNull()
}, (table) => [
	index('idx_decision_rulings_option_id').on(table.optionId),
	index('idx_decision_rulings_ruled_by').on(table.ruledBy)
]);

export const decisionEvents = sqliteTable('decision_events', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	participantId: integer('participant_id').references(() => decisionParticipants.id),
	kind: text('kind').notNull(),
	versionNumber: integer('version_number'),
	/** JSON. */
	detail: text('detail'),
	actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
	actorName: text('actor_name').notNull(),
	source: text('source').notNull(), // 'ui' | 'api' | 'link' | 'system'
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_decision_events_decision_id_created_at').on(table.decisionId, table.createdAt),
	index('idx_decision_events_participant_id').on(table.participantId),
	index('idx_decision_events_actor_user_id').on(table.actorUserId),
	// Card 2685 (migration 0063): one closing-date reminder per participant per
	// round, held by the database whatever the code does. Partial: only
	// `reminded` rows are covered, so every other kind may repeat a participant
	// and version as before.
	uniqueIndex('idx_decision_events_participant_id_version_number_reminded')
		.on(table.participantId, table.versionNumber)
		.where(sql`kind = 'reminded'`)
]);

export const decisionCardLinks = sqliteTable('decision_card_links', {
	decisionId: integer('decision_id')
		.notNull()
		.references(() => decisions.id, { onDelete: 'cascade' }),
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	relation: text('relation').notNull().default('relates'),
	createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	primaryKey({ columns: [table.decisionId, table.cardId] }),
	index('idx_decision_card_links_card_id').on(table.cardId),
	index('idx_decision_card_links_created_by').on(table.createdBy)
]);

export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type PeopleGroup = typeof peopleGroups.$inferSelect;
export type NewPeopleGroup = typeof peopleGroups.$inferInsert;
export type PeopleGroupMember = typeof peopleGroupMembers.$inferSelect;
export type PeopleChange = typeof peopleChanges.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;
export type DecisionOption = typeof decisionOptions.$inferSelect;
export type NewDecisionOption = typeof decisionOptions.$inferInsert;
export type DecisionVersion = typeof decisionVersions.$inferSelect;
export type NewDecisionVersion = typeof decisionVersions.$inferInsert;
export type DecisionParticipant = typeof decisionParticipants.$inferSelect;
export type NewDecisionParticipant = typeof decisionParticipants.$inferInsert;
export type DecisionResponse = typeof decisionResponses.$inferSelect;
export type NewDecisionResponse = typeof decisionResponses.$inferInsert;
export type DecisionQuestion = typeof decisionQuestions.$inferSelect;
export type NewDecisionQuestion = typeof decisionQuestions.$inferInsert;
export type DecisionRuling = typeof decisionRulings.$inferSelect;
export type NewDecisionRuling = typeof decisionRulings.$inferInsert;
export type DecisionEvent = typeof decisionEvents.$inferSelect;
export type NewDecisionEvent = typeof decisionEvents.$inferInsert;
export type DecisionCardLink = typeof decisionCardLinks.$inferSelect;
export type NewDecisionCardLink = typeof decisionCardLinks.$inferInsert;

// ─── Insert Types ────────────────────────────────────────────────────────────

export type NewBoard = typeof boards.$inferInsert;
export type NewColumn = typeof columns.$inferInsert;
export type NewCard = typeof cards.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewSubtask = typeof subtasks.$inferInsert;
export type NewActivityLog = typeof activityLog.$inferInsert;
export type NewLabel = typeof labels.$inferInsert;
