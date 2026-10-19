/**
 * ssh-host-key.ts — an SFTP destination's host key, as it is typed, stored,
 * shown and checked (card 2250).
 *
 * An SFTP destination connected to whatever answered for its host: ssh2
 * accepts any host key when it is given no verifier, and the password, or a
 * signature made with the private key, goes once the handshake is complete.
 * So a destination holds the key it was confirmed with, `hostKey`, as one text
 * in the `backup_config` setting's JSON beside its other fields:
 *
 *     ssh-ed25519 SHA256:s16t1ixxsjxOgoaXCXACvAIOEG1K5biSlM7GekmavrY
 *
 * the key's type and its fingerprint as OpenSSH prints it (`SHA256:` and the
 * unpadded standard base64 of SHA-256 over the key's blob), which is what an
 * administrator can compare by eye with `ssh-keygen -l` on the server. Empty,
 * or absent, for none.
 *
 * It is read from either form an administrator copies (`readHostKey`, the
 * plan's R5): that text, or the line `ssh-keygen -l` prints, pasted whole
 * (`256 SHA256:… root@nas (ED25519)`). A fingerprint without its type is
 * refused: the type is what every connect pins (`pinFor`), so that a server
 * that gains a key of a type ssh2 prefers does not look changed.
 *
 * Nothing here connects, and nothing is imported: a key's blob is read as the
 * SSH wire format writes it (RFC 4253, section 6.6), its type the first string.
 */
import { createHash } from 'node:crypto';

/** The host key types a destination may be confirmed with, as a key's blob names them. */
export const HOST_KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa'] as const;

export type HostKeyType = (typeof HOST_KEY_TYPES)[number];

/** A host key read: its type and its fingerprint, `SHA256:` and 43 characters. */
export type HostKey = { type: HostKeyType; fingerprint: string };

/**
 * What `runBackup`, Backup History, the failure mail and an upload, listing or
 * delete say of an SFTP destination with no confirmed key (decision 6, R7).
 * Every host key failure says what happened in its first 40 characters, all
 * Backup History shows of a message (the card 2250 review's S2): "SFTP host
 * key not confirmed: " here and in a Test's first look, "SFTP host key
 * refused: " for a key that did not match, a type no longer offered and a
 * signature that failed.
 */
export const HOST_KEY_NOT_CONFIRMED =
	'SFTP host key not confirmed: nothing was sent to this destination. In Admin, Scheduled Backups, press Test on ' +
	'it and confirm the key it shows.';

/** The refusal of a host key that does not read, after `<at>.hostKey` (R5). */
export const HOST_KEY_REFUSAL =
	'must be an SSH host key fingerprint with its type: the line ssh-keygen -l prints (256 SHA256:… root@nas ' +
	'(ED25519)), or the type and fingerprint (ssh-ed25519 SHA256:…), the fingerprint being SHA256: and 43 characters';

const isHostKeyType = (type: string): type is HostKeyType => (HOST_KEY_TYPES as readonly string[]).includes(type);

/**
 * The 43 characters after `SHA256:`, or null where they are not a SHA-256 in
 * unpadded standard base64: `A-Z`, `a-z`, `0-9`, `+` and `/` only, and the text
 * the 32 bytes they decode to encode to again (so that the last character's
 * unused bits are 0, as OpenSSH writes it).
 */
function readFingerprint(text: string): string | null {
	if (!text.startsWith('SHA256:')) return null;
	const digits = text.slice('SHA256:'.length);
	if (!/^[A-Za-z0-9+/]{43}$/.test(digits)) return null;
	const bytes = Buffer.from(digits, 'base64');
	if (bytes.length !== 32 || bytes.toString('base64').replace(/=+$/, '') !== digits) return null;
	return text;
}

/**
 * The type `ssh-keygen -l` puts in brackets, and the bits it prints first, as
 * a key's blob names it; null for any other, and for an RSA key of fewer than
 * 1,024 bits, which no server should be trusted by (the card 2250 review's S5).
 */
function typeOfKeygen(bits: string, named: string): HostKeyType | null {
	switch (named) {
		case 'ED25519':
			return 'ssh-ed25519';
		case 'RSA':
			return Number(bits) >= 1024 ? 'ssh-rsa' : null;
		case 'ECDSA':
			return bits === '256' ? 'ecdsa-sha2-nistp256' : bits === '384' ? 'ecdsa-sha2-nistp384' : bits === '521' ? 'ecdsa-sha2-nistp521' : null;
		default:
			return null;
	}
}

/** Text trimmed of ASCII spaces, tabs and line breaks at either end, as a line copied from a terminal may come. */
const trimmed = (text: string) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

/**
 * A host key from either form an administrator copies (R5), or null where it
 * reads as neither:
 *
 *   - `<type> SHA256:<43>`, the type one of `HOST_KEY_TYPES`, spaces and tabs
 *     around and between them;
 *   - `<bits> SHA256:<43> <comment> (<TYPE>)`, as `ssh-keygen -l` prints it,
 *     the comment optional and possibly holding spaces: `ED25519`, `RSA`, and
 *     `ECDSA` of 256, 384 or 521 bits. Any other type (`DSA`, `ED25519-SK`,
 *     `ECDSA-SK`) is refused. The bits and the comment are dropped.
 *
 * Empty text is not a key either: the caller reads it as none.
 */
export function readHostKey(text: string): HostKey | null {
	const line = trimmed(text);
	const typed = /^([a-z0-9-]+)[ \t]+(\S+)$/.exec(line);
	if (typed) {
		const fingerprint = readFingerprint(typed[2]);
		return fingerprint !== null && isHostKeyType(typed[1]) ? { type: typed[1], fingerprint } : null;
	}
	const keygen = /^([0-9]+)[ \t]+(\S+)(?:[ \t].*)?[ \t]\(([^()]+)\)$/.exec(line);
	if (keygen) {
		const fingerprint = readFingerprint(keygen[2]);
		const type = typeOfKeygen(keygen[1], keygen[3]);
		return fingerprint !== null && type !== null ? { type, fingerprint } : null;
	}
	return null;
}

/** A host key as it is stored and shown: the type, one space, the fingerprint. */
export const hostKeyText = (key: HostKey): string => `${key.type} ${key.fingerprint}`;

/**
 * The key a destination's stored `hostKey` holds, or null for none. Stored
 * text is in the canonical form (`readDestination` writes nothing else), and
 * text that does not read is no key: a destination with it is held to what
 * one with none is, and nothing is sent to it.
 */
export function confirmedHostKey(stored: unknown): HostKey | null {
	return typeof stored === 'string' && stored !== '' ? readHostKey(stored) : null;
}

/** The fingerprint of a host key's blob, as OpenSSH prints it: `SHA256:` and the unpadded base64 of its SHA-256. */
export function fingerprintOf(blob: Buffer): string {
	return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** The type a host key's blob names, its first string; null for a blob too short to hold one. */
export function typeOf(blob: Buffer): string | null {
	if (blob.length < 4) return null;
	const length = blob.readUInt32BE(0);
	if (length === 0 || length > 64 || blob.length < 4 + length) return null;
	return blob.subarray(4, 4 + length).toString('latin1');
}

/** A host key's blob as a Test shows it: its type and fingerprint, `ssh-ed25519 SHA256:…`. */
export function shownHostKey(blob: Buffer): string {
	return `${typeOf(blob) ?? 'unknown'} ${fingerprintOf(blob)}`;
}

/**
 * The host key formats a connect offers for a key of `type`, so that the
 * server presents a key of that type and no other (decision 4): an RSA key
 * may be signed three ways, every other type one.
 */
export function pinFor(type: HostKeyType): string[] {
	return type === 'ssh-rsa' ? ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'] : [type];
}

/** The file on an OpenSSH server that holds its key of `type`: what `ssh-keygen -lf` is pointed at to check one. */
export function serverKeyFile(type: string | null): string {
	const kind = type === 'ssh-rsa' ? 'rsa' : type?.startsWith('ecdsa-') ? 'ecdsa' : 'ed25519';
	return `/etc/ssh/ssh_host_${kind}_key.pub`;
}
