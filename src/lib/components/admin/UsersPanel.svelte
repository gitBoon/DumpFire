<!--
  UsersPanel.svelte — The admin page's User Management: Add User, and each
  account's row with what the caller may do to it, its role, 🔑, 📧 and 🗑️
  (card 2281, slice C1b: moved from src/routes/admin/+page.svelte).

  Shown to every administrator. The password dialog is drawn after the
  section, as it was on the page, and 🔑 opens it through `bind:this`. The
  link of an invite whose mail was not sent is the page's (`inviteLink`,
  bound here): its dialog is drawn by the page where it was, after the
  page's own dialogs. Delete asks first through the page's confirm dialog,
  and so does every role change (card 2701: a role change to User for an
  account whose settings would go with it names them, card 2397's review, as
  the server says it holds them just then, its second review) and 📧. Each
  asks in it for the caller's own password too, which it sends, and Add User
  has a field of its own for it (card 2701). After an invite the mail panel is
  read again through the page.

  🛡️ resets another account's two-step sign-in (card 2773, plan 4.4), on
  every row that shows 📧, asked through the same confirm with the caller's
  password. Its link is shown once in the same dialog as an invite's, with
  `kind: 'mfa-reset'`. 📧 is refused for an account that uses two-step
  sign-in, as the server refuses its invite: reset it first.

  An account that may still set up two-step sign-in on its password alone, in
  the 14 days after the release that turned it on, says until when (card
  2769, decision 25: `passwordSetUpUntil`).
-->
<script lang="ts">
	import type { PageData } from '../../../routes/admin/$types';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { answerBody, failureMessage, userDeleteWarning } from '$lib/api';
	import { mayManageAccount } from '$lib/account-rule';
	import { NO_ANSWER, sentAsking, showToast } from '$lib/admin/send';
	import CurrentPasswordField from '$lib/components/CurrentPasswordField.svelte';
	import EmojiPicker from '$lib/components/EmojiPicker.svelte';
	import { toasts } from '$lib/stores/toast';
	import { ASKS_FOR_PASSWORD, proofTyped, stepUpRefusal, type StepUpProof } from '$lib/step-up-words';
	import ResetPasswordDialog from './ResetPasswordDialog.svelte';

	/** The settings an account had set that a role change or a delete removes, or would (card 2397): `SettingsRemoved` on the server. */
	type SettingsGone = { mail: boolean; appUrl: boolean; destinations: string[] };

	let {
		data,
		isSuperadmin,
		confirm,
		loadMailStatus,
		settingsRemoved = () => {},
		inviteLink = $bindable()
	}: {
		/** What the admin page's load gave it, passed on as it is. */
		data: PageData;
		isSuperadmin: boolean;
		/**
		 * The page's confirm dialog, which asks before an account is deleted, its
		 * role changed or an invite sent, with `askPassword` for the caller's own
		 * password, handed to the action. Text the action gives back is a refusal
		 * of the password, shown in the dialog (card 2701).
		 */
		confirm: (
			title: string,
			message: string,
			action: (proof: StepUpProof) => Promise<string | null | void>,
			options?: { askPassword?: boolean }
		) => void;
		/** The mail panel's own read of what mail has done, which the page draws for every administrator (card 2395). */
		loadMailStatus: () => void;
		/**
		 * The page's: told what a role change or a delete removed of the mail
		 * settings, the App URL and the backup destinations the account had set
		 * (card 2397), so that the panels that show what went read it again, and
		 * no other (its review).
		 */
		settingsRemoved?: (removed: SettingsGone) => void;
		/**
		 * The page's: the link of an invite whose mail was not sent, which its
		 * dialog shows, and the control the focus goes back to after Done (card
		 * 2365's review: + Add User for Create, or the row's 📧). A two-step
		 * sign-in reset's link is handed back the same way, with `kind:
		 * 'mfa-reset'` (card 2773).
		 */
		inviteLink: { url: string; username: string; message: string; returnTo?: HTMLElement; kind?: 'invite' | 'mfa-reset' } | null;
	} = $props();

	/**
	 * + Add User: where the focus goes back to once an invite link from Create
	 * is dismissed. Create itself is off while the invite is out and gone with
	 * the form once it is answered, so the dialog found the focus on nothing.
	 */
	let addUserButton = $state<HTMLButtonElement>();

	/** The password dialog, opened by 🔑. */
	let resetDialog = $state<ReturnType<typeof ResetPasswordDialog>>();

	// ─── User Management ──────────────────────────────────────────────────

	let showCreateUser = $state(false);
	let newUsername = $state('');
	let newEmail = $state('');
	let newPassword = $state('');
	let newUserRole = $state('user');
	let newUserEmoji = $state('👤');
	/**
	 * The caller's own password, which making an account asks for again (card
	 * 2701): cleared once sent, and never kept beyond the form.
	 */
	let newUserCurrentPassword = $state('');
	/** The sign-in code typed beside it (card 2770), held and cleared as the password is. */
	let newUserCurrentCode = $state('');
	/** The server's refusal of that password, said in the form beside its field until the next Create (card 2701). */
	let newUserRefusal = $state<string | null>(null);
	let creatingUser = $state(false);

	/**
	 * The one invite out at a time (card 2196, R-S5): the account a 📧 was
	 * pressed for, or 'new' for Create User with no password. While it is set
	 * every 📧 and Create User are disabled, and the pressed 📧 reads "…". An
	 * invite now waits for its mail, a second or two, and a second press used
	 * to issue a second invite, which ends the first one's link.
	 */
	let inviteInFlight = $state<number | 'new' | null>(null);

	/**
	 * The account a 🛡️ reset is out for (card 2773), for the "…" on its 🛡️.
	 * A reset also sets `inviteInFlight`, so that it and an invite are gated
	 * as one: each issues a link the dialog shows, and one at a time.
	 */
	let twoStepInFlight = $state<number | null>(null);

	/** What 📧 says, and does nothing, for an account that uses two-step sign-in (card 2773): the server refuses its invite. */
	const INVITE_REFUSED = 'This account uses two-step sign-in. Reset it first, then send the invite';

	async function createUser() {
		if (!newUsername.trim() || !newEmail.trim() || !proofTyped(newUserCurrentPassword, newUserCurrentCode)) return;
		// Password required if non-empty, must be 8+ chars
		if (newPassword && newPassword.length < 8) {
			showToast('Password must be at least 8 characters', 'error');
			return;
		}
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		creatingUser = true;
		// With no password an invite is issued, and its mail waited for.
		if (!newPassword) inviteInFlight = 'new';
		// The caller's own password goes with the request and no further: a
		// refusal of it is said in the form, beside its field, and it is typed
		// again.
		const currentPassword = newUserCurrentPassword;
		const currentCode = newUserCurrentCode;
		newUserCurrentPassword = '';
		newUserCurrentCode = '';
		newUserRefusal = null;
		try {
			// A refusal is read with failureMessage: a proxy's page in place of
			// one used to make the page's own reading of it throw.
			const res = await sentAsking(
				() =>
					fetch('/api/users', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							username: newUsername.trim(),
							email: newEmail.trim(),
							emoji: newUserEmoji,
							role: newUserRole,
							// Left out when blank: an invite is issued.
							password: newPassword || undefined,
							currentPassword,
							currentCode
						})
					}),
				'Failed to create user'
			);
			if (typeof res === 'string') {
				newUserRefusal = res;
				return;
			}
			if (!res) return;
			const result = await answerBody(res);
			showCreateUser = false;
			const made = typeof result?.username === 'string' ? result.username : newUsername.trim();
			newUsername = ''; newEmail = ''; newPassword = ''; newUserRole = 'user'; newUserEmoji = '👤';
			await invalidateAll();
			// The user was made either way. Its invite mail not sent: the link,
			// for the caller to pass on (card 2196), and never "invite email sent!".
			if (result?.mailSent === false) {
				const said = `User ${made} was made, but the invite mail could not be sent: ${result.mailProblem}.`;
				if (typeof result.inviteUrl === 'string') {
					inviteLink = { url: result.inviteUrl, username: made, message: said, returnTo: addUserButton };
				} else {
					showToast(`${said} Send a new invite with 📧 once mail works.`, 'error', started);
				}
				return;
			}
			showToast(result?.invited ? 'User created — invite email sent!' : 'User created');
		} finally {
			creatingUser = false;
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail:
			// every administrator's since card 2395.
			loadMailStatus();
		}
	}

	/**
	 * The role chosen in each account's picker and not yet saved, by account
	 * (card 2376). Choosing sends nothing: on Windows, Up and Down on a closed
	 * picker change it at once, and the picker saved every role arrowed past,
	 * Admin included. Change sends the one chosen. The picker shows it until
	 * it is saved or put back, the account is deleted, or a re-read drops it.
	 */
	let chosenRole = $state(new Map<number, string>());

	function setChosen(userId: number, role: string | null) {
		const next = new Map(chosenRole);
		if (role === null) next.delete(userId);
		else next.set(userId, role);
		chosenRole = next;
	}

	/**
	 * The accounts whose role change is out, each with its name for the status
	 * line. A second Change meanwhile sends nothing (card 2376: a second
	 * choice was sent while the first was out). The picker and Change are
	 * marked busy rather than turned off, which would drop the keyboard's
	 * focus to the page.
	 */
	let changingRole = $state(new Map<number, string>());

	function markChanging(userId: number, username: string | null) {
		const next = new Map(changingRole);
		if (username === null) next.delete(userId);
		else next.set(userId, username);
		changingRole = next;
	}

	/** What a screen reader is told while a change is out (card 2376), politely; the toast says how it ended. */
	let savingSaid = $derived([...changingRole.values()].map((name) => `Saving ${name}'s role…`).join(' '));

	/** The role the page's data gives the account now. */
	function storedUserRole(userId: number): string | undefined {
		return data.users.find((u) => u.id === userId)?.role;
	}

	/**
	 * A role chosen and not saved is dropped when the page's data is read
	 * again and the account is gone or already has it (the card 2376 review,
	 * as on the team pages: the choice outlived the row). A choice whose change
	 * is out is left to that change, which clears it as it ends.
	 */
	$effect.pre(() => {
		const accounts = data.users;
		untrack(() => {
			const stale = [...chosenRole].filter(([userId, role]) => {
				if (changingRole.has(userId)) return false;
				const stored = accounts.find((u) => u.id === userId)?.role;
				return stored === undefined || stored === role;
			});
			if (stale.length === 0) return;
			const next = new Map(chosenRole);
			for (const [userId] of stale) next.delete(userId);
			chosenRole = next;
		});
	});

	/** A role chosen in a row's picker, kept for Change. While its change is out, another choice goes back to the role being saved. */
	function chooseUserRole(userId: number, select: HTMLSelectElement) {
		if (changingRole.has(userId)) {
			select.value = chosenRole.get(userId) ?? select.value;
			return;
		}
		setChosen(userId, select.value === storedUserRole(userId) ? null : select.value);
	}

	/**
	 * Settings an account had set, as an answer's `settingsRemoved` or the
	 * page's `settingsSet` gives them (card 2397), or null where they name
	 * none: the mail settings, the App URL and the backup destinations.
	 */
	function settingsNamed(given: unknown): SettingsGone | null {
		if (given === null || typeof given !== 'object') return null;
		const r = given as { mail?: unknown; appUrl?: unknown; destinations?: unknown };
		const named: SettingsGone = {
			mail: r.mail === true,
			appUrl: r.appUrl === true,
			destinations: Array.isArray(r.destinations) ? r.destinations.filter((d): d is string => typeof d === 'string') : []
		};
		return named.mail || named.appUrl || named.destinations.length > 0 ? named : null;
	}

	/**
	 * Those settings in words (card 2397's review): what going does to
	 * invites, password resets and the links in mail, and each destination by
	 * name. Said before a change is sent and after it is done.
	 */
	function settingsWords(named: SettingsGone): string {
		const { destinations } = named;
		return [
			...(named.mail
				? ['the mail settings, so no mail is sent, invites and password resets included, until an administrator sets them again in Email / SMTP']
				: []),
			...(named.appUrl ? ["the App URL, so the links in mail point to the server's APP_URL, or else its ORIGIN"] : []),
			...(destinations.length > 0
				? [`the backup destination${destinations.length === 1 ? '' : 's'} ${destinations.map((d) => `"${d}"`).join(', ')}`]
				: [])
		].join('; ');
	}

	/** What an answer says was removed with the account's role or the account, in words, or null where it says nothing was. */
	function settingsRemovedWords(username: string, removed: SettingsGone | null): string | null {
		return removed === null ? null : `What ${username} had set was removed: ${settingsWords(removed)}.`;
	}

	/**
	 * What a role change to user or a delete of the account would remove now,
	 * read from the server just before the panel asks (card 2397's second
	 * review): the page's data is as old as the page, and another
	 * administrator may have taken a setting over since, or given one back.
	 * Null for nothing; 'unread' where the read failed, which is asked about
	 * all the same, in general words.
	 */
	async function settingsHeldNow(userId: number): Promise<SettingsGone | null | 'unread'> {
		try {
			const res = await fetch(`/api/users/${userId}`);
			if (!res.ok) return 'unread';
			const body = await answerBody(res);
			return body !== null && 'settingsSet' in body ? settingsNamed(body.settingsSet) : 'unread';
		} catch {
			return 'unread';
		}
	}

	/** What a confirmation says of the settings where the read failed: the change or delete may still remove some. */
	const SETTINGS_UNREAD =
		'What they set of the mail settings, the App URL and the backup destinations could not be read just now: whatever of it is still theirs goes too.';

	/** The accounts whose settings are being read before a question (the second review): a second press meanwhile does nothing. */
	let askingAbout = $state(new Set<number>());

	function markAsking(userId: number, asking: boolean) {
		const next = new Set(askingAbout);
		if (asking) next.add(userId);
		else next.delete(userId);
		askingAbout = next;
	}

	/**
	 * Change pressed: the page's confirm asks first, for the caller's own
	 * password too (card 2701: a change of role asks for it), and Confirm sends
	 * the change. Where the role chosen is User, what the account holds is read
	 * first (card 2397's second review), and where it holds settings that
	 * would go with its role, or the read failed, the confirm names them.
	 */
	async function askChangeUserRole(userId: number, username: string) {
		if (askingAbout.has(userId) || changingRole.has(userId)) return;
		const role = chosenRole.get(userId);
		if (role === undefined) return;
		const ask = (said: string) =>
			confirm('Change Role', said, (proof: StepUpProof) => changeUserRole(userId, username, proof), { askPassword: true });
		if (role !== 'user') {
			ask(`Make ${username} ${role === 'admin' ? 'an administrator' : `a ${role}`}? ${ASKS_FOR_PASSWORD}`);
			return;
		}
		markAsking(userId, true);
		let held: SettingsGone | null | 'unread';
		try {
			held = await settingsHeldNow(userId);
		} finally {
			markAsking(userId, false);
		}
		if (held === null) {
			ask(`Make ${username} a user? ${ASKS_FOR_PASSWORD}`);
			return;
		}
		const said = held === 'unread' ? SETTINGS_UNREAD : `This removes what they set: ${settingsWords(held)}.`;
		ask(`Make ${username} a user? ${said} ${ASKS_FOR_PASSWORD}`);
	}

	/**
	 * Change: saves the role chosen in the row's picker, with the caller's own
	 * password (card 2701). Refused or not answered, the picker shows the role
	 * the account has again; a refusal of the password is given back for the
	 * confirm to show, and the choice is kept to try again. Where the change
	 * removed settings the account had set (card 2397), a warning that stays
	 * says what, and the page reads the panels that show it again.
	 */
	async function changeUserRole(userId: number, username: string, proof: StepUpProof): Promise<string | void> {
		const newRole = chosenRole.get(userId);
		if (changingRole.has(userId) || newRole === undefined) return;
		if (newRole === storedUserRole(userId)) {
			setChosen(userId, null);
			return;
		}
		const putBack = () => setChosen(userId, null);
		const started = toasts.navigation();
		markChanging(userId, username);
		try {
			let res: Response;
			try {
				res = await fetch(`/api/users/${userId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ role: newRole, currentPassword: proof.currentPassword, currentCode: proof.currentCode })
				});
			} catch {
				putBack();
				showToast(NO_ANSWER, 'error', started);
				return;
			}
			const refusal = await stepUpRefusal(res);
			if (refusal !== null) return refusal;
			if (res.ok) {
				// A change of role ends any invite to the account not yet used: it
				// was sent to the account as it was. The answer says how many.
				const result = await answerBody(res);
				const invitesEnded = result?.invitesEnded;
				const gone = settingsNamed(result?.settingsRemoved);
				await invalidateAll();
				setChosen(userId, null);
				const said =
					typeof invitesEnded === 'number' && invitesEnded > 0
						? 'Role updated. The invite sent to this account earlier no longer works: send a new one with 📧.'
						: 'Role updated';
				if (gone === null) {
					showToast(said);
				} else {
					showToast(`${said}${said.endsWith('.') ? '' : '.'} ${settingsRemovedWords(username, gone)}`, 'warning', started);
					settingsRemoved(gone);
				}
			} else {
				putBack();
				showToast(await failureMessage(res, 'Failed to update role'), 'error', started);
			}
		} finally {
			markChanging(userId, null);
		}
	}

	/**
	 * The teams the account is the only owner of, from the page's data, by
	 * name and then id, as the delete's refusal names them (card 2377): an
	 * owner row of theirs and no other owner in the team. For the
	 * confirmation, which says the delete will be refused (card 2380).
	 */
	function soleOwnerOf(userId: number): string[] {
		return data.teams
			.filter((team) => {
				const owners = team.members.filter((m) => m.role === 'owner');
				return owners.length > 0 && owners.every((m) => m.userId === userId);
			})
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id))
			.map((team) => team.name);
	}

	async function deleteUser(userId: number, proof: StepUpProof): Promise<string | void> {
		const started = toasts.navigation();
		const username = data.users.find((u) => u.id === userId)?.username ?? 'the account';
		const res = await sentAsking(
			() => fetch(`/api/users/${userId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
			'Failed to delete user'
		);
		if (typeof res === 'string') return res;
		if (!res) return;
		// What it had set, removed with it (card 2397): said in a warning that stays.
		const gone = settingsNamed((await answerBody(res))?.settingsRemoved);
		// A role chosen for the account and not saved goes with it (the card 2376 review).
		setChosen(userId, null);
		await invalidateAll();
		if (gone === null) {
			showToast('User deleted');
		} else {
			showToast(`User deleted. ${settingsRemovedWords(username, gone)}`, 'warning', started);
			settingsRemoved(gone);
		}
	}

	/** The delete's confirmation: the warning of every delete, then what of the settings the account set would go with it (card 2397's review), as read just now. */
	function deleteWarning(userId: number, username: string, held: SettingsGone | null | 'unread'): string {
		const warning = userDeleteWarning(username, soleOwnerOf(userId));
		if (held === 'unread') return `${warning} ${SETTINGS_UNREAD} ${ASKS_FOR_PASSWORD}`;
		return held === null ? `${warning} ${ASKS_FOR_PASSWORD}` : `${warning} What they set goes too: ${settingsWords(held)}. ${ASKS_FOR_PASSWORD}`;
	}

	/** 🗑️ pressed: what the account holds is read first (the second review), then the page's confirm asks, for the caller's password too (card 2701), and Confirm deletes. */
	async function askDeleteUser(userId: number, username: string) {
		if (askingAbout.has(userId)) return;
		markAsking(userId, true);
		let held: SettingsGone | null | 'unread';
		try {
			held = await settingsHeldNow(userId);
		} finally {
			markAsking(userId, false);
		}
		confirm('Delete User', deleteWarning(userId, username, held), (proof: StepUpProof) => deleteUser(userId, proof), { askPassword: true });
	}

	/**
	 * 📧 pressed: the page's confirm asks first, for the caller's own password
	 * too (card 2701: an invite is a password reset by another way), and
	 * Confirm sends it.
	 */
	function askResendInvite(userId: number, username: string, control?: HTMLElement) {
		if (inviteInFlight !== null || inviteLink !== null) return;
		// Card 2773: aria-disabled, not disabled, so its title says why; pressed, it does nothing.
		if (data.users.find((u) => u.id === userId)?.twoStep === true) return;
		confirm(
			'Send Invite',
			`Send ${username} a new invite? Whoever opens its link sets the account's password, and an invite sent earlier stops working. ${ASKS_FOR_PASSWORD}`,
			(proof: StepUpProof) => resendInvite(userId, proof, control),
			{ askPassword: true }
		);
	}

	/**
	 * 📧, confirmed: a new invite, which ends the account's earlier one. The
	 * server waits for its mail and says whether it went (card 2196): sent, the
	 * toast; not sent, the dialog with the link to pass on, or, where the
	 * server could no longer show it, the server's words in a toast that
	 * stays. "Invite sent" only for an answer that says `mailSent: true`. A
	 * refusal of the password is given back for the confirm to show (card
	 * 2701). Either way the mail panel is read again, so it shows this mail.
	 */
	async function resendInvite(userId: number, proof: StepUpProof, control?: HTMLElement): Promise<string | void> {
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		inviteInFlight = userId;
		try {
			const res = await sentAsking(
				() => fetch(`/api/users/${userId}/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
				'Failed to send invite'
			);
			if (typeof res === 'string') return res;
			if (!res) return;
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' ? result.message : '';
			if (result?.mailSent === false) {
				if (typeof result.inviteUrl === 'string') {
					const username = data.users.find((u) => u.id === userId)?.username ?? 'this user';
					inviteLink = { url: result.inviteUrl, username, message: said, returnTo: control };
				} else {
					showToast(said || 'The invite was made, but its mail could not be sent.', 'error', started);
				}
				return;
			}
			if (result?.mailSent === true) {
				showToast(said || 'Invite sent!');
				return;
			}
			// An answer that says neither is not taken as a mail that went.
			showToast('The invite was made, but the answer did not say whether its mail was sent.', 'error', started);
		} finally {
			inviteInFlight = null;
			// The panel the dialog points to, read again so it shows this mail:
			// every administrator's since card 2395.
			loadMailStatus();
		}
	}

	/**
	 * 🛡️ pressed (card 2773, plan 4.4): the page's confirm asks first, for the
	 * caller's own password too, as the server does (a reset hands the caller a
	 * link that sets up another account's second factor), and Confirm sends it.
	 */
	function askResetTwoStep(userId: number, username: string, control?: HTMLElement) {
		if (inviteInFlight !== null || inviteLink !== null) return;
		confirm(
			'Reset Two-Step Sign-In',
			`Reset ${username}'s two-step sign-in? Their authenticator and recovery codes stop working, they are signed out everywhere, and you are given a link, once, to pass on to them yourself. ${ASKS_FOR_PASSWORD}`,
			(proof: StepUpProof) => resetTwoStepOf(userId, username, proof, control),
			{ askPassword: true }
		);
	}

	/**
	 * 🛡️, confirmed: the reset, whose link the server gives once, in its answer,
	 * and never mails (decision 6). It opens the link's dialog, with `kind:
	 * 'mfa-reset'`; where the server withheld the link (decision 15), its words
	 * are a warning that stays, saying to run the reset again. Either way the
	 * page's data is read again, so `twoStep` is, and 📧 is offered again. A
	 * refusal of the password is given back for the confirm to show.
	 */
	async function resetTwoStepOf(userId: number, username: string, proof: StepUpProof, control?: HTMLElement): Promise<string | void> {
		if (inviteInFlight !== null || inviteLink !== null) return;
		const started = toasts.navigation();
		inviteInFlight = userId;
		twoStepInFlight = userId;
		try {
			const res = await sentAsking(
				() => fetch(`/api/users/${userId}/mfa/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: proof.currentPassword, currentCode: proof.currentCode }) }),
				'Failed to reset two-step sign-in'
			);
			if (typeof res === 'string') return res;
			if (!res) return;
			const result = await answerBody(res);
			const said = typeof result?.message === 'string' ? result.message : `${username}'s two-step sign-in was reset.`;
			// The notice the account's address is sent holds no link (decision 7); where it was not sent, the caller is told why.
			const notice = typeof result?.mailProblem === 'string' ? ` The notice to ${username} was not sent: ${result.mailProblem}.` : '';
			// Card 2773: the link is shown before the page's data is read again. The
			// reset is already committed and the link is given only this once, so a
			// reload that fails must not be able to lose it.
			if (typeof result?.enrolmentUrl === 'string') {
				inviteLink = { url: result.enrolmentUrl, username, message: `${said}${notice}`, returnTo: control, kind: 'mfa-reset' };
			} else {
				showToast(`${said}${notice}`, 'warning', started);
			}
			await invalidateAll();
		} finally {
			inviteInFlight = null;
			twoStepInFlight = null;
		}
	}
</script>

<!-- User Management -->
<section class="admin-card glass fade-in-up" style="animation-delay: 200ms">
	<div class="section-header">
		<h2>👥 User Management</h2>
		<button class="btn-primary btn-sm" onclick={() => (showCreateUser = true)} bind:this={addUserButton}>+ Add User</button>
	</div>
	<!-- A role being saved, said politely to a screen reader (card 2376). -->
	<p class="saving-status" role="status">{savingSaid}</p>
	<p class="section-desc">Each row shows only what you may do to that account. Only the superadmin changes an administrator's account, and nobody else changes the superadmin's: those rows show 🔒. On your own row there is only 🔑, to change your password.</p>

	{#if showCreateUser}
		<div class="inline-form">
			<div class="form-row">
				<input type="text" placeholder="Username" bind:value={newUsername} class="form-input" />
				<input type="email" placeholder="Email" bind:value={newEmail} class="form-input" />
				<input type="password" placeholder="Password (blank = send invite)" bind:value={newPassword} class="form-input" autocomplete="new-password" />
			</div>
			<!-- The caller's own, which making an account asks for again (card 2701), with the server's refusal of it. -->
			<CurrentPasswordField bind:value={newUserCurrentPassword} bind:code={newUserCurrentCode} refusal={newUserRefusal} onEnter={createUser} />
			<p class="form-hint">{ASKS_FOR_PASSWORD} Making an account asks for yours, so that a browser left signed in cannot.</p>
			<div class="form-row">
				<EmojiPicker value={newUserEmoji} onSelect={(e) => (newUserEmoji = e)} />
				<select bind:value={newUserRole} class="form-input">
					<option value="user">User</option>
					{#if isSuperadmin}<option value="admin">Admin</option>{/if}
				</select>
				<button class="btn-primary btn-sm" onclick={createUser} disabled={creatingUser || inviteInFlight !== null || inviteLink !== null || !newUsername || !newEmail || !proofTyped(newUserCurrentPassword, newUserCurrentCode)}>
					{creatingUser ? 'Creating...' : 'Create'}
				</button>
				<button class="btn-ghost btn-sm" onclick={() => { showCreateUser = false; newUserCurrentPassword = ''; newUserCurrentCode = ''; newUserRefusal = null; }}>Cancel</button>
			</div>
		</div>
	{/if}

	{#if data.users.length === 0}
		<p class="empty-msg">No users yet.</p>
	{:else}
		<div class="user-list">
			{#each data.users as u (u.id)}
				<div class="user-row">
					<span class="user-row-emoji">{u.emoji}</span>
					<div class="user-row-info">
						<span class="user-row-name">{u.username}</span>
						<span class="user-row-email">{u.email}</span>
						<!-- Card 2769 (decision 25): leave to set up two-step sign-in on the password alone, in the 14 days after the release. -->
						{#if u.passwordSetUpUntil}
							<span class="user-row-setup">may set up on password until {u.passwordSetUpUntil} UTC</span>
						{/if}
					</div>
					<span class="role-badge role-{u.role}">{u.role}</span>
					<!-- Only what the server would let you do to this account (the rule in $lib/account-rule.ts). On your own row, only the password. -->
					{#if mayManageAccount(data.currentUser, u)}
						{#if u.id !== data.currentUser.id}
							<!-- The picker and Change for the superadmin alone: anyone else may give only User, so the picker had one choice and Change could never do anything (the card 2376 review); the badge says the role. -->
							{#if isSuperadmin}
								<!-- Choosing sends nothing; Change saves it (card 2376). Busy, not off, while its change is out: off, it would drop the focus. -->
								<select
									value={chosenRole.get(u.id) ?? u.role}
									aria-busy={changingRole.has(u.id) ? 'true' : undefined}
									onchange={(e) => chooseUserRole(u.id, e.currentTarget)}
									class="role-select"
									aria-label="{u.username}'s role"
								>
									<option value="user">User</option>
									<option value="admin">Admin</option>
								</select>
								<button
									class="btn-ghost btn-sm role-change"
									aria-disabled={chosenRole.has(u.id) && !changingRole.has(u.id) ? undefined : 'true'}
									onclick={() => askChangeUserRole(u.id, u.username)}
									aria-label="Change {u.username}'s role"
								>Change</button>
							{/if}
						{/if}
						<button class="btn-ghost btn-sm" onclick={() => resetDialog?.openResetDialog(u.id)} title="Reset password">🔑</button>
						{#if u.id !== data.currentUser.id}
							<!-- Card 2773: refused for an account that uses two-step sign-in, aria-disabled so its title says why. -->
							<button
								class="btn-ghost btn-sm invite-resend"
								onclick={(e) => askResendInvite(u.id, u.username, e.currentTarget)}
								disabled={inviteInFlight !== null || inviteLink !== null}
								aria-disabled={u.twoStep === true ? 'true' : undefined}
								title={u.twoStep === true ? INVITE_REFUSED : 'Resend invite email'}
							>{inviteInFlight === u.id && twoStepInFlight === null ? '…' : '📧'}</button>
							<button class="btn-ghost btn-sm" onclick={(e) => askResetTwoStep(u.id, u.username, e.currentTarget)} disabled={inviteInFlight !== null || inviteLink !== null} title="Reset two-step sign-in">{twoStepInFlight === u.id ? '…' : '🛡️'}</button>
							<button class="btn-ghost btn-sm danger" onclick={() => askDeleteUser(u.id, u.username)} title="Delete user">🗑️</button>
						{/if}
					{:else}
						<span class="superadmin-lock" title={u.role === 'superadmin' ? "The superadmin's account is theirs alone" : "Only the superadmin can change an administrator's account"}>🔒</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

<!-- The password dialog, after the section as it was on the page: fixed to the window, not to a card that moves on hover. -->
<ResetPasswordDialog bind:this={resetDialog} {data} />

<style>
	/* User list */
	.user-list { display: flex; flex-direction: column; gap: var(--space-xs); }
	.user-row {
		display: flex; align-items: center; gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); transition: border-color 0.15s;
	}
	.user-row:hover { border-color: var(--accent-indigo); }
	.user-row-emoji { font-size: 1.2rem; flex-shrink: 0; }
	.user-row-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
	.user-row-name { font-weight: 600; font-size: 0.85rem; }
	.user-row-email { font-size: 0.72rem; color: var(--text-tertiary); }
	.user-row-setup { font-size: 0.72rem; color: var(--accent-amber); }

	.role-badge {
		font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
		letter-spacing: 0.05em; padding: 2px 8px; border-radius: var(--radius-sm);
	}
	.role-superadmin { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
	.role-admin { background: rgba(99, 102, 241, 0.15); color: var(--accent-indigo); }
	.role-user { background: rgba(100, 116, 139, 0.15); color: var(--text-secondary); }

	.role-select {
		padding: 2px var(--space-sm); border: 1px solid var(--glass-border);
		border-radius: var(--radius-sm); background: var(--bg-base);
		color: var(--text-secondary); font-size: 0.72rem; font-weight: 600;
		cursor: pointer; font-family: var(--font-family);
	}

	/* Change beside the picker (card 2376): dimmed, and sending nothing, until a role other than the account's is chosen. */
	.role-change[aria-disabled='true'] { opacity: 0.35; cursor: default; }
	/* 📧 for an account that uses two-step sign-in (card 2773): dimmed, its title saying why, and sending nothing. Keyed to the class, as Change is, so rewording the title cannot undim it. */
	.invite-resend[aria-disabled='true'] { opacity: 0.35; cursor: default; }
	/* The status line is for screen readers alone. */
	.saving-status {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}

	.superadmin-lock { font-size: 0.9rem; opacity: 0.5; }

	/* Why Add User asks for the caller's own password (card 2701) */
	.form-hint { font-size: 0.72rem; color: var(--text-tertiary); margin: 0; }
</style>
