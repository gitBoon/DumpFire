/**
 * api-key-revoke.ts — the revoke's body, one function for every way a key is revoked (card 2995, R7).
 *
 * The revoke on the Account page and the start's pass for a present key the record of ended keys names both run
 * `revokeApiKeys`, so that what a revoke ends is decided in one place: the key recorded and deleted, the webhooks it
 * set held `'key ended'`, and every webhook with a secret it was given held. Its own module, so that the one hold of
 * what a key was given (`holdRevealed`, webhooks.ts) is reached from one function (tests/check-at-the-write.test.ts).
 */
import { sqlite } from './db';
import { REVOKED_BECAUSE, endApiKeys, keyRecordedWhere, type RevokedBecause } from './key-revocations';
import { holdRevealed, markExposed, revealsOfKeys, seedRevealsOnce, switchOffLostWebhooks, type SwitchedOff } from './webhooks';

/** What revoking keys did (card 2995): the webhooks swept and held, each marked exposed where a key was given it. */
export type KeysRevoked = {
	/** The keys deleted, in order. */
	keyIds: number[];
	/** The webhooks the setters' sweep switched off, those the keys set among them (`'key ended'`). */
	swept: SwitchedOff[];
	/** The webhooks the keys were given the secret of, held (`holdRevealed`). */
	revealedHeld: { switchedOff: SwitchedOff[]; held: SwitchedOff[] };
	/** Everything switched off, and everything already off now held, to tell: each a key was given marked exposed (FP4). */
	switchedOff: SwitchedOff[];
	held: SwitchedOff[];
	/** How many reads the once-only reveal seed wrote, where it ran first here; null where it had run already. */
	seeded: number | null;
};

/**
 * Revoke `keys`, the revoke's body (card 2893, D5; card 2947, R3; card 2995, R7), inside the caller's transaction on
 * the server's connection: the reads made before they were recorded seeded where they never were (card 2947's code
 * review, FP2); what the keys were given read, before the delete takes their rows; each key recorded and deleted
 * (`endApiKeys`), its webhooks' `set_by_key` emptied by the foreign key, which `holdOf` reads as a key that ended; the
 * accounts' webhooks swept (`{ setters }`), which also finds one set up before keys were recorded whose setter has just
 * lost their last key from then; then every webhook with a secret a key was given held (`holdRevealed`). Tells nobody:
 * the caller tells once after its commit. Called by the revoke route, and by the start and the five-minute sweep for a
 * key the record names that is present (`endRecordedKeysPresent`). Throws outside a transaction.
 */
export function revokeApiKeys(keys: readonly { id: number; userId: number }[], cause: string, because: RevokedBecause): KeysRevoked {
	if (!sqlite.inTransaction) throw new Error('revokeApiKeys revokes inside the transaction of the write, and none is open');
	const seeded = seedRevealsOnce();
	const revealed = revealsOfKeys(keys.map((key) => key.id));
	const keyIds = keys.flatMap((key) => endApiKeys(sqlite, { keyId: key.id }, because));
	const swept = switchOffLostWebhooks({ setters: [...new Set(keys.map((key) => key.userId))] }, cause, { told: 'by the caller' });
	const revealedHeld = holdRevealed(revealed);
	// Every one a key was given told as exposed, a webhook it set among them (FP4).
	const given = revealed.map((reveal) => reveal.webhookId);
	return {
		keyIds: keyIds.sort((a, b) => a - b),
		swept,
		revealedHeld,
		switchedOff: markExposed([...swept, ...revealedHeld.switchedOff], given),
		held: markExposed(revealedHeld.held, given),
		seeded
	};
}

/**
 * End every API key present that the record of keys ended on this server names (card 2995, R7): one brought back by
 * an older image's import or a host edit, which the gate already refuses. Each is revoked as a revoke revokes it
 * (`revokeApiKeys`): what it set held `'key ended'`, what it was given held. Inside the caller's transaction; tells
 * nobody. A second run finds none. Returns what it did, with the cause the log names the keys by, by id alone.
 */
export function endRecordedKeysPresent(): KeysRevoked & { cause: string } {
	const present = sqlite
		.prepare(`SELECT k.id, k.user_id AS userId FROM api_keys AS k WHERE ${keyRecordedWhere('k.id', 'k.key_hash')} ORDER BY k.id`)
		.all() as { id: number; userId: number }[];
	const cause = `API key(s) ${present.map((key) => `#${key.id}`).join(', ')} named by the record of keys ended on this server were ended again`;
	if (present.length === 0) return { keyIds: [], swept: [], revealedHeld: { switchedOff: [], held: [] }, switchedOff: [], held: [], seeded: null, cause };
	return { ...revokeApiKeys(present, cause, REVOKED_BECAUSE.beforeRecord), cause };
}
