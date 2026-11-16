/**
 * The host's reset of an account's two-step sign-in (card 2773, plan 4.5):
 * scripts/mfa-reset.mjs, run as the host runs it, with node, in a process of
 * its own.
 *
 * Each case seeds the in-memory database and writes it, with
 * `sqlite.serialize()`, to a scratch folder of its own under the temp folder,
 * removed after the case; the command is pointed at that file with `DB_PATH`
 * and run with the scratch folder as its working directory, so it never
 * reaches the repository's dumpfire.db. `APP_URL` and `ORIGIN` are only what
 * a case gives it. The image build runs the suite as root, so every run names
 * a uid through the command's test seam, `DUMPFIRE_TEST_UID` (read only when
 * `NODE_ENV` is `test` and `VITEST` is set): 1000, but in T26.
 *
 * T21 is the command's whole job: what it leaves is compared, every table and
 * column, with what `resetTwoStep` leaves of the same database in memory, so
 * a statement one makes and the other does not fails here.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, sqlite } from '$lib/server/db';
import { enrolmentLinks, inviteTokens, settings, signInChallenges, users } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { sha256Hex } from '$lib/server/mfa-crypto';
import { ENROLMENT_LINK_LIFETIME_MS, addTotpFactor, resetTwoStep, storeRecoveryCodes } from '$lib/server/mfa-store';
import { newRecoveryCodes } from '$lib/server/recovery-codes';
import { newTotpSecret } from '$lib/server/totp';
import { isStamp, parseStamp, stamp } from '$lib/timestamps';
import { inviteHashOf, makeApiKey, makeSession, makeUser, resetDb } from './helpers/fixtures';

const SCRIPT = join(process.cwd(), 'scripts', 'mfa-reset.mjs');

let scratch: string;
/** The scratch copy of the database the command is run on. */
let file: string;

beforeEach(() => {
	resetDb();
	scratch = mkdtempSync(join(tmpdir(), 'dumpfire-mfa-reset-'));
	file = join(scratch, 'dumpfire.db');
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run the command with `args`, on `DB_PATH` (the scratch copy unless a case
 * names another), with nothing of this process's `APP_URL`, `ORIGIN` or
 * `DB_PATH`, and `env` on top.
 */
function run(args: string[], env: Record<string, string> = {}) {
	const inherited: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && !['APP_URL', 'ORIGIN', 'DB_PATH'].includes(name)) inherited[name] = value;
	}
	const result = spawnSync(process.execPath, [SCRIPT, ...args], {
		cwd: scratch,
		// VITEST named here, not left to what is inherited: the seam is read only with it and NODE_ENV both (card 2773's review).
		env: { ...inherited, NODE_ENV: 'test', VITEST: 'true', DUMPFIRE_TEST_UID: '1000', DB_PATH: file, ...env },
		encoding: 'utf8',
		timeout: 30_000
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Write the in-memory database, as it is now, to the scratch copy. */
const writeCopy = () => writeFileSync(file, sqlite.serialize());

type Row = Record<string, unknown>;

/**
 * Every row of every table of `database`, in rowid order, the id counters
 * included. Left out unless `logs` is set: `system_logs` and its counter. An
 * enrolment link's hash and its two times are made fresh by each reset, so
 * they are masked; the link itself, its account and `issued_by` are not.
 */
function dumpOf(database: Database.Database, { logs = false } = {}): Record<string, Row[]> {
	const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
		.map((table) => table.name)
		.filter((name) => logs || name !== 'system_logs');
	const dump: Record<string, Row[]> = {};
	for (const table of tables) {
		let rows = database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Row[];
		if (table === 'sqlite_sequence' && !logs) rows = rows.filter((row) => row.name !== 'system_logs');
		if (table === 'enrolment_links') rows = rows.map((row) => ({ ...row, token_hash: '(masked)', created_at: '(masked)', expires_at: '(masked)' }));
		dump[table] = rows;
	}
	return dump;
}

/** The scratch copy's dump, opened read-only and closed again. */
function fileDump(options: { logs?: boolean } = {}): Record<string, Row[]> {
	const copy = new Database(file, { readonly: true, fileMustExist: true });
	try {
		return dumpOf(copy, options);
	} finally {
		copy.close();
	}
}

/**
 * An account with everything a reset ends or keeps, as T1 of
 * tests/mfa-reset.test.ts seeds one: a factor, ten recovery codes, two
 * sessions, a pending sign-in, an enrolment link, an unused invite and a used
 * one, an API key, wrong-code counts with their pauses, and the banner.
 */
function seedAccount(username: string) {
	const user = makeUser({ username });
	addTotpFactor(user.id, 'Phone', newTotpSecret());
	storeRecoveryCodes(user.id, newRecoveryCodes());
	makeSession(user);
	makeSession(user);
	db.insert(signInChallenges)
		.values({
			tokenHash: sha256Hex(`challenge-${username}`),
			shortId: `c-${username}`,
			userId: user.id,
			purpose: 'sign-in',
			lane: 'other',
			passwordHash: '$2b$04$notareal.hash',
			expiresAt: stamp(new Date(Date.now() + 10 * 60 * 1000))
		})
		.run();
	db.insert(enrolmentLinks)
		.values({ tokenHash: sha256Hex(`older link of ${username}`), userId: user.id, issuedBy: 'admin-reset', expiresAt: stamp(new Date(Date.now() + 60_000)) })
		.run();
	const week = stamp(new Date(Date.now() + ENROLMENT_LINK_LIFETIME_MS));
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf(`unused-${username}-${randomBytes(4).toString('hex')}`), userId: user.id, expiresAt: week }).run();
	db.insert(inviteTokens).values({ tokenHash: inviteHashOf(`used-${username}-${randomBytes(4).toString('hex')}`), userId: user.id, expiresAt: week, used: true }).run();
	makeApiKey(user);
	const later = stamp(new Date(Date.now() + 60 * 60 * 1000));
	db.update(users)
		.set({
			mfaKnownWrong: 2,
			mfaOtherWrong: 3,
			mfaRecoveryWrong: 4,
			mfaKnownResumesAt: later,
			mfaOtherResumesAt: later,
			mfaRecoveryResumesAt: later,
			failedCodesSinceSignIn: 5,
			securityBanner: 'codes-failed',
			securityBannerAt: stamp(),
			// May set up on its password alone (card 2769): the reset clears it,
			// so the whole-table comparison fails unless the script does too.
			mfaPasswordEnrol: 1
		})
		.where(eq(users.id, user.id))
		.run();
	return user;
}

/** The token of the link the command printed, from its line of stdout, and that line. */
function printedLink(stdout: string): { line: string; token: string } {
	const line = stdout.split(/\r?\n/).find((text) => /\/enrol\/[A-Za-z0-9_-]{43}$/.test(text));
	expect(line, stdout).toBeDefined();
	return { line: line!, token: line!.slice(-43) };
}

const linksIn = (database: Database.Database) =>
	database.prepare('SELECT token_hash AS tokenHash, user_id AS userId, issued_by AS issuedBy, created_at AS createdAt, expires_at AS expiresAt FROM enrolment_links').all() as {
		tokenHash: string;
		userId: number;
		issuedBy: string;
		createdAt: string;
		expiresAt: string;
	}[];

/** The scratch copy's enrolment links, read and closed again. */
function fileLinks() {
	const copy = new Database(file, { readonly: true, fileMustExist: true });
	try {
		return linksIn(copy);
	} finally {
		copy.close();
	}
}

describe('scripts/mfa-reset.mjs', () => {
	it("T21: leaves every table and column as resetTwoStep leaves them, issues a 'host-reset' link whose printed token is the one stored, logs one CRITICAL line, and exits 0", () => {
		// Two accounts alike: the one reset, and one beside it that nothing may touch.
		const holder = seedAccount('holder');
		seedAccount('twin');
		writeCopy();
		const logsBefore = (sqlite.prepare('SELECT COUNT(*) AS n FROM system_logs').get() as { n: number }).n;

		// What the server's own reset leaves of the same database.
		inTransaction(() => resetTwoStep(holder.id, 'host-reset'));
		const expected = dumpOf(sqlite);

		// The username as typed, with spaces round it: trimmed, as sign-in trims it (decision 12).
		const ran = run(['  holder  ']);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stderr).toBe('');
		expect(fileDump()).toEqual(expected);
		expect(ran.stdout).toContain(
			'Two-step sign-in was reset for "holder" (user ' +
				`${holder.id}): removed 1 factor(s) and 10 recovery code(s), ended 2 session(s), 1 pending sign-in(s) and 1 invite(s).`
		);

		// One link, the holder's, issued by the host, for seven days, stored as the hash of the token printed.
		const { token } = printedLink(ran.stdout);
		const links = fileLinks().filter((link) => link.userId === holder.id);
		expect(links).toHaveLength(1);
		expect(links[0]).toMatchObject({ tokenHash: sha256Hex(token), issuedBy: 'host-reset' });
		expect(isStamp(links[0].createdAt)).toBe(true);
		expect(Math.abs(parseStamp(links[0].expiresAt)!.getTime() - (Date.now() + ENROLMENT_LINK_LIFETIME_MS))).toBeLessThan(60_000);

		// One line more in the log, CRITICAL, the account's, with its counts and no token.
		const copy = new Database(file, { readonly: true, fileMustExist: true });
		const lines = copy.prepare('SELECT * FROM system_logs ORDER BY id').all() as Row[];
		copy.close();
		expect(lines).toHaveLength(logsBefore + 1);
		const line = lines.at(-1)!;
		expect(line).toMatchObject({ level: 'CRITICAL', context: 'AUTH', user_id: holder.id, ip: null });
		expect(isStamp(line.timestamp)).toBe(true);
		expect(line.message).toBe(
			`Two-step sign-in reset for user ${holder.id} ("holder") on the server's host, with scripts/mfa-reset.mjs: removed ` +
				'1 factor(s) and 10 recovery code(s), ended 2 session(s), 1 pending sign-in(s) and 1 invite(s); an enrolment link was issued'
		);
		expect(JSON.parse(line.meta as string)).toEqual({
			targetUserId: holder.id,
			resetBy: 'host',
			factorsRemoved: 1,
			recoveryCodesRemoved: 10,
			sessionsEnded: 2,
			challengesEnded: 1,
			invitesEnded: 1
		});
		expect(JSON.stringify(lines)).not.toContain(token);
	});

	it.each([
		{ case: 'T22', refusal: 'an unknown username', args: ['nobody'], database: 'seeded', status: 1, says: 'there is no account with the username "nobody". Nothing was changed.' },
		{ case: 'T23', refusal: 'no argument', args: [], database: 'seeded', status: 2, says: 'Usage: node scripts/mfa-reset.mjs <username>' },
		{ case: 'T24', refusal: 'no database', args: ['holder'], database: 'missing', status: 1, says: 'there is no database at' },
		{
			case: 'T25',
			refusal: 'a database without the 0065 tables',
			args: ['holder'],
			database: 'unmigrated',
			status: 1,
			says: 'this database has no two-step sign-in tables; start the server once to migrate it'
		}
	])('$case: refuses $refusal with exit $status, saying so, and changes nothing', ({ args, database, status, says }) => {
		if (database === 'seeded') {
			seedAccount('holder');
			writeCopy();
		} else if (database === 'unmigrated') {
			const old = new Database(file);
			old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL); INSERT INTO users (username) VALUES ('holder');");
			old.close();
		}
		const before = database === 'missing' ? null : fileDump({ logs: true });

		const ran = run(args);

		expect(ran.status, ran.stderr).toBe(status);
		expect(ran.stderr).toContain(says);
		expect(ran.stdout).toBe('');
		if (before === null) expect(existsSync(file)).toBe(false);
		else expect(fileDump({ logs: true })).toEqual(before);
	});

	// The guard is POSIX's: Windows has no uid 0. Faked through the seam, so it is run whoever runs the suite.
	it.skipIf(process.platform === 'win32')('T26: refuses to run as uid 0 with exit 1, and changes nothing', () => {
		seedAccount('holder');
		writeCopy();
		const before = fileDump({ logs: true });

		const ran = run(['holder'], { DUMPFIRE_TEST_UID: '0' });

		expect(ran.status, ran.stderr).toBe(1);
		expect(ran.stderr).toContain('this is running as root');
		expect(fileDump({ logs: true })).toEqual(before);
	});

	it.each<{ case: string; from: string; env: Record<string, string>; setting: boolean; base: string; says: string }>([
		{
			case: 'T27',
			from: 'APP_URL, over ORIGIN and the setting',
			env: { APP_URL: ' https://app.example.test/ ', ORIGIN: 'https://origin.example.test' },
			setting: true,
			base: 'https://app.example.test',
			says: "The link's address is from APP_URL."
		},
		{
			case: 'T28',
			from: 'ORIGIN, over the setting, with no APP_URL',
			env: { ORIGIN: 'https://ORIGIN.example.test/' },
			setting: true,
			base: 'https://origin.example.test',
			says: "The link's address is from ORIGIN."
		},
		{
			case: 'T29',
			from: "the setting, with a warning, when ORIGIN is the image's placeholder",
			env: { ORIGIN: 'http://localhost:3000' },
			setting: true,
			base: 'https://setting.example.test',
			says: "The link's address is from the App URL setting. Warning: an administrator set it"
		},
		{
			case: 'T30',
			from: 'nowhere: the path alone, with the instruction',
			env: {},
			setting: false,
			base: '',
			says: "put your server's address in front of this path"
		}
	])('$case: takes the address from $from', ({ env, setting, base, says }) => {
		const holder = seedAccount('holder');
		if (setting) db.insert(settings).values({ key: 'app_url', value: 'https://setting.example.test/' }).run();
		writeCopy();

		const ran = run(['holder'], env);

		expect(ran.status, ran.stderr).toBe(0);
		expect(ran.stdout).toContain(says);
		const { line, token } = printedLink(ran.stdout);
		expect(line).toBe(`${base}/enrol/${token}`);
		expect(fileLinks().find((link) => link.userId === holder.id)?.tokenHash).toBe(sha256Hex(token));
	});

	// Card 2769, its security review's CS1: a sign-in left at its second step,
	// which the reset ends, is said; no notice is mailed from the host.
	it('T100 (card 2769): a reset that ends a sign-in left at its second step writes one WARN line saying so', () => {
		const holder = seedAccount('holder');
		db.insert(signInChallenges)
			.values({
				tokenHash: sha256Hex('a verify challenge'),
				shortId: 'v-holder',
				userId: holder.id,
				purpose: 'verify',
				lane: 'other',
				passwordHash: '$2b$04$notareal.hash',
				expiresAt: stamp(new Date(Date.now() + 10 * 60 * 1000))
			})
			.run();
		writeCopy();

		const ran = run(['holder']);

		expect(ran.status, ran.stderr).toBe(0);
		const warned = (fileDump({ logs: true }).system_logs as Row[]).filter((line) => line.level === 'WARN');
		expect(warned).toEqual([
			expect.objectContaining({
				context: 'AUTH',
				user_id: holder.id,
				message: `The reset ended 1 sign-in(s) of user ${holder.id} ("holder") left at their second step; no notice was mailed`
			})
		]);
	});
});
