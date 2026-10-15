/**
 * hooks.client.ts — what the application does once, when it starts in the
 * browser.
 *
 * One thing: `fetch` is watched for the answer that says this page's session
 * has ended, and the page is sent to the login page when it comes. The gate
 * answers a page's script 401 for an internal API route with no session
 * (src/hooks.server.ts). Which 401s count, and why only once, is in
 * $lib/signed-out.ts.
 *
 * `window.fetch` is replaced, and not wrapped by each caller, because there
 * is no one place every page calls: the pages and components call `fetch`
 * directly, well over a hundred times. SvelteKit's own requests for a page's
 * data do not go through it, and need not: the gate sends those to the login
 * page in the way SvelteKit's router follows.
 *
 * The page has a signed-in user when the root layout's data has one
 * (src/routes/+layout.server.ts), which is read at the moment of the 401 and
 * not before. The login page is opened as a new page, so that nothing of the
 * page whose session ended is left running.
 */
import { page } from '$app/state';
import type { ClientInit } from '@sveltejs/kit';
import { watchForSignOut } from '$lib/signed-out';

export const init: ClientInit = () => {
	window.fetch = watchForSignOut(window.fetch.bind(window), {
		address: () => window.location.href,
		signedIn: () => Boolean(page.data?.user),
		toLogin: () => window.location.assign('/login')
	});
};
