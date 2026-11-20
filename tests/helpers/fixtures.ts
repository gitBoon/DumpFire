/**
 * Builders for the rows a test needs, and a reset between tests.
 *
 * Every builder inserts through the real schema, so a column the application
 * requires is required here too. Defaults are deliberately boring: a test
 * states only what it is about.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, vi } from 'vitest';
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
	decisionCardLinks,
	decisionOptions,
	decisionParticipants,
	decisionQuestions,
	decisionResponses,
	decisionRulings,
	decisionVersions,
	decisions,
	labels,
	mfaFactors,
	milestones,
	people,
	sessions,
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
	type Decision,
	type DecisionCardLink,
	type DecisionOption,
	type DecisionParticipant,
	type DecisionQuestion,
	type DecisionResponse,
	type DecisionRuling,
	type DecisionVersion,
	type Label,
	type Milestone,
	type NewDecision,
	type Person,
	type Subtask,
	type Team,
	type WorkDependency
} from '$lib/server/db/schema';
import {
	SESSION_COOKIE_NAME,
	createSession,
	forgetChecksInFlight,
	generateApiKey,
	whilePasswordHolds,
	type Credential,
	type SessionUser
} from '$lib/server/auth';
import { forgetUnreadablePrefsWarnings } from '$lib/server/notifications';
import { ensureFormSecret } from '$lib/server/request-tokens';
import { resetKnownBrowserSecretCache } from '$lib/server/known-browsers';
import { sealValue, webhookUrlAad } from '$lib/server/stored-secrets';
import { currentMfaKey } from '$lib/server/mfa-key';
import { receiverOf } from '$lib/server/webhook-address';
import { CONFIRMATION_HEADER, STEP_UP_FIELD, forgetImportConfirmations, issueImportConfirmation } from '$lib/server/step-up';
import { STEP_UP_CODE_FIELD } from '$lib/step-up-words';
import { addTotpFactor, factorSecret } from '$lib/server/mfa-store';
import { forgetPendingAuthenticators } from '$lib/server/pending-authenticators';
import { hotp, newTotpSecret, stepAt } from '$lib/server/totp';
import { appendEvent, SYSTEM_ACTOR } from '$lib/server/decision-record';
import { resetMailStatus } from '$lib/server/email';
import { forgetConnects } from '$lib/server/gdrive-connect';
import { forgetDeliveries, forgetWebhookWarnings } from '$lib/server/webhooks';
import { stamp } from '$lib/timestamps';

let seq = 0;
const next = () => ++seq;
/**
 * The fixture accounts of this test so far, apart from `seq` (card 2997's code review, FP9): the pool index of
 * `makeUser`'s and `newFixtureHash`'s hash is the n-th fixture account of the test, whatever else the test built first.
 */
let fixtureAccounts = 0;

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
	fixtureAccounts = 0;
	fixtureHashes.clear();
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
	// And the import confirmations not yet taken, and the password checks
	// under way, which a restart ends too (card 2701).
	forgetImportConfirmations();
	forgetChecksInFlight();
	// And the authenticators being added on the Account page, held in memory
	// as the confirmations are (card 2772, D1).
	forgetPendingAuthenticators();
	// And which accounts' unreadable notification preferences were warned of (card 2724).
	forgetUnreadablePrefsWarnings();
	// And the form signing key, which a start makes, so that no check made by
	// a test is the first to need it: none makes it now (card 2750).
	ensureFormSecret();
	// And the remembered-browser key held in memory, which the wipe deleted
	// (card 2943's fix pass, C11): each test starts as a server does.
	resetKnownBrowserSecretCache();
}

export type Role = 'user' | 'admin' | 'superadmin';

/**
 * Every fixture user's password (card 2701, decision 14): the actions that
 * ask for it again are checked against a real hash, so that a test of one
 * proves the password, and a wrong one is refused.
 */
export const FIXTURE_PASSWORD = 'the fixture password';

/**
 * The real bcryptjs, whatever a test file mocks it as: making a fixture's hash
 * is no hash the application made, and must not be counted as one.
 */
const realBcrypt = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');

/**
 * Distinct hashes of each password a test asks for, each made once with the
 * real bcryptjs at bcrypt's lowest cost (about a millisecond, where the
 * application's cost takes about a quarter of a second) and kept for the
 * worker's life, grown as a test asks for more (card 2997, N2; its code
 * review, FP9).
 */
const fixtureHashPools = new Map<string, string[]>();

/**
 * The `n`-th (from 1) of the worker's distinct hashes of `password`: the same
 * string for the same `password` and `n` in every test of the worker, and a
 * different one for each `n`. A test that hands each of its accounts its own
 * `n` gives no two of them the same string, so that a record of one account's
 * replaced or deleted hash names that account alone, as bcrypt's salt makes it
 * in use.
 */
export function fixtureHashFor(password: string, n: number): string {
	if (!Number.isSafeInteger(n) || n < 1) throw new Error(`fixtureHashFor takes a whole number from 1, and was given ${n}`);
	let pool = fixtureHashPools.get(password);
	if (pool === undefined) fixtureHashPools.set(password, (pool = []));
	while (pool.length < n) pool.push(realBcrypt.hashSync(password, 4));
	return pool[n - 1];
}

/**
 * The hash of `FIXTURE_PASSWORD` for the next fixture account of this test:
 * the pool's n-th for the test's n-th account, by its own counter, so that no
 * two fixture accounts in one test hold the same string (card 2997, N2).
 */
const nextFixtureHash = (): string => fixtureHashFor(FIXTURE_PASSWORD, ++fixtureAccounts);

/** The hash `makeUser` gave each account of this test, by id: emptied by `resetDb`. */
const fixtureHashes = new Map<number, string>();

/**
 * The hash of `FIXTURE_PASSWORD` that `makeUser` gave this account: the one it
 * holds unless the test changed it. Still answered once the account is
 * deleted, so that a test can name the hash it held. Throws for an account
 * `makeUser` did not make in this test.
 */
export function fixtureHashOf(user: Pick<SessionUser, 'id'> | number): string {
	const id = typeof user === 'number' ? user : user.id;
	const hash = fixtureHashes.get(id);
	if (hash === undefined) throw new Error(`Account ${id} was not made by makeUser in this test`);
	return hash;
}

/**
 * A hash of `FIXTURE_PASSWORD` that no other account of this test holds, for
 * a users row a test writes by hand.
 */
export function newFixtureHash(): string {
	return nextFixtureHash();
}

/**
 * A user row, returned in the shape `locals.user` carries: `disabledAt: null`,
 * as every gate gives an account it lets in (card 2671). `disabled` makes it
 * an account disabled now, by `disabled.by` where one is given, as the
 * superadmin's or an administrator's disable writes it, and the shape is
 * returned without `disabledAt`, so that whatever is handed it reads the
 * account as it is.
 */
export function makeUser(opts: { role?: Role; username?: string; disabled?: true | { by: Pick<SessionUser, 'id'> } } = {}): SessionUser {
	const n = next();
	const username = opts.username ?? `user${n}`;
	const passwordHash = nextFixtureHash();
	const row = db
		.insert(users)
		.values({
			username,
			email: `${username}@example.test`,
			passwordHash,
			role: opts.role ?? 'user',
			...(opts.disabled === undefined
				? {}
				: { disabledAt: stamp(), disabledBy: opts.disabled === true ? null : opts.disabled.by.id })
		})
		.returning()
		.get();
	fixtureHashes.set(row.id, passwordHash);
	const user = {
		id: row.id,
		username: row.username,
		email: row.email,
		emoji: row.emoji || '👤',
		role: row.role
	};
	return opts.disabled === undefined ? { ...user, disabledAt: null } : user;
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
 * An API key for a user, as `makeApiKey` makes one, with its row id, for a call
 * through `api()` sent as `credential: { kind: 'api key', id }` (card 2893,
 * E15). `expiresAt`, in the stored form, may be in the past: a key that has
 * ended.
 */
export function makeApiKeyRow(user: SessionUser, opts: { expiresAt?: string } = {}): { key: string; id: number } {
	const key = generateApiKey();
	const row = db
		.insert(apiKeys)
		.values({ userId: user.id, name: `Key ${next()}`, keyHash: key.keyHash, keyPrefix: key.keyPrefix, expiresAt: opts.expiresAt ?? null })
		.returning({ id: apiKeys.id })
		.get();
	return { key: key.plaintextKey, id: row.id };
}

/**
 * A session for a user, made as a login makes one, with the limits of the
 * user's role and only its hash stored (card 2775). Returns the code the
 * session cookie carries: send it as `Cookie: dumpfire_session=<token>`, the
 * name being `SESSION_COOKIE_NAME` under the tests (`__Host-dumpfire_session`
 * under `COOKIE_SECURE=true` or over `https:`). Random, as `makeApiKey` is.
 * `api()` turns the cookie into the credential the gate would record.
 */
export function makeSession(user: SessionUser): string {
	return createSession(user.id).token;
}

/**
 * The code the authenticator with this secret shows at `at` (now by default).
 * Kept here and re-exported by ./two-step.ts, which imports
 * `FIXTURE_PASSWORD` from this file: one definition, and no import each way.
 */
export function codeFor(secret: Buffer, at: number = Date.now()): string {
	return hotp(secret, stepAt(at));
}

/**
 * The account's authenticator a step-up's code is made from (card 2771, plan
 * D10): its row id and secret. The first factor the account holds, by id, is
 * reused: one a test gave (`giveFactor`) has its secret
 * read through `factorSecret`, and a factor that does not open is a throw
 * naming the test. With none, one is written with `addTotpFactor` under the
 * test process's key: no AUTH line, no mail and no recovery codes, but the
 * factor row and, for the first factor of the database, the
 * `settings.mfa_key_check` row.
 */
export function stepUpFactor(user: Pick<SessionUser, 'id'>): { factorId: number; secret: Buffer } {
	// The lowest id, so that a test with several authenticators reads the same one each time (card 2772, F7).
	const factor = db.select().from(mfaFactors).where(eq(mfaFactors.userId, user.id)).orderBy(mfaFactors.id).get();
	if (factor === undefined) {
		const secret = newTotpSecret();
		const { id } = addTotpFactor(user.id, 'Authenticator', secret);
		return { factorId: id, secret };
	}
	const opened = factorSecret(factor);
	if (!opened.usable) {
		throw new Error(
			`stepUpFactor: user ${user.id}'s factor ${factor.id} does not open (${opened.why}) in "${expect.getState().currentTestName}": pass the code to stepUp`
		);
	}
	return { factorId: factor.id, secret: opened.secret };
}

/**
 * A code that confirms a step-up for `user` at `at` (now by default): the
 * account's factor (`stepUpFactor`), its last spent step cleared, so that a
 * code of the same step as an earlier success is not refused as spent, and
 * the code it shows then.
 */
export function stepUpCode(user: Pick<SessionUser, 'id'>, at: number = Date.now()): string {
	const { factorId, secret } = stepUpFactor(user);
	db.update(mfaFactors).set({ lastStep: null }).where(eq(mfaFactors.id, factorId)).run();
	return codeFor(secret, at);
}

/**
 * The `api()` options of a request that asks for the current password and a
 * code again (cards 2701 and 2771, `STEP_UP_ACTIONS`): `user` calling, `body`
 * with `currentPassword` and `currentCode` added, and the cookie of a session
 * of that user, made for it, which the wrong passwords are counted on.
 * `password` is the fixture's, and `code` the account's own for now
 * (`stepUpCode`, which gives the account a factor if it has none), unless a
 * test sends others, a wrong one through the same helper. Build it before any
 * snapshot: it writes the factor, the session and the cleared step.
 */
export function stepUp(
	user: SessionUser,
	body: Record<string, unknown> = {},
	password: string = FIXTURE_PASSWORD,
	code: string = stepUpCode(user)
): { user: SessionUser; body: Record<string, unknown>; headers: Record<string, string> } {
	return {
		user,
		body: { ...body, [STEP_UP_FIELD]: password, [STEP_UP_CODE_FIELD]: code },
		headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` }
	};
}

/**
 * The columns a right step-up writes apart from the route's transaction (card
 * 2771, plan D10, E1): the count on the session as the password arrives, and
 * the code's step spent with it. For `eachWriteInTurn`'s `apart`.
 */
export const STEP_UP_APART: readonly string[] = [
	'sessions.wrong_password_count',
	'mfa_factors.last_step',
	'mfa_factors.last_used_at'
];

/**
 * The shapes of a right step-up's own writes, in order, before the route's
 * (card 2771, plan D10, E1): the count, the code's step spent, and the count
 * cleared.
 */
export const STEP_UP_WRITES: readonly string[] = ['update sessions set', 'update mfa_factors set', 'update sessions set'];

/**
 * Run `write` inside `whilePasswordHolds` for `user`, against their stored
 * hash read from the row, so that `passwordHeld(user.id)` is true while it
 * runs (card 2726). It skips the password confirmation: no password is asked
 * or checked, and nothing is counted on a session. It exists only for service
 * unit tests that call a service asking the proof itself (`deleteDecision`,
 * `withdrawDecision` on an opened decision) directly; a test of a route sends
 * the password instead. The write runs at once, before the promise is
 * answered.
 */
export function holdingPassword<T>(user: SessionUser, write: () => T extends PromiseLike<unknown> ? never : T): Promise<T> {
	const hash = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get()!.passwordHash;
	return whilePasswordHolds(user.id, hash, write);
}

/**
 * The headers of an import confirmed as `POST /api/admin/import/confirm`
 * confirms one (card 2701, decision 8): the session cookie, of `token` or of
 * a session made for it, and the confirmation, issued for that session and
 * the user's password hash as it is now with the issuer the route uses.
 */
export function importConfirmation(user: SessionUser, token?: string): Record<string, string> {
	const session = token ?? makeSession(user);
	const hash = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get()!.passwordHash;
	return {
		cookie: `${SESSION_COOKIE_NAME}=${session}`,
		[CONFIRMATION_HEADER]: issueImportConfirmation(sessionHashOf(session), user.id, hash)
	};
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
 * one on a board made with no owner, unless a `setBy` is given. `heldBecause`
 * makes it one switched off by a hold (card 2752): off, with the hold and a
 * moment recorded.
 *
 * The key it records (card 2893, E15): `setWithKey` false by default, as a
 * webhook made with no credential at all (a test's) records, which the key
 * rule never holds; `true` with `setByKey` a key's row id, or with none; and
 * `null`, as a webhook made before keys were recorded.
 *
 * Its address is stored as the server stores one (card 2928, R2): sealed
 * through the production helper (`sealValue` with `webhookUrlAad`), bound to
 * its id, board and `receiver`, which is filled as `receiverOf` reads the
 * address. The row returned is as stored, its `url` the envelope, with the
 * address as given beside it as `address`, for a test to compare deliveries
 * and answers with (`readOpenedUrl` opens the stored one). A test that needs a
 * plain address stored, or a plain row, builds it itself and says so.
 */
export function makeWebhook(
	board: Board,
	opts: {
		url?: string;
		events?: string[];
		secret?: string;
		active?: boolean;
		setBy?: SessionUser | null;
		heldBecause?: string;
		setWithKey?: boolean | null;
		setByKey?: number | null;
	} = {}
): typeof webhooks.$inferSelect & { address: string } {
	const url = opts.url ?? `https://hooks.example.test/${next()}`;
	const receiver = receiverOf(url) ?? '';
	const made = db
		.insert(webhooks)
		.values({
			boardId: board.id,
			url: '',
			receiver,
			events: JSON.stringify(opts.events ?? []),
			secret: opts.secret ?? '',
			active: opts.heldBecause === undefined ? (opts.active ?? true) : false,
			setBy: opts.setBy === undefined ? board.createdBy : opts.setBy === null ? null : opts.setBy.id,
			setWithKey: opts.setWithKey === undefined ? false : opts.setWithKey,
			setByKey: opts.setByKey ?? null,
			...(opts.heldBecause === undefined ? {} : { heldBecause: opts.heldBecause, heldAt: '2026-11-18 09:00:00' })
		})
		.returning()
		.get();
	const stored = db
		.update(webhooks)
		// `sealValue`, as the start's sweep seals one: no key check recorded, so that a test's own check stands.
		.set({ url: sealValue(url, webhookUrlAad(made.id, made.boardId, receiver), currentMfaKey()!) })
		.where(eq(webhooks.id, made.id))
		.returning()
		.get()!;
	// The row as stored, its `url` the envelope (card 2928's code review, C8), and the address as the test wrote
	// it beside, as `address`: what deliveries and answers are compared with. Handed to `deliver` or
	// `deliveryResultFor`, the row takes the sealed path a stored row takes.
	return { ...stored, address: url };
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

/**
 * `database` as a server that has started since card 2923's release holds it:
 * the `settings` flag `webhooks_already_off_held`, so that a backup made of it
 * is one made since, and its restore holds only the already-off webhooks of a
 * disabled or missing setter (card 2923's code review, S2). Without it, a
 * backup is one from before the release, whose restore holds every one.
 *
 * And the moment card 2935's start pass covered (`webhooks_readable_by_disabled_held`, P4), so that the restore of a
 * backup made of it does not run the pass itself (P12): a server started since that release too.
 */
export function startedSinceAlreadyOffHeld(database: { prepare(source: string): { run(...args: unknown[]): unknown } } = sqlite): void {
	database.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks_already_off_held', '2026-11-19T00:00:00.000Z')").run();
	database.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('webhooks_readable_by_disabled_held', '2026-11-19 00:00:00')").run();
}

/** A person in the directory (card 2674): active, with no account and no job title unless told otherwise. */
export function makePerson(
	opts: { fullName?: string; email?: string; jobTitle?: string; user?: SessionUser | null; status?: 'active' | 'left' } = {}
): Person {
	const n = next();
	const status = opts.status ?? 'active';
	return db
		.insert(people)
		.values({
			fullName: opts.fullName ?? `Person ${n}`,
			email: (opts.email ?? `person${n}@example.test`).toLowerCase(),
			jobTitle: opts.jobTitle ?? '',
			userId: opts.user?.id ?? null,
			status,
			leftAt: status === 'left' ? '2026-11-01 09:00:00' : null
		})
		.returning()
		.get();
}

/**
 * A decision, written as card 2675's service would leave it: a draft on no
 * board unless told otherwise, with the board's and the accounts' names kept
 * beside their ids. Any other column is given in `row`, `closesAt`,
 * `ruledAt` and `withdrawnAt` among them.
 */
export function makeDecision(
	opts: { board?: Board | null; author?: SessionUser | null; decider?: SessionUser | null; status?: string; closesAt?: string | null } & Partial<NewDecision> = {}
): Decision {
	const { board, author, decider, ...row } = opts;
	return db
		.insert(decisions)
		.values({
			title: `Decision ${next()}`,
			...row,
			boardId: board?.id ?? null,
			boardName: board?.name ?? 'No board',
			authorUserId: author?.id ?? null,
			authorName: author?.username ?? 'An author',
			deciderUserId: decider?.id ?? null,
			deciderName: decider?.username ?? null,
			status: opts.status ?? 'draft',
			closesAt: opts.closesAt ?? null
		})
		.returning()
		.get();
}

/** An option of a decision, labelled and placed in the order made unless told otherwise. */
export function makeOption(decision: Decision, opts: Partial<typeof decisionOptions.$inferInsert> = {}): DecisionOption {
	const n = next();
	return db
		.insert(decisionOptions)
		.values({ label: `Option ${n}`, position: n, ...opts, decisionId: decision.id })
		.returning()
		.get();
}

/**
 * The SHA-256 an invite's token is stored as (card 2849): its 32 bytes, a
 * BLOB, so that no text an address can be is ever equal to it.
 */
export function inviteHashOf(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

/**
 * The SHA-256 a session's code is stored as (card 2775): its 32 bytes, a
 * BLOB, in `sessions.id`, which the model calls `tokenHash`.
 */
export function sessionHashOf(token: string): Buffer {
	return createHash('sha256').update(token).digest();
}

/** The session row of the code `token`, found by its hash, or undefined for none. */
export function sessionRow(token: string) {
	return db.select().from(sessions).where(eq(sessions.tokenHash, sessionHashOf(token))).get();
}

/** What the gate records in `locals.credential` for a request with the session of the code `token`. */
export function sessionCredential(token: string): Credential {
	return { kind: 'session', hash: sessionHashOf(token) };
}

/** The SHA-256 a personal link's token is stored as (card 2675, decision 9). */
export function linkHashOf(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * A participant row of a decision, with its snapshots: the person's, when one
 * is given, and made-up ones otherwise; any of them given in `row`, `userId`
 * and `email` among them. `token` gives it a personal link, stored as its
 * hash. `hadAccount` also writes the `included { role, hadAccount }` event
 * opening would, which only a decision that is not a draft may have.
 */
export function makeParticipant(
	decision: Decision,
	opts: { person?: Person | null; token?: string; hadAccount?: boolean } & Partial<typeof decisionParticipants.$inferInsert> = {}
): DecisionParticipant {
	const { person, token, hadAccount, ...row } = opts;
	const n = next();
	const participant = db
		.insert(decisionParticipants)
		.values({
			personId: person?.id ?? null,
			role: 'consulted',
			name: person?.fullName ?? `Participant ${n}`,
			email: person?.email ?? `participant${n}@example.test`,
			jobTitle: person?.jobTitle ?? '',
			groups: '[]',
			includedAt: '2026-11-01 09:00:00',
			userId: person?.userId ?? null,
			linkTokenHash: token === undefined ? null : linkHashOf(token),
			linkIssuedAt: token === undefined ? null : '2026-11-01 09:00:00',
			...row,
			decisionId: decision.id
		})
		.returning()
		.get();
	if (hadAccount !== undefined) {
		appendEvent(
			{ decisionId: decision.id, kind: 'included', participantId: participant.id, detail: { role: participant.role, hadAccount } },
			SYSTEM_ACTOR
		);
	}
	return participant;
}

/**
 * A published version of the decision (card 2677), its content given as an
 * object and stored as JSON: numbered one past the decision's current version
 * unless told otherwise, and asking for views again unless told not to. The
 * decision's `current_version` is moved on to it. Its options are the test's
 * to make live in it (`makeOption` with `addedInVersion`).
 */
export function makeVersion(
	decision: Decision,
	content: Record<string, unknown> = {},
	opts: { number?: number; asksAgain?: boolean; changeNote?: string | null; publishedAt?: string } = {}
): DecisionVersion {
	const current = db.select({ currentVersion: decisions.currentVersion }).from(decisions).where(eq(decisions.id, decision.id)).get()!.currentVersion;
	const number = opts.number ?? current + 1;
	const version = db
		.insert(decisionVersions)
		.values({
			decisionId: decision.id,
			number,
			content: JSON.stringify(content),
			changeNote: opts.changeNote === undefined ? (number === 1 ? null : 'A change') : opts.changeNote,
			asksAgain: opts.asksAgain ?? true,
			publishedByName: 'An author',
			publishedAt: opts.publishedAt ?? '2026-11-01 09:00:00'
		})
		.returning()
		.get();
	if (number > current) db.update(decisions).set({ currentVersion: number }).where(eq(decisions.id, decision.id)).run();
	return version;
}

/**
 * A response of the participant (card 2677), as `appendResponse` writes one:
 * an abstention in round 1 of version 1, given signed in, unless told
 * otherwise; any column given in `opts`.
 */
export function makeResponse(participant: DecisionParticipant, opts: Partial<typeof decisionResponses.$inferInsert> = {}): DecisionResponse {
	return db
		.insert(decisionResponses)
		.values({
			versionNumber: 1,
			round: 1,
			kind: 'abstain',
			via: 'session',
			createdAt: '2026-11-01 10:00:00',
			...opts,
			decisionId: participant.decisionId,
			participantId: participant.id
		})
		.returning()
		.get();
}

/**
 * A ruling of the decision (card 2679), as `ruleDecision` leaves one: the
 * ruling row, on none of these, for its current version, by its decider,
 * neither early nor against unless told otherwise, and the decision stored
 * `ruled` with its `ruled_at`; and its `ruled` event, holding the board's
 * Product Owner as it is now (code review S1). No `cut_off`, no mail. Any
 * column of the ruling given in `opts`.
 */
export function makeRuling(decision: Decision, opts: Partial<typeof decisionRulings.$inferInsert> = {}): DecisionRuling {
	const row = db.select().from(decisions).where(eq(decisions.id, decision.id)).get()!;
	const ruledAt = opts.ruledAt ?? '2026-11-02 09:00:00';
	const ruling = db
		.insert(decisionRulings)
		.values({
			optionId: null,
			reason: 'A reason.',
			conditions: null,
			againstResponses: false,
			early: false,
			versionNumber: row.currentVersion,
			ruledBy: row.deciderUserId,
			ruledByName: row.deciderName ?? 'A decider',
			...opts,
			ruledAt,
			decisionId: decision.id
		})
		.returning()
		.get();
	db.update(decisions).set({ status: 'ruled', ruledAt }).where(eq(decisions.id, decision.id)).run();
	// As `ruleDecision` records it (code review S1): the board's Product Owner now, who alone holds `productOwner` on it from then on.
	const productOwnerUserId =
		row.boardId === null ? null : (db.select({ id: boards.productOwnerUserId }).from(boards).where(eq(boards.id, row.boardId)).get()?.id ?? null);
	appendEvent(
		{
			decisionId: decision.id,
			kind: 'ruled',
			versionNumber: row.currentVersion,
			detail: { optionId: ruling.optionId, early: ruling.early, againstResponses: ruling.againstResponses, productOwnerUserId }
		},
		SYSTEM_ACTOR
	);
	return ruling;
}

/**
 * The keys no answer of a participant page holds, anywhere in it (card 2677,
 * decision 16, R3, D3). One list for every test that holds a page to it:
 * tests/decision-participation.test.ts and tests/decision-questions.test.ts
 * (card 2678, code review F5). It lives here, not in either test file, as
 * importing a test file runs its tests in the importer too.
 */
export const NEVER_GIVEN: readonly string[] = [
	'userId',
	'byUserId',
	'byName',
	'groupId',
	'deciderUserId',
	'authorUserId',
	'email',
	'linkTokenHash',
	'participantId',
	'decisionId',
	'replacesId'
];

/**
 * A clarification question of the participant (card 2678), as its writes
 * leave one: asked signed in on version 1, its asker the participant's
 * snapshot name, unanswered, unless told otherwise. `answer` answers it by
 * `by` (an account, or a name alone), and writes the `question_answered`
 * event the answer write would, with its `role` (the decider's unless told
 * otherwise); `agentDrafted` makes that answer an agent's draft, and
 * `published` publishes it, by `by` unless another is given. No notice and
 * no `question_asked` event: a test of those calls the writes.
 */
export function makeQuestion(
	decision: Decision,
	participant: DecisionParticipant,
	opts: {
		question?: string;
		via?: 'session' | 'link' | 'api';
		askedInVersion?: number;
		askedAt?: string;
		answer?: string;
		by?: SessionUser | string;
		role?: 'author' | 'decider';
		agentDrafted?: boolean;
		answeredAt?: string;
		published?: boolean | SessionUser;
		reviewedAt?: string;
	} = {}
): DecisionQuestion {
	const by = opts.by === undefined ? { id: null, username: 'An answerer' } : typeof opts.by === 'string' ? { id: null, username: opts.by } : opts.by;
	const answered = opts.answer !== undefined;
	const publisher = opts.published === undefined || opts.published === false ? null : opts.published === true ? by : opts.published;
	const question = db
		.insert(decisionQuestions)
		.values({
			decisionId: decision.id,
			participantId: participant.id,
			askerName: participant.name,
			question: opts.question ?? `Question ${next()}?`,
			askedInVersion: opts.askedInVersion ?? 1,
			via: opts.via ?? 'session',
			askedAt: opts.askedAt ?? '2026-11-02 10:00:00',
			answer: opts.answer ?? null,
			answeredBy: answered ? by.id : null,
			answeredByName: answered ? by.username : null,
			answeredAt: answered ? (opts.answeredAt ?? '2026-11-02 11:00:00') : null,
			answerAgentDrafted: answered && opts.agentDrafted === true,
			answerReviewedBy: answered && publisher !== null ? publisher.id : null,
			answerReviewedAt: answered && publisher !== null ? (opts.reviewedAt ?? '2026-11-02 12:00:00') : null
		})
		.returning()
		.get();
	if (answered) {
		appendEvent(
			{
				decisionId: decision.id,
				kind: 'question_answered',
				detail: {
					questionId: question.id,
					role: opts.role ?? 'decider',
					agentDrafted: opts.agentDrafted === true,
					notice: opts.agentDrafted === true ? 'awaiting_review' : 'asked'
				}
			},
			{ userId: by.id, name: by.username, source: opts.agentDrafted === true ? 'api' : 'ui' }
		);
	}
	return question;
}

/**
 * A link between the decision and the card (card 2680), as `linkCard` leaves
 * one: `relates`, by nobody, unless told otherwise. `relation` may be one no
 * write takes yet (`waits`, card 2687's), to hold what a change of it does.
 */
export function makeCardLink(decision: Decision, card: Card, opts: { by?: SessionUser; relation?: string } = {}): DecisionCardLink {
	return db
		.insert(decisionCardLinks)
		.values({ decisionId: decision.id, cardId: card.id, relation: opts.relation ?? 'relates', createdBy: opts.by?.id ?? null, createdAt: '2026-11-01 09:00:00' })
		.returning()
		.get();
}

/**
 * Move the decision's record-bearing mail events `minutes` back in time, so
 * that the next re-send, re-publish or re-inclusion is past the throttle
 * (card 2675, decision 31). A test's own change to the record: nothing in
 * `src` may make it.
 */
export function ageRecordMail(decisionId: number, minutes = 11): void {
	sqlite
		.prepare(
			"UPDATE decision_events SET created_at = strftime('%Y-%m-%d %H:%M:%S', created_at, ?) " +
				"WHERE decision_id = ? AND kind IN ('invited', 'asked_again', 'told_of_change', 'told_withdrawn', 'told_ruling')"
		)
		.run(`-${minutes} minutes`, decisionId);
}
