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
 */

import { error, json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf, readReportAssignee, readReportWindow,
	REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS
} from '$lib/server/reports';
import { readBody, readChoice, readEmailList, readId } from '$lib/server/request-body';
import { isSmtpConfigured, sendEmailWithAttachment } from '$lib/server/email';
import { escapeHtml } from '$lib/escape-html';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');

	// Each field by its rule (card 2117), as POST /api/reports reads them. A
	// scope it did not know was read as every board the caller can see.
	const body = await readBody(request);
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

	// A list of addresses, each one (R10). One that was not was dropped, and
	// the report sent to the rest; and an entry that was not text was a 500.
	const NONE = 'At least one recipient email is required';
	const recipients = readEmailList(body, 'recipients', { required: true, min: 1, says: { missing: NONE, type: NONE, empty: NONE } });

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		throw error(403, 'Only admins can generate all-boards reports');
	}

	let reportData;
	let scopeName = 'Report';

	if (scope === 'board') {
		if (scopeId === null) throw error(400, 'scopeId required');
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId);
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		scopeName = board?.name || 'Board';
	} else if (scope === 'category') {
		if (scopeId === null) throw error(400, 'scopeId required');
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId);
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		scopeName = cat?.name || 'Category';
	} else {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user, statusFilter, assigneeUserId);
		scopeName = 'All Boards';
	}

	if (!reportData) {
		throw error(403, 'Failed to generate report or no access');
	}

	// Each send would return false and nothing would leave: said before the
	// PDF is built, as the invite and the public request say it (card 2136).
	if (!isSmtpConfigured()) {
		throw error(503, 'Mail is not set up on this server, so the report was not sent. The superadmin sets it up on the admin page.');
	}

	const pdfBuffer = await generateReportPdf(reportData, detailLevel);
	const dateStr = new Date().toISOString().split('T')[0];
	const filename = `dumpfire-report-${scopeName.toLowerCase().replace(/\s+/g, '-')}-${dateStr}.pdf`;
	// A YYYY-MM-DD bound is read as UTC midnight, so it is written out in UTC: in the
	// server's own zone, west of UTC, it would read as the day before.
	const day = (value: string) => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

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
				email.trim(),
				`DumpFire Report: ${scopeName}`,
				`<div style="font-family: sans-serif; max-width: 600px;">
					<h2 style="color: #1e293b;">DumpFire Report</h2>
					<p><strong>${escapeHtml(scopeName)}</strong></p>
					<p style="color: #64748b;">Period: ${escapeHtml(day(periodStart))} — ${escapeHtml(day(periodEnd))}</p>
					<p>Please find the attached PDF report.</p>
					<p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">Sent by ${escapeHtml(user.username)} via DumpFire</p>
				</div>`,
				{ filename, content: pdfBuffer, contentType: 'application/pdf' }
			);
		} catch {
			// It catches and logs a failure itself, and returns false; a throw
			// would be something else again, and is not a send either.
			sent = false;
		}
		results.push(sent ? { email: email.trim(), success: true } : { email: email.trim(), success: false, message: REFUSED });
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
