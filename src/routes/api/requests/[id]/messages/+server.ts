import { json, error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requestMessages, taskRequests } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { notifyRequesterMessage, notifyAdminMessage } from '$lib/server/notifications';
import type { RequestHandler } from './$types';

/** GET — Fetch all messages for a request. */
export const GET: RequestHandler = async ({ params, url }) => {
	const requestId = Number(params.id);

	// Allow access if authenticated OR via email token
	const emailToken = url.searchParams.get('email');

	const request = db.select().from(taskRequests).where(eq(taskRequests.id, requestId)).get();
	if (!request) throw error(404, 'Request not found');

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
	const { message, senderType, senderName: bodyName, email: bodyEmail } = body;

	if (!message?.trim()) throw error(400, 'Message is required');

	const taskReq = db.select().from(taskRequests).where(eq(taskRequests.id, requestId)).get();
	if (!taskReq) throw error(404, 'Request not found');

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

	const baseUrl = `${url.protocol}//${url.host}`;

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
