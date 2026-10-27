/**
 * Builders for the rows a test needs, and a reset between tests.
 *
 * Every builder inserts through the real schema, so a column the application
 * requires is required here too. Defaults are deliberately boring: a test
 * states only what it is about.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { attachmentPath, cardDir, uploadsDir } from '$lib/server/uploads';
import { isUpstreamColumnId } from '$lib/server/upstream';
import {
	apiKeys,
	boardMembers,
	boards,
	boardTeams,
	cardAssignees,
	cardAttachments,
	cardComments,
	cards,
	columns,
	labels,
	milestones,
	settings,
	subtasks,
	teamMembers,
	teams,
	users,
	webhooks,
	workDependencies,
	type Board,
	type Card,
	type CardAttachment,
	type CardComment,
	type Column,
	type Label,
	type Milestone,
	type Subtask,
	type Team,
	type WorkDependency
} from '$lib/server/db/schema';
import { createSession, generateApiKey, type SessionUser } from '$lib/server/auth';
import { resetMailStatus } from '$lib/server/email';
import { forgetConnects } from '$lib/server/gdrive-connect';
import { forgetDeliveries, forgetWebhookWarnings } from '$lib/server/webhooks';

let seq = 0;
const next = () => ++seq;

/**
 * The folder this test file's attachment files are in, trash included.
 *
 * It is the application's own uploads folder, which `tests/setup.ts` pointed
 * at a new folder under the operating system's temp folder. Refused here if
 * it is anywhere else: `resetUploads` removes everything in it.
 */
export function testUploadsDir(): string {
	const dir = uploadsDir();
	const fromTemp = relative(tmpdir(), dir);
	if (fromTemp === '' || fromTemp === '..' || fromTemp.startsWith(`..${sep}`) || isAbsolute(fromTemp)) {
		throw new Error(`The tests' uploads folder must be under ${tmpdir()}, and it is "${dir}"`);
	}
	return dir;
}

/** Remove every attachment file the tests have made, in card folders and in the trash. */
export function resetUploads(): void {
	rmSync(testUploadsDir(), { recursive: true, force: true });
}

/**
 * Empty every table, keeping the schema and the migration record, and remove
 * every attachment file. What mail has done since the server started, which
 * `email.ts` keeps in memory, is started again too.
 *
 * Call from `beforeEach`. Foreign keys are switched off for the wipe so table
 * order does not matter, and back on before the test runs — the application
 * relies on them and so must the tests.
 */
export function resetDb(): void {
	const tables = (
		sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'"
			)
			.all() as { name: string }[]
	).map((t) => t.name);

	sqlite.pragma('foreign_keys = OFF');
	try {
		sqlite.transaction(() => {
			for (const table of tables) sqlite.prepare(`DELETE FROM "${table}"`).run();
			sqlite.prepare('DELETE FROM sqlite_sequence').run();
		})();
	} finally {
		sqlite.pragma('foreign_keys = ON');
	}
	seq = 0;
	resetUploads();
	// What mail has done is kept in memory since the server started (card
	// 2196): each test starts as a server does.
	resetMailStatus();
	// So is which webhook lines were written in the last hour (the review of
	// the webhook group, O2): a test's webhook 1 is not the last test's.
	forgetWebhookWarnings();
	// And each webhook's last delivery result (card 2178).
	forgetDeliveries();
	// And the Google Drive Connects under way, which a restart ends (card 2251).
	forgetConnects();
}

export type Role = 'user' | 'admin' | 'superadmin';

/** A user row, returned in the shape `locals.user` carries. */
export function makeUser(opts: { role?: Role; username?: string } = {}): SessionUser {
	const n = next();
	const username = opts.username ?? `user${n}`;
	const row = db
		.insert(users)
		.values({
			username,
			email: `${username}@example.test`,
			// Never verified in these tests; a real bcrypt hash costs ~250ms each.
			passwordHash: 'not-a-real-hash',
			role: opts.role ?? 'user'
		})
		.returning()
		.get();
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		emoji: row.emoji || '👤',
		role: row.role
	};
}

/**
 * An API key for a user, as the caller holds it: send it as
 * `Authorization: Bearer <key>`. Made by the application's own generator and
 * stored as the application stores one, so that the gate accepts it.
 *
 * Only a request sent through the gate (`gate()` in ./gate.ts) needs one:
 * `api()` hands a handler its caller directly. The key is random, as a real
 * one is, so a fixture that makes one is not the same rows twice.
 */
export function makeApiKey(user: SessionUser, name?: string): string {
	const key = generateApiKey();
	db.insert(apiKeys)
		.values({ userId: user.id, name: name ?? `Key ${next()}`, keyHash: key.keyHash, keyPrefix: key.keyPrefix })
		.run();
	return key.plaintextKey;
}

/**
 * A session for a user, made as a login makes one. Returns the token the
 * session cookie carries: send it as `Cookie: dumpfire_session=<token>`, the
 * name being `SESSION_COOKIE_NAME`. Random, as `makeApiKey` is, and needed
 * only by a request sent through the gate.
 */
export function makeSession(user: SessionUser): string {
	return createSession(user.id);
}

export type BoardFixture = {
	board: Board;
	/** Columns by title, e.g. `cols['To Do']`. */
	cols: Record<string, Column>;
};

const DEFAULT_COLUMNS = ['To Do', 'On Hold', 'In Progress', 'Complete'];

/** A board with the standard four columns unless told otherwise. */
export function makeBoard(
	opts: {
		owner?: SessionUser;
		name?: string;
		isPublic?: boolean;
		parentCardId?: number;
		columns?: string[];
		/**
		 * Give the board the Options column every delivery board has (card
		 * 2527), as `cols['Options']`: at -1, left of the others, titled Options,
		 * with the role. Without it the board has none, as a board put in by a
		 * direct insert has until the next start, which a file that runs the
		 * backfills would see given one part-way through.
		 */
		options?: boolean;
	} = {}
): BoardFixture {
	const board = db
		.insert(boards)
		.values({
			name: opts.name ?? `Board ${next()}`,
			isPublic: opts.isPublic ?? false,
			parentCardId: opts.parentCardId,
			createdBy: opts.owner?.id
		})
		.returning()
		.get();

	const cols: Record<string, Column> = {};
	if (opts.options) {
		cols['Options'] = db
			.insert(columns)
			.values({ boardId: board.id, title: 'Options', position: -1, color: '#8b5cf6', role: 'options' })
			.returning()
			.get();
	}
	(opts.columns ?? DEFAULT_COLUMNS).forEach((title, i) => {
		cols[title] = db
			.insert(columns)
			.values({ boardId: board.id, title, position: i })
			.returning()
			.get();
	});
	return { board, cols };
}

/**
 * A card in `column`. In a committed column it is committed as every write
 * commits one created there (milestone 22): `committedAt` is its `createdAt`
 * and `committedBy` its `createdBy`, so a fixture keeps the rule the backfill
 * would otherwise repair. In an Options column or on an ideas board it is an
 * option, with neither. A `committedAt` given, null included, is kept as given.
 */
export function makeCard(
	column: Column,
	opts: Partial<typeof cards.$inferInsert> = {}
): Card {
	const card = db
		.insert(cards)
		.values({ title: `Card ${next()}`, ...opts, columnId: column.id })
		.returning()
		.get();
	if ('committedAt' in opts || isUpstreamColumnId(column.id)) return card;
	return db
		.update(cards)
		.set({ committedAt: card.createdAt, committedBy: opts.committedBy ?? card.createdBy })
		.where(eq(cards.id, card.id))
		.returning()
		.get();
}

export function makeSubtask(
	card: Card,
	opts: Partial<typeof subtasks.$inferInsert> = {}
): Subtask {
	return db
		.insert(subtasks)
		.values({ title: `Subtask ${next()}`, ...opts, cardId: card.id })
		.returning()
		.get();
}

export function makeLabel(board: Board, name?: string): Label {
	return db
		.insert(labels)
		.values({ boardId: board.id, name: name ?? `Label ${next()}` })
		.returning()
		.get();
}

/** Give a user direct access to a board. */
export function addBoardMember(
	board: Board,
	user: SessionUser,
	role: 'owner' | 'editor' | 'viewer'
): void {
	db.insert(boardMembers).values({ boardId: board.id, userId: user.id, role }).run();
}

export function makeTeam(members: SessionUser[] = [], name?: string): Team {
	const team = db
		.insert(teams)
		.values({ name: name ?? `Team ${next()}` })
		.returning()
		.get();
	for (const m of members) {
		db.insert(teamMembers).values({ teamId: team.id, userId: m.id }).run();
	}
	return team;
}

/** Give every member of a team access to a board. */
export function shareBoardWithTeam(board: Board, team: Team, role: 'editor' | 'viewer'): void {
	db.insert(boardTeams).values({ boardId: board.id, teamId: team.id, role }).run();
}

/** One end of a dependency: a card or subtask row, or its kind and id. */
export type WorkEnd = Card | Subtask | { kind: 'card' | 'subtask'; id: number };

function endOf(work: WorkEnd): { kind: 'card' | 'subtask'; id: number } {
	if ('kind' in work) return work;
	// A subtask row has the card it belongs to; a card row has a column.
	return { kind: 'columnId' in work ? 'card' : 'subtask', id: work.id };
}

/**
 * Record that `blocked` waits on `blocker`. Either end may be a card or a
 * subtask. The ends are named so that the direction cannot be got backwards
 * by position.
 */
export function makeDependency(link: {
	blocked: WorkEnd;
	blocker: WorkEnd;
	createdBy?: SessionUser;
}): WorkDependency {
	const blocked = endOf(link.blocked);
	const blocker = endOf(link.blocker);
	return db
		.insert(workDependencies)
		.values({
			blockedType: blocked.kind,
			blockedId: blocked.id,
			blockerType: blocker.kind,
			blockerId: blocker.id,
			createdByUserId: link.createdBy?.id
		})
		.returning()
		.get();
}

/**
 * A milestone, with `cards` attached to it. `board` makes it that board's
 * own; without one it is a cross-board milestone.
 */
export function makeMilestone(
	opts: { board?: Board; name?: string; createdBy?: SessionUser; cards?: Card[] } = {}
): Milestone {
	const milestone = db
		.insert(milestones)
		.values({
			name: opts.name ?? `Milestone ${next()}`,
			boardId: opts.board?.id,
			createdBy: opts.createdBy?.id
		})
		.returning()
		.get();
	for (const card of opts.cards ?? []) {
		db.update(cards).set({ milestoneId: milestone.id }).where(eq(cards.id, card.id)).run();
	}
	return milestone;
}

/** A comment on a card. */
export function makeComment(card: Card, author: SessionUser, content?: string): CardComment {
	return db
		.insert(cardComments)
		.values({ cardId: card.id, userId: author.id, content: content ?? `Comment ${next()}` })
		.returning()
		.get();
}

/**
 * An attachment on a card: the row, and a real file where the row says it is,
 * under the tests' uploads folder.
 *
 * The stored file name is numbered, not random as an upload's is, so that a
 * fixture built twice makes the same rows. `file: false` makes the row alone,
 * which is what a working copy restored from a backup has.
 */
export function makeAttachment(
	card: Card,
	opts: {
		name?: string;
		mimeType?: string;
		content?: string | Uint8Array;
		uploadedBy?: SessionUser;
		file?: boolean;
	} = {}
): CardAttachment {
	const name = opts.name ?? 'notes.txt';
	const content = opts.content ?? `The contents of ${name}`;
	const filename = `${next()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

	if (opts.file !== false) {
		testUploadsDir();
		mkdirSync(cardDir(card.id), { recursive: true });
		writeFileSync(attachmentPath(card.id, filename), content);
	}
	return db
		.insert(cardAttachments)
		.values({
			cardId: card.id,
			filename,
			originalName: name,
			mimeType: opts.mimeType ?? 'text/plain',
			sizeBytes: Buffer.byteLength(content),
			uploadedBy: opts.uploadedBy?.id
		})
		.returning()
		.get();
}

export type SubBoardFixture = BoardFixture & {
	/** The cards made on it, in the order of `cards` below. */
	cards: Card[];
};

/**
 * A sub-board opened from `parent`, with cards on it.
 *
 * `cards` says how many to make in which column, by column title: the default
 * is one card in To Do, which is enough to stop `parent` being completed. Call
 * it again with one of the cards returned to go a level deeper.
 */
export function makeSubBoard(
	parent: Card,
	opts: { owner?: SessionUser; name?: string; columns?: string[]; cards?: Record<string, number> } = {}
): SubBoardFixture {
	const fixture = makeBoard({
		owner: opts.owner,
		name: opts.name ?? `Sub-board of card ${parent.id}`,
		columns: opts.columns,
		parentCardId: parent.id
	});
	const made: Card[] = [];
	for (const [title, count] of Object.entries(opts.cards ?? { 'To Do': 1 })) {
		const column = fixture.cols[title];
		if (!column) throw new Error(`makeSubBoard: the sub-board has no "${title}" column`);
		for (let i = 0; i < count; i++) made.push(makeCard(column, { position: i }));
	}
	return { ...fixture, cards: made };
}

/** Assign a user to a card. They are who a "card moved" mail goes to. */
export function assignCard(card: Card, user: SessionUser): void {
	db.insert(cardAssignees).values({ cardId: card.id, userId: user.id }).run();
}

/**
 * A webhook on a board. With no `events` it receives every event. Use it with
 * `effects()`, which records the delivery and sends nothing. With no `setBy`
 * its setter is the board's owner, so it is sent (card 2325: a webhook whose
 * setter cannot open the board is held). `setBy: null` gives it no recorded
 * setter, as a webhook made before migration 0056, which is held too; so is
 * one on a board made with no owner, unless a `setBy` is given.
 */
export function makeWebhook(
	board: Board,
	opts: { url?: string; events?: string[]; secret?: string; active?: boolean; setBy?: SessionUser | null } = {}
): typeof webhooks.$inferSelect {
	return db
		.insert(webhooks)
		.values({
			boardId: board.id,
			url: opts.url ?? `https://hooks.example.test/${next()}`,
			events: JSON.stringify(opts.events ?? []),
			secret: opts.secret ?? '',
			active: opts.active ?? true,
			setBy: opts.setBy === undefined ? board.createdBy : opts.setBy === null ? null : opts.setBy.id
		})
		.returning()
		.get();
}

/**
 * Mail settings, so that the application tries to send mail. Without them
 * every notification returns before it looks for anyone to tell. Use it with
 * `effects()`, which records the mail and sends nothing.
 */
export function makeSmtp(): void {
	db.insert(settings)
		.values([
			{ key: 'smtp_host', value: 'smtp.example.test' },
			{ key: 'smtp_from_address', value: 'dumpfire@example.test' }
		])
		.run();
}
