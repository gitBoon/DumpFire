/**
 * Invite tokens stored as hashes (card 2849).
 *
 * An invite's token was kept as it was mailed, and was looked up by that text.
 * Since card 2769 a working invite also sets up the account's authenticator,
 * so whoever could read the database file could take any invited account
 * whole. Now `issueInvite` keeps only the token's SHA-256, as its 32 bytes (a
 * BLOB), and returns the token for the mail, and `usableInvite` looks up the
 * hash of the token in the address, exactly as it is given
 * (src/lib/server/invites.ts). An image from before the card compares the
 * column with the address, which is text, and SQLite never takes a BLOB to
 * equal text: so no stored hash is a link there either.
 *
 * An image from before the card, started on this database after going back,
 * keeps an invite's token as mailed. Each start of this one ends every unused
 * invite held in plain and replaces the token of every used one
 * (`endPlainInvites`, in src/lib/server/startup-checks.ts).
 *
 * The cases are the plan's T1, T2, T3, T6, T8 and T9
 * (`docs/planning/card-2849-invite-tokens-hashed.md`, section 5), and T10 of
 * the code review (CR1). T4 is in tests/migrations.test.ts, and T5 and T7 in
 * tests/backups.test.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { inviteTokens, settings } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { issueInvite } from '$lib/server/invites';
import { endPlainInvites } from '$lib/server/startup-checks';
import { load as loadInvitePage } from '../src/routes/invite/[token]/+page.server';
import { action } from './helpers/actions';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { FIXTURE_PASSWORD, makeSession, makeSmtp, makeUser, resetDb, stepUpCode } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

const APP = 'https://kanban.example.test';
const NEW = 'a new password for the invite';
const LATER = '2099-01-01 00:00:00';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The SHA-256 of `text`, its 32 bytes: the form an invite is kept in. */
const digestOf = (text: string) => createHash('sha256').update(text).digest();

/** Whether a value read from `invite_tokens.token` is in that form. */
const inHashForm = (value: unknown) => Buffer.isBuffer(value) && value.length === 32;

/** What the invite page loads for `token`: the form, or `{ valid: false }` for a link that does not work. */
const pageFor = (token: string) => loadInvitePage({ params: { token } } as never);

/** Every row of `invite_tokens`, as the database holds it. */
const inviteRows = () => sqlite.prepare('SELECT * FROM invite_tokens ORDER BY created_at, token').all();

/**
 * Whether `text` holds the token, or any 16 characters of it, in any case,
 * its hyphens read back from `%2D`, `&#45;` and `&#x2D;` as a reader would.
 */
function holdsPieceOf(text: string, token: string): boolean {
	const lower = text.toLowerCase().replace(/%2d|&#0*45;|&#x0*2d;/g, '-');
	const secret = token.toLowerCase();
	for (let at = 0; at + 16 <= secret.length; at++) if (lower.includes(secret.slice(at, at + 16))) return true;
	return false;
}

/** Run `act` with every line logged, INFO and up, and the console quiet. */
async function logging<T>(act: () => Promise<T> | T): Promise<T> {
	const level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	const spies = (['log', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
	try {
		return await act();
	} finally {
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
		for (const spy of spies) spy.mockRestore();
	}
}

/** The lines `system_logs` holds under `context`, from `after` on. */
const linesUnder = (context: string, after = 0) =>
	sqlite
		.prepare('SELECT level, message, meta FROM system_logs WHERE context = ? AND id > ? ORDER BY id')
		.all(context, after) as { level: string; message: string; meta: string | null }[];

const lastLogId = () => (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM system_logs').get() as { id: number }).id;

let admin: SessionUser;
let invitee: SessionUser;

beforeEach(() => {
	resetDb();
	admin = makeUser({ username: 'admin', role: 'admin' });
	invitee = makeUser({ username: 'ana' });
});

describe('an invite, kept as the hash of its token', () => {
	it('T1: is written as the SHA-256 of the token it returns, and the token is in no row', () => {
		const token = inTransaction(() => issueInvite(invitee.id));

		expect(token).toMatch(UUID);
		const rows = db.select().from(inviteTokens).where(eq(inviteTokens.userId, invitee.id)).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].tokenHash).toEqual(digestOf(token));
		expect(sqlite.prepare('SELECT typeof(token) AS type, length(token) AS bytes FROM invite_tokens').all()).toEqual([
			{ type: 'blob', bytes: 32 }
		]);
		expect(JSON.stringify(inviteRows())).not.toContain(token);
	});

	it('T2: is no link by its stored hash: the page is the dead-link page, and the form answers 400 with nothing written', async () => {
		const token = inTransaction(() => issueInvite(invitee.id));
		// The column as whoever reads the file reads it, written out as hex.
		const stored = Buffer.from(sqlite.prepare('SELECT token FROM invite_tokens WHERE user_id = ?').pluck().get(invitee.id) as Buffer).toString('hex');
		// The token itself is a link, so the refusal below is of the hash alone.
		expect(await pageFor(token)).toMatchObject({ valid: true, username: 'ana' });
		const before = snapshotDb();

		expect(await pageFor(stored)).toEqual({ valid: false, username: '' });
		const res = await action(`/invite/${stored}`, { form: { password: NEW, confirmPassword: NEW } });

		expect(res).toMatchObject({ type: 'failure', status: 400, data: { error: expect.stringMatching(/^This invite link no longer works\./) } });
		expectUnchanged(before);
	});

	it('T3: is looked up by the token exactly as given: the token upper-cased is the dead-link page', async () => {
		const token = inTransaction(() => issueInvite(invitee.id));

		expect(await pageFor(token)).toMatchObject({ valid: true });
		expect(await pageFor(token.toUpperCase())).toEqual({ valid: false, username: '' });
	});

	it('T10: is no link to an older image: its lookup, the column compared with the address as text, finds no row for the token, the hash in hex, or the stored bytes read as text', () => {
		const token = inTransaction(() => issueInvite(invitee.id));
		const stored = sqlite.prepare('SELECT token FROM invite_tokens WHERE user_id = ?').pluck().get(invitee.id) as Buffer;
		// How an image from before card 2849 looks an invite up: the column
		// compared with the address, which SvelteKit gives as a string.
		const olderImage = sqlite.prepare('SELECT user_id FROM invite_tokens WHERE token = ?');
		const hex = digestOf(token).toString('hex');
		const bytes = Buffer.from(stored);

		for (const address of [token, hex, hex.toUpperCase(), bytes.toString('latin1'), bytes.toString('utf8'), bytes.toString('binary')]) {
			expect(olderImage.get(address), JSON.stringify(address)).toBeUndefined();
		}
		// What it is not: a value of the same type, which would be found.
		expect(inHashForm(stored)).toBe(true);
		expect(olderImage.get(stored)).toEqual({ user_id: invitee.id });
	});
});

describe('an invite issued and used, in the log', () => {
	let sent: Effects | null = null;

	beforeEach(() => {
		makeSmtp();
		db.insert(settings).values({ key: 'app_url', value: APP }).run();
	});

	afterEach(() => {
		sent?.restore();
		sent = null;
	});

	it('T6: the mail answer’s WARN and the invite’s INFO hold neither the token nor any 16 characters of it', async () => {
		// The mail server refuses, so the route writes its WARN and gives the link.
		sent = effects({ mailRefusal: () => Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }) });
		const from = lastLogId();

		const issued = await logging(() =>
			api('POST', `/api/users/${invitee.id}/invite`, {
				user: admin,
				body: { currentPassword: FIXTURE_PASSWORD, currentCode: stepUpCode(admin) },
				headers: { cookie: `${SESSION_COOKIE_NAME}=${makeSession(admin)}` }
			})
		);
		expect(issued.status).toBe(200);
		const link: string = issued.body.inviteUrl;
		const token = link.slice(link.lastIndexOf('/') + 1);
		expect(token).toMatch(UUID);

		const used = await logging(() => action(`/invite/${token}`, { form: { password: NEW, confirmPassword: NEW } }));
		expect(used).toMatchObject({ type: 'redirect', status: 303, location: '/login/enrol' });

		// Those two among them, and no AUTH line of the two requests holds it.
		const lines = linesUnder('AUTH', from);
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: 'WARN',
					message: expect.stringMatching(new RegExp(`^Invite for user ${invitee.id} was issued by user ${admin.id}; its mail was not sent`))
				}),
				expect.objectContaining({ level: 'INFO', message: expect.stringMatching(new RegExp(`^Password set with an invite for user ${invitee.id} `)) })
			])
		);
		for (const line of lines) expect(holdsPieceOf(JSON.stringify(line), token), line.message).toBe(false);
	});
});

describe('endPlainInvites, at every start', () => {
	it('T8: ends the unused invites an older image wrote, gives the used ones a token in hash form, leaves those in hash form, says so once, and the next start does nothing', async () => {
		const third = makeUser({ username: 'cat' });
		const plain = crypto.randomUUID();
		// Text of a hash's length is not a hash: the type is asked first.
		const textOf32 = 'ab'.repeat(16);
		const hashed = digestOf(crypto.randomUUID());
		const usedPlain = crypto.randomUUID();
		// Nor is a BLOB one byte short.
		const usedShort = randomBytes(31);
		const usedHashed = digestOf(crypto.randomUUID());
		const write = sqlite.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, ?)');
		write.run(plain, invitee.id, LATER, 0);
		write.run(textOf32, third.id, LATER, 0);
		write.run(hashed, admin.id, LATER, 0);
		write.run(usedPlain, invitee.id, LATER, 1);
		write.run(usedShort, third.id, LATER, 1);
		write.run(usedHashed, admin.id, LATER, 1);
		const from = lastLogId();

		const changed = logging(() => endPlainInvites());

		expect(await changed).toBe(4);
		const rows = sqlite.prepare('SELECT token, user_id AS userId, used FROM invite_tokens ORDER BY used, user_id').all() as {
			token: unknown;
			userId: number;
			used: number;
		}[];
		expect(rows.map(({ userId, used }) => ({ userId, used }))).toEqual([
			{ userId: admin.id, used: 0 },
			{ userId: admin.id, used: 1 },
			{ userId: invitee.id, used: 1 },
			{ userId: third.id, used: 1 }
		]);
		for (const row of rows) expect(inHashForm(row.token), JSON.stringify(row)).toBe(true);
		expect(rows[0].token).toEqual(hashed);
		expect(rows[1].token).toEqual(usedHashed);
		expect(rows[3].token).not.toEqual(Buffer.concat([usedShort, Buffer.alloc(1)]));
		const everything = JSON.stringify(inviteRows());
		for (const gone of [plain, textOf32, usedPlain]) expect(everything).not.toContain(gone);
		expect(linesUnder('AUTH', from)).toEqual([
			{
				level: 'WARN',
				message: expect.stringMatching(/^Ended 2 invite\(s\) held in plain.*Send again.* Replaced the token of 2 used invite\(s\) held in plain/),
				meta: null
			}
		]);
		expect(await pageFor(plain)).toEqual({ valid: false, username: '' });

		const before = snapshotDb();
		const again = lastLogId();
		expect(await logging(() => endPlainInvites())).toBe(0);
		expectUnchanged(before);
		expect(linesUnder('AUTH', again)).toEqual([]);

		// With only a used invite held in plain, the line says only that (the
		// code review, CS1): no invite ended, nothing to send again.
		write.run(crypto.randomUUID(), invitee.id, LATER, 1);
		const onlyUsed = lastLogId();
		expect(await logging(() => endPlainInvites())).toBe(1);
		expect(linesUnder('AUTH', onlyUsed)).toEqual([
			{ level: 'WARN', message: expect.stringMatching(/^Replaced the token of 1 used invite\(s\) held in plain/), meta: null }
		]);
		expect(linesUnder('AUTH', onlyUsed)[0].message).not.toMatch(/Ended|Send again/);
	});

	it('T9: cannot keep the server from starting: a failure is said at WARN, null is returned, and nothing is thrown', () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const said = vi.spyOn(console, 'warn').mockImplementation(() => {});
		// The logger cannot keep the line either, and says so on the console.
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const prepare = vi.spyOn(sqlite, 'prepare').mockImplementation(() => {
			throw new Error('the database is not to be had');
		});

		let lines: string[];
		try {
			expect(endPlainInvites()).toBeNull();
			lines = said.mock.calls.map(([line]) => String(line));
		} finally {
			// Before the check after every test, which reads the database.
			prepare.mockRestore();
			quiet.mockRestore();
			said.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(lines).toEqual([
			expect.stringMatching(/\[WARN\] \[AUTH\] Invites held in plain by an older image could not be ended: the database is not to be had\./)
		]);

		// When only the replacement fails, the deletes made before it are rolled
		// back with it (the code review, CR2): the two are one transaction.
		const plain = crypto.randomUUID();
		sqlite.prepare('INSERT INTO invite_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(plain, invitee.id, LATER);
		const real = sqlite.prepare.bind(sqlite);
		const onlyTheUpdate = vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (source.startsWith('UPDATE invite_tokens')) throw new Error('the replacement is not to be had');
			return real(source);
		}) as typeof sqlite.prepare);
		try {
			expect(endPlainInvites()).toBeNull();
		} finally {
			onlyTheUpdate.mockRestore();
		}
		expect(sqlite.prepare('SELECT token FROM invite_tokens').pluck().all()).toEqual([plain]);
	});
});
