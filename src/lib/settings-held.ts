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
	where: Record<string, unknown>;
};

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
