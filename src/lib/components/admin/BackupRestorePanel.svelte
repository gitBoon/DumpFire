<!--
  BackupRestorePanel.svelte — The admin page's Backup & Restore: the export,
  the import with its dialog, and the report of what an import did (card
  2281, slice C1a: moved from src/routes/admin/+page.svelte).

  The superadmin's alone: the page draws it inside its isSuperadmin block.
  The import dialog is drawn after the panel's section, not in it, so that
  it is fixed to the window and not to a card that moves on hover. After an
  import that changed the database the page is loaded again from nothing
  (`dismissImportReport`), on purpose.
-->
<script lang="ts">
	import { answerBody, failureMessage, uploadFailure, uploadNoAnswer, uploadNotRead } from '$lib/api';
	import { showToast } from '$lib/admin/send';
	import { toasts } from '$lib/stores/toast';

	/** This instance's default way to restore, from the page's load. */
	let { importOutsideDefault }: { importOutsideDefault: 'keep' | 'off' } = $props();

	let importing = $state(false);
	let exporting = $state(false);

	/**
	 * What an import could not do, or what a working copy had switched off,
	 * kept on the page until it is dismissed. A toast is a line in a corner,
	 * and one that is not a failure is gone in three seconds: neither a list of
	 * rows that were left out of the database nor an account of what no longer
	 * reaches outside is something to show in one.
	 *
	 * `trouble` is false when nothing went wrong and this is only here to say
	 * what a working copy switched off and removed.
	 *
	 * `reload` is true when the database was changed, or may have been. The
	 * page is not reloaded until this has been read: a restore signs everybody
	 * out, the reader included, so the reload ends at the login page.
	 */
	let importReport = $state<{
		headline: string;
		/** One line of the figures that matter: the size of the backup and what it held. */
		detail?: string;
		/** What a working copy switched off and removed. */
		workingCopy?: string;
		/** The secrets a backup does not hold that this server's were kept for (card 2169). */
		secretsKept?: string;
		/** The secrets a backup does not hold that are to be entered again, and where (card 2169). */
		secretsToEnter?: string;
		/** Attachment files the import had back from the uploads trash, when there were any. */
		putBack?: string;
		/** Request links the import replaced, when there were any (card 2158). */
		requestLinks?: string;
		/** Who the superadmin is now: who can sign in to export, import or reset again. */
		superadmin?: string;
		/** Every table restored, with its rows, for whoever wants all of it. */
		tables?: [string, number][];
		problems: string[];
		reload: boolean;
		trouble: boolean;
	} | null>(null);

	const count = (n: number) => n.toLocaleString('en-GB');

	/**
	 * What an import restored, said the way a person would: the size of the
	 * backup and the handful of figures that show it is the right one. The
	 * server's own message lists every table in one sentence, which is for the
	 * log; the full list is kept, folded away, for anyone who wants it.
	 */
	function accountOf(result: {
		sizeBytes?: number;
		restored?: Record<string, number>;
		workingCopy?: string;
		secretsKept?: string;
		secretsToEnter?: string;
		attachmentsPutBack?: number;
		requestLinksReplaced?: number;
		superadmins?: string[];
	}) {
		const restored = result.restored ?? {};
		const figures: [string, string, string][] = [
			['boards', 'board', 'boards'],
			['columns', 'column', 'columns'],
			['cards', 'card', 'cards'],
			['subtasks', 'subtask', 'subtasks'],
			['card_comments', 'comment', 'comments'],
			['comments', 'comment', 'comments'],
			['users', 'user', 'users']
		];
		const parts = figures
			.filter(([key]) => typeof restored[key] === 'number')
			.map(([key, one, many]) => `${count(restored[key])} ${restored[key] === 1 ? one : many}`);
		const bytes = result.sizeBytes;
		const size =
			bytes === undefined
				? null
				: bytes >= 1024 * 1024
					? `${(bytes / 1024 / 1024).toFixed(1)} MB`
					: `${Math.max(1, Math.round(bytes / 1024))} KB`;
		const from = size ? `From a ${size} backup` : 'From the backup';
		// Rows the import brought back can name files that a delete since the
		// backup had moved to the uploads trash. The import puts those back.
		const putBack = typeof result.attachmentsPutBack === 'number' ? result.attachmentsPutBack : 0;
		// Every request is given a new link by an import (card 2158), so a link
		// mailed before it no longer works: said beside the files put back.
		const links = typeof result.requestLinksReplaced === 'number' ? result.requestLinksReplaced : 0;
		return {
			detail: parts.length > 0 ? `${from}: ${parts.join(', ')}.` : `${from}. It held no rows.`,
			workingCopy: result.workingCopy,
			// A backup holds no mail password, destination credential or webhook
			// secret (card 2169). The server's two sentences say which of this
			// server's were kept and which are to enter again; each is absent when
			// there is nothing to say, as for a backup made before that card.
			secretsKept: result.secretsKept,
			secretsToEnter: result.secretsToEnter,
			// The import signed everybody out, and the backup's accounts are the
			// ones there are now: this is the one to sign in as to undo it.
			superadmin: !Array.isArray(result.superadmins)
				? undefined
				: result.superadmins.length === 0
					? 'There are no user accounts now: set-up is open, and whoever completes it is the superadmin.'
					: result.superadmins.length === 1
						? `The superadmin is now ${result.superadmins[0]}.`
						: `The superadmins are now ${result.superadmins.join(', ')}.`,
			putBack:
				putBack > 0
					? `${count(putBack)} attachment ${putBack === 1 ? 'file' : 'files'} put back from the trash.`
					: undefined,
			requestLinks:
				links > 0
					? `${count(links)} request ${links === 1 ? 'link' : 'links'} replaced: a link mailed before this restore no ` +
						'longer works, and its requester can have a new one sent from the page it opens.'
					: undefined,
			tables: Object.entries(restored)
				.filter(([, rows]) => rows > 0)
				.sort(([a], [b]) => a.localeCompare(b))
		};
	}

	async function exportDatabase() {
		exporting = true;
		const started = toasts.navigation();
		try {
			const res = await fetch('/api/admin/export');
			if (!res.ok) {
				// A refusal is an answer too, and was once saved as the backup: a
				// file of a few bytes of JSON, named .db, under "exported successfully".
				showToast(await failureMessage(res, 'Export failed: no file was saved'), 'error', started);
				return;
			}
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `dumpfire-backup-${new Date().toISOString().slice(0, 10)}.db`;
			document.body.append(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			showToast('Database exported successfully');
		} catch {
			showToast('Export failed', 'error', started);
		} finally {
			exporting = false;
		}
	}

	// State, because it is bound to an element that is there for the superadmin only.
	let fileInput = $state<HTMLInputElement>();

	/**
	 * The import dialog, and which of its two ways to restore is chosen: `keep`
	 * restores everything as the backup has it, `off` restores a working copy.
	 * The choice outlives the dialog, because the file is picked after it closes.
	 */
	let showImportDialog = $state(false);
	let importOutside = $state<'keep' | 'off'>('keep');

	/** Opens the import dialog with this instance's default selected, whatever was chosen the last time. */
	function openImportDialog() {
		importOutside = importOutsideDefault;
		showImportDialog = true;
	}

	async function importDatabase() {
		fileInput?.click();
	}

	async function handleFileSelected(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;

		importing = true;
		const started = toasts.navigation();
		try {
			// In any case: a backup saved as BACKUP.DB is a .db backup.
			const named = file.name.toLowerCase();
			const isDbFile = named.endsWith('.db') || named.endsWith('.sqlite') || named.endsWith('.sqlite3');
			const what = `The backup "${file.name}"`;

			/**
			 * A failure that changed nothing, said in the report under the Import
			 * button. Not in a toast as well: a failure's toast stays until it is
			 * closed, so it was the same words twice, to be closed twice.
			 */
			const notImported = (headline: string) => {
				importReport = { headline, problems: [], reload: false, trouble: true };
			};

			// Only a .db backup is imported. Any other file is refused here, and
			// nothing is read or sent: the server would refuse it too. The old
			// JSON export is named, because it is the one file somebody may
			// still have that once was imported.
			if (!isDbFile) {
				notImported(
					`The file "${file.name}" is not a .db backup. Exports in the old JSON format, which DumpFire wrote only ` +
						'from 1 to 7 April 2026, are no longer imported. Nothing was sent.'
				);
				return;
			}

			// One of four things has gone wrong when an import is not accepted,
			// and each is said for what it is: see `uploadFailure` in $lib/api.
			// The first: the file could not be read here, so nothing was sent.
			let body: ArrayBuffer;
			try {
				body = await file.arrayBuffer();
			} catch {
				notImported(uploadNotRead(what));
				return;
			}

			// The second: no answer. It is not known whether the import ran.
			let res: Response;
			try {
				res = await fetch(`/api/admin/import?outside=${importOutside}`, {
					method: 'POST',
					// The file's bytes, as they are.
					headers: { 'Content-Type': 'application/octet-stream' },
					body
				});
			} catch {
				importReport = {
					headline: `${uploadNoAnswer(what)} Reload the page to see what the database holds.`,
					problems: [],
					reload: true,
					trouble: true
				};
				return;
			}

			// The third and the fourth: an answer that is not DumpFire's, which is
			// a proxy's refusal, and DumpFire's own 413. Nothing was changed by
			// either. Read from a copy, so that `uploadFailure` can read it too.
			const result: Record<string, any> | null = await answerBody(res.clone());
			if (result === null || res.status === 413) {
				notImported(await uploadFailure(res, what));
				return;
			}

			const problems: string[] = Array.isArray(result.errors) ? result.errors.map(String) : [];
			const restoredAs = result.outside ? 'Database restored as a working copy' : 'Database restored';
			if (res.ok && problems.length === 0) {
				// Restored, and nothing wrong with it. The toast says so in a few
				// words and is gone in three seconds; what was restored, and what a
				// working copy switched off, stays on the page until it is dismissed.
				// The page is not reloaded until then: a restore signs everybody
				// out, so the reload is a sign-in.
				importReport = { headline: restoredAs, ...accountOf(result), problems, reload: true, trouble: false };
				showToast(`${restoredAs}.`);
			} else if (res.ok) {
				// Restored, with something to read: a row that was left out, or one
				// that was copied and refers to a row that is not there. That is an
				// error to show, not a success with a footnote, and the report shows
				// it as one.
				importReport = {
					headline: `${restoredAs}, with ${problems.length} problem${problems.length === 1 ? '' : 's'}`,
					...accountOf(result),
					problems,
					reload: true,
					trouble: true
				};
			} else {
				// `committed` is the one failure after which the data has changed.
				importReport = { headline: result.message || 'Import failed', problems, reload: result.committed === true, trouble: true };
			}
		} catch {
			// None of the four, and not the file's doing: a fault in this page
			// once the answer was in. What the import did is not known from here,
			// and there is no report to say it in, so the toast does.
			showToast('The answer to the import could not be shown. Reload the page to see what the database holds.', 'error', started);
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	/**
	 * Puts the import report away and, if the database was changed, loads the
	 * page again from nothing. A full reload and not `invalidateAll`: the
	 * backup and mail panels are read once, when the page opens, and would go
	 * on showing what was there before the import. A restore brings in no
	 * session, so the reload is what asks for a sign-in.
	 */
	function dismissImportReport() {
		const reload = importReport?.reload === true;
		importReport = null;
		if (reload) window.location.reload();
	}
</script>

<!-- Backup & Restore -->
<section class="admin-card glass fade-in-up" style="animation-delay: 80ms">
	<h2>💾 Backup & Restore</h2>
	<p class="section-desc">Export a complete backup of your entire database as a SQLite file, or restore from a previous backup. Captures everything automatically — users, teams, boards, cards, settings, and all other data.</p>

	<div class="backup-actions">
		<div class="backup-item">
			<div class="backup-icon export-icon">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
					<path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
			<div class="backup-info">
				<strong>Export Database</strong>
				<p>Download the complete database as a .db file — includes all data automatically.</p>
			</div>
			<button class="btn-backup export" onclick={exportDatabase} disabled={exporting}>
				{#if exporting}
					<span class="spinner"></span> Exporting...
				{:else}
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v8m0 0l-3-3m3 3l3-3M2 11v1a1 1 0 001 1h8a1 1 0 001-1v-1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
					Export Backup
				{/if}
			</button>
		</div>

		<div class="backup-item">
			<div class="backup-icon import-icon">
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none">
					<path d="M12 15V3m0 0l-4 4m4-4l4 4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</div>
			<div class="backup-info">
				<strong>Import Database</strong>
				<p>Restore from a backup file. <span class="warning-text">This will replace ALL current data.</span></p>
			</div>
			<button class="btn-backup import" onclick={openImportDialog} disabled={importing}>
				{#if importing}
					<span class="spinner"></span> Importing...
				{:else}
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 12V4m0 0L4 7m3-3l3 3M2 2v1a1 1 0 001 1h8a1 1 0 001-1V2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
					Import Backup
				{/if}
			</button>
		</div>
	</div>

	{#if importReport}
		<div class="import-report" class:import-report-done={!importReport.trouble} role={importReport.trouble ? 'alert' : 'status'}>
			<strong>{importReport.headline}</strong>
			{#if importReport.detail}
				<p class="import-report-detail">{importReport.detail}</p>
			{/if}
			{#if importReport.putBack}
				<p class="import-report-detail">{importReport.putBack}</p>
			{/if}
			{#if importReport.requestLinks}
				<p class="import-report-detail">{importReport.requestLinks}</p>
			{/if}
			{#if importReport.workingCopy}
				<p class="import-report-detail">{importReport.workingCopy}</p>
			{/if}
			{#if importReport.secretsKept}
				<p class="import-report-detail">{importReport.secretsKept}</p>
			{/if}
			{#if importReport.secretsToEnter}
				<p class="import-report-detail">{importReport.secretsToEnter}</p>
			{/if}
			{#if importReport.superadmin}
				<p class="import-report-detail">{importReport.superadmin}</p>
			{/if}
			{#if importReport.tables && importReport.tables.length > 0}
				<details class="import-report-tables">
					<summary>All {importReport.tables.length} tables restored</summary>
					<dl>
						{#each importReport.tables as [table, rows]}
							<div><dt>{table}</dt><dd>{count(rows)}</dd></div>
						{/each}
					</dl>
				</details>
			{/if}
			{#if importReport.problems.length > 0}
				<ul>
					{#each importReport.problems.slice(0, 100) as problem}
						<li>{problem}</li>
					{/each}
				</ul>
				{#if importReport.problems.length > 100}
					<p>…and {importReport.problems.length - 100} more.</p>
				{/if}
			{/if}
			<button class="btn-ghost btn-sm" onclick={dismissImportReport}>
				{importReport.reload ? 'Dismiss and reload' : 'Dismiss'}
			</button>
		</div>
	{/if}

	<input type="file" accept=".db,.sqlite,.sqlite3" class="hidden-input" bind:this={fileInput} onchange={handleFileSelected} />
</section>

<!-- Import dialog: the warning, and which of the two ways to restore -->
{#if showImportDialog}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="modal-overlay" role="dialog" aria-modal="true">
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<div class="modal-content confirm-modal" onclick={(e) => e.stopPropagation()} role="document" style="max-width: 520px">
			<h2>Import Database</h2>
			<p style="margin-bottom: var(--space-md)">This will REPLACE ALL existing data with the backup — users, teams, boards, cards, comments, labels, task requests, and settings will all be overwritten. Everybody is signed out, you included: no session is restored, whatever the backup holds, so you will sign in again with an account the backup has. Invites that have not been used yet stop working. A backup with users and no superadmin among them is refused.</p>
			<div class="import-choices" role="radiogroup" aria-label="How to restore the backup">
				<label class="import-choice" class:selected={importOutside === 'keep'}>
					<input type="radio" name="import-outside" value="keep" bind:group={importOutside} />
					<span>
						<strong>Restore everything as it is</strong>
						<span class="import-choice-desc">For putting this installation back. Backup destinations, report schedules, mail settings and webhooks come back as the backup has them. A backup holds no mail password, destination credential or webhook secret: the ones this server has for the same accounts are kept, and the result lists any to enter again; a webhook that had a secret stays off until it is set.</span>
					</span>
				</label>
				<label class="import-choice" class:selected={importOutside === 'off'}>
					<input type="radio" name="import-outside" value="off" bind:group={importOutside} />
					<span>
						<strong>Restore as a working copy</strong>
						<span class="import-choice-desc">For a copy that must not reach outside. Report schedules and webhooks are switched off, the backup schedule is switched off and its destinations removed, and the mail settings are removed. Everything else is restored.</span>
					</span>
				</label>
				{#if importOutsideDefault === 'off' && importOutside === 'off'}
					<span class="import-default-note">Working copy is selected because this instance's schedulers are off.</span>
				{/if}
			</div>
			<div class="modal-actions">
				<button class="btn-ghost" onclick={() => (showImportDialog = false)}>Cancel</button>
				<button class="btn-danger-solid" onclick={async () => { showImportDialog = false; await importDatabase(); }}>Confirm</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Backup & Restore */
	.backup-actions { display: flex; flex-direction: column; gap: var(--space-md); }
	.backup-item {
		display: flex; align-items: center; gap: var(--space-lg);
		padding: var(--space-lg); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		transition: border-color 0.2s ease, transform 0.2s ease;
	}
	.backup-item:hover { border-color: var(--accent-indigo); transform: translateX(2px); }
	.backup-icon {
		width: 48px; height: 48px; border-radius: var(--radius-md);
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.export-icon { background: rgba(52, 211, 153, 0.1); color: var(--accent-emerald); }
	.import-icon { background: rgba(99, 102, 241, 0.1); color: var(--accent-indigo); }
	.backup-info { flex: 1; }
	.backup-info strong { font-size: 0.9rem; display: block; margin-bottom: 4px; }
	.backup-info p { font-size: 0.78rem; color: var(--text-tertiary); margin: 0; line-height: 1.4; }

	.btn-backup {
		padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-sm);
		font-weight: 600; font-size: 0.82rem; border: none; cursor: pointer;
		font-family: var(--font-family); white-space: nowrap;
		display: flex; align-items: center; gap: 6px;
		transition: all 0.2s ease;
	}
	.btn-backup.export {
		background: var(--accent-emerald); color: white;
	}
	.btn-backup.export:hover { background: #059669; transform: scale(1.02); }
	.btn-backup.import {
		background: var(--accent-indigo); color: white;
	}
	.btn-backup.import:hover { background: #4f46e5; transform: scale(1.02); }
	.btn-backup:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

	.spinner {
		width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3);
		border-top-color: white; border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.hidden-input { display: none; }

	/* What an import could not do: stays until dismissed */
	.import-report {
		margin-top: var(--space-md); padding: var(--space-lg);
		background: rgba(244, 63, 94, 0.08);
		border: 1px solid var(--accent-rose); border-radius: var(--radius-md);
		font-size: 0.85rem; line-height: 1.5;
		display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-sm);
	}
	.import-report strong { color: var(--accent-rose); }
	.import-report ul {
		margin: 0; padding-left: var(--space-lg);
		max-height: 240px; overflow-y: auto; align-self: stretch;
		color: var(--text-secondary); overflow-wrap: anywhere;
	}
	.import-report p { margin: 0; color: var(--text-tertiary); }
	/* Nothing wrong: what was restored, and what a working copy switched off */
	.import-report-done { background: rgba(52, 211, 153, 0.08); border-color: var(--accent-emerald); }
	.import-report-done strong { color: var(--accent-emerald); }
	.import-report strong { font-size: 0.95rem; }
	.import-report p.import-report-detail { color: var(--text-secondary); }
	.import-report-tables { align-self: stretch; color: var(--text-secondary); }
	.import-report-tables summary { cursor: pointer; color: var(--text-tertiary); font-size: 0.8rem; }
	.import-report-tables dl {
		margin: var(--space-sm) 0 0; display: grid;
		grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 2px var(--space-lg);
	}
	.import-report-tables dl div { display: flex; justify-content: space-between; gap: var(--space-md); font-size: 0.8rem; }
	.import-report-tables dt { color: var(--text-tertiary); }
	.import-report-tables dd { margin: 0; font-variant-numeric: tabular-nums; }

	/* Import dialog: the two ways to restore */
	.import-choices { display: flex; flex-direction: column; gap: var(--space-sm); margin-bottom: var(--space-xl); }
	.import-choice {
		display: flex; align-items: flex-start; gap: var(--space-sm);
		padding: var(--space-md); background: var(--bg-base);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		cursor: pointer; transition: border-color 0.2s ease;
	}
	.import-choice:hover, .import-choice.selected { border-color: var(--accent-indigo); }
	/* The global rule for inputs gives every one of them the full width and a
	   text field's padding. A radio button takes its own size here, and the
	   words beside it take the rest of the row. */
	.import-choice input {
		width: auto; padding: 0; margin: 3px 0 0; flex: none;
		border: none; background: none; cursor: pointer;
	}
	.import-choice > span { flex: 1; min-width: 0; }
	.import-choice strong { font-size: 0.9rem; display: block; margin-bottom: 4px; }
	.import-choice-desc { font-size: 0.78rem; color: var(--text-tertiary); line-height: 1.4; display: block; }
	.import-default-note { font-size: 0.78rem; color: var(--text-secondary); line-height: 1.4; }
</style>
