import type { PageServerLoad } from './$types';
import { redirect } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/board-access';
import { readDirectory } from '$lib/server/people-directory';
import { settingsHeldForBanner } from '$lib/server/setting-setters';

/**
 * The people directory's page (card 2674, plan 4.3): every person, group and
 * account, for an administrator to keep.
 */
export const load: PageServerLoad = async ({ locals }) => {
	// Administrators only. ADMIN_ROUTES in hooks.server.ts turns everyone else
	// away before this runs, with the same two redirects. It is asked again
	// here, as `/admin` asks it, because this load hands back every person's
	// and every account's name and address.
	if (!locals.user) throw redirect(303, '/login');
	if (!isAdmin(locals.user)) throw redirect(303, '/');

	// Card 2922 (R7): the settings held for review, for the superadmin's banner: their kind and name alone.
	return { ...readDirectory(), settingsHeld: settingsHeldForBanner() };
};
