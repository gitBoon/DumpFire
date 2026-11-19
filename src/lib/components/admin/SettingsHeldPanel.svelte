<!--
  SettingsHeldPanel.svelte — the admin page's Settings held for review (card
  2922, its plan's R7).

  When an account's access ends with its API keys (an administrator's password
  set, an invite used, a two-step reset, the holder's own change that ends its
  keys), the mail settings, the App URL and the backup destinations it set are
  held: nothing is sent to them until the superadmin keeps or removes each.
  This is the one list of them, read from GET /api/admin/settings/held by every
  administrator; the settings panels each point here.

  Each held setting shows where it sends, never a secret, who it was held for
  and since when. The superadmin alone is offered Keep and Remove, each asking
  for their password and a code (`STEP_UP_ACTIONS`): Keep's confirm shows the
  place reviewed, which the server checks is still where the setting sends
  (R4); Remove's says the hold stays (R1), and for the mail settings that every
  invite not yet used, set-up link and request link on the server ends (R2).

  Drawn nothing where nothing is held.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { sentAsking, showToast } from '$lib/admin/send';
	import { ASKS_FOR_PASSWORD, type StepUpProof } from '$lib/step-up-words';
	import { heldIsPlural, heldPlaceWords, heldSettingName, heldSettingNameWithin, type HeldSetting } from '$lib/settings-held';

	/**
	 * What a Remove of held mail or a held App URL ends across the server (R2; the code review's C2, C3): every
	 * mailed key, each of which went through the mail settings or began with the App URL.
	 */
	const ENDS_EVERY_MAILED_LINK =
		'Every invite not yet used, two-step set-up link, request link and decision link on the server will end too: each was mailed ' +
		'through the mail settings, with a link that began with the App URL.';

	let {
		confirm,
		onChanged = () => {},
		held = $bindable([])
	}: {
		/** The page's confirm dialog, asking for the password (card 2701). */
		confirm: (title: string, message: string, action: (proof: StepUpProof) => Promise<string | null | void>, options?: { askPassword?: boolean }) => void;
		/** Told after a Keep or a Remove, so the page reads the panels that show the setting again. */
		onChanged?: (setting: string) => void;
		/** The settings held, as last read: bound by the page, which points each settings panel here from it (R7). */
		held?: HeldSetting[];
	} = $props();

	let mayRelease = $state(false);
	let unread = $state(false);

	// Read once, as the panel is drawn (the code review's C11): nothing it reads should read it again.
	onMount(() => {
		load();
	});

	/** Read the list. */
	export async function load() {
		try {
			const res = await fetch('/api/admin/settings/held');
			if (!res.ok) {
				unread = true;
				return;
			}
			const body = await res.json();
			held = Array.isArray(body.held) ? body.held : [];
			mayRelease = body.mayRelease === true;
			unread = false;
		} catch {
			unread = true;
		}
	}

	/** Keep or Remove `setting`, confirmed with the password: the place reviewed is sent back (R4). */
	function ask(setting: HeldSetting, action: 'keep' | 'remove') {
		const name = heldSettingNameWithin(setting);
		const where = heldPlaceWords(setting);
		const plural = heldIsPlural(setting);
		const savedAgain = plural ? 'the same settings saved again are held again' : 'the same setting saved again is held again';
		const message =
			action === 'keep'
				? `Keep ${name} in use as ${plural ? 'they are' : 'it is'} now: ${where}. Nothing changes but the hold. ${ASKS_FOR_PASSWORD}`
				: setting.kind === 'mail' || setting.kind === 'app_url'
					? `Remove ${name} (${where}). ${ENDS_EVERY_MAILED_LINK} The hold stays, so ${savedAgain}. ${ASKS_FOR_PASSWORD}`
					: `Remove ${name} (${where}). The hold stays, so ${savedAgain}. ${ASKS_FOR_PASSWORD}`;
		confirm(
			action === 'keep' ? 'Keep held setting' : 'Remove held setting',
			message,
			(proof: StepUpProof) => release(setting, action, proof),
			{ askPassword: true }
		);
	}

	async function release(setting: HeldSetting, action: 'keep' | 'remove', proof: StepUpProof): Promise<string | void> {
		const res = await sentAsking(
			() =>
				fetch('/api/admin/settings/held', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						setting: setting.setting,
						place: setting.place,
						action,
						currentPassword: proof.currentPassword,
						currentCode: proof.currentCode
					})
				}),
			action === 'keep' ? 'Failed to keep the setting' : 'Failed to remove the setting'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		showToast(await releasedWords(setting, action, res));
		onChanged(setting.setting);
		await load();
	}

	/** What a Keep or a Remove done says: for held mail removed, how many mailed links ended (R2). */
	async function releasedWords(setting: HeldSetting, action: 'keep' | 'remove', res: Response): Promise<string> {
		if (action === 'keep') return `${heldSettingName(setting)} kept, and in use again`;
		const body = await res.json().catch(() => ({}));
		const ended = body?.ended as { invites: number; enrolmentLinks: number; requestLinks: number; decisionLinks: number } | null | undefined;
		return ended
			? `${heldSettingName(setting)} removed; ${ended.invites} invite(s), ${ended.enrolmentLinks} set-up link(s), ${ended.requestLinks} request link(s) ` +
					`and ${ended.decisionLinks} decision link(s) ended`
			: `${heldSettingName(setting)} removed`;
	}
</script>

{#if held.length > 0 || unread}
	<section id="settings-held" class="admin-card glass fade-in-up settings-held" style="animation-delay: 20ms">
		<h2>⏸️ Settings held for review</h2>
		{#if unread}
			<p class="section-desc">⚠️ The settings held for review could not be read: reload the page.</p>
		{:else}
			<p class="section-desc">
				Each of these was set by an account whose access was ended with its API keys. Nothing is sent to it until
				{mayRelease ? 'you keep it or remove it' : 'the superadmin keeps it or removes it'}.
			</p>
			<ul class="held-list">
				{#each held as setting (setting.setting + setting.place)}
					<li class="held-item">
						<div>
							<strong>{heldSettingName(setting)}</strong>: {heldPlaceWords(setting)}
							<div class="held-meta">
								Set by {setting.setByName ?? `user ${setting.setBy ?? 'unknown'}`}; held since {setting.heldAt} UTC
							</div>
							{#if setting.kind === 'mail'}
								<!-- The code review's C14: what was mailed through it before the hold still works. -->
								<div class="held-meta held-urgent">
									Links already mailed through these mail settings stay usable until they are removed, so decide quickly.
								</div>
							{/if}
						</div>
						{#if mayRelease}
							<div class="held-actions">
								<button class="btn-secondary btn-sm" aria-label={`Keep ${heldSettingNameWithin(setting)}`} onclick={() => ask(setting, 'keep')}>Keep</button>
								<button class="btn-danger btn-sm" aria-label={`Remove ${heldSettingNameWithin(setting)}`} onclick={() => ask(setting, 'remove')}>Remove</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}

<style>
	.held-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}
	.held-item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-sm);
		flex-wrap: wrap;
	}
	.held-meta {
		font-size: 0.68rem;
		color: var(--text-secondary);
	}
	.held-actions {
		display: flex;
		gap: var(--space-xs);
	}
</style>
