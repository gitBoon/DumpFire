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
 */

import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf, readReportAssignee, readReportWindow, takeReportMail,
	REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS
} from '$lib/server/reports';
import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
import { readBody, readChoice, readEmailList, readId, readTimeZone } from '$lib/server/request-body';
import { isSmtpConfigured, sendEmailWithAttachment } from '$lib/server/email';
import { canViewBoard, isAdmin } from '$lib/server/board-access';
import { requireUser } from '$lib/server/route-guards';
import { stillCallerNow } from '$lib/server/write-as';
import { escapeHtml } from '$lib/escape-html';
import { parseStamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals.user);

	// Each field by its rule (card 2117), as POST /api/reports reads them. A
	// scope it did not know was read as every board the caller can see.
	const body = await readBody(request);
	// Who is asking, as their account is now, once the body has come: a
	// session that ended while it arrived is refused, and a role lowered
	// meanwhile is met below (card 2253). Mail leaves the process, after a PDF
	// built with an await, which no transaction can hold: asked here, and again
	// before the first mail is sent.
	const caller = stillCallerNow(locals);
	const user = requireUser(caller);
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

	let reportData;
	let scopeName = 'Report';
	// For a grouping's report, the boards in it the caller can open: what the
	// PDF holds, asked again of the caller before it is sent.
	let reported: number[] = [];

	if (scope === 'board') {
		if (scopeId === null) throw error(400, 'scopeId required');
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		scopeName = board?.name || 'Board';
	} else if (scope === 'category') {
		if (scopeId === null) throw error(400, 'scopeId required');
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		scopeName = cat?.name || 'Category';
		reported = db.select({ id: boards.id }).from(boards).where(eq(boards.categoryId, scopeId)).all()
			.map((b) => b.id)
			.filter((id) => canViewBoard(user, id));
	} else {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		scopeName = 'All Boards';
	}

	const NO_ACCESS = 'Failed to generate report or no access';
	if (!reportData) {
		throw error(403, NO_ACCESS);
	}

	// Each send would return false and nothing would leave: said before the
	// PDF is built, as the invite and the public request say it (card 2136).
	if (!isSmtpConfigured()) {
		throw error(503, 'Mail is not set up on this server, so the report was not sent. The superadmin sets it up on the admin page.');
	}

	// The day's allowance: a call refused above spent nothing, and nothing is
	// built or sent when this refuses. What it takes is not given back when the
	// mail server refuses a send: the attempt was made.
	takeReportMail(user, recipients.length, 'email');

	const pdfBuffer = await generateReportPdf(reportData, detailLevel);
	// Asked again now the PDF is made, with nothing awaited between this and
	// the first send: a session that ended while it was built sends no mail
	// (the plan's R1). The allowance taken above stays taken: the attempt was
	// made. The second and later recipients are sent on this check.
	const sender = requireUser(stillCallerNow(locals));
	// And everything the mail relies on, decided again on the account as it is
	// now, in the same words: the PDF was built for the caller as they were
	// before its await, and a role lowered or a board taken away meanwhile
	// sends nothing. An all-boards report by an administrator; a board's by
	// someone who can open it; a grouping's by someone who can still open every
	// board in it that the PDF holds. The sub-boards a PDF takes in are not
	// asked again (N4).
	if (scope === 'all' && !isAdmin(sender)) {
		throw error(403, 'Only admins can generate all-boards reports');
	}
	if (scope === 'board' && scopeId !== null && !canViewBoard(sender, scopeId)) throw error(403, NO_ACCESS);
	if (scope === 'category' && !reported.every((id) => canViewBoard(sender, id))) throw error(403, NO_ACCESS);
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

	if (sentTo === 0) {
		return json({ message: `The report was not sent. ${REFUSED}`, results }, { status: 502 });
	}
	return json(
		{
			message:
				notSent.length === 0
					? `Report sent to ${sentTo} recipient(s)`
					: `Report sent to ${sentTo} of ${results.length} recipients. Not sent to ${notSent.join(', ')}. ${REFUSED}`,
			results
		},
		{ status: 200 }
	);
};
