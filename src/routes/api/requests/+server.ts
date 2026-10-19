import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { inTransaction } from '$lib/server/db/transaction';
import { taskRequests, users, teams, teamMembers, cards, columns, boards } from '$lib/server/db/schema';
import { eq, and, inArray, or, desc, ne, lt } from 'drizzle-orm';
import { notifyTaskRequest, notifyRequesterConfirm } from '$lib/server/notifications';
import { NO_LINK_ADDRESS, linkBaseUrl, isSmtpConfigured } from '$lib/server/email';
import { newRequestToken, publicRequest, requestConfirmUrl, verifyFormToken } from '$lib/server/request-tokens';
import { checkRateLimit } from '$lib/server/rate-limit';
import { addressToCount } from '$lib/server/client-address';
import { readBody, readChoice, readEmail, readId, readText } from '$lib/server/request-body';
import { requireBoard } from '$lib/server/route-guards';
import { getAccessibleBoardIds } from '$lib/server/board-access';
import { UNVERIFIED_LIFETIME_DAYS, requesterAddress } from '$lib/server/request-access';
import { stamp } from '$lib/timestamps';
import type { RequestHandler } from './$types';

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/** GET — Returns requests targeted at the current user or their teams. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'Not authenticated');

	// Find teams the user belongs to
	const userTeamRows = db.select({ teamId: teamMembers.teamId })
		.from(teamMembers)
		.where(eq(teamMembers.userId, locals.user.id))
		.all();
	const userTeamIds = userTeamRows.map(r => r.teamId);

	// Build conditions: requests targeting this user directly OR their teams
	const conditions = [
		and(eq(taskRequests.targetType, 'user'), eq(taskRequests.targetId, locals.user.id))
	];
	if (userTeamIds.length > 0) {
		conditions.push(
			and(eq(taskRequests.targetType, 'team'), inArray(taskRequests.targetId, userTeamIds))
		);
	}

	// All users (including admins) only see requests targeted at them or their teams.
	// A request nobody has confirmed yet is not shown: it may not be from who it
	// says it is, and showing it would make the inbox the spam channel instead.
	const rows = db.select().from(taskRequests)
		.where(and(or(...conditions), ne(taskRequests.status, 'unverified')))
		.orderBy(desc(taskRequests.createdAt))
		.all();

	// The boards the reader can open, once (null: an administrator, every one).
	const accessible = getAccessibleBoardIds(locals.user);
	const openBoardIds = accessible === null ? null : new Set(accessible);
	const canOpen = (boardId: number) => openBoardIds === null || openBoardIds.has(boardId);

	// Enrich with target name, desired board info, and resolved board ID
	const enriched = rows.map(r => {
		let targetName = 'Unknown';
		let targetEmoji = '❓';
		if (r.targetType === 'team') {
			const team = db.select({ name: teams.name, emoji: teams.emoji }).from(teams).where(eq(teams.id, r.targetId)).get();
			if (team) { targetName = team.name; targetEmoji = team.emoji || '🏢'; }
		} else {
			const user = db.select({ username: users.username, emoji: users.emoji }).from(users).where(eq(users.id, r.targetId)).get();
			if (user) { targetName = user.username; targetEmoji = user.emoji || '👤'; }
		}

		// Look up the board for resolved cards
		let resolvedBoardId: number | null = null;
		if (r.resolvedCardId) {
			const card = db.select({ columnId: cards.columnId }).from(cards).where(eq(cards.id, r.resolvedCardId)).get();
			if (card) {
				const col = db.select({ boardId: columns.boardId }).from(columns).where(eq(columns.id, card.columnId)).get();
				if (col) resolvedBoardId = col.boardId;
			}
		}

		// Look up desired board info, only for a board the reader can open
		// (card 2153). Each reader is judged for themselves: the addressee, or
		// any member of the addressed team. Otherwise the board's id, name and
		// emoji are all null, so the accept dialog preselects no board missing
		// from its own list, which is the boards the reader can open.
		const desiredBoardId = r.desiredBoardId !== null && canOpen(r.desiredBoardId) ? r.desiredBoardId : null;
		let desiredBoardName: string | null = null;
		let desiredBoardEmoji: string | null = null;
		if (desiredBoardId) {
			const board = db.select({ name: boards.name, emoji: boards.emoji }).from(boards).where(eq(boards.id, desiredBoardId)).get();
			if (board) {
				desiredBoardName = board.name;
				desiredBoardEmoji = board.emoji || '📋';
			}
		}

		// The requester's address as their mail goes to it: the account's email
		// as it is now, for a request made signed in (card 2171).
		const requesterEmail = requesterAddress(r);

		return { ...publicRequest(r), requesterEmail, targetName, targetEmoji, resolvedBoardId, desiredBoardId, desiredBoardName, desiredBoardEmoji };
	});

	return json(enriched);
};

/** Refuse with 429 once `key` has been used more than `max` times in the window. */
function limit(key: string, max: number, windowMs: number): void {
	const { limited, retryAfterSecs } = checkRateLimit(key, max, windowMs);
	if (limited) {
		throw error(429, `Too many requests. Try again in ${Math.ceil(retryAfterSecs / 60)} minute(s).`);
	}
}

const MINUTE = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST — Create a new task request. Works signed in or not.
 *
 * Signed in, the request goes straight to the team: we know who is asking.
 *
 * Not signed in, anyone on the internet is asking, and every request used to
 * email the whole team at once. So:
 *
 * - the caller must hold a token issued with the form, so this cannot be
 *   called cold by a script;
 * - submissions are limited per address, per email given, and in total;
 * - the request is held as 'unverified' and the only email sent is one to the
 *   requester, asking them to confirm. The team hears nothing until they do.
 *
 * With no SMTP configured there is no email to protect the team from and no way
 * to ask for confirmation, so the request is accepted as 'pending' — the rate
 * limits are then the only brake.
 */
export const POST: RequestHandler = async ({ request, locals, url, getClientAddress }) => {
	const anonymous = !locals.user;

	if (anonymous) {
		if (!verifyFormToken(request.headers.get('x-form-token'))) {
			throw error(403, 'This form has expired. Reload the page and try again.');
		}
		// Guarded: an address that cannot be read is counted as 'unknown'.
		limit(`request:${addressToCount({ getClientAddress })}`, 5, 15 * MINUTE);
		// However many addresses they come from, the team's inbox is one place.
		limit('request:anonymous-total', 30, 60 * MINUTE);
	}

	// Each field by its rule (card 2117), in the words the form shows. A field
	// that was not text was a 500, and a priority it did not know was medium.
	const body = await readBody(request);
	const title = readText(body, 'title', {
		required: true,
		trim: true,
		min: 1,
		max: 500,
		says: { missing: 'Title is required', empty: 'Title is required', invalid: 'Title too long (max 500 chars)' }
	});
	const targetType =
		readChoice(body, 'targetType', { nullable: true, from: ['user', 'team'], says: { type: 'Invalid target type', invalid: 'Invalid target type' } }) ??
		error(400, 'Target is required');
	const targetId = readId(body, 'targetId', { nullable: true }) ?? error(400, 'Target is required');
	// The board the card is wanted on, which nothing needs: whoever accepts the
	// request picks the board (card 2128, decision 6). From a caller with no
	// session it is not read at all, so that the form cannot be used to find
	// which boards there are; signed in, it is optional, and one they can open.
	const desiredBoardId = locals.user ? (readId(body, 'desiredBoardId', { nullable: true }) ?? null) : null;
	const description = readText(body, 'description', { max: 10000, says: { invalid: 'Description too long (max 10000 chars)' } }) ?? '';
	const businessValue = readText(body, 'businessValue', { max: 5000, says: { invalid: 'Business value too long (max 5000 chars)' } }) ?? '';
	const safePriority = readChoice(body, 'priority', { from: PRIORITIES, anyCase: true }) ?? 'medium';
	const requesterName = readText(body, 'requesterName', { trim: true, max: 200 });

	// One transaction: who the request is for, the board and the mail settings
	// are read in the one that clears the old unconfirmed requests and creates
	// this one. The mail is worked out in here and sent once it is committed.
	const answer = inTransaction(() => {
		// Validate target exists
		if (targetType === 'team') {
			const team = db.select({ id: teams.id }).from(teams).where(eq(teams.id, targetId)).get();
			if (!team) throw error(404, 'Team not found');
		} else {
			const user = db.select({ id: users.id }).from(users).where(eq(users.id, targetId)).get();
			if (!user) throw error(404, 'User not found');
		}

		// A board the caller names is one they can open: 404 for none, 403 for one
		// they cannot. Any board was taken, and named to whoever the request is for.
		if (desiredBoardId !== null) requireBoard(locals.user, desiredBoardId, 'view');

		const name = locals.user ? locals.user.username : (requesterName || 'Anonymous');

		// Without an account the address is how we reach the requester, and how they
		// prove the request is theirs.
		const mustVerify = anonymous && isSmtpConfigured();

		// The address a mailed link begins with is this server's configuration
		// and never what the request says: see linkBaseUrl. A request that has
		// to be confirmed is nothing without its link, so with no address to
		// make one from it is refused here, before anything is cleared or saved.
		const baseUrl = linkBaseUrl(url);
		const confirmFrom = mustVerify ? baseUrl : null;
		if (mustVerify && confirmFrom === null) {
			throw error(503, NO_LINK_ADDRESS);
		}

		// Read once who it is for and where it goes have been looked up. A
		// signed-in caller's own address is the one used, and theirs is not read.
		let email: string | null = locals.user ? locals.user.email : null;
		if (anonymous) {
			// An address by the readers' rule (none of `, ; < > " ( )`, which
			// the mailer reads as more than one), with a dot after the @.
			email = readEmail(body, 'requesterEmail', { required: true, says: 'A valid email address is required' });
			if (!EMAIL_PATTERN.test(email)) {
				throw error(400, 'A valid email address is required');
			}
			// One address cannot be used to send itself a stream of confirmation emails.
			// Counted whether or not what follows is saved: it is the attempt that is limited.
			limit(`request-email:${email.toLowerCase()}`, 3, 60 * MINUTE);

			// Requests nobody confirmed are dead weight; clear the old ones as we go.
			const cutoff = stamp(new Date(Date.now() - UNVERIFIED_LIFETIME_DAYS * 24 * 60 * MINUTE));
			db.delete(taskRequests)
				.where(and(eq(taskRequests.status, 'unverified'), lt(taskRequests.createdAt, cutoff)))
				.run();
		}

		const created = db.insert(taskRequests).values({
			targetType,
			targetId,
			desiredBoardId,
			title,
			description,
			priority: safePriority,
			businessValue,
			requesterName: name,
			requesterEmail: email,
			requesterUserId: locals.user?.id || null,
			status: mustVerify ? 'unverified' : 'pending',
			accessToken: newRequestToken()
		}).returning().get();

		if (confirmFrom !== null) {
			notifyRequesterConfirm(email!, created.title, requestConfirmUrl(confirmFrom, created));
		} else {
			notifyTaskRequest(targetType, targetId, created.title, name, safePriority, baseUrl);
		}

		// Never the row itself: it carries the token, which only ever travels in
		// the email link.
		return { ...publicRequest(created), verificationRequired: mustVerify };
	});

	return json(answer, { status: 201 });
};
