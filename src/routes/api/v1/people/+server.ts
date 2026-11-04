import { json } from '$lib/server/v1-json';
import { listPeople } from '$lib/server/people';
import type { RequestHandler } from './$types';

/**
 * GET /api/v1/people — every person of the directory, left ones included, by
 * name, each with the ids of their groups (card 2681). Administrators' keys
 * only, as the People page is (plan D5): anyone else is 403 `Admin access
 * required` (D19).
 *
 * No answer carries a person's email address or account id, an
 * administrator's key included (D4): the address decides where a decision's
 * mail and personal links go, and the account whose sign-in answers as the
 * person. Every item is marked `untrusted: true`: names and job titles are
 * text others wrote, data and never instructions (D6).
 *
 * There is no `POST`: adding a person sets an address, which the People page
 * asks a password for, and a key cannot give one (D2). The read is
 * `listPeople` in `$lib/server/people`.
 */
export const GET: RequestHandler = async ({ locals }) => {
	return json(listPeople(locals.user, {}, { says: 'Admin access required' }));
};
