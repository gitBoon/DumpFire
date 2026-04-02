/**
 * notifications.ts — Email notification service for DumpFire.
 *
 * Sends emails for card events (creation, moves, assignment).
 * All functions silently no-op if SMTP is not configured.
 * Notifications are fire-and-forget — they never block API responses.
 */

import { sendEmail, isSmtpConfigured, resolveBaseUrl } from './email';
import { db } from './db';
import { users, cardAssignees, boards, teamMembers } from './db/schema';
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
								<span style="font-size: 2.2rem;">🔥</span>
								<h2 style="margin: 12px 0 0; color: #4338ca; font-size: 1.3rem; font-weight: 600;">${title}</h2>
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
export function notifyCardCreated(boardId: number, cardId: number, cardTitle: string, creatorName: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const assignees = getAssigneeEmails(cardId);
	if (assignees.length === 0) return;

	const baseUrl = resolveBaseUrl();
	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const html = emailTemplate('New Card Created', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #6366f1;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				Created by <strong>${creatorName}</strong> in <strong>${boardName}</strong>
			</p>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #6366f1; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	for (const a of assignees) {
		sendEmail(a.email, `📋 New card: ${cardTitle}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
	}
}

/** Notify assignees when a card is moved between columns. */
export function notifyCardMoved(boardId: number, cardId: number, cardTitle: string, moverName: string, fromColumn: string, toColumn: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);
	const assignees = getAssigneeEmails(cardId);
	if (assignees.length === 0) return;

	const baseUrl = resolveBaseUrl();
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
		sendEmail(a.email, `🔄 Card moved: ${cardTitle} → ${toColumn}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
	}
}

/** Notify a user when they are assigned to a card. */
export function notifyUserAssigned(boardId: number, cardId: number, cardTitle: string, assigneeEmail: string, assigneeName: string, assignerName: string) {
	if (!isSmtpConfigured()) return;
	const boardName = getBoardName(boardId);

	const baseUrl = resolveBaseUrl();
	const boardUrl = `${baseUrl}/board/${boardId}?card=${cardId}`;

	const html = emailTemplate('You\'ve Been Assigned', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">${cardTitle}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				<strong>${assignerName}</strong> assigned you to this card in <strong>${boardName}</strong>
			</p>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">View Task</a>
		</div>
	`);

	sendEmail(assigneeEmail, `👤 Assigned: ${cardTitle}`, html).catch(err => console.error('[EMAIL] Send failed:', err));
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
	sendEmail(email, '🔥 You\'re invited to DumpFire!', html)
		.then(sent => console.log('[INVITE] Email sent:', sent))
		.catch(err => console.error('[INVITE] Failed to send:', err));
}

/** Notify a user when they are added to a board. */
export function notifyBoardShared(boardId: number, boardName: string, userEmail: string, userName: string, sharerName: string, role: string) {
	if (!isSmtpConfigured()) return;

	const baseUrl = resolveBaseUrl();
	const boardUrl = `${baseUrl}/board/${boardId}`;

	const html = emailTemplate('Board Shared With You', `
		<div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #8b5cf6;">
			<p style="margin: 0 0 8px; font-weight: 600; color: #0f172a;">📋 ${boardName}</p>
			<p style="margin: 0 0 16px; font-size: 13px; color: #475569;">
				<strong>${sharerName}</strong> shared this board with you as <strong style="text-transform: capitalize;">${role}</strong>
			</p>
			<a href="${boardUrl}" style="display: inline-block; padding: 8px 16px; background: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 13px;">Open Board</a>
		</div>
	`);

	sendEmail(userEmail, `📋 Board shared: ${boardName}`, html).catch(err => console.error('[EMAIL] Board share notify failed:', err));
}

/** Notify the target user(s) when a new task request is submitted. */
export function notifyTaskRequest(targetType: string, targetId: number, title: string, requesterName: string, priority: string) {
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

	const baseUrl = resolveBaseUrl();
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
		sendEmail(r.email, `📋 New request: ${title}`, html).catch(err => console.error('[EMAIL] Request notify failed:', err));
	}
}
