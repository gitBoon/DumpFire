import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requestMessages, taskRequests } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { notifyRequesterMessage, notifyAdminMessage } from '$lib/server/notifications';
import { resolveBaseUrl } from '$lib/server/email';
import type { RequestHandler } from './$types';

/** GET — Fetch all messages for a request. Requires auth or valid requester email. */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const requestId = Number(params.id);
	const emailToken = url.searchParams.get('email');

	const request = db.select().from(taskRequests).where(eq(taskRequests.id, requestId)).get();
	if (!request) throw error(404, 'Request not found');

	// Access control: must be authenticated OR provide the correct requester email
	const isAuthed = !!locals.user;
	const isRequester = emailToken && request.requesterEmail && emailToken === request.requesterEmail;

	if (!isAuthed && !isRequester) {
		throw error(403, 'Access denied');
	}

	const messages = db.select().from(requestMessages)
		.where(eq(requestMessages.requestId, requestId))
		.orderBy(asc(requestMessages.createdAt))
		.all();

	return json(messages);
};

/** POST — Add a message to the conversation. */
export const POST: RequestHandler = async ({ params, request: req, locals, url }) => {
	const requestId = Number(params.id);
	const body = await req.json();
	const { message, senderType, email: bodyEmail } = body;

	if (!message?.trim()) throw error(400, 'Message is required');
	if (message.trim().length > 5000) throw error(400, 'Message too long (max 5000 characters)');

	const taskReq = db.select().from(taskRequests).where(eq(taskRequests.id, requestId)).get();
	if (!taskReq) throw error(404, 'Request not found');
	if (taskReq.status !== 'pending') throw error(400, 'Request is already resolved');

	let sType: string;
	let sName: string;

	if (senderType === 'requester') {
		// Public requester reply — validate email matches
		if (!bodyEmail || bodyEmail !== taskReq.requesterEmail) {
			throw error(403, 'Invalid email');
		}
		sType = 'requester';
		sName = taskReq.requesterName;
	} else {
		// Admin/user reply — must be authenticated
		if (!locals.user) throw error(401, 'Not authenticated');
		sType = 'admin';
		sName = locals.user.username;
	}

	const newMsg = db.insert(requestMessages).values({
		requestId,
		senderType: sType,
		senderName: sName,
		message: message.trim()
	}).returning().get();

	const baseUrl = resolveBaseUrl(req, url);

	// Send email notifications
	if (sType === 'admin' && taskReq.requesterEmail) {
		// Admin replied → email the requester with a reply link
		notifyRequesterMessage(
			taskReq.requesterEmail,
			taskReq.title,
			sName,
			message.trim(),
			requestId,
			baseUrl
		);
	} else if (sType === 'requester') {
		// Requester replied → notify inbox targets
		notifyAdminMessage(
			taskReq.targetType,
			taskReq.targetId,
			taskReq.title,
			taskReq.requesterName,
			message.trim(),
			baseUrl
		);
	}

	return json(newMsg);
};
