/**
 * Retention on a Google Drive destination (card 2238): what it removes, what
 * it sets aside, how it counts, and that it reads every page of the folder.
 *
 * Drive answered `404 File not found` on every run for three old backups the
 * account could see but not delete (made by another identity, or in a Shared
 * drive where the account is no Manager), and retention counted them and
 * picked them first each time, being the oldest: three ERROR lines a run.
 * Now each file's capabilities are read with the listing: one the account may
 * delete is deleted, one it may only trash is trashed, and one it may do
 * neither to is set aside, left out of the count, with one WARN a run.
 *
 * `googleapis` is replaced by a folder held here (`folder`), so nothing is
 * reached. Its `files.list` answers as Drive does: only the fields asked for,
 * in name order, at most 100 files a page whatever the page size asked (Drive
 * may answer fewer than asked), and a `nextPageToken` while more remain. A
 * backup is run with `runBackup`, the function the schedule calls, so the
 * upload is in the folder before retention counts it.
 *
 * The other destinations are unchanged: an SFTP destination is replaced by a
 * stub without `listForRetention`, and is counted from `list()` as before.
 *
 * And Run Now (card 2405), on the SFTP stub: a manual run names its copy
 * `…-manual.db`, and Keep Last counts those apart from the scheduled copies,
 * a Run Now removing only older Run Now copies and a scheduled run only older
 * scheduled ones, so pressing it Keep Last times no longer pushes the older
 * copies out, and the Run Now copies stay at most Keep Last.
 *
 * And the history (card 2412): reading it writes nothing, a run still trims
 * it to the newest 10, and an interval schedule counts after a start from the
 * last scheduled run, so a Run Now just before a restart does not hold the
 * next one back.
 *
 * The history is kept by runs (card 2413): every row of the newest 30 runs,
 * which the GET answers, and the last scheduled run's row whatever came after
 * it. A daily or weekly backup is not made twice in its minute across a
 * restart (card 2414): the clock is faked, and a restart is the scheduler
 * started again.
 *
 * Nor missed or doubled around downtime, clock changes, failures and repeated
 * presses (card 2415): a daily or weekly target time not made is made once
 * after a start or a missed check, once on each day the clocks change (in
 * Europe/London), a run that failed at every destination is tried again 15
 * minutes later at most three times, a stamp ahead holds no hourly run back,
 * and copies are named to the millisecond.
 *
 * A copy of the database that cannot be made (card 2416) fails each
 * destination that was to be tried, with a row and the reason, answers Run
 * Now with it, and is tried again as any run that failed everywhere; the
 * trim keeps the last scheduled run stamped before now, not one stamped ahead.
 *
 * An upload whose Backup History row cannot be written (card 2417) is a
 * success with a note: retention runs, no failure mail, no try again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBackupScheduler, lastScheduledBackupAt, runBackup, saveBackupConfig } from '$lib/server/backup';
import type { DestinationConfig } from '$lib/server/backup-destinations';
import { sqlite } from '$lib/server/db';
import { api } from './helpers/api';
import { effects, type Effects } from './helpers/effects';
import { makeSession, makeSmtp, makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

/** A file in the folder, and what the account may do to it. */
type DriveFile = { id: string; name: string; canDelete: boolean; canTrash: boolean };

const { folder, files, sftp } = vi.hoisted(() => {
	const folder: DriveFile[] = [];
	const files = {
		list: vi.fn(),
		delete: vi.fn(),
		update: vi.fn(),
		create: vi.fn()
	};
	/**
	 * The SFTP stand-in's own folder, what it was asked to delete, whether its
	 * uploads fail (card 2415), and a promise the next upload waits for, failing
	 * if it comes true (the card 2415 review).
	 */
	const sftp = { names: [] as string[], deleted: [] as string[], failing: false, hold: null as Promise<boolean> | null };
	return { folder, files, sftp };
});

vi.mock('googleapis', () => ({
	google: {
		auth: {
			OAuth2: class {
				setCredentials() {}
			},
			GoogleAuth: class {}
		},
		drive: () => ({ files })
	}
}));

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		createDestination: (config: DestinationConfig) =>
			config.type === 'sftp'
				? {
						type: 'sftp',
						name: config.name,
						test: async () => ({ success: true, message: 'ok' }),
						upload: async (_data: Buffer, filename: string) => {
							const held = sftp.hold;
							if (held) {
								sftp.hold = null;
								if (await held) throw new Error('Connection reset');
							}
							if (sftp.failing) throw new Error('Connection refused');
							sftp.names.push(filename);
						},
						list: async () => [...sftp.names].sort(),
						delete: async (filename: string) => {
							sftp.deleted.push(filename);
							sftp.names = sftp.names.filter((n) => n !== filename);
						}
					}
				: real.createDestination(config)
	};
});

const GDRIVE: DestinationConfig = {
	type: 'gdrive',
	name: 'GoogleDriveTest',
	authMethod: 'oauth',
	clientId: 'client-id',
	clientSecret: 'client-secret',
	refreshToken: 'refresh-token',
	folderId: 'folder-1'
};

/** Run one backup to `destination`, keeping `retention` copies. */
async function backUp(destination: DestinationConfig, retention = 7) {
	saveBackupConfig({
		schedule: 'disabled',
		scheduleTime: '02:00',
		scheduleDay: 0,
		retention,
		destinations: [destination],
		notifyOnFailure: false,
		notifyEmail: ''
	});
	const results = await runBackup();
	expect(results).toEqual([expect.objectContaining({ status: 'success' })]);
}

/** `count` backups made on days from 2026-04-01, older than any upload made now. */
function addBackups(count: number, can: { canDelete: boolean; canTrash: boolean } = { canDelete: true, canTrash: true }) {
	for (let i = 0; i < count; i++) {
		const n = folder.length;
		const day = new Date(Date.UTC(2026, 3, 1, 0, 0, 0) + n * 3_600_000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
		folder.push({ id: `id-${n}`, name: `dumpfire-backup-${day}.db`, ...can });
	}
}

/** What retention logged, oldest first: level and message. */
function backupLines(): { level: string; message: string }[] {
	return sqlite
		.prepare("SELECT level, message FROM system_logs WHERE context = 'BACKUP' AND message NOT LIKE 'Backup succeeded%' ORDER BY id")
		.all() as { level: string; message: string }[];
}

/** The ids `files.delete` was called with. */
const deletedIds = () => files.delete.mock.calls.map((c) => c[0].fileId as string);

let logLevel: string | undefined;

beforeEach(() => {
	resetDb();
	folder.length = 0;
	sftp.names = [];
	sftp.deleted = [];
	sftp.failing = false;
	sftp.hold = null;
	// The tests run at LOG_LEVEL=ERROR; the warning is what is looked for.
	logLevel = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});

	files.list.mockReset().mockImplementation(async (params: Record<string, any>) => {
		const q = String(params.q);
		const byName = /name = '([^']+)'/.exec(q);
		let matching = [...folder].sort((a, b) => a.name.localeCompare(b.name));
		if (byName) matching = matching.filter((f) => f.name === byName[1]);
		const start = params.pageToken ? Number(params.pageToken) : 0;
		const size = Math.min(params.pageSize ?? 100, 100);
		const page = matching.slice(start, start + size);
		const withCapabilities = String(params.fields).includes('capabilities');
		return {
			data: {
				files: page.map((f) => ({
					id: f.id,
					name: f.name,
					...(withCapabilities ? { capabilities: { canDelete: f.canDelete, canTrash: f.canTrash } } : {})
				})),
				...(start + size < matching.length && String(params.fields).includes('nextPageToken')
					? { nextPageToken: String(start + size) }
					: {})
			}
		};
	});
	files.create.mockReset().mockImplementation(async (params: Record<string, any>) => {
		const id = `id-new-${folder.length}`;
		folder.push({ id, name: params.requestBody.name, canDelete: true, canTrash: true });
		return { data: { id } };
	});
	files.delete.mockReset().mockImplementation(async ({ fileId }: { fileId: string }) => {
		const i = folder.findIndex((f) => f.id === fileId);
		// Drive's answer for a file the caller can see but may not delete.
		if (i < 0 || !folder[i].canDelete) throw Object.assign(new Error(`File not found: ${fileId}`), { code: 404 });
		folder.splice(i, 1);
	});
	files.update.mockReset().mockImplementation(async ({ fileId }: { fileId: string }) => {
		const i = folder.findIndex((f) => f.id === fileId);
		if (i < 0 || !folder[i].canTrash) throw Object.assign(new Error(`File not found: ${fileId}`), { code: 404 });
		folder.splice(i, 1);
	});
});

afterEach(() => {
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
	vi.restoreAllMocks();
});

describe('Google Drive retention', () => {
	it('deletes the oldest files by the ids it listed them under, without listing again', async () => {
		addBackups(9);
		await backUp(GDRIVE);

		// Ten files, seven kept: the three oldest deleted, by their listed ids.
		expect(deletedIds()).toEqual(['id-0', 'id-1', 'id-2']);
		expect(folder).toHaveLength(7);
		// The folder was listed for retention, and no file was looked up by name.
		expect(files.list.mock.calls.map((c) => String(c[0].q))).not.toContainEqual(expect.stringContaining("name = '"));
		expect(files.list.mock.calls[0][0].fields).toContain('capabilities(canDelete, canTrash)');
		expect(backupLines().filter((l) => l.level === 'ERROR')).toEqual([]);
		expect(backupLines().map((l) => l.message)).toContainEqual('Retention cleanup: deleted dumpfire-backup-2026-04-01T00-00-00.db from GoogleDriveTest');
		// Without these Drive answers for the account's own drive only, and a
		// folder in a Shared drive reads as empty or not found.
		for (const [params] of files.list.mock.calls) {
			expect(params).toMatchObject({ supportsAllDrives: true, includeItemsFromAllDrives: true });
		}
		for (const [params] of files.delete.mock.calls) expect(params).toMatchObject({ supportsAllDrives: true });
	});

	it('sets aside the files it may not remove, counts only the rest, and warns once', async () => {
		addBackups(3, { canDelete: false, canTrash: false });
		addBackups(7);
		await backUp(GDRIVE);

		// Eleven files, eight removable, seven kept: the oldest removable goes.
		expect(deletedIds()).toEqual(['id-3']);
		expect(files.update).not.toHaveBeenCalled();
		expect(folder.map((f) => f.id)).toEqual(expect.arrayContaining(['id-0', 'id-1', 'id-2']));
		expect(folder).toHaveLength(10);

		const lines = backupLines();
		expect(lines.filter((l) => l.level === 'ERROR')).toEqual([]);
		const warnings = lines.filter((l) => l.level === 'WARN' && l.message.startsWith('Retention:'));
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toBe(
			`Retention: 3 file(s) in GoogleDriveTest cannot be removed by this account (for example ${folder[0].name}); remove them by hand as their owner, or make the account a Manager of the Shared drive`
		);
	});

	it('moves to the trash a file it may trash and not delete', async () => {
		addBackups(1, { canDelete: false, canTrash: true });
		addBackups(6);
		await backUp(GDRIVE);

		expect(files.delete).not.toHaveBeenCalled();
		expect(files.update).toHaveBeenCalledTimes(1);
		expect(files.update).toHaveBeenCalledWith({ fileId: 'id-0', requestBody: { trashed: true }, supportsAllDrives: true });
		expect(folder).toHaveLength(7);
		const lines = backupLines();
		expect(lines.filter((l) => l.level === 'ERROR')).toEqual([]);
		// The log says where it went: a trashed copy can still be read for 30 days.
		const removed = lines.filter((l) => l.message.startsWith('Retention cleanup:')).map((l) => l.message);
		expect(removed).toEqual(['Retention cleanup: moved to the trash dumpfire-backup-2026-04-01T00-00-00.db from GoogleDriveTest']);
	});

	it('removes only the removable one of two files of one name, and does not try the other', async () => {
		// Two files of one name (not made by DumpFire, whose names carry the
		// time to the second): the first removable, the second set aside.
		const name = 'dumpfire-backup-2026-04-01T00-00-00.db';
		folder.push({ id: 'id-removable', name, canDelete: true, canTrash: true });
		folder.push({ id: 'id-set-aside', name, canDelete: false, canTrash: false });
		addBackups(6);
		await backUp(GDRIVE);

		// Eight removable with the upload, seven kept: the removable one goes.
		expect(deletedIds()).toEqual(['id-removable']);
		expect(files.update).not.toHaveBeenCalled();
		expect(folder.map((f) => f.id)).toContain('id-set-aside');
		expect(backupLines().filter((l) => l.level === 'ERROR')).toEqual([]);
	});

	it('stops with an error, not for ever, when Drive keeps answering the same page token', async () => {
		addBackups(9);
		files.list.mockImplementation(async () => {
			// A guard for the test itself: an unbounded loop would never end.
			if (files.list.mock.calls.length > 101) throw new Error('listed past the cap');
			return { data: { files: [], nextPageToken: 'same' } };
		});
		await backUp(GDRIVE);

		// 100 pages of up to 1,000 files, then an error and nothing removed.
		expect(files.list).toHaveBeenCalledTimes(100);
		expect(files.delete).not.toHaveBeenCalled();
		const errors = backupLines().filter((l) => l.level === 'ERROR');
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toBe('Retention cleanup failed for GoogleDriveTest');
		expect(sqlite.prepare("SELECT meta FROM system_logs WHERE level = 'ERROR'").get()).toMatchObject({
			meta: expect.stringContaining('more than 100 pages')
		});
	});

	it('reads every page of a folder of more than 100 files', async () => {
		addBackups(149);
		await backUp(GDRIVE);

		// 150 files over two pages, seven kept.
		expect(files.list).toHaveBeenCalledTimes(2);
		expect(files.list.mock.calls[1][0].pageToken).toBe('100');
		expect(files.delete).toHaveBeenCalledTimes(143);
		expect(folder).toHaveLength(7);
	});

	it('logs one ERROR naming a file whose delete fails otherwise, and goes on to the next', async () => {
		addBackups(9);
		const failing = folder[1];
		const real = files.delete.getMockImplementation()!;
		files.delete.mockImplementation(async (params: { fileId: string }) => {
			if (params.fileId === failing.id) throw Object.assign(new Error('Internal Error'), { code: 500 });
			return real(params);
		});
		await backUp(GDRIVE);

		expect(deletedIds()).toEqual(['id-0', 'id-1', 'id-2']);
		const errors = backupLines().filter((l) => l.level === 'ERROR');
		expect(errors).toHaveLength(1);
		expect(errors[0].message).toContain(failing.name);
		expect(folder.map((f) => f.id)).toContain(failing.id);
	});
});

describe('a destination without listForRetention', () => {
	it('is counted from list() and its oldest removed with delete(), as before', async () => {
		sftp.names = Array.from({ length: 8 }, (_, i) => `dumpfire-backup-2026-04-0${i + 1}T00-00-00.db`);
		// With its host key confirmed, without which a run does not try it (card 2250).
		await backUp({
			type: 'sftp',
			name: 'Offsite',
			host: 'sftp.example.test',
			port: 22,
			username: 'backup',
			remotePath: '/backups',
			hostKey: 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY'
		});

		// Nine with the upload, seven kept.
		expect(sftp.deleted).toEqual(['dumpfire-backup-2026-04-01T00-00-00.db', 'dumpfire-backup-2026-04-02T00-00-00.db']);
		expect(sftp.names).toHaveLength(7);
		expect(backupLines().filter((l) => l.level === 'WARN' && l.message.startsWith('Retention:'))).toEqual([]);
		expect(files.list).not.toHaveBeenCalled();
	});
});

describe('Keep Last counts Run Now copies apart from scheduled ones (card 2405)', { timeout: 30_000 }, () => {
	const OFFSITE: DestinationConfig = {
		type: 'sftp',
		name: 'Offsite',
		host: 'sftp.example.test',
		port: 22,
		username: 'backup',
		remotePath: '/backups',
		hostKey: 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY'
	};
	/** Seven scheduled copies, one a day from 2026-04-01: as many as Keep Last 7 keeps. */
	const OLDER = Array.from({ length: 7 }, (_, i) => `dumpfire-backup-2026-04-0${i + 1}T00-00-00.db`);

	/** ▶ Run Now as the panel sends it, by an administrator, a second after the last, so that each copy has a name of its own. */
	async function runNow(): Promise<void> {
		vi.setSystemTime(Date.now() + 1000);
		const admin = makeUser({ role: 'admin' });
		const res = await api('POST', '/api/admin/backup', { user: admin, credential: { kind: 'session', token: makeSession(admin) }, body: {} });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.results).toEqual([expect.objectContaining({ status: 'success' })]);
	}

	beforeEach(() => {
		// The clock alone, so that copies made a second apart are named apart; put back after each.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T10:00:00Z') });
		sftp.names = [...OLDER];
		saveBackupConfig({ schedule: 'daily', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('removes no scheduled copy on Run Now, names its copy …-manual.db, and says so in the log', async () => {
		await runNow();

		expect(sftp.deleted).toEqual([]);
		expect(sftp.names.slice(0, 7)).toEqual(OLDER);
		expect(sftp.names).toHaveLength(8);
		expect(sftp.names[7]).toBe('dumpfire-backup-2026-10-22T10-00-01-000-manual.db');
		const succeeded = sqlite
			.prepare("SELECT message FROM system_logs WHERE context = 'BACKUP' AND message LIKE 'Backup succeeded%'")
			.pluck()
			.all() as string[];
		expect(succeeded).toHaveLength(1);
		expect(succeeded[0]).toContain(`→ ${sftp.names[7]} (`);
		expect(succeeded[0]).toMatch(
			/\. Made by Run Now: Keep Last counts Run Now copies apart from scheduled ones, so only an older Run Now copy can be removed$/
		);
		expect(backupLines().filter((l) => l.message.startsWith('Retention cleanup'))).toEqual([]);
	});

	it('pressed Keep Last times and then followed by a scheduled run, still keeps the older copies a scheduled run keeps', async () => {
		for (let i = 0; i < 7; i++) await runNow();
		expect(sftp.deleted).toEqual([]);

		// The scheduled run: eight scheduled copies with its own, seven kept. The
		// seven Run Now copies are not counted, so they push nothing out.
		await runBackup();

		expect(sftp.deleted).toEqual([OLDER[0]]);
		expect(sftp.names.filter((n) => OLDER.includes(n))).toEqual(OLDER.slice(1));
		expect(sftp.names.filter((n) => n.endsWith('-manual.db'))).toHaveLength(7);
		expect(sftp.names.filter((n) => !n.endsWith('-manual.db') && !OLDER.includes(n))).toHaveLength(1);
	});

	it('pressed eight times with Keep Last 7, keeps the newest seven Run Now copies and every scheduled copy', async () => {
		for (let i = 0; i < 8; i++) await runNow();

		const manual = Array.from({ length: 8 }, (_, i) => `dumpfire-backup-2026-10-22T10-00-0${i + 1}-000-manual.db`);
		// The eighth press removed the first press's copy, and nothing else.
		expect(sftp.deleted).toEqual([manual[0]]);
		expect(sftp.names.filter((n) => n.endsWith('-manual.db'))).toEqual(manual.slice(1));
		expect(sftp.names.filter((n) => !n.endsWith('-manual.db'))).toEqual(OLDER);
		expect(backupLines().filter((l) => l.message.startsWith('Retention cleanup'))).toEqual([
			{ level: 'WARN', message: `Retention cleanup: deleted ${manual[0]} from Offsite` }
		]);
	});

	it('never removes a Run Now copy on a scheduled run, however many scheduled copies it removes', async () => {
		await runNow();
		const manualCopy = sftp.names[7];
		// Seven scheduled copies made after it, each named a day apart on from the older ones.
		for (let i = 0; i < 7; i++) sftp.names.push(`dumpfire-backup-2099-01-0${i + 1}T00-00-00.db`);

		await runBackup();

		// The run's own and the seven of 2099 are eight scheduled copies newer than all of
		// OLDER: Keep Last 7 keeps the newest seven of them and removes every older one, the
		// Run Now copy excepted.
		expect(sftp.names).toContain(manualCopy);
		expect(sftp.deleted).not.toContain(manualCopy);
		expect(sftp.names.filter((n) => !n.endsWith('-manual.db'))).toHaveLength(7);
	});
});

/** The SFTP stand-in as a destination of the history and scheduler tests (cards 2412 to 2414). */
const OFFSITE: DestinationConfig = {
	type: 'sftp',
	name: 'Offsite',
	host: 'sftp.example.test',
	port: 22,
	username: 'backup',
	remotePath: '/backups',
	hostKey: 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY'
};
const MINUTE = 60_000;

/** A time in the form `backup_log` stores it (UTC). */
const stamp = (at: Date) => at.toISOString().replace('T', ' ').slice(0, 19);
/** A `backup_log` row as `runBackup` writes one, stamped `at`. */
const logged = (filename: string, at: Date, status: 'success' | 'failed' = 'success', destination = 'Offsite') =>
	sqlite
		.prepare(
			"INSERT INTO backup_log (destination_type, destination_name, filename, size_bytes, status, duration_ms, created_at) VALUES ('sftp', ?, ?, 1024, ?, 5, ?)"
		)
		.run(destination, filename, status, stamp(at));
const historyRows = () => sqlite.prepare('SELECT filename FROM backup_log ORDER BY created_at DESC').pluck().all() as string[];

describe('Backup History is read without writing, and Run Now does not hold back the schedule after a start (card 2412)', { timeout: 30_000 }, () => {
	it('GET /api/admin/backup writes nothing, however many rows the history holds; a run under 30 runs trims nothing', async () => {
		const days = Array.from({ length: 12 }, (_, i) => `dumpfire-backup-2026-04-${String(i + 1).padStart(2, '0')}T00-00-00.db`);
		days.forEach((name, i) => logged(name, new Date(Date.UTC(2026, 3, i + 1))));
		const admin = makeUser({ role: 'admin' });
		const credential = { kind: 'session' as const, token: makeSession(admin) };
		const before = snapshotDb();

		const res = await api('GET', '/api/admin/backup', { user: admin, credential });

		expect(res.status).toBe(200);
		expect(res.body.history.map((row: { filename: string }) => row.filename)).toEqual([...days].reverse());
		expectUnchanged(before);

		// Trimmed where a row is added, to the newest 30 runs (card 2413): 13
		// runs are all kept. The trim itself is card 2413's describe below.
		await backUp(OFFSITE);
		const rows = historyRows();
		expect(rows).toHaveLength(13);
		expect(rows[0]).toBe(sftp.names.find((name) => !days.includes(name)));
		expect(rows.slice(1)).toEqual([...days].reverse());
	});

	it('takes the last scheduled run from the history, leaving out Run Now’s and failed rows, or 0 with none', () => {
		expect(lastScheduledBackupAt()).toBe(0);
		logged('dumpfire-backup-2026-10-22T08-00-00.db', new Date('2026-10-22T08:00:00Z'));
		logged('dumpfire-backup-2026-10-22T09-00-00.db', new Date('2026-10-22T09:00:00Z'), 'failed');
		logged('dumpfire-backup-2026-10-22T09-30-00-manual.db', new Date('2026-10-22T09:30:00Z'));

		expect(lastScheduledBackupAt()).toBe(Date.parse('2026-10-22T08:00:00Z'));
	});

	it('runs an hourly backup at the first check after a start when the last scheduled run was over an hour ago, a Run Now a minute before the start notwithstanding', async () => {
		const start = new Date('2026-10-22T10:00:00Z');
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: start });
		try {
			saveBackupConfig({ schedule: 'hourly', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });
			logged('dumpfire-backup-2026-10-22T08-59-00.db', new Date(start.getTime() - 61 * MINUTE));
			logged('dumpfire-backup-2026-10-22T09-59-00-manual.db', new Date(start.getTime() - MINUTE));

			// The start: the scheduler's first check is a minute in, 62 minutes after the last scheduled run.
			initBackupScheduler();
			await vi.advanceTimersByTimeAsync(MINUTE);

			await vi.waitFor(() => expect(sftp.names).toEqual(['dumpfire-backup-2026-10-22T10-01-00-000.db']));
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('Backup History keeps the newest 30 runs, and the last scheduled run whatever came after it (card 2413)', { timeout: 30_000 }, () => {
	/** A copy's name for a run started `at`, as `runBackup` names it. */
	const nameAt = (at: Date, manual = false) =>
		`dumpfire-backup-${at.toISOString().replace(/[:.]/g, '-').slice(0, 23)}${manual ? '-manual' : ''}.db`;
	/** `count` scheduled runs from 2026-04-01, an hour apart, each with a row for Offsite and one for Second; their names, oldest first. */
	const runsOfTwo = (count: number) =>
		Array.from({ length: count }, (_, i) => {
			const at = new Date(Date.UTC(2026, 3, 1) + i * 3_600_000);
			logged(nameAt(at), at);
			logged(nameAt(at), new Date(at.getTime() + 5_000), 'success', 'Second');
			return nameAt(at);
		});
	const historyAnswered = async () => {
		const admin = makeUser({ role: 'admin' });
		const res = await api('GET', '/api/admin/backup', { user: admin, credential: { kind: 'session', token: makeSession(admin) } });
		expect(res.status).toBe(200);
		return res.body.history.map((row: { filename: string }) => row.filename) as string[];
	};

	it('a run keeps every row of the newest 30 runs, both destinations’ rows of each, and removes older runs whole', async () => {
		const old = runsOfTwo(31);

		await backUp(OFFSITE);

		// The run's own row, and both rows of each of the 29 newest before it: the two oldest runs went.
		const rows = historyRows();
		expect(rows).toHaveLength(1 + 29 * 2);
		expect(rows[0]).toBe(sftp.names[0]);
		expect(new Set(rows.slice(1))).toEqual(new Set(old.slice(2)));
	});

	it('GET /api/admin/backup answers every row of the newest 30 runs', async () => {
		const old = runsOfTwo(31);

		const names = await historyAnswered();

		expect(names).toHaveLength(60);
		expect(names.slice(0, 2)).toEqual([old[30], old[30]]);
		expect(new Set(names)).toEqual(new Set(old.slice(1)));
	});

	it('keeps the last scheduled run for lastScheduledBackupAt() however many Run Now runs follow it; the GET leaves it out past 30 runs', async () => {
		const scheduled = nameAt(new Date('2026-10-01T02:00:00Z'));
		logged(scheduled, new Date('2026-10-01T02:00:00Z'));
		const failed = nameAt(new Date('2026-10-02T02:00:00Z'));
		logged(failed, new Date('2026-10-02T02:00:00Z'), 'failed');
		for (let i = 0; i < 35; i++) {
			const at = new Date(Date.UTC(2026, 9, 3) + i * 3_600_000);
			logged(nameAt(at, true), at);
		}
		saveBackupConfig({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });

		expect(await runBackup(undefined, 'manual')).toEqual([expect.objectContaining({ status: 'success' })]);

		// This Run Now and the 29 newest before it, and the scheduled run; the failed one went.
		const rows = historyRows();
		expect(rows).toHaveLength(31);
		expect(rows.at(-1)).toBe(scheduled);
		expect(rows).not.toContain(failed);
		expect(lastScheduledBackupAt()).toBe(Date.parse('2026-10-01T02:00:00Z'));

		const names = await historyAnswered();
		expect(names).toHaveLength(30);
		expect(names).not.toContain(scheduled);
	});
});

describe('A daily or weekly backup is not made twice in its minute across a restart (card 2414)', { timeout: 30_000 }, () => {
	/** A time on 2026-04-14, a Tuesday, or `day`, in the server's own time zone: the schedule's time is local. */
	const at = (h: number, m: number, s: number, day = 14) => new Date(2026, 3, day, h, m, s);
	const schedule = (kind: 'daily' | 'weekly') =>
		saveBackupConfig({ schedule: kind, scheduleTime: '02:00', scheduleDay: 2, retention: 7, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });
	const fakeClock = (now: Date) => vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now });
	/**
	 * Wait for the newest run's row, and stamp it at the faked time: SQLite
	 * stamps a row with its own clock, which the faked one does not reach.
	 */
	const rowMadeNow = async (rows: number) => {
		await vi.waitFor(() => expect(historyRows()).toHaveLength(rows));
		sqlite.prepare('UPDATE backup_log SET created_at = ? WHERE id = (SELECT MAX(id) FROM backup_log)').run(stamp(new Date()));
	};

	afterEach(() => {
		vi.useRealTimers();
	});

	it('is not run again after a plain restart in the minute, whose first check is a minute later (as before card 2414)', async () => {
		fakeClock(at(1, 59, 30));
		schedule('daily');
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE); // 02:00:30: the run
		await rowMadeNow(1);

		// The restart, at 02:00:40: its first check is at 02:01:40.
		await vi.advanceTimersByTimeAsync(10_000);
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(sftp.names).toHaveLength(1);
	});

	it.each(['daily', 'weekly'] as const)('is not run again when the clock is put back across a restart into its minute: %s', async (kind) => {
		fakeClock(at(1, 59, 30));
		schedule(kind);
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE); // 02:00:30: the run
		await rowMadeNow(1);
		const made = [...sftp.names];
		expect(made).toHaveLength(1);

		// The restart, at 02:00:40, its clock then put back to 01:59:55 (a host's
		// corrected at boot): its first check is at 02:00:55, in the minute again.
		await vi.advanceTimersByTimeAsync(10_000);
		vi.setSystemTime(at(1, 59, 55));
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(sftp.names).toEqual(made);
		expect(historyRows()).toHaveLength(1);
		// Said, once (the review).
		expect(backupLines().filter((l) => l.message.startsWith(`Scheduled ${kind} backup at 02:00 not made`))).toEqual([
			expect.objectContaining({ level: 'WARN', message: expect.stringContaining('was already made in this minute') })
		]);
	});

	it('is run on each of the next days though a scheduled run is stamped days ahead by a clock that ran fast, and says so (the review)', async () => {
		fakeClock(at(1, 59, 30));
		schedule('daily');
		// Stamped six days ahead, at the schedule's own minute.
		logged('dumpfire-backup-stamped-ahead.db', at(2, 0, 30, 20));

		for (const day of [14, 15, 16]) {
			vi.setSystemTime(at(1, 59, 30, day));
			initBackupScheduler();
			await vi.advanceTimersByTimeAsync(MINUTE);
			await rowMadeNow(day - 12);
		}

		expect(sftp.names).toHaveLength(3);
		const ahead = backupLines().filter((l) => l.message.startsWith('The last scheduled backup is recorded at'));
		expect(ahead).toHaveLength(3);
		expect(ahead[0]).toEqual({ level: 'WARN', message: expect.stringContaining("later than the server's clock") });
		expect(backupLines().some((l) => l.message.includes('not made'))).toBe(false);
	});

	it('is run in its minute after a Run Now made in that minute', async () => {
		fakeClock(at(1, 59, 50));
		schedule('daily');
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(15_000); // 02:00:05: the Run Now
		await runBackup(undefined, 'manual');
		await rowMadeNow(1);

		await vi.advanceTimersByTimeAsync(45_000); // 02:00:50: the first check

		await vi.waitFor(() => expect(sftp.names.filter((n) => !n.endsWith('-manual.db'))).toHaveLength(1));
	});

	it('is run the next day, after a restart', async () => {
		fakeClock(at(1, 59, 30));
		schedule('daily');
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE);
		await rowMadeNow(1);

		vi.setSystemTime(at(1, 59, 30, 15));
		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE);

		await rowMadeNow(2);
		expect(sftp.names).toHaveLength(2);
	});
});

describe('Scheduled backups are not missed or doubled around downtime, clock changes, failures and repeated presses (card 2415)', { timeout: 60_000 }, () => {
	/** A time in 2026 on the server's clock, which is Europe/London here. */
	const at = (month: number, day: number, h: number, m: number, s = 0) => new Date(2026, month - 1, day, h, m, s);
	const fakeClock = (now: Date) => vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now });
	const configure = (schedule: 'disabled' | 'hourly' | 'daily' | 'weekly', scheduleTime = '02:00') =>
		saveBackupConfig({ schedule, scheduleTime, scheduleDay: 2, retention: 50, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });
	/** A start: the scheduler started again at `now`, remembering nothing. */
	const startAt = (now: Date) => {
		vi.setSystemTime(now);
		initBackupScheduler();
	};
	/** `n` of the scheduler's checks, a minute apart, each let finish the run it started. */
	const checks = async (n = 1) => {
		for (let i = 0; i < n; i++) {
			await vi.advanceTimersByTimeAsync(MINUTE);
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	/** A copy's name for a run started `at`, as `runBackup` names it. */
	const copyAt = (when: Date, manual = false) =>
		`dumpfire-backup-${when.toISOString().replace(/[:.]/g, '-').slice(0, 23)}${manual ? '-manual' : ''}.db`;
	const scheduledCopies = () => sftp.names.filter((name) => !name.endsWith('-manual.db'));
	const failedRuns = () => sqlite.prepare("SELECT filename FROM backup_log WHERE status = 'failed' ORDER BY id").pluck().all() as string[];
	const warned = (start: string) => backupLines().filter((l) => l.level === 'WARN' && l.message.startsWith(start));

	let zone: string | undefined;
	beforeEach(() => {
		zone = process.env.TZ;
		process.env.TZ = 'Europe/London';
		// SQLite stamps a row with its own clock, which the faked one does not
		// reach: a row a run writes is stamped again at the faked time. A row
		// written here with a time of its own is left as it is.
		sqlite.function('faked_now', () => stamp(new Date()));
		sqlite.exec(`CREATE TEMP TRIGGER IF NOT EXISTS stamp_by_faked_clock AFTER INSERT ON backup_log
			WHEN NEW.created_at = datetime('now')
			BEGIN UPDATE backup_log SET created_at = faked_now() WHERE id = NEW.id; END`);
	});
	afterEach(() => {
		vi.useRealTimers();
		sqlite.exec('DROP TRIGGER IF EXISTS temp.stamp_by_faked_clock');
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	});

	it('daily: a start after its time, with no backup made for it, makes it once at the first check', async () => {
		fakeClock(at(4, 14, 9, 0));
		configure('daily');
		logged(copyAt(at(4, 13, 2, 0, 30)), at(4, 13, 2, 0, 30));

		initBackupScheduler();
		await checks(60);
		startAt(at(4, 14, 10, 0, 30));
		await checks(2);

		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 9, 1))]);
		expect(warned('Scheduled daily backup at 02:00 was not made at its time')).toHaveLength(1);
	});

	it('daily: a check missed in a running process (busy past the minute) is made up at the next', async () => {
		fakeClock(at(4, 14, 1, 59, 30));
		configure('daily');
		logged(copyAt(at(4, 13, 2, 0, 30)), at(4, 13, 2, 0, 30));
		initBackupScheduler();

		vi.setSystemTime(at(4, 14, 2, 5)); // held past 02:00 and its minute
		await checks(3);

		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 2, 6))]);
	});

	it('weekly: a start the day after its day makes it once, and the next week’s is made on its day', async () => {
		fakeClock(at(4, 15, 10, 0)); // Wednesday; the schedule is Tuesday 02:00
		configure('weekly');
		logged(copyAt(at(4, 7, 2, 0, 30)), at(4, 7, 2, 0, 30));

		initBackupScheduler();
		await checks(2);
		startAt(at(4, 16, 10, 0)); // Thursday
		await checks(2);
		startAt(at(4, 21, 1, 59, 30)); // the next Tuesday
		await checks(2);

		expect(scheduledCopies()).toEqual([copyAt(at(4, 15, 10, 1)), copyAt(at(4, 21, 2, 0, 30))]);
	});

	it('a schedule set in a running process after its time does not run until its next time', async () => {
		fakeClock(at(4, 14, 9, 0));
		configure('disabled');
		initBackupScheduler();
		await checks(1);

		configure('daily');
		await checks(5);
		expect(sftp.names).toEqual([]);

		vi.setSystemTime(at(4, 15, 1, 59, 30));
		await checks(1);
		expect(scheduledCopies()).toEqual([copyAt(at(4, 15, 2, 0, 30))]);
	});

	it('the clocks going back: a daily 01:30 is made once on 25 October 2026, a restart in the hour that comes twice notwithstanding', async () => {
		fakeClock(new Date('2026-10-25T00:29:30Z')); // 01:29:30 BST
		configure('daily', '01:30');
		logged(copyAt(at(10, 24, 1, 30, 30)), at(10, 24, 1, 30, 30));

		initBackupScheduler();
		await checks(1); // 01:30:30 BST: the run
		expect(scheduledCopies()).toEqual(['dumpfire-backup-2026-10-25T00-30-30-000.db']);

		startAt(new Date('2026-10-25T01:29:30Z')); // 01:29:30 GMT, the hour again
		await checks(60);

		expect(scheduledCopies()).toEqual(['dumpfire-backup-2026-10-25T00-30-30-000.db']);
	});

	it('the clocks going forward: a daily 01:30 is made once on 29 March 2026, at 02:30 BST', async () => {
		fakeClock(new Date('2026-03-29T00:59:30Z')); // 00:59:30 GMT
		configure('daily', '01:30');
		logged(copyAt(at(3, 28, 1, 30, 30)), at(3, 28, 1, 30, 30));

		initBackupScheduler();
		await checks(90); // to 03:29:30 BST

		expect(scheduledCopies()).toEqual(['dumpfire-backup-2026-03-29T01-30-30-000.db']);
	});

	it('hourly: a run that failed at every destination is tried again 15 minutes later', async () => {
		fakeClock(at(4, 14, 10, 0));
		configure('hourly');
		logged(copyAt(at(4, 14, 8, 0)), at(4, 14, 8, 0));
		sftp.failing = true;

		initBackupScheduler();
		await checks(1); // 10:01: fails
		sftp.failing = false;
		await checks(15); // 10:16: tried again

		expect(failedRuns()).toEqual([copyAt(at(4, 14, 10, 1))]);
		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 10, 16))]);
		expect(warned('Scheduled backup failed at every destination: tried again at')).toHaveLength(1);
		expect(warned('Scheduled backup tried again (1 of 3)')).toHaveLength(1);
	});

	it('hourly: tried again at most three times, then hourly; a run that succeeds gives the three back', async () => {
		fakeClock(at(4, 14, 10, 0));
		configure('hourly');
		logged(copyAt(at(4, 14, 8, 0)), at(4, 14, 8, 0));
		sftp.failing = true;

		initBackupScheduler();
		await checks(120); // to 12:00
		expect(failedRuns()).toEqual([[10, 1], [10, 16], [10, 31], [10, 46], [11, 46]].map(([h, m]) => copyAt(at(4, 14, h, m))));
		expect(warned('Scheduled backup failed at every destination, and its 3 tries again are spent')).toHaveLength(1);

		sftp.failing = false;
		await checks(46); // 12:46: succeeds
		sftp.failing = true;
		await checks(75); // 13:46 fails, 14:01 tried again

		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 12, 46))]);
		expect(failedRuns().slice(5)).toEqual([copyAt(at(4, 14, 13, 46)), copyAt(at(4, 14, 14, 1))]);
	});

	it('daily: a run that failed at every destination is tried again 15 minutes later, not the next day', async () => {
		fakeClock(at(4, 14, 1, 59, 30));
		configure('daily');
		logged(copyAt(at(4, 13, 2, 0, 30)), at(4, 13, 2, 0, 30));
		sftp.failing = true;

		initBackupScheduler();
		await checks(1); // 02:00:30: fails
		sftp.failing = false;
		await checks(15); // 02:15:30: tried again

		expect(failedRuns()).toEqual([copyAt(at(4, 14, 2, 0, 30))]);
		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 2, 15, 30))]);
	});

	it('hourly: after a start, a scheduled run stamped six days ahead does not hold the next one back, and is said', async () => {
		fakeClock(at(4, 14, 10, 0));
		configure('hourly');
		logged(copyAt(at(4, 14, 8, 0)), at(4, 14, 8, 0));
		logged('dumpfire-backup-stamped-ahead.db', at(4, 20, 8, 0));

		initBackupScheduler();
		await checks(60);

		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 10, 1))]);
		expect(warned('The last scheduled backup is recorded at')).toEqual([
			expect.objectContaining({ message: expect.stringContaining("later than the server's clock") })
		]);
	});

	it('two Run Now presses in one second, or in one millisecond, make copies of their own and runs of their own', async () => {
		fakeClock(new Date('2026-10-23T09:00:00.000Z'));
		configure('disabled');

		for (const after of [0, 300, 0]) {
			vi.setSystemTime(Date.now() + after);
			expect(await runBackup(undefined, 'manual')).toEqual([expect.objectContaining({ status: 'success' })]);
		}

		const names = ['000', '300', '301'].map((ms) => `dumpfire-backup-2026-10-23T09-00-00-${ms}-manual.db`);
		expect(sftp.names).toEqual(names);
		expect(new Set(historyRows())).toEqual(new Set(names));
	});

	// The code review's.
	it('the time set to 02:00 at 01:59:40 in a running process runs at 02:00, its first check after the change being past it', async () => {
		fakeClock(at(4, 14, 1, 58, 30));
		configure('daily', '03:00');
		logged(copyAt(at(4, 13, 3, 0, 30)), at(4, 13, 3, 0, 30));
		initBackupScheduler();
		await checks(1); // 01:59:30

		await vi.advanceTimersByTimeAsync(10_000);
		configure('daily', '02:00'); // 01:59:40
		await checks(1); // the check at 02:00:30

		expect(scheduledCopies()).toEqual([copyAt(at(4, 14, 2, 0, 30))]);
	});

	it('daily 02:00 switched on at 01:59:40 in a running process runs at 02:00', async () => {
		// The 15th: a copy named in the same millisecond as the last test's is named a millisecond on.
		fakeClock(at(4, 15, 1, 58, 30));
		configure('disabled');
		initBackupScheduler();
		await checks(1); // 01:59:30

		await vi.advanceTimersByTimeAsync(10_000);
		configure('daily'); // 01:59:40
		await checks(2); // the checks at 02:00:30 and 02:01:30

		expect(scheduledCopies()).toEqual([copyAt(at(4, 15, 2, 0, 30))]);
	});

	it('three starts two hours apart, the run due having already failed, make one try each and no tries again', async () => {
		fakeClock(at(4, 14, 9, 0));
		configure('daily');
		logged(copyAt(at(4, 13, 2, 0, 30)), at(4, 13, 2, 0, 30));
		logged(copyAt(at(4, 14, 2, 0, 30)), at(4, 14, 2, 0, 30), 'failed');
		sftp.failing = true;

		for (const h of [9, 11, 13]) {
			startAt(at(4, 14, h, 0));
			await checks(110);
		}

		expect(failedRuns()).toEqual([[2, 0, 30], [9, 1, 0], [11, 1, 0], [13, 1, 0]].map(([h, m, s]) => copyAt(at(4, 14, h, m, s))));
		expect(warned('This scheduled backup already failed before this start')).toHaveLength(3);
		expect(warned('Scheduled backup failed at every destination: tried again at')).toEqual([]);
	});

	it('a run that failed only before anything was sent (an SFTP host key not confirmed) is not tried again', async () => {
		fakeClock(at(4, 14, 10, 0));
		saveBackupConfig({ schedule: 'hourly', scheduleTime: '02:00', scheduleDay: 2, retention: 50, destinations: [{ ...OFFSITE, hostKey: '' }], notifyOnFailure: false, notifyEmail: '' });
		logged(copyAt(at(4, 14, 8, 0)), at(4, 14, 8, 0));

		initBackupScheduler();
		await checks(50);

		expect(failedRuns()).toEqual([copyAt(at(4, 14, 10, 1))]);
		expect(warned('Scheduled backup failed at every destination before anything was sent')).toHaveLength(1);
		expect(warned('Scheduled backup failed at every destination: tried again at')).toEqual([]);
	});

	it('a run that fails after a later run has succeeded, the two overlapping, is not tried again', async () => {
		fakeClock(at(4, 16, 10, 0)); // a day of its own, as above
		configure('hourly');
		logged(copyAt(at(4, 16, 8, 0)), at(4, 16, 8, 0));
		let release!: (fail: boolean) => void;
		sftp.hold = new Promise<boolean>((resolve) => (release = resolve));

		initBackupScheduler();
		await checks(61); // 10:01: held; 11:01: succeeds
		expect(scheduledCopies()).toEqual([copyAt(at(4, 16, 11, 1))]);

		release(true); // 10:01's upload fails now
		await checks(30);

		expect(failedRuns()).toEqual([copyAt(at(4, 16, 10, 1))]);
		expect(scheduledCopies()).toEqual([copyAt(at(4, 16, 11, 1))]);
		expect(warned('Scheduled backup failed at every destination: tried again at')).toEqual([]);
	});
});

describe('A copy of the database that cannot be made is recorded, answered and tried again, and the trim keeps the last scheduled run before now (card 2416)', { timeout: 60_000 }, () => {
	const FULL = 'The copy of the database could not be made: database or disk is full';
	/**
	 * `generateBackupData()` failing as on a full volume: its `VACUUM INTO`
	 * throws, every other statement runs. The function is called inside its
	 * own module, so a spy on the export would not reach it.
	 */
	const copyFails = () => {
		const exec = sqlite.exec.bind(sqlite);
		return vi.spyOn(sqlite, 'exec').mockImplementation(((source: string) => {
			if (source.startsWith('VACUUM INTO')) throw new Error('database or disk is full');
			return exec(source);
		}) as typeof sqlite.exec);
	};
	type Row = { destination: string; filename: string; status: string; error: string | null; size: number };
	const rows = () =>
		sqlite.prepare('SELECT destination_name AS destination, filename, status, error, size_bytes AS size FROM backup_log ORDER BY id').all() as Row[];
	/** A copy's name for a run started `at`, as `runBackup` names it. */
	const copyAt = (when: Date, manual = false) =>
		`dumpfire-backup-${when.toISOString().replace(/[:.]/g, '-').slice(0, 23)}${manual ? '-manual' : ''}.db`;
	const warned = (start: string) => backupLines().filter((l) => l.level === 'WARN' && l.message.startsWith(start));

	afterEach(() => {
		vi.useRealTimers();
	});

	it('Run Now: each destination that was to be tried fails with the reason and a row, one ERROR, and the answer says so', async () => {
		const unconfirmed = { ...OFFSITE, name: 'Unconfirmed', hostKey: '' };
		const second = { ...OFFSITE, name: 'Second' };
		saveBackupConfig({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [OFFSITE, unconfirmed, second], notifyOnFailure: false, notifyEmail: '' });
		copyFails();
		const admin = makeUser({ role: 'admin' });

		const res = await api('POST', '/api/admin/backup', { user: admin, credential: { kind: 'session', token: makeSession(admin) }, body: {} });

		// It was a 500, with nothing in Backup History.
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const hostKey = expect.stringMatching(/^SFTP host key not confirmed: /);
		expect(res.body.results.map((r: { destination: string; status: string; message: string }) => [r.destination, r.status, r.message])).toEqual([
			['Offsite', 'failed', FULL],
			['Unconfirmed', 'failed', hostKey],
			['Second', 'failed', FULL]
		]);
		expect(sftp.names).toEqual([]);
		const written = rows();
		expect(written.map((r) => [r.destination, r.status, r.error, r.size])).toEqual([
			['Unconfirmed', 'failed', hostKey, 0],
			['Offsite', 'failed', FULL, 0],
			['Second', 'failed', FULL, 0]
		]);
		// One run in Backup History: the rows share the run's name.
		expect(new Set(written.map((r) => r.filename)).size).toBe(1);
		expect(written[0].filename).toMatch(/^dumpfire-backup-.*-manual\.db$/);
		expect(backupLines().filter((l) => l.level === 'ERROR' && l.message.startsWith('The copy of the database could not be made'))).toHaveLength(1);
	});

	it('scheduled: a run whose copy cannot be made is a failed row, and is tried again 15 minutes later as a run that failed at every destination', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date('2026-04-17T10:00:00Z') });
		saveBackupConfig({ schedule: 'hourly', scheduleTime: '02:00', scheduleDay: 0, retention: 50, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });
		logged(copyAt(new Date('2026-04-17T08:00:00Z')), new Date('2026-04-17T08:00:00Z'));
		const copy = copyFails();

		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE); // 10:01: the copy fails
		await vi.waitFor(() => expect(rows()).toHaveLength(2));
		copy.mockRestore();
		await vi.advanceTimersByTimeAsync(15 * MINUTE); // 10:16: tried again

		await vi.waitFor(() => expect(sftp.names).toEqual([copyAt(new Date('2026-04-17T10:16:00Z'))]));
		expect(rows().filter((r) => r.status === 'failed').map((r) => [r.filename, r.error])).toEqual([[copyAt(new Date('2026-04-17T10:01:00Z')), FULL]]);
		expect(warned('Scheduled backup failed at every destination: tried again at')).toHaveLength(1);
		expect(warned('Scheduled backup failed at every destination before anything was sent')).toEqual([]);
	});

	it('the trim keeps the last scheduled run stamped before now, though a later one is stamped ahead, however many Run Now runs follow', async () => {
		const DAY = 86_400_000;
		const now = Date.now();
		const real = new Date(Math.floor((now - 50 * DAY) / 1000) * 1000);
		logged(copyAt(real), real);
		// Stamped six days ahead by a clock that ran fast.
		logged('dumpfire-backup-stamped-ahead.db', new Date(now + 6 * DAY));
		for (let i = 0; i < 35; i++) {
			const at = new Date(now - 40 * DAY + i * 3_600_000);
			logged(copyAt(at, true), at);
		}
		saveBackupConfig({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 7, destinations: [OFFSITE], notifyOnFailure: false, notifyEmail: '' });

		expect(await runBackup(undefined, 'manual')).toEqual([expect.objectContaining({ status: 'success' })]);

		// The newest 30 runs (the row ahead, this Run Now and 28 before it), and the last scheduled run before now.
		const kept = historyRows();
		expect(kept).toHaveLength(31);
		expect(kept).toContain('dumpfire-backup-stamped-ahead.db');
		expect(kept.at(-1)).toBe(copyAt(real));
		expect(lastScheduledBackupAt()).toBe(real.getTime());
	});
});

describe('An upload whose Backup History row cannot be written is a success, with a note (card 2417)', { timeout: 60_000 }, () => {
	const NOTE = /^Uploaded, but Backup History could not record it: .*database or disk is full/;
	/** `backup_log`'s insert failing as on a full volume; every other statement runs. */
	const rowsCannotBeWritten = () => {
		const prepare = sqlite.prepare.bind(sqlite);
		return vi.spyOn(sqlite, 'prepare').mockImplementation(((source: string) => {
			if (/^insert into "backup_log"/i.test(source)) throw new Error('database or disk is full');
			return prepare(source);
		}) as typeof sqlite.prepare);
	};
	const backupRows = () => sqlite.prepare('SELECT COUNT(*) FROM backup_log').pluck().get() as number;
	const errors = (start: string) => backupLines().filter((l) => l.level === 'ERROR' && l.message.startsWith(start));
	let sent: Effects;

	beforeEach(() => {
		makeSmtp();
		sent = effects();
	});
	afterEach(() => {
		sent.restore();
		vi.useRealTimers();
	});

	it('Run Now: answers success with the note, runs retention, sends no failure mail and logs one ERROR', async () => {
		saveBackupConfig({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention: 2, destinations: [OFFSITE], notifyOnFailure: true, notifyEmail: 'chief@example.test' });
		sftp.names = ['dumpfire-backup-2026-04-01T00-00-00-000-manual.db', 'dumpfire-backup-2026-04-02T00-00-00-000-manual.db', 'dumpfire-backup-2026-04-03T00-00-00-000-manual.db'];
		rowsCannotBeWritten();

		const results = await runBackup(undefined, 'manual');

		// It was answered as failed with the database's error, mailed, and kept out of retention.
		expect(results).toEqual([
			expect.objectContaining({ destination: 'Offsite', status: 'success', message: expect.stringMatching(/^Uploaded dumpfire-backup-.*-manual\.db /), note: expect.stringMatching(NOTE) })
		]);
		expect(sftp.deleted).toEqual(['dumpfire-backup-2026-04-01T00-00-00-000-manual.db', 'dumpfire-backup-2026-04-02T00-00-00-000-manual.db']);
		expect(sent.emails).toEqual([]);
		expect(backupRows()).toBe(0);
		expect(errors('Backup History row for Offsite could not be written, though')).toHaveLength(1);
		expect(errors('Backup failed')).toEqual([]);
	});

	it('scheduled: is a run that succeeded, so it is not tried again 15 minutes later', async () => {
		vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date('2026-04-17T10:00:00Z') });
		saveBackupConfig({ schedule: 'hourly', scheduleTime: '02:00', scheduleDay: 0, retention: 50, destinations: [OFFSITE], notifyOnFailure: true, notifyEmail: 'chief@example.test' });
		logged('dumpfire-backup-2026-04-17T08-00-00-000.db', new Date('2026-04-17T08:00:00Z'));
		rowsCannotBeWritten();

		initBackupScheduler();
		await vi.advanceTimersByTimeAsync(MINUTE); // 10:01: uploaded, its row not written
		await vi.waitFor(() => expect(sftp.names).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(20 * MINUTE); // past 10:16, when a failed run is tried again

		expect(sftp.names).toHaveLength(1);
		expect(backupLines().filter((l) => l.level === 'WARN' && l.message.startsWith('Scheduled backup failed at every destination'))).toEqual([]);
		expect(sent.emails).toEqual([]);
		expect(errors('Backup History row for Offsite could not be written, though')).toHaveLength(1);
	});
});
