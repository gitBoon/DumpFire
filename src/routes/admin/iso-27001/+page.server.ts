import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { CHECKED_ON, CHECKLIST, summarise } from '$lib/server/iso-27001';

/**
 * The ISO/IEC 27001:2022 checklist's page (card 2670): every Annex A control
 * and clause, with the application's side counted apart from the
 * organisation's. Read-only.
 */
export const load: PageServerLoad = async ({ locals }) => {
	// Administrators only. ADMIN_ROUTES in hooks.server.ts turns everyone else
	// away before this runs, with the same two redirects. It is asked again
	// here, as `/admin/people` asks it, because the checklist names DumpFire's
	// known weaknesses and the files they are in (plan D2).
	if (!locals.user) throw redirect(303, '/login');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	return { items: CHECKLIST, summary: summarise(CHECKLIST), checkedOn: CHECKED_ON };
};
