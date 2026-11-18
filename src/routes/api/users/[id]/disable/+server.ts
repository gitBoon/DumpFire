import { error, json } from '@sveltejs/kit';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { ALREADY_DISABLED, disableAccount } from '$lib/server/account-disable';
import { addressOf } from '$lib/server/client-address';
import { securityNoticeSent } from '$lib/server/notifications';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * POST — Disable another account (card 2671): it can no longer sign in, and
 * everything that let it in or sent things out for it ends at once
 * (`disableAccount`): its sessions, invites, pending sign-ins, set-up links
 * and API keys, the webhooks it set (switched off), its report schedules
 * (paused) and the links of its requests; for an administrator, the mail
 * settings, App URL and backup destinations they saved and their address in
 * the backup failure address. Its name stays wherever it is shown, and its
 * password and authenticators are kept for an Enable.
 *
 * Shaped as POST /api/users/[id]/mfa/reset is: the caller's own account is
 * refused, 403 (D2); whose account they may disable is the one rule in
 * route-guards.ts; an account already disabled is 409; then the caller's own
 * password and a code (step-up.ts), and the disable in one transaction that
 * asks all of it again.
 *
 * Once committed, the account's address is sent a notice naming who disabled
 * it, and awaited: `noticeSent` says whether it went. It cannot go when the
 * disable removed the mail settings, which the answer then says (S8).
 *
 *     { disabled: true, disabledAt, sessionsEnded, invitesEnded, apiKeysEnded,
 *       webhooksSwitchedOff, reportSchedulesPaused, requestLinksEnded,
 *       soleOwnerOf, noticeSent, settingsRemoved? }
 *
 * `settingsRemoved`, `{ mail, appUrl, destinations, failureAddress }`, only
 * where something was.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies, getClientAddress }) => {
	requireUser(locals.user);

	const userId = pathId(params.id, 'user');

	// Nobody disables their own account (D2): it would sign them out of every
	// session with nobody to enable it but another administrator.
	const OWN = 'You cannot disable your own account';
	refuseOwnAccount(locals.user, userId, OWN);
	requireAdmin(locals.user);

	const body = await readBody(request);

	/** Every refusal, read only: asked before the password, and again in the transaction that disables. */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);
		refuseOwnAccount(actor, userId, OWN);
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Cannot disable superadmin account',
			admin: 'Only superadmin can disable admin users'
		});
		if (target.disabledAt !== null) throw error(409, ALREADY_DISABLED);
		return { actor, target };
	};

	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/users/[id]/disable', (caller) =>
		refusals(caller)
	);

	// The administrator's address goes on the AUTH line alone, never in the
	// notice to the account (the code review's CS1).
	const ip = addressOf({ getClientAddress })?.slice(0, 100) ?? null;
	const done = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, target } = refusals(caller);
			return { actor, target, disabled: disableAccount(target, actor, ip) };
		})
	);

	// After the commit, and awaited. Not sent where the disable removed the mail
	// settings: there is no mail to send it by (S8).
	const { actor, target, disabled } = done;
	const noticeSent =
		disabled.settingsRemoved?.mail === true
			? false
			: await securityNoticeSent(target.id, 'account-disabled', { at: new Date(), address: null, by: actor.username });

	const { access } = disabled;
	return json({
		disabled: true,
		disabledAt: disabled.disabledAt,
		sessionsEnded: access.sessions,
		invitesEnded: access.invites,
		apiKeysEnded: access.apiKeys,
		webhooksSwitchedOff: access.webhooks,
		reportSchedulesPaused: access.reportSchedules,
		requestLinksEnded: disabled.requestLinksEnded,
		soleOwnerOf: disabled.soleOwnerOf,
		noticeSent,
		...(disabled.settingsRemoved === null ? {} : { settingsRemoved: disabled.settingsRemoved })
	});
};
