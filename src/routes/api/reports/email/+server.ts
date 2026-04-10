/**
 * POST /api/reports/email — Generate a report PDF and email it to recipients.
 */

import { db } from '$lib/server/db';
import { boards, boardCategories } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	generateBoardReport, generateCategoryReport, generateAllBoardsReport,
	generateReportPdf
} from '$lib/server/reports';
import { sendEmailWithAttachment } from '$lib/server/email';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

	const body = await request.json();
	const { scope, scopeId, periodStart, periodEnd, recipients } = body;

	if (!scope || !periodStart || !periodEnd) {
		return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
		return new Response(JSON.stringify({ error: 'At least one recipient email is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	// Validate emails
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const validEmails = recipients.filter((e: string) => emailRegex.test(e.trim()));
	if (validEmails.length === 0) {
		return new Response(JSON.stringify({ error: 'No valid email addresses provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	if (scope === 'all' && user.role !== 'admin' && user.role !== 'superadmin') {
		return new Response(JSON.stringify({ error: 'Only admins can generate all-boards reports' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
	}

	let reportData;
	let scopeName = 'Report';

	if (scope === 'board') {
		if (!scopeId) return new Response(JSON.stringify({ error: 'scopeId required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		reportData = generateBoardReport(scopeId, periodStart, periodEnd, user);
		const board = db.select().from(boards).where(eq(boards.id, scopeId)).get();
		scopeName = board?.name || 'Board';
	} else if (scope === 'category') {
		if (!scopeId) return new Response(JSON.stringify({ error: 'scopeId required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		reportData = generateCategoryReport(scopeId, periodStart, periodEnd, user);
		const cat = db.select().from(boardCategories).where(eq(boardCategories.id, scopeId)).get();
		scopeName = cat?.name || 'Category';
	} else {
		reportData = generateAllBoardsReport(periodStart, periodEnd, user);
		scopeName = 'All Boards';
	}

	if (!reportData) {
		return new Response(JSON.stringify({ error: 'Failed to generate report or no access' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
	}

	const pdfBuffer = await generateReportPdf(reportData);
	const dateStr = new Date().toISOString().split('T')[0];
	const filename = `dumpfire-report-${scopeName.toLowerCase().replace(/\s+/g, '-')}-${dateStr}.pdf`;

	const results: { email: string; success: boolean; error?: string }[] = [];

	for (const email of validEmails) {
		try {
			await sendEmailWithAttachment(
				email.trim(),
				`DumpFire Report: ${scopeName}`,
				`<div style="font-family: sans-serif; max-width: 600px;">
					<h2 style="color: #1e293b;">DumpFire Report</h2>
					<p><strong>${scopeName}</strong></p>
					<p style="color: #64748b;">Period: ${new Date(periodStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} — ${new Date(periodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
					<p>Please find the attached PDF report.</p>
					<p style="color: #94a3b8; font-size: 12px; margin-top: 20px;">Sent by ${user.username} via DumpFire</p>
				</div>`,
				{ filename, content: pdfBuffer, contentType: 'application/pdf' }
			);
			results.push({ email: email.trim(), success: true });
		} catch (err) {
			results.push({ email: email.trim(), success: false, error: (err as Error).message });
		}
	}

	const sent = results.filter(r => r.success).length;
	const failed = results.filter(r => !r.success).length;

	return new Response(JSON.stringify({
		message: `Report sent to ${sent} recipient(s)${failed > 0 ? `, ${failed} failed` : ''}`,
		results
	}), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
};
