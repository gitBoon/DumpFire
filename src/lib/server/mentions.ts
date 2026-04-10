/**
 * mentions.ts — Parse and notify @mentions in comments and descriptions.
 */

import { db } from './db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { notifyMention } from './notifications';
import { createLogger } from './logger';

const log = createLogger('Mentions');

/** Extract unique @usernames from text. Returns lowercase usernames. */
export function parseMentions(text: string): string[] {
	const matches = text.match(/@(\w+)/g);
	if (!matches) return [];
	const unique = new Set(matches.map(m => m.slice(1).toLowerCase()));
	return Array.from(unique);
}

/**
 * Resolve @usernames to user IDs. Returns array of matched user records.
 * Skips the author (don't notify yourself).
 */
export function resolveMentions(usernames: string[], excludeUserId: number) {
	return usernames
		.map(u => db.select().from(users).where(eq(users.username, u)).get())
		.filter((u): u is NonNullable<typeof u> => u != null && u.id !== excludeUserId);
}

/**
 * Parse, resolve, and notify @mentions from a comment.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export function processMentions(
	text: string,
	authorUserId: number,
	authorUsername: string,
	cardId: number,
	cardTitle: string,
	boardId: number,
	baseUrl: string
) {
	try {
		const usernames = parseMentions(text);
		if (usernames.length === 0) return;

		const mentionedUsers = resolveMentions(usernames, authorUserId);
		for (const user of mentionedUsers) {
			notifyMention(
				user,
				authorUsername,
				cardId,
				cardTitle,
				text,
				boardId,
				baseUrl
			);
		}
	} catch (err) {
		log.error('Failed to process mentions', err);
	}
}
