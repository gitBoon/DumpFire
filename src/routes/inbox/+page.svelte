<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let { data } = $props();

	type TaskRequest = {
		id: number;
		targetType: string;
		targetId: number;
		targetName: string;
		targetEmoji: string;
		requesterName: string;
		requesterEmail: string | null;
		requesterUserId: number | null;
		title: string;
		description: string;
		businessValue: string | null;
		priority: string;
		status: string;
		rejectReason: string | null;
		resolvedCardId: number | null;
		resolvedBoardId: number | null;
		createdAt: string;
		resolvedAt: string | null;
	};

	let requests = $state<TaskRequest[]>([]);
	let loading = $state(true);
	let tab = $state<'all' | 'me' | 'team'>('all');

	// Accept modal state
	let acceptModal = $state<{ show: boolean; request: TaskRequest | null; boardId: number | null; columnId: number | null; assigneeId: number | null }>({
		show: false, request: null, boardId: null, columnId: null, assigneeId: null
	});

	// Reject modal state
	let rejectModal = $state<{ show: boolean; request: TaskRequest | null; reason: string }>({
		show: false, request: null, reason: ''
	});

	// Conversation modal state
	type ChatMessage = { id: number; requestId: number; senderType: string; senderName: string; message: string; createdAt: string };
	let chatModal = $state<{ show: boolean; request: TaskRequest | null; messages: ChatMessage[]; newMsg: string; sending: boolean }>({
		show: false, request: null, messages: [], newMsg: '', sending: false
	});
	let chatPollInterval: ReturnType<typeof setInterval> | null = null;
	let chatMessagesEl: HTMLDivElement | undefined = $state();

	let showResolved = $state(false);

	const pendingRequests = $derived(
		requests.filter(r => r.status === 'pending').filter(r => {
			if (tab === 'me') return r.targetType === 'user';
			if (tab === 'team') return r.targetType === 'team';
			return true;
		})
	);
	const resolvedRequests = $derived(
		requests.filter(r => r.status !== 'pending').filter(r => {
			if (tab === 'me') return r.targetType === 'user';
			if (tab === 'team') return r.targetType === 'team';
			return true;
		})
	);

	const selectedBoardColumns = $derived(
		acceptModal.boardId
			? data.boards.find((b: any) => b.id === acceptModal.boardId)?.columns || []
			: []
	);

	onMount(async () => {
		await loadRequests();
	});

	onDestroy(() => {
		if (chatPollInterval) clearInterval(chatPollInterval);
	});

	async function loadRequests() {
		loading = true;
		const res = await fetch('/api/requests');
		if (res.ok) requests = await res.json();
		loading = false;
	}

	async function acceptRequest() {
		const req = acceptModal.request;
		if (!req || !acceptModal.boardId || !acceptModal.columnId) return;

		const res = await fetch(`/api/requests/${req.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'accept',
				boardId: acceptModal.boardId,
				columnId: acceptModal.columnId,
				assigneeId: acceptModal.assigneeId
			})
		});
		if (res.ok) {
			acceptModal = { show: false, request: null, boardId: null, columnId: null, assigneeId: null };
			await loadRequests();
		}
	}

	async function rejectRequest() {
		const req = rejectModal.request;
		if (!req) return;

		const res = await fetch(`/api/requests/${req.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'reject',
				rejectReason: rejectModal.reason.trim() || undefined
			})
		});
		if (res.ok) {
			rejectModal = { show: false, request: null, reason: '' };
			await loadRequests();
		}
	}

	function timeAgo(dateStr: string): string {
		const now = Date.now();
		const then = new Date(dateStr + 'Z').getTime();
		const diff = Math.floor((now - then) / 1000);
		if (diff < 60) return 'just now';
		if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
		if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
		return `${Math.floor(diff / 86400)}d ago`;
	}

	const priorityLabels: Record<string, string> = {
		critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low'
	};

	async function openChat(req: TaskRequest) {
		chatModal = { show: true, request: req, messages: [], newMsg: '', sending: false };
		const res = await fetch(`/api/requests/${req.id}/messages`);
		if (res.ok) {
			chatModal.messages = await res.json();
			scrollChatToBottom();
		}
		// Start polling for new messages
		if (chatPollInterval) clearInterval(chatPollInterval);
		chatPollInterval = setInterval(() => pollChatMessages(req.id), 5000);
	}

	function closeChat() {
		if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
		chatModal = { show: false, request: null, messages: [], newMsg: '', sending: false };
	}

	async function pollChatMessages(requestId: number) {
		try {
			const res = await fetch(`/api/requests/${requestId}/messages`);
			if (res.ok) {
				const fresh: ChatMessage[] = await res.json();
				if (fresh.length !== chatModal.messages.length) {
					chatModal.messages = fresh;
					scrollChatToBottom();
				}
			}
		} catch { /* silent */ }
	}

	function scrollChatToBottom() {
		requestAnimationFrame(() => {
			if (chatMessagesEl) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
		});
	}

	async function sendChatMessage() {
		if (!chatModal.request || !chatModal.newMsg.trim()) return;
		chatModal.sending = true;
		const res = await fetch(`/api/requests/${chatModal.request.id}/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ message: chatModal.newMsg.trim() })
		});
		chatModal.sending = false;
		if (res.ok) {
			chatModal.newMsg = '';
			// Reload messages
			const msgRes = await fetch(`/api/requests/${chatModal.request.id}/messages`);
			if (msgRes.ok) {
				chatModal.messages = await msgRes.json();
				scrollChatToBottom();
			}
		}
	}
</script>

<svelte:head>
	<title>Inbox — DumpFire</title>
</svelte:head>

<div class="inbox-page">
	<header class="inbox-header glass">
		<div class="inbox-header-inner">
			<a href="/" class="header-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<h1 class="header-title">📥 Inbox</h1>
			<div class="header-spacer"></div>
		</div>
	</header>

	<main class="inbox-content">
	<!-- Tabs -->
	<div class="inbox-tabs">
		<button class="tab" class:active={tab === 'all'} onclick={() => tab = 'all'}>
			All <span class="tab-count">{requests.filter(r => r.status === 'pending').length}</span>
		</button>
		<button class="tab" class:active={tab === 'me'} onclick={() => tab = 'me'}>
			👤 For Me <span class="tab-count">{requests.filter(r => r.status === 'pending' && r.targetType === 'user').length}</span>
		</button>
		<button class="tab" class:active={tab === 'team'} onclick={() => tab = 'team'}>
			🏢 For My Teams <span class="tab-count">{requests.filter(r => r.status === 'pending' && r.targetType === 'team').length}</span>
		</button>
	</div>

	{#if loading}
		<div class="loading-state">Loading...</div>
	{:else if pendingRequests.length === 0 && resolvedRequests.length === 0}
		<div class="empty-state">
			<div class="empty-icon">📭</div>
			<h2>No requests</h2>
			<p>When someone submits a task request targeting you or your team, it'll appear here.</p>
		</div>
	{:else}
		<!-- Pending -->
		{#if pendingRequests.length > 0}
			<div class="section-label">Pending · {pendingRequests.length}</div>
			<div class="requests-list">
				{#each pendingRequests as req}
					<div class="request-card">
						<div class="request-top">
							<span class="priority-badge priority-{req.priority}">{priorityLabels[req.priority] || req.priority}</span>
							<span class="target-badge" class:target-team={req.targetType === 'team'} class:target-user={req.targetType === 'user'}>
								{req.targetEmoji} {req.targetName}
							</span>
							<span class="request-age">{timeAgo(req.createdAt)}</span>
						</div>
						<h3 class="request-title">{req.title}</h3>
						{#if req.description}
							<p class="request-desc">{req.description}</p>
						{/if}
						{#if req.businessValue}
							<div class="bv-callout">
								<span class="bv-label">💡 Business Value</span>
								<p class="bv-text">{req.businessValue}</p>
							</div>
						{/if}
						<div class="request-bottom">
							<span class="requester-info">
								From: {req.requesterName}
								{#if req.requesterEmail}
									<span class="requester-email">({req.requesterEmail})</span>
								{/if}
							</span>
							<div class="request-actions">
								<button class="btn-discuss" onclick={() => openChat(req)}>
									💬 Discuss
								</button>
								<button class="btn-accept" onclick={() => acceptModal = { show: true, request: req, boardId: null, columnId: null, assigneeId: null }}>
									✅ Accept
								</button>
								<button class="btn-reject" onclick={() => rejectModal = { show: true, request: req, reason: '' }}>
									❌ Reject
								</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="all-clear">
				<span>🎉</span> No pending requests — you're all caught up!
			</div>
		{/if}

		<!-- Resolved -->
		{#if resolvedRequests.length > 0}
			<button class="resolved-toggle" onclick={() => showResolved = !showResolved}>
				{showResolved ? '▼' : '▶'} Resolved · {resolvedRequests.length}
			</button>
			{#if showResolved}
				<div class="requests-list resolved">
					{#each resolvedRequests as req}
						<div class="request-card" class:accepted={req.status === 'accepted'} class:rejected={req.status === 'rejected'}>
							<div class="request-top">
								<span class="status-badge" class:status-accepted={req.status === 'accepted'} class:status-rejected={req.status === 'rejected'}>
									{req.status === 'accepted' ? '✅ Accepted' : '❌ Rejected'}
								</span>
								<span class="target-badge" class:target-team={req.targetType === 'team'} class:target-user={req.targetType === 'user'}>
									{req.targetEmoji} {req.targetName}
								</span>
								<span class="request-age">{timeAgo(req.createdAt)}</span>
							</div>
							<h3 class="request-title">{req.title}</h3>
							{#if req.businessValue}
								<div class="bv-callout">
									<span class="bv-label">💡 Business Value</span>
									<p class="bv-text">{req.businessValue}</p>
								</div>
							{/if}
							{#if req.rejectReason}
								<p class="reject-reason">Reason: {req.rejectReason}</p>
							{/if}
							{#if req.resolvedCardId && req.resolvedBoardId}
								<a class="view-card-link" href="/board/{req.resolvedBoardId}?card={req.resolvedCardId}">
									View created card →
								</a>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		{/if}
	{/if}
	</main>
</div>

<!-- Accept Modal -->
{#if acceptModal.show && acceptModal.request}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay">
		<div class="modal-card" onclick={(e) => e.stopPropagation()}>
			<h2>Accept Request</h2>
			<p class="modal-desc">Create a card from "<strong>{acceptModal.request.title}</strong>" on a board.</p>

			<div class="modal-field">
				<label>Board</label>
				<select bind:value={acceptModal.boardId} class="modal-select" onchange={() => acceptModal.columnId = null}>
					<option value={null}>Select a board...</option>
					{#each data.boards as board}
						<option value={board.id}>{board.emoji || '📋'} {board.name}</option>
					{/each}
				</select>
			</div>

			{#if acceptModal.boardId}
				<div class="modal-field">
					<label>Column</label>
					<select bind:value={acceptModal.columnId} class="modal-select">
						<option value={null}>Select a column...</option>
						{#each selectedBoardColumns as col}
							<option value={col.id}>{col.title}</option>
						{/each}
					</select>
				</div>
			{/if}

			<div class="modal-field">
				<label>Assign to <span style="color: var(--text-tertiary); font-weight: 400">(optional)</span></label>
				<select bind:value={acceptModal.assigneeId} class="modal-select">
					<option value={null}>Unassigned</option>
					{#each data.users as u}
						<option value={u.id}>{u.emoji || '👤'} {u.username}</option>
					{/each}
				</select>
			</div>

			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => acceptModal = { show: false, request: null, boardId: null, columnId: null, assigneeId: null }}>Cancel</button>
				<button class="btn-confirm" disabled={!acceptModal.boardId || !acceptModal.columnId} onclick={acceptRequest}>
					Create Card & Accept
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Reject Modal -->
{#if rejectModal.show && rejectModal.request}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay">
		<div class="modal-card" onclick={(e) => e.stopPropagation()}>
			<h2>Reject Request</h2>
			<p class="modal-desc">Reject "<strong>{rejectModal.request.title}</strong>"</p>

			<div class="modal-field">
				<label>Reason <span style="color: var(--text-tertiary); font-weight: 400">(optional)</span></label>
				<textarea bind:value={rejectModal.reason} class="modal-textarea" rows="3" placeholder="Why are you rejecting this request?"></textarea>
			</div>

			<div class="modal-actions">
				<button class="btn-cancel" onclick={() => rejectModal = { show: false, request: null, reason: '' }}>Cancel</button>
				<button class="btn-reject-confirm" onclick={rejectRequest}>Reject Request</button>
			</div>
		</div>
	</div>
{/if}

<!-- Conversation Modal -->
{#if chatModal.show && chatModal.request}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay">
		<div class="modal-card chat-modal" onclick={(e) => e.stopPropagation()}>
			<div class="chat-header">
				<div>
					<h2>💬 Discussion</h2>
					<p class="chat-title">{chatModal.request.title}</p>
					{#if chatModal.request.requesterEmail}
						<p class="chat-requester-info">With: {chatModal.request.requesterName} ({chatModal.request.requesterEmail})</p>
					{/if}
				</div>
				<button class="chat-close" onclick={closeChat}>✕</button>
			</div>

			<div class="chat-messages" bind:this={chatMessagesEl}>
				{#if chatModal.messages.length === 0}
					<div class="chat-empty">No messages yet. Start the conversation!</div>
				{:else}
					{#each chatModal.messages as msg}
						<div class="chat-bubble" class:chat-admin={msg.senderType === 'admin'} class:chat-requester-bubble={msg.senderType === 'requester'}>
							<div class="chat-bubble-header">
								<span class="chat-sender">{msg.senderType === 'admin' ? '🛡️' : '👤'} {msg.senderName}</span>
								<span class="chat-time">{timeAgo(msg.createdAt)}</span>
							</div>
							<p class="chat-text">{msg.message}</p>
						</div>
					{/each}
				{/if}
			</div>

			<div class="chat-input-area">
				<textarea
					bind:value={chatModal.newMsg}
					placeholder="Type a message..."
					rows="2"
					class="chat-textarea"
					onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChatMessage(); }}
				></textarea>
				<button class="btn-send-chat" disabled={chatModal.sending || !chatModal.newMsg.trim()} onclick={sendChatMessage}>
					{chatModal.sending ? '...' : '📨 Send'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.inbox-page { min-height: 100vh; padding-top: 64px; }
	.inbox-header {
		position: fixed; top: 0; left: 0; right: 0; z-index: 200;
		height: 64px; border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
	}
	.inbox-header-inner {
		max-width: 1400px; margin: 0 auto; height: 100%;
		display: flex; align-items: center; justify-content: center;
		padding: 0 var(--space-xl); gap: var(--space-lg); position: relative;
	}
	.header-logo {
		position: absolute; left: var(--space-xl);
		display: flex; align-items: center; gap: var(--space-sm);
		text-decoration: none; color: var(--text-primary);
		font-weight: 700; font-size: 1.1rem;
	}
	.logo-fire { font-size: 1.4rem; }
	.header-title {
		font-size: 1rem; font-weight: 700; color: var(--text-primary);
		letter-spacing: -0.01em;
	}
	.header-spacer {
		position: absolute; right: var(--space-xl);
		width: 80px;
	}
	.inbox-content {
		max-width: 800px; margin: 0 auto;
		padding: var(--space-2xl);
	}

	/* Tabs */
	.inbox-tabs {
		display: flex; gap: var(--space-xs); margin-bottom: var(--space-lg);
		border-bottom: 1px solid var(--glass-border); padding-bottom: var(--space-sm);
	}
	.tab {
		display: flex; align-items: center; gap: 6px;
		padding: 8px 16px; border: none; background: transparent;
		color: var(--text-secondary); font-size: 0.82rem; font-weight: 600;
		cursor: pointer; border-radius: var(--radius-md); font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.tab:hover { background: var(--bg-surface); color: var(--text-primary); }
	.tab.active { background: var(--accent-indigo); color: white; }
	.tab-count {
		background: rgba(255, 255, 255, 0.2); padding: 1px 6px;
		border-radius: var(--radius-full); font-size: 0.7rem;
	}
	.tab:not(.active) .tab-count { background: var(--bg-surface); }

	/* Section */
	.section-label {
		font-size: 0.75rem; font-weight: 700; color: var(--text-tertiary);
		text-transform: uppercase; letter-spacing: 0.05em;
		margin-bottom: var(--space-sm);
	}

	/* Request cards */
	.requests-list { display: flex; flex-direction: column; gap: var(--space-sm); }
	.request-card {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); padding: var(--space-md);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.request-card:hover { border-color: rgba(99, 102, 241, 0.3); }
	.request-card.accepted { opacity: 0.7; border-left: 3px solid #22c55e; }
	.request-card.rejected { opacity: 0.7; border-left: 3px solid #ef4444; }

	.request-top { display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap; margin-bottom: var(--space-xs); }
	.request-title { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin-bottom: var(--space-xs); }
	.request-desc {
		font-size: 0.82rem; color: var(--text-secondary); line-height: 1.5;
		margin-bottom: var(--space-sm);
		display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
	}
	.bv-callout {
		background: rgba(99, 102, 241, 0.06); border: 1px solid rgba(99, 102, 241, 0.15);
		border-radius: var(--radius-md); padding: var(--space-sm) var(--space-md);
		margin-bottom: var(--space-sm);
	}
	.bv-label { font-size: 0.72rem; font-weight: 700; color: var(--accent-indigo); text-transform: uppercase; letter-spacing: 0.03em; }
	.bv-text { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; margin-top: 2px; }
	.request-age { font-size: 0.7rem; color: var(--text-tertiary); margin-left: auto; }

	.target-badge {
		display: inline-flex; align-items: center; gap: 3px;
		padding: 2px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
	}
	.target-team { background: rgba(99, 102, 241, 0.1); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.2); }
	.target-user { background: rgba(16, 185, 129, 0.1); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.2); }

	.status-badge {
		padding: 2px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
	}
	.status-accepted { background: rgba(16, 185, 129, 0.1); color: #22c55e; }
	.status-rejected { background: rgba(239, 68, 68, 0.1); color: #ef4444; }

	.priority-badge {
		display: inline-flex; align-items: center; gap: 2px;
		padding: 1px 8px; border-radius: var(--radius-full);
		font-size: 0.68rem; font-weight: 600;
	}
	.priority-critical { background: rgba(239, 68, 68, 0.1); color: #ef4444; }
	.priority-high { background: rgba(249, 115, 22, 0.1); color: #f97316; }
	.priority-medium { background: rgba(234, 179, 8, 0.1); color: #eab308; }
	.priority-low { background: rgba(34, 197, 94, 0.1); color: #22c55e; }

	.request-bottom {
		display: flex; align-items: center; justify-content: space-between;
		flex-wrap: wrap; gap: var(--space-sm); margin-top: var(--space-sm);
	}
	.requester-info { font-size: 0.75rem; color: var(--text-secondary); }
	.requester-email { color: var(--text-tertiary); }

	.request-actions { display: flex; gap: var(--space-xs); }
	.btn-accept, .btn-reject {
		padding: 6px 14px; border-radius: var(--radius-md);
		font-size: 0.78rem; font-weight: 600; cursor: pointer;
		border: 1px solid transparent; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-accept {
		background: rgba(16, 185, 129, 0.1); color: #22c55e;
		border-color: rgba(16, 185, 129, 0.2);
	}
	.btn-accept:hover { background: rgba(16, 185, 129, 0.2); }
	.btn-reject {
		background: rgba(239, 68, 68, 0.08); color: #ef4444;
		border-color: rgba(239, 68, 68, 0.15);
	}
	.btn-reject:hover { background: rgba(239, 68, 68, 0.15); }

	.reject-reason {
		font-size: 0.78rem; color: var(--accent-rose); font-style: italic;
		margin-bottom: var(--space-sm);
	}
	.view-card-link {
		font-size: 0.78rem; color: var(--accent-indigo); text-decoration: none; font-weight: 600;
	}
	.view-card-link:hover { text-decoration: underline; }

	/* Resolved toggle */
	.resolved-toggle {
		display: flex; align-items: center; gap: var(--space-xs);
		margin-top: var(--space-lg); padding: 8px 12px;
		background: transparent; border: none; color: var(--text-secondary);
		font-size: 0.78rem; font-weight: 600; cursor: pointer;
		font-family: var(--font-family);
	}
	.resolved-toggle:hover { color: var(--text-primary); }
	.requests-list.resolved { margin-top: var(--space-sm); }

	/* Empty / loading */
	.empty-state { text-align: center; padding: var(--space-2xl); color: var(--text-secondary); }
	.empty-icon { font-size: 2.5rem; margin-bottom: var(--space-sm); }
	.empty-state h2 { font-size: 1.1rem; margin-bottom: var(--space-xs); color: var(--text-primary); }
	.empty-state p { font-size: 0.85rem; }
	.loading-state { text-align: center; padding: var(--space-xl); color: var(--text-secondary); }
	.all-clear {
		padding: var(--space-lg); text-align: center;
		background: rgba(16, 185, 129, 0.05); border: 1px solid rgba(16, 185, 129, 0.1);
		border-radius: var(--radius-md); color: var(--text-secondary); font-size: 0.88rem;
	}

	/* Modals */
	.modal-overlay {
		position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
		display: flex; align-items: center; justify-content: center;
		z-index: 1000; backdrop-filter: blur(4px);
	}
	.modal-card {
		background: var(--bg-card); border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg); padding: var(--space-xl);
		width: 90%; max-width: 460px; box-shadow: var(--shadow-lg);
	}
	.modal-card h2 { font-size: 1.15rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-xs); }
	.modal-desc { font-size: 0.85rem; color: var(--text-secondary); margin-bottom: var(--space-lg); }
	.modal-field { margin-bottom: var(--space-md); }
	.modal-field label { display: block; font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
	.modal-select, .modal-textarea {
		width: 100%; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.85rem;
	}
	.modal-select:focus, .modal-textarea:focus { outline: none; border-color: var(--accent-indigo); }
	.modal-textarea { resize: vertical; min-height: 60px; }
	.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-sm); margin-top: var(--space-lg); }
	.btn-cancel {
		padding: 8px 16px; background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-secondary); font-weight: 600;
		font-size: 0.82rem; cursor: pointer; font-family: var(--font-family);
	}
	.btn-confirm {
		padding: 8px 16px; background: var(--accent-indigo); border: none;
		border-radius: var(--radius-md); color: white; font-weight: 600;
		font-size: 0.82rem; cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-confirm:hover:not(:disabled) { background: #5558e6; }
	.btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-reject-confirm {
		padding: 8px 16px; background: #ef4444; border: none;
		border-radius: var(--radius-md); color: white; font-weight: 600;
		font-size: 0.82rem; cursor: pointer; font-family: var(--font-family);
	}
	.btn-reject-confirm:hover { background: #dc2626; }

	/* Discuss button */
	.btn-discuss {
		padding: 6px 14px; border-radius: var(--radius-md);
		font-size: 0.78rem; font-weight: 600; cursor: pointer;
		border: 1px solid rgba(99, 102, 241, 0.2); font-family: var(--font-family);
		background: rgba(99, 102, 241, 0.08); color: var(--accent-indigo);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-discuss:hover { background: rgba(99, 102, 241, 0.15); }

	/* Chat modal */
	.chat-modal { max-width: 560px; width: 95%; display: flex; flex-direction: column; max-height: 80vh; }
	.chat-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: var(--space-md); }
	.chat-header h2 { margin: 0; font-size: 1.1rem; }
	.chat-title { font-size: 0.82rem; color: var(--text-secondary); margin: 2px 0 0; font-weight: 500; }
	.chat-requester-info { font-size: 0.72rem; color: var(--text-tertiary); margin: 2px 0 0; }
	.chat-close {
		background: none; border: none; font-size: 1.1rem; cursor: pointer;
		color: var(--text-tertiary); padding: 4px; line-height: 1;
	}
	.chat-close:hover { color: var(--text-primary); }

	.chat-messages {
		flex: 1; overflow-y: auto; display: flex; flex-direction: column;
		gap: var(--space-sm); padding: var(--space-sm) 0;
		min-height: 150px; max-height: 350px;
		border-top: 1px solid var(--glass-border);
		border-bottom: 1px solid var(--glass-border);
		margin-bottom: var(--space-sm);
	}
	.chat-empty { text-align: center; color: var(--text-tertiary); font-size: 0.82rem; padding: var(--space-lg); }

	.chat-bubble {
		max-width: 80%; padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-md); font-size: 0.82rem;
	}
	.chat-admin {
		align-self: flex-end;
		background: rgba(99, 102, 241, 0.08); border: 1px solid rgba(99, 102, 241, 0.15);
		border-bottom-right-radius: 4px;
	}
	.chat-requester-bubble {
		align-self: flex-start;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-bottom-left-radius: 4px;
	}
	.chat-bubble-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px; }
	.chat-sender { font-size: 0.68rem; font-weight: 600; color: var(--text-secondary); }
	.chat-time { font-size: 0.6rem; color: var(--text-tertiary); }
	.chat-text { margin: 0; color: var(--text-primary); line-height: 1.5; white-space: pre-wrap; }

	.chat-input-area { display: flex; gap: var(--space-sm); align-items: flex-end; }
	.chat-textarea {
		flex: 1; padding: 8px 12px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.82rem; resize: none;
	}
	.chat-textarea:focus { outline: none; border-color: var(--accent-indigo); }
	.btn-send-chat {
		padding: 8px 14px; background: var(--accent-indigo); color: white; border: none;
		border-radius: var(--radius-md); font-weight: 600; font-size: 0.78rem;
		cursor: pointer; font-family: var(--font-family); white-space: nowrap;
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-send-chat:hover:not(:disabled) { background: #5558e6; }
	.btn-send-chat:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
