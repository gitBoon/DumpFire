/**
 * Cards 2397 and 2398: the settings that send mail and backups somewhere.
 *
 * Card 2398. Any administrator could lower Keep Last to 1 and press Run Now,
 * which deletes every older copy at every destination, or remove the
 * destinations, or switch the schedule off: logged (card 2270), not
 * prevented. Now `PUT /api/admin/backup` refuses a save that lowers Keep Last,
 * removes a destination (a rename, or another type under the name, is the old
 * one removed) or switches the schedule off, `403`, for anyone but the
 * superadmin, asked of the account as it is at the write. Everything else an
 * administrator did is still theirs.
 *
 * Card 2397. Nothing recorded who saved the mail settings, the App URL or a
 * destination, so a demoted or deleted administrator's server went on
 * receiving every mail and backup. Now `setting_setters` (migration 0059)
 * names who last changed each, and demoting that account to user, or deleting
 * it, removes what it set in the same transaction, with a WARN line under
 * SMTP or BACKUP and `settingsRemoved` in the answer. A setting nobody is
 * recorded for, as one saved before the migration, stays.
 *
 * Card 2406. A role written to `user` from the host runs none of that, so
 * every start removes what a setter who is no longer an administrator set
 * (`removeSettingsOfNonAdministrators`), and what a setter whose account is
 * gone set, where a delete with foreign keys off left the rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { settingSetters, settings, users } from '$lib/server/db/schema';
import { settingsHeldBy } from '$lib/server/setting-setters';
import { removeSettingsOfNonAdministrators } from '$lib/server/startup-checks';
import { load as loadAdminPage } from '../src/routes/admin/+page.server';
import type { SessionUser } from '$lib/server/auth';
import { api } from './helpers/api';
import { sendAround } from './helpers/held-body';
import { makeSession, makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb, type DbSnapshot } from './helpers/snapshot';

/** The three destinations of the scene: chief's, ann's and one saved before 0059. */
const s3 = (name: string, bucket: string) => ({
	type: 's3',
	name,
	region: 'eu-west-2',
	bucket,
	accessKeyId: `AKIA-${bucket}`,
	secretAccessKey: `secret-${bucket}`,
	prefix: 'dumpfire/'
});
const OLD = s3('Old', 'old-bucket');
/** An SFTP server's key as `ssh-keygen -l` prints it. */
const HOST_KEY = 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY';
const ANNS = s3("Ann's", 'ann-bucket');
const BOBS = s3("Bob's", 'bob-bucket');

const CONFIG = { schedule: 'daily', scheduleTime: '02:00', scheduleDay: 0, retention: 7, notifyOnFailure: false, notifyEmail: '' };

/** The words of card 2398's refusal before what the save would do. */
const RULE = 'Lowering Keep Last, removing a destination or switching the schedule off needs the superadmin.';
const RENAMED = '(a destination renamed, or saved as another type, is the old one removed)';

type Who = { user: SessionUser; credential: { kind: 'session'; token: string } };
const as = (user: SessionUser): Who => ({ user, credential: { kind: 'session', token: makeSession(user) } });

/**
 * Whose each setting is now, as a demotion would read it (`settingsHeldBy`):
 * the account recorded for the place it is at (the second code review). A
 * setting at a place nobody is recorded for, or not stored, is nobody's.
 */
const setters = () =>
	[...settingsHeldBy()]
		.flatMap(([userId, held]) => [
			...(held.mail ? [{ setting: 'mail', userId }] : []),
			...(held.appUrl ? [{ setting: 'app_url', userId }] : []),
			...held.destinations.map((name) => ({ setting: `backup_destination:${name}`, userId }))
		])
		.sort((a, b) => (a.setting < b.setting ? -1 : a.setting > b.setting ? 1 : 0));
/** The setter rows as stored, each place an account was recorded for. */
const rows = () => sqlite.prepare('SELECT setting, user_id AS userId FROM setting_setters ORDER BY setting, user_id').all();
const lines = () =>
	sqlite
		.prepare("SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE context IN ('SMTP', 'BACKUP') ORDER BY id")
		.all() as { level: string; context: string; message: string; meta: string | null; userId: number | null }[];
const setting = (key: string) => db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
const stored = () => JSON.parse(setting('backup_config')!) as typeof CONFIG & { destinations: Record<string, unknown>[] };
const names = () => stored().destinations.map((d) => d.name);
const roleOf = (user: SessionUser) => db.select({ role: users.role }).from(users).where(eq(users.id, user.id)).get()?.role;

let chief: SessionUser;
let ann: SessionUser;
let bob: SessionUser;
/** The suite runs at LOG_LEVEL=ERROR (vitest.config.ts); these tests read WARN lines. */
let level: string | undefined;

afterEach(() => {
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
});

beforeEach(() => {
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	resetDb();
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	ann = makeUser({ username: 'ann', role: 'admin' });
	bob = makeUser({ username: 'bob', role: 'admin' });
	db.insert(settings)
		.values({ key: 'backup_config', value: JSON.stringify({ ...CONFIG, destinations: [OLD] }) })
		.run();
});

/** The destinations as the panel sends them back: the GET's, secrets masked. */
async function shown(who: Who): Promise<Record<string, unknown>[]> {
	const res = await api('GET', '/api/admin/backup', who);
	expect(res.status).toBe(200);
	return res.body.destinations;
}

// ─── Card 2398 ───────────────────────────────────────────────────────────────

// The first request loads the route modules, which can take seconds when the whole suite runs at once.
describe('lowering Keep Last, removing a destination and switching the schedule off are the superadmin’s (card 2398)', { timeout: 30_000 }, () => {
	/** Each save an administrator is refused, with the words that say what it would do. */
	const REFUSED: { name: string; body: (dests: Record<string, unknown>[]) => unknown; would: string }[] = [
		{ name: 'Keep Last lowered', body: () => ({ retention: 1 }), would: 'lower Keep Last from 7 to 1' },
		{ name: 'a destination removed', body: () => ({ destinations: [] }), would: `remove the destination "Old" ${RENAMED}` },
		{
			name: 'a destination renamed',
			body: (dests) => ({ destinations: [{ ...dests[0], name: 'Renamed', secretAccessKey: 'typed-again' }] }),
			would: `remove the destination "Old" ${RENAMED}`
		},
		{ name: 'the schedule switched off', body: () => ({ schedule: 'disabled' }), would: 'switch the schedule off' },
		{
			name: 'all three at once',
			body: () => ({ retention: 3, schedule: 'disabled', destinations: [] }),
			would: `lower Keep Last from 7 to 3, and remove the destination "Old" ${RENAMED}, and switch the schedule off`
		}
	];

	it.each(REFUSED)('refuses an administrator $name, 403 in plain words, with nothing written and no line', async ({ body, would }) => {
		const who = as(ann);
		const sent = body(await shown(who));
		const before = snapshotDb();
		const linesBefore = lines();

		const res = await api('PUT', '/api/admin/backup', { ...who, body: sent });

		expect({ status: res.status, body: res.body }).toEqual({ status: 403, body: { message: `${RULE} This save would ${would}.` } });
		expectUnchanged(before);
		expect(lines()).toEqual(linesBefore);
	});

	it.each(REFUSED)('lets the superadmin make the same save: $name', async ({ body }) => {
		const who = as(chief);
		const res = await api('PUT', '/api/admin/backup', { ...who, body: body(await shown(who)) });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
	});

	it('lets an administrator raise Keep Last, change between schedules that run, add a destination and edit one', async () => {
		const who = as(ann);

		expect((await api('PUT', '/api/admin/backup', { ...who, body: { retention: 9 } })).status).toBe(200);
		expect((await api('PUT', '/api/admin/backup', { ...who, body: { schedule: 'hourly' } })).status).toBe(200);
		expect((await api('PUT', '/api/admin/backup', { ...who, body: { schedule: 'weekly', scheduleDay: 3 } })).status).toBe(200);
		const dests = await shown(who);
		expect((await api('PUT', '/api/admin/backup', { ...who, body: { destinations: [...dests, ANNS] } })).status).toBe(200);
		// Edited in place, pointed at another bucket with its secret typed again: still an administrator's.
		const edited = (await shown(who)).map((d) => (d.name === 'Old' ? { ...d, bucket: 'moved-bucket', secretAccessKey: 'typed-again' } : d));
		const res = await api('PUT', '/api/admin/backup', { ...who, body: { destinations: edited } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored()).toMatchObject({ retention: 9, schedule: 'weekly', scheduleDay: 3 });
		expect(stored().destinations.map((d) => [d.name, d.bucket])).toEqual([
			['Old', 'moved-bucket'],
			["Ann's", 'ann-bucket']
		]);
	});

	it('refuses the superadmin made an administrator while the body arrives, at the write, with nothing written', async () => {
		const token = makeSession(chief);
		let before: DbSnapshot | undefined;

		const res = await sendAround('PUT', '/api/admin/backup', { session: token }, { retention: 2 }, () => {
			db.update(users).set({ role: 'admin' }).where(eq(users.id, chief.id)).run();
			before = snapshotDb();
		});

		expect(res).toEqual({ status: 403, body: { message: `${RULE} This save would lower Keep Last from 7 to 2.` } });
		expectUnchanged(before!);
	});

	it('lets the superadmin through when nothing changes meanwhile, sent the same way (the control)', async () => {
		const res = await sendAround('PUT', '/api/admin/backup', { session: makeSession(chief) }, { retention: 2 }, () => {});

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored().retention).toBe(2);
	});

	it('refuses an administrator made a user while the body arrives as a user is refused: Forbidden, before the rule', async () => {
		const token = makeSession(ann);
		let before: DbSnapshot | undefined;

		const res = await sendAround('PUT', '/api/admin/backup', { session: token }, { retention: 2 }, () => {
			db.update(users).set({ role: 'user' }).where(eq(users.id, ann.id)).run();
			before = snapshotDb();
		});

		expect(res).toEqual({ status: 403, body: { message: 'Forbidden' } });
		expectUnchanged(before!);
	});
});

// ─── Card 2397: who saved ───────────────────────────────────────────────────

describe('who last changed each setting is recorded (card 2397)', () => {
	it('makes whoever moves the mail the mail settings’ setter, and whoever sets the App URL to an address its own', async () => {
		expect((await api('PUT', '/api/admin/smtp', { ...as(ann), body: { host: 'smtp.ann.example', fromAddress: 'a@example.test' } })).status).toBe(200);
		expect(setters()).toEqual([{ setting: 'mail', userId: ann.id }]);

		// The App URL alone: its own row, and the mail settings stay ann's.
		expect((await api('PUT', '/api/admin/smtp', { ...as(bob), body: { appUrl: 'https://bob.example' } })).status).toBe(200);
		expect(setters()).toEqual([
			{ setting: 'app_url', userId: bob.id },
			{ setting: 'mail', userId: ann.id }
		]);

		// The last to move the mail is its setter: each of the host, port, user and way out does, the
		// password typed again with it (card 2190 asks for it).
		const moves: [SessionUser, Record<string, unknown>][] = [
			[bob, { port: 2526 }],
			[chief, { user: 'chief-mailer' }],
			[bob, { allowInsecure: true }],
			[chief, { host: 'smtp.chief.example' }]
		];
		for (const [who, move] of moves) {
			const res = await api('PUT', '/api/admin/smtp', { ...as(who), body: { ...move, pass: `typed-by-${who.username}` } });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(setters()).toEqual([
				{ setting: 'app_url', userId: bob.id },
				{ setting: 'mail', userId: who.id }
			]);
		}
	});

	// The card 2397 review: an administrator who corrected one field of the superadmin's mail became its setter.
	it('makes nobody the setter by a sender’s name or address, or a password typed again alone', async () => {
		await api('PUT', '/api/admin/smtp', { ...as(chief), body: { host: 'smtp.chief.example', pass: 'chief-secret' } });
		expect(setters()).toEqual([{ setting: 'mail', userId: chief.id }]);

		for (const body of [{ fromName: 'Ann was here' }, { fromAddress: 'ann@example.test' }, { pass: 'typed-by-ann' }]) {
			const res = await api('PUT', '/api/admin/smtp', { ...as(ann), body });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
		}

		expect(setting('smtp_from_name')).toBe('Ann was here');
		expect(setting('smtp_pass')).toBe('typed-by-ann');
		expect(setters()).toEqual([{ setting: 'mail', userId: chief.id }]);
	});

	it('makes nobody the App URL’s setter by clearing it', async () => {
		await api('PUT', '/api/admin/smtp', { ...as(bob), body: { appUrl: 'https://bob.example' } });

		const res = await api('PUT', '/api/admin/smtp', { ...as(ann), body: { appUrl: '' } });

		expect(res.status).toBe(200);
		expect(setting('app_url')).toBe('');
		// Bob's row stays, for the address he set; none is ann's, and a cleared App URL is nobody's.
		expect(rows()).toEqual([{ setting: 'app_url', userId: bob.id }]);
		expect(setters()).toEqual([]);
	});

	it('records nothing for a save that changes nothing, as a mail reads it', async () => {
		await api('PUT', '/api/admin/smtp', { ...as(ann), body: { host: 'smtp.ann.example', appUrl: 'https://ann.example' } });

		const res = await api('PUT', '/api/admin/smtp', { ...as(bob), body: { host: 'smtp.ann.example', port: 587, appUrl: 'https://ann.example' } });

		expect(res.status).toBe(200);
		expect(setters()).toEqual([
			{ setting: 'app_url', userId: ann.id },
			{ setting: 'mail', userId: ann.id }
		]);
	});

	it('makes whoever adds or changes a destination its setter, drops the row of one removed, and records none for one left as it was', async () => {
		const added = await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: [...(await shown(as(ann))), ANNS] } });
		expect(added.status).toBe(200);
		// "Old" was saved before 0059 and is sent back unchanged: nobody's still.
		expect(setters()).toEqual([{ setting: "backup_destination:Ann's", userId: ann.id }]);

		const dests = await shown(as(bob));
		// Another prefix is another place: its secret is typed again (card 2190).
		const changed = dests.map((d) => (d.name === 'Old' ? { ...d, prefix: 'elsewhere/', secretAccessKey: 'typed-again' } : d));
		expect((await api('PUT', '/api/admin/backup', { ...as(bob), body: { destinations: [...changed, BOBS] } })).status).toBe(200);
		expect(setters()).toEqual([
			{ setting: "backup_destination:Ann's", userId: ann.id },
			{ setting: "backup_destination:Bob's", userId: bob.id },
			{ setting: 'backup_destination:Old', userId: bob.id }
		]);

		// The superadmin removes ann's and renames bob's: the old names' rows go, the new name is chief's.
		const now = await shown(as(chief));
		const kept = now.filter((d) => d.name !== "Ann's").map((d) => (d.name === "Bob's" ? { ...d, name: 'Renamed', secretAccessKey: 'typed-again' } : d));
		expect((await api('PUT', '/api/admin/backup', { ...as(chief), body: { destinations: kept } })).status).toBe(200);
		expect(setters()).toEqual([
			{ setting: 'backup_destination:Old', userId: bob.id },
			{ setting: 'backup_destination:Renamed', userId: chief.id }
		]);
	});

	// The card 2397 review: a secret typed again, or a host key confirmed, made an administrator the setter.
	it('makes nobody a destination’s setter by a secret typed again for the same place or an SFTP host key confirmed, and whoever points it elsewhere its setter', async () => {
		const BOX = { type: 'sftp', name: 'Box', host: 'box.example.test', port: 22, username: 'backup', password: 'box-secret', remotePath: '/backups' };
		const added = await api('PUT', '/api/admin/backup', { ...as(chief), body: { destinations: [...(await shown(as(chief))), ANNS, BOX] } });
		expect(added.status, JSON.stringify(added.body)).toBe(200);
		const chiefs = [
			{ setting: "backup_destination:Ann's", userId: chief.id },
			{ setting: 'backup_destination:Box', userId: chief.id }
		];
		expect(setters()).toEqual(chiefs);

		// Ann types the S3 secret again and confirms the SFTP server's key: the same places.
		const same = (await shown(as(ann))).map((d) =>
			d.name === "Ann's" ? { ...d, secretAccessKey: 'typed-by-ann' } : d.name === 'Box' ? { ...d, hostKey: HOST_KEY } : d
		);
		const kept = await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: same } });
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(stored().destinations.find((d) => d.name === "Ann's")!.secretAccessKey).toBe('typed-by-ann');
		expect(stored().destinations.find((d) => d.name === 'Box')!.hostKey).toBe(HOST_KEY);
		expect(setters()).toEqual(chiefs);

		// Bob points the S3 destination at another bucket: his.
		const moved = (await shown(as(bob))).map((d) => (d.name === "Ann's" ? { ...d, bucket: 'bob-bucket', secretAccessKey: 'typed-by-bob' } : d));
		expect((await api('PUT', '/api/admin/backup', { ...as(bob), body: { destinations: moved } })).status).toBe(200);
		expect(setters()).toEqual([
			{ setting: "backup_destination:Ann's", userId: bob.id },
			{ setting: 'backup_destination:Box', userId: chief.id }
		]);
	});

	it('records nothing for a refused save', async () => {
		const who = as(ann);
		const before = snapshotDb();

		const res = await api('PUT', '/api/admin/backup', { ...who, body: { retention: 1, destinations: [ANNS] } });

		expect(res.status).toBe(403);
		expectUnchanged(before);
		expect(setters()).toEqual([]);
	});
});

// ─── Card 2397: what goes ───────────────────────────────────────────────────

describe('demoting or deleting the setter removes what they set (card 2397)', () => {
	/**
	 * Ann sets the mail, the App URL and a destination; bob a destination; "Old"
	 * is nobody's. Through the routes, as the panels save them.
	 */
	async function annsSettings(): Promise<void> {
		const mail = await api('PUT', '/api/admin/smtp', {
			...as(ann),
			body: { host: 'smtp.ann.example', port: 2525, user: 'ann-mailer', pass: 'ann-mail-secret', fromAddress: 'a@example.test', appUrl: 'https://ann.example' }
		});
		expect(mail.status).toBe(200);
		expect((await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: [...(await shown(as(ann))), ANNS] } })).status).toBe(200);
		expect((await api('PUT', '/api/admin/backup', { ...as(bob), body: { destinations: [...(await shown(as(bob))), BOBS] } })).status).toBe(200);
		expect(setters()).toEqual([
			{ setting: 'app_url', userId: ann.id },
			{ setting: "backup_destination:Ann's", userId: ann.id },
			{ setting: "backup_destination:Bob's", userId: bob.id },
			{ setting: 'mail', userId: ann.id }
		]);
	}

	const SMTP_ROWS = () => sqlite.prepare("SELECT key FROM settings WHERE key LIKE 'smtp%' ORDER BY key").pluck().all();

	/** What the removal leaves, whichever way ann goes. */
	function expectAnnsGone(by: 'made a user' | 'deleted', linesBefore: number): void {
		expect(SMTP_ROWS()).toEqual([]);
		expect(setting('app_url')).toBeNull();
		expect(names()).toEqual(['Old', "Bob's"]);
		// Her destination's stored secret is nowhere in the settings any more.
		expect(setting('backup_config')).not.toContain('secret-ann-bucket');
		expect(setters()).toEqual([{ setting: "backup_destination:Bob's", userId: bob.id }]);

		const because = by === 'made a user' ? 'who was made a user by "chief"' : 'whose account was deleted by "chief"';
		const reason = by === 'made a user' ? 'demoted' : 'deleted';
		expect(lines().slice(linesBefore)).toEqual([
			{
				level: 'WARN',
				context: 'SMTP',
				message:
					`The mail settings and the App URL removed: saved by "ann", ${because}. No mail is sent until an administrator sets the mail up again. ` +
					"Links in mail use APP_URL, or the server's own address, until an App URL is saved again.",
				meta: JSON.stringify({ setter: ann.id, reason, mail: true, appUrl: true }),
				userId: chief.id
			},
			{
				level: 'WARN',
				context: 'BACKUP',
				message: `Backup destination "Ann's" (s3) removed: saved by "ann", ${because}. Its stored secrets went with it; the copies already there are kept.`,
				meta: JSON.stringify({ setter: ann.id, reason, destinations: [{ name: "Ann's", type: 's3' }] }),
				userId: chief.id
			}
		]);
	}

	it('removes exactly the demoted administrator’s mail settings, App URL and destinations, logs it, and says so in the answer', async () => {
		await annsSettings();
		const linesBefore = lines().length;

		const res = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: ann.id, role: 'user', settingsRemoved: { mail: true, appUrl: true, destinations: ["Ann's"] } });
		expect(roleOf(ann)).toBe('user');
		expectAnnsGone('made a user', linesBefore);
		// Mail is not sent now: there is no host.
		const mail = await api('GET', '/api/admin/smtp', as(chief));
		expect(mail.body.configured).toBe(false);
	});

	it('does the same when the account is deleted', async () => {
		await annsSettings();
		const linesBefore = lines().length;

		const res = await api('DELETE', `/api/users/${ann.id}`, as(chief));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toEqual({ success: true, settingsRemoved: { mail: true, appUrl: true, destinations: ["Ann's"] } });
		expect(roleOf(ann)).toBeUndefined();
		expectAnnsGone('deleted', linesBefore);
	});

	it('leaves settings someone else set, and settings nobody is recorded for, when an administrator who set none is demoted or deleted: no field in the answer, no line', async () => {
		await annsSettings();
		// A mail setting written before 0059 would be nobody's: here, bob's account set nothing of the mail.
		const before = { smtp: SMTP_ROWS(), app: setting('app_url'), dests: names(), setters: setters() };
		const linesBefore = lines().length;

		const demoted = await api('PUT', `/api/users/${bob.id}`, { ...as(chief), body: { role: 'user' } });
		expect(demoted.status).toBe(200);
		expect(demoted.body).toMatchObject({ settingsRemoved: { mail: false, appUrl: false, destinations: ["Bob's"] } });
		expect(SMTP_ROWS()).toEqual(before.smtp);
		expect(setting('app_url')).toBe(before.app);
		expect(names()).toEqual(['Old', "Ann's"]);

		const carol = makeUser({ username: 'carol', role: 'admin' });
		const plainDemotion = await api('PUT', `/api/users/${carol.id}`, { ...as(chief), body: { role: 'user' } });
		expect(plainDemotion.status).toBe(200);
		expect(plainDemotion.body).not.toHaveProperty('settingsRemoved');
		const deleted = await api('DELETE', `/api/users/${carol.id}`, as(chief));
		expect(deleted.body).toEqual({ success: true });
		expect(lines().slice(linesBefore).map((l) => l.context)).toEqual(['BACKUP']);
	});

	it('leaves the mail settings, the App URL and a destination saved before 0059 in force, whoever is demoted', async () => {
		db.insert(settings)
			.values([
				{ key: 'smtp_host', value: 'smtp.legacy.example' },
				{ key: 'smtp_pass', value: 'legacy-secret' },
				{ key: 'app_url', value: 'https://legacy.example' }
			])
			.run();
		const before = snapshotDb();

		const res = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });

		expect(res.status).toBe(200);
		expect(res.body).not.toHaveProperty('settingsRemoved');
		expect(SMTP_ROWS()).toEqual(['smtp_host', 'smtp_pass']);
		expect(setting('app_url')).toBe('https://legacy.example');
		expect(names()).toEqual(['Old']);
		// Only ann's role changed.
		const after = snapshotDb();
		expect(after.settings).toEqual(before.settings);
	});

	// The card 2397 review's probe: demoting an administrator deleted the superadmin's own settings and secrets.
	it('keeps the superadmin’s mail, App URL and destination through an administrator’s small edits and that administrator’s demotion', async () => {
		const CHIEFS = s3("Chief's", 'chief-bucket');
		const mail = await api('PUT', '/api/admin/smtp', {
			...as(chief),
			body: { host: 'smtp.chief.example', port: 465, user: 'chief-mailer', pass: 'chief-secret', fromAddress: 'c@example.test', appUrl: 'https://chief.example' }
		});
		expect(mail.status).toBe(200);
		expect((await api('PUT', '/api/admin/backup', { ...as(chief), body: { destinations: [...(await shown(as(chief))), CHIEFS] } })).status).toBe(200);
		const chiefs = setters();
		expect(chiefs).toEqual([
			{ setting: 'app_url', userId: chief.id },
			{ setting: "backup_destination:Chief's", userId: chief.id },
			{ setting: 'mail', userId: chief.id }
		]);

		// Ann corrects the sender's name, types the mail password again, and types the destination's secret again.
		expect((await api('PUT', '/api/admin/smtp', { ...as(ann), body: { fromName: 'Ann was here' } })).status).toBe(200);
		expect((await api('PUT', '/api/admin/smtp', { ...as(ann), body: { pass: 'typed-by-ann' } })).status).toBe(200);
		const retyped = (await shown(as(ann))).map((d) => (d.name === "Chief's" ? { ...d, secretAccessKey: 'typed-by-ann' } : d));
		expect((await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: retyped } })).status).toBe(200);
		expect(setters()).toEqual(chiefs);
		const linesBefore = lines().length;

		const res = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).not.toHaveProperty('settingsRemoved');
		expect(setting('smtp_host')).toBe('smtp.chief.example');
		expect(setting('smtp_pass')).toBe('typed-by-ann');
		expect(setting('app_url')).toBe('https://chief.example');
		expect(names()).toEqual(['Old', "Chief's"]);
		expect(stored().destinations.find((d) => d.name === "Chief's")!.secretAccessKey).toBe('typed-by-ann');
		expect(setters()).toEqual(chiefs);
		expect(lines().slice(linesBefore)).toEqual([]);
	});

	// The card 2397 second review: where no secret has to be typed again, an administrator who
	// changed a setting and changed it back had taken it over, and their demotion removed it.
	describe('a setting changed and changed back (the second code review)', () => {
		const KEYLESS = { type: 's3', name: 'Keyless', region: 'eu-west-2', bucket: 'chief-bucket', prefix: 'a/' };
		/** The superadmin's passwordless relay, keyless S3 destination and App URL; each move of ann's is one save. */
		async function chiefsAndAnnsMoves(moves: { port: number; prefix: string; appUrl: string }[]): Promise<void> {
			const mail = await api('PUT', '/api/admin/smtp', {
				...as(chief),
				body: { host: 'relay.chief.example', port: 25, fromAddress: 'c@example.test', appUrl: 'https://chief.example' }
			});
			expect(mail.status, JSON.stringify(mail.body)).toBe(200);
			const added = await api('PUT', '/api/admin/backup', { ...as(chief), body: { destinations: [...(await shown(as(chief))), KEYLESS] } });
			expect(added.status, JSON.stringify(added.body)).toBe(200);
			expect(setters()).toEqual([
				{ setting: 'app_url', userId: chief.id },
				{ setting: 'backup_destination:Keyless', userId: chief.id },
				{ setting: 'mail', userId: chief.id }
			]);
			for (const { port, prefix, appUrl } of moves) {
				const moved = await api('PUT', '/api/admin/smtp', { ...as(ann), body: { port, appUrl } });
				expect(moved.status, JSON.stringify(moved.body)).toBe(200);
				const dests = (await shown(as(ann))).map((d) => (d.name === 'Keyless' ? { ...d, prefix } : d));
				const saved = await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: dests } });
				expect(saved.status, JSON.stringify(saved.body)).toBe(200);
			}
		}

		it('leaves the passwordless relay, the keyless S3 destination and the App URL the superadmin’s, and ann’s demotion removes none of them', async () => {
			await chiefsAndAnnsMoves([
				{ port: 26, prefix: 'b/', appUrl: 'https://ann.example' },
				{ port: 25, prefix: 'a/', appUrl: 'https://chief.example' }
			]);
			expect(setters()).toEqual([
				{ setting: 'app_url', userId: chief.id },
				{ setting: 'backup_destination:Keyless', userId: chief.id },
				{ setting: 'mail', userId: chief.id }
			]);
			const linesBefore = lines().length;

			const res = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).not.toHaveProperty('settingsRemoved');
			expect(setting('smtp_host')).toBe('relay.chief.example');
			expect(setting('smtp_port')).toBe('25');
			expect(setting('app_url')).toBe('https://chief.example');
			expect(stored().destinations.find((d) => d.name === 'Keyless')).toMatchObject({ prefix: 'a/' });
			expect(lines().slice(linesBefore)).toEqual([]);
			// And they are still the superadmin's: chief's own rows stay.
			expect(setters()).toEqual([
				{ setting: 'app_url', userId: chief.id },
				{ setting: 'backup_destination:Keyless', userId: chief.id },
				{ setting: 'mail', userId: chief.id }
			]);
		});

		it('makes ann the setter of each where she moves it and leaves it there, and her demotion removes them (the control)', async () => {
			await chiefsAndAnnsMoves([{ port: 26, prefix: 'b/', appUrl: 'https://ann.example' }]);
			expect(setters()).toEqual([
				{ setting: 'app_url', userId: ann.id },
				{ setting: 'backup_destination:Keyless', userId: ann.id },
				{ setting: 'mail', userId: ann.id }
			]);

			const res = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).toMatchObject({ settingsRemoved: { mail: true, appUrl: true, destinations: ['Keyless'] } });
			expect(setting('smtp_host')).toBeNull();
			expect(setting('app_url')).toBeNull();
			expect(names()).toEqual(['Old']);
			// Every row of each setting removed goes, chief's for where it was before included.
			expect(rows()).toEqual([]);
		});

		it('gives a setting moved back to where somebody else put it to them: ann’s move undone by bob is the superadmin’s again', async () => {
			await chiefsAndAnnsMoves([{ port: 26, prefix: 'b/', appUrl: 'https://ann.example' }]);

			expect((await api('PUT', '/api/admin/smtp', { ...as(bob), body: { port: 25 } })).status).toBe(200);

			expect(setters().filter((s) => s.setting === 'mail')).toEqual([{ setting: 'mail', userId: chief.id }]);
			const demoted = await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });
			expect(demoted.body).toMatchObject({ settingsRemoved: { mail: false, appUrl: true, destinations: ['Keyless'] } });
			expect(setting('smtp_host')).toBe('relay.chief.example');
		});
	});

	// The card 2397 review: an App URL cleared since its setter saved it was reported, and logged, as
	// removed. Its second review: the cleared row is not at the place bob set, so it is not his and stays.
	it('leaves an App URL cleared since its setter saved it, and drops the setter’s row: no field in the answer, no line', async () => {
		await api('PUT', '/api/admin/smtp', { ...as(bob), body: { appUrl: 'https://bob.example' } });
		await api('PUT', '/api/admin/smtp', { ...as(ann), body: { appUrl: '' } });
		expect(rows()).toEqual([{ setting: 'app_url', userId: bob.id }]);
		const linesBefore = lines().length;

		const res = await api('PUT', `/api/users/${bob.id}`, { ...as(chief), body: { role: 'user' } });

		expect(res.status).toBe(200);
		expect(res.body).not.toHaveProperty('settingsRemoved');
		expect(setting('app_url')).toBe('');
		expect(rows()).toEqual([]);
		expect(lines().slice(linesBefore)).toEqual([]);
	});

	// The card 2397 review: the users panel names what would go before a role change or a delete is sent.
	it('gives the admin page what a role change to user or a delete of each account would remove, by the rule of the counts', async () => {
		await annsSettings();
		const carol = makeUser({ username: 'carol', role: 'admin' });
		// A setter row whose destination is no longer stored names nothing.
		db.insert(settingSetters).values({ setting: 'backup_destination:Gone', place: 'nowhere', userId: carol.id }).run();
		const settingsSet = async (caller: SessionUser) => {
			const data = (await loadAdminPage({ locals: { user: caller } } as unknown as Parameters<typeof loadAdminPage>[0])) as {
				users: { username: string; settingsSet: unknown }[];
			};
			return Object.fromEntries(data.users.map((u) => [u.username, u.settingsSet]));
		};

		expect(await settingsSet(chief)).toEqual({
			chief: null,
			ann: { mail: true, appUrl: true, destinations: ["Ann's"] },
			bob: { mail: false, appUrl: false, destinations: ["Bob's"] },
			carol: null
		});
		// Another administrator manages none of them: nothing to name.
		expect(await settingsSet(bob)).toEqual({ chief: null, ann: null, bob: null, carol: null });
	});

	// The card 2397 third review: a place an administrator visited first was theirs even when the
	// superadmin later moved the setting there; the table grew with every save; and a setting saved
	// before 0059 changed and changed back became the administrator's.
	describe('places visited first, the size of the table, and settings saved before 0059 (the third code review)', () => {
		const smtp = (who: SessionUser, body: Record<string, unknown>) => api('PUT', '/api/admin/smtp', { ...as(who), body });
		const demoteAnn = () => api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'user' } });
		const mailSetter = () => setters().filter((s) => s.setting === 'mail');

		it('the reviewer’s mail probe: ann claims port 465 first with a garbage password and goes back; the superadmin’s later move there with the real password is his', async () => {
			expect((await smtp(chief, { host: 'smtp.chief.example', port: 587, user: 'chief-mailer', pass: 'chief-secret', fromAddress: 'c@example.test' })).status).toBe(200);
			expect((await smtp(ann, { port: 465, pass: 'garbage' })).status).toBe(200);
			expect((await smtp(ann, { port: 587, pass: 'garbage' })).status).toBe(200);

			expect((await smtp(chief, { port: 465, pass: 'chief-secret' })).status).toBe(200);

			expect(mailSetter()).toEqual([{ setting: 'mail', userId: chief.id }]);
			const res = await demoteAnn();
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).not.toHaveProperty('settingsRemoved');
			expect(setting('smtp_port')).toBe('465');
			expect(setting('smtp_pass')).toBe('chief-secret');
		});

		it('the reviewer’s destination probe: ann points the superadmin’s destination at a bucket first with a garbage secret and goes back; his later move there with the real secret is his', async () => {
			const CHIEFS = s3("Chief's", 'chief-bucket');
			expect((await api('PUT', '/api/admin/backup', { ...as(chief), body: { destinations: [...(await shown(as(chief))), CHIEFS] } })).status).toBe(200);
			const moveTo = async (who: SessionUser, bucket: string, secret: string) => {
				const dests = (await shown(as(who))).map((d) => (d.name === "Chief's" ? { ...d, bucket, secretAccessKey: secret } : d));
				const res = await api('PUT', '/api/admin/backup', { ...as(who), body: { destinations: dests } });
				expect(res.status, JSON.stringify(res.body)).toBe(200);
			};
			await moveTo(ann, 'ann-bucket', 'garbage');
			await moveTo(ann, 'chief-bucket', 'garbage');

			await moveTo(chief, 'ann-bucket', 'chief-real-secret');

			expect(setters().filter((s) => s.setting === "backup_destination:Chief's")).toEqual([{ setting: "backup_destination:Chief's", userId: chief.id }]);
			const res = await demoteAnn();
			expect(res.body).not.toHaveProperty('settingsRemoved');
			expect(stored().destinations.find((d) => d.name === "Chief's")).toMatchObject({ bucket: 'ann-bucket', secretAccessKey: 'chief-real-secret' });
		});

		it('gives a place an administrator visited first to another administrator who moves there with the password typed, and to the superadmin who moves there with none', async () => {
			expect((await smtp(chief, { host: 'smtp.chief.example', port: 587, pass: 'chief-secret', appUrl: 'https://chief.example' })).status).toBe(200);
			expect((await smtp(ann, { port: 2526, pass: 'garbage', appUrl: 'https://first.example' })).status).toBe(200);
			expect((await smtp(ann, { port: 587, pass: 'garbage', appUrl: 'https://chief.example' })).status).toBe(200);

			// Bob, an administrator, with the password typed: the mail at 2526 is his, not ann's.
			expect((await smtp(bob, { port: 2526, pass: 'bobs-real-secret' })).status).toBe(200);
			// The superadmin sets the App URL ann visited first, with no secret to type: his.
			expect((await smtp(chief, { appUrl: 'https://first.example' })).status).toBe(200);

			expect(setters()).toEqual([
				{ setting: 'app_url', userId: chief.id },
				{ setting: 'mail', userId: bob.id }
			]);
			expect((await demoteAnn()).body).not.toHaveProperty('settingsRemoved');
		});

		it('keeps one row for each account for each setting: 21 moves by ann leave one row of hers', async () => {
			expect((await smtp(chief, { host: 'relay.chief.example', port: 25, fromAddress: 'c@example.test' })).status).toBe(200);
			for (let i = 0; i < 21; i++) expect((await smtp(ann, { port: 3000 + i })).status).toBe(200);

			expect(rows()).toEqual([
				{ setting: 'mail', userId: chief.id },
				{ setting: 'mail', userId: ann.id }
			].sort((a, b) => a.userId - b.userId));
			expect(mailSetter()).toEqual([{ setting: 'mail', userId: ann.id }]);
		});

		it('records the place a setting saved before 0059 leaves as nobody’s: changed and changed back by ann, it is nobody’s, and her demotion removes nothing', async () => {
			const KEYLESS_OLD = { type: 's3', name: 'Keyless', region: 'eu-west-2', bucket: 'legacy-bucket', prefix: 'a/' };
			db.insert(settings)
				.values([
					{ key: 'smtp_host', value: 'relay.legacy.example' },
					{ key: 'smtp_port', value: '25' },
					{ key: 'app_url', value: 'https://legacy.example' }
				])
				.run();
			db.update(settings)
				.set({ value: JSON.stringify({ ...CONFIG, destinations: [OLD, KEYLESS_OLD] }) })
				.where(eq(settings.key, 'backup_config'))
				.run();
			const prefixed = async (prefix: string) => {
				const dests = (await shown(as(ann))).map((d) => (d.name === 'Keyless' ? { ...d, prefix } : d));
				expect((await api('PUT', '/api/admin/backup', { ...as(ann), body: { destinations: dests } })).status).toBe(200);
			};
			expect((await smtp(ann, { port: 26, appUrl: 'https://ann.example' })).status).toBe(200);
			await prefixed('b/');
			expect(setters().map((s) => s.userId)).toEqual([ann.id, ann.id, ann.id]);

			expect((await smtp(ann, { port: 25, appUrl: 'https://legacy.example' })).status).toBe(200);
			await prefixed('a/');

			expect(setters()).toEqual([]);
			// The three places left, as nobody's; ann's one row for each setting, where she had moved it.
			expect(rows().filter((r) => (r as { userId: number | null }).userId === null)).toHaveLength(3);
			const res = await demoteAnn();
			expect(res.body).not.toHaveProperty('settingsRemoved');
			expect(setting('smtp_host')).toBe('relay.legacy.example');
			expect(setting('app_url')).toBe('https://legacy.example');
			expect(names()).toEqual(['Old', 'Keyless']);
		});
	});

	// The second code review: the users panel decided on what the page load had read, however old.
	it('answers GET /api/users/:id with what a role change to user or a delete would remove now, by the rule of the counts', async () => {
		await annsSettings();
		const held = async (caller: SessionUser, account: SessionUser) => {
			const res = await api('GET', `/api/users/${account.id}`, as(caller));
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.headers.get('cache-control')).toBe('no-store');
			return res.body;
		};

		expect(await held(chief, ann)).toEqual({ id: ann.id, settingsSet: { mail: true, appUrl: true, destinations: ["Ann's"] } });
		expect(await held(chief, bob)).toEqual({ id: bob.id, settingsSet: { mail: false, appUrl: false, destinations: ["Bob's"] } });
		// Bob takes the mail over: read again, it is his now, and no longer ann's.
		expect((await api('PUT', '/api/admin/smtp', { ...as(bob), body: { port: 2626, pass: 'typed-by-bob' } })).status).toBe(200);
		expect(await held(chief, ann)).toEqual({ id: ann.id, settingsSet: { mail: false, appUrl: true, destinations: ["Ann's"] } });
		expect(await held(chief, bob)).toEqual({ id: bob.id, settingsSet: { mail: true, appUrl: false, destinations: ["Bob's"] } });
		// The caller's own, and an account the caller may not manage, name nothing.
		expect(await held(chief, chief)).toEqual({ id: chief.id, settingsSet: null });
		expect(await held(bob, ann)).toEqual({ id: ann.id, settingsSet: null });

		const carol = makeUser({ username: 'carol', role: 'user' });
		expect((await api('GET', `/api/users/${ann.id}`, as(carol))).status).toBe(403);
		expect((await api('GET', '/api/users/9999', as(chief))).status).toBe(404);
	});

	it('removes nothing for a change that is not to user: an email changed, or an administrator kept one', async () => {
		await annsSettings();
		const kept = setters();

		expect((await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { email: 'ann2@example.test' } })).status).toBe(200);
		expect((await api('PUT', `/api/users/${ann.id}`, { ...as(chief), body: { role: 'admin' } })).status).toBe(200);

		expect(setters()).toEqual(kept);
		expect(names()).toEqual(['Old', "Ann's", "Bob's"]);
	});

	// Card 2406: a role written to user, or an account deleted, from the host runs no application code.
	describe('at start-up, what a setter who is no longer an administrator set (card 2406)', () => {
		afterEach(() => sqlite.exec('DROP TRIGGER IF EXISTS refuse_2406'));

		const START_UP = '(found at start-up: the role was changed outside the admin page)';
		const STARTUP_LINES = () =>
			sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'STARTUP' ORDER BY id").all() as { level: string; message: string }[];

		it('removes what an administrator made a user from the host set, logged at WARN under nobody, and finds nothing the second time', async () => {
			await annsSettings();
			const linesBefore = lines().length;
			sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(ann.id);

			expect(removeSettingsOfNonAdministrators()).toBe(1);

			expect(SMTP_ROWS()).toEqual([]);
			expect(setting('app_url')).toBeNull();
			expect(names()).toEqual(['Old', "Bob's"]);
			expect(setting('backup_config')).not.toContain('secret-ann-bucket');
			expect(setters()).toEqual([{ setting: "backup_destination:Bob's", userId: bob.id }]);
			expect(rows()).toEqual([{ setting: "backup_destination:Bob's", userId: bob.id }]);
			expect(lines().slice(linesBefore)).toEqual([
				{
					level: 'WARN',
					context: 'SMTP',
					message:
						`The mail settings and the App URL removed: saved by "ann", who is no longer an administrator ${START_UP}. ` +
						'No mail is sent until an administrator sets the mail up again. ' +
						"Links in mail use APP_URL, or the server's own address, until an App URL is saved again.",
					meta: JSON.stringify({ setter: ann.id, reason: 'not-an-administrator', mail: true, appUrl: true }),
					userId: null
				},
				{
					level: 'WARN',
					context: 'BACKUP',
					message: `Backup destination "Ann's" (s3) removed: saved by "ann", who is no longer an administrator ${START_UP}. Its stored secrets went with it; the copies already there are kept.`,
					meta: JSON.stringify({ setter: ann.id, reason: 'not-an-administrator', destinations: [{ name: "Ann's", type: 's3' }] }),
					userId: null
				}
			]);

			// The next start finds nobody.
			const before = snapshotDb();
			expect(removeSettingsOfNonAdministrators()).toBe(0);
			expectUnchanged(before);
		});

		it('leaves what administrators set, the superadmin made an administrator from the host included', async () => {
			await annsSettings();
			// From the host the superadmin is made `admin`, which is still an administrator.
			sqlite.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(chief.id);
			const before = snapshotDb();

			expect(removeSettingsOfNonAdministrators()).toBe(0);

			expectUnchanged(before);
		});

		it('treats a row whose account is gone, deleted from the host with foreign keys off, the same', async () => {
			await annsSettings();
			const linesBefore = lines().length;
			sqlite.pragma('foreign_keys = OFF');
			try {
				sqlite.prepare('DELETE FROM users WHERE id = ?').run(ann.id);
			} finally {
				sqlite.pragma('foreign_keys = ON');
			}
			expect(rows()).toContainEqual({ setting: 'mail', userId: ann.id });

			expect(removeSettingsOfNonAdministrators()).toBe(1);

			expect(SMTP_ROWS()).toEqual([]);
			expect(setting('app_url')).toBeNull();
			expect(names()).toEqual(['Old', "Bob's"]);
			expect(rows()).toEqual([{ setting: "backup_destination:Bob's", userId: bob.id }]);
			const gone = '(found at start-up: it was deleted outside the admin page)';
			expect(lines().slice(linesBefore).map((l) => [l.context, l.message.split('. ')[0], l.userId])).toEqual([
				['SMTP', `The mail settings and the App URL removed: saved by account ${ann.id}, whose account no longer exists ${gone}`, null],
				['BACKUP', `Backup destination "Ann's" (s3) removed: saved by account ${ann.id}, whose account no longer exists ${gone}`, null]
			]);
		});

		it('cannot find an account deleted from the host with foreign keys on: the cascade takes its rows, and its settings stay, unattributed', async () => {
			await annsSettings();
			sqlite.prepare('DELETE FROM users WHERE id = ?').run(ann.id);
			expect(rows()).toEqual([{ setting: "backup_destination:Bob's", userId: bob.id }]);
			const before = snapshotDb();

			expect(removeSettingsOfNonAdministrators()).toBe(0);

			expectUnchanged(before);
			expect(SMTP_ROWS()).not.toEqual([]);
			expect(names()).toEqual(['Old', "Ann's", "Bob's"]);
		});

		it('removes all of it or none, and does not throw, when a removal fails: one WARN line under STARTUP', async () => {
			await annsSettings();
			sqlite.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(ann.id);
			sqlite.exec("CREATE TEMP TRIGGER refuse_2406 BEFORE DELETE ON setting_setters BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
			const before = snapshotDb();
			const linesBefore = lines().length;

			expect(removeSettingsOfNonAdministrators()).toBeNull();

			expectUnchanged(before);
			expect(lines().slice(linesBefore)).toEqual([]);
			expect(STARTUP_LINES()).toEqual([
				{
					level: 'WARN',
					message:
						'The settings of setters who are no longer administrators could not be checked: refused for the test. ' +
						'Mail and backups may still go where such a person set them.'
				}
			]);
		});

		it('is called by hooks.server.ts after the migrations and before the schedulers start', () => {
			const hooks = readFileSync(join(process.cwd(), 'src/hooks.server.ts'), 'utf8');
			const at = (call: string) => hooks.indexOf(`\n${call}`);
			expect(at('removeSettingsOfNonAdministrators();')).toBeGreaterThan(at('runMigrations();'));
			expect(at('removeSettingsOfNonAdministrators();')).toBeLessThan(at('startSchedulers();'));
			expect(at('runMigrations();')).toBeGreaterThan(-1);
		});
	});

	describe('all together or not at all', () => {
		afterEach(() => sqlite.exec('DROP TRIGGER IF EXISTS refuse_2397'));

		it('rolls the role change and every removal back together when the last removal fails, and logs nothing', async () => {
			await annsSettings();
			// A write of the removal after the settings have gone: the setter rows.
			sqlite.exec("CREATE TEMP TRIGGER refuse_2397 BEFORE DELETE ON setting_setters BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
			const who = as(chief);
			const before = snapshotDb();
			const linesBefore = lines().length;

			// Thrown out of the handler: the gate would answer it 500.
			await expect(api('PUT', `/api/users/${ann.id}`, { ...who, body: { role: 'user' } })).rejects.toThrow('refused for the test');

			expectUnchanged(before);
			expect(roleOf(ann)).toBe('admin');
			expect(lines().slice(linesBefore).filter((l) => l.level === 'WARN')).toEqual([]);
		});

		it('rolls every removal back with the delete when the delete fails', async () => {
			await annsSettings();
			sqlite.exec("CREATE TEMP TRIGGER refuse_2397 BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
			const who = as(chief);
			const before = snapshotDb();
			const linesBefore = lines().length;

			await expect(api('DELETE', `/api/users/${ann.id}`, who)).rejects.toThrow('refused for the test');

			expectUnchanged(before);
			expect(lines().slice(linesBefore).filter((l) => l.level === 'WARN')).toEqual([]);
		});
	});
});
