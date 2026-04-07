import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Users & Auth ────────────────────────────────────────────────────────────

export const users = sqliteTable('users', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	username: text('username').notNull().unique(),
	email: text('email').notNull().unique(),
	passwordHash: text('password_hash').notNull(),
	emoji: text('emoji').default('👤'),
	role: text('role').notNull().default('user'), // 'superadmin' | 'admin' | 'user'
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
});

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
	primaryKey({ columns: [table.teamId, table.userId] })
]);

// ─── Boards ──────────────────────────────────────────────────────────────────

export const boards = sqliteTable('boards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	emoji: text('emoji').default('📋'),
	parentCardId: integer('parent_card_id'),
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
});

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
	primaryKey({ columns: [table.boardId, table.userId] })
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
	primaryKey({ columns: [table.boardId, table.teamId] })
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
	showAddCard: integer('show_add_card', { mode: 'boolean' }).notNull().default(false)
});

export const categories = sqliteTable('categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.references(() => boards.id, { onDelete: 'set null' }),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1')
});

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
	completedAt: text('completed_at'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

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
});

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
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const labels = sqliteTable('labels', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	color: text('color').notNull().default('#6366f1')
});

export const cardLabels = sqliteTable('card_labels', {
	cardId: integer('card_id')
		.notNull()
		.references(() => cards.id, { onDelete: 'cascade' }),
	labelId: integer('label_id')
		.notNull()
		.references(() => labels.id, { onDelete: 'cascade' })
});

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
	primaryKey({ columns: [table.cardId, table.userId] })
]);

// ─── Invite Tokens ───────────────────────────────────────────────────────────

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
});

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
});

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
	status: text('status').notNull().default('pending'), // 'pending' | 'accepted' | 'rejected'
	businessValue: text('business_value').default(''),
	resolvedBy: integer('resolved_by').references(() => users.id, { onDelete: 'set null' }),
	resolvedCardId: integer('resolved_card_id').references(() => cards.id, { onDelete: 'set null' }),
	rejectReason: text('reject_reason'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	resolvedAt: text('resolved_at')
});

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
});

export type RequestMessage = typeof requestMessages.$inferSelect;

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

// ─── Insert Types ────────────────────────────────────────────────────────────

export type NewBoard = typeof boards.$inferInsert;
export type NewColumn = typeof columns.$inferInsert;
export type NewCard = typeof cards.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewSubtask = typeof subtasks.$inferInsert;
export type NewActivityLog = typeof activityLog.$inferInsert;
export type NewLabel = typeof labels.$inferInsert;
