/**
 * Session-authenticated milestone PDF — what the download button on the
 * planning view calls. Mirrors the v1 route; only the auth differs.
 */
import { error } from '@sveltejs/kit';
import { readMilestoneSummary } from '$lib/server/milestone-service';
import { generateMilestonePdf, milestonePdfFilename } from '$lib/server/milestone-report';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.id, 'milestone');

	// Exporting a plan is reading it, so it is governed by the same rule, and
	// it is the caller's own view of the plan: a document they take away holds
	// no more than the page shows them (card 2129). `readMilestoneSummary`
	// (card 2012).
	const summary = readMilestoneSummary(locals.user, { milestoneId: id }, {});

	const pdf = await generateMilestonePdf(summary);
	return new Response(new Uint8Array(pdf), {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${milestonePdfFilename(summary.milestone.name)}"`,
			'Content-Length': String(pdf.length)
		}
	});
};
