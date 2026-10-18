/**
 * webhook-address.ts — where a webhook may send (card 2161).
 *
 * A webhook is a request this server makes to an address a caller typed. Left
 * to itself it would send a board's events to anything the server can reach
 * and the caller cannot: this server (loopback), the Docker host and its other
 * containers, the office or cloud network, and the cloud metadata service at
 * 169.254.169.254. So an address inside the network is refused, at
 * registration as written and at delivery as written and as resolved.
 *
 *   - `insideReason(address)` is the one judgement of an IP address, for
 *     registration and delivery alike: the IANA special-purpose addresses that
 *     are not globally reachable, condensed into the two tables below.
 *   - `addressRefusal(url)` judges an address as written: credentials, an
 *     inside IP, or a name that is inside whatever it resolves to.
 *   - `guardedLookup` is set on the webhooks' own agents (webhooks.ts), so the
 *     address checked is the address connected to: every address a name
 *     resolves to is judged at the moment the connection is made, and one
 *     inside refuses the connection (DNS rebinding included).
 *   - `allowInside()` reads `WEBHOOK_ALLOW_INSIDE`, which lets an installation
 *     with a genuine receiver inside name it.
 *
 * Addresses are read here into numbers and compared by prefix, by family,
 * never with `net.BlockList`: its `check` takes an IPv6 address it is not told
 * is IPv6 for an IPv4 one it cannot read, and answers "not listed" (the plan's
 * R-M1). An address that `net.isIP` cannot read is inside.
 */
import dns from 'node:dns';
import net from 'node:net';
import { error } from '@sveltejs/kit';
import { readUrl, type RequestBody, type UrlRule } from './request-body';

// ─── Addresses as numbers ─────────────────────────────────────────────────

type Family = 4 | 6;
const WIDTH: Record<Family, number> = { 4: 32, 6: 128 };

/** An IPv4 address `net.isIP` has read (four decimal parts), as a number. */
function v4Bits(address: string): bigint {
	return address.split('.').reduce((bits, part) => (bits << 8n) | BigInt(Number(part)), 0n);
}

function v4Text(bits: bigint): string {
	return [24n, 16n, 8n, 0n].map((shift) => String((bits >> shift) & 0xffn)).join('.');
}

/**
 * An IPv6 address `net.isIP` has read, as a number: the zone is dropped, an
 * IPv4 tail (`::ffff:127.0.0.1`) is read as the two groups it is, and `::`
 * is as many zero groups as are missing.
 */
function v6Bits(address: string): bigint {
	let text = address.split('%')[0];
	const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
	if (tail) {
		const v4 = v4Bits(tail[1]);
		text = `${text.slice(0, -tail[1].length)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
	}
	const [head, rest] = text.includes('::') ? text.split('::') : [text, undefined];
	const before = head ? head.split(':') : [];
	const after = rest ? rest.split(':') : [];
	const groups = rest === undefined ? before : [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
	return groups.reduce((bits, group) => (bits << 16n) | BigInt(parseInt(group, 16)), 0n);
}

type Range = { family: Family; bits: bigint; prefix: number };

function inRange(family: Family, bits: bigint, range: Range): boolean {
	if (family !== range.family) return false;
	const shift = BigInt(WIDTH[family] - range.prefix);
	return bits >> shift === range.bits >> shift;
}

function range(text: string): Range {
	const [address, prefix] = text.split('/');
	const family = net.isIP(address) as Family;
	return { family, bits: family === 4 ? v4Bits(address) : v6Bits(address), prefix: Number(prefix) };
}

// ─── What is inside ───────────────────────────────────────────────────────

type Row = Range & { what: string; text: string };
const row = (text: string, what: string): Row => ({ ...range(text), what, text });

/** IPv4 addresses that are inside, with what each is. */
const V4_ROWS: Row[] = [
	row('0.0.0.0/8', 'a "this network" address, which reaches this server'),
	row('10.0.0.0/8', 'a private network address'),
	row('100.64.0.0/10', 'a shared address (carrier NAT, Tailscale)'),
	row('127.0.0.0/8', 'a loopback address'),
	row('169.254.0.0/16', 'a link-local address, where the cloud metadata service is'),
	// Docker's own networks are in here.
	row('172.16.0.0/12', 'a private network address'),
	row('192.0.0.0/24', 'an IETF protocol address'),
	row('192.0.2.0/24', 'a documentation address'),
	row('192.88.99.0/24', 'a 6to4 relay address'),
	row('192.168.0.0/16', 'a private network address'),
	row('198.18.0.0/15', 'a benchmarking address'),
	row('198.51.100.0/24', 'a documentation address'),
	row('203.0.113.0/24', 'a documentation address'),
	row('224.0.0.0/4', 'a multicast address'),
	row('240.0.0.0/4', 'a reserved address')
];

/**
 * IPv6 addresses that are inside, the first that matches naming it. The three
 * forms that hold an IPv4 address (mapped `::ffff:0:0/96`, NAT64
 * `64:ff9b::/96` and 6to4 `2002::/16`) are not here: each is judged by the
 * IPv4 address it holds, before this list is read.
 */
const V6_ROWS: Row[] = [
	row('::/128', 'the unspecified address, which reaches this server'),
	row('::1/128', 'a loopback address'),
	row('64:ff9b:1::/48', 'a local-use NAT64 address'),
	// The rest of ::/8, which holds both NAT64 blocks: the retired
	// IPv4-compatible form and SIIT's ::ffff:0:0:0/96 among it.
	row('::/8', 'a reserved address'),
	row('100::/64', 'a discard-only address'),
	// Teredo (2001::/32) and benchmarking (2001:2::/48) among it.
	row('2001::/23', 'an IETF protocol address'),
	row('2001:db8::/32', 'a documentation address'),
	row('3fff::/20', 'a documentation address'),
	row('5f00::/16', 'an SRv6 identifier'),
	row('fc00::/7', 'a unique local address (a private network)'),
	row('fe80::/10', 'a link-local address'),
	row('fec0::/10', 'a site-local address'),
	row('ff00::/8', 'a multicast address')
];

/** The row of the rest of ::/8, which an allow entry may not be inside. */
const RESERVED_V6 = V6_ROWS.find((r) => r.text === '::/8')!;

/**
 * The two addresses that reach this server whatever it listens on, which no
 * allow entry may hold, though one row holds the whole entry: `0.0.0.0/8` lies
 * wholly inside its row. A loopback address is not here: `127.0.0.1` or `::1`
 * named alone is a receiver on this server, allowed on purpose (a development
 * installation's own); any wider entry that holds `::1` holds `::` as well.
 */
const THIS_SERVER: Row[] = [row('0.0.0.0/32', V4_ROWS[0].what), V6_ROWS[0]];

const MAPPED = range('::ffff:0:0/96');
const NAT64 = range('64:ff9b::/96');
const SIX_TO_FOUR = range('2002::/16');

/** The IPv4 address an IPv6 one holds, in the mapped, NAT64 or 6to4 form, or null. */
function heldV4(bits: bigint): bigint | null {
	if (inRange(6, bits, MAPPED) || inRange(6, bits, NAT64)) return bits & 0xffffffffn;
	if (inRange(6, bits, SIX_TO_FOUR)) return (bits >> 80n) & 0xffffffffn;
	return null;
}

const firstRow = (rows: Row[], family: Family, bits: bigint) => rows.find((r) => inRange(family, bits, r));

/** An address as a family and a number, an IPv6 one that holds an IPv4 address as that; null if it is not one. */
function judged(address: string): { family: Family; bits: bigint; held?: true } | null {
	const family = net.isIP(address);
	if (family === 4) return { family, bits: v4Bits(address) };
	if (family !== 6) return null;
	const bits = v6Bits(address);
	const v4 = heldV4(bits);
	return v4 === null ? { family, bits } : { family: 4, bits: v4, held: true };
}

/**
 * Why an IP address is inside the network, as words that follow "is", or null
 * when it is outside. The one judgement for registration and delivery alike.
 *
 * An IPv6 address that holds an IPv4 one is judged by that. An address that is
 * not one at all is inside: a "no" is never trusted for an address that was
 * not read first.
 */
export function insideReason(address: string): string | null {
	const read = judged(address);
	if (read === null) return 'not an address';
	const found = firstRow(read.family === 4 ? V4_ROWS : V6_ROWS, read.family, read.bits);
	if (!found) return null;
	return read.held ? `${found.what} (it holds ${v4Text(read.bits)})` : found.what;
}

// ─── WEBHOOK_ALLOW_INSIDE ─────────────────────────────────────────────────

export type AllowInside = {
	/** Host names, in lower case with every final dot removed. */
	names: Set<string>;
	ranges: Range[];
	/** The entries ignored, each with why. */
	bad: { entry: string; why: string }[];
};

/** A host name as compared: lower case, every final dot removed (`LOCALHOST..` is `localhost`). */
const asName = (host: string) => host.toLowerCase().replace(/\.+$/, '');

/** A label of a host name the list takes. The URL parser has made any other script `xn--`. */
const HOST_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/** One entry of the list read, or why it is ignored. */
function allowEntry(entry: string): { name: string } | { range: Range } | { why: string } {
	const slash = entry.indexOf('/');
	const written = slash < 0 ? entry : entry.slice(0, slash);
	const address = written.startsWith('[') && written.endsWith(']') ? written.slice(1, -1) : written;
	const family = net.isIP(address) as Family | 0;

	if (family === 0) {
		const notTaken = { why: 'not a host name, an address or a range (a port, a path or a wildcard is not taken)' };
		if (slash >= 0) return notTaken;
		// Read the way the URL parser reads a host: `127.1` is 127.0.0.1 to it,
		// and would match nothing as a name, without a word.
		let host: string;
		try {
			host = new URL(`http://${entry}/`).hostname;
		} catch {
			return notTaken;
		}
		if (net.isIP(host) === 4) return { why: 'an IPv4 address not written as four decimal numbers' };
		const name = asName(host);
		if (/[:/@*?#\\[\]\s]/.test(entry) || !HOST_NAME.test(name)) return notTaken;
		return { name };
	}

	const width = WIDTH[family];
	const prefixText = slash < 0 ? String(width) : entry.slice(slash + 1);
	if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > width) return { why: 'its range is not a number of bits' };
	let prefix = Number(prefixText);
	let bits = family === 4 ? v4Bits(address) : v6Bits(address);
	let at: Family = family;
	// Written in a form that holds an IPv4 address, with too short a prefix to
	// be read as the IPv4 range it means: `::ffff:10.0.5.0/24` is `::/24`, which
	// holds `::1`, and allowed it.
	if (family === 6 && prefix < MAPPED.prefix) {
		if (inRange(6, bits, MAPPED)) return { why: 'an IPv4-mapped range needs /96 or more' };
		if (inRange(6, bits, NAT64)) return { why: 'a NAT64 range needs /96 or more' };
	}
	// A range of the forms that hold an IPv4 address is the range of IPv4
	// addresses it holds, matched as those are.
	if (family === 6) {
		const holding = [MAPPED, NAT64].find((r) => prefix >= r.prefix && inRange(6, bits, r));
		if (holding) {
			at = 4;
			bits &= 0xffffffffn;
			prefix -= 96;
		} else if (prefix >= SIX_TO_FOUR.prefix && inRange(6, bits, SIX_TO_FOUR)) {
			at = 4;
			bits = (bits >> 80n) & 0xffffffffn;
			prefix = Math.min(prefix - 16, 32);
		}
	}
	const shift = BigInt(WIDTH[at] - prefix);
	const kept: Range = { family: at, bits: (bits >> shift) << shift, prefix };
	// Kept only if it lies wholly inside one row: a slip such as 10.0.0.0/2
	// for /24, or 0.0.0.0/0, would let every webhook reach this server and the
	// metadata service.
	const rows = at === 4 ? V4_ROWS : V6_ROWS;
	const holder = rows.findIndex((r) => prefix >= r.prefix && inRange(at, kept.bits, r));
	if (holder >= 0) {
		const holds = (r: Range) => r.family === at && r.prefix >= prefix && inRange(at, r.bits, kept);
		// Nor may it hold an address that reaches this server, though one row
		// holds it all: `0.0.0.0/8` is the "this network" row itself.
		const server = THIS_SERVER.find(holds);
		if (server) return { why: `it holds ${server.text.split('/')[0]}, ${server.what}` };
		// Nor a row placed before the row that holds it, which a narrower entry
		// would have been judged by.
		const before = rows.slice(0, holder).find(holds);
		if (before) return { why: `it holds ${before.text}, ${before.what}` };
		// The rest of ::/8 is reserved: an IPv4-compatible range (`::10.0.5.0/120`)
		// allows nothing a receiver is on.
		if (rows[holder] === RESERVED_V6) return { why: 'a reserved range inside ::/8 (an IPv4-mapped range needs /96 or more)' };
		return { range: kept };
	}
	const overlaps = rows.some((r) => inRange(at, kept.bits, { ...r, prefix: Math.min(r.prefix, prefix) }));
	return { why: overlaps ? 'wider than one inside range' : 'not inside the network, so it allows nothing' };
}

/** Read a value of `WEBHOOK_ALLOW_INSIDE`. Writes nothing: start-up names the bad entries (startup-checks.ts). */
export function parseAllowInside(value: string): AllowInside {
	const read: AllowInside = { names: new Set(), ranges: [], bad: [] };
	for (const entry of value.split(',').map((e) => e.trim()).filter((e) => e !== '')) {
		const one = allowEntry(entry);
		if ('name' in one) read.names.add(one.name);
		else if ('range' in one) read.ranges.push(one.range);
		else read.bad.push({ entry, why: one.why });
	}
	return read;
}

let memo: { value: string; read: AllowInside } | null = null;

/**
 * What `WEBHOOK_ALLOW_INSIDE` allows: host names (exact, case ignored, final
 * dots removed) and addresses or ranges (`10.0.5.20`, `10.0.5.0/24`,
 * `fd00::/8`, `[fd00::1]`), comma-separated. Read again only when the value
 * changes, which tests use.
 *
 * A name in it is allowed whatever it resolves to inside but `0.0.0.0/8` and
 * `::` (a listed name is never let reach either), and passes the name rules.
 * An address in either is refused whatever range is listed.
 * An address or range lets in any address inside it, written or resolved, of
 * its own family. An entry that does not read, or is not wholly inside one row
 * of the tables, is ignored, and the rest applies. So is one that holds
 * `0.0.0.0` or `::`, or a row placed before the row that holds it, one inside
 * the reserved rest of `::/8`, and an IPv4-mapped or NAT64 range under /96: each
 * of those let in `::1` or `0.0.0.0`, this server, beside what it named.
 */
export function allowInside(value: string = process.env.WEBHOOK_ALLOW_INSIDE ?? ''): AllowInside {
	if (memo?.value !== value) memo = { value, read: parseAllowInside(value) };
	return memo.read;
}

function allowedAddress(address: string): boolean {
	const read = judged(address);
	return read !== null && allowInside().ranges.some((r) => inRange(read.family, read.bits, r));
}

/** `0.0.0.0/8` and `::`: an address in either (in any form that holds one) reaches this server, whatever is allowed. */
const NEVER_ALLOWED: Row[] = [V4_ROWS[0], V6_ROWS[0]];

/**
 * Why an address reaches this server whatever `WEBHOOK_ALLOW_INSIDE` says, or
 * null. A DNS filter answers `0.0.0.0` (or `::`) for a name it blocks, so a
 * listed name filtered that way would otherwise be sent to this server.
 */
function thisServerReason(address: string): string | null {
	const read = judged(address);
	if (read === null || !NEVER_ALLOWED.some((r) => inRange(read.family, read.bits, r))) return null;	return insideReason(address);
}

/** Why an IP address may not be sent to, as words that follow "is", or null when it may. */
function refusedAddress(address: string): string | null {
	const why = insideReason(address);
	if (why === null) return null;
	return thisServerReason(address) !== null || !allowedAddress(address) ? why : null;
}

// ─── An address as written ────────────────────────────────────────────────

/** Why a name is inside whatever it resolves to (decision 3), or null. */
function nameReason(name: string): string | null {
	if (name === 'localhost' || name.endsWith('.localhost')) return `${name} is this server`;
	if (!name.includes('.')) return `${name} is a name with no dot, which is looked up inside the network`;
	if (name.endsWith('.local')) return `${name} is a name on the local link (.local)`;
	if (name.endsWith('.internal')) return `${name} is a name kept for private networks (.internal)`;
	if (name.endsWith('.home.arpa')) return `${name} is a home network name (.home.arpa)`;
	return null;
}

export type AddressRefusal = {
	/** Registration answers each in its own words. */
	kind: 'credentials' | 'inside';
	/** What is wrong, naming the host and never the path or the query. */
	reason: string;
};

/**
 * Why an address as written may not be sent to, or null when it may (it is
 * then judged again at delivery, by what it resolves to).
 *
 * A user name or password is always refused: `http.request` would send the
 * pair as Basic authentication, and a receiver that wants a credential reads
 * the signature. An IP address is judged by `insideReason`, and a name by the
 * names that are inside whatever they resolve to, unless `WEBHOOK_ALLOW_INSIDE`
 * names it. No name is looked up here.
 */
export function addressRefusal(url: URL): AddressRefusal | null {
	if (url.username !== '' || url.password !== '') {
		return { kind: 'credentials', reason: `the address for ${url.host} carries a user name or password` };
	}
	const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
	if (net.isIP(host)) {
		const why = refusedAddress(host);
		return why === null ? null : { kind: 'inside', reason: `${url.hostname} is ${why}` };
	}
	const name = asName(host);
	// The URL parser keeps `a..b` and a name of dots alone as names.
	if (name === '' || name.split('.').includes('')) {
		return { kind: 'inside', reason: `${url.hostname} is a name with an empty label` };
	}
	if (allowInside().names.has(name)) return null;
	const why = nameReason(name);
	return why === null ? null : { kind: 'inside', reason: why };
}

/**
 * The `url` of a webhook's body, as card 2117's reader reads it, refused 400
 * if `addressRefusal` refuses it (registration, decision 4). A value equal to
 * `rule.keep`, the address stored, is accepted unchanged (2117 decision 8), so
 * a row stored before this rule can be saved with its address sent back.
 */
export function readWebhookUrl<R extends UrlRule>(body: RequestBody, rule: R): string | undefined {
	const url = readUrl(body, 'url', rule) as string | null | undefined;
	if (typeof url !== 'string' || (rule.keep !== undefined && url === rule.keep)) return url ?? undefined;
	const refusal = addressRefusal(new URL(url));
	if (refusal?.kind === 'credentials') throw error(400, 'Webhook url must not carry a user name or password');
	if (refusal) throw error(400, `Webhook url points inside the network: ${refusal.reason}`);
	return url;
}

// ─── At the connection ────────────────────────────────────────────────────

type LookupAnswer = { address: string; family: number };
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAnswer[], family?: number) => void;

/**
 * The `lookup` of the webhooks' own agents. Asks `dns.lookup` for every
 * address of the name, through the module object (so a test's stand-in
 * applies), and refuses with code `EWEBHOOKINSIDE` if any of them is inside
 * and not allowed: a name that answers one address outside and one inside is
 * what a rebinding attack looks like, and the connection may be made to
 * either. A name `WEBHOOK_ALLOW_INSIDE` lists is refused only for an address
 * in `0.0.0.0/8` or `::`, which a DNS filter answers for a name it blocks.
 * Otherwise answers in the form asked: the list when `options.all` is
 * set, as Node 22 asks, the first address otherwise.
 *
 * Node makes no lookup for a host that is an IP address: webhooks.ts judges
 * that one as written, before the request.
 */
export function guardedLookup(
	hostname: string,
	options: dns.LookupOptions | number | LookupCallback,
	callback?: LookupCallback
): void {
	const done = (typeof options === 'function' ? options : callback) as LookupCallback;
	const asked: dns.LookupOptions = typeof options === 'object' && options !== null ? options : typeof options === 'number' ? { family: options } : {};
	dns.lookup(hostname, { ...asked, all: true }, (err, addresses) => {
		if (err) return done(err, []);
		if (addresses.length === 0) {
			return done(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }), []);
		}
		// A listed name is let resolve anywhere inside but 0.0.0.0/8 and `::`.
		const judge = allowInside().names.has(asName(hostname)) ? thisServerReason : refusedAddress;
		for (const { address } of addresses) {
			const why = judge(address);
			if (why !== null) {
				return done(Object.assign(new Error(`${hostname} resolves to ${address}, ${why}`), { code: 'EWEBHOOKINSIDE' }), []);
			}
		}
		if (asked.all) done(null, addresses);
		else done(null, addresses[0].address, addresses[0].family);
	});
}
