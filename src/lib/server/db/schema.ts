import {
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

// ─── Users & Auth ────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	emoji: text('emoji').default('👤'),
	role: text('role').notNull().default('user'), // 'superadmin' | 'admin' | 'user'
	notificationPrefs: text('notification_prefs').default('{}'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const sessions = sqliteTable('sessions', {
	id: text('id').primaryKey(), // UUID token
	userId: integer('user_id')
		.notNull()
		.references(() => users.id, { onDelete: 'cascade' }),
	expiresAt: text('expires_at').notNull(),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
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
	createdBy: integer('created_by')
		.references(() => users.id, { onDelete: 'set null' }),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_boards_parent_card_id').on(table.parentCardId),
	index('idx_boards_created_by').on(table.createdBy)
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
	wipLimit: integer('wip_limit').notNull().default(0)
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
	index('idx_cards_created_by').on(table.createdBy)
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
	 * Where the action came from: 'ui' or 'api'.
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
	url: text('url').notNull(),
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
	setBy: integer('set_by').references(() => users.id, { onDelete: 'set null' })
}, (table) => [
	index('idx_webhooks_board_id').on(table.boardId),
	index('idx_webhooks_set_by').on(table.setBy)
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

export const settings = sqliteTable('settings', {
	key: text('key').primaryKey(),
	value: text('value').notNull()
});

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
	token: text('token').primaryKey(),
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
	 * The secret in the requester's link. Whoever holds it can read the thread
	 * and reply as the requester, so it never leaves the server except inside
	 * that link — see `publicRequest` in request-tokens.ts.
	 */
	accessToken: text('access_token'),
	businessValue: text('business_value').default(''),
	resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
	resolvedCardId: integer('resolved_card_id').references(() => cards.id, { onDelete: 'set null' }),
	desiredBoardId: integer('desired_board_id').references(() => boards.id, { onDelete: 'set null' }),
	rejectReason: text('reject_reason'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	resolvedAt: text('resolved_at')
}, (table) => [
	// No two requests share a link. Requests with no token yet are not compared.
	uniqueIndex('task_requests_access_token_idx').on(table.accessToken),
	index('idx_task_requests_requester_user_id').on(table.requesterUserId),
	index('idx_task_requests_resolved_by').on(table.resolvedBy),
	index('idx_task_requests_resolved_card_id').on(table.resolvedCardId),
	index('idx_task_requests_desired_board_id').on(table.desiredBoardId)
]);

export type TaskRequest = typeof taskRequests.$inferSelect;
export type NewTaskRequest = typeof taskRequests.$inferInsert;

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
		.default(sql`(datetime('now'))`)
}, (table) => [
	index('idx_api_keys_user_id').on(table.userId)
]);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

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

// ─── Insert Types ────────────────────────────────────────────────────────────

export type NewBoard = typeof boards.$inferInsert;
export type NewColumn = typeof columns.$inferInsert;
export type NewCard = typeof cards.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewSubtask = typeof subtasks.$inferInsert;
export type NewActivityLog = typeof activityLog.$inferInsert;
export type NewLabel = typeof labels.$inferInsert;
