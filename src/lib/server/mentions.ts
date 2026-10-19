/**
 * mentions.ts — Parse and notify @mentions in comments.
 *
 * Only the two routes that add a comment call it. Who is named is
 * `findMentions`'s rule (card 2207); which of them are mailed is
 * `notifyMention`'s (card 2198: only those who can open the board).
 */

import { db } from './db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { notifyMention } from './notifications';
import { createLogger } from './logger';
import { findMentions } from '$lib/mentions';

const log = createLogger('Mentions');

/**
 * The usernames mentioned in text, each once, as they are stored, among
 * `usernames`: every account's, so that a longer name is never cut to a
 * shorter one (card 2207). Where a mention is is `findMentions`'s rule, the
 * same one the card window draws its chips by (`$lib/mentions`).
 */
export function parseMentions(text: string, usernames: readonly string[]): string[] {
	const unique = new Set(findMentions(text, usernames).map(m => m.username));
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
	baseUrl: string | null
) {
	try {
		if (!text.includes('@')) return;
		const everyone = db.select({ username: users.username }).from(users).all().map(u => u.username);
		const usernames = parseMentions(text, everyone);
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
