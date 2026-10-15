/**
 * client-address.ts — the caller's address, asked so that it cannot throw.
 *
 * `getClientAddress()` throws during prerendering, and in a built server
 * started with `ADDRESS_HEADER` set it throws for every request that arrives
 * without that header: one sent to the container's port directly, past the
 * proxy that adds it. Asked unguarded, that throw was a 500, and on the login
 * form it was a 500 for everybody who tried to sign in that way. So it is
 * asked here, and nowhere else but the logout page
 * (src/routes/logout/+page.server.ts), which asks it for its two log lines,
 * each inside a try of its own, and logs no address where there is none.
 */
import type { RequestEvent } from '@sveltejs/kit';

/** What a request whose address cannot be read is counted against. */
export const UNKNOWN_ADDRESS = 'unknown';

/** The caller's address, or null where there is none to be had. */
export function addressOf(event: Pick<RequestEvent, 'getClientAddress'>): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

/**
 * The address a rate limit counts this request against: the caller's, or
 * `'unknown'` where it cannot be read. A request with no address is never let
 * past a limit uncounted: it shares one count with every other request whose
 * address cannot be read, as the v1 branch of the gate counts it.
 */
export function addressToCount(event: Pick<RequestEvent, 'getClientAddress'>): string {
	return addressOf(event) ?? UNKNOWN_ADDRESS;
}
