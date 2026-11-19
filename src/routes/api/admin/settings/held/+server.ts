/**
 * /api/admin/settings/held — the settings held for the superadmin's review
 * (card 2922).
 *
 * When an account's access ends with its API keys, the mail settings, the App
 * URL and the backup destinations it set are held (setting-holds.ts): nothing
 * is sent to them until the superadmin keeps or removes each here.
 *
 * GET — every administrator's: the settings held and in force at their held
 * place, each with where it sends and no secret, who it was held for and
 * since when; how many holds are at a place no setting is at now
 * (`tombstones`); and whether the caller may keep or remove one
 * (`mayRelease`, the superadmin alone).
 *
 *     { held: [{ setting, kind, name, place, holdPlace, heldAt, setBy, setByName, where }], tombstones, mayRelease }
 *
 * `place` is what was reviewed: the held place, and for an SFTP destination its
 * confirmed host key too (the code review's C16). Answered with no-store (C17).
 *
 * POST — the superadmin alone, with their current password and a code
 * (`STEP_UP_ACTIONS`): `{ setting, place, action: 'keep' | 'remove' }`, the
 * place as the GET gave it (its plan's R4). 403 for anyone else; 409 for a
 * setting that is not held now, or held at another place than the one sent
 * (it moved since the list was read). Keep deletes the hold and nothing else;
 * Remove removes the setting and keeps its hold, a tombstone (R1), and for
 * the mail settings or the App URL ends every invite not yet used, set-up link,
 * request link and decision link on the server (R2, C2, C3), counted in `ended`.
 *
 *     keep     { success, kept: setting }
 *     remove   { success, removed: setting, ended: { invites, enrolmentLinks, requestLinks, decisionLinks } | null }
 */
import { error, json } from '@sveltejs/kit';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { readBody, readChoice, readText } from '$lib/server/request-body';
import { requireAdmin } from '$lib/server/route-guards';
import { keepHeldSetting, removeHeldSetting, settingsHeldForReview } from '$lib/server/setting-setters';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import type { RequestHandler } from './$types';

/** What anyone but the superadmin is told of a Keep or a Remove. */
const ONLY_SUPERADMIN = "Only the superadmin keeps or removes a setting held for review. Nothing was changed.";
/** What a setting that is not held now is told. */
const NOT_HELD = 'That setting is not held for review now: it was kept, removed or changed since the list was read. Nothing was changed.';
/** What a setting held at another place than the one reviewed is told (R4). */
const MOVED = 'That setting has changed since the list was read: read it again and review it as it is now. Nothing was changed.';

const ACTIONS = ['keep', 'remove'] as const;

export const GET: RequestHandler = async ({ locals }) => {
	const caller = requireAdmin(locals.user);
	const { held, tombstones } = settingsHeldForReview();
	// Kept by nothing on the way (the code review's C17): where the mail and the backups send.
	return json({ held, tombstones, mayRelease: caller.role === 'superadmin' }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	requireAdmin(locals.user);
	const body = await readBody(request);
	const MISSING = 'Missing setting, place or action';
	const setting = readText(body, 'setting', { required: true, min: 1, max: 600, says: { missing: MISSING, empty: MISSING } });
	const place = readText(body, 'place', { required: true, min: 1, max: 200, says: { missing: MISSING, empty: MISSING } });
	const action = readChoice(body, 'action', { from: ACTIONS, required: true });

	/**
	 * Every refusal, read only: the caller as their account is now, the
	 * superadmin alone, and the setting held now at the place reviewed. Asked
	 * before the password, and again in the transaction that writes.
	 */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);
		if (actor.role !== 'superadmin') throw error(403, ONLY_SUPERADMIN);
		const now = settingsHeldForReview().held.filter((held) => held.setting === setting);
		if (now.length === 0) throw error(409, NOT_HELD);
		const reviewed = now.find((held) => held.place === place);
		if (reviewed === undefined) throw error(409, MOVED);
		return { actor, reviewed };
	};

	const { userId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/admin/settings/held', (caller) => refusals(caller));

	const answer = await whilePasswordHolds(userId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, reviewed } = refusals(caller);
			if (action === 'keep') {
				keepHeldSetting(reviewed, actor);
				return { success: true, kept: reviewed.setting };
			}
			const { ended } = removeHeldSetting(reviewed, actor);
			return { success: true, removed: reviewed.setting, ended };
		})
	);
	return json(answer);
};
