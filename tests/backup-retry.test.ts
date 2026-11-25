/**
 * A backup destination tried again after a failure that passes, and every failure said in one plain sentence
 * (card 3080).
 *
 * On 2026-11-25 live's hourly Google Drive backup failed twice with Google's "502, please try again in 30 seconds"
 * page, tried once each time, and the whole page went into the mail, Backup History and the log. Now `runBackup`
 * tries each destination up to three times when it fails in a way that passes, 30 s then 60 s apart (or the far
 * end's Retry-After, up to 2 minutes), in two passes; the settings are read again and the hold asked before every
 * call; SFTP, S3 and OneDrive are first asked whether the copy already arrived; a ▶ Run Now answers after each
 * destination's first try. `backup-failure.ts` says each failure in one sentence, HTML dropped and secrets masked.
 *
 * `createDestination` is replaced by a stand-in whose `upload`, `uploadedAlready` and `list` each case scripts,
 * throwing errors built in each library's shape. The clock is faked (`setTimeout`, `clearTimeout`, `Date`) for every
 * R case, and a case never uses `vi.waitFor` under it: each wait is advanced to the millisecond. Keep Last is 0, so
 * it returns at once, but where a case is about it.
 *
 * The W cases read `backup-failure.ts`'s rules directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { RETENTION_CALL_MS, destinationHeldWordsNow, getBackupConfig, runBackup, saveBackupConfig } from '$lib/server/backup';
import { COPY_NAME, HostKeyMismatch, type DestinationConfig } from '$lib/server/backup-destinations';
import {
	RAW_LOG_MAX,
	briefFailure,
	failureOf,
	masked,
	plainFailure,
	withStop
} from '$lib/server/backup-failure';
import { SECRET_MASK, destinationPlace } from '$lib/server/backup-secrets';
import { SETTER_ACCESS_ENDED, placeKey } from '$lib/server/setting-holds';
import { confirmedHostKey } from '$lib/server/ssh-host-key';
import { sqlite } from '$lib/server/db';
import { effects, type Effects } from './helpers/effects';
import { makeSmtp, resetDb } from './helpers/fixtures';

/** What each destination's stand-in does, by its name. */
type Script = { upload: Mock; check?: Mock; list?: Mock; explode?: boolean };

const stand = vi.hoisted(() => ({ scripts: {} as Record<string, Script> }));

vi.mock('$lib/server/backup-destinations', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/server/backup-destinations')>();
	return {
		...real,
		createDestination: (config: DestinationConfig) => {
			const script = stand.scripts[config.name];
			const destination = {
				type: config.type,
				name: config.name,
				test: async () => ({ success: true, message: 'ok' }),
				upload: (...args: unknown[]) => script.upload(...args),
				...(script.check ? { uploadedAlready: (...args: unknown[]) => script.check!(...args), overwritesByName: true } : {}),
				list: async () => (script.list ? script.list() : []),
				delete: async () => {}
			};
			// A fault of DumpFire's own in a try again (the fix pass, G): reading the check throws.
			if (script.explode) {
				Object.defineProperty(destination, 'uploadedAlready', {
					get() {
						throw new Error('boom');
					}
				});
			}
			return destination;
		}
	};
});

const DRIVE: DestinationConfig = {
	type: 'gdrive',
	name: 'Drive',
	authMethod: 'oauth',
	clientId: 'client-3080.apps.example.test',
	clientSecret: 'drive-client-secret-3080',
	refreshToken: '1//drive-refresh-token-3080',
	folderId: 'folder-3080'
};
const S3: DestinationConfig = {
	type: 's3',
	name: 'Bucket',
	region: 'eu-west-2',
	bucket: 'backups-3080',
	accessKeyId: 'AKIA3080EXAMPLE',
	secretAccessKey: 's3-secret-access-key-3080',
	prefix: 'dumpfire'
};
const NAS: DestinationConfig = {
	type: 'sftp',
	name: 'NAS',
	host: 'nas.example.test',
	port: 22,
	username: 'backup',
	password: 'sftp-password-3080',
	remotePath: '/backups',
	hostKey: 'ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY'
};

/** Google's 502 page, as live met it on 2026-11-25. */
const PAGE =
	'<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 502 (Server Error)!!1</title>\n' +
	'  <p><b>502.</b> <ins>That’s an error.</ins>\n  <p>The server encountered a temporary error and could not complete your request.' +
	'<p>Please try again in 30 seconds.  <ins>That’s all we know.</ins>';

/** A Google Drive error as gaxios 7 throws it: its status, the body as its message, the API's reason on its cause. */
function driveError(status: number, opts: { body?: string; reason?: string; retryAfter?: string } = {}): Error {
	const message = opts.body ?? PAGE;
	const err = new Error(message, opts.reason ? { cause: { errors: [{ reason: opts.reason, message }] } } : undefined);
	return Object.assign(err, {
		name: 'GaxiosError',
		status,
		// The request it was, with its bearer token: never to be said anywhere.
		config: { url: 'https://www.googleapis.com/upload/drive/v3/files', headers: { Authorization: 'Bearer ya29.never-said-3080' } },
		response: { status, headers: new Headers(opts.retryAfter === undefined ? {} : { 'retry-after': opts.retryAfter }), data: message }
	});
}

/** An S3 error as the AWS SDK v3 throws it. */
function s3Error(status: number, name: string, retryAfter?: string): Error {
	return Object.assign(new Error(`${name}: please reduce your request rate`), {
		name,
		$fault: 'server',
		$metadata: { httpStatusCode: status, requestId: 'REQ3080' },
		$response: { statusCode: status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } }
	});
}

/** A dropped connection as ssh2-sftp-client throws it. */
const sftpDropped = () => Object.assign(new Error('put: Remote host has reset the connection: read ECONNRESET'), { code: 'ECONNRESET' });

const MINUTE = 60_000;

/** The settings: `destinations`, Keep Last 0, a failure mail to the chief. */
function save(destinations: DestinationConfig[], retention = 0) {
	saveBackupConfig({ schedule: 'disabled', scheduleTime: '02:00', scheduleDay: 0, retention, destinations, notifyOnFailure: true, notifyEmail: 'chief@example.test' });
}

/** A hold on `name` as the superadmin's review writes one (card 2922), and the words it is held in. */
function hold(name: string): string {
	const entry = getBackupConfig().destinations.find((d) => d.name === name)!;
	sqlite
		.prepare("INSERT OR IGNORE INTO setting_holds (setting, place, held_because, held_at, set_by, set_by_name) VALUES (?, ?, ?, datetime('now'), 7, 'ann')")
		.run(`backup_destination:${name}`, placeKey(destinationPlace(entry)), SETTER_ACCESS_ENDED);
	return destinationHeldWordsNow(entry)!;
}

/** Each destination's stand-in: `upload` answering from `answers` in turn (an Error thrown, anything else returned). */
function script(name: string, answers: Array<Error | undefined>, more: Partial<Script> = {}): Script {
	const queue = [...answers];
	const upload = vi.fn(async () => {
		const next = queue.length > 1 ? queue.shift() : queue[0];
		if (next instanceof Error) throw next;
		return undefined;
	});
	stand.scripts[name] = { upload, ...more };
	return stand.scripts[name];
}

const rows = () =>
	sqlite.prepare('SELECT destination_name AS destination, status, error, size_bytes AS size FROM backup_log ORDER BY id').all() as Array<{
		destination: string;
		status: string;
		error: string | null;
		size: number;
	}>;
const lines = () => sqlite.prepare("SELECT level, message, meta FROM system_logs WHERE context = 'BACKUP' ORDER BY id").all() as Array<{ level: string; message: string; meta: string | null }>;

/** Advance the fake clock to `at` ms after the run began, from `elapsed`, checking `upload` is called again at `at` and not a millisecond before. */
async function nextTryAt(upload: Mock, elapsed: { ms: number }, at: number) {
	const before = upload.mock.calls.length;
	await vi.advanceTimersByTimeAsync(at - elapsed.ms - 1);
	expect(upload).toHaveBeenCalledTimes(before);
	await vi.advanceTimersByTimeAsync(1);
	expect(upload).toHaveBeenCalledTimes(before + 1);
	elapsed.ms = at;
}

let sent: Effects;
let logLevel: string | undefined;

beforeEach(() => {
	resetDb();
	stand.scripts = {};
	makeSmtp();
	sent = effects();
	logLevel = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'WARN';
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-11-25T10:00:00Z') });
});

afterEach(() => {
	vi.useRealTimers();
	sent.restore();
	if (logLevel === undefined) delete process.env.LOG_LEVEL;
	else process.env.LOG_LEVEL = logLevel;
	vi.restoreAllMocks();
});

describe('the retry loop (R cases)', () => {
	it('R1: a passing failure, then success: the 2nd try at 30 s and not before; the note on the row at the insert; no mail', async () => {
		save([DRIVE]);
		const { upload } = script('Drive', [driveError(502), undefined]);

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		expect(upload).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(upload).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(upload).toHaveBeenCalledTimes(2);
		const results = await running;

		const note = 'Uploaded on the 2nd try, after Google Drive answered 502';
		expect(results).toEqual([expect.objectContaining({ destination: 'Drive', status: 'success', note: `${note}.` })]);
		expect(rows()).toEqual([expect.objectContaining({ destination: 'Drive', status: 'success', error: note })]);
		expect(sent.emails).toEqual([]);
	});

	it('R2: passing three times: waits of 30 s then 60 s, and one sentence everywhere, the page in none of it', async () => {
		save([DRIVE]);
		const { upload } = script('Drive', [driveError(502)]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 30_000);
		await nextTryAt(upload, elapsed, 90_000);
		const results = await running;

		const said = 'Google Drive answered 502, a temporary error at Google Drive; tried 3 times.';
		expect(upload).toHaveBeenCalledTimes(3);
		expect(results).toEqual([expect.objectContaining({ status: 'failed', message: said })]);
		expect(rows()).toEqual([expect.objectContaining({ status: 'failed', error: said })]);
		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].html).toContain(said);
		const everything = [JSON.stringify(results), JSON.stringify(rows()), sent.emails[0].html, JSON.stringify(lines())].join('\n');
		for (const piece of ['DOCTYPE', '<html', 'That’s an error', 'Please try again in 30 seconds', 'ya29.never-said-3080']) {
			expect(everything).not.toContain(piece);
		}
	});

	it('R3: a 401: one try, no wait, no "tried"', async () => {
		save([DRIVE]);
		const { upload } = script('Drive', [driveError(401, { body: 'Request had invalid authentication credentials.' })]);

		const results = await runBackup();
		await vi.advanceTimersByTimeAsync(5 * MINUTE);

		expect(upload).toHaveBeenCalledTimes(1);
		expect(results).toEqual([
			expect.objectContaining({ status: 'failed', message: 'Google Drive refused the sign-in (401): Request had invalid authentication credentials.' })
		]);
		expect(results[0].message).not.toContain('tried');
	});

	it('R4: passing, then not: stops at the 2nd try, naming the one that does not pass', async () => {
		save([DRIVE]);
		const quota = driveError(403, { body: "The user's Drive storage quota has been exceeded.", reason: 'storageQuotaExceeded' });
		const { upload } = script('Drive', [driveError(502), quota]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 30_000);
		const results = await running;
		await vi.advanceTimersByTimeAsync(5 * MINUTE);

		expect(upload).toHaveBeenCalledTimes(2);
		expect(results[0].message).toBe("Google Drive refused the upload with 403: The user's Drive storage quota has been exceeded; tried 2 times.");
	});

	it('R5: a Retry-After of 45: the 2nd try at 45 s', async () => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown', '45'), undefined]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 45_000);
		expect((await running)[0].status).toBe('success');
	});

	it('R6: a Retry-After of 600: the 2nd try at 120 s', async () => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown', '600'), undefined]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 120_000);
		expect((await running)[0].status).toBe('success');
	});

	it('R7: a Retry-After that is a date: the default 30 s', async () => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown', 'Wed, 25 Nov 2026 10:00:45 GMT'), undefined]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 30_000);
		expect((await running)[0].status).toBe('success');
	});

	it.each(['0', 'soon'])('R8: a Retry-After of %j is ignored: the default 30 s', async (retryAfter) => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown', retryAfter), undefined]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 30_000);
		expect((await running)[0].status).toBe('success');
	});

	it('R9: the check finds the copy whole: one upload, and the ⚠️ says it arrived', async () => {
		save([S3]);
		const check = vi.fn(async () => true);
		const { upload } = script('Bucket', [s3Error(503, 'ServiceUnavailable'), undefined], { check });

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(30_000);
		const results = await running;

		const note = 'S3 answered 503, but the copy had arrived in full; it was not sent again';
		expect(upload).toHaveBeenCalledTimes(1);
		expect(check).toHaveBeenCalledTimes(1);
		const [name, size] = check.mock.calls[0] as unknown as [string, number];
		expect(name).toMatch(COPY_NAME);
		expect(rows()).toEqual([{ destination: 'Bucket', status: 'success', error: note, size }]);
		expect(results[0].note).toBe(`${note}.`);
	});

	it.each([
		{ what: 'R10: fails with a 503', check: async () => Promise.reject(s3Error(503, 'SlowDown')) },
		{ what: 'R11: fails with a 403', check: async () => Promise.reject(s3Error(403, 'AccessDenied')) }
	])('$what: the check could not say, so the copy is uploaded again', async ({ check }) => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown'), undefined], { check: vi.fn(check) });

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(30_000);
		const results = await running;

		expect(upload).toHaveBeenCalledTimes(2);
		expect(results[0]).toEqual(expect.objectContaining({ status: 'success', note: 'Uploaded on the 2nd try, after S3 answered 503.' }));
	});

	it('R12: a check that does not answer in RETENTION_CALL_MS: uploaded again once it is given up', async () => {
		save([S3]);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown'), undefined], { check: vi.fn(() => new Promise<boolean>(() => {})) });
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		await nextTryAt(upload, elapsed, 30_000 + RETENTION_CALL_MS);
		expect((await running)[0].status).toBe('success');
	});

	it('R13: a hold written while the check is pending: no upload, and the last error with what holds it', async () => {
		save([S3]);
		let words = '';
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown'), undefined], {
			check: vi.fn(async () => {
				words = hold('Bucket');
				return false;
			})
		});

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(30_000);
		const results = await running;

		expect(upload).toHaveBeenCalledTimes(1);
		expect(results[0].message).toBe(withStop(`S3 answered 503 on the 1st try; not tried again: ${words}`));
		expect(rows()).toEqual([expect.objectContaining({ status: 'failed', error: results[0].message })]);
	});

	it('R14: a hold written during the wait: no check, no upload', async () => {
		save([S3]);
		const check = vi.fn(async () => false);
		const { upload } = script('Bucket', [s3Error(503, 'SlowDown'), undefined], { check });

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(10_000);
		const words = hold('Bucket');
		await vi.advanceTimersByTimeAsync(20_000);
		const results = await running;

		expect(upload).toHaveBeenCalledTimes(1);
		expect(check).not.toHaveBeenCalled();
		expect(results[0].message).toBe(withStop(`S3 answered 503 on the 1st try; not tried again: ${words}`));
	});

	it.each([
		{
			what: 'its secret changed',
			destination: S3,
			error: () => s3Error(503, 'SlowDown'),
			change: (d: DestinationConfig) => ({ ...d, secretAccessKey: 's3-secret-access-key-changed' }),
			first: 'S3 answered 503'
		},
		{
			what: 'its host key cleared',
			destination: NAS,
			error: sftpDropped,
			change: (d: DestinationConfig) => ({ ...d, hostKey: '' }),
			first: 'The connection to the SFTP server at nas.example.test:22 dropped during the upload'
		}
	])('R15: a destination with $what during the wait is not tried again', async ({ destination, error, change, first }) => {
		save([destination]);
		const check = vi.fn(async () => false);
		const { upload } = script(destination.name, [error(), undefined], { check });

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(10_000);
		save([change(getBackupConfig().destinations[0])]);
		await vi.advanceTimersByTimeAsync(20_000);
		const results = await running;

		expect(upload).toHaveBeenCalledTimes(1);
		expect(check).not.toHaveBeenCalled();
		expect(results[0].message).toBe(`${first} on the 1st try; not tried again: the destination was removed or changed meanwhile.`);
	});

	it('R16: two destinations: A recovers on its 2nd try, B fails three times; the one mail names B only', async () => {
		save([DRIVE, S3]);
		const a = script('Drive', [driveError(502), undefined]);
		const b = script('Bucket', [s3Error(503, 'SlowDown')]);
		const elapsed = { ms: 0 };

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(0);
		expect([a.upload.mock.calls.length, b.upload.mock.calls.length]).toEqual([1, 1]);
		await nextTryAt(a.upload, elapsed, 30_000);
		await nextTryAt(b.upload, elapsed, 60_000);
		await nextTryAt(b.upload, elapsed, 120_000);
		const results = await running;

		expect(results.map((r) => [r.destination, r.status])).toEqual([
			['Drive', 'success'],
			['Bucket', 'failed']
		]);
		expect(rows().find((r) => r.destination === 'Drive')?.error).toBe('Uploaded on the 2nd try, after Google Drive answered 502');
		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].html).toContain('<strong>Bucket</strong>');
		expect(sent.emails[0].html).not.toContain('<strong>Drive</strong>');
	});

	it('R17: a later-try success whose Keep Last then fails: the problem first, then the note', async () => {
		save([DRIVE], 2);
		script('Drive', [driveError(502), undefined], { list: vi.fn(async () => Promise.reject(new Error('Permission denied'))) });

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(30_000);
		const results = await running;

		const problem = 'Keep Last was not applied: the backups at this destination could not be listed: Permission denied';
		const note = 'Uploaded on the 2nd try, after Google Drive answered 502';
		expect(rows()).toEqual([expect.objectContaining({ status: 'success', error: `${problem}. ${note}` })]);
		expect(results[0].note).toBe(`${problem}. ${note}.`);
	});

	it('R18: one WARN a try again, and one ERROR whose meta is the facts alone', async () => {
		save([DRIVE]);
		script('Drive', [driveError(502)]);

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(90_000);
		await running;

		const said = 'Google Drive answered 502, a temporary error at Google Drive';
		expect(lines().filter((l) => l.message.startsWith('Backup try')).map((l) => [l.level, l.message])).toEqual([
			['WARN', `Backup try 1 of 3 failed: Drive → ${said}. Trying again in 30 s.`],
			['WARN', `Backup try 2 of 3 failed: Drive → ${said}. Trying again in 60 s.`]
		]);
		const errors = lines().filter((l) => l.level === 'ERROR');
		expect(errors.map((l) => l.message)).toEqual([`Backup failed: Drive → ${said}; tried 3 times.`]);
		expect(JSON.parse(errors[0].meta!)).toEqual({ status: 502, code: null, reason: null, requestId: null, tries: 3 });
	});

	it('R19: at DEBUG, one line with the message, status, code, name and request id only, masked and capped', async () => {
		process.env.LOG_LEVEL = 'DEBUG';
		save([S3]);
		const long = Object.assign(s3Error(403, 'AccessDenied'), { message: `Access Denied for s3-secret-access-key-3080 ${'x'.repeat(5000)}` });
		script('Bucket', [long]);

		await runBackup();

		const debug = lines().filter((l) => l.level === 'DEBUG');
		expect(debug).toHaveLength(1);
		const meta = JSON.parse(debug[0].meta!);
		expect(Object.keys(meta).sort()).toEqual(['code', 'message', 'name', 'requestId', 'status']);
		expect(meta).toMatchObject({ status: 403, name: 'AccessDenied', requestId: 'REQ3080' });
		expect(meta.message.length).toBeLessThanOrEqual(RAW_LOG_MAX);
		expect(meta.message).toContain(`Access Denied for ${SECRET_MASK}`);
		expect(JSON.stringify(lines())).not.toContain('s3-secret-access-key-3080');
	});

	it('R20: a Keep Last listing that fails with Google’s 502 page: the note says it in a sentence', async () => {
		save([DRIVE], 2);
		script('Drive', [undefined], { list: vi.fn(async () => Promise.reject(driveError(502))) });

		const results = await runBackup();

		expect(results[0].note).toBe(
			'Keep Last was not applied: the backups at this destination could not be listed: Google Drive answered 502, a temporary error at Google Drive.'
		);
		expect(JSON.stringify(lines())).not.toContain('DOCTYPE');
	});

	it.each([
		{ ending: 'recovers in the background: its row a success with the note, no mail', second: [undefined], recovered: true },
		{ ending: 'fails three times: its row and the one mail follow at the end', second: [driveError(502)], recovered: false }
	])('R21: Run Now answers after the first tries; A then $ending', async ({ second, recovered }) => {
		save([DRIVE, S3]);
		const a = script('Drive', [driveError(502), ...second]);
		script('Bucket', [undefined]);

		const results = await runBackup(undefined, 'manual');

		expect(results).toEqual([
			{
				destination: 'Drive',
				status: 'failed',
				retrying: true,
				message:
					'Try 1 of 3 failed, trying again in 30 s: Google Drive answered 502, a temporary error at Google Drive. Backup History will show how it ends.',
				durationMs: expect.any(Number)
			},
			expect.objectContaining({ destination: 'Bucket', status: 'success' })
		]);
		expect(rows().map((r) => r.destination)).toEqual(['Bucket']);

		await vi.advanceTimersByTimeAsync(90_000);
		await vi.advanceTimersByTimeAsync(0);

		const drive = rows().find((r) => r.destination === 'Drive');
		if (recovered) {
			expect(a.upload).toHaveBeenCalledTimes(2);
			expect(drive).toEqual(expect.objectContaining({ status: 'success', error: 'Uploaded on the 2nd try, after Google Drive answered 502' }));
			expect(sent.emails).toEqual([]);
		} else {
			expect(a.upload).toHaveBeenCalledTimes(3);
			expect(drive).toEqual(expect.objectContaining({ status: 'failed', error: 'Google Drive answered 502, a temporary error at Google Drive; tried 3 times.' }));
			expect(sent.emails).toHaveLength(1);
			expect(sent.emails[0].html).toContain('Run Now Backup Failed');
		}
	});

	it('R22: a 502, then a 503, then success: the last error named, with its try', async () => {
		save([DRIVE]);
		script('Drive', [driveError(502), driveError(503), undefined]);

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(90_000);
		const results = await running;

		expect(results[0].note).toBe('Uploaded on the 3rd try, after Google Drive answered 503 on the 2nd.');
	});
});

describe('the fix pass (card 3080)', () => {
	it('D: a hold written during the upload: Keep Last lists nothing, and the note says why', async () => {
		save([S3], 2);
		let words = '';
		const list = vi.fn(async () => []);
		script('Bucket', [undefined], { list });
		stand.scripts.Bucket.upload.mockImplementation(async () => {
			words = hold('Bucket');
		});

		const results = await runBackup();

		expect(list).not.toHaveBeenCalled();
		expect(results[0]).toEqual(expect.objectContaining({ status: 'success', note: withStop(`Keep Last was not applied: ${words}`) }));
		expect(sent.emails).toEqual([]);
	});

	it('G: a try again that throws for the 1st of two destinations: its row is written, the 2nd still tried, one mail', async () => {
		save([S3, { ...S3, name: 'Second' }]);
		const first = script('Bucket', [s3Error(503, 'SlowDown'), undefined], { explode: true });
		const second = script('Second', [s3Error(503, 'SlowDown'), undefined]);

		const running = runBackup();
		await vi.advanceTimersByTimeAsync(60_000);
		const results = await running;

		expect(first.upload).toHaveBeenCalledTimes(1);
		expect(second.upload).toHaveBeenCalledTimes(2);
		expect(results.map((r) => [r.destination, r.status, r.message])).toEqual([
			['Bucket', 'failed', 'boom.'],
			['Second', 'success', expect.stringMatching(/^Uploaded /)]
		]);
		expect(rows().map((r) => [r.destination, r.status])).toEqual([
			['Bucket', 'failed'],
			['Second', 'success']
		]);
		expect(sent.emails).toHaveLength(1);
		expect(sent.emails[0].html).toContain('<strong>Bucket</strong>');
	});

	it('F: a stored secret holding <ss> is masked, not split by the tag removal', () => {
		const secret = 'pass<ss>word-3080';
		const said = plainFailure({ ...NAS, password: secret }, new Error(`Permission denied for ${secret}`));

		expect(said).not.toContain('word-3080');
		expect(said).toContain(SECRET_MASK);
	});

	it('I: Azure AD’s AuthenticationError answering 503 passes; one answering 400 does not', () => {
		const ONE = { type: 'onedrive', name: 'One' };
		const busy = Object.assign(new Error('AADSTS90033: A transient error has occurred.'), { name: 'AuthenticationError', statusCode: 503 });
		const refused = Object.assign(new Error('AADSTS7000215: Invalid client secret provided.'), { name: 'AuthenticationError', statusCode: 400 });

		expect(failureOf(ONE, busy).temporary).toBe(true);
		expect(plainFailure(ONE, busy)).toBe('OneDrive answered 503, a temporary error at OneDrive');
		expect(failureOf(ONE, refused).temporary).toBe(false);
	});
});

describe('the rules (W cases)', () => {
	it('W1: a native fetch failure with ECONNRESET two causes down passes: the connection dropped', () => {
		const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
		const err = Object.assign(new Error('request to https://www.googleapis.com/upload/drive/v3/files failed', { cause: new TypeError('fetch failed', { cause: reset }) }), {
			name: 'GaxiosError'
		});

		expect(failureOf(DRIVE, err).temporary).toBe(true);
		expect(briefFailure(DRIVE, err)).toBe('the connection to Google Drive dropped during the upload');
		expect(plainFailure(DRIVE, err)).toBe('The connection to Google Drive dropped during the upload, a temporary network error');
	});

	it.each([
		{ reason: 'rateLimitExceeded', temporary: true, said: 'Google Drive answered 403 (rateLimitExceeded), a temporary error at Google Drive' },
		{ reason: 'dailyLimitExceeded', temporary: false, said: 'Google Drive refused the upload with 403: Daily Limit Exceeded' },
		{ reason: 'storageQuotaExceeded', temporary: false, said: "Google Drive refused the upload with 403: The user's Drive storage quota has been exceeded" }
	])('W2: Drive 403 $reason: temporary $temporary', ({ reason, temporary, said }) => {
		const body = reason === 'storageQuotaExceeded' ? "The user's Drive storage quota has been exceeded." : reason === 'dailyLimitExceeded' ? 'Daily Limit Exceeded' : 'Rate Limit Exceeded';
		const err = driveError(403, { body, reason });

		expect(failureOf(DRIVE, err).temporary).toBe(temporary);
		expect(plainFailure(DRIVE, err)).toBe(said);
	});

	it('W3: a host key refusal, DumpFire’s own, keeps its words exactly', () => {
		const key = confirmedHostKey('ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY')!;
		const mismatch = new HostKeyMismatch('nas.example.test:22', 'ssh-ed25519 SHA256:ALe9DUsmTiEbrhMq6gHWhUH7Py+bvczbvrQRhT0Y2Sg', key);
		expect(withStop(plainFailure(NAS, mismatch))).toBe(mismatch.message);
		expect(failureOf(NAS, mismatch)).toEqual({ temporary: false, own: true });
	});

	it('W3: a plain "Connection refused" with no code is rule 6: its words, not passing', () => {
		const plain = new Error('Connection refused');
		expect(failureOf(NAS, plain).temporary).toBe(false);
		expect(plainFailure(NAS, plain)).toBe('Connection refused');
	});

	it.each([
		{
			err: Object.assign(new Error('connect: All configured authentication methods failed'), { code: 'ERR_GENERIC_CLIENT' }),
			temporary: false,
			said: 'The SFTP server at nas.example.test:22 refused the sign-in: check the username and the password or private key'
		},
		{
			err: Object.assign(new Error('put: Unexpected close event'), { code: 'ERR_GENERIC_CLIENT' }),
			temporary: true,
			said: 'The connection to the SFTP server at nas.example.test:22 dropped during the upload, a temporary network error'
		},
		{
			err: Object.assign(new Error('_put: No response from server'), { code: 'ERR_GENERIC_CLIENT' }),
			temporary: true,
			said: 'The SFTP server at nas.example.test:22 stopped answering, a temporary network error'
		},
		{
			err: Object.assign(new Error('put: No SFTP connection available'), { code: 'ERR_NOT_CONNECTED' }),
			temporary: true,
			said: 'The connection to the SFTP server at nas.example.test:22 dropped during the upload, a temporary network error'
		}
	])('W4: SFTP "$err.message"', ({ err, temporary, said }) => {
		expect(failureOf(NAS, err).temporary).toBe(temporary);
		expect(plainFailure(NAS, err)).toBe(said);
	});

	it('W5: OneDrive’s fetch that failed before any answer passes: could not be reached', () => {
		const err = Object.assign(new Error('fetch failed'), { name: 'GraphError', statusCode: -1, code: 'TypeError' });
		const ONE = { type: 'onedrive', name: 'One' };

		expect(failureOf(ONE, err).temporary).toBe(true);
		expect(plainFailure(ONE, err)).toBe('OneDrive could not be reached, a temporary network error');
	});

	it.each([
		{ err: Object.assign(new Error('request to https://www.googleapis.com failed, reason: socket hang up'), { code: 'ECONNRESET' }), said: 'The connection to Google Drive dropped during the upload, a temporary network error' },
		{ err: Object.assign(new Error('The operation was aborted due to timeout'), { code: 'TimeoutError' }), said: 'Google Drive stopped answering, a temporary network error' }
	])('W6: Drive "$err.message" passes', ({ err, said }) => {
		expect(failureOf(DRIVE, err).temporary).toBe(true);
		expect(plainFailure(DRIVE, err)).toBe(said);
	});

	it.each([
		{ destination: S3, err: s3Error(503, 'SlowDown'), temporary: true, said: 'S3 answered 503 (SlowDown), a temporary error at Amazon S3' },
		{ destination: S3, err: s3Error(400, 'RequestTimeout'), temporary: true, said: 'S3 answered 400 (RequestTimeout), a temporary error at Amazon S3' },
		{
			destination: { ...S3, endpoint: 'https://minio.example.test:9000' },
			err: s3Error(503, 'SlowDown'),
			temporary: true,
			said: 'S3 answered 503 (SlowDown), a temporary error at the S3 service at minio.example.test:9000'
		}
	])('W7: $said', ({ destination, err, temporary, said }) => {
		expect(failureOf(destination, err).temporary).toBe(temporary);
		expect(plainFailure(destination, err)).toBe(said);
	});

	it('W8: Drive’s invalid_grant: its own sentence, press Connect again', () => {
		const err = Object.assign(new Error('invalid_grant'), {
			status: 400,
			response: { status: 400, headers: new Headers(), data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } }
		});

		expect(failureOf(DRIVE, err).temporary).toBe(false);
		expect(plainFailure(DRIVE, err)).toBe(
			'Google Drive refused the sign-in: the connection has expired or was withdrawn; press Connect on the destination again'
		);
	});

	it.each([
		{ what: 'a stored secret as it is', config: DRIVE, text: 'refused client_secret=drive-client-secret-3080 here', secret: 'drive-client-secret-3080' },
		{
			what: 'a stored secret URL-encoded',
			config: { ...S3, secretAccessKey: 'p@ss w/rd+3080!x' },
			text: `https://s3.example.test/?secret=${encodeURIComponent('p@ss w/rd+3080!x')}&x=1`,
			secret: encodeURIComponent('p@ss w/rd+3080!x')
		},
		{
			what: 'a stored secret JSON-escaped',
			config: { ...NAS, password: 'se"cr\\et-3080/x' },
			text: `{"password":${JSON.stringify('se"cr\\et-3080/x')}}`,
			secret: JSON.stringify('se"cr\\et-3080/x').slice(1, -1)
		}
	])('W9: masks $what', ({ config, text, secret }) => {
		const said = masked(text, config);

		expect(said).not.toContain(secret);
		expect(said).toContain(SECRET_MASK);
	});

	it('W9: masks each pattern, whatever the destination', () => {
		const examples = [
			['Authorization: Bearer abc.def-ghi_3080', 'abc.def-ghi_3080'],
			['token ya29.a0AfH6SMBx-token-3080 refused', 'a0AfH6SMBx-token-3080'],
			['refresh 1//0gLongRefreshToken-3080 refused', '0gLongRefreshToken-3080'],
			['assertion eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2lnbmF0dXJl3080 refused', 'c2lnbmF0dXJl3080'],
			['https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ADPycdsSecretSession3080', 'ADPycdsSecretSession3080'],
			['https://b.s3.example.test/k?X-Amz-Signature=abcdef0123456789&x=1', 'abcdef0123456789'],
			['https://b.s3.example.test/k?X-Amz-Credential=AKIA3080%2F20261125%2Fs3&x=1', 'AKIA3080%2F20261125'],
			['key -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg3080\n-----END PRIVATE KEY----- end', 'MIIEvQIBADANBg3080'],
			['sftp://backup:hunter2pass3080@nas.example.test/backups', 'hunter2pass3080'],
			// The fix pass, H.
			['https://login.example.test/cb?access_token=opaqueAccess3080&x=1', 'opaqueAccess3080'],
			['https://b.s3.example.test/k?X-Amz-Security-Token=FwoGZXIvYXdzSession3080&x=1', 'FwoGZXIvYXdzSession3080'],
			['https://acct.blob.example.test/c/f?sv=2024&Signature=sasSig3080%3D&x=1', 'sasSig3080'],
			['https://acct.blob.example.test/c/f?sv=2024&sig=shortSig3080&x=1', 'shortSig3080'],
			['https://tenant.sharepoint.example.test/_layouts/download.aspx?tempauth=graphTemp3080&x=1', 'graphTemp3080']
		];
		for (const [text, secret] of examples) {
			const said = masked(text, { type: 's3' });
			expect(said, text).not.toContain(secret);
			expect(said, text).toContain(SECRET_MASK);
		}
	});

	it.each([
		{
			what: 'HTML in mixed case partway through the text is dropped whole',
			err: driveError(404, { body: 'Upstream answered: <HtMl><BODY>File gone for folder-3080</BODY></HtMl>' }),
			said: 'Google Drive refused the upload with 404'
		},
		{
			what: 'a JSON body’s error_description is the reason',
			err: driveError(400, { body: '{"error":"invalid_request","error_description":"Missing required parameter: uploadType"}' }),
			said: 'Google Drive refused the upload with 400: Missing required parameter: uploadType'
		}
	])('W10: $what', ({ err, said }) => {
		expect(plainFailure(DRIVE, err)).toBe(said);
	});

	it.each([
		{ length: 200, cut: false },
		{ length: 250, cut: true }
	])('W11: a reason of $length characters, cut $cut, and no full stop', ({ length, cut }) => {
		const reason = `${'R'.repeat(length - 1)}.`;
		const said = plainFailure(DRIVE, driveError(403, { body: reason }));
		const prefix = 'Google Drive refused the upload with 403: ';

		expect(said.startsWith(prefix)).toBe(true);
		const kept = said.slice(prefix.length);
		if (cut) {
			expect(kept).toHaveLength(200);
			expect(kept.endsWith('…')).toBe(true);
		} else {
			// Its full stop dropped, nothing else.
			expect(kept).toBe('R'.repeat(length - 1));
		}
		expect(said.endsWith('.')).toBe(false);
	});
});
