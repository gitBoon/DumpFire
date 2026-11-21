/**
 * settings-held.ts — the words the pages use for the settings held for the
 * superadmin's review (card 2922), shared by the review list, the banner and
 * the panels' pointers. Browser-safe: no server import.
 */

/** One setting held for review, as GET /api/admin/settings/held answers it. */
export type HeldSetting = {
	setting: string;
	kind: 'mail' | 'app_url' | 'destination';
	name: string | null;
	place: string;
	heldAt: string;
	setBy: number | null;
	setByName: string | null;
	/** Why it is held (`held_because`): an ended setter's access, or a backup whose seal did not verify (card 3009). */
	heldBecause: string;
	where: Record<string, unknown>;
};

/**
 * `held_because` of a setting a restore held because it came in with a backup whose seal did not verify (card 3009,
 * R4): set by nobody, so its words never name a setter or say one's access was ended (its code review, FP4).
 */
export const HELD_FROM_UNSEALED_BACKUP = 'restored from a backup whose seal did not verify';

/** Whether a hold is the unsealed restore's (`HELD_FROM_UNSEALED_BACKUP`), not an ended setter's. */
export const heldFromUnsealedBackup = (held: Pick<HeldSetting, 'heldBecause'>): boolean => held.heldBecause === HELD_FROM_UNSEALED_BACKUP;

/**
 * `held_because` of a setting a restore held because this server's record of where it sends has it removed or moved
 * here since the backup was made (card 3004, plan 3.4 rule 2). Set by nobody.
 */
export const HELD_REMOVED_HERE = 'removed here';

/**
 * `held_because` of a setting a restore of a backup whose seal verified held because this server's record of where it
 * sends does not name it, and this server did not hold it (card 3004, plan 3.4 rule 3, R1). Set by nobody.
 */
export const HELD_NOT_RECORDED = "not in this server's record";

/**
 * `held_because` of a webhook a restore switched off for good because this server's record of where it sends has it
 * deleted here since the backup was made (card 3004, plan 3.4): its secret discarded. Set by nobody.
 */
export const HELD_DELETED_HERE = 'deleted here';

/**
 * `held_because` of a webhook a restore switched off for good because its address is not the one this server held or
 * recorded for it: pointed elsewhere here since the backup was made, or not compared for want of an MFA key (card 3004,
 * plan 3.4, R10): its secret discarded. Set by nobody.
 */
export const HELD_REPOINTED_HERE = 're-pointed here';

/** Whether a hold is a restore's by this server's record of where it sends (card 3004): removed here, or not in the record. */
export const heldByOutboundRecord = (held: Pick<HeldSetting, 'heldBecause'>): boolean =>
	held.heldBecause === HELD_REMOVED_HERE || held.heldBecause === HELD_NOT_RECORDED;

/**
 * What the review list says of why its settings are held (card 3009's code review, FP4), by the reasons it holds: an
 * ended setter's access, a backup whose seal did not verify, a restore of something removed here or not in this
 * server's record (card 3004), or more than one.
 */
export function heldListWhy(held: readonly Pick<HeldSetting, 'heldBecause'>[]): string {
	const unsealed = held.filter(heldFromUnsealedBackup).length;
	const recorded = held.filter(heldByOutboundRecord).length;
	if (recorded === 0) {
		if (unsealed === 0) return 'Each of these was set by an account whose access was ended with its API keys.';
		if (unsealed === held.length) return "Each of these came in with a backup whose seal did not verify, so where it sends is only the file's word.";
		return "Each of these was set by an account whose access was ended with its API keys, or came in with a backup whose seal did not verify.";
	}
	if (recorded === held.length) return "Each of these came back with a restore, though it was removed on this server since the backup was made or is not in this server's record of where it sends.";
	return "Each of these was set by an account whose access was ended with its API keys, came in with a backup whose seal did not verify, or came back with a restore though removed here or not in this server's record.";
}

/** Who a held setting is told as set by, by why it is held (FP4): a restore's hold names nobody. */
export function heldSetByWords(held: Pick<HeldSetting, 'heldBecause' | 'setBy' | 'setByName'>): string {
	if (heldFromUnsealedBackup(held)) return 'From a backup whose seal did not verify';
	if (held.heldBecause === HELD_REMOVED_HERE) return 'From a backup made before it was removed on this server';
	if (held.heldBecause === HELD_NOT_RECORDED) return "From a backup, and not in this server's record of where it sends";
	// Card 3004 (R13): held by a restore because this server's record says an ending held it here, which names no setter.
	if (held.setBy === null && held.setByName === null) return 'From a backup made before it was held on this server';
	return `Set by ${held.setByName ?? `user ${held.setBy ?? 'unknown'}`}`;
}

/** A held setting's name, to begin a sentence: the mail settings, the App URL, or a backup destination by its name. */
export function heldSettingName(held: Pick<HeldSetting, 'kind' | 'name'>): string {
	if (held.kind === 'mail') return 'The mail settings';
	if (held.kind === 'app_url') return 'The App URL';
	return `Backup destination "${held.name ?? ''}"`;
}

/** The same within a sentence (the code review's C11). */
export function heldSettingNameWithin(held: Pick<HeldSetting, 'kind' | 'name'>): string {
	const name = heldSettingName(held);
	return name.charAt(0).toLowerCase() + name.slice(1);
}

/** Whether a held setting's name is plural, for the verbs and pronouns that follow it (C11): the mail settings are. */
export const heldIsPlural = (held: Pick<HeldSetting, 'kind'>): boolean => held.kind === 'mail';

/** Where a held setting sends, in words, with no secret: what Keep is confirmed against (R4). */
export function heldPlaceWords(held: Pick<HeldSetting, 'kind' | 'where'>): string {
	const w = held.where;
	const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
	if (held.kind === 'mail') {
		const user = text(w.user);
		return `mail server ${text(w.host)}, port ${text(w.port)}${user ? `, user ${user}` : ''}${w.allowInsecure === true ? ', without a checked encrypted connection' : ''}`;
	}
	if (held.kind === 'app_url') return `links begin with ${text(w.url)}`;
	const shown = Object.entries(w)
		.filter(([field, value]) => field !== 'type' && text(value) !== '' && !/^[•*]+$/.test(text(value)))
		.map(([field, value]) => `${field} ${text(value)}`);
	return `${text(w.type)}${shown.length > 0 ? `: ${shown.join(', ')}` : ''}`;
}

/** The pointer each settings panel shows while any of its settings is held (R7), after "… held for review: ". */
export const HELD_POINTER = 'see Settings held for review at the top of this page.';
