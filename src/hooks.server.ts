import { runMigrations } from '$lib/server/db/migrate';
import {
	validateSession,
	hasAnyUsers,
	cleanExpiredSessions,
	findApiKey,
	markApiKeyUsed,
	oldSessionCookieDeletion,
	openSessionUser,
	readSessionCookie,
	sessionTokenHash,
	slidesSession,
	startSessionSweep
} from '$lib/server/auth';
import { startSchedulers } from '$lib/server/schedulers';
import { json, text, type Handle, type HandleServerError, type RequestEvent } from '@sveltejs/kit';
import { createLogger, initLogMaintenance } from '$lib/server/logger';
import { checkRateLimit } from '$lib/server/rate-limit';
import { failureAsJson, guardBody } from '$lib/server/api-errors';
import { bodyLimit, heldToLimit, refuseBody, type Caller } from '$lib/server/body-limits';
import { addressKey, addressOf, UNKNOWN_ADDRESS } from '$lib/server/client-address';
import { isNavigation, notSignedIn, secured, sendTo, whereSent } from '$lib/server/gate-answers';
import { refusalSeen, refuseCrossSiteWrite } from '$lib/server/same-origin';
import { pathToLog } from '$lib/server/secret-paths';
import {
	announceReportSchedules,
	announceWebhooksBeforeKeys,
	checkMfaKeyAtStart,
	endPlainInvites,
	endPlainRequestLinks,
	endPlainSessions,
	holdAlreadyOffWebhooksAtStart,
	holdReadableWebhooksAtStart,
	maskLiveLog,
	refuseUserlessBesideAnother,
	removeSettingsOfNonAdministrators,
	reportInstallation,
	sealStoredSecretsAtStart,
	startEndedKeyRevealSweep,
	sweepEndedKeyReveals,
	switchOffHeldWebhooksAtStart
} from '$lib/server/startup-checks';
import { recheckStoredImages } from '$lib/server/image-recheck';
import { ensureFormSecret } from '$lib/server/request-tokens';
import { startChallengeSweep } from '$lib/server/sign-in-challenges';

const log = createLogger('HTTP');

// Run migrations on server start.
//
// Deliberately a bare call with no try/catch. A migration that fails throws,
// and that throw is what stops the built server before it listens (exit code
// 1), so a deploy fails loudly instead of serving a half-migrated database.
// Catching it here would bring back exactly that. See db/migrate.ts.
//
// Under `vite dev` it does not end the process. The dev server stays up, this
// module fails to load, and every request fails until the cause is fixed and
// the server is restarted.
runMigrations();

// Stop here too, the same way, when the database in use has no users while
// another database is beside it (card 2083): set-up would be open to whoever
// comes first while the real database sits unused. A bare call: its throw is
// what stops the server before it listens. See $lib/server/startup-checks.ts.
refuseUserlessBesideAnother();

// Stop here too, the same way, when the key that protects authenticator
// secrets does not load, or is not the one the stored second factors were
// made with (card 2768), or the stored secrets sealed with (card 2898): under
// the production rules MFA_KEY_FILE must name
// it, and a server must not run with secrets it cannot read. The key is read
// here, for the first time, and never at import. A bare call: its throw is
// what stops the server before it listens. See $lib/server/startup-checks.ts.
checkMfaKeyAtStart();

// Make the key form tokens and decision revisions are signed with, where
// there is none (card 2750), so that every check that signs or verifies only
// reads it. It was made at first use, which could be inside a read-only check.
// A bare call: a database that cannot take it stops the server here.
ensureFormSecret();

// Seal every secret the database still holds in plain (card 2898): the mail
// password, the backup destinations' credentials, the webhooks' secrets and
// the signing keys, under the MFA key checked above, the key check recorded
// with them; then scrub the old plain text out of the file. After the form
// key is made, so that it is sealed with the rest. A bare call: a sealing
// that fails stops the server here, nothing changed. See
// $lib/server/startup-checks.ts.
sealStoredSecretsAtStart();

// End every session an older image kept in plain (card 2775). An image from
// before the card, started here after going back, keeps a session's code as
// the cookie holds it, and that code would sign its holder in again if the
// older image were started again. Going back is safe for the sessions this
// image made: each is a BLOB, which that image's lookup by the cookie, as
// text, never matches. Before the clean-up, so that every plain session is
// counted. A second start changes nothing, and it cannot throw. See
// $lib/server/startup-checks.ts.
endPlainSessions();

// Delete the sessions whose deadline has passed, at start, and then every five
// minutes (card 2883), so that ended rows do not wait for a restart.
cleanExpiredSessions();

// Sweep expired sign-in challenges now and every five minutes (card 2769,
// CS1): a verify challenge left unfinished raises its account's banner and
// mails the owner without waiting for some later sign-in to sweep it.
startChallengeSweep();

// Clear ended sessions every five minutes (card 2883). Only the timer: the
// start-up clean-up is the call above.
startSessionSweep();

// Start log retention maintenance (prune old system_logs entries)
initLogMaintenance();

// Mask, once, the invite tokens an older gate wrote into the system log, and
// any request link's token a line holds, by the rule a backup's copy is
// masked with: the log any administrator reads holds none either. A second
// start changes nothing, and it cannot throw. See
// $lib/server/startup-checks.ts.
maskLiveLog();

// Remove the mail settings, App URL and backup destinations set by someone who
// is no longer an administrator (card 2406): a role written to `user` from the
// host runs no application code. Before the schedulers, so that no backup is
// sent to such a destination first. It cannot throw. See
// $lib/server/startup-checks.ts.
removeSettingsOfNonAdministrators();

// End every unused invite an older image kept in plain, and give every used
// one held in plain 32 random bytes in place of its token (card 2849). An
// image from before the card, started here after going back, keeps an
// invite's token as mailed, and a link it keeps as mailed would work again if
// that older image were started again. Going back is safe for the invites
// this image issued: each is a BLOB, which that image's lookup by the
// address, as text, never matches. A second start changes nothing, and it
// cannot throw. See $lib/server/startup-checks.ts.
endPlainInvites();

// When an older image has written requester links in plain into the retired
// task_requests.access_token, set them back to NULL and end every link kept
// as a hash too (card 2870): while that image ran, request_links was outside
// its rules, and a link kept through its restore or reset could open
// somebody else's thread. Each requester has a new link mailed from the page
// their old one opens. A start after no older image changes nothing, and a
// second start changes nothing. Where it cannot look, it ends every link
// instead; where it cannot do that either, it throws, and a bare call's throw
// is what stops the server before it listens (the code review's CS3): no
// server runs with links that may open other people's threads. See
// $lib/server/startup-checks.ts.
endPlainRequestLinks();

// Tell each owner of a report schedule that is on, once, at the first start
// after card 2751, which of theirs are running, with every address each is
// sent to: one made before the release asked for no password, and may have
// been made by someone holding the owner's session. One WARN line a schedule,
// then the notices, then, once every notice went, a settings row that says it
// was done, so a second start says nothing. Only where the schedulers run, by
// the same decision as startSchedulers: a rehearsal or a dev copy mails nobody.
// Not awaited, so the start does not wait on the mail server; the lines are
// written and the notices begun before it first waits, so before the
// schedulers start, and the owners hear of a schedule before its next run. It
// never rejects. See $lib/server/startup-checks.ts.
void announceReportSchedules();

// Tell the owners of each board, once, at the first start after card 2893,
// which of its webhooks were set up before API keys were recorded, and the
// date each will stop: the latest end among its setter's working keys from
// then. One WARN line a webhook, then one mail to each owner, then, once every
// mail went, a settings row that says it was done. Only where the schedulers
// run, as above. Straight after the report schedules, and not awaited; it
// never rejects. See $lib/server/startup-checks.ts.
void announceWebhooksBeforeKeys();

// Check, once, every image stored before card 2761 as an upload is checked
// now: its hidden data taken out in place, or, where it is refused by the
// check (not the image its type names, animated, too large, or malformed),
// typed as a download, kept as it was. One WARN line with the counts, then a
// settings row that says it was done, written only when no row failed (a row
// that failed the same way at three starts is given up), so a second start
// does nothing. An import of a backup runs it again. Not awaited, and before the schedulers, so the
// attachment sweep's first run (15 minutes on) finds the files it rewrote
// new. It never rejects. See $lib/server/image-recheck.ts.
void recheckStoredImages();

// Switch off, for good, every webhook that is on and whose setter cannot open
// its board, that nobody is recorded as having set up (card 2752), or whose
// API key has ended (card 2893): at the
// first start after the card, every webhook card 2325 held at delivery; after
// that, what changed outside the writes that switch off. One WARN line each,
// and the boards' owners mailed only where the schedulers run, by the same
// decision as startSchedulers. After the settings of non-administrators are
// removed, and before the schedulers start. A second start changes nothing,
// and it cannot throw. See $lib/server/startup-checks.ts.
switchOffHeldWebhooksAtStart();

// Hold the webhooks already switched off without a hold (card 2923): once,
// while the settings flag is absent, every one of them, whoever set it; at
// every start, those whose setter is disabled or not recorded. Switched on,
// each is given a new secret. One WARN line when any was held, and nobody
// mailed. It cannot throw. See $lib/server/startup-checks.ts.
holdAlreadyOffWebhooksAtStart();

// Hold the webhooks whose secret a disabled owner or administrator could read
// (card 2935): the first time, every disabled one's, and every webhook made
// before setters were recorded; after that, those of accounts disabled since
// the moment stored, which only an older image leaves. Told as the sweep above
// tells. It cannot throw. See $lib/server/startup-checks.ts.
holdReadableWebhooksAtStart();

// Hold what every ended API key was given (card 2947): each key with rows in
// webhook_reveals that has expired, passed its deadline or gone has its
// account's webhooks swept as a revoke sweeps them, and every webhook with a
// secret it was given held as setter access ended, so that switching it on
// gives it a new secret; then its rows go. Told as the sweeps above tell. Then
// every five minutes, whatever SCHEDULERS says: a server with its schedulers
// off still delivers. It cannot throw. See $lib/server/startup-checks.ts.
sweepEndedKeyReveals();
startEndedKeyRevealSweep();

// Start the backup, report and snapshot schedulers, the decision reminder and
// the attachment file sweep, or leave all five off. SCHEDULERS=on or =off
// decides. When it is not set they run in a built server and not under `vite
// dev`, so that a dev instance holding a copy of production's data does not
// back up to production's destination, send its reports or remind its
// decisions' participants. See $lib/server/schedulers.ts.
startSchedulers();

// Say in the system log, once, what about this installation nothing else
// would say: that there are users and no superadmin among them, that ORIGIN
// is still the address the image is built with, that a board hangs beneath
// one of its own cards, or, of the database, that it was new at this start,
// that it is not on a mounted volume, or that another is beside it (card
// 2083), or that a secret a backup does not hold is still to be entered (card
// 2169). It reads and it logs, and it cannot throw. See
// $lib/server/startup-checks.ts.
reportInstallation();

/**
 * The routes a caller who is not signed in is let through to, by route id,
 * exactly. The handlers under /api/requests each ask for themselves what
 * they need: a session, the token the form was given, or a request's link.
 * `/api/v1/openapi.json` is answered in the v1 branch, before this is asked,
 * and is here so that the list is the whole of what is public.
 *
 * By id, and not by how an address begins. Compared by its start, the list
 * let `/requestX`, `/loginX` and `/api/requestsX` past the sign-in redirect:
 * nothing is served there but a 404 today, and nothing is to be served to
 * nobody tomorrow for being named like a public route. A route under a public
 * one is not public unless it is here itself. A path that is no route has no
 * id, and is never public.
 */
const PUBLIC_ROUTES = new Set([
	'/login',
	// The second step of signing in (card 2769): it answers only the browser
	// holding a live challenge, which a right password opened. The set-up page
	// likewise, whose challenge a password, an invite or the first-run set-up opened.
	'/login/verify',
	'/login/enrol',
	// A set-up link's page (card 2769, decision 19): it asks nothing, and
	// leaves the link for the sign-in that follows, which asks the password.
	'/enrol/[token]',
	// Sign-out (card 2775, the code review's CS3): reached with no session
	// too, so that a browser sending two session cookies, which signs in with
	// neither, can still end both. Its POST passes the same-origin check above
	// and SvelteKit's own; its GET only sends the browser home.
	'/logout',
	'/docs',
	'/invite/[token]',
	'/request',
	'/request/[id]/confirm',
	'/request/[id]/reply',
	'/api/requests',
	'/api/requests/[id]',
	'/api/requests/[id]/confirm',
	// Asked from the page a dead request link opens (card 2158): it mails a
	// new link only to the address the request was made with (card 2870).
	'/api/requests/[id]/link',
	'/api/requests/[id]/messages',
	'/api/requests/targets',
	// A decision's personal link (card 2677, decisions 4 and 9): its page, and
	// its holder's response and seen, the token in the body. Each answers only
	// a token whose hash a participant holds, and signs nobody in. Card 2679
	// (decision 4) adds its holder's concern about the ruling, card 2678
	// (decision 12) its holder's clarification question, and card 2684 (R3)
	// its holder's objection or request to talk.
	'/decision-link/[token]',
	'/api/decision-by-link/responses',
	'/api/decision-by-link/seen',
	'/api/decision-by-link/concerns',
	'/api/decision-by-link/questions',
	'/api/decision-by-link/flags',
	'/api/v1/openapi.json'
]);

/** The sign-in pages, by route id, which a caller who is signed in is sent home from. */
const SIGNED_IN_SENT_HOME = new Set(['/login', '/login/verify', '/login/enrol']);

/** The set-up page, by route id: the one page there is before there is a user, and never one after. */
const SETUP_ROUTE = '/setup';

/** Routes restricted to admin/superadmin only. */
const ADMIN_ROUTES = ['/admin', '/audit'];

/**
 * What passes the gate untouched, unasked and unlogged: SvelteKit's own
 * scripts and styles, under `/_app/` as a whole segment, and `/favicon.ico`,
 * exactly. Nothing else does: `/faviconX` is asked who is calling, like any
 * other path.
 *
 * A file under `/_app/` does not reach the gate: in a built server the
 * adapter serves those files from the disk. Nor does any other path that
 * begins `/_app`, but one: SvelteKit answers them itself, 404, before it calls
 * the gate (`respond` in @sveltejs/kit/src/runtime/server/respond.js). The one
 * is a call to a remote function, `/_app/remote/<id>`, which does reach the
 * gate, and with `event.url` and the route taken from what the caller wrote in
 * its `x-sveltekit-pathname` header. It is answered 404 by the gate before
 * this is asked (`handle`), so that it can never pass through here, whatever
 * path it names. There is no favicon file: the icon is drawn in the page, and
 * a browser still asks for `/favicon.ico` beside a tab that shows JSON or a
 * PDF, which is answered 404.
 */
function passesThrough(path: string): boolean {
	return path.startsWith('/_app/') || path === '/favicon.ico';
}

/**
 * The gate's answer to a call to a remote function: 404, as JSON, to anybody.
 *
 * SvelteKit reads the path such a call is for from the `x-sveltekit-pathname`
 * header, which the caller writes, and has set `event.url` and the route from
 * it before this hook is called. Decided on that, a call that named `/login`
 * would be let through as the public page, and one that named `/_app/x` would
 * pass through unasked and unlogged. This application has no remote functions,
 * so there is nothing for such a call to reach, and it is answered here.
 */
function noRemoteFunctions(): Response {
	return json({ message: 'Not found' }, { status: 404 });
}

/** Who is calling, as far as the size of a body goes: see `bodyLimit`. */
function callerOf(user: App.Locals['user'] | undefined): Caller {
	if (!user) return 'nobody';
	return user.role === 'superadmin' ? 'the superadmin' : 'signed in';
}

/** The gate's 429, with how long to wait in the body and in `Retry-After`. */
function rateLimited(retryAfterSecs: number): Response {
	return json(
		{ message: 'Rate limit exceeded', retryAfterSecs },
		{ status: 429, headers: { 'Retry-After': String(retryAfterSecs) } }
	);
}

/**
 * Faults the gate has written to the log itself, so that `handleError`,
 * which SvelteKit calls with the same error once the gate has thrown it, does
 * not write it down a second time.
 */
const loggedByTheGate = new WeakSet<object>();

/** An exception as the log keeps it: what it said, and where. Never throws. */
function describeFault(fault: unknown): { error: string; stack?: string } {
	try {
		if (fault instanceof Error) return { error: fault.message, stack: fault.stack };
		return { error: String(fault) };
	} catch {
		return { error: 'a value that cannot be written out' };
	}
}

/**
 * The path a request is decided on: the path as the router sees it.
 *
 * `event.url.pathname` is the address as it was sent, and SvelteKit decodes
 * it before it looks for a route. `/%61dmin` is served by the route `/admin`,
 * so a rule that compared the address as sent with '/admin' let it past: the
 * gate and the router had each read the address in their own way. Every rule
 * in `handle` and `handleRequest` is decided on what this returns instead.
 *
 *   - Where a route matched, it is that route's id: `/admin`,
 *     `/api/cards/[id]`. That is the router's own answer, so the two cannot
 *     disagree, whatever was done to the address to arrive at it. A request
 *     for a page's data, `/admin/__data.json`, has the id of the page.
 *   - Where none did, nothing but a 404 is served, and it is the address
 *     decoded as SvelteKit decodes it before it looks (`decode_pathname` in
 *     @sveltejs/kit/src/utils/url.js): `decodeURI` on each piece between one
 *     `%25` and the next. So `%2F` stays as it is and is no `/`, to the router
 *     and here alike. `%2561` stays as it is, and is not decoded a second
 *     time into an `a`.
 *   - Where the address cannot be decoded at all (`/%zz`), it is null, and
 *     `handle` answers 400 "Malformed URI" before anything else. Up to
 *     SvelteKit 2.60 SvelteKit answered that itself before it called this
 *     hook; since 2.61 it calls the hook with no route, and `decodeURI` threw
 *     here, a 500 (card 2227).
 *
 * An id is compared as it is written. No route here is inside a `(group)`,
 * whose name is in the id and not in the address, so that `/(app)/admin`
 * would not start with `/admin`: tests/gate.test.ts fails if one is added.
 */
function routedPath(event: RequestEvent): string | null {
	if (event.route.id !== null) return event.route.id;
	try {
		return event.url.pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		return null;
	}
}

type ResolveFn = Parameters<Handle>[0]['resolve'];

/**
 * Auth guards + routing rules. Wrapped by `handle` below for request logging.
 *
 * `path` is the path as the router sees it, which `handle` works out once:
 * see routedPath. No rule here reads `event.url.pathname`. `address` is the
 * caller's, or null where there is none (`addressOf`).
 *
 * Every refusal and every redirect here is an answer that is returned, and
 * none is thrown, so that `handle` heads and logs each like any other.
 */
async function handleRequest(event: RequestEvent, resolve: ResolveFn, path: string, address: string | null): Promise<Response> {
	// ── 1a. API v1 bearer-token authentication ───────────────────────
	if (path.startsWith('/api/v1/')) {
		// Every failure under /api/v1/ is answered as JSON. SvelteKit chooses
		// between JSON and an HTML page for an `error()` by the request's
		// Accept header, and chooses the page for a caller that sends no such
		// header, or a browser's. So the request is made to ask for JSON,
		// whatever it asked for. The header is set on the request itself and
		// the request is not replaced by a copy: SvelteKit answers an error
		// thrown out of this hook from the object it gave us. The request the
		// gate hands on with its body counted (`handOn`) is made after this,
		// from this one, and asks for JSON too.
		event.request.headers.set('accept', 'application/json');

		// Public API endpoints (no auth required). No key and no rate limit,
		// but a wrong method is answered as JSON here too: see the end of this
		// branch.
		if (path === '/api/v1/openapi.json') {
			return await failureAsJson(await resolve(event), event.request.method);
		}

		// The key is looked up first, then the request is counted against it,
		// and only then is the key recorded as used. 60 requests a minute.
		//
		// It was counted first, against the first 11 characters of whatever
		// was sent, which is the prefix stored for a real key. A caller who had
		// seen a key's prefix, in a log or on a screen, could spend that key's
		// allowance with requests that were not the key at all. Now a key's
		// requests are counted against the key's own row, which only the key
		// reaches, and a key that is over its limit is refused without being
		// marked as used.
		const authHeader = event.request.headers.get('authorization');
		const presented = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
		const key = presented ? findApiKey(presented) : null;

		if (!key) {
			// No key the gate accepts, a missing header included, is counted
			// against the address the request came from, in a bucket of its own,
			// so that guessing at keys is slowed and can never spend a real
			// key's allowance. Behind a proxy that does not say who its caller
			// was (ADDRESS_HEADER, in docs/deployment.md) every caller has the
			// proxy's address, and so shares the one bucket: a valid key is
			// never held up by it, and a mistyped key may be answered 429 while
			// somebody else is guessing. Counted by the address's key
			// (`addressKey`, card 2195): an IPv6 caller by its /64, so that
			// the addresses of one network share the one allowance.
			const guessing = checkRateLimit(`apikey-none:${addressKey(address ?? UNKNOWN_ADDRESS)}`, 60, 60 * 1000);
			if (guessing.limited) return rateLimited(guessing.retryAfterSecs);

			// `Bearer ` with nothing after it is answered here too: a header's
			// value loses the spaces at its end before the gate sees it, so it
			// arrives as `Bearer`, which is no Bearer header. An empty key had a
			// branch of its own, which nothing could reach.
			if (presented === null) {
				return json({ message: 'Missing or invalid Authorization header. Use: Bearer <api_key>' }, { status: 401 });
			}
			return json({ message: 'Invalid or expired API key' }, { status: 401 });
		}

		const rl = checkRateLimit(`apikey:${key.id}`, 60, 60 * 1000);
		if (rl.limited) return rateLimited(rl.retryAfterSecs);

		markApiKeyUsed(key.id);
		event.locals.user = key.user;
		// The key itself, by its row, so that a handler can ask in the
		// transaction that writes whether it is still open, and who its account
		// is now: a body may arrive long after this, and a reset end the key or a
		// role change lower its account meanwhile (`writeAs`, card 2253).
		event.locals.credential = { kind: 'api key', id: key.id };

		let response: Response;
		if (event.route.id === null) {
			// No such route. SvelteKit would render its 404 page: HTML, and with
			// the key owner's name, email and role in it, which the root layout
			// loads for every page. It is answered here instead, and only now
			// that the key is accepted: without one, every path is a 401.
			response = json({ message: 'Not found' }, { status: 404 });
		} else {
			// What SvelteKit answers without asking a handler is plain text: a
			// method the route does not have, above all. Any failure that is
			// not JSON is answered again as JSON, with its status and, for a
			// wrong method, its Allow header.
			response = await failureAsJson(await resolve(event), event.request.method);
		}

		return response;
	}

	// ── 1b. Writes from DumpFire's own pages alone (card 2700) ─────────
	// Every method but GET and HEAD, outside /api/v1/, form actions included:
	// a request the server makes of itself is refused, 403; one the browser
	// does not say comes from this origin, 403; under
	// /api/, one that does not say it is JSON, but the two uploads, 415. Before
	// the session cookie is read, because reading it slides the session: a
	// refused request touches no row. See $lib/server/same-origin.ts.
	const crossSite = refuseCrossSiteWrite(event, path);
	if (crossSite) return crossSite;

	// ── 1c. Read session cookie and attach user to locals ─────────────
	// One value of the name in force, in a code's shape, or none (card 2775).
	// The code goes no further than here. Only the holder's own use slides the
	// session: a navigation, or a write, which has passed the check above
	// (the code review's CS1). A page's own reads are checked and slide nothing.
	const token = readSessionCookie(event.request, event.url);
	const found = token === undefined ? null : validateSession(token, { slide: slidesSession(event.request) });
	event.locals.user = found?.user ?? null;
	// The session the account was found by, as its hash, as the key is kept above.
	event.locals.credential = found ? { kind: 'session', hash: found.hash } : null;

	// Decided on the route's id, which a path that is no route has not got.
	const routeId = event.route.id;
	const isPublicRoute = routeId !== null && PUBLIC_ROUTES.has(routeId);
	const isSetupRoute = routeId === SETUP_ROUTE;

	// A page's script, or any other program, asking an internal API route for
	// something, as opposed to a browser that has gone to one of its
	// addresses. Without a session the first is answered 401, which a script
	// can act on, and the second is sent to sign in, which a person can: an
	// attachment opened in a new tab, the milestone PDF, an export's
	// download. The documented API and the public routes are not internal
	// routes, and are as they were. See $lib/server/gate-answers.ts.
	const asksAnInternalRoute =
		path.startsWith('/api/') && !path.startsWith('/api/v1/') && !isPublicRoute && !isNavigation(event.request);

	// ── 2. Setup guard — if no users exist, force /setup ─────────────
	const usersExist = hasAnyUsers();

	if (!usersExist) {
		// No users — only allow /setup. Nobody can be signed in, so a script
		// asking an internal route is told so, and a browser goes to set-up.
		if (isSetupRoute) return await resolve(event);
		if (asksAnInternalRoute) return notSignedIn();
		return sendTo(event, '/setup');
	}

	// Users exist — block /setup permanently
	if (isSetupRoute) return sendTo(event, '/');

	// ── 3. Auth guard — unauthenticated: 401 to a script, /login to a browser ──
	if (!event.locals.user) {
		if (isPublicRoute) return await resolve(event);
		if (asksAnInternalRoute) return notSignedIn();
		return sendTo(event, '/login');
	}

	// Authenticated user visiting /login, or its second step (card 2769) — redirect home
	if (routeId !== null && SIGNED_IN_SENT_HOME.has(routeId)) return sendTo(event, '/');

	// ── 4. Admin guard — block non-admin from admin routes ───────────
	const isAdminRoute = ADMIN_ROUTES.some((r) => path.startsWith(r));
	if (isAdminRoute) {
		const role = event.locals.user.role;
		if (role !== 'admin' && role !== 'superadmin') return sendTo(event, '/');
	}

	return await resolve(event);
}

export const handle: Handle = async ({ event, resolve }) => {
	// No key and no session until one is found, on every request the gate
	// hands on, whichever way: a write handler refuses a request that reaches
	// it with none recorded (`stillAuthenticated`, card 2253). The v1 branch
	// and the session branch of handleRequest set it again as they find one.
	event.locals.credential = null;
	// Every rule here and in handleRequest is decided on this, the path as the
	// router sees it, and none on the address as it was sent: see routedPath.
	const routed = routedPath(event);
	// An address that cannot be decoded is answered as SvelteKit answered it
	// before it began calling this hook for one: 400, the same plain words, and
	// nothing written to the log. It is no route, so nobody is asked who they
	// are; the security headers are put on it, now that it passes through here.
	// error-shape-allowed: malformed-uri
	if (routed === null) return secured(text('Malformed URI', { status: 400 }), null);
	const path = routed;
	// A call to a remote function, which is answered 404 below whatever path it
	// names: see noRemoteFunctions. Its `event.url` is the path its header
	// names, so it is written down at the address it was really sent to.
	const remoteCall = event.isRemoteRequest;
	// The address as it was sent, for the log only: what was asked for is the
	// evidence, and `/%61dmin` is not to be written down as `/admin`. But never
	// a secret: an invite's address is written down as `/invite/[token]` (see
	// $lib/server/secret-paths.ts), so that the log, which every administrator
	// can read and every backup kept, holds no live invite.
	const sent = remoteCall ? new URL(event.request.url).pathname : pathToLog(event.url.pathname, path);

	// How large a body may be, asked at once and of every request: a page and a
	// form action as much as a route under /api/. A request that declares more
	// than its route accepts is a 413: see $lib/server/body-limits.ts. Decided
	// here, before anybody is asked who they are, on what the route would give
	// anybody, so that the login form is held to the default without a session
	// being read. It is an answer and is not thrown; where it is returned is
	// below. A body that declares no length is held to the same limit as it is
	// read: see handOn.
	//
	// A request the server makes of itself, from a page's load, has a body the
	// server already holds and is not asked.
	const method = event.request.method;
	const tooLarge =
		event.isSubRequest || remoteCall ? null : refuseBody(event.request, bodyLimit(path, method, 'not yet known'));
	// What is answered in place of everything handleRequest would have done.
	const refused = remoteCall ? noRemoteFunctions() : tooLarge;

	// Every request the gate lets through is handed on by this, from each of
	// the places handleRequest hands one on and from the pass-through below.
	//
	// The limit is asked again here, now that the gate knows who is calling.
	// Two routes accept more than the default: the attachment upload gives it
	// to anybody signed in, and the import to the superadmin alone. So an
	// administrator who declares a whole backup to the import is refused for
	// its size here, before the handler refuses them for not being the
	// superadmin, and has had none of it read. One who sends it in chunks,
	// with no length, is refused by the handler instead, and may have had a
	// chunk or two of it read by then: a body sent that way is read a little
	// ahead as soon as it is handed on.
	//
	// Then the body is counted as it is read, against the same limit
	// (`heldToLimit`): a body that declares no length, one sent in chunks, is
	// read until it passes the limit and is answered 413 there. The request
	// handed on is a copy of the one the gate was given, with its body passed
	// through the count, and the event is handed on with it in place of the
	// old one, as SvelteKit itself hands on a copy of the event it is given.
	//
	// And the read is guarded (`guardBody`): a body that is missing, is not
	// JSON, or is JSON and not an object (an array among them) is the caller's
	// mistake and a 400, and a body over the limit is a 413. Both used to be a
	// 500: handlers read the body unguarded. It is on every request and not
	// only those under /api/. The three form actions (/login, /setup,
	// /invite/[token]) read their body with `formData()`, and the adapter's 413
	// thrown out of that was a 500 there too; so was a body not sent as a form,
	// which is now a 400, `The request body is not a form`, there and on the
	// attachment upload alike. Nothing outside /api/ reads a body as JSON, so
	// the JSON rules change nothing for a page.
	//
	// A request the server makes of itself is guarded, and not limited.
	const handOn: ResolveFn = async (handed, opts) => {
		if (handed.isSubRequest) {
			guardBody(handed.request);
			return await resolve(handed, opts);
		}
		const limit = bodyLimit(path, method, callerOf(handed.locals.user));
		const tooLargeNow = refuseBody(handed.request, limit);
		if (tooLargeNow) return tooLargeNow;

		const request = heldToLimit(handed.request, limit);
		guardBody(request);
		return await resolve(request === handed.request ? handed : { ...handed, request }, opts);
	};

	// Static assets pass through immediately, unlogged: see passesThrough. A
	// request refused on the way, a remote call included, is an answer like any
	// other, and is logged below.
	if (!refused && passesThrough(path)) {
		return secured(await handOn(event), event.route.id);
	}

	const start = Date.now();
	// Unavailable during prerendering, and behind a misconfigured proxy: the
	// request is logged without it, and the v1 branch counts it as unknown.
	const ip = addressOf(event);

	let response: Response;
	try {
		// A remote call, or a body that will not be read, is answered here, in
		// place of everything handleRequest would have done, and is logged
		// below like any other.
		response = refused ?? (await handleRequest(event, handOn, path, ip));
	} catch (err) {
		// `resolve` never throws: SvelteKit makes an answer of whatever a
		// handler or a page throws, and `handleError` below is told of it. So
		// what is caught here is a fault in the gate itself, a database that
		// cannot be read as a session is looked up above all. It is written
		// down here, once, with what the gate knows of the request, and thrown
		// on for SvelteKit to answer 500. `handleError` is then called with
		// the same error and leaves it, so that it is not written down twice.
		const durationMs = Date.now() - start;
		const fault = describeFault(err);
		log.error(
			`${method} ${sent} → unhandled error: ${fault.error} (${durationMs}ms)`,
			{ method, path: sent, route: event.route.id, durationMs, ...fault },
			{ userId: event.locals.user?.id ?? null, ip }
		);
		if (typeof err === 'object' && err !== null) loggedByTheGate.add(err);
		throw err;
	}

	const durationMs = Date.now() - start;
	// The status that is sent. The 404 for an unknown v1 route and the JSON
	// put in place of an answer that was not JSON are made in handleRequest,
	// so there is no later step that could send another.
	const status = response.status;
	// A redirect is written down with where it sent the caller: a request
	// that carried a cookie and is sent to /login is the evidence of being
	// logged out. A page's script is sent on with a 200 that says where, and
	// is written down as the 200 it was sent, with where.
	const location = whereSent(response);
	// A refusal of a write that is not from DumpFire's own page carries the two
	// headers it was decided on, cut and made printable (card 2700, R4). It is
	// made before the session is read, so the line names the session's user by
	// a read that writes nothing and slides no expiry (`openSessionUser`):
	// whose session a forged write rode on is what an investigation asks.
	const seen = refusalSeen(response);
	const sentCode = seen === undefined ? undefined : readSessionCookie(event.request, event.url);
	const userId =
		seen === undefined
			? (event.locals.user?.id ?? null)
			: (openSessionUser(sentCode === undefined ? undefined : sessionTokenHash(sentCode))?.id ?? null);
	const fields = { userId, ip };
	const meta = { method, path: sent, status, ...(location === null ? {} : { location }), durationMs, ...seen };
	const line = `${method} ${sent} → ${status}${location === null ? '' : ` redirect to ${location}`} (${durationMs}ms)`;

	if (status >= 500) log.error(line, meta, fields);
	else if (status >= 400) log.warn(line, meta, fields);
	else log.info(line, meta, fields);

	// A session cookie of the plain name, sent where cookies are HTTPS-only,
	// names a session ended at the release: deleted on this answer, whoever
	// made it (card 2775, decision 13). The gate's own answers never pass
	// through `event.cookies`, so the header is added here, where every logged
	// answer passes.
	const oldCookie = oldSessionCookieDeletion(event.request, event.url);
	if (oldCookie !== null) response.headers.append('set-cookie', oldCookie);

	// A remote call's route is the one its caller named in a header (see
	// noRemoteFunctions), so it is headed as no route at all: naming a page
	// that may be framed does not make the 404 frameable.
	return secured(response, remoteCall ? null : event.route.id);
};

/**
 * What SvelteKit answers, and what is written down, when something fails that
 * nobody refused: a handler or a page's load threw, the gate itself failed,
 * or there is no route for the path. SvelteKit calls this with the error,
 * the status it will answer (it cannot be changed here) and its own message
 * for that status: "Not Found" for a path that is no route, "Internal Error"
 * for a fault. A handler's `error(404, ...)` is a refusal and never comes
 * here.
 *
 * A fault, a status of 500 or more, is written to the system log at ERROR,
 * with what the exception said and where (its stack), the route and the
 * user. Before this hook, SvelteKit wrote the stack to the console and the
 * system log had only the gate's line, "→ 500", with no reason. A 404 is not
 * a fault, and the gate's own line for it is enough.
 *
 * The caller is answered SvelteKit's message for the status and nothing of
 * the exception: `{ message: 'Internal Error' }`, as before.
 *
 * Its body cannot throw. A throw from here would leave SvelteKit's answer
 * unmade, and in the node adapter be an unhandled rejection. So whatever goes
 * wrong in writing the line down is let go, and the answer is made all the
 * same.
 */
export const handleError: HandleServerError = ({ error, event, status, message }) => {
	try {
		const already = typeof error === 'object' && error !== null && loggedByTheGate.has(error);
		if (status >= 500 && !already) {
			const method = event.request.method;
			// As the gate writes it: an invite's address with its token masked.
			const sent = pathToLog(event.url.pathname, routedPath(event) ?? event.url.pathname);
			const fault = describeFault(error);
			log.error(
				`${method} ${sent} → ${status}: ${fault.error}`,
				{ method, path: sent, route: event.route.id, status, ...fault },
				{ userId: event.locals.user?.id ?? null, ip: addressOf(event) }
			);
		}
	} catch {
		// The line could not be written. Nothing more can be done about it here.
	}
	return { message };
};
