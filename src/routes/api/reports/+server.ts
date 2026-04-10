/**
 * Reports API — Generate PDF reports on demand.
 *
 * POST /api/reports — Generate a PDF report and return it as binary.
 *                     No storage — the PDF is ephemeral.
 */

import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf
} from '$lib/server/reports';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

	const body = await request.json();
	const { scope, scopeId, periodStart, periodEnd } = body;

	if (!scope || !periodStart || !periodEnd) {
		return new Response(JSON.stringify({ error: 'Missing required fields: scope, periodStart, periodEnd' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	if (!['board', 'category', 'all'].includes(scope)) {
		return new Response(JSON.stringify({ error: 'Invalid scope. Must be: board, category, or all' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		return new Response(JSON.stringify({ error: 'Only admins can generate all-boards reports' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
	}

	let reportData;
	let filename = 'dumpfire-report';

	if (scope === 'board') {
		if (!scopeId) return new Response(JSON.stringify({ error: 'scopeId required for board scope' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user);
		if (!reportData) return new Response(JSON.stringify({ error: 'Board not found or no access' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		filename = `dumpfire-report-${(board?.name || 'board').toLowerCase().replace(/\s+/g, '-')}`;
	} else if (scope === 'category') {
		if (!scopeId) return new Response(JSON.stringify({ error: 'scopeId required for category scope' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user);
		if (!reportData) return new Response(JSON.stringify({ error: 'Category not found or no accessible boards' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		filename = `dumpfire-report-${(cat?.name || 'category').toLowerCase().replace(/\s+/g, '-')}`;
	} else {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user);
		if (!reportData) return new Response(JSON.stringify({ error: 'Failed to generate report' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
		filename = 'dumpfire-report-all-boards';
	}

	// Generate PDF
	const pdfBuffer = await generateReportPdf(reportData);

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
