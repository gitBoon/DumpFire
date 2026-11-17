/**
 * POST /api/reports/email — Generate a report PDF and email it to recipients.
 *
 * The answer says what was sent (card 2113). It used to be 200, "Report sent
 * to N recipient(s)", whatever the mail server answered, and with no mail set
 * up at all. Now:
 *   - no mail set up: 503, before the PDF is built, and nothing is sent;
 *   - sent to every recipient: 200;
 *   - sent to some: 200, with a message naming the others. Not a failure
 *     status: the page would offer a resend, and the rest would get it twice;
 *   - sent to none: 502.
 * The last two carry `results`, each recipient's `success` being what the
 * send returned. `email.ts` logs the mail server's reason.
 *
 * Who it may reach (card 2182): any address, at most 10 distinct addresses a
 * call (400, before anything else is looked at), and at most 100 a day from
 * one account (429, `takeReportMail`, taken once access is checked and mail
 * is known to be set up, before the PDF is built). The list is read by
 * `reportRecipients`, as the schedules and the page read one, and each
 * address is sent one mail, once.
 *
 * An optional `timeZone` is the zone whose day the Overdue figure counts from
 * (card 2258), as POST /api/reports reads it; without one it is UTC.
 *
 * Asks for the current password and a code (card 2751, D1, D4), for every
 * address, the caller's own and the company's among them, through the
 * step-up every listed action asks with (step-up.ts). Every refusal above is
 * made first, read only, in its guard (`readReportMail`), the day's
 * allowance read with nothing taken; the allowance is taken once the report
 * is built. Before every send the session, the caller's access and the
 * password are asked again (S5): refused before any mail has gone, the first
 * refused by the mail server included, the answer is that refusal (CR3);
 * once one has gone the sending stops, each address left is answered
 * `STOPPED`, and the answer is the partial 200, naming each reason by its
 * addresses when some were refused and some stopped. Once the sending is
 * done, an INFO line names the addresses reached (D13).
 */

import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '$lib/server/auth';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf, readReportAssignee, readReportWindow, takeReportMail,
	checkReportMail, reportScopeOpen,
	REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS
} from '$lib/server/reports';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { readBody, readChoice, readEmailList, readId, readTimeZone, type RequestBody } from '$lib/server/request-body';
import { isSmtpConfigured, sendEmailWithAttachment } from '$lib/server/email';
import { canViewBoard, isAdmin } from '$lib/server/board-access';
import { createLogger } from '$lib/server/logger';
import { requireUser } from '$lib/server/route-guards';
import { confirmStepUp, requirePasswordUnchanged } from '$lib/server/step-up';
import { stillCallerNow } from '$lib/server/write-as';
import { escapeHtml } from '$lib/escape-html';
import { parseStamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const log = createLogger('REPORTS');

/** What a report that cannot be had is answered: the scope is not there, or not the caller's to read. */
const NO_ACCESS = 'Failed to generate report or no access';

/**
 * What each address left is answered when the sending stops before it (card
 * 2751, S5): the session ended, the caller's access changed, or the password
 * changed, after the first mail had gone.
 */
const STOPPED =
	'Not sent: sending stopped because the session ended, access changed or the password changed while the report was being sent';

export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	requireUser(locals.user);

	const body = await readBody(request);
	// Every refusal that needs no password, in today's order, read only in the
	// step-up's guard (card 2751, D5): the fields, the addresses and their cap,
	// what the report covers (`reportScopeOpen`), the mail being set up, and
	// the day's report mail, read with nothing taken (S4). Then the password
	// and a code, for every send, whatever the addresses (D4).
	const {
		actor: mail,
		userId,
		hash
	} = await confirmStepUp(locals, cookies, body, 'POST /api/reports/email', (caller) => readReportMail(requireUser(caller), body));
	// Who is asking, as their account is now, once the password is checked: a
	// session that ended while it was checked is refused, and a role lowered
	// meanwhile is met below (card 2253). Mail leaves the process, after a PDF
	// built with an await, which no transaction can hold: asked here, and again
	// before each mail is sent.
	const caller = stillCallerNow(locals);
	const user = requireUser(caller);
	const { scope, scopeId, periodStart, periodEnd, detailLevel, statusFilter, assigneeUserId, timeZone, recipients } = mail;

	if (scope === 'all' && !isAdmin(user)) {
		throw error(403, 'Only admins can generate all-boards reports');
	}

	let reportData;
	let scopeName = 'Report';
	// For a grouping's report, the boards in it the caller can open: what the
	// PDF holds, asked again of the caller before each send.
	let reported: number[] = [];

	if (scope === 'board' && scopeId !== null) {
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		scopeName = board?.name || 'Board';
	} else if (scope === 'category' && scopeId !== null) {
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		scopeName = cat?.name || 'Category';
		reported = db.select({ id: boards.id }).from(boards).where(eq(boards.categoryId, scopeId)).all()
			.map((b) => b.id)
			.filter((id) => canViewBoard(user, id));
	} else if (scope === 'all') {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		scopeName = 'All Boards';
	}

	if (!reportData) {
		throw error(403, NO_ACCESS);
	}

	// The day's allowance: a call refused above spent nothing, and nothing is
	// built or sent when this refuses. What it takes is not given back when the
	// mail server refuses a send, or the sending stops: the attempt was made.
	takeReportMail(user, recipients.length, 'email');

	const pdfBuffer = await generateReportPdf(reportData, detailLevel);
	const dateStr = new Date().toISOString().split('T')[0];
	const filename = `dumpfire-report-${scopeName.toLowerCase().replace(/\s+/g, '-')}-${dateStr}.pdf`;
	// Each bound is in the stored form, which is UTC (card 2095), so it is read
	// with parseStamp and written out in UTC: `new Date()` reads the stored form
	// in the server's own zone, and west of UTC that is the day before.
	const day = (value: string) => (parseStamp(value) ?? new Date(NaN)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

	// Why a send failed, for the page. The mail server's own answer is in the
	// system log, which `email.ts` writes, and not in an answer to the browser.
	const REFUSED = 'The mail server did not accept it. An administrator can see the reason in the system log.';
	const results: { email: string; success: boolean; message?: string }[] = [];

	for (const email of recipients) {
		// The sending stopped at an earlier address: none of the rest is sent.
		if (results.some((r) => r.message === STOPPED)) {
			results.push({ email, success: false, message: STOPPED });
			continue;
		}
		// Asked again before every send, with nothing awaited between this and
		// the send (the plan's R1; card 2751, S5): the session still open, and
		// everything the mail relies on decided again on the account as it is
		// now, in the same words: the PDF was built for the caller as they were
		// before its await, and a role lowered or a board taken away meanwhile
		// sends nothing more. An all-boards report by an administrator; a
		// board's by someone who can open it; a grouping's by someone who can
		// still open every board in it that the PDF holds. The sub-boards a PDF
		// takes in are not asked again (N4). And the password unchanged since it
		// was checked. Refused before any mail has gone, the answer is the
		// refusal (the review's CR3: a first address the mail server refused is
		// no reason to hide it); once one has gone, the sending stops and each
		// address left is said not to have been sent.
		let sender: SessionUser;
		try {
			sender = requireUser(stillCallerNow(locals));
			if (scope === 'all' && !isAdmin(sender)) {
				throw error(403, 'Only admins can generate all-boards reports');
			}
			if (scope === 'board' && scopeId !== null && !canViewBoard(sender, scopeId)) throw error(403, NO_ACCESS);
			if (scope === 'category' && !reported.every((id) => canViewBoard(sender, id))) throw error(403, NO_ACCESS);
			requirePasswordUnchanged(userId, hash, 'changed');
		} catch (refusal) {
			if (!results.some((r) => r.success)) throw refusal;
			results.push({ email, success: false, message: STOPPED });
			continue;
		}
		let sent = false;
		try {
			// The board or grouping's name and the sender's username are what
			// somebody typed, and this mail goes to any address the caller
			// gives: each is escaped where it is put (card 2149). The subject
			// is plain text and keeps the name as it was typed.
			sent = await sendEmailWithAttachment(
				email,
				`DumpFire Report: ${scopeName}`,
				`<div style="font-family: sans-serif; max-width: 600px;">
					<h2 style="color: #1e293b;">DumpFire Report</h2>
					<p><strong>${escapeHtml(scopeName)}</strong></p>
					<p style="color: #64748b;">Period: ${escapeHtml(day(periodStart))} — ${escapeHtml(day(periodEnd))}</p>
					<p>Please find the attached PDF report.</p>
					<p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">Sent by ${escapeHtml(sender.username)} via DumpFire</p>
				</div>`,
				{ filename, content: pdfBuffer, contentType: 'application/pdf' }
			);
		} catch {
			// It catches and logs a failure itself, and returns false; a throw
			// would be something else again, and is not a send either.
			sent = false;
		}
		results.push(sent ? { email, success: true } : { email, success: false, message: REFUSED });
	}

	const notSent = results.filter((r) => !r.success).map((r) => r.email);
	const sentTo = results.length - notSent.length;

	// Who it reached, by name, the sender as the line's user (card 2751, D13).
	const reached = results.filter((r) => r.success).map((r) => r.email);
	log.info(
		`Report "${scopeName}" was mailed by ${user.username} (ID: ${user.id}) to: ${reached.length === 0 ? 'no address' : reached.join(', ')}` +
			(notSent.length > 0 ? `; not to: ${notSent.join(', ')}` : ''),
		{ scope, scopeId },
		{ userId: user.id }
	);

	if (sentTo === 0) {
		return json({ message: `The report was not sent. ${REFUSED}`, results }, { status: 502 });
	}
	// Each reason a mail was not sent, by its addresses, when there are both (the review's CR3).
	const refusedTo = results.filter((r) => r.message === REFUSED).map((r) => r.email);
	const stoppedTo = results.filter((r) => r.message === STOPPED).map((r) => r.email);
	const notSentWords =
		refusedTo.length > 0 && stoppedTo.length > 0
			? `Not sent to ${refusedTo.join(', ')}: ${REFUSED} Not sent to ${stoppedTo.join(', ')}: ${STOPPED}`
			: `Not sent to ${notSent.join(', ')}. ${stoppedTo.length > 0 ? STOPPED : REFUSED}`;
	return json(
		{
			message:
				notSent.length === 0
					? `Report sent to ${sentTo} recipient(s)`
					: `Report sent to ${sentTo} of ${results.length} recipients. ${notSentWords}`,
			results
		},
		{ status: 200 }
	);
};

/**
 * A report mail of `user`'s, read from `body`, with every refusal of it that
 * needs no password, in order (card 2751, D5): each field by its rule (card
 * 2117), as POST /api/reports reads them; the addresses, each as the mailer
 * reads it, and at most 10 (400); an all-boards report by an administrator
 * alone (403); what it covers, by the one rule every report opens with
 * (`reportScopeOpen`, S6: 403); mail set up (503); and the day's report mail,
 * read with nothing taken (`checkReportMail`, S4: 429). Reads only: asked in
 * the step-up's guard, before the password.
 */
function readReportMail(user: SessionUser, body: RequestBody) {
	const MISSING = 'Missing required fields';
	const SCOPE = 'Invalid scope. Must be: board, category, or all';
	const scope = readChoice(body, 'scope', { required: true, from: REPORT_SCOPES, says: { missing: MISSING, type: SCOPE, invalid: SCOPE } });
	// Each end a date or a timestamp, and the start not after the end.
	const { periodStart, periodEnd } = readReportWindow(body, MISSING);
	const scopeId = readId(body, 'scopeId', { nullable: true }) ?? null;
	const detailLevel = readChoice(body, 'detailLevel', { from: REPORT_DETAIL_LEVELS }) ?? 'detailed';
	const statusFilter = readChoice(body, 'statusFilter', { from: REPORT_STATUS_FILTERS }) ?? 'all';
	// Optional: narrow the whole report to one person's assigned work.
	const assigneeUserId = readReportAssignee(body);
	// Optional: the reader's time zone, whose day decides the Overdue figure
	// (card 2258), read as a schedule's is. None is UTC.
	const timeZone = readTimeZone(body, 'timeZone', {});

	// A list of addresses, each one (R10). One that was not was dropped, and
	// the report sent to the rest; and an entry that was not text was a 500.
	const NONE = 'At least one recipient email is required';
	const listed = readEmailList(body, 'recipients', { required: true, min: 1, says: { missing: NONE, type: NONE, empty: NONE } });
	// Each entry read as the mailer reads it (card 2182): one that the mailer
	// would send to someone other than it shows (`a@b.c<x>` goes to `x`), or
	// that has no dot after its `@`, is refused in the same words.
	listed.forEach((entry, index) => {
		const { addresses, notAddresses } = reportRecipients(entry);
		if (addresses.length !== 1 || notAddresses.length > 0) throw error(400, `recipients[${index}] must be an email address`);
	});
	// Each address once, in any case it was written in: one mail each.
	const recipients = reportRecipients(listed).addresses;
	// Before anything else is looked at, so the refusal says nothing of the board.
	if (recipients.length > MAX_REPORT_RECIPIENTS) {
		throw error(
			400,
			`A report can be emailed to at most ${MAX_REPORT_RECIPIENTS} addresses at a time, and this names ${recipients.length}. Nothing was sent.`
		);
	}

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		throw error(403, 'Only admins can generate all-boards reports');
	}
	if (scope !== 'all' && scopeId === null) throw error(400, 'scopeId required');

	// What the report covers, by the rule every report opens with (S6): a
	// board or grouping that is not there, or none of whose boards the caller
	// can open, is refused here as building it would refuse it.
	if (!reportScopeOpen(user, scope, scopeId)) {
		throw error(403, NO_ACCESS);
	}

	// Each send would return false and nothing would leave: said before the
	// PDF is built, as the invite and the public request say it (card 2136).
	if (!isSmtpConfigured()) {
		throw error(503, 'Mail is not set up on this server, so the report was not sent. An administrator sets it up on the admin page.');
	}

	// The day's allowance, read with nothing taken: taken once the password
	// is checked and the report built (`takeReportMail`, above).
	checkReportMail(user, recipients.length, 'email');

	return { scope, scopeId, periodStart, periodEnd, detailLevel, statusFilter, assigneeUserId, timeZone, recipients };
}
