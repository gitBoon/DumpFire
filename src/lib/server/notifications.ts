/**
 * notifications.ts — Email notification service for DumpFire.
 *
 * Sends emails for card events (moves, assignment, comments, mentions,
 * unblocked work), shared boards, invites, task requests and new plans.
 * There is no mail for a new card. Whoever is put on one is mailed "Assigned":
 * accepting a task request with an assignee makes the card and assigns it,
 * and a page that makes a card with assignees adds each after it. The "Card
 * created" mail would have told them twice; nothing called it, and it was
 * removed (card 2010).
 * All functions silently no-op if SMTP is not configured.
 * Notifications are fire-and-forget — they never block API responses. The
 * invite is the one exception: its route awaits it after its commit, and
 * says whether it went (card 2196).
 *
 * Every text put into a mail's HTML here goes through `escapeHtml` where it is
 * put, each link in an `href` included (the rule is in `$lib/escape-html`).
 * Left bare: numbers, the colours taken from a table in the same function,
 * and a block built in the same function from values already escaped
 * (`descBlock`, `chainBlock`, `detailHtml`). Subjects are plain text and are
 * not escaped.
 */

import { escapeHtml } from '$lib/escape-html';
import { MASTER_PREF, type NotificationPref } from '$lib/notification-prefs';
import { MAIL_PROBLEM_WORDS, sendEmailWithAttachment, isSmtpConfigured, trySendEmail, type MailOutcome } from './email';
import { db } from './db';
import { afterCommit } from './db/transaction';
import { users, cards, cardAssignees, boards, teamMembers, boardMembers, boardTeams, taskRequests } from './db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { createLogger } from './logger';
import { requestReplyUrl } from './request-tokens';
import { requesterAddress } from './request-access';
import { canViewBoard, type Actor } from './board-access';
import { WITHHELD_CARD_TITLE, WITHHELD_SUBTASK_TITLE } from './withheld';

const log = createLogger('NOTIFY');

/**
 * Send an email once the write it follows from is committed, and resolve with
 * whether it went (`trySendEmail` in `email.ts`, card 2196).
 *
 * Every mail in this file tells somebody about a write. Called inside a
 * transaction, the send waits for the commit and never happens if the
 * transaction rolls back, in which case the promise returned here is never
 * settled. Outside a transaction it is sent at once, as `sendEmail` in
 * `email.ts` does. Callers that await a result (the SMTP test, the scheduled
 * reports) use that one directly and are not inside a transaction; the
 * invite routes await `sendInviteEmail` after theirs.
 *
 * A mail that fails resolves `sent: false` and is logged, once, by
 * `email.ts`. The `.catch` beside each send below is for an error before the
 * send, never for a mail that failed.
 */
function sendEmail(to: string, subject: string, html: string): Promise<MailOutcome> {
	return new Promise((resolve, reject) => {
		afterCommit(() => trySendEmail(to, subject, html).then(resolve, reject));
	});
}

/**
 * True when there is no address to make a mail's link from, with one WARN
 * line that says which mail was not sent for the want of it.
 *
 * `baseUrl` is what `linkBaseUrl` in `email.ts` gave: the App URL, or failing
 * that the address the server was started with, and never anything a request
 * said. It is null on a built server that was given neither. A mail whose
 * link goes nowhere is worse than no mail, so the notification is skipped.
 * Nothing is thrown: this is called from the write the mail is about, and
 * that write has succeeded.
 *
 * Every function here asks it last, once it is known that there is somebody
 * to tell, so that a server with no address logs a line for a mail it would
 * have sent and for nothing else.
 */
function noLinkAddress(baseUrl: string | null, what: string): baseUrl is null {
	if (baseUrl !== null) return false;
	log.warn(
		`${what} was not sent: this server has no address to make its link from. ` +
			'Set the App URL on the admin page, or start the server with ORIGIN set to its public address.'
	);
	return true;
}

// ─── Notification Preferences ────────────────────────────────────────────────

type NotifPrefs = Record<string, boolean>;

/**
 * Get a user's notification preferences (defaults to all enabled).
 *
 * Preferences that cannot be read, because the stored text is not JSON or is
 * not a JSON object, are the defaults, and a WARN line names the user. This is
 * called inside the transaction of whoever made the change being mailed about,
 * and an error thrown here used to fail that person's write: a comment could
 * not be saved on a board one of whose members had a `notification_prefs`
 * that would not parse.
 *
 * The account's own route (`api/account/notifications`) reads them through
 * here too, so a user whose stored preferences are unreadable is shown the
 * defaults and can save over them.
 */
export function getUserNotifPrefs(userId: number): NotifPrefs {
	const user = db.select({ notificationPrefs: users.notificationPrefs })
		.from(users).where(eq(users.id, userId)).get();
	if (!user?.notificationPrefs) return {};
	try {
		const stored: unknown = JSON.parse(user.notificationPrefs);
		if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) return stored as NotifPrefs;
	} catch {
		// Not JSON. Reported below, with what is JSON and not an object.
	}
	log.warn(
		`The notification preferences of user ${userId} could not be read, so the defaults were used: ` +
			'notification_prefs is not a JSON object'
	);
	return {};
}

/**
 * Check if a user should receive a specific notification type.
 * Returns false if the user has disabled that type or disabled all emails.
 *
 * `type` is a key of the one list in `$lib/notification-prefs`, which the
 * account page draws and its route saves (card 2146): a mail cannot read a
 * preference that nobody can set.
 */
function shouldNotifyUser(userId: number, type: NotificationPref): boolean {
	const prefs = getUserNotifPrefs(userId);
	// Master toggle
	if (prefs[MASTER_PREF] === false) return false;
	// Per-type toggle
	if (prefs[type] === false) return false;
	return true;
}

/** Get user ID from email address (for preference checking). */
function getUserIdByEmail(email: string): number | null {
	const user = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
	return user?.id ?? null;
}

/**
 * Filter recipients by notification preferences.
 * Returns only recipients who have the given notification type enabled.
 */
function filterRecipientsByPref<R extends { email: string; username: string }>(recipients: R[], type: NotificationPref): R[] {
	return recipients.filter(r => {
		const userId = getUserIdByEmail(r.email);
		if (!userId) return true; // External email — always send
		return shouldNotifyUser(userId, type);
	});
}

/**
 * The recipients, among these, who can open the board.
 *
 * The rule for every mail about a board's cards that goes to people somebody
 * else chose, such as a card's assignees: only those who can open the board
 * are mailed (card 2180). An assignee stays assigned when they are taken off
 * the board, or out of the team it is shared with, or when the card moves to
 * a board they cannot open, and the mail would tell them the card's title,
 * the board's name and who did what. The board's owner, a member of any role,
 * a member of a team it is shared with, anyone for a public board, and an
 * administrator can open it, as `canViewBoard` has it. Preferences decide
 * after this.
 */
function whoCanOpen<R extends Actor>(recipients: R[], boardId: number): R[] {
	return recipients.filter(r => canViewBoard(r, boardId));
}

/** An assignee as the card mails read them. */
type Assignee = {
	id: number;
	email: string;
	username: string;
	/** The account's role (`users.role`), not a role on the board. */
	role: string;
};

/**
 * The assignees of a card who can open `boardId`, the board the mail is
 * about, but `excludeUserId` if given.
 *
 * Taking someone off a board leaves them assigned to its cards, so the
 * assignees are asked here, when the mail is sent, and not when they were
 * assigned (`whoCanOpen`).
 */
function getAssigneeEmails(cardId: number, boardId: number, excludeUserId?: number): Assignee[] {
	const assignees = db.select({ userId: cardAssignees.userId })
		.from(cardAssignees)
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	const userIds = assignees.map(a => a.userId).filter(id => id !== excludeUserId);
	if (userIds.length === 0) return [];

	const rows = db.select({ id: users.id, email: users.email, username: users.username, role: users.role })
		.from(users)
		.where(inArray(users.id, userIds))
		.all();
	return whoCanOpen(rows, boardId);
}

/** Get board name for email context. */
function getBoardName(boardId: number): string {
	const board = db.select({ name: boards.name }).from(boards).where(eq(boards.id, boardId)).get();
	return board?.name || 'Unknown Board';
}

/** Get card description and business value for email content. */
function getCardDetails(cardId: number): { description: string; businessValue: string } {
	const card = db.select({ description: cards.description, businessValue: cards.businessValue })
		.from(cards).where(eq(cards.id, cardId)).get();
	return { description: card?.description || '', businessValue: card?.businessValue || '' };
}

/** Wrap content in a styled email template. */
function emailTemplate(title: string, content: string): string {
	return `
	<table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 40px 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;">
		<tr>
			<td align="center">
				<table width="100%" cellpadding="0" cellspacing="0" style="max-width: 520px; background-color: #ffffff; border-radius: 12px; border: 1px solid #cbd5e1; width: 100%; text-align: left;">
					<tr>
						<td style="padding: 32px;">
							<div style="text-align: center; margin-bottom: 24px;">
								<h2 style="margin: 0; color: #4338ca; font-size: 1.3rem; font-weight: 600;">${title}</h2>
							</div>
							${content}
							<hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
							<p style="color: #94a3b8; font-size: 11px; text-align: center; margin: 0;">Sent from DumpFire</p>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	</table>
	`;
}

// ─── Notification Functions ──────────────────────────────────────────────────

/**
 * Notify assignees when a card is moved between columns.
 *
 * The mover is left out, as the commenter is left out of the comment mail: an
 * assignee who moves their own card is not told that they moved it (card
 * 2134, R4). Turning "card moved" mail off to stop that would also stop the
 * "Unblocked" mail, which reads the same preference.
 *
 * `boardId` is the board the card is on now, which the mail names: only the
 * assignees who can open it are mailed (card 2180).
 */
export function notifyCardMoved(boardId: number, cardId: number, cardTitle: string, moverName: string, fromColumn: string, toColumn: string, moverId: number, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const allAssignees = getAssigneeEmails(cardId, boardId, moverId);
	const assignees = filterRecipientsByPref(allAssignees, 'email_moved');
	if (assignees.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a card that was moved')) return;

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const html = emailTemplate('Card Moved', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #f59e0b;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(cardTitle)}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(moverName)}</strong> moved this card from <strong>${escapeHtml(fromColumn)}</strong> → <strong>${escapeHtml(toColumn)}</strong>
			</p>
			<p style="margin: 4px 0 16px; font-size: 12px; color: #64748b;">Board: ${escapeHtml(boardName)}</p>
			<a href="${escapeHtml(boardUrl)}" style="display: inline-block; padding: 8px 16px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	for (const a of assignees) {
		sendEmail(a.email, `Card moved: ${cardTitle} → ${toColumn}`, html).catch(err => log.error(`Card-moved notification failed for ${a.email}`, err));
	}
}

/** Notify a user when they are assigned to a card. */
export function notifyUserAssigned(boardId: number, cardId: number, cardTitle: string, assigneeEmail: string, assigneeName: string, assignerName: string, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;

	// Check assignee's notification preferences
	const userId = getUserIdByEmail(assigneeEmail);
	if (userId && !shouldNotifyUser(userId, 'email_assigned')) return;
	if (noLinkAddress(baseUrl, 'The mail about a card that was assigned')) return;

	const boardName = getBoardName(boardId);

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const details = getCardDetails(cardId);
	const descBlock = details.description ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Description:</strong> ${escapeHtml(details.description.length > 200 ? details.description.slice(0, 200) + '…' : details.description)}</p>` : '';
	const bvBlock = details.businessValue ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Business Value:</strong> ${escapeHtml(details.businessValue.length > 200 ? details.businessValue.slice(0, 200) + '…' : details.businessValue)}</p>` : '';

	const html = emailTemplate('You\'ve Been Assigned', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(cardTitle)}</p>
			<p style="margin: 0 0 8px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(assignerName)}</strong> assigned you to this card in <strong>${escapeHtml(boardName)}</strong>
			</p>
			${descBlock}
			${bvBlock}
			<div style="margin-top: 16px;"><a href="${escapeHtml(boardUrl)}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a></div>
		</div>
	`);

	sendEmail(assigneeEmail, `Assigned: ${cardTitle}`, html).catch(err => log.error(`Assignment notification failed for ${assigneeEmail}`, err));
}

/**
 * Send an invite email to a new user with a password-set link, and say
 * whether it went (card 2196): `not-configured` when no mail host is set by
 * the time it is sent.
 *
 * Called by both routes that issue an invite once the transaction that
 * issued it has committed, and awaited, so that the route can say whether the
 * mail went and, when it did not, hand the link to the administrator who
 * issued it. Called inside a transaction, it would wait for the commit.
 */
export function sendInviteEmail(email: string, username: string, inviteToken: string, baseUrl: string): Promise<MailOutcome> {
	if (!isSmtpConfigured()) {
		return Promise.resolve({ sent: false, problem: 'not-configured', detail: MAIL_PROBLEM_WORDS['not-configured'] });
	}

	const inviteUrl = `${baseUrl}/invite/${inviteToken}`;
	const html = emailTemplate('Welcome to DumpFire!', `
		<p style="color: #334155; line-height: 1.6;">
			Hi <strong style="color: #0f172a;">${escapeHtml(username)}</strong>, you've been invited to join DumpFire — a blazingly fast Kanban board.
		</p>
		<div style="text-align: center; margin: 24px 0;">
			<a href="${escapeHtml(inviteUrl)}" style="display: inline-block; padding: 12px 32px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
				Set Your Password
			</a>
		</div>
		<p style="color: #64748b; font-size: 12px; text-align: center;">
			This link expires in 7 days. If you didn't expect this invitation, you can ignore this email.
		</p>
	`);

	return sendEmail(email, 'You\'re invited to DumpFire!', html);
}

/** Notify a user when they are added to a board. */
export function notifyBoardShared(boardId: number, boardName: string, userEmail: string, userName: string, sharerName: string, role: string, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;

	// Check recipient's notification preferences
	const userId = getUserIdByEmail(userEmail);
	if (userId && !shouldNotifyUser(userId, 'email_board_shared')) return;
	if (noLinkAddress(baseUrl, 'The mail about a board that was shared')) return;

	const boardUrl = `${baseUrl}/board/${boardId}`;

	const html = emailTemplate('Board Shared With You', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(boardName)}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(sharerName)}</strong> shared this board with you as <strong style="text-transform: capitalize;">${escapeHtml(role)}</strong>
			</p>
			<a href="${escapeHtml(boardUrl)}" style="display: inline-block; padding: 8px 16px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Board</a>
		</div>
	`);

	sendEmail(userEmail, `Board shared: ${boardName}`, html).catch(err => log.error(`Board-share notification failed for ${userEmail}`, err));
}

/** Notify the target user(s) when a new task request is submitted. */
export function notifyTaskRequest(targetType: string, targetId: number, title: string, requesterName: string, priority: string, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;

	// Determine recipients
	let recipients: { email: string; username: string }[] = [];
	if (targetType === 'user') {
		const user = db.select({ email: users.email, username: users.username })
			.from(users).where(eq(users.id, targetId)).get();
		if (user) recipients = [user];
	} else {
		// Team — email all team members
		const members = db.select({ userId: teamMembers.userId })
			.from(teamMembers).where(eq(teamMembers.teamId, targetId)).all();
		if (members.length > 0) {
			recipients = db.select({ email: users.email, username: users.username })
				.from(users).where(inArray(users.id, members.map((m: any) => m.userId))).all();
		}
	}

	recipients = filterRecipientsByPref(recipients, 'email_requests');
	if (recipients.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a new request')) return;

	const inboxUrl = `${baseUrl}/inbox`;

	const priorityColors: Record<string, string> = {
		critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e'
	};
	const borderColor = priorityColors[priority] || '#6366f1';

	const html = emailTemplate('New Task Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid ${borderColor};">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(title)}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				From <strong>${escapeHtml(requesterName)}</strong> · Priority: <strong style="text-transform: capitalize;">${escapeHtml(priority)}</strong>
			</p>
			<p style="margin: 8px 0 16px; font-size: 12px; color: #64748b;">Review this request in your inbox to accept or reject it.</p>
			<a href="${escapeHtml(inboxUrl)}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Inbox</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `New request: ${title}`, html).catch(err => log.error(`Task-request notification failed for ${r.email}`, err));
	}
}

/** Get emails of all users who have access to a board (for comment notifications). */
function getBoardMemberEmails(boardId: number, excludeUserId?: number): { email: string; username: string }[] {
	const userIds = new Set<number>();

	// Board creator
	const board = db.select({ createdBy: boards.createdBy }).from(boards).where(eq(boards.id, boardId)).get();
	if (board?.createdBy) userIds.add(board.createdBy);

	// Direct members
	const directMembers = db.select({ userId: boardMembers.userId }).from(boardMembers).where(eq(boardMembers.boardId, boardId)).all();
	directMembers.forEach(m => userIds.add(m.userId));

	// Team members
	const sharedTeams = db.select({ teamId: boardTeams.teamId }).from(boardTeams).where(eq(boardTeams.boardId, boardId)).all();
	if (sharedTeams.length > 0) {
		const teamUserRows = db.select({ userId: teamMembers.userId }).from(teamMembers)
			.where(inArray(teamMembers.teamId, sharedTeams.map(t => t.teamId))).all();
		teamUserRows.forEach(r => userIds.add(r.userId));
	}

	// Exclude the commenter
	if (excludeUserId) userIds.delete(excludeUserId);
	if (userIds.size === 0) return [];

	return db.select({ email: users.email, username: users.username })
		.from(users).where(inArray(users.id, Array.from(userIds))).all();
}

/** Notify all board members when a comment is posted on a task. */
export function notifyCommentAdded(boardId: number, cardId: number, cardTitle: string, commenterName: string, commentPreview: string, commenterId: number, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const allRecipients = getBoardMemberEmails(boardId, commenterId);
	const recipients = filterRecipientsByPref(allRecipients, 'email_comments');
	if (recipients.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a comment')) return;

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;
	const preview = commentPreview.length > 120 ? commentPreview.slice(0, 120) + '…' : commentPreview;

	const html = emailTemplate('New Comment', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #06b6d4;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(cardTitle)}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(commenterName)}</strong> commented in <strong>${escapeHtml(boardName)}</strong>
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #06b6d4; color: #334155; font-size: 13px; border-radius: 4px;">
				${escapeHtml(preview)}
			</blockquote>
			<a href="${escapeHtml(boardUrl)}" style="display: inline-block; padding: 8px 16px; background: #06b6d4; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `New comment on: ${cardTitle}`, html).catch(err => log.error(`Comment notification failed for ${r.email}`, err));
	}
}

// ─── Request Conversation Notifications ──────────────────────────────────────

/** Notify the requester when their request is accepted. */
export function notifyRequesterAccepted(email: string, requestTitle: string, resolverName: string) {
	if (!isSmtpConfigured() || !email) return;

	const html = emailTemplate('Request Accepted ✅', `
		<div style="background: #f0fdf4; padding: 16px; border-radius: 8px; border-left: 4px solid #22c55e;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				Great news! <strong>${escapeHtml(resolverName)}</strong> has accepted your request and created a task for it.
			</p>
		</div>
	`);

	sendEmail(email, `Request accepted: ${requestTitle}`, html).catch(err => log.error(`Accept notification failed for ${email}`, err));
}

/** Notify the requester when their request is rejected. */
export function notifyRequesterRejected(email: string, requestTitle: string, resolverName: string, reason?: string) {
	if (!isSmtpConfigured() || !email) return;

	const reasonBlock = reason
		? `<blockquote style="margin: 12px 0 0; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #ef4444; color: #334155; font-size: 13px; border-radius: 4px;">${escapeHtml(reason)}</blockquote>`
		: '';

	const html = emailTemplate('Request Declined', `
		<div style="background: #fef2f2; padding: 16px; border-radius: 8px; border-left: 4px solid #ef4444;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(resolverName)}</strong> has declined this request.
			</p>
			${reasonBlock}
		</div>
	`);

	sendEmail(email, `Request declined: ${requestTitle}`, html).catch(err => log.error(`Reject notification failed for ${email}`, err));
}

/** Notify the requester when an admin sends a conversation message. */
/**
 * Ask someone who has just submitted a request to confirm it is theirs.
 *
 * This is the only email an unconfirmed request sends. The team is told
 * nothing until the link in it is followed, so a form filled in with somebody
 * else's address reaches that one person and no further.
 */
export function notifyRequesterConfirm(email: string, requestTitle: string, confirmUrl: string) {
	if (!isSmtpConfigured() || !email) return;

	const html = emailTemplate('Confirm Your Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				Someone submitted this request using your email address. If it was you, confirm it and we will pass it to the team.
				If it was not, ignore this message and nothing further will happen.
			</p>
			<a href="${escapeHtml(confirmUrl)}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Confirm my request</a>
		</div>
	`);

	sendEmail(email, `Confirm your request: ${requestTitle}`, html).catch(err => log.error(`Request-confirmation email failed for ${email}`, err));
}

/**
 * @param replyUrl The requester's own link to the thread — build it with
 * `requestReplyUrl`. It carries the request's token; it used to carry their
 * email address, which anyone who knew the address could reproduce. Null
 * where the server has no address to build it from, and then nothing is sent.
 */
export function notifyRequesterMessage(email: string, requestTitle: string, senderName: string, message: string, replyUrl: string | null) {
	if (!isSmtpConfigured() || !email) return;
	if (noLinkAddress(replyUrl, 'The mail to a requester about a reply to their request')) return;

	const preview = message.length > 300 ? message.slice(0, 300) + '…' : message;

	const html = emailTemplate('New Message on Your Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(senderName)}</strong> sent you a message:
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #6366f1; color: #334155; font-size: 13px; border-radius: 4px;">
				${escapeHtml(preview)}
			</blockquote>
			<a href="${escapeHtml(replyUrl)}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View & Reply</a>
		</div>
	`);

	sendEmail(email, `Message on request: ${requestTitle}`, html).catch(err => log.error(`Requester-message notification failed for ${email}`, err));
}

/**
 * Mail a requester the current link to their request, which they asked for
 * from the page a link that no longer works opens (card 2158). Sent only to
 * the request's address, `requesterAddress(request)` (card 2171: the account's
 * email as it is now for a request made signed in), and only by
 * `POST /api/requests/[id]/link`, which has made sure the address given
 * matches it and counted the mail.
 *
 * @param link The confirmation link for a request not yet confirmed
 * (`requestConfirmUrl`), the thread's link otherwise (`requestReplyUrl`).
 * @param unconfirmed Which of the two it is: the button says so.
 */
export function notifyRequesterNewLink(email: string, requestTitle: string, link: string, unconfirmed: boolean) {
	if (!isSmtpConfigured() || !email) return;

	const html = emailTemplate('A New Link to Your Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				A new link to this request was asked for with your email address. Use the button below
				from now on. If you did not ask for it, you can ignore this message: the link was sent to you alone.
			</p>
			<a href="${escapeHtml(link)}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">${unconfirmed ? 'Confirm my request' : 'View the conversation'}</a>
		</div>
	`);

	sendEmail(email, `A new link to your request: ${requestTitle}`, html).catch((err) =>
		log.error(`New-link mail to the requester of "${requestTitle}" failed`, err)
	);
}

/** Notify admin/team when the requester replies. */
export function notifyAdminMessage(targetType: string, targetId: number, requestTitle: string, requesterName: string, message: string, baseUrl: string | null) {
	if (!isSmtpConfigured()) return;

	let recipients: { email: string; username: string }[] = [];
	if (targetType === 'user') {
		const user = db.select({ email: users.email, username: users.username })
			.from(users).where(eq(users.id, targetId)).get();
		if (user) recipients = [user];
	} else {
		const members = db.select({ userId: teamMembers.userId })
			.from(teamMembers).where(eq(teamMembers.teamId, targetId)).all();
		if (members.length > 0) {
			recipients = db.select({ email: users.email, username: users.username })
				.from(users).where(inArray(users.id, members.map((m: any) => m.userId))).all();
		}
	}

	recipients = filterRecipientsByPref(recipients, 'email_requests');
	if (recipients.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a reply from a requester')) return;

	const inboxUrl = `${baseUrl}/inbox`;
	const preview = message.length > 300 ? message.slice(0, 300) + '…' : message;

	const html = emailTemplate('Reply on Task Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #f59e0b;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(requesterName)}</strong> replied:
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #f59e0b; color: #334155; font-size: 13px; border-radius: 4px;">
				${escapeHtml(preview)}
			</blockquote>
			<a href="${escapeHtml(inboxUrl)}" style="display: inline-block; padding: 8px 16px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Inbox</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `Reply on request: ${requestTitle}`, html).catch(err => log.error(`Admin-message notification failed for ${r.email}`, err));
	}
}


// ─── Requester Progress Notifications ────────────────────────────────────────

type RequesterProgressAction = 'comment' | 'moved' | 'subtask_completed' | 'completed';

interface RequesterProgressEvent {
	/** The card that was acted upon. */
	cardId: number;
	/** What happened: comment, moved, subtask_completed, completed. */
	action: RequesterProgressAction;
	/** Human-readable summary e.g. "Subtask 'Write tests' completed" or "John commented: ..." */
	summary: string;
	/** Who performed the action. */
	actorName: string;
	/** Base URL for building links, or null if this server has none: see `linkBaseUrl`. */
	baseUrl: string | null;
	/** For 'moved' events — the column the card moved to. */
	toColumn?: string;
	/** For 'moved' events — the column the card moved from. */
	fromColumn?: string;
	/** The user ID of the actor (to skip self-notifications). */
	actorUserId?: number;
}

/**
 * Notify the original task requester about progress on their accepted request.
 *
 * Looks up the task_requests table for a request with resolvedCardId = cardId.
 * Sends a styled email with event-specific content, to `requesterAddress` as
 * it is when the row is read, after the commit: for a request made signed in,
 * the account's email as it is then (card 2171).
 * Automatically stops if the card already has completedAt set (unless this IS the completion event).
 * Skips if the actor is the requester themselves.
 *
 * Fire-and-forget, and nothing of it runs until the write it reports is
 * committed. The work is async (a completion builds a PDF first), so started
 * inside a transaction its later part would run whether or not that
 * transaction was rolled back. A failure is logged and reaches no caller.
 */
export function notifyRequesterProgress(event: RequesterProgressEvent): void {
	afterCommit(() => sendRequesterProgress(event));
}

async function sendRequesterProgress(event: RequesterProgressEvent): Promise<void> {
	if (!isSmtpConfigured()) return;

	const { cardId, action, summary, actorName, baseUrl, toColumn, fromColumn, actorUserId } = event;

	// Find the originating task request for this card
	const request = db.select({
		id: taskRequests.id,
		requesterEmail: taskRequests.requesterEmail,
		requesterUserId: taskRequests.requesterUserId,
		title: taskRequests.title,
		status: taskRequests.status,
		accessToken: taskRequests.accessToken
	})
	.from(taskRequests)
	.where(and(eq(taskRequests.resolvedCardId, cardId), eq(taskRequests.status, 'accepted')))
	.get();

	if (!request) return;
	// The requester's address as it is now: the account's email for a request
	// made signed in (card 2171). None, and nothing is sent.
	const address = requesterAddress(request);
	if (address === null) return;

	// Skip self-notifications — don't email the requester about their own actions
	if (actorUserId && request.requesterUserId && actorUserId === request.requesterUserId) return;

	// For non-completion events, check if the card is already completed — stop sending updates
	if (action !== 'completed') {
		const card = db.select({ completedAt: cards.completedAt }).from(cards).where(eq(cards.id, cardId)).get();
		if (card?.completedAt) return;
	}

	// Check notification preferences for internal users
	if (request.requesterUserId) {
		if (!shouldNotifyUser(request.requesterUserId, 'email_request_progress')) return;
	}

	// Its link is the requester's own way in to their request, so with no
	// address to make it from there is no mail. The move it reports is done.
	if (noLinkAddress(baseUrl, `The progress mail to the requester of request ${request.id}`)) return;

	// Build event-specific email content
	const requestTitle = request.title;
	const replyUrl = requestReplyUrl(baseUrl, request);

	const actionConfigs: Record<RequesterProgressAction, { subject: string; borderColor: string; heading: string; icon: string }> = {
		comment: {
			subject: `New comment on your request: ${requestTitle}`,
			borderColor: '#06b6d4',
			heading: 'Comment Added',
			icon: '💬'
		},
		moved: {
			subject: `Your request moved: ${requestTitle}${toColumn ? ` → ${toColumn}` : ''}`,
			borderColor: '#f59e0b',
			heading: 'Card Moved',
			icon: '📋'
		},
		subtask_completed: {
			subject: `Subtask completed on your request: ${requestTitle}`,
			borderColor: '#8b5cf6',
			heading: 'Subtask Completed',
			icon: '✅'
		},
		completed: {
			subject: `Your request is complete: ${requestTitle} ✅`,
			borderColor: '#22c55e',
			heading: 'Request Complete!',
			icon: '🎉'
		}
	};

	const config = actionConfigs[action];

	// Build the detail block based on action type
	let detailHtml = '';
	if (action === 'comment') {
		const preview = summary.length > 300 ? summary.slice(0, 300) + '…' : summary;
		detailHtml = `
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(actorName)}</strong> commented:
			</p>
			<blockquote style="margin: 12px 0 0; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid ${config.borderColor}; color: #334155; font-size: 13px; border-radius: 4px;">
				${escapeHtml(preview)}
			</blockquote>
		`;
	} else if (action === 'moved') {
		detailHtml = `
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(actorName)}</strong> moved this task from <strong>${escapeHtml(fromColumn || 'Unknown')}</strong> → <strong>${escapeHtml(toColumn || 'Unknown')}</strong>
			</p>
		`;
	} else if (action === 'subtask_completed') {
		detailHtml = `
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(actorName)}</strong> completed a subtask:
			</p>
			<p style="margin: 8px 0 0; font-size: 13px; color: #334155; font-weight: 500;">
				${escapeHtml(summary)}
			</p>
		`;
	} else if (action === 'completed') {
		detailHtml = `
			<p style="margin: 0; font-size: 13px; color: #475569;">
				Great news! <strong>${escapeHtml(actorName)}</strong> has completed the task for your request.
			</p>
			<p style="margin: 8px 0 0; font-size: 12px; color: #64748b;">
				No further progress updates will be sent for this request.
			</p>
		`;
	}

	const bgColor = action === 'completed' ? '#f0fdf4' : '#f8fafc';

	const html = emailTemplate(`${config.icon} ${config.heading}`, `
		<div style="background: ${bgColor}; padding: 16px; border-radius: 8px; border-left: 4px solid ${config.borderColor};">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(requestTitle)}</p>
			${detailHtml}
			<div style="margin-top: 16px;">
				<a href="${escapeHtml(replyUrl)}" style="display: inline-block; padding: 8px 16px; background: ${config.borderColor}; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Request</a>
			</div>
		</div>
	`);

	// For completion events, generate and attach a PDF report
	if (action === 'completed') {
		// Lazy-import to avoid circular dependency
		const { generateCardReport, generateReportPdf } = await import('./reports');
		try {
			const reportData = generateCardReport(cardId);
			if (reportData) {
				const pdfBuffer = await generateReportPdf(reportData);
				const safeTitle = requestTitle.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').slice(0, 60);
				const filename = `dumpfire-task-report-${safeTitle}-${new Date().toISOString().split('T')[0]}.pdf`;

				sendEmailWithAttachment(
					address,
					config.subject,
					html,
					{ filename, content: pdfBuffer, contentType: 'application/pdf' }
				).catch(err =>
					log.error(`Requester completion PDF email failed for ${address}`, err)
				);
				return;
			}
		} catch (err) {
			log.error(`Failed to generate completion PDF for card ${cardId}`, err);
			// Fall through to send without PDF
		}
	}

	sendEmail(address, config.subject, html).catch(err =>
		log.error(`Requester progress notification (${action}) failed for ${address}`, err)
	);
}

// ─── Dependency Notifications ───────────────────────────────────────────────

/** The work whose completion unblocked a card, as `recordUnblocked` found it. */
export type FinishedWork = {
	kind: 'card' | 'subtask';
	id: number;
	title: string;
	/** The board it is on: a subtask's is its card's. */
	boardId: number;
};

/**
 * Tell a card's assignees that the last thing blocking it just finished.
 *
 * This is the whole point of recording dependencies for a small team: nobody
 * has to poll the board to notice that their turn came round. Uses the
 * `email_moved` preference rather than a new toggle — being unblocked is a
 * column change on somebody else's card, and a user who muted moves does not
 * want this either. Only the assignees who can open the waiting card's board
 * (`boardId`) are mailed (card 2180).
 *
 * The finished work may be on another board. Each mail is one person's, so it
 * names the work by its title to an assignee who can open that board, and
 * otherwise in the words of a plan view, "A card on a board you cannot open"
 * or "A subtask on a board you cannot open" (card 2152, decision 7). A card
 * keeps its number either way; a subtask is named as a subtask, never by its
 * id, which is not a card's number.
 */
export function notifyCardUnblocked(
	boardId: number,
	cardId: number,
	cardTitle: string,
	completed: FinishedWork,
	completerName: string,
	baseUrl: string | null
): void {
	if (!isSmtpConfigured()) return;

	const assignees = filterRecipientsByPref(getAssigneeEmails(cardId, boardId), 'email_moved');
	if (assignees.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a card that is no longer blocked')) return;

	const boardName = getBoardName(boardId);
	const cardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	// At most two mails to build: with the finished work's title, and without.
	const htmlFor = (named: boolean) => {
		const title = named ? completed.title : completed.kind === 'card' ? WITHHELD_CARD_TITLE : WITHHELD_SUBTASK_TITLE;
		const work =
			completed.kind === 'card'
				? `#${completed.id} <strong>${escapeHtml(title)}</strong>`
				: named
					? `the subtask <strong>${escapeHtml(title)}</strong>`
					: `<strong>${escapeHtml(title)}</strong>`;
		return emailTemplate('Ready to start', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(cardTitle)}</p>
			<p style="margin: 0 0 8px; font-size: 13px; color: #475569;">
				Nothing is blocking this card any more — <strong>${escapeHtml(completerName)}</strong> completed
				${work}, which was the last one.
			</p>
			<p style="margin: 4px 0 16px; font-size: 12px; color: #64748b;">Board: ${escapeHtml(boardName)}</p>
			<a href="${escapeHtml(cardUrl)}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);
	};
	const built = new Map<boolean, string>();

	for (const a of assignees) {
		const named = canViewBoard(a, completed.boardId);
		if (!built.has(named)) built.set(named, htmlFor(named));
		sendEmail(a.email, `Unblocked: ${cardTitle}`, built.get(named)!).catch(err =>
			log.error(`Unblock notification failed for ${a.email}`, err)
		);
	}
}

// ─── Planning Notifications ─────────────────────────────────────────────────

export interface PlanCreatedNotice {
	milestoneId: number;
	name: string;
	/** Cards now in the plan, in the order the plan reports them. */
	cardCount: number;
	boards: string[];
	/** Ordered card ids on the critical path, empty when nothing is sequenced yet. */
	criticalPath: { id: number; title: string }[];
	startable: number;
	blocked: number;
}

/**
 * Tell people a plan has appeared.
 *
 * Agents can now create a milestone on their own when they spot that a set of
 * cards forms a goal with a real order. That is useful, but a plan that appears
 * silently is a plan nobody agreed to — this is the oversight on it.
 *
 * Recipients are the assignees of the cards in the plan, plus admins (a
 * cross-board goal has no single board owner to notify), minus whoever created
 * it — they already know. Respects an `email_planning` preference.
 *
 * Then each is asked of `noticeFor`, which gives the plan as that recipient
 * would see it on its page, or null when they cannot open it, and they are
 * not mailed (card 2152, decision 8). An assignee may be a former member of
 * the board, or unable to open every board of a goal that spans several, and
 * the mail holds the chain's titles and the boards' names. The caller works
 * the notice out, so that this module does not import the planning modules,
 * which import it.
 */
export function notifyPlanCreated(
	cardIds: number[],
	creatorName: string,
	creatorUserId: number,
	baseUrl: string | null,
	noticeFor: (recipient: Actor) => PlanCreatedNotice | null
): void {
	if (!isSmtpConfigured()) return;
	if (cardIds.length === 0) return;

	// Assignees of the cards in the plan.
	const assigneeIds = new Set<number>();
	for (let i = 0; i < cardIds.length; i += 500) {
		const chunk = cardIds.slice(i, i + 500);
		for (const r of db
			.select({ userId: cardAssignees.userId })
			.from(cardAssignees)
			.where(inArray(cardAssignees.cardId, chunk))
			.all()) {
			assigneeIds.add(r.userId);
		}
	}

	// Plus admins — a cross-board goal has no board owner, and somebody needs to
	// see that a plan was created even when its cards are unassigned.
	for (const a of db
		.select({ id: users.id })
		.from(users)
		.where(inArray(users.role, ['admin', 'superadmin']))
		.all()) {
		assigneeIds.add(a.id);
	}

	assigneeIds.delete(creatorUserId);
	if (assigneeIds.size === 0) return;

	const recipients = db
		.select({ id: users.id, email: users.email, username: users.username, role: users.role })
		.from(users)
		.where(inArray(users.id, [...assigneeIds]))
		.all();

	const toSend = filterRecipientsByPref(recipients, 'email_planning');
	if (toSend.length === 0) return;
	if (noLinkAddress(baseUrl, 'The mail about a new plan')) return;

	// One mail for each notice: recipients who see the plan alike are given
	// the same notice, and so the same mail.
	const built = new Map<PlanCreatedNotice, string>();
	for (const r of toSend) {
		const notice = noticeFor(r);
		if (!notice) continue;
		if (!built.has(notice)) built.set(notice, planCreatedHtml(notice, creatorName, baseUrl));
		sendEmail(r.email, `Plan created: ${notice.name}`, built.get(notice)!).catch((err) =>
			log.error(`Plan-created notification failed for ${r.email}`, err)
		);
	}
}

/** The "A plan was created" mail, for one notice. */
function planCreatedHtml(notice: PlanCreatedNotice, creatorName: string, baseUrl: string | null): string {
	const planUrl = `${baseUrl}/plan/${notice.milestoneId}`;
	const scope = notice.boards.length > 0 ? notice.boards.join(', ') : 'no boards yet';

	const chainBlock =
		notice.criticalPath.length > 0
			? `<p style="margin: 12px 0 6px; font-size: 13px; font-weight: 600; color: #0f172a;">The chain that cannot slip</p>
			   <ol style="margin: 0 0 8px; padding-left: 20px; font-size: 13px; color: #334155; line-height: 1.6;">
			     ${notice.criticalPath.map((c) => `<li>#${c.id} ${escapeHtml(c.title)}</li>`).join('')}
			   </ol>`
			: `<p style="margin: 12px 0 8px; font-size: 13px; color: #64748b;">
			     No ordering recorded yet — nothing in this goal is waiting on anything else.
			   </p>`;

	return emailTemplate('A plan was created', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(notice.name)}</p>
			<p style="margin: 0 0 8px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(creatorName)}</strong> grouped ${notice.cardCount} card${notice.cardCount === 1 ? '' : 's'}
				into a goal because they have an order that has to be respected.
			</p>
			<p style="margin: 0 0 4px; font-size: 12px; color: #64748b;">Covering: ${escapeHtml(scope)}</p>
			<p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">
				${notice.startable} can be started now &middot; ${notice.blocked} waiting
			</p>
			${chainBlock}
			<div style="margin-top: 16px;">
				<a href="${escapeHtml(planUrl)}" style="display: inline-block; padding: 8px 16px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View the plan</a>
			</div>
		</div>
	`);
}

// ─── @Mention Notifications ─────────────────────────────────────────────────

/**
 * Send an email notification to a user who was @mentioned in a comment.
 * Respects the user's email_mentions notification preference.
 *
 * Only to someone who can open the board (card 2198): anyone named, whoever
 * the author chose, was mailed the card's title, the board's name and the
 * comment. Nothing goes to anyone else, and the author is not told who was
 * not mailed, which would say whether an account of that name exists and
 * whether it can open the board.
 */
export function notifyMention(
	mentionedUser: { id: number; email: string; username: string; role: string },
	authorUsername: string,
	cardId: number,
	cardTitle: string,
	commentText: string,
	boardId: number,
	baseUrl: string | null
): void {
	if (!isSmtpConfigured()) return;
	if (whoCanOpen([mentionedUser], boardId).length === 0) return;
	if (!shouldNotifyUser(mentionedUser.id, 'email_mentions')) return;
	if (noLinkAddress(baseUrl, 'The mail about a mention')) return;

	const boardName = getBoardName(boardId);
	const preview = commentText.length > 300 ? commentText.slice(0, 300) + '…' : commentText;
	const cardUrl = `${baseUrl}/board/${boardId}`;

	const html = emailTemplate(`You were mentioned by ${escapeHtml(authorUsername)}`, `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${escapeHtml(cardTitle)}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${escapeHtml(authorUsername)}</strong> mentioned you in a comment on <strong>${escapeHtml(boardName)}</strong>:
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #8b5cf6; color: #334155; font-size: 13px; border-radius: 4px;">
				${escapeHtml(preview)}
			</blockquote>
			<a href="${escapeHtml(cardUrl)}" style="display: inline-block; padding: 8px 16px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Board</a>
		</div>
	`);

	sendEmail(mentionedUser.email, `${authorUsername} mentioned you: ${cardTitle}`, html).catch(err =>
		log.error(`Mention notification failed for ${mentionedUser.email}`, err)
	);
}
