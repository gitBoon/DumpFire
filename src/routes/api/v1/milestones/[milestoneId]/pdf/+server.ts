/**
 * GET /api/v1/milestones/:milestoneId/pdf — the milestone plan as a PDF.
 *
 * Same document the planning view's download button produces, so a plan can be
 * pulled for a stakeholder pack without opening a browser.
 */
import { error } from '@sveltejs/kit';
import { readMilestoneSummary } from '$lib/server/milestone-service';
import { generateMilestonePdf, milestonePdfFilename } from '$lib/server/milestone-report';
import { pathId } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = pathId(params.milestoneId, 'milestone');

	// The key's user's own view of the plan, as the summary gives it (card
	// 2129): `readMilestoneSummary`, which the internal route shares (card 2012).
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
