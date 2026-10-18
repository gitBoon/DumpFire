/**
 * Runs once per test file, before any test in it.
 *
 * Builds the schema by applying the real migrations in `drizzle/` to an
 * in-memory SQLite database — the same runner and the same files a deployment
 * uses. A hand-written test schema would pass while the migrations drifted;
 * this way a migration that no longer applies to a fresh database fails every
 * test, which is the point.
 */
import dns from 'node:dns';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { getDbPath, sqlite } from '$lib/server/db';
import { runMigrations } from '$lib/server/db/migrate';
import { afterEachTimestampCheck } from './helpers/timestamps';

// tests/harness.test.ts holds the list of every test file and the test that
// compares it with the files on disk: it is what notices a test file that was
// left out of a commit. Nothing notices that file itself being left out,
// except this.
if (!existsSync(join(process.cwd(), 'tests', 'harness.test.ts'))) {
	throw new Error(
		'tests/harness.test.ts is missing. It lists every test file and fails when one is not there: ' +
			'without it a tree that has lost a test file passes.'
	);
}

// The real database holds live board data. Nothing below may run against it.
if (getDbPath() !== ':memory:') {
	throw new Error(
		`Tests must run against an in-memory database, but DB_PATH resolved to "${getDbPath()}". ` +
			'Run them through vitest (npm test), which sets DB_PATH=:memory:.'
	);
}

// ./uploads holds real attachment files, and a test that deletes a card moves
// its files. Nothing below may run with the uploads folder there, or anywhere
// else in the repository.
// The folder the configuration named is remembered, in case a process is ever
// given a second test file: UPLOADS_DIR is changed below.
const uploadsBase = (process.env.TEST_UPLOADS_BASE ??= process.env.UPLOADS_DIR ?? '');
const outsideRepo = (dir: string) => {
	const fromRepo = relative(process.cwd(), resolve(dir));
	return fromRepo === '..' || fromRepo.startsWith(`..${sep}`) || isAbsolute(fromRepo);
};
if (!uploadsBase || !outsideRepo(uploadsBase)) {
	throw new Error(
		`Tests must keep attachment files outside the repository, but UPLOADS_DIR is "${uploadsBase ?? ''}". ` +
			'Run them through vitest (npm test), which sets it to a folder under the temp directory.'
	);
}
// Test files run side by side, each in its own process, and each makes card 1.
// So each has a folder of its own under the one the configuration names, and
// the application is pointed at that before anything asks where uploads go.
mkdirSync(uploadsBase, { recursive: true });
const uploadsHere = mkdtempSync(join(resolve(uploadsBase), 'file-'));
process.env.UPLOADS_DIR = uploadsHere;
afterAll(() => {
	try {
		rmSync(uploadsHere, { recursive: true, force: true });
	} catch {
		// Left in the temp folder.
	}
});

// Nothing in a test may reach the network. A webhook is delivered with `fetch`
// and a mail goes to a host whose address is looked up first. The application
// catches the failure of either, so a test that attempted one passed all the
// same, having waited on a resolver for a name that does not exist. Both are
// replaced here, before anything runs: an attempt is refused at once, and it
// fails the test that made it, by the address. A test that is about a webhook
// or a mail installs `effects()` (tests/helpers/effects.ts), which records it
// and puts this back afterwards.
//
// Assigned, and not spied on with `vi.spyOn`: several test files call
// `vi.restoreAllMocks()`, which would take a spy off again.
const attempts: string[] = [];
const refused = (what: string, address: unknown): Error => {
	attempts.push(`${what} ${String(address)}`);
	return Object.assign(new Error(`A test attempted ${what} ${String(address)}: nothing in a test may reach the network`), {
		code: 'ECONNREFUSED'
	});
};

globalThis.fetch = (async (input: RequestInfo | URL) => {
	throw refused('a fetch of', input instanceof Request ? input.url : input);
}) as typeof fetch;

// Every way of asking for an address: `dns.lookup`, which a socket uses, and
// the resolver's own questions, which nodemailer asks first.
const LOOKUPS = [
	'lookup',
	'resolve',
	'resolve4',
	'resolve6',
	'resolveAny',
	'resolveCname',
	'resolveMx',
	'resolveNs',
	'resolveSrv',
	'resolveTxt',
	'reverse'
];
type Asked = Record<string, (...args: unknown[]) => unknown>;
for (const name of LOOKUPS) {
	// With a callback: the module's own functions, and a `Resolver` made from it.
	for (const target of [dns, dns.Resolver.prototype] as unknown as Asked[]) {
		target[name] = (...args: unknown[]) => {
			const failure = refused('a DNS lookup of', args[0]);
			const callback = args.at(-1);
			if (typeof callback === 'function') process.nextTick(() => callback(failure));
		};
	}
	// With a promise.
	for (const target of [dns.promises, dns.promises.Resolver.prototype] as unknown as Asked[]) {
		target[name] = async (...args: unknown[]) => {
			throw refused('a DNS lookup of', args[0]);
		};
	}
}

/** Fail with every attempt made since the last time this was asked. */
function failOnAttempts(when: string): void {
	if (attempts.length === 0) return;
	const made = attempts.splice(0);
	throw new Error(
		`${when} reached for the network: ${made.join(', ')}. ` +
			'Install effects() from tests/helpers/effects.ts, which records a webhook or a mail and sends neither.'
	);
}

afterEach(async () => {
	// A notification starts on a later turn of the event loop than the request
	// that caused it: let it start, so that it is this test it fails.
	for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
	failOnAttempts('This test');
});
// Whatever started later still, after the last test of the file.
afterAll(() => failOnAttempts('A test in this file'));

// Every timestamp a test leaves in the database is in the stored form,
// `YYYY-MM-DD HH:MM:SS` in UTC, or NULL (card 2095, decision 13 and R2): the
// test that left another form fails, naming each value, and that is how a
// write path that still writes another form is found. A test that writes one
// on purpose says so with `allowOtherTimestampForms()`. Registered after the
// hook above, so it runs before it: vitest runs `afterEach` hooks as a stack,
// the last registered first, and a test file's own `afterEach` before both.
// So a test file's `afterEach` that empties the database makes the check
// itself first, or the check sees nothing: backups, import-working-copy and
// migrations do. Nor may one forget the allowance.
afterEach(() => afterEachTimestampCheck(sqlite));

// Throws on the first migration that fails, which fails every test in the file.
runMigrations();

// Belt and braces: the runner returned, so every file on disk should now be
// recorded as applied. This says so independently of the runner's own account.
const onDisk = readdirSync(join(process.cwd(), 'drizzle'))
	.filter((f) => f.endsWith('.sql'))
	.sort();
const applied = new Set(
	(sqlite.prepare('SELECT hash FROM __drizzle_migrations').all() as { hash: string }[]).map(
		(r) => r.hash
	)
);
const missing = onDisk.filter((f) => !applied.has(f));
if (missing.length > 0) {
	throw new Error(
		`${missing.length} migration(s) did not apply to a fresh database: ${missing.join(', ')}`
	);
}
