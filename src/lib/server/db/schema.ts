import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const boards = sqliteTable('boards', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	name: text('name').notNull(),
	emoji: text('emoji').default('📋'),
	createdAt: text('created_at')
		.notNull()
		.default(sql`(datetime('now'))`),
	updatedAt: text('updated_at')
		.notNull()
		.default(sql`(datetime('now'))`)
});

export const columns = sqliteTable('columns', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
	title: text('title').notNull(),
	position: real('position').notNull().default(0),
	color: text('color').notNull().default('#6366f1')
});

export const categories = sqliteTable('categories', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	boardId: integer('board_id')
		.notNull()
		.references(() => boards.id, { onDelete: 'cascade' }),
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

export type Board = typeof boards.$inferSelect;
export type Column = typeof columns.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Subtask = typeof subtasks.$inferSelect;
export type UserXp = typeof userXp.$inferSelect;
export type ActivityLog = typeof activityLog.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type NewBoard = typeof boards.$inferInsert;
export type NewColumn = typeof columns.$inferInsert;
export type NewCard = typeof cards.$inferInsert;
export type NewCategory = typeof categories.$inferInsert;
export type NewSubtask = typeof subtasks.$inferInsert;
export type NewActivityLog = typeof activityLog.$inferInsert;
export type NewLabel = typeof labels.$inferInsert;
