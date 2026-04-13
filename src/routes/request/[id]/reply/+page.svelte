<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/stores';

	type Message = {
		id: number;
		requestId: number;
		senderType: string;
		senderName: string;
		message: string;
		createdAt: string;
	};

	type RequestInfo = {
		id: number;
		title: string;
		description: string;
		priority: string;
		status: string;
		requesterName: string;
		requesterEmail: string | null;
		createdAt: string;
	};

	let requestId = $derived(Number($page.params.id));
	let email = $derived($page.url.searchParams.get('email') || '');

	let request = $state<RequestInfo | null>(null);
	let messages = $state<Message[]>([]);
	let newMessage = $state('');
	let loading = $state(true);
	let sending = $state(false);
	let errorMsg = $state('');
	let threadEl: HTMLDivElement | undefined = $state();
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	onMount(async () => {
		await loadData();
		// Poll for new messages every 5 seconds
		pollInterval = setInterval(pollMessages, 5000);
	});

	onDestroy(() => {
		if (pollInterval) clearInterval(pollInterval);
	});

	async function pollMessages() {
		try {
			const msgRes = await fetch(`/api/requests/${requestId}/messages?email=${encodeURIComponent(email)}`);
			if (msgRes.ok) {
				const fresh: Message[] = await msgRes.json();
				if (fresh.length !== messages.length) {
					messages = fresh;
					scrollToBottom();
				}
			}
		} catch { /* silent */ }
	}

	function scrollToBottom() {
		requestAnimationFrame(() => {
			if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
		});
	}

	async function loadData() {
		loading = true;
		try {
			// Load request info (public endpoint — supports email token auth)
			const reqRes = await fetch(`/api/requests/${requestId}?email=${encodeURIComponent(email)}`);
			if (reqRes.ok) {
				request = await reqRes.json();
			}

			// Load messages
			const msgRes = await fetch(`/api/requests/${requestId}/messages?email=${encodeURIComponent(email)}`);
			if (msgRes.ok) {
				messages = await msgRes.json();
				scrollToBottom();
			}
		} catch (e) {
			errorMsg = 'Failed to load conversation';
		}
		loading = false;
	}

	async function sendReply() {
		if (!newMessage.trim() || !email) return;
		sending = true;
		errorMsg = '';

		const res = await fetch(`/api/requests/${requestId}/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				message: newMessage.trim(),
				senderType: 'requester',
				email
			})
		});

		sending = false;
		if (res.ok) {
			newMessage = '';
			await loadData();
		} else {
			const data = await res.json().catch(() => ({}));
			errorMsg = data.message || 'Failed to send message';
		}
	}

	function timeAgo(dateStr: string): string {
		const now = Date.now();
		const then = new Date(dateStr.endsWith('Z') ? dateStr : dateStr + 'Z').getTime();
		if (isNaN(then)) return 'unknown';
		const diff = Math.floor((now - then) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	const priorityLabels: Record<string, string> = {
		critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low'
	};
</script>

<svelte:head>
	<title>Request Conversation — DumpFire</title>
</svelte:head>

<div class="reply-page">
	<div class="reply-container">
		<a href="/" class="home-link" title="Home">🏠</a>
		<div class="reply-header">
			<span class="reply-icon">💬</span>
			<h1>Request Conversation</h1>
		</div>

		{#if loading}
			<div class="loading-state">Loading...</div>
		{:else if !request}
			<div class="error-state">
				<span>❌</span>
				<p>Request not found or you don't have access.</p>
			</div>
		{:else}
			<!-- Request summary -->
			<div class="request-summary">
				<div class="summary-top">
					<span class="priority-badge priority-{request.priority}">{priorityLabels[request.priority] || request.priority}</span>
					<span class="status-badge" class:status-pending={request.status === 'pending'} class:status-accepted={request.status === 'accepted'} class:status-rejected={request.status === 'rejected'}>
						{request.status === 'pending' ? '⏳ Pending' : request.status === 'accepted' ? '✅ Accepted' : '❌ Rejected'}
					</span>
				</div>
				<h2 class="summary-title">{request.title}</h2>
				{#if request.description}
					<p class="summary-desc">{request.description}</p>
				{/if}
				<p class="summary-meta">Submitted {timeAgo(request.createdAt)}</p>
			</div>

			<!-- Messages thread -->
			<div class="messages-thread" bind:this={threadEl}>
				{#if messages.length === 0}
					<div class="no-messages">No messages yet. Start the conversation below.</div>
				{:else}
					{#each messages as msg}
						<div class="msg-bubble" class:msg-admin={msg.senderType === 'admin'} class:msg-requester={msg.senderType === 'requester'}>
							<div class="msg-header">
								<span class="msg-sender">{msg.senderType === 'admin' ? '🛡️' : '👤'} {msg.senderName}</span>
								<span class="msg-time">{timeAgo(msg.createdAt)}</span>
							</div>
							<p class="msg-text">{msg.message}</p>
						</div>
					{/each}
				{/if}
			</div>

			<!-- Reply input -->
			{#if request.status === 'pending'}
				<div class="reply-input-area">
					{#if errorMsg}
						<div class="error-msg">{errorMsg}</div>
					{/if}
					<textarea
						bind:value={newMessage}
						placeholder="Type your reply..."
						rows="3"
						class="reply-textarea"
						onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendReply(); }}
					></textarea>
					<div class="reply-actions">
						<span class="reply-hint">Ctrl+Enter to send</span>
						<button class="btn-send" disabled={sending || !newMessage.trim()} onclick={sendReply}>
							{sending ? 'Sending...' : '📨 Send Reply'}
						</button>
					</div>
				</div>
			{:else}
				<div class="resolved-notice">
					This request has been {request.status}. No further replies can be sent.
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.reply-page {
		min-height: 100vh;
		display: flex; align-items: flex-start; justify-content: center;
		padding: var(--space-xl); padding-top: 40px;
	}
	.reply-container {
		width: 100%; max-width: 640px;
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		padding: var(--space-2xl);
		box-shadow: var(--shadow-lg);
		position: relative;
	}

	.home-link {
		position: absolute; top: var(--space-lg); right: var(--space-lg);
		font-size: 1.3rem; text-decoration: none; opacity: 0.5;
		transition: opacity var(--duration-fast) var(--ease-out);
	}
	.home-link:hover { opacity: 1; }

	.reply-header { text-align: center; margin-bottom: var(--space-lg); }
	.reply-icon { font-size: 2rem; }
	.reply-header h1 { font-size: 1.3rem; font-weight: 700; color: var(--text-primary); margin-top: var(--space-xs); }

	/* Summary */
	.request-summary {
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-md);
		margin-bottom: var(--space-lg);
	}
	.summary-top { display: flex; gap: var(--space-sm); margin-bottom: var(--space-xs); }
	.summary-title { font-size: 1rem; font-weight: 600; color: var(--text-primary); margin-bottom: var(--space-xs); }
	.summary-desc { font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: var(--space-xs); }
	.summary-meta { font-size: 0.72rem; color: var(--text-tertiary); }

	.priority-badge {
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
	}
	.priority-critical { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
	.priority-high { background: rgba(249, 115, 22, 0.1); color: #f97316; }
	.priority-medium { background: rgba(234, 179, 8, 0.1); color: #eab308; }
	.priority-low { background: rgba(34, 197, 94, 0.1); color: #22c55e; }

	.status-badge {
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
	}
	.status-pending { background: rgba(234, 179, 8, 0.1); color: #eab308; }
	.status-accepted { background: rgba(34, 197, 94, 0.1); color: #22c55e; }
	.status-rejected { background: rgba(239, 68, 68, 0.1); color: #ef4444; }

	/* Messages */
	.messages-thread {
		display: flex; flex-direction: column; gap: var(--space-sm);
		margin-bottom: var(--space-lg);
		max-height: 400px; overflow-y: auto;
		padding: var(--space-sm) 0;
	}
	.no-messages { text-align: center; color: var(--text-tertiary); font-size: 0.85rem; padding: var(--space-lg); }

	.msg-bubble {
		max-width: 85%; padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md);
		font-size: 0.85rem;
	}
	.msg-admin {
		align-self: flex-start;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-bottom-left-radius: 4px;
	}
	.msg-requester {
		align-self: flex-end;
		background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.15);
		border-bottom-right-radius: 4px;
	}
	.msg-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
	.msg-sender { font-size: 0.72rem; font-weight: 600; color: var(--text-secondary); }
	.msg-time { font-size: 0.62rem; color: var(--text-tertiary); }
	.msg-text { margin: 0; color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; }

	/* Reply input */
	.reply-input-area { border-top: 1px solid var(--glass-border); padding-top: var(--space-md); }
	.reply-textarea {
		width: 100%; padding: 10px 14px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
		resize: vertical; min-height: 70px;
		transition: border-color var(--duration-fast) var(--ease-out);
	}
	.reply-textarea:focus { outline: none; border-color: var(--accent-indigo); box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1); }
	.reply-actions { display: flex; justify-content: space-between; align-items: center; margin-top: var(--space-sm); }
	.reply-hint { font-size: 0.68rem; color: var(--text-tertiary); }
	.btn-send {
		padding: 8px 18px; background: var(--accent-indigo); color: white; border: none;
		border-radius: var(--radius-md); font-weight: 600; font-size: 0.82rem;
		cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-send:hover:not(:disabled) { background: #5558e6; }
	.btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

	.resolved-notice {
		text-align: center; padding: var(--space-md);
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error-msg {
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2);
		border-radius: var(--radius-md); padding: 8px 12px;
		color: var(--accent-rose); font-size: 0.8rem; margin-bottom: var(--space-sm);
	}
	.loading-state, .error-state { text-align: center; padding: var(--space-xl); color: var(--text-secondary); }
	.error-state span { font-size: 2rem; display: block; margin-bottom: var(--space-sm); }
</style>
