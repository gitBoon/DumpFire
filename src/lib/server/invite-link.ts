/**
 * invite-link.ts — what an invite route answers about its mail (card 2196).
 *
 * Both routes that issue an invite (POST /api/users/[id]/invite, and POST
 * /api/users with no password) send its mail once the invite is committed,
 * and wait for it. When the mail went, the answer says so. When it did not,
 * the invite is kept (the account's earlier one was deleted at the commit,
 * so deleting this one too would leave it no link at all) and the answer
 * gives its link to the administrator whose request issued it, to pass on by
 * hand. Neither route ever says "sent" for a mail that was not.
 *
 * The link is a credential: whoever opens it sets the account's password and
 * is signed in. It adds no power: the account rule (`requireManagedAccount`)
 * has already let this administrator reset the account's password, which
 * ends what an invite's use ends. But the mail takes seconds, and meanwhile
 * the issuer may have been made an ordinary user or signed out, or another
 * administrator may have sent a newer invite. So before the link is put in
 * the answer, three things are read again (R-S1), by reads only:
 *
 *     the caller's session     still open, and still an administrator's
 *     the account rule         `mayManageAccount`, both accounts read afresh
 *     the invite               still one that can set a password
 *
 * Any of them failing, the answer has no link, and says to send a new invite
 * once mail works. Either way one `WARN` line says that the mail of an invite
 * failed and whether its link was given, naming the two accounts by id and
 * holding no link and no token: the trail that an administrator held a link.
 *
 * The routes that give an enrolment link in their answer ask the same three
 * of it, the third of the link (`enrolmentLinkNotGiven`, card 2773's decision
 * 15, shared by the two-step reset and, since card 2851, the create with a
 * password).
 */
import { and, eq, gt } from 'drizzle-orm';
import { mayManageAccount } from '$lib/account-rule';
import { stamp } from '$lib/timestamps';
import { openSessionUser, sessionHashIn, type Credential } from './auth';
import { isAdmin } from './board-access';
import { db } from './db';
import { enrolmentLinks, users } from './db/schema';
import { type MailOutcome, mailProblemWords } from './email';
import { usableInvite } from './invites';
import { createLogger } from './logger';

const log = createLogger('AUTH');

/** What an invite route answers about its mail, beside its own fields. */
export type InviteMailAnswer =
	| { mailSent: true }
	| { mailSent: false; mailProblem: string; inviteUrl: string }
	| { mailSent: false; mailProblem: string; inviteUrl: null };

/**
 * The words of the two checks every link given in an answer asks first: the
 * invite's here (R-S1), and the two-step reset's enrolment link (card 2773,
 * decision 15), which shares them so the two cannot come to say different
 * things of the same failure.
 */
export const CALLER_NOT_GIVEN = {
	session: "the caller's session has ended, or is no longer an administrator's",
	rule: 'the caller may no longer manage the account'
} as const;

/** Why the link of an invite whose mail failed was not given, by the check that failed. */
const NOT_GIVEN = {
	...CALLER_NOT_GIVEN,
	invite: 'the invite no longer works'
} as const;

/**
 * The first two checks of R-S1 (and of card 2773's decision 15), by reads
 * only: the caller's session is still open and an administrator's, and the
 * caller, as their account is now, may still manage the account, read
 * afresh. Answers the first that fails, or null when both hold; each caller
 * then asks its own third check, of its own link. The session is the one the
 * gate let the request in with, by its hash (card 2775).
 */
export function callerStillManages(credential: Credential | null | undefined, actorId: number, accountId: number): keyof typeof CALLER_NOT_GIVEN | null {
	// Only a session reaches an internal route: a key is taken only under /api/v1/.
	const caller = openSessionUser(sessionHashIn(credential));
	if (!caller || caller.id !== actorId || !isAdmin(caller)) return 'session';

	const account = db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, accountId)).get();
	if (!account || account.id === caller.id || !mayManageAccount(caller, account)) return 'rule';

	return null;
}

/**
 * What the answer to the request that issued an invite says of its mail.
 *
 * `outcome` is what `sendInviteEmail` resolved with, after the commit. Every
 * outcome but `sent: true` is a mail that did not go, `not-configured`
 * included: the mail host was cleared between the commit and the send, and
 * the invite exists all the same (R-S2). Then the link is given only if the
 * three checks above all still hold.
 */
export function inviteMailAnswer(opts: {
	outcome: MailOutcome;
	credential: Credential | null | undefined;
	actorId: number;
	accountId: number;
	token: string;
	baseUrl: string;
}): InviteMailAnswer {
	const { outcome, credential, actorId, accountId, token, baseUrl } = opts;
	if (outcome.sent) return { mailSent: true };

	const mailProblem = mailProblemWords(outcome.problem);
	const notGiven = whyNotGiven(credential, actorId, accountId, token);
	const said = `Invite for user ${accountId} was issued by user ${actorId}; its mail was not sent (${mailProblem}), and its link was`;

	if (notGiven !== null) {
		log.warn(`${said} not given to them: ${NOT_GIVEN[notGiven]}`, { accountId, problem: outcome.problem, check: notGiven }, { userId: actorId });
		return { mailSent: false, mailProblem, inviteUrl: null };
	}

	log.warn(`${said} given in the answer to their request`, { accountId, problem: outcome.problem }, { userId: actorId });
	return { mailSent: false, mailProblem, inviteUrl: `${baseUrl}/invite/${token}` };
}

/**
 * Why an enrolment link was withheld from an answer, by the check of card
 * 2773's decision 15 that failed: the two-step reset's (POST
 * /api/users/[id]/mfa/reset) and, since card 2851, the one issued with an
 * account an administrator makes with a password (POST /api/users).
 */
export const ENROLMENT_LINK_NOT_GIVEN = {
	...CALLER_NOT_GIVEN,
	link: "the link is no longer the account's"
} as const;

/**
 * The first of decision 15's checks that fails for an enrolment link about to
 * be put in an answer, or null when all three hold, by reads only. The first
 * two are `callerStillManages` (card 2773's review, C-I1); the third, that
 * the link (by its token's hash) is still live and still the account's. One
 * function for both routes that give such a link (card 2851), so that the two
 * cannot come to say different things of the same failure.
 */
export function enrolmentLinkNotGiven(
	credential: Credential | null | undefined,
	actorId: number,
	accountId: number,
	tokenHash: string
): keyof typeof ENROLMENT_LINK_NOT_GIVEN | null {
	const callerCheck = callerStillManages(credential, actorId, accountId);
	if (callerCheck !== null) return callerCheck;

	const link = db
		.select({ userId: enrolmentLinks.userId })
		.from(enrolmentLinks)
		.where(and(eq(enrolmentLinks.tokenHash, tokenHash), gt(enrolmentLinks.expiresAt, stamp())))
		.get();
	if (!link || link.userId !== accountId) return 'link';

	return null;
}

/** The first of R-S1's checks that fails, or null when all three hold. */
function whyNotGiven(credential: Credential | null | undefined, actorId: number, accountId: number, token: string): keyof typeof NOT_GIVEN | null {
	const callerCheck = callerStillManages(credential, actorId, accountId);
	if (callerCheck !== null) return callerCheck;

	const invite = usableInvite(token);
	if (!invite || invite.userId !== accountId) return 'invite';

	return null;
}
