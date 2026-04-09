import { runMigrations } from '$lib/server/db/migrate';
import { validateSession, SESSION_COOKIE_NAME, hasAnyUsers, cleanExpiredSessions } from '$lib/server/auth';
import { initBackupScheduler } from '$lib/server/backup';
import { redirect, type Handle } from '@sveltejs/kit';

// Run migrations on server start
runMigrations();

// Clean expired sessions periodically (on startup)
cleanExpiredSessions();

// Start the scheduled backup timer
initBackupScheduler();

/** Public routes that don't require authentication. */
const PUBLIC_ROUTES = ['/login', '/setup', '/invite', '/request', '/api/requests'];

/** Routes restricted to admin/superadmin only. */
const ADMIN_ROUTES = ['/admin'];

export const handle: Handle = async ({ event, resolve }) => {
	// ── 1. Read session cookie and attach user to locals ──────────────
	const token = event.cookies.get(SESSION_COOKIE_NAME);
	if (token) {
		event.locals.user = validateSession(token);
	} else {
		event.locals.user = null;
	}

	const path = event.url.pathname;

	// Allow static assets and API routes for auth to pass through
	if (path.startsWith('/_app/') || path.startsWith('/favicon')) {
		return await resolve(event);
	}

	// ── 2. Setup guard — if no users exist, force /setup ─────────────
	const usersExist = hasAnyUsers();

	if (!usersExist) {
		// No users — only allow /setup
		if (!path.startsWith('/setup')) {
			throw redirect(303, '/setup');
		}
		return await resolve(event);
	}

	// Users exist — block /setup permanently
	if (path.startsWith('/setup')) {
		throw redirect(303, '/');
	}

	// ── 3. Auth guard — redirect unauthenticated to /login ───────────
	const isPublicRoute = PUBLIC_ROUTES.some((r) => path.startsWith(r));

	if (!event.locals.user) {
		if (!isPublicRoute) {
			throw redirect(303, '/login');
		}
		return await resolve(event);
	}

	// Authenticated user visiting /login — redirect home
	if (path === '/login') {
		throw redirect(303, '/');
	}

	// ── 4. Admin guard — block non-admin from admin routes ───────────
	const isAdminRoute = ADMIN_ROUTES.some((r) => path.startsWith(r));
	if (isAdminRoute) {
		const role = event.locals.user.role;
		if (role !== 'admin' && role !== 'superadmin') {
			throw redirect(303, '/');
		}
	}

	const response = await resolve(event);

	// ── 5. Security headers ──────────────────────────────────────────────
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('X-XSS-Protection', '1; mode=block');

	return response;
};
