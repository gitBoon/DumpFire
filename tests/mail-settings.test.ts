/**
 * The mail settings: where the saved mail password may be sent (card 2190),
 * and the connection every mail is sent over (card 2189).
 *
 * `PUT /api/admin/smtp` kept the stored password whenever it was sent back
 * masked, whatever host it was now saved with, and kept it too when it was
 * left out (`{ host: 'smtp.evil.example' }`), since only the keys sent are
 * written. So a mistaken edit, or a session in the wrong hands, could send the
 * stored password to a mail server of anybody's choosing without knowing it.
 *
 * The rule now (`keepMailPassword` in `src/lib/server/backup-secrets.ts`, the
 * rule a restore fills the password by): a password masked or left out is
 * kept only while the host (trimmed, in any case), port, user name and "Allow
 * mail without a checked, encrypted connection" are as stored, read as the
 * mailer reads them; otherwise the save is a `400` naming what changed, and
 * nothing is written. A password typed, an empty one included, is saved as
 * typed. The sender's address and name and the App URL decide nothing about
 * where the password goes and are not compared, so the App URL saved alone is
 * never refused.
 *
 * Mail on any port but 465 went out without requiring STARTTLS, and without
 * checking the server's certificate unless "Use SSL/TLS" was ticked, so anyone
 * on the network path could strip STARTTLS or present any certificate and read
 * the password and every message. Now every port but 465 requires STARTTLS,
 * every port checks the certificate, and "Use SSL/TLS" is no longer read; the
 * one way out, `smtp_allow_insecure`, gives back the old options on any port
 * but 465. The transport is a stand-in (a spy on `nodemailer.createTransport`,
 * as `effects()` installs one): the suite reaches no mail server, so the tests
 * read the options each mail is handed to nodemailer with.
 */
import nodemailer from 'nodemailer';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '$lib/server/auth';
import { db, sqlite } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';
import { TLS_FAULT_HINT, sendEmail, sendEmailWithAttachment, sendTestEmail } from '$lib/server/email';
import { eq } from 'drizzle-orm';
import { api } from './helpers/api';
import { makeUser, resetDb } from './helpers/fixtures';
import { expectUnchanged, snapshotDb } from './helpers/snapshot';

const MASK = '••••••••';
const PASSWORD = 'the-stored-mail-password-2190';

/**
 * Mail set up and signed in to, as the panel saves it, and "Use SSL/TLS"
 * ticked before card 2189: the row is left where it is and no longer read.
 */
const STORED: Record<string, string> = {
	smtp_host: 'smtp.example.test',
	smtp_port: '587',
	smtp_secure: 'true',
	smtp_allow_insecure: 'false',
	smtp_user: 'mailer',
	smtp_pass: PASSWORD,
	smtp_from_address: 'board@example.test',
	smtp_from_name: 'The Board'
};

/** The panel's save as the GET filled it: every field as stored, the password masked. */
const PANEL = { host: 'smtp.example.test', port: 587, allowInsecure: false, user: 'mailer', pass: MASK, fromAddress: 'board@example.test', fromName: 'The Board' };

/** The way out's name on the panel, in the words of decision 14. */
const WAY_OUT = '"Allow mail without a checked, encrypted connection"';

/** Decision 4's words, naming what changed. */
const typeAgain = (changes: string) =>
	`Type the mail password again. The saved password is used only with the host, port, user name and ${WAY_OUT} ` +
	`setting it was saved with, and this changes the ${changes}.`;

/** Decision 15's sentence, spelt out once so that the words are held as well as the function. */
const TLS_HINT =
	"The mail server's certificate could not be checked, or the server does not offer STARTTLS. For a certificate " +
	'from a private authority, see docs/deployment.md, Mail Server Certificates; for a relay on this server\'s own ' +
	`network that cannot use TLS, tick ${WAY_OUT} and type the password again.`;

let chief: SessionUser;

const stored = () => Object.fromEntries(db.select().from(settings).all().map((row) => [row.key, row.value]));
const save = (body: Record<string, unknown>) => api('PUT', '/api/admin/smtp', { user: chief, body });

beforeEach(() => {
	resetDb();
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	db.insert(settings).values(Object.entries(STORED).map(([key, value]) => ({ key, value }))).run();
});

describe('a mail password masked or left out (test 19)', () => {
	const CHANGES: [string, Record<string, unknown>, string][] = [
		['the host', { host: 'smtp.invalid' }, 'host'],
		['the port', { port: 465 }, 'port'],
		['the user name', { user: 'someone-else' }, 'user name'],
		['the way out', { allowInsecure: true }, `${WAY_OUT} setting`],
		['the host and the port', { host: 'smtp.invalid', port: 25 }, 'host and port']
	];

	it.each(CHANGES)('is not kept for a change of %s when it is sent masked, and nothing is written', async (_case, change, named) => {
		const before = snapshotDb();

		const res = await save({ ...PANEL, ...change });

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body.message).toBe(typeAgain(named));
		expectUnchanged(before);
	});

	it.each(CHANGES)('is not kept for a change of %s when it is left out, and nothing is written', async (_case, change, named) => {
		const before = snapshotDb();

		const res = await save(change);

		expect(res.status, JSON.stringify(res.body)).toBe(400);
		expect(res.body.message).toBe(typeAgain(named));
		expectUnchanged(before);
	});

	// The review-fix pass's S1: the host is trimmed of ASCII spaces and tabs
	// alone, and only ASCII letters are in any case, so a host that `trim()`
	// and `toLowerCase()` would have made the stored one is a change.
	it.each<[string, string, string | null]>([
		['a no-break space after it', 'smtp.example.test ', null],
		['a byte-order mark before it', '﻿smtp.example.test', null],
		['an ideographic space after it', 'smtp.example.test　', null],
		['a Kelvin sign for its k', 'smtp.eKample.test', 'smtp.ekample.test']
	])('is not kept for the host with %s, masked or left out, and nothing is written', async (_case, host, storedHost) => {
		if (storedHost !== null) setMail({ smtp_host: storedHost });
		const before = snapshotDb();

		for (const body of [{ ...PANEL, host }, { host }]) {
			const res = await save(body);
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(res.body.message).toBe(typeAgain('host'));
		}
		expectUnchanged(before);
	});
});

describe('what keeps the mail password, and what saves a new one (test 20)', () => {
	it('keeps it when only the sender’s address and name change', async () => {
		const res = await save({ ...PANEL, fromAddress: 'reports@example.test', fromName: 'Reports' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored()).toEqual({ ...STORED, smtp_from_address: 'reports@example.test', smtp_from_name: 'Reports' });
	});

	it('keeps it, and the stored host, for the host in capitals with spaces and a tab, a port sent as text, and a save that sends no host', async () => {
		// The stored host is written, not the one sent (S1): the password goes
		// to the host it was saved with, byte for byte.
		expect((await save({ ...PANEL, host: '  SMTP.Example.TEST \t' })).status).toBe(200);
		expect(stored()).toEqual(STORED);
		expect((await save({ host: '\tSMTP.EXAMPLE.TEST' })).status).toBe(200);
		expect(stored()).toEqual(STORED);

		expect((await save({ port: '587' })).status).toBe(200);
		expect((await save({ user: 'mailer', pass: MASK })).status).toBe(200);
		expect(stored()).toEqual(STORED);
	});

	it('keeps it where the way out was never saved and is sent off, and where "Use SSL/TLS" is sent changed', async () => {
		// Mail set up before card 2189 has no row: it reads as off.
		db.delete(settings).where(eq(settings.key, 'smtp_allow_insecure')).run();

		expect((await save({ ...PANEL, secure: false })).status).toBe(200);
		expect(stored()).toEqual(STORED);
	});

	it('saves the App URL alone, which decides nothing about the password', async () => {
		const res = await save({ appUrl: 'https://kanban.example.test' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored()).toEqual({ ...STORED, app_url: 'https://kanban.example.test' });
	});

	it('refuses nothing where no password is stored: there is none to keep', async () => {
		db.delete(settings).run();

		const res = await save({ ...PANEL, host: 'smtp.elsewhere.test' });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(stored()).toMatchObject({ smtp_host: 'smtp.elsewhere.test', smtp_pass: '' });
	});

	it('saves a new host with the password typed, and an emptied password as typed', async () => {
		expect((await save({ ...PANEL, host: 'smtp.elsewhere.test', pass: 'a-new-password' })).status).toBe(200);
		expect(stored()).toEqual({ ...STORED, smtp_host: 'smtp.elsewhere.test', smtp_pass: 'a-new-password' });

		expect((await save({ ...PANEL, host: 'relay.example.test', user: '', pass: '' })).status).toBe(200);
		expect(stored()).toEqual({ ...STORED, smtp_host: 'relay.example.test', smtp_user: '', smtp_pass: '' });
	});

	it('saves a host trimmed of ASCII spaces and tabs, and of nothing else (S1)', async () => {
		expect((await save({ ...PANEL, host: ' \tsmtp.elsewhere.test \t', pass: 'a-new-password' })).status).toBe(200);
		expect(stored()).toMatchObject({ smtp_host: 'smtp.elsewhere.test', smtp_pass: 'a-new-password' });

		// The host compared is the host connected to: one with a no-break space
		// is saved with it, and is not the host without it.
		expect((await save({ ...PANEL, host: ' smtp.elsewhere.test ', pass: 'a-new-password' })).status).toBe(200);
		expect(stored()).toMatchObject({ smtp_host: 'smtp.elsewhere.test ' });
	});
});

// ─── The connection (card 2189) ─────────────────────────────────────────────

/** Set each setting given, or remove it where it is null. */
const setMail = (values: Record<string, string | null>) => {
	for (const [key, value] of Object.entries(values)) {
		db.delete(settings).where(eq(settings.key, key)).run();
		if (value !== null) db.insert(settings).values({ key, value }).run();
	}
};

/**
 * nodemailer's `createTransport` stood in for: each transport's options are
 * kept in `handed`, and its `sendMail` sends, or throws the error `fail` gave.
 */
function standInTransport() {
	const handed: Record<string, any>[] = [];
	let failWith: Error | null = null;
	const spy = vi.spyOn(nodemailer, 'createTransport').mockImplementation(((options: Record<string, any>) => {
		handed.push(options);
		return {
			sendMail: async () => {
				if (failWith) throw failWith;
				return { messageId: '<stand-in@example.test>' };
			}
		};
	}) as unknown as typeof nodemailer.createTransport);
	return {
		handed,
		fail(error: Error | null) {
			failWith = error;
		},
		restore: () => spy.mockRestore()
	};
}

/** What decides how a transport meets the server: TLS from the first byte, STARTTLS required, the certificate checked. */
const howItConnects = (options: Record<string, any>) => ({
	secure: options.secure,
	requireTLS: options.requireTLS === true,
	rejectUnauthorized: options.tls?.rejectUnauthorized
});

const CHECKED_STARTTLS = { secure: false, requireTLS: true, rejectUnauthorized: true };
const IMPLICIT_TLS = { secure: true, requireTLS: false, rejectUnauthorized: true };
/** The options before card 2189: STARTTLS only when the server offers it, the certificate not checked. */
const AS_BEFORE = { secure: false, requireTLS: false, rejectUnauthorized: false };

/** An error as nodemailer gives one: a message and a code. */
const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

const PDF = { filename: 'report.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' };

describe('the connection every mail is sent over (test 16)', () => {
	let transport: ReturnType<typeof standInTransport>;
	beforeEach(() => {
		transport = standInTransport();
	});
	afterEach(() => transport.restore());

	// Port, the way out as stored (null: no row, as before card 2189), and what
	// every mail then meets. Each with "Use SSL/TLS" left stored ticked and
	// unticked: it changes nothing.
	const CASES: [string, string | null, typeof CHECKED_STARTTLS][] = [
		['587', null, CHECKED_STARTTLS],
		['587', 'false', CHECKED_STARTTLS],
		['25', null, CHECKED_STARTTLS],
		['465', null, IMPLICIT_TLS],
		['587', 'true', AS_BEFORE],
		['25', 'true', AS_BEFORE],
		// R9: the way out lowers nothing on 465, which checked the certificate before.
		['465', 'true', IMPLICIT_TLS]
	];
	const EACH = CASES.flatMap(([port, wayOut, expected]) => ['true', 'false'].map((secure) => [port, wayOut, secure, expected] as const));

	it.each(EACH)('on port %s with the way out %s and "Use SSL/TLS" %s, sends the test, a notification and a report alike', async (port, wayOut, secure, expected) => {
		setMail({ smtp_port: port, smtp_allow_insecure: wayOut, smtp_secure: secure });

		await sendTestEmail('someone@example.test');
		expect(await sendEmail('someone@example.test', 'A notification', '<p>Hello</p>')).toBe(true);
		expect(await sendEmailWithAttachment('someone@example.test', 'A report', '<p>Attached</p>', PDF)).toBe(true);

		expect(transport.handed).toHaveLength(3);
		for (const options of transport.handed) {
			expect(howItConnects(options)).toEqual(expected);
			expect(options).toMatchObject({ host: 'smtp.example.test', port: Number(port), auth: { user: 'mailer', pass: PASSWORD } });
		}
	});
});

describe('the way out on the SMTP route (test 17)', () => {
	it('is answered by the GET as allowInsecure, and "Use SSL/TLS" is not answered', async () => {
		const res = await api('GET', '/api/admin/smtp', { user: chief });

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			configured: true,
			host: 'smtp.example.test',
			port: 587,
			allowInsecure: false,
			user: 'mailer',
			pass: MASK,
			fromAddress: 'board@example.test',
			fromName: 'The Board',
			appUrl: '',
			// What mail has done since the server started (card 2196).
			mailStatus: { since: expect.any(String), sent: 0, failed: 0, lastSentAt: null, lastFailure: null }
		});

		setMail({ smtp_allow_insecure: 'true' });
		expect((await api('GET', '/api/admin/smtp', { user: chief })).body.allowInsecure).toBe(true);
	});

	it('is saved with the password typed, with one WARN line naming who set it each time it changes, and a "secure" sent is not saved', async () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const on = await save({ ...PANEL, allowInsecure: true, pass: PASSWORD, secure: false });
			expect(on.status, JSON.stringify(on.body)).toBe(200);
			expect(stored()).toEqual({ ...STORED, smtp_allow_insecure: 'true' });

			// Sent again as it is: no line.
			expect((await save({ ...PANEL, allowInsecure: true, pass: PASSWORD })).status).toBe(200);

			const off = await save({ ...PANEL, allowInsecure: false, pass: PASSWORD });
			expect(off.status, JSON.stringify(off.body)).toBe(200);
			expect(stored()).toEqual(STORED);
		} finally {
			quiet.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE context = 'SMTP' ORDER BY id").all()).toEqual([
			{ level: 'WARN', message: 'Mail is now sent without a checked, encrypted connection (set by chief)' },
			{ level: 'WARN', message: 'Mail is now sent with a checked, encrypted connection (set by chief)' }
		]);
	});

	it('is refused as anything but true or false', async () => {
		const res = await save({ allowInsecure: 'true' });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe('allowInsecure must be true or false');
	});
});

describe('what a failure of the certificate or STARTTLS says (test 18)', () => {
	let transport: ReturnType<typeof standInTransport>;
	beforeEach(() => {
		transport = standInTransport();
	});
	afterEach(() => transport.restore());

	it.each([
		['STARTTLS refused or not offered', fault('ETLS', 'Error upgrading connection with STARTTLS: 502 not implemented'), true],
		['a name not on the certificate', fault('ESOCKET', "Hostname/IP does not match certificate's altnames"), true],
		['a self-signed certificate', fault('ESOCKET', 'self-signed certificate'), true],
		// nodemailer 10, a server that answers neither EHLO nor STARTTLS (S6).
		['a server with no STARTTLS to HELO', fault('ECONNECTION', 'EHLO failed but HELO does not support required STARTTLS. response=502 5.5.1 Unrecognized command'), true],
		['a sign-in refused', fault('EAUTH', 'Invalid login: 535 5.7.8 Username and Password not accepted'), false],
		['a timeout', fault('ETIMEDOUT', 'Connection timeout'), false]
	])('Send Test answers %s with the error, and the ways out where it is the certificate or STARTTLS', async (_case, error, hinted) => {
		transport.fail(error);
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await api('POST', '/api/admin/smtp', { user: chief, body: {} });
		quiet.mockRestore();

		expect(res.status).toBe(500);
		expect(res.body.message).toBe(`Failed to send test email: ${error.message}${hinted ? `. ${TLS_HINT}` : ''}`);
	});

	it('writes one WARN line when mail cannot go for the certificate or STARTTLS, at most once in ten minutes, and none for a sign-in failure (R3)', async () => {
		const level = process.env.LOG_LEVEL;
		process.env.LOG_LEVEL = 'WARN';
		const quiet = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			transport.fail(fault('ETLS', 'Error upgrading connection with STARTTLS: 502 not implemented'));
			expect(await sendEmail('a@example.test', 'One', '<p>1</p>')).toBe(false);
			expect(await sendEmail('b@example.test', 'Two', '<p>2</p>')).toBe(false);
			expect(await sendEmailWithAttachment('c@example.test', 'Three', '<p>3</p>', PDF)).toBe(false);

			// Ten minutes on, it is said again.
			vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
			expect(await sendEmailWithAttachment('c@example.test', 'Four', '<p>4</p>', PDF)).toBe(false);

			// A sign-in failure is not the certificate: no such line.
			vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
			transport.fail(fault('EAUTH', 'Invalid login: 535 5.7.8 Username and Password not accepted'));
			expect(await sendEmail('d@example.test', 'Five', '<p>5</p>')).toBe(false);
		} finally {
			vi.useRealTimers();
			for (const spy of quiet) spy.mockRestore();
			if (level === undefined) delete process.env.LOG_LEVEL;
			else process.env.LOG_LEVEL = level;
		}

		const said = `Mail is not being sent: Error upgrading connection with STARTTLS: 502 not implemented. ${TLS_HINT}`;
		expect(sqlite.prepare("SELECT level, message FROM system_logs WHERE level = 'WARN' ORDER BY id").all()).toEqual([
			{ level: 'WARN', message: said },
			{ level: 'WARN', message: said }
		]);
	});
});

describe('the mail panel on the admin page (cards 2189 and 2190, slice 4)', () => {
	// Read as text: the page is CRLF in the working copy, so lines are joined with \n first.
	const page = readFileSync(join(process.cwd(), 'src/routes/admin/+page.svelte'), 'utf8').replace(/\r\n/g, '\n');
	const script = page.slice(0, page.indexOf('</script>'));
	const markup = page.slice(page.indexOf('</script>'));
	const panel = markup.slice(markup.indexOf('<h2>📧 Email / SMTP</h2>'), markup.indexOf('<!-- Danger zone -->'));
	/** The body of one of the script's functions, to the closing brace at its own indent. */
	const fn = (name: string) => {
		const at = script.indexOf(`async function ${name}(`);
		expect(at, name).toBeGreaterThan(-1);
		return script.slice(at, script.indexOf('\n\t}\n', at));
	};

	const LABEL = 'Allow mail without a checked, encrypted connection';
	const WARNING =
		'⚠️ Mail, and the mail password, can then be read and changed by anyone on the network between this server and ' +
		"the mail server. Use it only for a relay on this server's own network that cannot use TLS. For a mail server " +
		'whose certificate comes from a private authority, set NODE_EXTRA_CA_CERTS instead: see docs/deployment.md, ' +
		'Mail Server Certificates.';

	it('has no "Use SSL/TLS" box, keeps no state for it and sends no `secure` (decision 12)', () => {
		expect(page).not.toContain('Use SSL/TLS');
		expect(page).not.toContain('smtpSecure');
		expect(fn('saveSmtp')).not.toMatch(/\bsecure:/);
	});

	it('has the way out as a box labelled exactly as the server names it, read from the GET and sent to the PUT as a boolean (decision 14)', () => {
		// The refusal of decision 4 and Send Test's sentence name the box: the label is theirs, word for word.
		expect(TLS_FAULT_HINT).toContain(`"${LABEL}"`);
		expect(typeAgain('host')).toContain(`"${LABEL}"`);
		expect(panel).toMatch(new RegExp(String.raw`<input type="checkbox" bind:checked=\{smtpAllowInsecure\} /> ${LABEL}\s*</label>`));
		expect(panel.split(LABEL)).toHaveLength(2);
		expect(script).toContain('let smtpAllowInsecure = $state(false);');
		expect(fn('loadSmtpConfig')).toContain('smtpAllowInsecure = data.allowInsecure === true;');
		expect(fn('saveSmtp')).toContain('allowInsecure: smtpAllowInsecure,');
	});

	it('shows decision 14’s warning while the box is ticked, and only then', () => {
		const at = panel.indexOf('{#if smtpAllowInsecure}');
		expect(at).toBeGreaterThan(-1);
		expect(panel.slice(at, panel.indexOf('{/if}', at))).toContain(WARNING);
		expect(page.split(WARNING)).toHaveLength(2);
	});

	it('says under the host and port how mail is encrypted, and under the password when it must be typed again (decisions 4 and 11)', () => {
		const host = panel.indexOf('bind:value={smtpHost}');
		const user = panel.indexOf('bind:value={smtpUser}');
		const from = panel.indexOf('bind:value={smtpFromAddress}');
		const ports = "Port 465 is encrypted from the start; any other port must offer STARTTLS. The mail server's certificate is checked either way.";
		const password = 'The saved password is kept only while the host, port, user name and the box below stay as they are: type it again when you change them.';
		expect(panel.indexOf(ports)).toBeGreaterThan(host);
		expect(panel.indexOf(ports)).toBeLessThan(user);
		expect(panel.indexOf(password)).toBeGreaterThan(user);
		expect(panel.indexOf(password)).toBeLessThan(from);
		expect(panel.indexOf(password)).toBeLessThan(panel.indexOf(LABEL));
	});

	it('shows a refused save in the server’s own words (decision 4)', () => {
		expect(fn('saveSmtp')).toContain("smtpMessage = await failureMessage(res, 'Failed to save SMTP settings');");
	});
});
