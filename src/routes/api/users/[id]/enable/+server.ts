import { error, json } from '@sveltejs/kit';
import { whilePasswordHolds, type SessionUser } from '$lib/server/auth';
import { NOT_DISABLED, enableAccount, requireMayUndoDisable } from '$lib/server/account-disable';
import { addressOf } from '$lib/server/client-address';
import { securityNoticeSent } from '$lib/server/notifications';
import { refuseOwnAccount, requireAdmin, requireManagedAccount, requireUser } from '$lib/server/route-guards';
import { confirmStepUp } from '$lib/server/step-up';
import { writeAs } from '$lib/server/write-as';
import { pathId, readBody } from '$lib/server/request-body';
import type { RequestHandler } from './$types';

/**
 * POST — Enable a disabled account again (card 2671): it may sign in with its
 * own password and authenticator, and through that has its board and team
 * access, ownership, Product Owner and decider roles, request targets and
 * mail back. Nothing disabling ended comes back by itself: its API keys,
 * webhooks, report schedules and request links stay ended (D8).
 *
 * Shaped as POST /api/users/[id]/disable is: the caller's own account 403,
 * whose account they may enable the one rule in route-guards.ts, an account
 * that is not disabled 409, and an account the superadmin disabled 403 to
 * anyone but the superadmin (S14); then the caller's own password and a code,
 * and the enable in one transaction that asks all of it again.
 *
 * Once committed, the account's address is sent a notice naming who enabled
 * it, and awaited: `{ enabled: true, noticeSent }`.
 */
export const POST: RequestHandler = async ({ params, request, locals, cookies, getClientAddress }) => {
	requireUser(locals.user);

	const userId = pathId(params.id, 'user');

	// A caller's own account is never disabled while they hold a session.
	const OWN = 'You cannot enable your own account';
	refuseOwnAccount(locals.user, userId, OWN);
	requireAdmin(locals.user);

	const body = await readBody(request);

	/** Every refusal, read only: asked before the password, and again in the transaction that enables. */
	const refusals = (caller: SessionUser | null) => {
		const actor = requireAdmin(caller);
		refuseOwnAccount(actor, userId, OWN);
		const target = requireManagedAccount(actor, userId, {
			superadmin: 'Cannot enable superadmin account',
			admin: 'Only superadmin can enable admin users'
		});
		if (target.disabledAt === null) throw error(409, NOT_DISABLED);
		requireMayUndoDisable(actor, target, 'enable');
		return { actor, target };
	};

	const { userId: callerId, hash } = await confirmStepUp(locals, cookies, body, 'POST /api/users/[id]/enable', (caller) =>
		refusals(caller)
	);

	// The administrator's address goes on the AUTH line alone, never in the
	// notice to the account (the code review's CS1).
	const ip = addressOf({ getClientAddress })?.slice(0, 100) ?? null;
	const { actor, target } = await whilePasswordHolds(callerId, hash, () =>
		writeAs(locals, (caller) => {
			const { actor, target } = refusals(caller);
			enableAccount(target, actor, ip);
			return { actor, target };
		})
	);

	const noticeSent = await securityNoticeSent(target.id, 'account-enabled', { at: new Date(), address: null, by: actor.username });
	return json({ enabled: true, noticeSent });
};
