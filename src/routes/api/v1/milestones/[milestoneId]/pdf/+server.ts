/**
 * GET /api/v1/milestones/:milestoneId/pdf — the milestone plan as a PDF.
 *
 * Same document the planning view's download button produces, so a plan can be
 * pulled for a stakeholder pack without opening a browser.
 */
import { error } from '@sveltejs/kit';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import { generateMilestonePdf, milestonePdfFilename } from '$lib/server/milestone-report';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.milestoneId);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	try {
		requireMilestone(locals.user, id);
	} catch (e) {
		if (e instanceof MilestoneError) throw error(e.status, e.message);
		throw e;
	}

	const summary = getMilestoneSummary(id);
	if (!summary) throw error(404, 'Milestone not found');

	const pdf = await generateMilestonePdf(summary);
	return new Response(new Uint8Array(pdf), {
		headers: {
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${milestonePdfFilename(summary.milestone.name)}"`,
			'Content-Length': String(pdf.length)
		}
	});
};
