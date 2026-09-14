/**
 * types.ts — Centralised type definitions for the DumpFire Kanban application.
 *
 * All domain types are defined here once and imported by components, utilities,
 * and API modules. This eliminates the duplicate inline type declarations that
 * previously existed across multiple Svelte files.
 */

// ─── Domain Entities ─────────────────────────────────────────────────────────

/** A subtask belonging to a card. Tracks completion independently. */
export type SubtaskType = {
	id: number;
	cardId: number;
	title: string;
	description: string | null;
	priority: string;
	colorTag: string | null;
	dueDate: string | null;
	completed: boolean;
	position: number;
};

/** A category used to group/tag cards within a board. */
export type CategoryType = {
	id: number;
	boardId: number;
	name: string;
	color: string;
};

/** Summary info for a sub-board linked to a card. Includes progress counts. */
export type SubBoardType = {
	id: number;
	name: string;
	emoji: string;
	done: number;
	total: number;
};

/** A Kanban card with all its nested data (subtasks, labels, sub-boards, assignees). */
export type CardType = {
	id: number;
	columnId: number;
	categoryId: number | null;
	title: string;
	description: string | null;
	position: number;
	priority: string;
	colorTag: string | null;
	dueDate: string | null;
	createdAt: string;
	updatedAt: string;
	subtasks: SubtaskType[];
	labelIds: number[];
	pinned: boolean;
	onHoldNote: string;
	businessValue: string | null;
	subBoards: SubBoardType[];
	assignees: { id: number; username: string; emoji: string }[];
	archivedAt: string | null;
	coverUrl: string | null;
	/** The goal this card belongs to, if any. A card is in at most one milestone. */
	milestoneId: number | null;
	/** Who raised the card. Null for cards created before this was recorded. */
	createdBy?: number | null;
	// ── Reporting fields ────────────────────────────────────────────────────
	// What a management report needs and the technical card text cannot give it.
	// All null when not recorded, which reports honestly as "not recorded".
	// Vocabularies live in `$lib/reporting`.
	/** Plain English, ~12 words. Quoted verbatim into report appendices. */
	summary?: string | null;
	/** new capability | customer issue | security & compliance | maintenance */
	theme?: string | null;
	/** none | internal | live customers — optionally naming them after a colon. */
	customerImpact?: string | null;
	/** delivered | not needed | superseded | parked */
	closeReason?: string | null;
	/** built | on UAT | live */
	releaseState?: string | null;
	requestOrigin?: { requesterName: string; requesterEmail?: string; requestTitle: string } | null;
};

/** One end of a card dependency, as the board and card modal need it. */
export type DependencyRefType = {
	cardId: number;
	title: string;
	boardId: number;
	boardName: string;
	columnName: string;
	priority: string;
	/** True when this end sits in a Complete column, so it no longer blocks. */
	resolved: boolean;
};

/** A milestone as the board and card modal need it (no derived planning data). */
export type MilestoneType = {
	id: number;
	boardId: number | null;
	name: string;
	description: string;
	targetDate: string | null;
	status: string;
};

/** A label that can be attached to cards for tagging/filtering. */
export type LabelType = {
	id: number;
	boardId: number;
	name: string;
	color: string;
};

/** An entry in the activity log tracking board changes. */
export type ActivityType = {
	id: number;
	boardId: number;
	cardId: number | null;
	action: string;
	detail: string;
	userName: string;
	userEmoji: string;
	createdAt: string;
};

/** A Kanban column containing an ordered list of cards. */
export type ColumnType = {
	id: number;
	boardId: number;
	title: string;
	position: number;
	color: string;
	showAddCard: boolean;
	wipLimit: number;
	cards: CardType[];
};

// ─── UI State Types ──────────────────────────────────────────────────────────

/** Available sort options for columns. 'none' means manual/default order. */
export type SortOption = 'none' | 'date-asc' | 'date-desc' | 'priority' | 'category' | 'assignee';

/** A user's XP entry for the leaderboard display. */
export type XpEntry = {
	name: string;
	xp: number;
	emoji: string;
};

/** Confirm modal state used for destructive actions. */
export type ConfirmState = {
	show: boolean;
	title: string;
	message: string;
	confirmText: string;
	onConfirm: () => void;
};

/** State for the "blocked by subtasks/sub-board" modal. */
export type BlockedState = {
	show: boolean;
	card: CardType | null;
	incomplete: number;
	reason: 'subtasks' | 'subboard';
};

/** State for the "On Hold" note prompt modal. */
export type OnHoldState = {
	show: boolean;
	cardId: number;
	cardTitle: string;
	note: string;
	pendingUpdates: { id: number; columnId: number; position: number }[];
	pendingColumnId: number;
};

/** Context menu state for right-click card actions. */
export type ContextMenuState = {
	show: boolean;
	x: number;
	y: number;
	card: CardType | null;
	columnId: number;
};
