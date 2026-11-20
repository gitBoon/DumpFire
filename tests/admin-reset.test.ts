/**
 * Reset and Vacuum, the two admin actions that used to restart the id
 * counters.
 *
 * Reset cleared a fixed list of eighteen tables, each in a `try/catch` that
 * only warned. `DELETE FROM users` failed whenever a dependency, a template or
 * a milestone named a user, and then every user stayed, their sessions and the
 * settings were gone, and the answer was success. Six tables were never
 * cleared at all, and no attachment file was ever removed.
 *
 * It is one transaction now. These tests build a database with a row in every
 * table, the rows that used to stop it among them, and ask that a reset clears
 * all of it but the system log and the backup history, leaves the id counters
 * and the migration record alone, and, with any one of its writes failed,
 * clears nothing and says so.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import Database from 'better-sqlite3';
import { generateBackupData } from '$lib/server/backup';
import { restorableTables, restoreFromBackup } from '$lib/server/db/restore';
import { RECORD_ACCOUNT_ENDING_SQL, RECORD_PASSWORD_REPLACED_SQL, credentialOf } from '$lib/server/account-endings';
import { DUMMY_HASH } from '$lib/server/passwords';
import {
	activityLog,
	apiKeys,
	backupLog,
	boardCategories,
	boardFavourites,
	cardAttachments,
	cardDependencies,
	cardLabels,
	cardTemplates,
	categories,
	dailySnapshots,
	inviteTokens,
	reportSchedules,
	requestMessages,
	sessions,
	taskRequests,
	tokenUsage,
	userXp,
	type Card
} from '$lib/server/db/schema';
import { inviteHashOf, sessionHashOf } from './helpers/fixtures';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { stamp } from '$lib/timestamps';
import { issueFormToken, resetFormSecretCache, verifyFormToken } from '$lib/server/request-tokens';
import { randomBytes } from 'node:crypto';
import { currentMfaKey, keyFromBytes, type KeyLoad } from '$lib/server/mfa-key';
import { readMfaKeyCheck } from '$lib/server/mfa-store';
import { MfaKeyError, checkMfaKeyAtStart } from '$lib/server/startup-checks';
import { api, type ApiResult } from './helpers/api';
import { eachWriteInTurn } from './helpers/each-write';
import { failingWrite } from './helpers/failing-write';
import {
	FIXTURE_PASSWORD,
	addBoardMember,
	assignCard,
	fixtureHashOf,
	makeAttachment,
	makeBoard,
	makeCard,
	makeComment,
	makeDependency,
	makeLabel,
	makeMilestone,
	makeSmtp,
	makeSubBoard,
	makeSubtask,
	makeTeam,
	makeUser,
	makeWebhook,
	resetDb,
	shareBoardWithTeam,
	STEP_UP_APART,
	STEP_UP_WRITES,
	stepUpCode,
	testUploadsDir
} from './helpers/fixtures';
import { diffSnapshots, snapshotDb, type DbSnapshot } from './helpers/snapshot';

/**
 * What a reset refused after the password and code were checked leaves: the
 * code's step spent, apart from the reset (card 2771, S4), and nothing else.
 */
const SPENT_ALONE = [expect.stringMatching(/^mfa_factors: row \d+ changed \(last_step: null became \d+; last_used_at: null became /)];

beforeEach(resetDb);
afterEach(() => {
	vi.restoreAllMocks();
});

/** What a reset keeps: with the record of every API key ended here (card 2995), and of every account ended here (card 2996). */
const KEPT = ['system_logs', 'backup_log', 'api_key_revocations', 'account_endings'];
/** The migration runner's record of the files it has applied. */
const MIGRATION_RECORD = '__drizzle_migrations';

/** Every table of the application, as the database lists them. */
const appTables = () =>
	(
		sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid")
			.all() as { name: string }[]
	)
		.map((t) => t.name)
		.filter((name) => name !== MIGRATION_RECORD);

const count = (table: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;

const counter = (table: string) =>
	(sqlite.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as { seq: number } | undefined)?.seq;

const logLines = () =>
	sqlite
		.prepare("SELECT level, message, user_id AS userId FROM system_logs WHERE context = 'ADMIN' ORDER BY id")
		.all() as { level: string; message: string; userId: number | null }[];

const fileIn = (...parts: (string | number)[]) => existsSync(join(testUploadsDir(), ...parts.map(String)));

type Everything = {
	admin: SessionUser;
	owner: SessionUser;
	/** The superadmin's code, which a reset asks beside the password (card 2771). */
	code: string;
	/** The cards that have an attachment with a real file. */
	withFiles: Card[];
	/** Every row of every table but `system_logs`, once all of this was built. */
	before: DbSnapshot;
	/** How many rows each table held. */
	rows: Record<string, number>;
};

/**
 * A row, at least, in every table the application has. The user `member` is
 * named by each of the five keys that have no `ON DELETE` action, which is
 * what `DELETE FROM users` used to fail on.
 */
function everything(): Everything {
	// The superadmin, whose username is `admin`: a reset is the superadmin's
	// alone, and a vacuum is any administrator's, which the superadmin is too.
	const admin = makeUser({ username: 'admin', role: 'superadmin' });
	const owner = makeUser({ username: 'owner' });
	const member = makeUser({ username: 'member' });

	const team = makeTeam([member], 'Team');
	const A = makeBoard({ owner, name: 'A' });
	addBoardMember(A.board, member, 'editor');
	shareBoardWithTeam(A.board, team, 'viewer');
	const hook = makeWebhook(A.board, { secret: 's' });
	makeSmtp();
	// Who set the mail (card 2397, migration 0059): cleared with the rest.
	sqlite.prepare("INSERT INTO setting_setters (setting, place, user_id) VALUES ('mail', 'p', ?)").run(admin.id);

	const category = db.insert(categories).values({ boardId: A.board.id, name: 'Bug' }).returning().get();
	db.insert(boardCategories).values({ name: 'Projects' }).run();
	const first = makeCard(A.cols['To Do'], { title: 'First', categoryId: category.id, createdBy: owner.id });
	const second = makeCard(A.cols['In Progress'], { title: 'Second' });
	const sub = makeSubBoard(first, { owner });
	const subtask = makeSubtask(first);
	const label = makeLabel(A.board);
	db.insert(cardLabels).values({ cardId: first.id, labelId: label.id }).run();
	assignCard(first, member);
	makeComment(first, member);

	const withFiles = [first, second, sub.cards[0]];
	for (const card of withFiles) makeAttachment(card, { name: `${card.title}.txt`, uploadedBy: member });

	makeMilestone({ name: 'Across boards', createdBy: member, cards: [first, second] });
	db.insert(cardTemplates).values({ boardId: A.board.id, name: 'Bug report', createdBy: member.id }).run();
	makeDependency({ blocked: second, blocker: first, createdBy: member });
	makeDependency({ blocked: sub.cards[0], blocker: subtask, createdBy: member });
	db.insert(cardDependencies)
		.values({ cardId: second.id, dependsOnCardId: first.id, createdByUserId: member.id })
		.run();

	db.insert(userXp).values({ name: owner.username, xp: 100 }).run();
	// An hour on: inside an administrator's idle limit (card 2775), made after a second factor.
	db.insert(sessions)
		.values({ tokenHash: sessionHashOf('session-of-admin'), userId: admin.id, expiresAt: stamp(new Date(Date.now() + 60 * 60 * 1000)), twoStep: 1 })
		.run();
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf('invite'), userId: member.id, expiresAt: '2099-01-01 00:00:00' }).run();
	const key = db.insert(apiKeys).values({ keyHash: 'hash', keyPrefix: 'df_', name: 'Key', userId: owner.id }).returning().get();
	// Which key was given which webhook's secret (card 2947, migration 0075): cleared with both.
	sqlite.prepare("INSERT INTO webhook_reveals (webhook_id, key_id, revealed_at) VALUES (?, ?, '2026-11-19 09:00:00')").run(hook.id, key.id);
	db.insert(boardFavourites).values({ userId: owner.id, boardId: A.board.id }).run();
	db.insert(reportSchedules).values({ userId: owner.id, name: 'Weekly', scope: 'board', scopeId: A.board.id }).run();
	db.insert(tokenUsage).values({ cardId: first.id, tokens: 1200, reportedByUserId: owner.id }).run();
	db.insert(activityLog)
		.values({ boardId: A.board.id, cardId: first.id, userId: owner.id, action: 'card_created' })
		.run();
	db.insert(dailySnapshots)
		.values({ boardId: A.board.id, columnId: A.cols['To Do'].id, date: '2026-10-01', cardCount: 1 })
		.run();

	const request = db
		.insert(taskRequests)
		.values({ targetType: 'user', targetId: owner.id, title: 'Please', requesterUserId: member.id, resolvedBy: owner.id })
		.returning()
		.get();
	db.insert(requestMessages).values({ requestId: request.id, senderName: 'member', message: 'Hello' }).run();
	// A requester's link, kept as its token's hash (card 2870, migration 0070).
	sqlite
		.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')")
		.run('d'.repeat(64), request.id);

	// A decision record, a row in each of its twelve tables (card 2673, migration 0061), and a Product Owner.
	const at = '2026-11-03 09:00:00';
	sqlite.exec(`
		UPDATE boards SET product_owner_user_id = ${member.id} WHERE id = ${A.board.id};
		INSERT INTO people (id, full_name, email, user_id, created_by) VALUES (1, 'Member', 'member@example.test', ${member.id}, ${owner.id});
		INSERT INTO people_groups (id, name) VALUES (1, 'Finance');
		INSERT INTO people_group_members (group_id, person_id) VALUES (1, 1);
		INSERT INTO decisions (id, board_id, board_name, title, author_user_id, author_name, decider_user_id)
			VALUES (1, ${A.board.id}, 'A', 'Which supplier', ${owner.id}, 'owner', ${member.id});
		INSERT INTO decision_options (id, decision_id, label, position) VALUES (1, 1, 'A', 1);
		INSERT INTO decision_versions (decision_id, number, content, asks_again, published_by, published_by_name, published_at)
			VALUES (1, 1, '{}', 1, ${owner.id}, 'owner', '${at}');
		INSERT INTO decision_participants (id, decision_id, person_id, role, name, email, job_title, groups, included_at, included_by, user_id)
			VALUES (1, 1, 1, 'consulted', 'Member', 'member@example.test', '', '[]', '${at}', ${owner.id}, ${member.id});
		INSERT INTO decision_responses (decision_id, participant_id, version_number, round, kind, option_id, via) VALUES (1, 1, 1, 1, 'vote', 1, 'session');
		INSERT INTO decision_questions (decision_id, participant_id, asker_name, question, asked_in_version, via, asked_at)
			VALUES (1, 1, 'Member', 'How much?', 1, 'session', '${at}');
		INSERT INTO decision_rulings (decision_id, option_id, reason, against_responses, early, version_number, ruled_by, ruled_by_name, ruled_at)
			VALUES (1, 1, 'Cheaper.', 0, 0, 1, ${member.id}, 'member', '${at}');
		INSERT INTO decision_events (decision_id, participant_id, kind, actor_user_id, actor_name, source) VALUES (1, 1, 'responded', ${member.id}, 'member', 'ui');
		INSERT INTO decision_card_links (decision_id, card_id, created_by) VALUES (1, ${first.id}, ${owner.id});
	`);
	// The record of every change to the people directory (card 2681, migration 0064): cleared with the directory it
	// records, as the decision record is with its decisions.
	sqlite
		.prepare("INSERT INTO people_changes (actor_user_id, actor_name, source, subject, subject_id, kind, before, after) VALUES (?, 'owner', 'ui', 'person', 1, 'created', NULL, ?)")
		.run(owner.id, JSON.stringify({ fullName: 'Member', jobTitle: '', status: 'active', leftAt: null, groupIds: [1] }));
	// Two-step sign-in (card 2768, migration 0065): a second factor, a recovery code, a pending sign-in and an
	// enrolment link, each cleared with the accounts they belong to.
	sqlite.exec(`
		INSERT INTO mfa_factors (factor_uid, user_id, kind, label, key_id, secret_ciphertext, secret_nonce)
			VALUES ('${'a'.repeat(32)}', ${owner.id}, 'totp', 'Phone', '${'b'.repeat(16)}', 'Y2lwaGVydGV4dA==', 'bm9uY2Vub25jZW5v');
		INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (${owner.id}, '${'c'.repeat(64)}');
		INSERT INTO sign_in_challenges (token_hash, short_id, user_id, purpose, lane, password_hash, expires_at)
			VALUES ('${'d'.repeat(64)}', 'abcd', ${owner.id}, 'sign_in', 'other', 'hash', '2099-01-01 00:00:00');
		INSERT INTO enrolment_links (token_hash, user_id, issued_by, expires_at)
			VALUES ('${'e'.repeat(64)}', ${member.id}, 'owner', '2099-01-01 00:00:00');
	`);
	// A setting held for the superadmin's review (card 2922, migration 0074): cleared with the settings it holds, as a
	// new installation has none.
	sqlite
		.prepare("INSERT INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES ('mail', ?, 'setter access ended', ?, ?, 'member')")
		.run('f'.repeat(64), '2026-11-19 09:00:00', member.id);

	// The tables a reset keeps: with the record of every API key ended here (card 2995, migration 0076).
	sqlite
		.prepare("INSERT INTO api_key_revocations (key_id, key_hash, revoked_at, revoked_because) VALUES (?, ?, '2026-11-19 09:00:00', 'revoked')")
		.run(900, 'a'.repeat(64));
	// And of every account ended here (card 2996, migration 0077).
	sqlite
		.prepare("INSERT INTO account_endings (user_id, account_created, ending, ended_at) VALUES (900, '2026-01-01 09:00:00', 'deleted', '2026-11-20 09:00:00')")
		.run();
	db.insert(backupLog)
		.values({ destinationType: 'sftp', destinationName: 'Offsite', filename: 'backup-1.db', status: 'success' })
		.run();
	sqlite
		.prepare('INSERT INTO system_logs (timestamp, level, context, message) VALUES (?, ?, ?, ?)')
		.run('2026-10-01 09:00:00', 'INFO', 'TEST', 'A line from before the reset');

	// The superadmin's factor, and the code a reset sends from it (card 2771), made before the rows are counted.
	const code = stepUpCode(admin);

	const rows = Object.fromEntries(appTables().map((table) => [table, count(table)]));
	return { admin, owner, code, withFiles, before: snapshotDb(), rows };
}

const cleared = () => appTables().filter((table) => !KEPT.includes(table));

/** Whether every attachment file is still in its card's folder, and nothing is in the trash. */
function expectFilesInPlace(e: Everything): void {
	for (const row of Object.values(e.before.card_attachments)) {
		expect(fileIn(row.card_id as number, row.filename as string), `the file of card ${row.card_id}`).toBe(true);
	}
	expect(fileIn('.trash')).toBe(false);
}

/** The reset, as the superadmin asks it: with their current password (card 2701) and a code (card 2771), from their session. */
const reset = (e: Everything) =>
	api('POST', '/api/admin/reset', {
		user: e.admin,
		body: { currentPassword: FIXTURE_PASSWORD, currentCode: e.code },
		headers: { cookie: `${SESSION_COOKIE_NAME}=session-of-admin` }
	});

// ─── Reset ──────────────────────────────────────────────────────────────────

describe('POST /api/admin/reset', () => {
	it('is tested on a database with a row in every table', () => {
		const e = everything();

		// A table added later has to be given a row in `everything`, and so has
		// to be thought about here: is it cleared, or is it kept?
		expect(Object.entries(e.rows).filter(([, n]) => n === 0)).toEqual([]);
		expect(Object.keys(e.rows)).toEqual(expect.arrayContaining(KEPT));
		expect(e.withFiles).toHaveLength(3);
		expectFilesInPlace(e);
	});

	it('(n) (card 2996, R19): a reset records every account but the superadmin as disabled, and an import after it brings them back disabled, the superadmin enabled', async () => {
		const e = everything();
		const backup = new Database(generateBackupData());
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await reset(e);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ accountsRecorded: 2 });

		const result = restoreFromBackup(sqlite, backup);

		expect(result.accountsKept).toMatchObject({ disabled: 2 });
		const accounts = sqlite.prepare('SELECT role, disabled_at AS disabledAt, disabled_by AS disabledBy FROM users ORDER BY id').all() as {
			role: string;
			disabledAt: string | null;
			disabledBy: number | null;
		}[];
		expect(accounts.filter((account) => account.role === 'superadmin')).toEqual([{ role: 'superadmin', disabledAt: null, disabledBy: null }]);
		const others = accounts.filter((account) => account.role !== 'superadmin');
		expect(others).toHaveLength(2);
		for (const account of others) expect(account).toMatchObject({ disabledAt: expect.any(String), disabledBy: e.admin.id });
	});

	it('(y) card 2997: a reset records the password hash of every account but the superadmin as replaced, and an import after it of a backup taken before brings those accounts back disabled with DUMMY_HASH, the superadmin with its hash as the backup has it', async () => {
		const e = everything();
		const accounts = Object.values(e.before.users).map((user) => ({ id: user.id as number, role: user.role as string, created: user.created_at as string }));
		const others = accounts.filter((account) => account.role !== 'superadmin');
		expect(others).toHaveLength(2);
		const backup = new Database(generateBackupData());
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await reset(e);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		// The answer is unchanged: no count of passwords of its own.
		expect(Object.keys(res.body).sort()).toEqual(['accountsRecorded', 'apiKeysRecorded', 'redirect', 'success', 'trash']);

		// One `password` row for each account but the superadmin, the fingerprint of the hash it held, written here.
		expect(
			sqlite.prepare("SELECT user_id AS id, account_created AS created, role, credential, origin FROM account_endings WHERE ending = 'password' ORDER BY seq").all()
		).toEqual(others.map((account) => ({ id: account.id, created: account.created, role: '', credential: credentialOf(fixtureHashOf(account.id)), origin: 'here' })));

		const result = restoreFromBackup(sqlite, backup);

		// The one `errors` line is the fixture's hand-made ending of account 900, which names no account here (card 2997,
		// NF6), pinned so that a change to it is seen.
		expect(result.errors).toEqual([
			"1 row(s) of the backup's record of account endings were left out, as they can name no account here: 1 with an id above the backup's own account counter. The rest of the record was added to this server's."
		]);
		expect(result.accountsKept).toMatchObject({ disabled: 2 });
		expect(result.passwordsKept).toEqual({ here: 0, reset: 2, superadmin: 0 });
		const restored = (id: number) =>
			sqlite.prepare('SELECT disabled_at AS disabledAt, password_hash AS passwordHash FROM users WHERE id = ?').get(id) as { disabledAt: string | null; passwordHash: string };
		for (const account of others) expect(restored(account.id), account.role).toEqual({ disabledAt: expect.any(String), passwordHash: DUMMY_HASH });
		expect(restored(e.admin.id)).toEqual({ disabledAt: null, passwordHash: fixtureHashOf(e.admin) });
	});

	it('test 6: leaves the record of account endings out of the tables a restore and a reset clear (card 2996)', () => {
		expect(restorableTables(sqlite)).not.toContain('account_endings');
		expect(restorableTables(sqlite)).toContain('users');
		expect(appTables()).toContain('account_endings');
	});

	it('clears every table but the system log and the backup history, or clears nothing', async () => {
		// A failed reset is logged at ERROR, once for each write that is failed below.
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const run = await eachWriteInTurn({
			build: everything,
			request: async (e) => {
				const res = await reset(e);
				// With a write failed: not a file has moved. The rows are checked by
				// `eachWriteInTurn`.
				if (res.status >= 500) expectFilesInPlace(e);
				return res;
			},
			// The current password is counted on the session as it arrives, apart
			// from the transaction, and the count cleared for the right one (card
			// 2701), with the code spent (card 2771).
			apart: [...STEP_UP_APART],
			afterSuccess: (e, res: ApiResult) => {
				expect(res.status).toBe(200);
				expect(res.body).toEqual({
					success: true,
					redirect: '/setup',
					trash: { moved: 3, missing: 0, failed: [] },
					// Card 2995 (k, R5): every key it cleared recorded as ended, and counted.
					apiKeysRecorded: 1,
					// Card 2996 (n, R19): every account but the superadmin recorded as disabled, and counted.
					accountsRecorded: 2
				});
				// The record kept, the row it held among it, and the key cleared recorded `reset` (card 2995, k, R5).
				const key = Object.values(e.before.api_keys)[0];
				expect(
					sqlite.prepare('SELECT key_id AS id, key_hash AS hash, revoked_because AS because FROM api_key_revocations ORDER BY key_hash').all()
				).toEqual([
					{ id: 900, hash: 'a'.repeat(64), because: 'revoked' },
					{ id: key.id, hash: 'hash', because: 'reset' }
				]);

				// Everything is cleared, the users among them: they used to stay.
				// Settings hold three rows: the form signing key, made again as the reset commits (card 2750),
				// sealed, the key check recorded with it (card 2898, S2), and the scrub marked pending (its code review, S1).
				for (const table of cleared()) expect(count(table), table).toBe(table === 'settings' ? 3 : 0);

				// The backup history is as it was, and so is the line that was in
				// the system log.
				const after = snapshotDb();
				expect(after.backup_log).toEqual(e.before.backup_log);
				// Card 2996 (test 6): the record of account endings kept, every row of it; (n, R19): and every account but
				// the superadmin recorded as disabled here, by its id and creation time, before the clear.
				const kept = Object.values(e.before.account_endings);
				expect(Object.values(after.account_endings).slice(0, kept.length)).toEqual(kept);
				const accounts = Object.values(e.before.users).filter((user) => user.role !== 'superadmin');
				expect(
					sqlite.prepare("SELECT user_id AS id, account_created AS created, ending, origin FROM account_endings WHERE seq > 1 AND ending = 'disabled' ORDER BY seq").all()
				).toEqual(accounts.map((user) => ({ id: user.id, created: user.created_at, ending: 'disabled', origin: 'here' })));
				expect(
					sqlite.prepare("SELECT message FROM system_logs WHERE context = 'TEST'").all()
				).toEqual([{ message: 'A line from before the reset' }]);

				// The migration record is as it was. Cleared, every migration would
				// run again at the next start, against tables that are already there.
				expect(Object.keys(e.before[MIGRATION_RECORD]).length).toBeGreaterThan(50);
				expect(after[MIGRATION_RECORD]).toEqual(e.before[MIGRATION_RECORD]);

				// The id counters are as they were, every one.
				expect(after.sqlite_sequence).toEqual(e.before.sqlite_sequence);
				expect(Object.keys(after.sqlite_sequence)).toEqual(expect.arrayContaining(['users', 'boards', 'cards']));

				// The line that says who did it is in the log, written after the commit.
				const total = cleared().reduce((sum, table) => sum + e.rows[table], 0);
				expect(logLines()).toEqual([
					{
						level: 'CRITICAL',
						userId: e.admin.id,
						message:
							`The database was reset by admin (ID: ${e.admin.id}): ${total} row(s) cleared from ` +
							`${cleared().length} table(s), the system log and the backup history kept; ` +
							'1 API key(s) recorded as ended, so that no import brings one back, and that record kept; ' +
							'2 account(s) recorded as disabled, so that an import brings each back disabled, and that record kept; ' +
							'3 attachment file(s) moved to the trash'
					}
				]);

				// The files are in the trash, and no card folder is left.
				for (const row of Object.values(e.before.card_attachments)) {
					expect(fileIn('.trash', row.card_id as number, row.filename as string)).toBe(true);
					expect(fileIn(row.card_id as number)).toBe(false);
				}
				expect(readdirSync(join(testUploadsDir(), '.trash')).sort()).toEqual(
					e.withFiles.map((card) => String(card.id)).sort()
				);

				// And what is made next carries on from the old ids, not from 1.
				const lastUser = counter('users')!;
				const lastBoard = counter('boards')!;
				const lastCard = counter('cards')!;
				expect(lastCard).toBe(Math.max(...Object.values(e.before.cards).map((card) => card.id as number)));
				const user = makeUser({ username: 'first-after-reset' });
				const board = makeBoard({ owner: user });
				const card = makeCard(board.cols['To Do']);
				expect({ user: user.id, board: board.board.id, card: card.id }).toEqual({
					user: lastUser + 1,
					board: lastBoard + 1,
					card: lastCard + 1
				});
			}
		});

		// First the current password, counted on the session as it arrives, the
		// code spent and the count cleared for the right one (cards 2701 and
		// 2771). Then one statement for each table, and nothing else: no id
		// counter is deleted, and neither kept table is written to.
		expect(run.writes.slice(0, STEP_UP_WRITES.length).map((sql) => sql.split(' ').slice(0, 3).join(' ').replace(/"/g, ''))).toEqual([...STEP_UP_WRITES]);
		// And the new form signing key, last, in the same transaction (card 2750),
		// sealed, after the key check it records (card 2898, S2).
		// And then the scrub marked pending, in the same transaction (its code review, S1).
		const upsert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
		expect(run.writes.at(-1)).toBe(upsert);
		expect(run.writes.at(-2)).toMatch(/^INSERT INTO settings \(key, value\) VALUES/);
		expect(run.writes.at(-3)).toBe(upsert);
		// Before the clear, every account but the superadmin recorded as disabled (card 2996, n, R19), then each one's
		// password hash recorded as replaced (card 2997, y, decision 5), then every key recorded as ended and deleted
		// (card 2995, R5): the only writes to the kept tables.
		expect(run.writes.slice(STEP_UP_WRITES.length, STEP_UP_WRITES.length + 6)).toEqual([
			RECORD_ACCOUNT_ENDING_SQL.slice(0, 160),
			RECORD_ACCOUNT_ENDING_SQL.slice(0, 160),
			RECORD_PASSWORD_REPLACED_SQL.slice(0, 160),
			RECORD_PASSWORD_REPLACED_SQL.slice(0, 160),
			expect.stringMatching(/^INSERT OR IGNORE INTO api_key_revocations \(key_id, key_hash, revoked_at, revoked_because\) SELECT id, key_hash, @at, @because FROM api_keys WHERE 1 = 1 /),
			'DELETE FROM api_keys WHERE 1 = 1 RETURNING id'
		]);
		expect(run.writes.slice(STEP_UP_WRITES.length + 6, -3).sort()).toEqual(
			cleared()
				.map((table) => `DELETE FROM "${table}"`)
				.sort()
		);
		expect(run.writes.length).toBeGreaterThanOrEqual(30);
		expect(run.effects).toEqual([]);
		// Everything is built, and reset, once for each of some forty writes: two
		// seconds alone, and past vitest's five with every other file running.
	}, 30_000);

	it('answers a failed reset 500, says nothing was cleared, and logs the failure and not a reset', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const e = everything();
		const writes = failingWrite();

		let res: ApiResult;
		try {
			// The last table of all: everything before it had been cleared. One
			// further on for the code's step, spent before the reset (card 2771).
			writes.failNth(cleared().length + 1);
			res = await reset(e);
			expect(writes.fired).toBe(true);
		} finally {
			writes.restore();
		}

		expect(res.status).toBe(500);
		expect(res.body.message).toMatch(/^The reset failed and nothing was cleared: .*made to fail/);
		expect(diffSnapshots(e.before, snapshotDb())).toEqual(SPENT_ALONE);
		expectFilesInPlace(e);
		expect(sqlite.inTransaction).toBe(false);

		expect(logLines()).toEqual([
			{
				level: 'ERROR',
				userId: e.admin.id,
				message: expect.stringMatching(/^A reset by admin \(ID: \d+\) failed, and nothing was cleared: /)
			}
		]);
	});

	it('clears nothing when the commit is refused, for a row left pointing at a row that went', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const e = everything();
		// A row that is still there at the commit and names a user who is not.
		// The reset empties this table with the rest, and the trigger puts the
		// row back as it goes, so the foreign key check, held until the commit,
		// fails there. Nothing real does this: it is a way to refuse the commit.
		sqlite.exec('CREATE TABLE "__new_leftover" (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');
		sqlite.exec(
			'CREATE TRIGGER leftover_comes_back AFTER DELETE ON "__new_leftover" ' +
				'BEGIN INSERT INTO "__new_leftover" (user_id) VALUES (old.user_id); END'
		);

		try {
			sqlite.prepare('INSERT INTO "__new_leftover" (user_id) VALUES (?)').run(e.owner.id);
			const before = snapshotDb();

			const res = await reset(e);

			expect(res.status).toBe(500);
			expect(res.body.message).toMatch(/nothing was cleared: FOREIGN KEY constraint failed/);
			expect(sqlite.inTransaction).toBe(false);
			expect(diffSnapshots(before, snapshotDb())).toEqual(SPENT_ALONE);
			expectFilesInPlace(e);
			// The checks are held for that one transaction only.
			expect(sqlite.pragma('defer_foreign_keys', { simple: true })).toBe(0);
			expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		} finally {
			sqlite.exec('DROP TABLE "__new_leftover"');
		}
	});

	it('is not refused by a table left half way through a rebuild whose row names a user, and empties it', async () => {
		const e = everything();
		// What the migration runner reports and leaves alone: `__new_...`. Its
		// row names a user with no `ON DELETE` action. Left as it was, it would
		// refuse the commit of every reset on this database.
		sqlite.exec('CREATE TABLE "__new_leftover" (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))');

		try {
			sqlite.prepare('INSERT INTO "__new_leftover" (user_id) VALUES (?)').run(e.owner.id);

			const res = await reset(e);

			expect(res.status).toBe(200);
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "__new_leftover"').get()).toEqual({ n: 0 });
			expect(sqlite.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
			expect(sqlite.pragma('foreign_key_check')).toEqual([]);
		} finally {
			sqlite.exec('DROP TABLE "__new_leftover"');
		}
	});

	it('leaves foreign keys on, and no check held over, after a reset that succeeds', async () => {
		const e = everything();

		expect((await reset(e)).status).toBe(200);

		expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
		expect(sqlite.pragma('defer_foreign_keys', { simple: true })).toBe(0);
		expect(sqlite.pragma('foreign_key_check')).toEqual([]);
	});

	it('24: records the key check with the sealed form key it makes, so that a start with another key is then refused (card 2898, S2)', async () => {
		const e = everything();

		expect((await reset(e)).status).toBe(200);

		const formKey = sqlite.prepare("SELECT value FROM settings WHERE key = 'request_form_secret'").get() as { value: string };
		expect(formKey.value).toMatch(/^dfsealed:1:/);
		expect(readMfaKeyCheck(sqlite)).toBe(currentMfaKey()!.check);
		const silenced = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const another: KeyLoad = { ok: true, key: keyFromBytes(randomBytes(32)), path: null, made: false, insideDatabaseDir: false, warnings: [] };
			expect(() => checkMfaKeyAtStart(another, () => [], undefined, { ok: true, key: null, path: null, warnings: [] })).toThrow(MfaKeyError);
		} finally {
			silenced.mockRestore();
		}
	});

	it('24b: marks the scrub pending in its transaction, at its own time, over a marker already set (card 2898 code review, S1)', async () => {
		const e = everything();
		sqlite.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('secrets_scrub_pending', '2026-01-01T00:00:00.000Z');

		expect((await reset(e)).status).toBe(200);

		const marker = sqlite.prepare("SELECT value FROM settings WHERE key = 'secrets_scrub_pending'").get() as { value: string } | undefined;
		expect(marker?.value).toMatch(/^\d{4}-\d\d-\d\dT/);
		expect(marker?.value).not.toBe('2026-01-01T00:00:00.000Z');
	});

	it('forgets the key the public request form signs with, so a form token made before it is refused after it', async () => {
		const e = everything();
		// As a process that has just started: nothing cached by an earlier test.
		resetFormSecretCache();
		const before = issueFormToken();
		expect(verifyFormToken(before)).toBe(true);
		expect(count('settings')).toBeGreaterThan(0);

		expect((await reset(e)).status).toBe(200);

		// The key was a setting and went with the rest. The copy of it in memory
		// used to stay, and went on accepting this token. A new one is made as
		// the reset commits (card 2750), sealed, with the key check it records
		// (card 2898), and the scrub marked pending (its code review, S1): the only settings.
		const only = [{ key: 'mfa_key_check' }, { key: 'request_form_secret' }, { key: 'secrets_scrub_pending' }];
		expect(sqlite.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual(only);
		expect(verifyFormToken(before)).toBe(false);

		// A token made now is good, and is signed with a key that is in the
		// settings: a process starting now agrees with this one.
		const after = issueFormToken();
		expect(verifyFormToken(after)).toBe(true);
		expect(sqlite.prepare('SELECT key FROM settings ORDER BY key').all()).toEqual(only);
		resetFormSecretCache();
		expect(verifyFormToken(after)).toBe(true);
		expect(verifyFormToken(before)).toBe(false);
	});

	it('says in its answer which files could not be moved, and is a success all the same', async () => {
		const e = everything();
		// A file name that climbs out of its card's folder, as a restored backup
		// could hold. It is refused, and so it is not moved.
		db.insert(cardAttachments)
			.values({ cardId: e.withFiles[0].id, filename: '../outside.txt', originalName: 'outside.txt' })
			.run();

		const res = await reset(e);

		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ success: true, redirect: '/setup', trash: { moved: 3, missing: 0 } });
		expect(res.body.trash.failed).toEqual([expect.stringMatching(/^card \d+, "\.\.\/outside\.txt": /)]);
		// Settings hold three rows: the form signing key, made again as the reset commits (card 2750), the key check (card 2898)
		// and the scrub marked pending (its code review, S1).
		for (const table of cleared()) expect(count(table), table).toBe(table === 'settings' ? 3 : 0);
		expect(logLines().at(-1)?.message).toMatch(
			/3 attachment file\(s\) moved to the trash, and 1 could not be moved and are where they were: card \d+, "\.\.\/outside\.txt"/
		);
	});

	it('moves no file that is not there, and counts it as missing', async () => {
		const e = everything();
		makeAttachment(e.withFiles[0], { name: 'row-only.txt', file: false });

		const res = await reset(e);

		expect(res.body.trash).toEqual({ moved: 3, missing: 1, failed: [] });
	});

	it('refuses everybody but the superadmin, an administrator included, with nothing cleared', async () => {
		const e = everything();
		// Whoever sets up after a reset is the superadmin, so an administrator
		// who could reset could make themselves that.
		const administrator = makeUser({ username: 'administrator', role: 'admin' });
		const before = snapshotDb();

		expect((await api('POST', '/api/admin/reset')).status).toBe(401);
		for (const user of [e.owner, administrator]) {
			const res = await api('POST', '/api/admin/reset', { user });
			expect(res.status).toBe(403);
			expect(res.body.message).toContain('belongs to the superadmin');
		}

		expect(diffSnapshots(before, snapshotDb())).toEqual([]);
		expectFilesInPlace(e);
		expect(logLines()).toEqual([]);
	});
});

// ─── Vacuum ─────────────────────────────────────────────────────────────────

describe('POST /api/admin/vacuum', () => {
	it('leaves the id counters as they were, so the next card does not get a deleted card\'s id', async () => {
		const e = everything();
		// The card with the highest id is deleted. Without its counter, the next
		// card made would be given that id again.
		const last = counter('cards')!;
		sqlite.prepare('DELETE FROM cards WHERE id = ?').run(last);
		const before = snapshotDb();
		expect(Object.keys(before.sqlite_sequence).length).toBeGreaterThan(10);

		const res = await api('POST', '/api/admin/vacuum', { user: e.admin });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({ success: true });
		// Not a row and not a counter is different.
		expect(diffSnapshots(before, snapshotDb())).toEqual([]);

		const board = makeBoard({ owner: e.owner });
		expect(makeCard(board.cols['To Do']).id).toBe(last + 1);
	});

	it('refuses a caller who is not an administrator', async () => {
		const e = everything();

		expect((await api('POST', '/api/admin/vacuum')).status).toBe(403);
		expect((await api('POST', '/api/admin/vacuum', { user: e.owner })).status).toBe(403);
		expect(diffSnapshots(e.before, snapshotDb())).toEqual([]);
	});
});
