import { runMigrations } from '$lib/server/db/migrate';
import { validateSession, SESSION_COOKIE_NAME, hasAnyUsers, cleanExpiredSessions, validateApiKey } from '$lib/server/auth';
import { initBackupScheduler } from '$lib/server/backup';
import { initReportScheduler } from '$lib/server/reports';
import { initSnapshotScheduler } from '$lib/server/snapshots';
import { json, redirect, type Handle } from '@sveltejs/kit';
import { createLogger } from '$lib/server/logger';
import { checkRateLimit } from '$lib/server/rate-limit';

const log = createLogger('HTTP');

// Run migrations on server start
runMigrations();

// Clean expired sessions periodically (on startup)
cleanExpiredSessions();

// Start the scheduled backup timer
initBackupScheduler();

// Start the scheduled report timer
initReportScheduler();

// Start the daily snapshot scheduler (for CFD / burndown)
initSnapshotScheduler();

/** Public routes that don't require authentication. */
const PUBLIC_ROUTES = ['/login', '/setup', '/invite', '/request', '/api/requests', '/docs', '/api/v1/openapi.json'];

/** Routes restricted to admin/superadmin only. */
const ADMIN_ROUTES = ['/admin'];

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;

	// Allow static assets to pass through immediately
	if (path.startsWith('/_app/') || path.startsWith('/favicon')) {
		return await resolve(event);
	}

	// ── 1a. API v1 bearer-token authentication ───────────────────────
	if (path.startsWith('/api/v1/')) {
		// Public API endpoints (no auth required)
		if (path === '/api/v1/openapi.json') {
			return await resolve(event);
		}

		const authHeader = event.request.headers.get('authorization');
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return json({ error: 'Missing or invalid Authorization header. Use: Bearer <api_key>' }, { status: 401 });
		}

		const apiKey = authHeader.substring(7);
		if (!apiKey) {
			return json({ error: 'API key is empty' }, { status: 401 });
		}

		// Rate limit by API key prefix (60 requests per minute)
		const keyId = apiKey.substring(0, 11);
		const rl = checkRateLimit(`apikey:${keyId}`, 60, 60 * 1000);
		if (rl.limited) {
			return json(
				{ error: 'Rate limit exceeded', retryAfterSecs: rl.retryAfterSecs },
				{ status: 429, headers: { 'Retry-After': String(rl.retryAfterSecs) } }
			);
		}

		const user = validateApiKey(apiKey);
		if (!user) {
			return json({ error: 'Invalid or expired API key' }, { status: 401 });
		}

		event.locals.user = user;

		let response: Response;
		try {
			response = await resolve(event);
		} catch (err) {
			throw err;
		}

		// Security headers
		response.headers.set('X-Content-Type-Options', 'nosniff');
		return response;
	}

	// ── 1b. Read session cookie and attach user to locals ─────────────
	const token = event.cookies.get(SESSION_COOKIE_NAME);
	if (token) {
		event.locals.user = validateSession(token);
	} else {
		event.locals.user = null;
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

	let response: Response;
	try {
		response = await resolve(event);
	} catch (err) {
		// Re-throw redirects and SvelteKit HTTP errors — they are expected control flow
		throw err;
	}

	// Log server errors (5xx responses)
	if (response.status >= 500) {
		log.error(`${event.request.method} ${path} → ${response.status}`);
	}

	// ── 5. Security headers ──────────────────────────────────────────────
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('X-XSS-Protection', '1; mode=block');

	return response;
};
