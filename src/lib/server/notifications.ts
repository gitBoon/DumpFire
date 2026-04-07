/**
 * notifications.ts — Email notification service for DumpFire.
 *
 * Sends emails for card events (creation, moves, assignment).
 * All functions silently no-op if SMTP is not configured.
 * Notifications are fire-and-forget — they never block API responses.
 */

import { sendEmail, isSmtpConfigured } from './email';
import { db } from './db';
import { users, cards, cardAssignees, boards, teamMembers, boardMembers, boardTeams } from './db/schema';
import { eq, inArray } from 'drizzle-orm';

/** Get email addresses for all assignees of a card. */
function getAssigneeEmails(cardId: number): { email: string; username: string }[] {
	const assignees = db.select({ userId: cardAssignees.userId })
		.from(cardAssignees)
		.where(eq(cardAssignees.cardId, cardId))
		.all();

	if (assignees.length === 0) return [];

	const userIds = assignees.map(a => a.userId);
	return db.select({ email: users.email, username: users.username })
		.from(users)
		.where(inArray(users.id, userIds))
		.all();
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

/** Notify assignees when a card is created. */
export function notifyCardCreated(boardId: number, cardId: number, cardTitle: string, creatorName: string, baseUrl: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const assignees = getAssigneeEmails(cardId);
	if (assignees.length === 0) return;

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const details = getCardDetails(cardId);
	const descBlock = details.description ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Description:</strong> ${details.description.length > 200 ? details.description.slice(0, 200) + '…' : details.description}</p>` : '';
	const bvBlock = details.businessValue ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Business Value:</strong> ${details.businessValue.length > 200 ? details.businessValue.slice(0, 200) + '…' : details.businessValue}</p>` : '';

	const html = emailTemplate('New Card Created', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0 0 8px; font-size: 13px; color: #475569;">
				Created by <strong>${creatorName}</strong> in <strong>${boardName}</strong>
			</p>
			${descBlock}
			${bvBlock}
			<div style="margin-top: 16px;"><a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a></div>
		</div>
	`);

	for (const a of assignees) {
		sendEmail(a.email, `New card: ${cardTitle}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
	}
}

/** Notify assignees when a card is moved between columns. */
export function notifyCardMoved(boardId: number, cardId: number, cardTitle: string, moverName: string, fromColumn: string, toColumn: string, baseUrl: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const assignees = getAssigneeEmails(cardId);
	if (assignees.length === 0) return;

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const html = emailTemplate('Card Moved', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #f59e0b;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${moverName}</strong> moved this card from <strong>${fromColumn}</strong> → <strong>${toColumn}</strong>
			</p>
			<p style="margin: 4px 0 16px; font-size: 12px; color: #64748b;">Board: ${boardName}</p>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	for (const a of assignees) {
		sendEmail(a.email, `Card moved: ${cardTitle} → ${toColumn}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
	}
}

/** Notify a user when they are assigned to a card. */
export function notifyUserAssigned(boardId: number, cardId: number, cardTitle: string, assigneeEmail: string, assigneeName: string, assignerName: string, baseUrl: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const details = getCardDetails(cardId);
	const descBlock = details.description ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Description:</strong> ${details.description.length > 200 ? details.description.slice(0, 200) + '…' : details.description}</p>` : '';
	const bvBlock = details.businessValue ? `<p style="margin: 8px 0; font-size: 13px; color: #334155; line-height: 1.5;"><strong>Business Value:</strong> ${details.businessValue.length > 200 ? details.businessValue.slice(0, 200) + '…' : details.businessValue}</p>` : '';

	const html = emailTemplate('You\'ve Been Assigned', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0 0 8px; font-size: 13px; color: #475569;">
				<strong>${assignerName}</strong> assigned you to this card in <strong>${boardName}</strong>
			</p>
			${descBlock}
			${bvBlock}
			<div style="margin-top: 16px;"><a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a></div>
		</div>
	`);

	sendEmail(assigneeEmail, `Assigned: ${cardTitle}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
}

/** Send an invite email to a new user with a password-set link. */
export function sendInviteEmail(email: string, username: string, inviteToken: string, baseUrl: string) {
	if (!isSmtpConfigured()) return;

	const inviteUrl = `${baseUrl}/invite/${inviteToken}`;
	const html = emailTemplate('Welcome to DumpFire!', `
		<p style="color: #334155; line-height: 1.6;">
			Hi <strong style="color: #0f172a;">${username}</strong>, you've been invited to join DumpFire — a blazingly fast Kanban board.
		</p>
		<div style="text-align: center; margin: 24px 0;">
			<a href="${inviteUrl}" style="display: inline-block; padding: 12px 32px; background: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
				Set Your Password
			</a>
		</div>
		<p style="color: #64748b; font-size: 12px; text-align: center;">
			This link expires in 7 days. If you didn't expect this invitation, you can ignore this email.
		</p>
	`);

	console.log('[INVITE] Sending invite email to', email, 'with URL', inviteUrl);
	sendEmail(email, 'You\'re invited to DumpFire!', html)
		.then(sent => console.log('[INVITE] Email sent:', sent))
		.catch(err => console.error('[INVITE] Failed to send:', err));
}

/** Notify a user when they are added to a board. */
export function notifyBoardShared(boardId: number, boardName: string, userEmail: string, userName: string, sharerName: string, role: string, baseUrl: string) {
	if (!isSmtpConfigured()) return;

	const boardUrl = `${baseUrl}/board/${boardId}`;

	const html = emailTemplate('Board Shared With You', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${boardName}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				<strong>${sharerName}</strong> shared this board with you as <strong style="text-transform: capitalize;">${role}</strong>
			</p>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Board</a>
		</div>
	`);

	sendEmail(userEmail, `Board shared: ${boardName}`, html).catch(err => console.error('[EMAIL] Board share notify failed:', err));
}

/** Notify the target user(s) when a new task request is submitted. */
export function notifyTaskRequest(targetType: string, targetId: number, title: string, requesterName: string, priority: string, baseUrl: string) {
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

	if (recipients.length === 0) return;

	const inboxUrl = `${baseUrl}/inbox`;

	const priorityColors: Record<string, string> = {
		critical: '#ef4444', high: '#f97316', medium: '#eab308', low: '#22c55e'
	};
	const borderColor = priorityColors[priority] || '#6366f1';

	const html = emailTemplate('New Task Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid ${borderColor};">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${title}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				From <strong>${requesterName}</strong> · Priority: <strong style="text-transform: capitalize;">${priority}</strong>
			</p>
			<p style="margin: 8px 0 16px; font-size: 12px; color: #64748b;">Review this request in your inbox to accept or reject it.</p>
			<a href="${inboxUrl}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Inbox</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `New request: ${title}`, html).catch(err => console.error('[EMAIL] Request notify failed:', err));
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
export function notifyCommentAdded(boardId: number, cardId: number, cardTitle: string, commenterName: string, commentPreview: string, commenterId: number, baseUrl: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const recipients = getBoardMemberEmails(boardId, commenterId);
	if (recipients.length === 0) return;

	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;
	const preview = commentPreview.length > 120 ? commentPreview.slice(0, 120) + '…' : commentPreview;

	const html = emailTemplate('New Comment', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #06b6d4;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${commenterName}</strong> commented in <strong>${boardName}</strong>
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #06b6d4; color: #334155; font-size: 13px; border-radius: 4px;">
				${preview}
			</blockquote>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #06b6d4; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `New comment on: ${cardTitle}`, html).catch(err => console.error('[EMAIL] Comment notify failed:', err));
	}
}

// ─── Request Conversation Notifications ──────────────────────────────────────

/** Notify the requester when their request is accepted. */
export function notifyRequesterAccepted(email: string, requestTitle: string, resolverName: string) {
	if (!isSmtpConfigured() || !email) return;

	const html = emailTemplate('Request Accepted ✅', `
		<div style="background: #f0fdf4; padding: 16px; border-radius: 8px; border-left: 4px solid #22c55e;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${requestTitle}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				Great news! <strong>${resolverName}</strong> has accepted your request and created a task for it.
			</p>
		</div>
	`);

	sendEmail(email, `Request accepted: ${requestTitle}`, html).catch(err => console.error('[EMAIL] Accept notify failed:', err));
}

/** Notify the requester when their request is rejected. */
export function notifyRequesterRejected(email: string, requestTitle: string, resolverName: string, reason?: string) {
	if (!isSmtpConfigured() || !email) return;

	const reasonBlock = reason
		? `<blockquote style="margin: 12px 0 0; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #ef4444; color: #334155; font-size: 13px; border-radius: 4px;">${reason}</blockquote>`
		: '';

	const html = emailTemplate('Request Declined', `
		<div style="background: #fef2f2; padding: 16px; border-radius: 8px; border-left: 4px solid #ef4444;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${requestTitle}</p>
			<p style="margin: 0; font-size: 13px; color: #475569;">
				<strong>${resolverName}</strong> has declined this request.
			</p>
			${reasonBlock}
		</div>
	`);

	sendEmail(email, `Request declined: ${requestTitle}`, html).catch(err => console.error('[EMAIL] Reject notify failed:', err));
}

/** Notify the requester when an admin sends a conversation message. */
export function notifyRequesterMessage(email: string, requestTitle: string, senderName: string, message: string, requestId: number, baseUrl: string) {
	if (!isSmtpConfigured() || !email) return;

	const replyUrl = `${baseUrl}/request/${requestId}/reply?email=${encodeURIComponent(email)}`;
	const preview = message.length > 300 ? message.slice(0, 300) + '…' : message;

	const html = emailTemplate('New Message on Your Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${requestTitle}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${senderName}</strong> sent you a message:
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #6366f1; color: #334155; font-size: 13px; border-radius: 4px;">
				${preview}
			</blockquote>
			<a href="${replyUrl}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View & Reply</a>
		</div>
	`);

	sendEmail(email, `Message on request: ${requestTitle}`, html).catch(err => console.error('[EMAIL] Message notify failed:', err));
}

/** Notify admin/team when the requester replies. */
export function notifyAdminMessage(targetType: string, targetId: number, requestTitle: string, requesterName: string, message: string, baseUrl: string) {
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

	if (recipients.length === 0) return;

	const inboxUrl = `${baseUrl}/inbox`;
	const preview = message.length > 300 ? message.slice(0, 300) + '…' : message;

	const html = emailTemplate('Reply on Task Request', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #f59e0b;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${requestTitle}</p>
			<p style="margin: 0 0 4px; font-size: 13px; color: #475569;">
				<strong>${requesterName}</strong> replied:
			</p>
			<blockquote style="margin: 12px 0 16px; padding: 8px 12px; background: #f1f5f9; border-left: 3px solid #f59e0b; color: #334155; font-size: 13px; border-radius: 4px;">
				${preview}
			</blockquote>
			<a href="${inboxUrl}" style="display: inline-block; padding: 8px 16px; background: #f59e0b; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Inbox</a>
		</div>
	`);

	for (const r of recipients) {
		sendEmail(r.email, `Reply on request: ${requestTitle}`, html).catch(err => console.error('[EMAIL] Admin msg notify failed:', err));
	}
}

