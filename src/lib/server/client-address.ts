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
 *
 * What a limit counts is not the address as received but its key
 * (`addressKey`, card 2195): an IPv6 address by its /64, the network one
 * host or one household is given, so that a caller holding a /64 does not
 * have 2^64 allowances; an IPv4 address written as IPv6 by the IPv4 address;
 * and no port, since every connection has a port of its own. Sign-in, the
 * public request form's three routes (`addressToCount`) and the gate's count
 * of v1 requests with no key all count by it. Every log line keeps the
 * address as received.
 */
import { isIP } from 'node:net';
import type { RequestEvent } from '@sveltejs/kit';

/** What a request whose address cannot be read is counted against. */
export const UNKNOWN_ADDRESS = 'unknown';

/** The most characters of something that is no address that a key keeps, so that a key's size is bounded. */
const MOST_KEPT = 100;

/**
 * The eight 16-bit groups of an IPv6 address that `isIP` accepts, with a
 * dotted IPv4 address at its end (`::ffff:198.51.100.7`,
 * `64:ff9b::198.51.100.7`) read as the last two.
 */
function groupsOf(address: string): number[] {
	let text = address.toLowerCase();
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number);
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	// `isIP` allows one `::` at most: it stands for as many zero groups as make eight.
	const [head, tail] = text.split('::');
	const before = head ? head.split(':') : [];
	const after = tail ? tail.split(':') : [];
	const zeros = tail === undefined ? [] : Array<string>(8 - before.length - after.length).fill('0');
	return [...before, ...zeros, ...after].map((group) => parseInt(group, 16));
}

/**
 * What a limit counts `address` against (card 2195):
 *
 *   - `unknown` stays `unknown`.
 *   - A port is taken off (`198.51.100.7:51234`, `[2001:db8::1]:443`), as is
 *     a zone (`fe80::1%eth0`). A port only from what is no address as it
 *     stands: `fe80::1` is one, and ends in a group, not a port.
 *   - IPv4: as it is.
 *   - IPv4 written as IPv6 (`::ffff:198.51.100.7`, `::ffff:c633:6407`): the
 *     IPv4 address, so that one caller is one count however the proxy wrote it.
 *   - Any other IPv6: its first four groups, which are its /64, as
 *     `2001:db8:1:2::/64`.
 *   - Anything else: as received, cut to 100 characters.
 */
export function addressKey(address: string): string {
	if (address === UNKNOWN_ADDRESS) return address;

	let bare = address;
	if (isIP(bare) === 0) {
		const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(bare);
		const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(bare);
		if (bracketed) bare = bracketed[1];
		else if (withPort) bare = withPort[1];
	}
	if (bare.includes(':') && bare.includes('%')) bare = bare.slice(0, bare.indexOf('%'));

	const kind = isIP(bare);
	if (kind === 4) return bare;
	if (kind === 6) {
		const groups = groupsOf(bare);
		if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
			return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
		}
		return `${groups
			.slice(0, 4)
			.map((group) => group.toString(16))
			.join(':')}::/64`;
	}
	return address.slice(0, MOST_KEPT);
}

/** The caller's address, or null where there is none to be had. */
export function addressOf(event: Pick<RequestEvent, 'getClientAddress'>): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

/**
 * The address a rate limit counts this request against: the caller's, by
 * `addressKey`, or `'unknown'` where it cannot be read. A request with no
 * address is never let past a limit uncounted: it shares one count with every
 * other request whose address cannot be read, as the v1 branch of the gate
 * counts it.
 */
export function addressToCount(event: Pick<RequestEvent, 'getClientAddress'>): string {
	return addressKey(addressOf(event) ?? UNKNOWN_ADDRESS);
}
