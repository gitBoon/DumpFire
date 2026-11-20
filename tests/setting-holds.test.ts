/**
 * Card 2922: the settings held for the superadmin's review.
 *
 * When an account's access ends with its API keys, the mail settings, the
 * App URL and the backup destinations it set are held (`setting_holds`,
 * migration 0074): nothing is sent through them until the superadmin keeps
 * or removes each. These cases guard the readers that stop a held setting
 * reaching outside (slice 1), the writers that hold (slice 2a), and Keep and
 * Remove (slice 2b). Each names the branch it reaches.
 *
 * Against the application's own in-memory database, emptied before each test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { google } from 'googleapis';

// Not under dev: a link's address is the server's configuration alone (case 22).
vi.mock('$app/environment', () => ({ dev: false, building: false, browser: false, version: 'test' }));

/** What the stand-in destination was handed, and a hook run as an upload begins (case 7). */
const reached = vi.hoisted(() => ({
	uploads: [] as string[],
	made: [] as string[],
	duringUpload: null as null | ((name: string) => void)
}));

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		// A destination that records what reaches it and reaches nowhere.
		createDestination: (config: { type: string; name: string }) => {
			reached.made.push(config.name);
			return {
				type: config.type,
				name: config.name,
				test: async () => ({ success: true, message: 'ok' }),
				upload: async () => {
					reached.duringUpload?.(config.name);
					reached.uploads.push(config.name);
				},
				list: async () => [],
				delete: async () => {}
			};
		}
	};
});

import { db, sqlite } from '$lib/server/db';
import { inviteTokens, settings } from '$lib/server/db/schema';
import { inTransaction } from '$lib/server/db/transaction';
import { holdSettingsSetBy, removeSettingsSetBy } from '$lib/server/setting-setters';
import { MAIL_PROBLEM_WORDS } from '$lib/server/email';
import { action } from './helpers/actions';
import { destinationHeldNow, generateBackupData, getBackupConfig, getBackupHistory, runBackup, saveBackupConfig } from '$lib/server/backup';
import { destinationPlace } from '$lib/server/backup-secrets';
import { restoreFromBackup } from '$lib/server/db/restore';
import type { SessionUser } from '$lib/server/auth';
import {
	appUrlFrom,
	getAppUrl,
	isSmtpConfigured,
	mailCannotSend,
	mailEverConfigured,
	mailStatus,
	PLACEHOLDER_ORIGIN,
	resetMailStatus,
	trySendEmail
} from '$lib/server/email';
import {
	appUrlPlaceOf,
	DESTINATION_HELD,
	DESTINATION_HELD_UNSEALED,
	destinationHeldWords,
	mailPlaceOf,
	placeKey,
	SETTER_ACCESS_ENDED,
	UNSEALED_RESTORE
} from '$lib/server/setting-holds';
import { MAIL_HELD_UNSEALED, mailProblemWords } from '$lib/server/email';
import { cannotMailWhy } from '$lib/server/request-tokens';
import { reportSettingsHeld } from '$lib/server/startup-checks';
import { stamp } from '$lib/timestamps';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { inviteHashOf, makeSmtp, makeUser, resetDb, stepUp } from './helpers/fixtures';

/** Two S3 destinations and a Google Drive one, as an administrator saves them. */
const s3 = (name: string, bucket: string) => ({
	type: 's3',
	name,
	region: 'eu-west-2',
	bucket,
	accessKeyId: `AKIA-${bucket}`,
	secretAccessKey: `secret-${bucket}`,
	prefix: 'dumpfire/'
});
const A = s3('A', 'a-bucket');
const B = s3('B', 'b-bucket');
const G = { type: 'gdrive', name: 'G', authMethod: 'oauth', clientId: 'client-g', clientSecret: 'secret-g', folderId: 'folder-g' };
const CONFIG = { schedule: 'daily', scheduleTime: '02:00', scheduleDay: 0, retention: 7, notifyOnFailure: false, notifyEmail: '' };

/** The destinations saved, sealed as a save stores them. */
function saveDestinations(destinations: Record<string, unknown>[]): void {
	saveBackupConfig({ ...CONFIG, destinations } as never);
}

/** The place of the stored destination named `name`, as a setter row and a hold record it. */
function placeOf(name: string): string {
	const entry = getBackupConfig().destinations.find((d) => d.name === name);
	if (entry === undefined) throw new Error(`no destination ${name}`);
	return placeKey(destinationPlace(entry));
}

const holdsNow = () => sqlite.prepare('SELECT setting, place FROM setting_holds ORDER BY setting, place').all() as { setting: string; place: string }[];

/** The place `makeSmtp`'s mail settings are at: the host, the default port, no user, the way out shut. */
const SMTP_PLACE = mailPlaceOf({ host: 'smtp.example.test', port: 587, user: '', allowInsecure: false });

/** Hold `setting` at `place`, as an ending writes it. */
function hold(setting: string, place: string, setByName: string | null = 'ann'): void {
	sqlite
		.prepare('INSERT INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, ?, ?, ?)')
		.run(setting, place, SETTER_ACCESS_ENDED, stamp(), 7, setByName);
}

/** The lines of `context` in the system log, as the server wrote them. */
const lines = (context: string) =>
	sqlite.prepare('SELECT level, message FROM system_logs WHERE context = ? ORDER BY id').all(context) as { level: string; message: string }[];

let sent: Effects;
let level: string | undefined;
let appUrl: string | undefined;

beforeEach(() => {
	level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	appUrl = process.env.APP_URL;
	delete process.env.APP_URL;
	resetDb();
	resetMailStatus();
	reached.uploads.length = 0;
	reached.made.length = 0;
	reached.duringUpload = null;
	sent = effects();
});

afterEach(() => {
	sent.restore();
	if (level === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = level;
	if (appUrl === undefined) delete process.env.APP_URL;
	else process.env.APP_URL = appUrl;
});

// ─── Slice 1: the readers ────────────────────────────────────────────────────

describe('a held setting reaches nothing outside (slice 1)', () => {
	it('case 2: held mail: deliverMail answers held, hands nothing to a transport and counts nothing; mail still counts as set up', async () => {
		makeSmtp();
		// The control: the same mail goes while nothing is held.
		expect(await trySendEmail('a@example.test', 'Before', '<p>x</p>')).toEqual({ sent: true });
		hold('mail', SMTP_PLACE);

		const outcome = await trySendEmail('a@example.test', 'After', '<p>x</p>');

		expect(outcome).toMatchObject({ sent: false, problem: 'held' });
		expect(sent.emails.map((mail) => mail.subject)).toEqual(['Before']);
		expect(mailStatus()).toMatchObject({ sent: 1, failed: 0, lastFailure: null });
		expect(isSmtpConfigured()).toBe(true);
		expect(mailCannotSend()).toBe(true);
	});

	it('case 5: a held App URL is not used for links: the setting is answered before the hold, APP_URL after it, and nothing without one', () => {
		db.insert(settings).values({ key: 'app_url', value: 'https://dumpfire.example.test' }).run();
		expect(getAppUrl()).toBe('https://dumpfire.example.test');
		hold('app_url', appUrlPlaceOf('https://dumpfire.example.test')!);

		expect(getAppUrl()).toBeNull();
		expect(appUrlFrom()).toBe('none');
		process.env.APP_URL = 'https://host.example.test';
		expect(getAppUrl()).toBe('https://host.example.test');
	});

	it('case 27: each start names every held setting in force at WARN, counts the tombstones at INFO, and says nothing when none is held', () => {
		process.env.LOG_LEVEL = 'INFO';
		expect(reportSettingsHeld()).toBe(0);
		expect(lines('STARTUP')).toEqual([]);
		makeSmtp();
		saveDestinations([A]);
		hold('mail', SMTP_PLACE);
		hold('backup_destination:A', placeOf('A'), null);
		// A tombstone (C5): a destination removed, its hold left at a place nothing is at.
		hold('backup_destination:Offsite', 'some-place', 'bob');

		expect(reportSettingsHeld()).toBe(2);

		const said = lines('STARTUP');
		expect(said.map((line) => line.level)).toEqual(['INFO', 'WARN']);
		expect(said[0].message).toBe(
			'1 setting hold(s) at places no setting is at now (removed or moved settings), kept so that a setting saved or restored there again is held again.'
		);
		expect(said[1].message).toContain("Settings held for the superadmin's review: backup destination \"A\", the mail settings");
		expect(said[1].message).toContain('"ann"');
		expect(said[1].message).toContain('user 7');
		expect(said[1].message).not.toContain('Offsite');
		expect(said[1].message).not.toContain('bob');
		expect(said[1].message).toContain('an older image would use them again');
	});
});

describe('a held destination is not reached (slice 1)', () => {
	let chief: SessionUser;

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		saveDestinations([A, B, G]);
	});

	it('case 6: a run does not try a held destination and names it in Backup History; the others are tried', async () => {
		hold('backup_destination:B', placeOf('B'));

		const results = await runBackup();

		expect(results.map(({ destination, status }) => ({ destination, status }))).toEqual([
			{ destination: 'A', status: 'success' },
			{ destination: 'B', status: 'failed' },
			{ destination: 'G', status: 'failed' }
		]);
		expect(results[1].message).toBe(DESTINATION_HELD);
		expect(reached.made).not.toContain('B');
		expect(reached.uploads).toEqual(['A']);
		expect(getBackupHistory().find((row) => row.destinationName === 'B')).toMatchObject({ status: 'failed', error: DESTINATION_HELD });
	});

	it('case 7: a destination held while an earlier one uploads is asked again before it is reached, and skipped', async () => {
		saveDestinations([A, B]);
		reached.duringUpload = (name) => {
			if (name === 'A') hold('backup_destination:B', placeOf('B'));
		};

		const results = await runBackup();

		expect(results.map(({ destination, status, message }) => ({ destination, status, message: status === 'failed' ? message : '' }))).toEqual([
			{ destination: 'A', status: 'success', message: '' },
			{ destination: 'B', status: 'failed', message: DESTINATION_HELD }
		]);
		expect(reached.made).toEqual(['A', 'A']);
		expect(reached.uploads).toEqual(['A']);
	});

	it('case 8: a Test of a held destination is refused 409, and nothing is reached', async () => {
		hold('backup_destination:B', placeOf('B'));
		const shown = (await api('GET', '/api/admin/backup', { user: chief })).body.destinations.find((d: { name: string }) => d.name === 'B');

		const res = await api('POST', '/api/admin/backup/test', { user: chief, body: shown });

		expect({ status: res.status, message: res.body.message }).toEqual({ status: 409, message: DESTINATION_HELD });
		expect(reached.made).toEqual([]);
	});

	it('case 9: a Google Drive Connect of a held destination is refused 409', async () => {
		hold('backup_destination:G', placeOf('G'));

		const res = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: chief });

		expect({ status: res.status, message: res.body.message }).toEqual({ status: 409, message: DESTINATION_HELD });
	});

	it('case 10: a save that renames a held destination is refused 409, and nothing is saved', async () => {
		hold('backup_destination:B', placeOf('B'));
		const before = sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get();

		const res = await api('PUT', '/api/admin/backup', stepUp(chief, { destinations: [A, { ...B, name: 'B2' }, G] }));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toContain('Backup destination "B" is held for the superadmin\'s review');
		expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get()).toEqual(before);
	});

	it('case C7c: a save that only removes a held destination is refused 409, and nothing is saved', async () => {
		hold('backup_destination:B', placeOf('B'));
		const before = sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get();

		const res = await api('PUT', '/api/admin/backup', stepUp(chief, { destinations: [A, G] }));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toContain('Backup destination "B" is held for the superadmin\'s review');
		expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get()).toEqual(before);
	});

	it('case C12a: a held destination renamed at the same place (a restore or the host) stays held, under its new name', async () => {
		hold('backup_destination:B', placeOf('B'));

		saveDestinations([A, { ...B, name: 'B2' }, G]);

		expect(destinationHeldNow(getBackupConfig().destinations[1])).toBe(true);
		expect((await runBackup('B2'))[0]).toMatchObject({ destination: 'B2', status: 'failed', message: DESTINATION_HELD });
		expect(reached.made).not.toContain('B2');
	});

	it('case C7a: a destination held while its own upload runs is not cleaned by retention, and the WARN names it quoted', async () => {
		// With failure mail on, so that "no mail" is asked of a run that could send one (card 2941, C7).
		makeSmtp();
		saveBackupConfig({ ...CONFIG, notifyOnFailure: true, notifyEmail: 'chief@example.test', destinations: [A] } as never);
		reached.duringUpload = (name) => {
			if (name === 'A') hold('backup_destination:A', placeOf('A'));
		};

		const results = await runBackup();

		expect(results.map(({ destination, status }) => ({ destination, status }))).toEqual([{ destination: 'A', status: 'success' }]);
		// Made once, for the upload: retention would make it again.
		expect(reached.made).toEqual(['A']);
		expect(lines('BACKUP').map((line) => line.message)).toContain(`Retention not run at "A": ${DESTINATION_HELD}`);
		// Card 2941 (C7): on the row and the answer, and in no mail: the hold is the superadmin's to review already.
		const held = `Keep Last was not applied: ${DESTINATION_HELD}`;
		expect(results[0].note).toBe(held);
		expect(getBackupHistory().map((row) => ({ status: row.status, error: row.error }))).toEqual([{ status: 'success', error: held }]);
		expect(sent.emails).toEqual([]);
	});

	describe('the second half of a Google Drive Connect (C7b)', () => {
		const files = { get: vi.fn(), create: vi.fn(), delete: vi.fn(), list: vi.fn() };
		/** The stand-ins of this describe alone, restored after each case. */
		const spies: { mockRestore(): void }[] = [];

		beforeEach(() => {
			for (const fn of Object.values(files)) fn.mockReset();
			files.get.mockResolvedValue({ data: { id: 'folder-g', name: 'Backups', mimeType: 'application/vnd.google-apps.folder', trashed: false } });
			spies.push(vi.spyOn(google, 'drive').mockReturnValue({ files } as never));
		});

		afterEach(() => {
			for (const spy of spies.splice(0)) spy.mockRestore();
		});

		it('is refused 409 while the destination is held, before the password, and nothing is exchanged', async () => {
			const begun = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: chief });
			const state = new URL(begun.body.authUrl).searchParams.get('state')!;
			hold('backup_destination:G', placeOf('G'));
			const exchanged = vi.spyOn(google.auth.OAuth2.prototype, 'getToken');
			spies.push(exchanged);

			const res = await api('POST', '/api/admin/backup/gdrive/auth', { user: chief, body: { code: 'the-code', state, destName: 'G' } });

			expect({ status: res.status, message: res.body.message }).toEqual({ status: 409, message: DESTINATION_HELD });
			expect(exchanged).not.toHaveBeenCalled();
		});

		it('held while Google answers: asked again in the write, nothing is saved, and the answer says it changed meanwhile', async () => {
			// Both halves from the one session, as the Connect is bound to it (card 2251).
			const connectAs = stepUp(chief, { code: 'the-code', destName: 'G' });
			const begun = await api('GET', '/api/admin/backup/gdrive/auth?dest=G', { user: chief, headers: connectAs.headers });
			const state = new URL(begun.body.authUrl).searchParams.get('state')!;
			const before = sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get();
			spies.push(
				vi.spyOn(google.auth.OAuth2.prototype, 'getToken').mockImplementation((async () => {
					hold('backup_destination:G', placeOf('G'));
					return { tokens: { refresh_token: 'refresh-g', scope: 'https://www.googleapis.com/auth/drive.file' }, res: null };
				}) as never)
			);

			const res = await api('POST', '/api/admin/backup/gdrive/auth', { ...connectAs, body: { ...connectAs.body, state } });

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body).toEqual({
				success: false,
				message: 'The destination was changed or removed while it was being connected, so the connection was not saved. Connect it again.'
			});
			expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get()).toEqual(before);
		});
	});
});

// ─── Slice 2a: the endings that hold ─────────────────────────────────────────

describe('an ending with the account’s keys holds what it set and ends its request links (slice 2a)', () => {
	let chief: SessionUser;
	let ann: SessionUser;
	/** A request ann made signed in, and one somebody else made, each with a mailed link. */
	let annsRequest: number;
	let othersRequest: number;

	const linksOf = (requestId: number) => (sqlite.prepare('SELECT COUNT(*) AS n FROM request_links WHERE request_id = ?').get(requestId) as { n: number }).n;
	const linesOf = (context: string) =>
		sqlite.prepare("SELECT message FROM system_logs WHERE context = ? AND message LIKE 'Held for the superadmin%' ORDER BY id").all(context) as { message: string }[];

	/** Ann recorded as the setter of the mail settings and destination B where they are. */
	function annSetMailAndB(): void {
		makeSmtp();
		saveDestinations([A, B]);
		const setter = sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)');
		setter.run('mail', SMTP_PLACE, ann.id);
		setter.run('backup_destination:B', placeOf('B'), ann.id);
	}

	function requestBy(userId: number | null): number {
		const id = Number(
			sqlite
				.prepare("INSERT INTO task_requests (target_type, target_id, title, requester_user_id, requester_email) VALUES ('user', ?, 'Please', ?, 'x@example.test')")
				.run(chief.id, userId).lastInsertRowid
		);
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run(`${id}`.padStart(64, 'a'), id);
		return id;
	}

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		ann = makeUser({ username: 'ann', role: 'admin' });
		annsRequest = requestBy(ann.id);
		othersRequest = requestBy(null);
	});

	it('case 1: holdSettingsSetBy copies every row of the account, one at a place the setting has left too; a second call adds nothing; the lines name the rows', () => {
		annSetMailAndB();
		// A row at a place the mail has left: copied, not in force.
		sqlite.prepare("INSERT INTO setting_setters (setting, place, user_id) VALUES ('app_url', 'a-place-left', ?)").run(ann.id);

		const held = inTransaction(() => holdSettingsSetBy(ann, { log: "ann's password was reset by chief" }));
		inTransaction(() => holdSettingsSetBy(ann, { log: 'again' }));

		expect(held).toEqual({ rows: ['app_url', 'backup_destination:B', 'mail'], inForce: { mail: true, appUrl: false, destinations: ['B'] } });
		expect(holdsNow()).toEqual(
			[
				{ setting: 'app_url', place: 'a-place-left' },
				{ setting: 'backup_destination:B', place: placeOf('B') },
				{ setting: 'mail', place: SMTP_PLACE }
			].sort((a, b) => (a.setting < b.setting ? -1 : 1))
		);
		expect(sqlite.prepare('SELECT DISTINCT set_by AS setBy, set_by_name AS setByName, held_because AS why FROM setting_holds').all()).toEqual([
			{ setBy: ann.id, setByName: 'ann', why: SETTER_ACCESS_ENDED }
		]);
		expect(linesOf('SMTP')[0].message).toBe(
			`Held for the superadmin's review: the App URL and the mail settings, set by "ann" (user ${ann.id}), as ann's password was reset by chief. ` +
				'No mail is sent through held mail settings, and no link begins with a held App URL, until the superadmin keeps or removes each under Settings held for review.'
		);
		expect(linesOf('BACKUP')[0].message).toContain('backup destination "B", set by "ann"');
	});

	it('case 16: a removal of a held setting (the setter demoted) leaves the hold as a tombstone: the mail set again at that place is held', () => {
		annSetMailAndB();
		inTransaction(() => holdSettingsSetBy(ann, { log: 'a test' }));

		inTransaction(() => removeSettingsSetBy(ann, 'demoted', chief));
		expect(isSmtpConfigured()).toBe(false);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
		makeSmtp();

		expect(mailCannotSend()).toBe(true);
	});

	it('case 17: an administrator’s password set holds what the account set, ends the links of its own requests and answers what it held', async () => {
		annSetMailAndB();

		const res = await api('PUT', `/api/users/${ann.id}/password`, stepUp(chief, { password: 'a-new-password-17' }));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.settingsHeld).toEqual({ mail: true, appUrl: false, destinations: ['B'] });
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
		expect([linksOf(annsRequest), linksOf(othersRequest)]).toEqual([0, 1]);
	});

	it('case 18: the holder’s own change holds and ends the links only when it ends the keys', async () => {
		annSetMailAndB();

		const kept = await api('PUT', '/api/account/password', stepUp(ann, { newPassword: 'a-new-password-18a', endApiKeys: false }));
		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body.settingsHeld).toBeNull();
		expect([holdsNow(), linksOf(annsRequest)]).toEqual([[], 1]);

		const ended = await api('PUT', '/api/account/password', stepUp(ann, { newPassword: 'a-new-password-18b', endApiKeys: true }, 'a-new-password-18a'));
		expect(ended.status, JSON.stringify(ended.body)).toBe(200);
		expect(ended.body.settingsHeld).toEqual({ mail: true, appUrl: false, destinations: ['B'] });
		expect([holdsNow().length, linksOf(annsRequest)]).toEqual([2, 0]);
	});

	it('case 19: an invite used holds what the account set and ends its request links', async () => {
		annSetMailAndB();
		db.insert(inviteTokens).values({ tokenHash: inviteHashOf('the-invite-19'), userId: ann.id, expiresAt: stamp(new Date(Date.now() + 3_600_000)) }).run();

		const res = await action('/invite/the-invite-19', { form: { password: 'a-new-password-19', confirmPassword: 'a-new-password-19' } });

		expect(res).toMatchObject({ type: 'redirect', status: 303 });
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
		expect(linksOf(annsRequest)).toBe(0);
	});

	describe('the two-step reset', () => {
		const reset = () => api('POST', `/api/users/${ann.id}/mfa/reset`, stepUp(chief));

		it('case 20: holds what the account set, and its message says so by count where the link is given', async () => {
			annSetMailAndB();
			process.env.APP_URL = 'https://host.example.test';

			const res = await reset();

			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect(res.body.settingsHeld).toEqual({ mail: true, appUrl: false, destinations: ['B'] });
			expect(res.body.message).toContain(
				' The mail settings and 1 backup destination they set are held for review: nothing is sent to them until you keep or remove them under Settings held for review on the admin page.'
			);
			expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
			expect(linksOf(annsRequest)).toBe(0);
		});

		it('case 21: holding the mail, the notice to the holder is not sent, and the answer says why', async () => {
			annSetMailAndB();
			process.env.APP_URL = 'https://host.example.test';

			const res = await reset();

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({ mailSent: false, mailProblem: MAIL_PROBLEM_WORDS.held });
			expect(sent.emails).toEqual([]);
		});

		it('case 22: where the App URL the account set is the only address, refused before anything is held or ended; with APP_URL, the link begins with it', async () => {
			sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://phish.example.test')").run();
			sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)').run('app_url', appUrlPlaceOf('https://phish.example.test'), ann.id);
			// Sent with no password: refused before the step-up, which would otherwise answer first.
			const refused = await api('POST', `/api/users/${ann.id}/mfa/reset`, { user: chief, body: {} });

			expect(refused.status).toBe(503);
			expect(refused.body.message).toContain('Disable the account, or reset its password, now.');
			expect([holdsNow(), linksOf(annsRequest)]).toEqual([[], 1]);

			process.env.APP_URL = 'https://host.example.test';
			const done = await reset();
			expect(done.status, JSON.stringify(done.body)).toBe(200);
			expect(done.body.enrolmentUrl).toMatch(/^https:\/\/host\.example\.test\/enrol\//);
			expect(holdsNow().map((row) => row.setting)).toEqual(['app_url']);
		});
	});

	it('case C6: an ending whose later write fails holds nothing and writes no hold’s line: the hold is one with the ending', async () => {
		annSetMailAndB();
		sqlite.prepare("INSERT INTO report_schedules (user_id, name, scope, enabled) VALUES (?, 'Weekly', 'all', 1)").run(ann.id);
		// The ending's last write, after the hold, made to fail.
		sqlite.exec("CREATE TEMP TRIGGER schedules_frozen BEFORE UPDATE ON report_schedules BEGIN SELECT RAISE(ABORT, 'schedules are frozen'); END");
		try {
			await expect(api('PUT', `/api/users/${ann.id}/password`, stepUp(chief, { password: 'a-new-password-c6' }))).rejects.toThrow('schedules are frozen');
		} finally {
			sqlite.exec('DROP TRIGGER IF EXISTS temp.schedules_frozen');
		}

		expect(holdsNow()).toEqual([]);
		expect([...linesOf('SMTP'), ...linesOf('BACKUP')]).toEqual([]);
		expect(linksOf(annsRequest)).toBe(1);
		expect(mailCannotSend()).toBe(false);
	});

	it('case 23: a disable removes what an administrator set, as it always has, holds nothing and writes no hold’s line; its links end as before', async () => {
		annSetMailAndB();

		const res = await api('POST', `/api/users/${ann.id}/disable`, stepUp(chief));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(isSmtpConfigured()).toBe(false);
		expect(holdsNow()).toEqual([]);
		expect([...linesOf('SMTP'), ...linesOf('BACKUP')]).toEqual([]);
		expect([linksOf(annsRequest), linksOf(othersRequest)]).toEqual([0, 1]);
	});
});

// ─── Slice 2b: the review list, Keep and Remove ──────────────────────────────

describe('the review list, Keep and Remove (slice 2b)', () => {
	let chief: SessionUser;
	let ann: SessionUser;

	/** Ann's mail settings and destination B, held as her two-step reset holds them. */
	function annHeld(): void {
		makeSmtp();
		saveDestinations([A, B]);
		const setter = sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)');
		setter.run('mail', SMTP_PLACE, ann.id);
		setter.run('backup_destination:B', placeOf('B'), ann.id);
		inTransaction(() => holdSettingsSetBy(ann, { log: "ann's two-step sign-in was reset by chief" }));
	}

	const list = (as: SessionUser) => api('GET', '/api/admin/settings/held', { user: as });
	const release = (as: SessionUser, setting: string, place: string, action: 'keep' | 'remove') =>
		api('POST', '/api/admin/settings/held', stepUp(as, { setting, place, action }));
	const settersNow = () => sqlite.prepare('SELECT setting, user_id AS userId FROM setting_setters ORDER BY setting').all();

	/** A decision with one participant holding a mailed personal link (C2), its author `author`. */
	let decisionLinks = 0;
	function decisionLinkOf(author: SessionUser): void {
		const decision = Number(
			sqlite
				.prepare("INSERT INTO decisions (board_name, title, status, author_user_id, author_name) VALUES ('Board', 'Which?', 'open', ?, ?)")
				.run(author.id, author.username).lastInsertRowid
		);
		decisionLinks++;
		sqlite
			.prepare(
				'INSERT INTO decision_participants (decision_id, role, name, email, job_title, groups, included_at, link_token_hash, link_issued_at) ' +
					"VALUES (?, 'consulted', 'Pat', 'pat@example.test', 'Engineer', '[]', ?, ?, ?)"
			)
			.run(decision, stamp(), `${decisionLinks}`.padStart(64, 'c'), stamp());
	}
	const decisionLinksNow = () =>
		(sqlite.prepare('SELECT COUNT(*) AS n FROM decision_participants WHERE link_token_hash IS NOT NULL').get() as { n: number }).n;

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		ann = makeUser({ username: 'ann', role: 'admin' });
		annHeld();
	});

	it('case 15: every administrator reads the list: each setting held at its place, where it sends with no secret, and who may release it', async () => {
		const res = await list(ann);

		expect(res.status).toBe(200);
		// Kept by nothing on the way (C17).
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(res.body.mayRelease).toBe(false);
		expect(res.body.tombstones).toBe(0);
		expect(res.body.held.map((held: { setting: string; kind: string; name: string | null; setByName: string }) => [held.setting, held.kind, held.name, held.setByName])).toEqual([
			['backup_destination:B', 'destination', 'B', 'ann'],
			['mail', 'mail', null, 'ann']
		]);
		expect(res.body.held[1].where).toEqual({ host: 'smtp.example.test', port: 587, user: '', allowInsecure: false });
		expect(res.body.held[0].where).toMatchObject({ type: 's3', bucket: 'b-bucket' });
		expect(JSON.stringify(res.body)).not.toContain('secret-b-bucket');
		expect((await list(chief)).body.mayRelease).toBe(true);
	});

	it('case 11: Keep deletes the hold and nothing else, against the place reviewed: a stale one is 409; kept, mail goes again and Ann is still its setter', async () => {
		const stale = await release(chief, 'mail', 'f'.repeat(64), 'keep');
		expect(stale.status).toBe(409);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);

		const kept = await release(chief, 'mail', SMTP_PLACE, 'keep');

		expect(kept.status, JSON.stringify(kept.body)).toBe(200);
		expect(kept.body).toEqual({ success: true, kept: 'mail' });
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B']);
		expect(settersNow()).toEqual([
			{ setting: 'backup_destination:B', userId: ann.id },
			{ setting: 'mail', userId: ann.id }
		]);
		expect(await trySendEmail('a@example.test', 'After keep', '<p>x</p>')).toEqual({ sent: true });
		expect(lines('SMTP').map((line) => line.message).filter((message) => message.startsWith('Kept'))).toEqual([
			expect.stringContaining('Kept after the superadmin\'s review by "chief": the mail settings, set by "ann"')
		]);
	});

	it('case 12: Remove takes a held destination out, and its hold stays: the same destination saved again is held again', async () => {
		const removed = await release(chief, 'backup_destination:B', placeOf('B'), 'remove');

		expect(removed.status, JSON.stringify(removed.body)).toBe(200);
		expect(removed.body).toEqual({ success: true, removed: 'backup_destination:B', ended: null });
		expect(getBackupConfig().destinations.map((d) => d.name)).toEqual(['A']);
		expect(settersNow()).toEqual([{ setting: 'mail', userId: ann.id }]);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);

		saveDestinations([A, B]);
		const results = await runBackup('B');
		expect(results).toEqual([expect.objectContaining({ destination: 'B', status: 'failed', message: DESTINATION_HELD })]);
	});

	it('case 13: Remove of held mail ends every invite not yet used, set-up link and request link on the server, and says how many', async () => {
		const other = makeUser({ username: 'other' });
		const week = stamp(new Date(Date.now() + 7 * 86_400_000));
		db.insert(inviteTokens).values({ tokenHash: inviteHashOf('unused-13'), userId: other.id, expiresAt: week }).run();
		db.insert(inviteTokens).values({ tokenHash: inviteHashOf('used-13'), userId: other.id, expiresAt: week, used: true }).run();
		sqlite.prepare("INSERT INTO enrolment_links (token_hash, user_id, issued_by, expires_at) VALUES (?, ?, 'admin-reset', ?)").run('e'.repeat(64), other.id, week);
		const request = Number(
			sqlite.prepare("INSERT INTO task_requests (target_type, target_id, title, requester_email) VALUES ('user', ?, 'Please', 'x@example.test')").run(chief.id).lastInsertRowid
		);
		sqlite.prepare("INSERT INTO request_links (token_hash, request_id, source) VALUES (?, ?, 'mail')").run('d'.repeat(64), request);
		decisionLinkOf(chief);

		const removed = await release(chief, 'mail', SMTP_PLACE, 'remove');

		expect(removed.status, JSON.stringify(removed.body)).toBe(200);
		expect(removed.body).toEqual({ success: true, removed: 'mail', ended: { invites: 1, enrolmentLinks: 1, requestLinks: 1, decisionLinks: 1 } });
		expect(isSmtpConfigured()).toBe(false);
		expect(sqlite.prepare('SELECT used FROM invite_tokens').all()).toEqual([{ used: 1 }]);
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM enrolment_links').get()).toEqual({ n: 0 });
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM request_links').get()).toEqual({ n: 0 });
		expect(decisionLinksNow()).toBe(0);
		expect(lines('SMTP').map((line) => line.message).filter((message) => message.startsWith('Removing the held mail settings'))).toEqual([
			'Removing the held mail settings ended, across the server, 1 invite(s) not yet used, 1 set-up link(s), 1 request link(s) and 1 decision link(s): ' +
				'each was mailed through them.'
		]);
	});

	it('case C2: a Keep of held mail ends no mailed link; a Remove then clears every decision participant’s link, counted', async () => {
		decisionLinkOf(chief);

		expect((await release(chief, 'mail', SMTP_PLACE, 'keep')).status).toBe(200);
		expect(decisionLinksNow()).toBe(1);

		inTransaction(() => holdSettingsSetBy(ann, { log: 'a second test' }));
		const removed = await release(chief, 'mail', SMTP_PLACE, 'remove');
		expect(removed.body.ended).toMatchObject({ decisionLinks: 1 });
		expect(decisionLinksNow()).toBe(0);
		// Recorded on its decision, as every other ending of a link is.
		expect(sqlite.prepare("SELECT kind, detail, actor_user_id AS actor, source FROM decision_events WHERE kind = 'link_revoked'").all()).toEqual([
			{ kind: 'link_revoked', detail: '{"reason":"held_setting_removed"}', actor: chief.id, source: 'ui' }
		]);
	});

	it('case C3: a Remove of a held App URL ends the same four sets of mailed links, counted', async () => {
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://phish.example.test')").run();
		const place = appUrlPlaceOf('https://phish.example.test')!;
		sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)').run('app_url', place, ann.id);
		inTransaction(() => holdSettingsSetBy(ann, { log: 'a test' }));
		const other = makeUser({ username: 'other' });
		db.insert(inviteTokens).values({ tokenHash: inviteHashOf('unused-c3'), userId: other.id, expiresAt: stamp(new Date(Date.now() + 86_400_000)) }).run();
		decisionLinkOf(chief);

		const removed = await release(chief, 'app_url', place, 'remove');

		expect(removed.status, JSON.stringify(removed.body)).toBe(200);
		expect(removed.body).toEqual({ success: true, removed: 'app_url', ended: { invites: 1, enrolmentLinks: 0, requestLinks: 0, decisionLinks: 1 } });
		expect(sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'app_url'").get()).toEqual({ n: 0 });
		expect(lines('SMTP').map((line) => line.message).filter((message) => message.startsWith('Removing the held App URL'))).toEqual([
			'Removing the held App URL ended, across the server, 1 invite(s) not yet used, 0 set-up link(s), 0 request link(s) and 1 decision link(s): ' +
				'each was mailed with a link that began with it.'
		]);
	});

	it('case C4b: a Remove of held mail before any start recorded mail as set up records it first, so password-only set-up stays shut', async () => {
		expect(mailEverConfigured()).toBe(false);

		expect((await release(chief, 'mail', SMTP_PLACE, 'remove')).status).toBe(200);

		expect(isSmtpConfigured()).toBe(false);
		expect(mailEverConfigured()).toBe(true);
	});

	it('case C12b: a held destination removed, then saved again at the same place under another name, is held again; Keep releases it', async () => {
		expect((await release(chief, 'backup_destination:B', placeOf('B'), 'remove')).status).toBe(200);

		saveDestinations([A, { ...B, name: 'C' }]);

		expect(destinationHeldNow(getBackupConfig().destinations[1])).toBe(true);
		const listed = (await list(chief)).body.held.map((held: { setting: string }) => held.setting);
		expect(listed).toEqual(['backup_destination:C', 'mail']);
		expect((await runBackup('C'))[0]).toMatchObject({ destination: 'C', status: 'failed', message: DESTINATION_HELD });

		expect((await release(chief, 'backup_destination:C', placeOf('C'), 'keep')).status).toBe(200);
		expect(holdsNow().map((row) => row.setting)).toEqual(['mail']);
		expect(destinationHeldNow(getBackupConfig().destinations[1])).toBe(false);
	});

	it('case C16: Keep of a held SFTP destination is checked against the host key reviewed: one confirmed since is 409', async () => {
		const S = { type: 'sftp', name: 'S', host: 'sftp.example.test', port: 22, username: 'backup', remotePath: '/backups', hostKey: 'ssh-ed25519 SHA256:first' };
		saveDestinations([A, B, S]);
		hold('backup_destination:S', placeOf('S'));
		const reviewed = (await list(chief)).body.held.find((held: { setting: string }) => held.setting === 'backup_destination:S');
		expect(reviewed.place).not.toBe(placeOf('S'));

		saveDestinations([A, B, { ...S, hostKey: 'ssh-ed25519 SHA256:second' }]);
		const stale = await release(chief, 'backup_destination:S', reviewed.place, 'keep');

		expect(stale.status).toBe(409);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'backup_destination:S', 'mail']);
		const now = (await list(chief)).body.held.find((held: { setting: string }) => held.setting === 'backup_destination:S');
		expect((await release(chief, 'backup_destination:S', now.place, 'keep')).status).toBe(200);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
	});

	it('case 14: Keep or Remove by an administrator is 403, and of a setting not held 409; nothing is changed', async () => {
		const byAdmin = await release(ann, 'mail', SMTP_PLACE, 'keep');
		expect(byAdmin.status).toBe(403);
		const notHeld = await release(chief, 'app_url', 'a'.repeat(64), 'remove');
		expect(notHeld.status).toBe(409);
		expect(holdsNow().map((row) => row.setting)).toEqual(['backup_destination:B', 'mail']);
		expect(isSmtpConfigured()).toBe(true);
	});

	it('case 24: Remove, then a restore of a backup made before the hold: the destination comes back, held', async () => {
		sqlite.prepare('DELETE FROM setting_holds').run();
		const backup = new Database(generateBackupData());
		try {
			inTransaction(() => holdSettingsSetBy(ann, { log: 'a test' }));
			expect((await release(chief, 'backup_destination:B', placeOf('B'), 'remove')).status).toBe(200);

			restoreFromBackup(sqlite, backup);

			expect(getBackupConfig().destinations.map((d) => d.name)).toEqual(['A', 'B']);
			expect(destinationHeldNow(getBackupConfig().destinations[1])).toBe(true);
		} finally {
			backup.close();
		}
	});
});

describe('a restore carries the holds of this server (slice 1)', () => {
	it('case 25: the holds here are carried over the backup’s own, a union, and the answer counts those it lacked', () => {
		makeUser({ username: 'chief', role: 'superadmin' });
		saveDestinations([A, B]);
		hold('backup_destination:A', placeOf('A'));
		const backup = new Database(generateBackupData());
		try {
			// Held here after the backup was made: the backup does not hold it.
			hold('backup_destination:B', placeOf('B'));
			sqlite.prepare("DELETE FROM setting_holds WHERE setting = 'backup_destination:A'").run();

			const result = restoreFromBackup(sqlite, backup);

			expect(result.settingHoldsCarried).toBe(1);
			expect(holdsNow()).toEqual([
				{ setting: 'backup_destination:A', place: placeOf('A') },
				{ setting: 'backup_destination:B', place: placeOf('B') }
			]);
		} finally {
			backup.close();
		}
	});

	it('case C4a: the restore of a backup made before this release, with mail set up, records that mail was set up on this server', () => {
		makeUser({ username: 'chief', role: 'superadmin' });
		makeSmtp();
		const backup = new Database(generateBackupData());
		try {
			expect(backup.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'mail_ever_configured_at'").get()).toEqual({ n: 0 });
			sqlite.prepare("DELETE FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\'").run();
			expect(mailEverConfigured()).toBe(false);

			restoreFromBackup(sqlite, backup);

			expect(isSmtpConfigured()).toBe(true);
			expect(mailEverConfigured()).toBe(true);
		} finally {
			backup.close();
		}
	});

	it('case C4a (control): a restore of a backup with no mail host records nothing', () => {
		makeUser({ username: 'chief', role: 'superadmin' });
		const backup = new Database(generateBackupData());
		try {
			restoreFromBackup(sqlite, backup);

			expect(mailEverConfigured()).toBe(false);
		} finally {
			backup.close();
		}
	});
});

// ─── The code review's C1 and C15: saves and invites through held or own settings ─

describe('a held destination cannot be pointed elsewhere by a save (card 2941, ruling R1)', () => {
	let chief: SessionUser;
	const O = { type: 'onedrive', name: 'O', tenantId: 'tenant-o', clientId: 'client-o', clientSecret: 'secret-o', folderPath: '/DumpFire Backups', drive: 'alice@contoso.example' };
	/** One saved before card 2941: no drive. */
	const { drive: _drive, ...L } = { ...O, name: 'L' };
	const configNow = () => sqlite.prepare("SELECT value FROM settings WHERE key = 'backup_config'").get();

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		saveDestinations([O, L]);
	});

	it('case T26: a held OneDrive given another folder, and a held one saved without a drive given one, are refused 409; nothing is saved', async () => {
		hold('backup_destination:O', placeOf('O'));
		hold('backup_destination:L', placeOf('L'));
		const before = configNow();

		for (const [sent, name] of [
			[[{ ...O, folderPath: '/Elsewhere' }, L], 'O'],
			[[O, { ...L, drive: 'mallory@contoso.example' }], 'L']
		] as const) {
			const res = await api('PUT', '/api/admin/backup', stepUp(chief, { destinations: sent }));

			expect(res.status, JSON.stringify(res.body)).toBe(409);
			expect(res.body.message).toBe(
				`Backup destination "${name}" is held for the superadmin's review: where it sends its copies cannot be changed by a save. ` +
					'Keep it or remove it under Settings held for review first. Nothing was saved.'
			);
		}
		expect(configNow()).toEqual(before);
	});

	it('case T27: the same saves with nothing held go through, and each new place is recorded as the saver’s', async () => {
		const res = await api('PUT', '/api/admin/backup', stepUp(chief, { destinations: [{ ...O, folderPath: '/Elsewhere' }, { ...L, drive: 'mallory@contoso.example' }] }));

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const rows = sqlite.prepare('SELECT setting, place, user_id AS userId FROM setting_setters ORDER BY setting').all();
		expect(rows).toContainEqual({ setting: 'backup_destination:L', place: placeOf('L'), userId: chief.id });
		expect(rows).toContainEqual({ setting: 'backup_destination:O', place: placeOf('O'), userId: chief.id });
	});
});

describe('a held setting cannot be saved over, nor an invite sent through the account’s own settings (C1, C15)', () => {
	let chief: SessionUser;

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		makeSmtp();
	});

	const smtpRows = () => sqlite.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp\\_%' ESCAPE '\\' OR key = 'app_url' ORDER BY key").all();

	it('case C1a: a save that changes only the port of held mail is refused 409, and nothing is saved', async () => {
		hold('mail', SMTP_PLACE);
		const before = smtpRows();

		const res = await api('PUT', '/api/admin/smtp', stepUp(chief, { port: 2525 }));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toBe(
			"The mail settings are held for the superadmin's review: they cannot be changed by a save. Keep them or remove them under " +
				'Settings held for review first. Nothing was saved.'
		);
		expect(smtpRows()).toEqual(before);
	});

	it('case C1b: a save that changes only the case of held mail’s host is refused 409, and nothing is saved', async () => {
		hold('mail', SMTP_PLACE);
		const before = smtpRows();

		const res = await api('PUT', '/api/admin/smtp', stepUp(chief, { host: 'SMTP.Example.Test' }));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toContain("The mail settings are held for the superadmin's review");
		expect(smtpRows()).toEqual(before);
	});

	it('case C1c: a save of a held App URL is refused 409, and nothing is saved; mail not held, its own save goes', async () => {
		sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://dumpfire.example.test')").run();
		hold('app_url', appUrlPlaceOf('https://dumpfire.example.test')!);
		const before = smtpRows();

		const res = await api('PUT', '/api/admin/smtp', stepUp(chief, { appUrl: 'https://elsewhere.example.test' }));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toBe(
			"The App URL is held for the superadmin's review: it cannot be changed by a save. Keep it or remove it under Settings held " +
				'for review first. Nothing was saved.'
		);
		expect(smtpRows()).toEqual(before);
		expect((await api('PUT', '/api/admin/smtp', stepUp(chief, { port: 2525 }))).status).toBe(200);
	});

	it('case C15: an invite to an account whose own mail settings are in force is refused 409, and nothing is made or sent', async () => {
		const ann = makeUser({ username: 'ann', role: 'admin' });
		sqlite.prepare('INSERT INTO setting_setters (setting, place, user_id) VALUES (?, ?, ?)').run('mail', SMTP_PLACE, ann.id);
		process.env.APP_URL = 'https://host.example.test';

		const res = await api('POST', `/api/users/${ann.id}/invite`, stepUp(chief));

		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.message).toContain("Reset the account's two-step sign-in first");
		expect(sqlite.prepare('SELECT COUNT(*) AS n FROM invite_tokens').get()).toEqual({ n: 0 });
		expect(sent.emails).toEqual([]);

		// The control: the setter row gone, the same invite is made.
		sqlite.prepare('DELETE FROM setting_setters').run();
		expect((await api('POST', `/api/users/${ann.id}/invite`, stepUp(chief))).status).toBe(200);
	});
});

describe('a backup whose seal did not verify has its mail, destinations and App URL held (card 3009, R4)', () => {
	const NONE = { mail: 0, destinations: 0, appUrl: 0 };
	const PLANTED_HOST = 'relay.planted.test';
	const PLANTED_URL = 'https://planted.example.test';
	const P = s3('P', 'planted-bucket');
	let chief: SessionUser;
	let origin: string | undefined;

	/** This server's backup, opened to be edited: any edit leaves a seal that does not verify. */
	const opened = () => new Database(generateBackupData());
	const set = (backup: Database.Database, key: string, value: string) =>
		backup.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
	/** `backup` with the destination `entry` added to its list, as a file edited by hand holds it. */
	const plantDestination = (backup: Database.Database, entry: Record<string, unknown>) => {
		const stored = backup.prepare("SELECT value FROM settings WHERE key = 'backup_config'").pluck().get() as string;
		const config = JSON.parse(stored) as { destinations: unknown[] };
		set(backup, 'backup_config', JSON.stringify({ ...config, destinations: [...config.destinations, entry] }));
	};
	const heldUnsealed = () =>
		sqlite.prepare('SELECT setting, place FROM setting_holds WHERE held_because = ? ORDER BY setting, place').all(UNSEALED_RESTORE) as { setting: string; place: string }[];

	beforeEach(() => {
		chief = makeUser({ username: 'chief', role: 'superadmin' });
		origin = process.env.ORIGIN;
	});

	afterEach(() => {
		if (origin === undefined) delete process.env.ORIGIN;
		else process.env.ORIGIN = origin;
	});

	it('(w1) a planted mail relay is held, and no mail is sent through it; released, it sends', async () => {
		makeSmtp();
		const backup = opened();
		try {
			set(backup, 'smtp_host', PLANTED_HOST);

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(false);
			expect(result.unsealedHeld).toEqual({ ...NONE, mail: 1 });
			const place = mailPlaceOf({ host: PLANTED_HOST, port: 587, user: '', allowInsecure: false });
			expect(heldUnsealed()).toEqual([{ setting: 'mail', place }]);
			expect(await trySendEmail('a@example.test', 'Planted', '<p>x</p>')).toMatchObject({ sent: false, problem: 'held' });
			expect(sent.emails).toEqual([]);
			// The control: the hold is what stops it.
			sqlite.prepare('DELETE FROM setting_holds').run();
			expect(await trySendEmail('a@example.test', 'Released', '<p>x</p>')).toEqual({ sent: true });
		} finally {
			backup.close();
		}
	});

	it('(w2) a planted destination is held, and a scheduled backup sends nothing to it; one this server held at its place is not held', async () => {
		saveDestinations([A]);
		const backup = opened();
		try {
			plantDestination(backup, P);

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(false);
			expect(result.unsealedHeld).toEqual({ ...NONE, destinations: 1 });
			expect(heldUnsealed()).toEqual([{ setting: 'backup_destination:P', place: placeOf('P') }]);
			const results = await runBackup();
			// In the words of why it is held (card 3009's code review, FP4): no setter, none whose access was ended.
			expect(results.find((row) => row.destination === 'P')).toMatchObject({ status: 'failed', message: DESTINATION_HELD_UNSEALED });
			expect(reached.made).not.toContain('P');
			expect(reached.uploads).not.toContain('P');
			// The control: released, the next run reaches it.
			sqlite.prepare('DELETE FROM setting_holds').run();
			await runBackup();
			expect(reached.uploads).toContain('P');
		} finally {
			backup.close();
		}
	});

	it.each([
		{ kind: 'a Google Drive destination', entry: { type: 'gdrive', name: 'PG', authMethod: 'oauth', clientId: 'client-pg', clientSecret: 'secret-pg', folderId: 'folder-pg' } },
		{
			kind: 'a OneDrive destination',
			entry: { type: 'onedrive', name: 'PO', tenantId: 'tenant-po', clientId: 'client-po', clientSecret: 'secret-po', folderPath: '/DumpFire Backups', drive: 'po@contoso.example' }
		}
	])('(w2b) card 3009’s code review, FP9: $kind planted is held as an S3 one is, and a scheduled backup sends nothing to it', async ({ entry }) => {
		saveDestinations([A]);
		const backup = opened();
		try {
			plantDestination(backup, entry);

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(false);
			expect(result.unsealedHeld).toEqual({ ...NONE, destinations: 1 });
			expect(heldUnsealed()).toEqual([{ setting: `backup_destination:${entry.name}`, place: placeOf(entry.name) }]);
			const results = await runBackup();
			expect(results.find((row) => row.destination === entry.name)).toMatchObject({ status: 'failed', message: DESTINATION_HELD_UNSEALED });
			expect(reached.made).not.toContain(entry.name);
			expect(reached.uploads).not.toContain(entry.name);
		} finally {
			backup.close();
		}
	});

	it('(w3) a planted App URL is held with ORIGIN the image’s placeholder, and no link begins with it; released, links do', () => {
		process.env.ORIGIN = PLACEHOLDER_ORIGIN;
		const backup = opened();
		try {
			set(backup, 'app_url', PLANTED_URL);

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(false);
			expect(result.unsealedHeld).toEqual({ ...NONE, appUrl: 1 });
			expect(heldUnsealed()).toEqual([{ setting: 'app_url', place: appUrlPlaceOf(PLANTED_URL) }]);
			expect(getAppUrl()).not.toBe(PLANTED_URL);
			// The control: released, the placeholder restricts nothing and links begin with it.
			sqlite.prepare('DELETE FROM setting_holds').run();
			expect(getAppUrl()).toBe(PLANTED_URL);
		} finally {
			backup.close();
		}
	});

	it.each([
		{ made: 'a working copy of an unsealed backup', outside: 'off' as const, sealed: false },
		{ made: 'a sealed backup, its mail, URL and destinations not this server’s now', outside: 'keep' as const, sealed: true }
	])('(w4) $made writes no hold', ({ outside, sealed }) => {
		makeSmtp();
		saveDestinations([A]);
		const backup = opened();
		try {
			if (sealed) {
				// This server moved on since the backup: its mail, URL and destinations elsewhere now.
				sqlite.prepare("UPDATE settings SET value = 'smtp.elsewhere.test' WHERE key = 'smtp_host'").run();
				sqlite.prepare("INSERT INTO settings (key, value) VALUES ('app_url', 'https://elsewhere.example.test')").run();
				saveDestinations([B]);
			} else {
				set(backup, 'smtp_host', PLANTED_HOST);
				set(backup, 'app_url', PLANTED_URL);
				plantDestination(backup, P);
			}

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id, outside });

			expect(result.sealVerified).toBe(sealed);
			expect(result.unsealedHeld).toEqual(NONE);
			expect(heldUnsealed()).toEqual([]);
			// The working copy removes the planted App URL with the mail, and counts it (card 3009's code review, FP3); a sealed
			// restore keeps the backup's.
			expect(result.outside?.appUrl).toBe(sealed ? undefined : 1);
			// None after either: the working copy removed the planted one; the sealed backup was made before this server set one.
			expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'app_url'").pluck().get()).toBeUndefined();
		} finally {
			backup.close();
		}
	});

	it('(w6) card 3009’s code review, FP8: a hold this server carried at the planted place already is not counted again', () => {
		makeSmtp();
		// A setter's hold here, a tombstone at the planted relay's place: carried over the backup, then met by the restore's.
		const place = mailPlaceOf({ host: PLANTED_HOST, port: 587, user: '', allowInsecure: false });
		hold('mail', place);
		const backup = opened();
		try {
			set(backup, 'smtp_host', PLANTED_HOST);

			const result = restoreFromBackup(sqlite, backup, { importer: chief.id });

			expect(result.sealVerified).toBe(false);
			expect(result.unsealedHeld).toEqual(NONE);
			expect(sqlite.prepare('SELECT setting, place, held_because AS why FROM setting_holds').all()).toEqual([{ setting: 'mail', place, why: SETTER_ACCESS_ENDED }]);
		} finally {
			backup.close();
		}
	});
});

describe('a hold is told by why it was held (card 3009’s code review, FP4)', () => {
	/** Hold `setting` at `place` as an unsealed restore does: set by nobody. */
	const holdUnsealed = (setting: string, place: string) =>
		sqlite
			.prepare('INSERT INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, ?, NULL, NULL)')
			.run(setting, place, UNSEALED_RESTORE, stamp());

	it.each([
		{ why: 'an unsealed restore', unsealed: true },
		{ why: 'an ended setter (the control)', unsealed: false }
	])('(fp4a) held mail, by $why: the mail, a mail problem and the request link’s WARN in its own words', async ({ unsealed }) => {
		makeSmtp();
		if (unsealed) holdUnsealed('mail', SMTP_PLACE);
		else hold('mail', SMTP_PLACE);
		const words = unsealed ? MAIL_HELD_UNSEALED : MAIL_PROBLEM_WORDS.held;

		expect(await trySendEmail('a@example.test', 'Held', '<p>x</p>')).toEqual({ sent: false, problem: 'held', detail: words });
		expect(mailProblemWords('held')).toBe(words);
		expect(cannotMailWhy('held')).toBe(words);
		if (unsealed) {
			expect(words).not.toMatch(/access was ended|account that set/);
			expect(words).toContain('a backup whose seal did not verify');
		}
	});

	it.each([
		{ why: 'an unsealed restore', unsealed: true },
		{ why: 'an ended setter (the control)', unsealed: false }
	])('(fp4b) a destination held by $why: a run, a Test and a Connect are told it in its own words', async ({ unsealed }) => {
		saveDestinations([A]);
		if (unsealed) holdUnsealed('backup_destination:A', placeOf('A'));
		else hold('backup_destination:A', placeOf('A'));
		const words = unsealed ? DESTINATION_HELD_UNSEALED : DESTINATION_HELD;

		expect(destinationHeldWords(placeOf('A'))).toBe(words);
		const results = await runBackup();
		expect(results.find((row) => row.destination === 'A')).toMatchObject({ status: 'failed', message: words });
		const superadmin = makeUser({ username: 'chief', role: 'superadmin' });
		const shown = (await api('GET', '/api/admin/backup', { user: superadmin })).body.destinations.find((d: { name: string }) => d.name === 'A');
		const tested = await api('POST', '/api/admin/backup/test', { user: superadmin, body: shown });
		expect(tested.status).toBe(409);
		expect(tested.body.message).toBe(words);
	});

	it('(fp4c) the start’s WARN names no setter for an unsealed restore’s hold, and names the ended setter beside it', () => {
		makeSmtp();
		saveDestinations([A]);
		holdUnsealed('mail', SMTP_PLACE);

		expect(reportSettingsHeld()).toBe(1);
		const alone = lines('STARTUP').at(-1)!.message;
		expect(alone).toBe(
			"Settings held for the superadmin's review: the mail settings (restored from a backup whose seal did not verify, so where they send is " +
				"only the file's word). Nothing is sent to them until the superadmin keeps or removes each under Settings held for review on the " +
				'admin page; an older image would use them again.'
		);
		expect(alone).not.toMatch(/user unknown|whose access was ended|set by/);

		hold('backup_destination:A', placeOf('A'));
		expect(reportSettingsHeld()).toBe(2);
		const both = lines('STARTUP').at(-1)!.message;
		expect(both).toContain('backup destination "A" (set by "ann", whose access was ended); the mail settings (restored from a backup whose seal did not verify');
	});

	it('(fp4d) the review list carries why each is held, for the page to word it', async () => {
		makeSmtp();
		saveDestinations([A]);
		holdUnsealed('mail', SMTP_PLACE);
		hold('backup_destination:A', placeOf('A'));
		const superadmin = makeUser({ username: 'chief', role: 'superadmin' });

		const listed = await api('GET', '/api/admin/settings/held', { user: superadmin });

		expect(listed.status).toBe(200);
		expect(listed.body.held.map((row: { setting: string; heldBecause: string; setBy: number | null }) => [row.setting, row.heldBecause, row.setBy])).toEqual([
			['backup_destination:A', SETTER_ACCESS_ENDED, 7],
			['mail', UNSEALED_RESTORE, null]
		]);
	});
});
