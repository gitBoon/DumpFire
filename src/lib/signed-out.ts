/**
 * signed-out.ts — what a page does when the server tells it that its session
 * has ended: it goes to the login page, once.
 *
 * The gate answers 401 when a page's script asks an internal API route for
 * something and there is no session (src/hooks.server.ts). It used to send
 * the request to the login page, which `fetch` followed, so the script was
 * handed the login page's HTML with a 200 and the page went on as if its
 * request had worked. A 401 is a failure a script can see. Something has to
 * act on it, and there are well over a hundred calls of `fetch` in the pages
 * and components, with no wrapper in common. So the one place that sees every
 * answer is `fetch` itself: `src/hooks.client.ts` puts `watchForSignOut` in
 * its place once, when the app starts in the browser.
 *
 * It acts on a 401 only where a 401 means that this page's session has
 * ended:
 *
 *   - the request went to this page's own server, under /api/;
 *   - not under /api/v1/, which is answered by a key and never by a session;
 *   - not under /api/requests, the public request form's routes. A requester
 *     who is not signed in is answered 401 there when the form's token has
 *     lapsed, and is not to be sent to a login page they have no account for;
 *   - and the page has a signed-in user. The login page, set-up and the public
 *     request pages have none.
 *
 * And once: the first such 401 starts the way to the login page, and the
 * rest, which a page with several requests in flight will have, are left.
 * The answer itself is handed back untouched, to the code that asked.
 *
 * This file is given what it needs and reaches for nothing in the browser,
 * so that the tests, which have no browser, can call it.
 */

/** `fetch`, as this file calls it and hands it back. */
export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** What the watch needs to know of the page it is in, and how it sends it to sign in. */
export type WatchedPage = {
	/** The page's own address, `location.href`: what a relative address is read against. */
	address: () => string;
	/** Whether the page has a signed-in user. */
	signedIn: () => boolean;
	/** Go to the login page. */
	toLogin: () => void;
};

/**
 * Whether a 401 to a request for `input`, made from the page at
 * `pageAddress`, says that the page's session has ended. See the list above.
 */
export function endsTheSession(input: RequestInfo | URL, pageAddress: string): boolean {
	let url: URL;
	let page: URL;
	try {
		const asked = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
		page = new URL(pageAddress);
		url = new URL(asked, page);
	} catch {
		// An address that cannot be read is not one of ours.
		return false;
	}
	if (url.origin !== page.origin) return false;

	const path = url.pathname;
	if (!path.startsWith('/api/')) return false;
	if (path.startsWith('/api/v1/')) return false;
	if (path === '/api/requests' || path.startsWith('/api/requests/')) return false;
	return true;
}

/**
 * `fetch`, watched: the same answers, and the page sent to sign in on the
 * first 401 that says its session has ended. Nothing the watch does can make
 * a request fail that would not have.
 */
export function watchForSignOut(fetch: Fetch, page: WatchedPage): Fetch {
	let sent = false;

	return async (input, init) => {
		const response = await fetch(input, init);
		try {
			if (!sent && response.status === 401 && endsTheSession(input, page.address()) && page.signedIn()) {
				sent = true;
				page.toLogin();
			}
		} catch {
			// The watch is not the request. Whatever went wrong in it, the
			// answer is the caller's as it came.
		}
		return response;
	};
}
