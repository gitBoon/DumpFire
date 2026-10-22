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
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initBackupScheduler, lastScheduledBackupAt, runBackup, saveBackupConfig } from '$lib/server/backup';
import type { DestinationConfig } from '$lib/server/backup-destinations';
import { sqlite } from '$lib/server/db';
import { api } from './helpers/api';
import { makeSession, makeUser, resetDb } from './helpers/fixtures';
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
	/** The SFTP stand-in's own folder, and what it was asked to delete. */
	const sftp = { names: [] as string[], deleted: [] as string[] };
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
		expect(sftp.names[7]).toBe('dumpfire-backup-2026-10-22T10-00-01-manual.db');
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

		const manual = Array.from({ length: 8 }, (_, i) => `dumpfire-backup-2026-10-22T10-00-0${i + 1}-manual.db`);
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

describe('Backup History is read without writing, and Run Now does not hold back the schedule after a start (card 2412)', { timeout: 30_000 }, () => {
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

	/** A `backup_log` row as `runBackup` writes one, stamped `at` in the stored form (UTC). */
	const logged = (filename: string, at: Date, status: 'success' | 'failed' = 'success') =>
		sqlite
			.prepare(
				"INSERT INTO backup_log (destination_type, destination_name, filename, size_bytes, status, duration_ms, created_at) VALUES ('sftp', 'Offsite', ?, 1024, ?, 5, ?)"
			)
			.run(filename, status, at.toISOString().replace('T', ' ').slice(0, 19));
	const historyRows = () => sqlite.prepare('SELECT filename FROM backup_log ORDER BY created_at DESC').pluck().all() as string[];

	it('GET /api/admin/backup writes nothing, however many rows the history holds; a run trims it to the newest 10', async () => {
		const days = Array.from({ length: 12 }, (_, i) => `dumpfire-backup-2026-04-${String(i + 1).padStart(2, '0')}T00-00-00.db`);
		days.forEach((name, i) => logged(name, new Date(Date.UTC(2026, 3, i + 1))));
		const admin = makeUser({ role: 'admin' });
		const credential = { kind: 'session' as const, token: makeSession(admin) };
		const before = snapshotDb();

		const res = await api('GET', '/api/admin/backup', { user: admin, credential });

		expect(res.status).toBe(200);
		expect(res.body.history.map((row: { filename: string }) => row.filename)).toEqual([...days].reverse());
		expectUnchanged(before);

		// Trimmed where a row is added, as before.
		await backUp(OFFSITE);
		const rows = historyRows();
		expect(rows).toHaveLength(10);
		expect(rows[0]).toBe(sftp.names.find((name) => !days.includes(name)));
		expect(rows.slice(1)).toEqual([...days].reverse().slice(0, 9));
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

			await vi.waitFor(() => expect(sftp.names).toEqual(['dumpfire-backup-2026-10-22T10-01-00.db']));
		} finally {
			vi.useRealTimers();
		}
	});
});
