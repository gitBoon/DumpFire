/**
 * auth.ts — Server-side authentication utilities for DumpFire.
 *
 * Handles password hashing, session management, and cookie operations.
 * Uses bcryptjs for password hashing and crypto.randomUUID() for session tokens.
 */

import { hashSync, compareSync } from 'bcryptjs';
import { db } from './db';
import { users, sessions } from './db/schema';
import { eq, and, gt, lt } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = 'dumpfire_session';
const BCRYPT_ROUNDS = 12;
const SESSION_DURATION_DAYS = 30;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SessionUser = {
	id: number;
	username: string;
	email: string;
	emoji: string;
	role: string;
};

// ─── Password Utilities ──────────────────────────────────────────────────────

/** Hash a plaintext password using bcrypt with 12 rounds. */
export function hashPassword(password: string): string {
	return hashSync(password, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a bcrypt hash. */
export function verifyPassword(password: string, hash: string): boolean {
	return compareSync(password, hash);
}

// ─── Session Management ─────────────────────────────────────────────────────

/** Create a new session for a user. Returns the session token (UUID). */
export function createSession(userId: number): string {
	const token = crypto.randomUUID();
	const expiresAt = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();

	db.insert(sessions)
		.values({ id: token, userId, expiresAt })
		.run();

	return token;
}

/**
 * Validate a session token. Returns the user if valid, null otherwise.
 * Also extends the session expiry on each valid access (sliding window).
 */
export function validateSession(token: string): SessionUser | null {
	const now = new Date().toISOString();

	const session = db.select()
		.from(sessions)
		.where(and(eq(sessions.id, token), gt(sessions.expiresAt, now)))
		.get();

	if (!session) return null;

	const user = db.select()
		.from(users)
		.where(eq(users.id, session.userId))
		.get();

	if (!user) {
		// Orphaned session — clean up
		db.delete(sessions).where(eq(sessions.id, token)).run();
		return null;
	}

	// Slide the session expiry forward
	const newExpiry = new Date(Date.now() + SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
	db.update(sessions)
		.set({ expiresAt: newExpiry })
		.where(eq(sessions.id, token))
		.run();

	return {
		id: user.id,
		username: user.username,
		email: user.email,
		emoji: user.emoji || '👤',
		role: user.role
	};
}

/** Delete a session (logout). */
export function deleteSession(token: string): void {
	db.delete(sessions).where(eq(sessions.id, token)).run();
}

/** Delete all expired sessions (housekeeping). */
export function cleanExpiredSessions(): void {
	const now = new Date().toISOString();
	db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
}

// ─── Cookie Utilities ────────────────────────────────────────────────────────

/** Set the session cookie on the response. */
export function setSessionCookie(cookies: Cookies, token: string): void {
	cookies.set(SESSION_COOKIE_NAME, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'strict',
		secure: process.env.NODE_ENV === 'production',
		maxAge: SESSION_DURATION_DAYS * 24 * 60 * 60
	});
}

/** Clear the session cookie. */
export function clearSessionCookie(cookies: Cookies): void {
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
}

// ─── User Queries ────────────────────────────────────────────────────────────

/** Check if any users exist in the database. */
export function hasAnyUsers(): boolean {
	const result = db.select().from(users).limit(1).get();
	return !!result;
}

/** Get a user by username (case-insensitive). */
export function getUserByUsername(username: string) {
	return db.select().from(users).where(eq(users.username, username)).get();
}

/** Get a user by email (case-insensitive). */
export function getUserByEmail(email: string) {
	return db.select().from(users).where(eq(users.email, email)).get();
}
