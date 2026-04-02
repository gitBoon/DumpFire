/**
 * user.ts — Reactive user store derived from SvelteKit page data.
 *
 * The authenticated user's profile is passed server-side via the layout
 * load function. This module provides a reactive reference for components
 * that need to check the current user, and a helper for user identity.
 */

import { page } from '$app/stores';
import { derived } from 'svelte/store';

export type SessionUser = {
	id: number;
	username: string;
	email: string;
	emoji: string;
	role: string;
};

/**
 * Reactive store for the authenticated user.
 * Reads from $page.data.user (set by +layout.server.ts).
 * Returns null if not authenticated.
 */
export const currentUser = derived(page, ($page) => {
	return ($page.data?.user as SessionUser) ?? null;
});

/** Check if user is admin or superadmin. */
export function isAdmin(user: SessionUser | null): boolean {
	return user?.role === 'admin' || user?.role === 'superadmin';
}

/** Check if user is the superadmin. */
export function isSuperadmin(user: SessionUser | null): boolean {
	return user?.role === 'superadmin';
}
