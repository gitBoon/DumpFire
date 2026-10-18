/**
 * Mail that says whether it went (card 2196).
 *
 * An invite whose mail failed was answered "Invite sent", and a user made with
 * no password while mail failed was answered `invited: true`, which the admin
 * page read as "invite email sent!". `sendEmail` caught every failure, logged
 * one `ERROR` and resolved `false`, and the invite routes queued the mail and
 * answered without waiting for it. Every other mail that failed was that one
 * line and nothing else. And the line was the error itself: a mail server's
 * refusal that quoted the mail's link put a live invite token in front of
 * every administrator in the live console.
 *
 * Now every mail goes through `deliverMail` in `src/lib/server/email.ts`, which
 * says whether it went and why not (`mailProblem`, seven problems in words),
 * keeps a record in memory for the mail panel (`mailStatus`, answered by
 * `GET /api/admin/smtp`), and logs a failure once, holding only its code and
 * its message masked (`maskMailText`). Both invite routes wait for the mail
 * after their commit; when it did not go they say so, and give the link to
 * the administrator whose request issued it, after reading again that their
 * session is open, that they may still manage the account and that the
 * invite still works (`src/lib/server/invite-link.ts`).
 *
 * The mail server is `effects()`'s recorded transport, refusing with
 * `mailRefusal`: called inside the send, after the commit, so a refusal can
 * quote the mail's own link and change the database while the mail is out.
 * The tests are the plan's M1 to M14 (`docs/planning/cards-2178-2196-delivery-failures.md`,
 * sections 6 and 8.6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { inviteTokens, sessions, settings, users } from '$lib/server/db/schema';
import { SESSION_COOKIE_NAME, type SessionUser } from '$lib/server/auth';
import { issueInvite } from '$lib/server/invites';
import { getRecentLogs } from '$lib/server/logger';
import { mailProblem, mailStatus, sendEmailWithAttachment } from '$lib/server/email';
import { notifyRequesterConfirm, notifyUserAssigned } from '$lib/server/notifications';
import { load as loadInvitePage } from '../src/routes/invite/[token]/+page.server';
import { api, type ApiResult } from './helpers/api';
import { effects, type Effects, type OfferedMail } from './helpers/effects';
import { makeBoard, makeCard, makeSession, makeSmtp, makeUser, resetDb } from './helpers/fixtures';
import { watchReads } from './helpers/reads';

const APP = 'https://kanban.example.test';
const INVITE_SUBJECT = "You're invited to DumpFire!";

/** An error as nodemailer throws one: a message, a code, and what else is given. */
const refused = (code: string | undefined, message: string, more: Record<string, unknown> = {}) =>
	Object.assign(new Error(message), code === undefined ? {} : { code }, more);

/** The invite link in a mail. */
const linkIn = (html: string) => html.match(/https:\/\/kanban\.example\.test\/invite\/[0-9a-f-]+/)![0];
const tokenOf = (link: string) => link.slice(link.lastIndexOf('/') + 1);

/** The cookie of a session of `user`'s, as the gate would have let the request in with. */
const signedIn = (user: SessionUser) => ({ cookie: `${SESSION_COOKIE_NAME}=${makeSession(user)}` });

const unusedInvites = (userId: number) =>
	db
		.select({ token: inviteTokens.token })
		.from(inviteTokens)
		.where(and(eq(inviteTokens.userId, userId), eq(inviteTokens.used, false)))
		.all()
		.map((row) => row.token);

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

type Spoken = { console: string; rows: { level: string; context: string; message: string; meta: string | null; userId: number | null }[] };

/**
 * Run `act` with every line logged, INFO and up, and each console method
 * spied on; return what it printed and the rows of `system_logs` it wrote.
 */
async function logging<T>(act: () => Promise<T>): Promise<{ result: T } & Spoken> {
	const level = process.env.LOG_LEVEL;
	process.env.LOG_LEVEL = 'INFO';
	const spies = (['log', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
	const before = (sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM system_logs').get() as { id: number }).id;
	let result: T;
	try {
		result = await act();
	} finally {
		if (level === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = level;
	}
	const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
	for (const spy of spies) spy.mockRestore();
	const rows = sqlite
		.prepare('SELECT level, context, message, meta, user_id AS userId FROM system_logs WHERE id > ? ORDER BY id')
		.all(before) as Spoken['rows'];
	return { result, console: printed, rows };
}

let sent: Effects | null = null;
/** What the recorded mail server answers each mail with: an error to refuse it, undefined to take it. */
let refusal: (mail: OfferedMail) => Error | undefined = () => undefined;

let chief: SessionUser;
let admin: SessionUser;
let invitee: SessionUser;

beforeEach(() => {
	resetDb();
	makeSmtp();
	db.insert(settings).values({ key: 'app_url', value: APP }).run();
	chief = makeUser({ username: 'chief', role: 'superadmin' });
	admin = makeUser({ username: 'admin', role: 'admin' });
	invitee = makeUser({ username: 'ana' });
	refusal = () => undefined;
	sent = effects({ mailRefusal: (mail) => refusal(mail) });
});

afterEach(() => {
	sent?.restore();
	sent = null;
});

const resend = (by: SessionUser, id: number, headers: Record<string, string> = signedIn(by)) =>
	api('POST', `/api/users/${id}/invite`, { user: by, headers });

const create = (by: SessionUser, body: Record<string, unknown>) =>
	api('POST', '/api/users', { user: by, body, headers: signedIn(by) });

/** A mail server that refuses the sign-in, with what Gmail says. */
const signInRefused = () =>
	refused('EAUTH', 'Invalid login: 535-5.7.8 Username and Password not accepted', { responseCode: 535, command: 'AUTH PLAIN' });

describe('an invite whose mail is refused (M1 to M4)', () => {
	it('says the mail was not sent and why, and gives the issuer the link of the one invite that works (M1)', async () => {
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await resend(admin, invitee.id);
		quiet.mockRestore();

		const [token] = unusedInvites(invitee.id);
		expect(unusedInvites(invitee.id)).toHaveLength(1);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			success: true,
			mailSent: false,
			mailProblem: 'the mail server refused the sign-in',
			inviteUrl: `${APP}/invite/${token}`,
			message:
				'The invite was made, but its mail to ana@example.test could not be sent: the mail server refused the sign-in. ' +
				'Give ana the link yourself. Any earlier invite to this account no longer works.'
		});
		expect(res.body.message).not.toContain('Invite sent');
		// A credential: kept by nothing on the way (N5).
		expect(res.headers.get('cache-control')).toBe('no-store');
		// The mail was tried once, with that link, after the commit.
		expect(sent!.refusedMail).toHaveLength(1);
		expect(linkIn(sent!.refusedMail[0].html)).toBe(res.body.inviteUrl);
		expect(sent!.duringTransaction).toEqual([]);
	});

	it('gives a link that works: the invite page takes it (M2)', async () => {
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const res = await resend(admin, invitee.id);
		quiet.mockRestore();

		const page = await loadInvitePage({ params: { token: tokenOf(res.body.inviteUrl) } } as never);

		expect(page).toMatchObject({ valid: true, username: 'ana' });
	});

	it('says "Invite sent" when the mail went, with no link, the mail sent once and after the commit (M3)', async () => {
		const res = await resend(admin, invitee.id);

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			success: true,
			mailSent: true,
			message: 'Invite sent to ana@example.test. Any earlier invite to this account no longer works.'
		});
		expect(res.headers.get('cache-control')).toBeNull();
		expect(sent!.emails).toHaveLength(1);
		expect(sent!.emails[0]).toMatchObject({ to: 'ana@example.test', subject: INVITE_SUBJECT, inTransaction: false });
		expect(tokenOf(linkIn(sent!.emails[0].html))).toBe(unusedInvites(invitee.id)[0]);
	});

	it('makes a user with no password, says their mail was not sent and gives the link; and with mail working, says it went (M4)', async () => {
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const made = await create(admin, { username: 'newbie', email: 'newbie@example.test' });
		quiet.mockRestore();

		expect(made.status).toBe(201);
		const [token] = unusedInvites(made.body.id);
		expect(made.body).toMatchObject({
			username: 'newbie',
			invited: true,
			mailSent: false,
			mailProblem: 'the mail server refused the sign-in',
			inviteUrl: `${APP}/invite/${token}`
		});
		expect(made.headers.get('cache-control')).toBe('no-store');

		refusal = () => undefined;
		const working = await create(admin, { username: 'second', email: 'second@example.test' });

		expect(working.status).toBe(201);
		expect(working.body).toMatchObject({ username: 'second', invited: true, mailSent: true });
		expect(working.body).not.toHaveProperty('inviteUrl');
		expect(working.body).not.toHaveProperty('mailProblem');

		// With a password there is no invite, and nothing is said of mail.
		const typed = await create(admin, { username: 'third', email: 'third@example.test', password: 'a long password' });
		expect(typed.status).toBe(201);
		expect(typed.body).toMatchObject({ invited: false });
		expect(typed.body).not.toHaveProperty('mailSent');
	});
});

describe('nothing secret is logged when a refusal quotes the link (M5a to M5h)', () => {
	/** What a refusal quoting `link` writes nowhere: no row, no console line, no record, no stack. */
	const expectNowhere = (spoken: Spoken, token: string) => {
		for (const row of spoken.rows) {
			expect(holdsPieceOf(row.message, token), row.message).toBe(false);
			expect(holdsPieceOf(row.meta ?? '', token), row.meta ?? '').toBe(false);
			expect(row.meta ?? '').not.toContain('"stack"');
		}
		expect(holdsPieceOf(spoken.console, token)).toBe(false);
		expect(holdsPieceOf(JSON.stringify(getRecentLogs()), token)).toBe(false);
		expect(holdsPieceOf(mailStatus().lastFailure!.detail, token)).toBe(false);
	};

	/** An invite resent with the mail refused as `say` words it, given the mail's link. */
	const resendRefused = async (say: (link: string, token: string) => string) => {
		refusal = (mail) => {
			const link = linkIn(mail.html);
			return refused('EMESSAGE', `Message failed: ${say(link, tokenOf(link))}`, { responseCode: 554, command: 'DATA' });
		};
		const spoken = await logging(() => resend(admin, invitee.id));
		return { ...spoken, token: tokenOf(spoken.result.body.inviteUrl as string) };
	};

	it('as written: the ERROR row holds the link masked, and the WARN row names the issuer and the account (M5a)', async () => {
		const { token, ...spoken } = await resendRefused((link) => `554 5.7.1 rejected, listed URL ${link}`);

		expectNowhere(spoken, token);
		const failed = spoken.rows.filter((row) => row.level === 'ERROR');
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ context: 'EMAIL', message: `Failed to send email to ana@example.test: ${INVITE_SUBJECT}` });
		expect(JSON.parse(failed[0].meta!)).toEqual({
			code: 'EMESSAGE',
			command: 'DATA',
			responseCode: 554,
			problem: 'refused',
			detail: `Message failed: 554 5.7.1 rejected, listed URL ${APP}/invite/[token]`
		});
		const warned = spoken.rows.filter((row) => row.level === 'WARN');
		expect(warned).toEqual([
			{
				level: 'WARN',
				context: 'AUTH',
				message:
					`Invite for user ${invitee.id} was issued by user ${admin.id}; its mail was not sent ` +
					'(the mail server did not accept the message), and its link was given in the answer to their request',
				meta: JSON.stringify({ accountId: invitee.id, problem: 'refused' }),
				userId: admin.id
			}
		]);
		expect(mailStatus().lastFailure!.detail).toBe(`Message failed: 554 5.7.1 rejected, listed URL ${APP}/invite/[token]`);
	});

	it.each([
		['URL-encoded (M5b)', (link: string) => `554 5.7.1 rejected, listed URL ${encodeURIComponent(link)}`],
		['in capitals (M5c)', (link: string) => `554 5.7.1 REJECTED, LISTED URL ${link.toUpperCase()}`],
		['split after /invite/ across two reply lines (M5d)', (_link: string, token: string) => `554-5.7.1 rejected, listed URL ${APP}/invite/\n554 5.7.1 ${token}`],
		['split inside the token (M5e)', (_link: string, token: string) => `554-5.7.1 rejected, listed URL ${APP}/invite/${token.slice(0, 18)}\n554 5.7.1 ${token.slice(18)}`],
		['the token alone (M5f)', (_link: string, token: string) => `554 5.7.1 message ${token} blocked`],
		// Review fixes, item 6: a hyphen encoded breaks a UUID into runs shorter than 16.
		[
			'URL-encoded, its hyphens too, in lower case',
			(_link: string, token: string) => `554 5.7.1 rejected, listed URL ${encodeURIComponent(`${APP}/invite/`)}${token.replace(/-/g, '%2d')}`
		],
		['the token alone, its hyphens as decimal HTML entities', (_link: string, token: string) => `554 5.7.1 message ${token.replace(/-/g, '&#45;')} blocked`],
		['the token alone, its hyphens as hex HTML entities in capitals', (_link: string, token: string) => `554 5.7.1 message ${token.replace(/-/g, '&#X2D;')} blocked`]
	])('%s', async (_case, say) => {
		const { token, ...spoken } = await resendRefused(say);

		expect(spoken.rows.filter((row) => row.level === 'ERROR')).toHaveLength(1);
		expectNowhere(spoken, token);
	});

	it("a public request's confirmation mail, its link URL-encoded (M5g)", async () => {
		const requestToken = 'a3'.repeat(32);
		refusal = (mail) => {
			const link = mail.html.match(/https:\/\/kanban\.example\.test\/request\/\d+\/confirm\?token=[0-9a-f]+/)![0];
			return refused('EENVELOPE', `Message failed: 550 5.7.1 URL ${encodeURIComponent(link)} is listed`);
		};

		const spoken = await logging(async () => {
			notifyRequesterConfirm('someone@example.test', 'A new laptop', `${APP}/request/7/confirm?token=${requestToken}`);
			await vi.waitFor(() => expect(mailStatus().failed).toBe(1));
		});

		expect(spoken.rows.filter((row) => row.level === 'ERROR')).toHaveLength(1);
		expectNowhere(spoken, requestToken);
	});

	it('Send Test refused with a token in its words, and its answer (M5h)', async () => {
		const token = (() => {
			let issued = '';
			inTransaction(() => (issued = issueInvite(invitee.id)));
			return issued;
		})();
		refusal = () => refused('EENVELOPE', `Mail command failed: 550 5.1.1 ${token.toUpperCase()} rejected`, { responseCode: 550 });

		const spoken = await logging(() => api('POST', '/api/admin/smtp', { user: chief, body: {} }));

		expect(spoken.result.status).toBe(500);
		expect(holdsPieceOf(JSON.stringify(spoken.result.body), token)).toBe(false);
		expect(spoken.result.body.message).toBe('Failed to send test email: Mail command failed: 550 5.1.1 [token] rejected');
		expectNowhere(spoken, token);
	});
});

describe('what an invite answer says of why (M6, M7)', () => {
	it("never gives an administrator the mail server's own words, which can name the mail host (M6)", async () => {
		refusal = () => refused('ECONNECTION', 'connect ECONNREFUSED smtp.example.test:587 (mailer@smtp.example.test)');
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await resend(admin, invitee.id);
		quiet.mockRestore();

		expect(res.body.mailProblem).toBe('the mail server could not be reached');
		expect(JSON.stringify(res.body)).not.toContain('smtp.example.test');
		expect(JSON.stringify(res.body)).not.toContain('mailer');
	});

	it.each([
		['EAUTH', refused('EAUTH', 'Invalid login: 535 5.7.8 Username and Password not accepted'), 'sign-in'],
		// nodemailer's own, before anything is asked of the server: a mail user with no password (review fixes, item 2).
		['EAUTH from the API, no password', refused('EAUTH', 'Missing credentials for "PLAIN"', { command: 'API' }), 'no-password'],
		['ETLS', refused('ETLS', 'Error upgrading connection with STARTTLS: 502 not implemented'), 'secure-connection'],
		['EREQUIRETLS', refused('EREQUIRETLS', 'Server does not support REQUIRETLS extension (RFC 8689)'), 'secure-connection'],
		['ESOCKET, a name not on the certificate', refused('ESOCKET', "Hostname/IP does not match certificate's altnames: IP: 127.0.0.1 is not in the cert's list: "), 'secure-connection'],
		['ESOCKET, a self-signed certificate', refused('ESOCKET', 'self-signed certificate'), 'secure-connection'],
		[
			'ECONNECTION, no STARTTLS to HELO (nodemailer 10)',
			refused('ECONNECTION', 'EHLO failed but HELO does not support required STARTTLS. response=502 5.5.1 Unrecognized command: 502 5.5.1 Unrecognized command', {
				response: '502 5.5.1 Unrecognized command',
				responseCode: 502
			}),
			'secure-connection'
		],
		['ESOCKET, a connection reset', refused('ESOCKET', 'read ECONNRESET'), 'unreachable'],
		['ECONNECTION', refused('ECONNECTION', 'connect ECONNREFUSED 127.0.0.1:1'), 'unreachable'],
		['ETIMEDOUT', refused('ETIMEDOUT', 'Connection timeout'), 'unreachable'],
		['EDNS', refused('EDNS', 'getaddrinfo ENOTFOUND smtp.invalid'), 'unreachable'],
		['EENVELOPE', refused('EENVELOPE', 'Mail command failed: 550 5.1.1 No such user'), 'refused'],
		['EMESSAGE', refused('EMESSAGE', 'Message failed: 554 5.7.1 rejected'), 'refused'],
		// The server's own reply saying "certificate" is its answer to the message, not a connection that failed (N3).
		[
			'EMESSAGE, the reply naming a certificate',
			refused('EMESSAGE', 'Message failed: 554 5.7.1 certificate policy violation', {
				response: '554 5.7.1 certificate policy violation',
				responseCode: 554
			}),
			'refused'
		],
		['EPROTOCOL', refused('EPROTOCOL', 'Invalid greeting'), 'failed'],
		['an Error with no code', refused(undefined, 'Something else'), 'failed'],
		['not an Error', 'a string', 'failed']
	])('reads %s as its problem (M7)', (_case, err, problem) => {
		expect(mailProblem(err)).toBe(problem);
	});
});

describe('the mail panel’s record (M8 to M12)', () => {
	const panel = (by: SessionUser = chief) => api('GET', '/api/admin/smtp', { user: by });

	it('starts empty, configured or not (M8)', async () => {
		const configured = await panel();
		expect(configured.status).toBe(200);
		expect(configured.body.mailStatus).toEqual({ since: expect.any(String), sent: 0, failed: 0, lastSentAt: null, lastFailure: null });
		expect(new Date(configured.body.mailStatus.since).toISOString()).toBe(configured.body.mailStatus.since);

		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		const not = await panel();
		expect(not.body).toEqual({ configured: false, mailStatus: { since: expect.any(String), sent: 0, failed: 0, lastSentAt: null, lastFailure: null } });
	});

	it('counts a notification refused and keeps it as the last failure, then counts one sent beside it (M9)', async () => {
		const owner = makeUser({ username: 'owner' });
		const assignee = makeUser({ username: 'assignee' });
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do'], { title: 'Deploy v2.1' });
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		notifyUserAssigned(board.id, card.id, card.title, assignee.email, assignee.username, owner.username, APP);
		await vi.waitFor(() => expect(mailStatus().failed).toBe(1));
		quiet.mockRestore();

		const failure = mailStatus().lastFailure!;
		expect(mailStatus()).toMatchObject({ sent: 0, failed: 1, lastSentAt: null });
		expect(failure).toEqual({
			at: expect.any(String),
			subject: 'Assigned: Deploy v2.1',
			problem: 'the mail server refused the sign-in',
			detail: 'Invalid login: 535-5.7.8 Username and Password not accepted'
		});
		expect((await panel()).body.mailStatus.lastFailure).toEqual(failure);

		refusal = () => undefined;
		notifyUserAssigned(board.id, card.id, card.title, assignee.email, assignee.username, owner.username, APP);
		await vi.waitFor(() => expect(mailStatus().sent).toBe(1));

		const after = mailStatus();
		expect(after).toMatchObject({ sent: 1, failed: 1, lastFailure: failure });
		expect(after.lastSentAt! >= failure.at).toBe(true);
	});

	it('counts Send Test, refused and then sent, and logs its failure once (M10)', async () => {
		refusal = signInRefused;
		const refusedTest = await logging(() => api('POST', '/api/admin/smtp', { user: chief, body: {} }));

		expect(refusedTest.result.status).toBe(500);
		expect(mailStatus()).toMatchObject({ sent: 0, failed: 1, lastFailure: { subject: 'DumpFire — SMTP Test', problem: 'the mail server refused the sign-in' } });
		// One line, the mail's own: the route used to write a second, unmasked (N2).
		expect(refusedTest.rows.map((row) => [row.level, row.context, row.message])).toEqual([
			['ERROR', 'EMAIL', 'Failed to send email to chief@example.test: DumpFire — SMTP Test']
		]);

		refusal = () => undefined;
		const sentTest = await api('POST', '/api/admin/smtp', { user: chief, body: {} });

		expect(sentTest.status).toBe(200);
		expect(mailStatus()).toMatchObject({ sent: 1, failed: 1, lastSentAt: expect.any(String) });
	});

	it("gives Send Test refused for STARTTLS its one ERROR and not R3's WARN, which the next mail refused so is given once", async () => {
		refusal = () => refused('ETLS', 'Error upgrading connection with STARTTLS: 502 not implemented', { responseCode: 502 });

		const spoken = await logging(async () => {
			const res = await api('POST', '/api/admin/smtp', { user: chief, body: {} });
			expect(res.status).toBe(500);
			// The superadmin who pressed it is told the ways out in its answer (card 2189).
			expect(res.body.message).toContain('Allow mail without a checked, encrypted connection');
			await sendEmailWithAttachment('reader@example.test', 'Weekly report', '<p>Attached</p>', {
				filename: 'report.pdf',
				content: Buffer.from('%PDF-1.4'),
				contentType: 'application/pdf'
			});
		});

		expect(spoken.rows.map((row) => [row.level, row.context, row.message])).toEqual([
			['ERROR', 'EMAIL', 'Failed to send email to chief@example.test: DumpFire — SMTP Test'],
			['ERROR', 'EMAIL', 'Failed to send email to reader@example.test: Weekly report'],
			['WARN', 'EMAIL', expect.stringMatching(/^Mail is not being sent: Error upgrading connection with STARTTLS: 502 not implemented\. The mail server's certificate/)]
		]);
	});

	it('counts a mail with an attachment refused, which still answers false (M11)', async () => {
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		const went = await sendEmailWithAttachment('reader@example.test', 'Weekly report', '<p>Attached</p>', {
			filename: 'report.pdf',
			content: Buffer.from('%PDF-1.4'),
			contentType: 'application/pdf'
		});
		quiet.mockRestore();

		expect(went).toBe(false);
		expect(mailStatus()).toMatchObject({ failed: 1, lastFailure: { subject: 'Weekly report' } });
	});

	it('is kept by nothing on the way: both answers that carry it are no-store (review fixes, item 7)', async () => {
		expect((await panel()).headers.get('cache-control')).toBe('no-store');

		db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		const not = await panel();
		expect(not.body).toMatchObject({ configured: false });
		expect(not.headers.get('cache-control')).toBe('no-store');
	});

	it("is the superadmin's alone (M12)", async () => {
		expect((await panel(admin)).status).toBe(403);
		expect((await panel(invitee)).status).toBe(403);
	});
});

describe('a mail user with no password, as a restore leaves the settings (review fixes, item 2)', () => {
	const NO_PASSWORD = 'the mail password has not been entered on this server; the superadmin enters it under 📧 Email / SMTP';

	beforeEach(() => {
		db.insert(settings).values({ key: 'smtp_user', value: 'mailer' }).run();
	});

	it("is its own problem on the mail panel, not a sign-in the mail server refused", async () => {
		const owner = makeUser({ username: 'owner' });
		const { board, cols } = makeBoard({ owner });
		const card = makeCard(cols['To Do'], { title: 'Deploy v2.1' });
		refusal = () => refused('EAUTH', 'Missing credentials for "PLAIN"', { command: 'API' });
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		notifyUserAssigned(board.id, card.id, card.title, invitee.email, invitee.username, owner.username, APP);
		await vi.waitFor(() => expect(mailStatus().failed).toBe(1));
		quiet.mockRestore();

		expect(mailStatus().lastFailure).toMatchObject({ subject: 'Assigned: Deploy v2.1', problem: NO_PASSWORD });
	});

	it('refuses a resent invite before it is made, as with no mail host, so the earlier invite still works', async () => {
		const earlier = inTransaction(() => issueInvite(invitee.id));

		const res = await resend(admin, invitee.id);

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(
			`The invite was not made: ${NO_PASSWORD}. Any earlier invite to this account still works.`
		);
		expect(unusedInvites(invitee.id)).toEqual([earlier]);
		expect(sent!.all.filter((effect) => effect.kind === 'email')).toEqual([]);
		expect(sent!.refusedMail).toEqual([]);
	});

	it('refuses a user with no password before they are made, and makes one with a password', async () => {
		const res = await create(admin, { username: 'newbie', email: 'newbie@example.test' });

		expect(res.status).toBe(400);
		expect(res.body.message).toBe(`Password must be at least 8 characters (${NO_PASSWORD})`);
		expect(db.select().from(users).where(eq(users.username, 'newbie')).get()).toBeUndefined();
		expect(sent!.all.filter((effect) => effect.kind === 'email')).toEqual([]);

		const typed = await create(admin, { username: 'third', email: 'third@example.test', password: 'a long password' });
		expect(typed.status).toBe(201);
		expect(typed.body).toMatchObject({ invited: false });
	});
});

describe('the link of a mail that failed, asked about again before it is given (M13, M14)', () => {
	it.each([
		[
			'the caller made an ordinary user (a)',
			() => db.update(users).set({ role: 'user' }).where(eq(users.id, admin.id)).run(),
			"the caller's session has ended, or is no longer an administrator's",
			'session'
		],
		['the caller\'s session deleted (b)', () => db.delete(sessions).where(eq(sessions.userId, admin.id)).run(), "the caller's session has ended, or is no longer an administrator's", 'session'],
		['a newer invite sent for the account (c)', () => inTransaction(() => issueInvite(invitee.id)), 'the invite no longer works', 'invite'],
		[
			'the account made an administrator, without ending its invites (d)',
			() => db.update(users).set({ role: 'admin' }).where(eq(users.id, invitee.id)).run(),
			'the caller may no longer manage the account',
			'rule'
		]
	])('gives no link when, while the mail is out, %s (M13)', async (_case, meanwhile, why, check) => {
		refusal = () => {
			meanwhile();
			return signInRefused();
		};

		const spoken = await logging(() => resend(admin, invitee.id));
		const res = spoken.result as ApiResult;

		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			success: true,
			mailSent: false,
			mailProblem: 'the mail server refused the sign-in',
			message:
				'The invite was made, but its mail could not be sent, and its link cannot be shown to you now. ' +
				'Send a new invite with 📧 once mail works.'
		});
		expect(spoken.rows.filter((row) => row.level === 'WARN')).toEqual([
			{
				level: 'WARN',
				context: 'AUTH',
				message:
					`Invite for user ${invitee.id} was issued by user ${admin.id}; its mail was not sent ` +
					`(the mail server refused the sign-in), and its link was not given to them: ${why}`,
				meta: JSON.stringify({ accountId: invitee.id, problem: 'sign-in', check }),
				userId: admin.id
			}
		]);
	});

	it('gives no link to a request that came with no session', async () => {
		refusal = signInRefused;
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

		const res = await resend(admin, invitee.id, {});
		quiet.mockRestore();

		expect(res.body).toMatchObject({ success: true, mailSent: false });
		expect(res.body).not.toHaveProperty('inviteUrl');
	});

	it('gives the link when the mail host is cleared between the commit and the send, and counts nothing (M14)', async () => {
		// The first read of the settings outside the transaction is the invite
		// mail's own look for a host: it finds one, which is then cleared, as
		// the superadmin saving the panel meanwhile would.
		const headers = signedIn(admin);
		let cleared = false;
		const reads = watchReads('settings', () => {
			if (cleared) return;
			cleared = true;
			db.delete(settings).where(eq(settings.key, 'smtp_host')).run();
		});
		let res: ApiResult;
		try {
			res = await resend(admin, invitee.id, headers);
		} finally {
			reads.restore();
		}

		const [token] = unusedInvites(invitee.id);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({
			success: true,
			mailSent: false,
			mailProblem: 'mail is not set up on this server',
			inviteUrl: `${APP}/invite/${token}`
		});
		expect(sent!.all.filter((effect) => effect.kind === 'email')).toEqual([]);
		expect(sent!.refusedMail).toEqual([]);
		expect(mailStatus()).toMatchObject({ sent: 0, failed: 0, lastFailure: null });
	});
});
