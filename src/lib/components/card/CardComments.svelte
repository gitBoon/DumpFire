<!--
  CardComments.svelte — The card window's Comments tab (card 2280, slice B4:
  moved from CardModal.svelte).

  The window draws it whatever tab is shown, and it shows itself on a saved
  card's Comments tab, so what is being written or edited here is kept
  while another tab is shown, as it always was. The comments themselves are
  the window's, bound here: the window reads them when it opens (its tab
  shows their count) and again when the tab is opened on none. Posting,
  editing and deleting one are sent from here, each answer read: a refusal
  is said in the window's message box (`windowError`, bound), and what was
  written stays in its box. A delete asks first, in the app's confirm dialog
  drawn here (card 2338).
-->
<script module lang="ts">
	export type CommentItem = {
		id: number; cardId: number; userId: number; content: string;
		createdAt: string; updatedAt: string; username: string; userEmoji: string | null;
	};
</script>

<script lang="ts">
	import { renderMarkdown } from '$lib/markdown';
	import { parseStamp } from '$lib/timestamps';
	import { deleteFailure, failureMessage } from '$lib/api';
	import { page } from '$app/stores';
	import ConfirmModal from '$lib/components/ConfirmModal.svelte';
	import type { CardType } from '$lib/types';

	let {
		card,
		activeTab,
		boardUsers,
		comments = $bindable(),
		loadingComments,
		windowError = $bindable(),
		onWritten
	}: {
		card: CardType | null;
		activeTab: 'details' | 'comments' | 'attachments';
		boardUsers: { id: number; username: string; email?: string; emoji: string }[];
		comments: CommentItem[];
		loadingComments: boolean;
		windowError: string;
		/**
		 * Called as a post, an edit or a delete made here is shown: the window
		 * then takes no answer of a re-read sent before it, which holds the
		 * comments as they were (card 2282, the slice 3 review).
		 */
		onWritten?: () => void;
	} = $props();

	/** What a change that got no answer says: it may or may not have been made. */
	const NO_ANSWER = 'No answer from the server. It is not known whether that was saved.';

	let newComment = $state('');
	let editingCommentId = $state<number | null>(null);
	let editingCommentText = $state('');

	let currentUser = $derived($page.data.user);

	/** What a Save of a comment someone else has deleted says (card 2282). */
	const GONE = 'This comment no longer exists.';

	/**
	 * The comment being edited, as it was when Edit was pressed. A live
	 * re-read can bring a list without it, someone else having deleted it
	 * (card 2282, ruling 5): it is then kept in the thread, where it was,
	 * marked deleted, with its box and what is typed in it, until Save (which
	 * sends nothing and says so) or Cancel (which drops it).
	 */
	let editingKept = $state<CommentItem | null>(null);
	let goneId = $derived(
		editingKept && editingCommentId === editingKept.id && !comments.some(c => c.id === editingKept!.id) ? editingKept.id : null
	);
	/** The thread as drawn: the comments, with the one being edited put back if it has gone. */
	let shown = $derived.by(() => {
		if (goneId === null || !editingKept) return comments;
		const kept = editingKept;
		const at = comments.findIndex(c => c.createdAt < kept.createdAt || (c.createdAt === kept.createdAt && c.id < kept.id));
		return at === -1 ? [...comments, kept] : [...comments.slice(0, at), kept, ...comments.slice(at)];
	});

	function startEdit(comment: CommentItem) {
		editingKept = comment;
		editingCommentId = comment.id;
		editingCommentText = comment.content;
	}

	async function postComment() {
		if (!card || !newComment.trim()) return;
		windowError = '';
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/comments`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: newComment.trim() })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			// What was written stays in the box.
			windowError = await failureMessage(res, 'The comment was not posted.');
			return;
		}
		const created = await res.json();
		// A live re-read may have brought it first (card 2282): shown once.
		comments = [created, ...comments.filter(c => c.id !== created.id)];
		onWritten?.();
		newComment = '';
	}

	async function deleteComment(commentId: number) {
		if (!card) return;
		const cardId = card.id;
		windowError = '';
		const failure = await deleteFailure(() => fetch(`/api/cards/${cardId}/comments/${commentId}`, { method: 'DELETE' }), 'comment');
		if (failure) {
			windowError = failure;
			return;
		}
		comments = comments.filter(c => c.id !== commentId);
		onWritten?.();
	}

	/**
	 * The comment whose Delete was pressed, while its confirm is open: a
	 * delete cannot be undone, and it went at once on one click (card 2338).
	 * The confirm is drawn here, inside the window, which leaves Escape and
	 * Ctrl+Enter to it (CardModal's `handleKeydown`).
	 */
	let deleting = $state<CommentItem | null>(null);

	/** What the confirm says: whose comment, when it is not the deleter's own, and that the log records it. */
	function deleteMessage(comment: CommentItem): string {
		if (currentUser?.id === comment.userId) return 'This comment will be deleted for everyone on the card. This cannot be undone.';
		return `${comment.username}'s comment will be deleted for everyone on the card, and the Activity Log will record that you deleted it. This cannot be undone.`;
	}

	function confirmDelete() {
		if (!deleting) return;
		const commentId = deleting.id;
		deleting = null;
		deleteComment(commentId);
	}

	/**
	 * Closes the edit box on a save that had nothing to send. Kept apart from
	 * `saveEditComment`, whose own closing lines run only for a save the
	 * server took (`tests/page-failures.test.ts` holds that).
	 */
	function closeUnchangedEdit() {
		editingCommentId = null;
		editingCommentText = '';
	}

	/**
	 * Saves the comment being edited. Text that is the comment's own once
	 * trimmed sends nothing and closes the box, as the server would write
	 * nothing for it (card 2284). Otherwise the comment's text and `updatedAt`
	 * are the answer's: the server's time, in the form it stores, and none at
	 * all when it wrote nothing, so "(edited)" shows only for a real change.
	 */
	async function saveEditComment(commentId: number) {
		if (!card || !editingCommentText.trim()) return;
		if (commentId === goneId) {
			// Nothing to save it to: what was typed stays in the box.
			windowError = GONE;
			return;
		}
		windowError = '';
		const editing = comments.find(c => c.id === commentId);
		if (editing && editingCommentText.trim() === editing.content.trim()) {
			closeUnchangedEdit();
			return;
		}
		let res: Response;
		try {
			res = await fetch(`/api/cards/${card.id}/comments/${commentId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editingCommentText.trim() })
			});
		} catch {
			windowError = NO_ANSWER;
			return;
		}
		if (!res.ok) {
			// Still open to edit, with what was written.
			windowError = await failureMessage(res, 'The comment was not saved.');
			return;
		}
		const saved: { content: string; updatedAt: string } = await res.json();
		comments = comments.map(c => c.id === commentId ? { ...c, content: saved.content, updatedAt: saved.updatedAt } : c);
		onWritten?.();
		editingCommentId = null;
		editingCommentText = '';
	}

	/**
	 * Ctrl+Enter (Cmd+Enter) in a comment box sends that comment, and goes no
	 * further: the window saves itself on Ctrl+Enter (its `handleKeydown`, on
	 * `window`), and would otherwise save and close with the comment (card
	 * 2280, slice B5c). Svelte delegates this handler to the root the page is
	 * mounted in, which the key reaches before `window`, so stopping it here
	 * keeps it from the window's handler; `tests/card-window-keys.svelte.test.ts`
	 * holds that. Escape in a comment being edited stops the edit, as its
	 * Cancel does, and is stopped the same way, or it would close the window.
	 */
	function sendKey(e: KeyboardEvent, send: () => void) {
		if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
		e.stopPropagation();
		send();
	}

	function commentTimeAgo(dateStr: string): string {
		const then = parseStamp(dateStr)?.getTime();
		if (then === undefined) return '';
		const diff = Math.floor((Date.now() - then) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}
</script>

{#if card && activeTab === 'comments'}
<!-- Comments Tab -->
<div class="comments-section">
	<div class="comment-input-area">
		<textarea class="comment-input" placeholder="Write a comment... (supports **markdown**)" bind:value={newComment} rows="3" onkeydown={(e) => sendKey(e, postComment)}></textarea>
		<div class="comment-input-actions">
			<span class="comment-hint">Ctrl+Enter to send</span>
			<button class="btn-primary small" onclick={postComment} disabled={!newComment.trim()}>Post Comment</button>
		</div>
	</div>

	{#if loadingComments}
		<div class="comments-loading">Loading comments...</div>
	{:else if shown.length === 0}
		<div class="comments-empty">
			<span class="comments-empty-icon">💬</span>
			<p>No comments yet. Be the first to comment!</p>
		</div>
	{:else}
		<div class="comment-thread">
			{#each shown as comment (comment.id)}
				<div class="comment-item">
					<div class="comment-avatar">{comment.userEmoji || '👤'}</div>
					<div class="comment-body">
						<div class="comment-meta">
							<span class="comment-author">{comment.username}</span>
							<span class="comment-time">{commentTimeAgo(comment.createdAt)}</span>
							{#if comment.createdAt !== comment.updatedAt}<span class="comment-edited">(edited)</span>{/if}
							{#if comment.id === goneId}<span class="comment-gone">(deleted)</span>{/if}
						</div>
						{#if editingCommentId === comment.id}
							<textarea class="comment-edit-input" bind:value={editingCommentText} rows="3" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); editingCommentId = null; } else sendKey(e, () => saveEditComment(comment.id)); }}></textarea>
							<div class="comment-edit-actions">
								<button class="btn-primary small" onclick={() => saveEditComment(comment.id)}>Save</button>
								<button class="btn-ghost small" onclick={() => (editingCommentId = null)}>Cancel</button>
							</div>
						{:else}
							<div class="comment-content markdown-body">{@html renderMarkdown(comment.content, { mentions: boardUsers.map((u) => u.username) })}</div>
							{#if currentUser && (currentUser.id === comment.userId || currentUser.role === 'admin' || currentUser.role === 'superadmin')}
								<div class="comment-actions">
									{#if currentUser.id === comment.userId}
										<button class="comment-action-btn" onclick={() => startEdit(comment)}>Edit</button>
									{/if}
									<button class="comment-action-btn danger" onclick={() => (deleting = comment)}>Delete</button>
								</div>
							{/if}
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}

	{#if deleting}
		<ConfirmModal
			title="Delete Comment"
			message={deleteMessage(deleting)}
			confirmText="Delete"
			onConfirm={confirmDelete}
			onCancel={() => (deleting = null)}
		/>
	{/if}
</div>
{/if}

<style>
	/* The window's own field style, on the boxes here (CardModal.svelte's `.card-modal-content textarea`). */
	:global(.card-modal-content) textarea {
		background: var(--bg-base); border: 1px solid var(--glass-border);
	}
	:global(.card-modal-content) textarea:focus {
		border-color: var(--accent-indigo); box-shadow: 0 0 0 2px var(--accent-purple-glow);
	}

	/* ─── Comments ──────────────────────────────────────────── */
	.comments-section { display: flex; flex-direction: column; gap: var(--space-lg); }
	.comment-input-area { display: flex; flex-direction: column; gap: var(--space-sm); }
	.comment-input {
		padding: var(--space-md); font-size: 0.85rem; min-height: 80px; resize: vertical;
		background: var(--bg-base); border: 1px solid var(--glass-border); border-radius: var(--radius-md);
		color: var(--text-primary); font-family: var(--font-family);
	}
	.comment-input:focus { outline: none; border-color: var(--accent-indigo); }
	.comment-input-actions { display: flex; justify-content: space-between; align-items: center; }
	.comment-hint { font-size: 0.7rem; color: var(--text-tertiary); }
	.comments-loading { text-align: center; color: var(--text-tertiary); padding: var(--space-xl); font-size: 0.85rem; }
	.comments-empty {
		text-align: center; padding: var(--space-2xl); color: var(--text-tertiary);
	}
	.comments-empty-icon { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
	.comments-empty p { font-size: 0.85rem; }
	.comment-thread { display: flex; flex-direction: column; gap: var(--space-md); }
	.comment-item {
		display: flex; gap: var(--space-sm); padding: var(--space-md);
		background: var(--bg-base); border-radius: var(--radius-md);
		border: 1px solid var(--glass-border); overflow: hidden;
	}
	.comment-avatar {
		width: 32px; height: 32px; border-radius: 50%; background: var(--bg-surface);
		display: flex; align-items: center; justify-content: center; font-size: 1rem;
		flex-shrink: 0; border: 1px solid var(--glass-border);
	}
	.comment-body { flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
	.comment-meta { display: flex; align-items: center; gap: var(--space-sm); margin-bottom: var(--space-xs); }
	.comment-author { font-size: 0.8rem; font-weight: 700; color: var(--text-primary); }
	.comment-time { font-size: 0.7rem; color: var(--text-tertiary); }
	.comment-edited { font-size: 0.65rem; color: var(--text-tertiary); font-style: italic; }
	.comment-gone { font-size: 0.65rem; color: var(--accent-rose); font-style: italic; }
	.comment-content { font-size: 0.85rem; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; word-break: break-word; overflow: hidden; }
	.comment-content :global(p) { margin: 0 0 var(--space-xs); overflow-wrap: anywhere; word-break: break-word; }
	.comment-content :global(p:last-child) { margin: 0; }
	.comment-content :global(pre) { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
	.comment-content :global(code) { word-break: break-all; }
	.comment-content :global(blockquote) { margin: var(--space-sm) 0; padding-left: var(--space-md); border-left: 3px solid var(--glass-border); color: var(--text-tertiary); }
	.comment-content :global(.mention-chip) {
		display: inline; padding: 1px 4px; border-radius: 3px;
		background: rgba(139, 92, 246, 0.12); color: #8b5cf6;
		font-weight: 600; font-size: 0.82em;
	}
	.comment-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-xs); }
	.comment-action-btn {
		font-size: 0.7rem; color: var(--text-tertiary); background: none; border: none;
		cursor: pointer; padding: 2px 6px; border-radius: var(--radius-sm);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.comment-action-btn:hover { color: var(--text-primary); background: var(--bg-surface); }
	.comment-action-btn.danger:hover { color: #ef4444; background: rgba(239,68,68,0.1); }
	.comment-edit-input {
		width: 100%; padding: var(--space-sm); font-size: 0.82rem; resize: vertical;
		background: var(--bg-surface); border: 1px solid var(--accent-indigo); border-radius: var(--radius-sm);
		color: var(--text-primary); font-family: var(--font-family);
	}
	.comment-edit-actions { display: flex; gap: var(--space-sm); margin-top: var(--space-xs); }
</style>
