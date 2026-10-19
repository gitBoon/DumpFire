/**
 * Reports API — Generate PDF reports on demand.
 *
 * POST /api/reports — Generate a PDF report and return it as binary.
 *                     No storage — the PDF is ephemeral.
 *
 * An optional `timeZone` (an IANA name, as the Reports page sends the
 * browser's) is the zone whose day the Overdue figure counts from (card
 * 2258); without one it is UTC. The PDF's dates are printed in UTC either way.
 */

import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf, readReportAssignee, readReportWindow,
	REPORT_DETAIL_LEVELS, REPORT_SCOPES, REPORT_STATUS_FILTERS
} from '$lib/server/reports';
import { readBody, readChoice, readId, readTimeZone } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

const MISSING = 'Missing required fields: scope, periodStart, periodEnd';
const SCOPE = 'Invalid scope. Must be: board, category, or all';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) throw error(401, 'Unauthorized');

	// Each field by its rule (card 2117). A detail level, a status filter or a
	// scope it did not know was read as another, and a period that was not
	// text, or a scopeId that was not an id, was a 500.
	const body = await readBody(request);
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

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		throw error(403, 'Only admins can generate all-boards reports');
	}

	let reportData;
	let filename = 'dumpfire-report';

	if (scope === 'board') {
		if (scopeId === null) throw error(400, 'scopeId required for board scope');
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		if (!reportData) throw error(403, 'Board not found or no access');
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		filename = `dumpfire-report-${(board?.name || 'board').toLowerCase().replace(/\s+/g, '-')}`;
	} else if (scope === 'category') {
		if (scopeId === null) throw error(400, 'scopeId required for category scope');
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		if (!reportData) throw error(403, 'Category not found or no accessible boards');
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		filename = `dumpfire-report-${(cat?.name || 'category').toLowerCase().replace(/\s+/g, '-')}`;
	} else {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user, statusFilter, assigneeUserId, timeZone);
		if (!reportData) throw error(500, 'Failed to generate report');
		filename = 'dumpfire-report-all-boards';
	}

	if (statusFilter !== 'all') filename += '-' + statusFilter.replace('_', '-');

	// Generate PDF
	const pdfBuffer = await generateReportPdf(reportData, detailLevel);

	const dateStr = new Date().toISOString().split('T')[0];

	return new Response(new Uint8Array(pdfBuffer), {
		status: 200,
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `inline; filename="${filename}-${dateStr}.pdf"`,
			'Content-Length': String(pdfBuffer.length)
		}
	});
};
