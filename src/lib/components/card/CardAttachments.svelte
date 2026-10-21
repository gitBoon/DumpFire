<!--
  CardAttachments.svelte — The card window's Files tab (card 2280, slice B4:
  moved from CardModal.svelte).

  The window draws it whatever tab is shown, and it shows itself on a saved
  card's Files tab, so an upload under way, and why a file of the last one
  was not attached, are kept while another tab is shown, as they always
  were. The files themselves are the window's, bound here: the window reads
  them when the tab is opened on none (its tab shows their count), and this
  asks it to read them again when a delete is refused. Uploads and deletes
  are sent from here, each answer read. Once it has read them, the window
  reads them again, quietly, when its page is told another person's upload
  or delete (card 2337); each shown here tells the window (`onWritten`).
-->
<script module lang="ts">
	export type AttachmentItem = {
		id: number; cardId: number; filename: string; originalName: string;
		mimeType: string; sizeBytes: number; uploadedBy: number | null; createdAt: string;
	};
</script>

<script lang="ts">
	import { answerBody, deleteFailure, uploadFailure, uploadNoAnswer, uploadNotRead } from '$lib/api';
	import type { CardType } from '$lib/types';

	let {
		card,
		activeTab,
		attachments = $bindable(),
		loadingAttachments,
		loadAttachments,
		windowError = $bindable(),
		onWritten
	}: {
		card: CardType | null;
		activeTab: 'details' | 'comments' | 'attachments';
		attachments: AttachmentItem[];
		loadingAttachments: boolean;
		/** The window's: reads the card's files again. */
		loadAttachments: () => Promise<void>;
		windowError: string;
		/**
		 * Called as an upload's file or a delete made here is shown: the window
		 * then takes no answer of a re-read sent before it, which holds the
		 * files as they were (card 2337, as card 2282 for comments).
		 */
		onWritten?: () => void;
	} = $props();

	let uploading = $state(false);
	let dragOver = $state(false);

	/**
	 * Why each file of the last upload that was not attached was not, a line
	 * a file. It stays until the next upload: a file that fails used to be
	 * dropped without a word.
	 */
	let uploadErrors = $state<string[]>([]);

	async function uploadFiles(files: FileList | File[]) {
		if (!card) return;
		uploading = true;
		uploadErrors = [];
		try {
			for (const file of files) {
				const failure = await uploadFile(card.id, file);
				if (failure) uploadErrors = [...uploadErrors, failure];
			}
		} finally {
			// Whatever happened. A request that threw used to leave this set, and
			// the tab saying "Uploading..." until the card was closed.
			uploading = false;
		}
	}

	/**
	 * Attach one file to the card. Null once it is attached, and if it is not,
	 * which of the four things went wrong: see `uploadFailure` in `$lib/api`.
	 */
	async function uploadFile(cardId: number, file: File): Promise<string | null> {
		const what = `"${file.name}"`;

		// The first: it cannot be read here, a folder that was dropped or a file
		// that has moved since. Asked for one byte, so that it is known before
		// the request and not taken for a server that gave no answer.
		try {
			await file.slice(0, 1).arrayBuffer();
		} catch {
			return uploadNotRead(what);
		}

		const form = new FormData();
		form.append('file', file);

		// The second: no answer.
		let res: Response;
		try {
			res = await fetch(`/api/cards/${cardId}/attachments`, {
				method: 'POST',
				body: form
			});
		} catch {
			return uploadNoAnswer(what);
		}

		// The third and the fourth, and anything else the server said of it.
		const created = res.ok ? await answerBody(res.clone()) : null;
		if (created === null) return uploadFailure(res, what);

		// A live re-read may have brought it first (card 2337): shown once.
		const made = created as AttachmentItem;
		attachments = [...attachments.filter(a => a.id !== made.id), made];
		onWritten?.();
		return null;
	}

	async function deleteAttachment(id: number) {
		if (!card) return;
		const cardId = card.id;
		windowError = '';
		const failure = await deleteFailure(() => fetch(`/api/cards/${cardId}/attachments/${id}`, { method: 'DELETE' }), 'attachment');
		if (failure) {
			windowError = failure;
			// And the list is read again, as when the tab was opened: a file
			// somebody else deleted first is the row known to be out of date.
			await loadAttachments();
			return;
		}
		attachments = attachments.filter(a => a.id !== id);
		onWritten?.();
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * The attachments the server answers as an image, which are the only ones
	 * an <img> can show: PNG, JPEG, GIF and WebP, and each by both the type
	 * stored with the upload and the extension of its name. Everything else is
	 * answered as a download, an SVG among them, and gets the ordinary file row.
	 * Keep in step with `attachmentHeaders` in `$lib/server/uploads.ts`.
	 */
	const SHOWN_AS_IMAGE: { stored: string; extensions: string[] }[] = [
		{ stored: 'image/png', extensions: ['png'] },
		{ stored: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
		{ stored: 'image/gif', extensions: ['gif'] },
		{ stored: 'image/webp', extensions: ['webp'] }
	];

	function isShownAsImage(att: { originalName: string; mimeType: string }): boolean {
		const extension = /\.([A-Za-z0-9]+)$/.exec(String(att.originalName ?? ''))?.[1].toLowerCase() ?? '';
		const stored = String(att.mimeType ?? '').split(';')[0].trim().toLowerCase();
		return SHOWN_AS_IMAGE.some((type) => type.stored === stored && type.extensions.includes(extension));
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dragOver = true;
	}
</script>

{#if card && activeTab === 'attachments'}
<!-- Attachments Tab -->
<div class="attachments-section">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="upload-zone"
		class:drag-over={dragOver}
		ondrop={handleDrop}
		ondragover={handleDragOver}
		ondragleave={() => dragOver = false}
	>
		<span class="upload-icon">{uploading ? '⏳' : '📎'}</span>
		<p>{uploading ? 'Uploading...' : 'Drag & drop files here or click to browse'}</p>
		<input type="file" multiple class="upload-input" onchange={(e) => { const el = e.target as HTMLInputElement; if (el.files?.length) uploadFiles(el.files); el.value = ''; }} />
	</div>

	{#if uploadErrors.length > 0}
		<div class="dep-error" role="alert" style="margin-top: 8px">
			{#each uploadErrors as failure}
				<div>{failure}</div>
			{/each}
		</div>
	{/if}

	{#if loadingAttachments}
		<div class="comments-loading">Loading attachments...</div>
	{:else if attachments.length === 0}
		<div class="comments-empty">
			<span class="comments-empty-icon">📂</span>
			<p>No files attached yet. Upload files above.</p>
		</div>
	{:else}
		<div class="attachment-list">
			{#each attachments as att (att.id)}
				<div class="attachment-item">
					{#if isShownAsImage(att)}
						<a href="/api/cards/{card.id}/attachments/{att.id}" target="_blank" class="attachment-thumb">
							<img src="/api/cards/{card.id}/attachments/{att.id}" alt={att.originalName} />
						</a>
					{:else}
						<div class="attachment-icon">📄</div>
					{/if}
					<div class="attachment-info">
						<a href="/api/cards/{card.id}/attachments/{att.id}" class="attachment-name" target="_blank" download={att.originalName}>{att.originalName}</a>
						<span class="attachment-meta">{formatFileSize(att.sizeBytes)}</span>
					</div>
					<button class="attachment-delete" onclick={() => deleteAttachment(att.id)} title="Delete">
						<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
					</button>
				</div>
			{/each}
		</div>
	{/if}
</div>
{/if}

<style>
	/* The window's own field style, on the file box here (CardModal.svelte's `.card-modal-content input`). */
	:global(.card-modal-content) input {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) input:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* A file of the last upload that was not attached, as the window says a refusal. */
	.dep-error {
		margin-bottom: 8px; padding: 7px 10px;
		font-size: 0.74rem; line-height: 1.4;
		background: rgba(244, 63, 94, 0.1); color: var(--accent-rose);
		border: 1px solid rgba(244, 63, 94, 0.25); border-radius: var(--radius-sm);
	}

	/* Loading and empty, drawn as the Comments tab draws them. */
	.comments-loading { text-align: center; color: var(--text-tertiary); padding: var(--space-xl); font-size: 0.85rem; }
	.comments-empty {
		text-align: center; padding: var(--space-2xl); color: var(--text-tertiary);
	}
	.comments-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.comments-empty p { font-size: 0.85rem; }

	/* ─── Attachments ────────────────────────────────────── */
	.attachments-section { display: flex; flex-direction: column; gap: var(--space-md); }
	.upload-zone {
		position: relative; padding: var(--space-xl); text-align: center;
		border: 2px dashed var(--glass-border); border-radius: var(--radius-md);
		background: var(--bg-base); cursor: pointer; transition: all 0.2s;
	}
	.upload-zone:hover, .upload-zone.drag-over {
		border-color: var(--accent-indigo); background: rgba(99, 102, 241, 0.04);
	}
	.upload-icon { font-size: 1.5rem; display: block; margin-bottom: var(--space-xs); }
	.upload-zone p { font-size: 0.82rem; color: var(--text-tertiary); margin: 0; }
	.upload-input {
		position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
	}
	.attachment-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.attachment-item {
		display: flex; align-items: center; gap: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		background: var(--bg-base); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md);
	}
	.attachment-thumb {
		width: 48px; height: 48px; border-radius: var(--radius-sm); overflow: hidden;
		flex-shrink: 0; border: 1px solid var(--glass-border);
	}
	.attachment-thumb img { width: 100%; height: 100%; object-fit: cover; }
	.attachment-icon {
		width: 48px; height: 48px; display: flex; align-items: center; justify-content: center;
		font-size: 1.5rem; flex-shrink: 0;
	}
	.attachment-info { flex: 1; min-width: 0; }
	.attachment-name {
		display: block; font-size: 0.82rem; font-weight: 600; color: var(--accent-indigo);
		text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.attachment-name:hover { text-decoration: underline; }
	.attachment-meta { font-size: 0.7rem; color: var(--text-tertiary); }
	.attachment-delete {
		padding: 6px; background: none; border: none; color: var(--text-tertiary);
		cursor: pointer; border-radius: var(--radius-sm); transition: all 0.15s;
	}
	.attachment-delete:hover { color: #ef4444; background: rgba(239, 68, 68, 0.1); }
</style>
