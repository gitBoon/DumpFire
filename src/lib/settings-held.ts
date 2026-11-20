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
 * What the review list says of why its settings are held (card 3009's code review, FP4), by the reasons it holds: an
 * ended setter's access, a backup whose seal did not verify, or both.
 */
export function heldListWhy(held: readonly Pick<HeldSetting, 'heldBecause'>[]): string {
	const unsealed = held.filter(heldFromUnsealedBackup).length;
	if (unsealed === 0) return 'Each of these was set by an account whose access was ended with its API keys.';
	if (unsealed === held.length) return "Each of these came in with a backup whose seal did not verify, so where it sends is only the file's word.";
	return "Each of these was set by an account whose access was ended with its API keys, or came in with a backup whose seal did not verify.";
}

/** Who a held setting is told as set by, by why it is held (FP4): a restore's hold names nobody. */
export function heldSetByWords(held: Pick<HeldSetting, 'heldBecause' | 'setBy' | 'setByName'>): string {
	if (heldFromUnsealedBackup(held)) return 'From a backup whose seal did not verify';
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
