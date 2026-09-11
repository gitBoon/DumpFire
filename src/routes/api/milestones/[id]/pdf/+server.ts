/**
 * Session-authenticated milestone PDF — what the download button on the
 * planning view calls. Mirrors the v1 route; only the auth differs.
 */
import { error } from '@sveltejs/kit';
import { requireMilestone, MilestoneError } from '$lib/server/milestones';
import { getMilestoneSummary } from '$lib/server/planning';
import { generateMilestonePdf, milestonePdfFilename } from '$lib/server/milestone-report';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	const id = Number(params.id);
	if (isNaN(id)) throw error(400, 'Invalid milestone ID');

	// Exporting a plan is reading it, so it is governed by the same rule.
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
