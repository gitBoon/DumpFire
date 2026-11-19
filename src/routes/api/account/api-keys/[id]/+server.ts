import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { afterCommit } from '$lib/server/db/transaction';
import { apiKeys } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { pathId } from '$lib/server/request-body';
import { requireUser } from '$lib/server/route-guards';
import { writeAs } from '$lib/server/write-as';
import { holdRevealed, markExposed, revealsOfKeys, seedRevealsOnce, switchOffLostWebhooks, tellSwitchedOff } from '$lib/server/webhooks';
import type { RequestHandler } from './$types';

/** What the boards' owners are told caused it (card 2947, R12): no account named; the key and user ids are in the WARN. */
const REVOKED_IN_MAIL = 'an API key was revoked by its holder';

/**
 * DELETE — Revoke an API key by ID (must belong to the current user).
 *
 * The webhooks the key set up are switched off for good in the same write
 * (card 2893, D5, S10): the key deleted (its webhooks' `set_by_key` emptied by
 * the foreign key, which `holdOf` reads as a key that ended), then the
 * account's webhooks swept (`{ setters }`), which also finds one set up
 * before keys were recorded whose setter has just lost their last key from
 * then.
 *
 * And every webhook with a secret the key was given (card 2947, R3), whoever set
 * it, is held as `'setter access ended'`, so that switching it on gives it a new
 * secret: the webhooks it was given read before the key is deleted, since the
 * foreign key takes its rows with it; then the delete; then the setters' sweep;
 * then the hold of those read, which leaves one already held, a webhook the sweep
 * has just switched off among them.
 *
 * Told once, after the commit (R4): one WARN for those switched off and one for
 * those held, naming the key by its id (`API key #N was revoked by <name>`, the
 * log's cause, which administrators read), and one mail to each owner of their
 * boards, which names no account (R12); the account itself is mailed as the
 * setter of a webhook its key set, where it can still open the board. Answers
 * how many it switched off of those it set (`webhooksSwitchedOff`) and how many
 * of the others it held (`revealedWebhooksHeld`); the Account page said both
 * first, from the list's counts.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	requireUser(locals.user);

	// An id, as every id in a path is read (card 2117): `1.5` and `0` were looked for.
	const id = pathId(params.id, 'key');

	// The key found and revoked in one transaction that asks first whether the
	// session is still open, and who its account is now (card 2253). The read
	// and the delete were two steps with no transaction around them.
	const answer = writeAs(locals, (caller) => {
		const user = requireUser(caller);
		const key = db.select()
			.from(apiKeys)
			.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)))
			.get();

		if (!key) throw error(404, 'API key not found');

		// The reads made before they were recorded, seeded first where they never were (its code review, FP2): one read
		// of a flag once done. Then what it was given, before the delete takes its rows (card 2947, R3).
		seedRevealsOnce();
		const revealed = revealsOfKeys([key.id]);
		db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
		// The key by its id, never its name: the cause goes to the system log, which
		// every administrator reads (the ruling on S1's departure 9, as the create
		// keeps a key's name out of the log).
		const cause = `API key #${key.id} was revoked by ${user.username}`;
		const swept = switchOffLostWebhooks({ setters: [user.id] }, cause, { told: 'by the caller' });
		const held = holdRevealed(revealed);
		// Every one it was given told as exposed, a webhook it set among them (FP4).
		const given = revealed.map((reveal) => reveal.webhookId);
		const switchedOff = markExposed([...swept, ...held.switchedOff], given);
		const heldOff = markExposed(held.held, given);
		if (switchedOff.length + heldOff.length > 0) {
			afterCommit(() => tellSwitchedOff(switchedOff, cause, { mail: true }, heldOff, REVOKED_IN_MAIL));
		}
		return { webhooksSwitchedOff: swept.length, revealedWebhooksHeld: held.switchedOff.length + held.held.length };
	});

	return json({ success: true, ...answer });
};
