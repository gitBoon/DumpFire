<script lang="ts">
	/**
	 * Reports Page — Generate and schedule PDF reports.
	 *
	 * Two tabs: Generate (one-off PDF with preview) and Schedules (recurring email delivery).
	 * No history — PDFs are ephemeral, never stored.
	 */
	import type { PageData } from './$types';
	import { invalidateAll } from '$app/navigation';
	import { theme } from '$lib/stores/theme';
	import ThemePicker from '$lib/components/ThemePicker.svelte';
	import { page } from '$app/stores';

	let { data }: { data: PageData } = $props();
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let user = $derived($page.data.user);
	let isAdmin = $derived(data.isAdmin);

	// ─── Generate Report Form ───────────────────────────────────────────
	// Unified target: 'all', 'cat:<id>', or '<boardId>'
	let genTarget = $state<string>(data.boards.length > 0 ? String(data.boards[0].id) : 'all');
	let genPeriod = $state('7d');
	let genCustomStart = $state('');
	let genCustomEnd = $state('');
	let genDetailLevel = $state<'summary' | 'detailed'>('detailed');
	let generating = $state(false);
	let genError = $state('');

	// PDF preview
	let pdfUrl = $state<string | null>(null);

	// Derive scope and scopeId from the unified target
	let genScope = $derived<'board' | 'category' | 'all'>(
		genTarget === 'all' ? 'all' : genTarget.startsWith('cat:') ? 'category' : 'board'
	);
	let genScopeId = $derived<number | null>(
		genTarget === 'all' ? null : genTarget.startsWith('cat:') ? Number(genTarget.slice(4)) : Number(genTarget)
	);

	// Group boards by category for optgroup display
	let categorisedBoards = $derived(() => {
		const catMap = new Map<number, { name: string; color: string }>();
		for (const c of data.categories) catMap.set(c.id, { name: c.name, color: c.color });

		const groups: { label: string; catId: number | null; boards: typeof data.boards }[] = [];
		const byCategory = new Map<number | null, typeof data.boards>();

		for (const b of data.boards) {
			const key = b.categoryId ?? null;
			if (!byCategory.has(key)) byCategory.set(key, []);
			byCategory.get(key)!.push(b);
		}

		// Categories with boards first
		for (const [catId, boards] of byCategory) {
			if (catId !== null) {
				const cat = catMap.get(catId);
				groups.push({ label: cat?.name || 'Unknown', catId, boards });
			}
		}
		groups.sort((a, b) => a.label.localeCompare(b.label));

		// Uncategorised at end
		const uncategorised = byCategory.get(null);
		if (uncategorised && uncategorised.length > 0) {
			groups.push({ label: 'Uncategorised', catId: null, boards: uncategorised });
		}

		return groups;
	});

	function getPeriodDates(): { start: string; end: string } {
		const end = new Date();
		const endStr = end.toISOString();

		if (genPeriod === 'custom') {
			return { start: genCustomStart ? new Date(genCustomStart).toISOString() : endStr, end: genCustomEnd ? new Date(genCustomEnd).toISOString() : endStr };
		}

		const days = genPeriod === '7d' ? 7 : genPeriod === '30d' ? 30 : genPeriod === 'month' ? new Date().getDate() : 7;
		const start = new Date();
		if (genPeriod === 'month') {
			start.setDate(1);
			start.setHours(0, 0, 0, 0);
		} else {
			start.setDate(start.getDate() - days);
		}
		return { start: start.toISOString(), end: endStr };
	}

	async function generateReport() {
		generating = true;
		genError = '';

		// Clean up previous blob URL
		if (pdfUrl) {
			URL.revokeObjectURL(pdfUrl);
			pdfUrl = null;
		}

		try {
			const { start, end } = getPeriodDates();
			const res = await fetch('/api/reports', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					scope: genScope,
					scopeId: genScopeId,
					periodStart: start,
					periodEnd: end,
					detailLevel: genDetailLevel
				})
			});
			if (!res.ok) {
				const err = await res.json();
				genError = err.error || 'Failed to generate report';
			} else {
				const blob = await res.blob();
				pdfUrl = URL.createObjectURL(blob);
			}
		} catch (e: any) {
			genError = e.message || 'Failed to generate report';
		}
		generating = false;
	}

	function downloadPdf() {
		if (!pdfUrl) return;
		const a = document.createElement('a');
		a.href = pdfUrl;
		a.download = `dumpfire-report-${new Date().toISOString().split('T')[0]}.pdf`;
		a.click();
	}

	function closePdfPreview() {
		if (pdfUrl) {
			URL.revokeObjectURL(pdfUrl);
			pdfUrl = null;
		}
	}

	// ─── Email Modal ────────────────────────────────────────────────────
	let showEmailModal = $state(false);
	let emailRecipients = $state('');
	let emailSending = $state(false);
	let emailResult = $state<{ message: string; type: 'success' | 'error' } | null>(null);

	async function sendReportEmail() {
		if (!emailRecipients.trim()) return;
		emailSending = true;
		emailResult = null;

		const recipients = emailRecipients.split(/[,;\n]/).map(e => e.trim()).filter(e => e.length > 0);
		if (recipients.length === 0) {
			emailResult = { message: 'Please enter at least one email address', type: 'error' };
			emailSending = false;
			return;
		}

		try {
			const { start, end } = getPeriodDates();
			const res = await fetch('/api/reports/email', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					scope: genScope,
					scopeId: genScopeId,
					periodStart: start,
					periodEnd: end,
					recipients,
					detailLevel: genDetailLevel
				})
			});
			const data = await res.json();
			if (res.ok) {
				emailResult = { message: data.message, type: 'success' };
				setTimeout(() => { showEmailModal = false; emailResult = null; emailRecipients = ''; }, 2500);
			} else {
				emailResult = { message: data.error || 'Failed to send', type: 'error' };
			}
		} catch (e: any) {
			emailResult = { message: e.message || 'Failed to send', type: 'error' };
		}
		emailSending = false;
	}

	// ─── Schedules ──────────────────────────────────────────────────────
	let showNewSchedule = $state(false);
	let schedName = $state('');
	let schedTarget = $state<string>(data.boards.length > 0 ? String(data.boards[0].id) : 'all');
	let schedFrequency = $state<'weekly' | 'monthly'>('weekly');
	let schedDayOfWeek = $state(1);
	let schedDayOfMonth = $state(1);
	let schedTime = $state('09:00');
	let schedRecipients = $state('');
	let schedPeriodDays = $state(7);
	let schedDetailLevel = $state<'summary' | 'detailed'>('detailed');
	let schedCreating = $state(false);

	let schedScope = $derived<'board' | 'category' | 'all'>(
		schedTarget === 'all' ? 'all' : schedTarget.startsWith('cat:') ? 'category' : 'board'
	);
	let schedScopeId = $derived<number | null>(
		schedTarget === 'all' ? null : schedTarget.startsWith('cat:') ? Number(schedTarget.slice(4)) : Number(schedTarget)
	);

	async function createSchedule() {
		schedCreating = true;
		await fetch('/api/report-schedules', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: schedName || 'Scheduled Report',
				scope: schedScope,
				scopeId: schedScopeId,
				frequency: schedFrequency,
				dayOfWeek: schedDayOfWeek,
				dayOfMonth: schedDayOfMonth,
				timeOfDay: schedTime,
				recipients: schedRecipients,
				periodDays: schedPeriodDays,
				detailLevel: schedDetailLevel
			})
		});
		showNewSchedule = false;
		schedName = '';
		schedRecipients = '';
		await invalidateAll();
		schedCreating = false;
	}

	async function toggleSchedule(scheduleId: number, enabled: boolean) {
		await fetch(`/api/report-schedules/${scheduleId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled })
		});
		await invalidateAll();
	}

	async function deleteSchedule(scheduleId: number) {
		await fetch(`/api/report-schedules/${scheduleId}`, { method: 'DELETE' });
		await invalidateAll();
	}

	// Helpers
	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	function formatDateTime(dateStr: string): string {
		if (!dateStr) return '—';
		const d = new Date(dateStr);
		return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	function getScopeLabel(scope: string, scopeId: number | null): string {
		if (scope === 'all') return '🌐 All Boards';
		if (scope === 'board') {
			const b = data.boards.find(b => b.id === scopeId);
			return b ? `${b.emoji} ${b.name}` : 'Unknown Board';
		}
		if (scope === 'category') {
			const c = data.categories.find(c => c.id === scopeId);
			return c ? `🏷️ ${c.name}` : 'Unknown Category';
		}
		return scope;
	}

	let activeTab = $state<'generate' | 'schedules'>('generate');
</script>

<svelte:head>
	<title>DumpFire — Reports</title>
</svelte:head>

<!-- PDF Preview Overlay -->
{#if pdfUrl}
<div class="pdf-overlay">
	<div class="pdf-header">
		<div class="pdf-title-area">
			<span class="pdf-icon">📄</span>
			<h2 class="pdf-title">Report Preview</h2>
		</div>
		<div class="pdf-actions">
			<button class="btn-primary download-btn" onclick={downloadPdf}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v8M4 7l3 3 3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 11h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
				Download PDF
			</button>
			<button class="btn-email email-btn" onclick={() => showEmailModal = true}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M1 4l6 4 6-4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
				Email Report
			</button>
			<button class="btn-ghost close-preview-btn" onclick={closePdfPreview}>
				<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
				Close
			</button>
		</div>
	</div>
	<iframe src={pdfUrl} class="pdf-iframe" title="Report PDF Preview"></iframe>

	<!-- Email Modal -->
	{#if showEmailModal}
	<div class="email-modal-backdrop" onclick={() => { showEmailModal = false; emailResult = null; }}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="email-modal" onclick={(e) => e.stopPropagation()}>
			<div class="email-modal-header">
				<h3>Email Report</h3>
				<button class="btn-ghost" onclick={() => { showEmailModal = false; emailResult = null; }}>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
				</button>
			</div>
			<div class="email-modal-body">
				<label class="email-label" for="email-recipients">
					Recipients
					<span class="email-hint">Separate multiple emails with commas</span>
				</label>
				<textarea
					id="email-recipients"
					class="email-input"
					bind:value={emailRecipients}
					placeholder="name@example.com, team@example.com"
					rows="3"
				></textarea>
				{#if emailResult}
					<div class="email-result {emailResult.type}">{emailResult.message}</div>
				{/if}
			</div>
			<div class="email-modal-footer">
				<button class="btn-ghost" onclick={() => { showEmailModal = false; emailResult = null; }}>Cancel</button>
				<button class="btn-primary" onclick={sendReportEmail} disabled={emailSending || !emailRecipients.trim()}>
					{#if emailSending}
						Sending...
					{:else}
						Send Report
					{/if}
				</button>
			</div>
		</div>
	</div>
	{/if}
</div>
{:else}
<div class="reports-page">
	<header class="reports-header">
		<div class="reports-header-left">
			<a href="/" class="back-btn btn-ghost" id="back-to-dashboard">
				<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 4L6 9l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
			</a>
			<span class="reports-icon">📊</span>
			<div>
				<h1 class="reports-title">Reports</h1>
				<p class="reports-subtitle">{data.schedules.length} schedule{data.schedules.length !== 1 ? 's' : ''}</p>
			</div>
		</div>
		<div class="reports-header-right">
			<ThemePicker />
		</div>
	</header>

	<!-- Tab Bar -->
	<div class="tab-bar">
		<button class="tab-btn" class:active={activeTab === 'generate'} onclick={() => activeTab = 'generate'}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
			Generate
		</button>
		<button class="tab-btn" class:active={activeTab === 'schedules'} onclick={() => activeTab = 'schedules'}>
			<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M7 4.5V7l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
			Schedules
			{#if data.schedules.length > 0}
				<span class="tab-count">{data.schedules.length}</span>
			{/if}
		</button>
	</div>

	<div class="reports-content">

		<!-- ─── Generate Report ──────────────────────────────────────── -->
		{#if activeTab === 'generate'}
			<div class="panel glass animate-fade-in" id="generate-report-panel">
				<h2 class="panel-heading">Generate PDF Report</h2>
				<p class="panel-desc">Create a one-off PDF report with detailed analytics and task breakdowns. The PDF will open for preview — no data is stored.</p>

				<div class="form-row">
					<div class="form-group">
						<label for="gen-target">Report Target</label>
						<select id="gen-target" bind:value={genTarget}>
							{#if isAdmin}
								<option value="all">🌐 All Boards</option>
							{/if}
							{#each categorisedBoards() as group}
								<optgroup label="{group.label}">
									{#if group.catId !== null}
										<option value="cat:{group.catId}">🏷️ All {group.label} boards</option>
									{/if}
									{#each group.boards as board}
										<option value={String(board.id)}>{board.emoji} {board.name}</option>
									{/each}
								</optgroup>
							{/each}
						</select>
					</div>
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="gen-period">Period</label>
						<select id="gen-period" bind:value={genPeriod}>
							<option value="7d">Last 7 days</option>
							<option value="30d">Last 30 days</option>
							<option value="month">This month</option>
							<option value="custom">Custom range</option>
						</select>
					</div>

					{#if genPeriod === 'custom'}
						<div class="form-group">
							<label for="gen-start">Start</label>
							<input type="date" id="gen-start" bind:value={genCustomStart} />
						</div>
						<div class="form-group">
							<label for="gen-end">End</label>
							<input type="date" id="gen-end" bind:value={genCustomEnd} />
						</div>
					{/if}
				</div>

				<div class="form-row">
					<div class="form-group">
						<label for="gen-detail">Report Detail</label>
						<select id="gen-detail" bind:value={genDetailLevel}>
							<option value="detailed">📋 Detailed — full descriptions, business value, subtasks</option>
							<option value="summary">📊 Summary — metrics and task listings only</option>
						</select>
					</div>
				</div>

				{#if genError}
					<div class="error-msg">{genError}</div>
				{/if}

				<button class="btn-primary generate-btn" onclick={generateReport} disabled={generating} id="generate-report-btn">
					{#if generating}
						<span class="spinner"></span> Generating PDF…
					{:else}
						<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="1" width="10" height="12" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 4h4M5 6.5h4M5 9h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
						Generate PDF
					{/if}
				</button>
			</div>
		{/if}

		<!-- ─── Schedules ────────────────────────────────────────────── -->
		{#if activeTab === 'schedules'}
			<div class="panel glass animate-fade-in" id="schedules-panel">
				<div class="panel-header-row">
					<div>
						<h2 class="panel-heading">Scheduled Reports</h2>
						<p class="panel-desc">Automatically generate and email PDF reports on a recurring schedule.</p>
					</div>
					<button class="btn-primary" onclick={() => showNewSchedule = !showNewSchedule}>
						{showNewSchedule ? '✕ Cancel' : '+ New Schedule'}
					</button>
				</div>

				{#if showNewSchedule}
					<div class="new-schedule-form animate-slide-up">
						<div class="form-row">
							<div class="form-group">
								<label for="sched-name">Name</label>
								<input type="text" id="sched-name" bind:value={schedName} placeholder="e.g. Weekly Sprint Report" />
							</div>
						</div>
						<div class="form-row">
							<div class="form-group">
								<label for="sched-target">Report Target</label>
								<select id="sched-target" bind:value={schedTarget}>
									{#if isAdmin}
										<option value="all">🌐 All Boards</option>
									{/if}
									{#each categorisedBoards() as group}
										<optgroup label="{group.label}">
											{#if group.catId !== null}
												<option value="cat:{group.catId}">🏷️ All {group.label} boards</option>
											{/if}
											{#each group.boards as board}
												<option value={String(board.id)}>{board.emoji} {board.name}</option>
											{/each}
										</optgroup>
									{/each}
								</select>
							</div>
						</div>
						<div class="form-row">
							<div class="form-group">
								<label for="sched-freq">Frequency</label>
								<select id="sched-freq" bind:value={schedFrequency}>
									<option value="weekly">Weekly</option>
									<option value="monthly">Monthly</option>
								</select>
							</div>
							{#if schedFrequency === 'weekly'}
								<div class="form-group">
									<label for="sched-dow">Day</label>
									<select id="sched-dow" bind:value={schedDayOfWeek}>
										{#each dayNames as day, i}
											<option value={i}>{day}</option>
										{/each}
									</select>
								</div>
							{:else}
								<div class="form-group">
									<label for="sched-dom">Day of month</label>
									<select id="sched-dom" bind:value={schedDayOfMonth}>
										{#each Array.from({ length: 28 }, (_, i) => i + 1) as d}
											<option value={d}>{d}</option>
										{/each}
									</select>
								</div>
							{/if}
							<div class="form-group">
								<label for="sched-time">Time</label>
								<input type="time" id="sched-time" bind:value={schedTime} />
							</div>
						</div>
						<div class="form-row">
							<div class="form-group">
								<label for="sched-period">Report Period</label>
								<select id="sched-period" bind:value={schedPeriodDays}>
									<option value={7}>Last 7 days</option>
									<option value={14}>Last 14 days</option>
									<option value={30}>Last 30 days</option>
									<option value={60}>Last 60 days</option>
									<option value={90}>Last 90 days</option>
								</select>
							</div>
							<div class="form-group full-width">
								<label for="sched-recipients">Email Recipients</label>
								<textarea
									id="sched-recipients"
									bind:value={schedRecipients}
									placeholder="Enter email addresses, separated by commas&#10;e.g. alice@example.com, bob@example.com"
									rows="2"
								></textarea>
								<span class="form-hint">Comma-separated email addresses. The PDF report will be emailed to all recipients.</span>
							</div>
						</div>
						<div class="form-row">
							<div class="form-group">
								<label for="sched-detail">Report Detail</label>
								<select id="sched-detail" bind:value={schedDetailLevel}>
									<option value="detailed">📋 Detailed</option>
									<option value="summary">📊 Summary</option>
								</select>
							</div>
						</div>
						<button class="btn-primary" onclick={createSchedule} disabled={schedCreating}>
							{schedCreating ? 'Creating…' : 'Create Schedule'}
						</button>
					</div>
				{/if}

				{#if data.schedules.length > 0}
					<div class="schedules-list">
						{#each data.schedules as schedule}
							<div class="schedule-card" class:disabled={!schedule.enabled}>
								<div class="schedule-info">
									<div class="schedule-name">{schedule.name}</div>
									<div class="schedule-meta">
										<span class="scope-badge">{getScopeLabel(schedule.scope, schedule.scopeId)}</span>
										<span class="freq-badge">{schedule.frequency === 'weekly' ? `Weekly on ${dayNames[schedule.dayOfWeek]}` : `Monthly on day ${schedule.dayOfMonth}`} at {schedule.timeOfDay}</span>
										<span class="freq-badge">Last {schedule.periodDays} days</span>
										<span class="freq-badge">{schedule.detailLevel === 'summary' ? '📊 Summary' : '📋 Detailed'}</span>
									</div>
									{#if schedule.recipients}
										<div class="schedule-recipients">
											<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M2 4l5 4 5-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1" y="3" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
											{schedule.recipients.split(',').length} recipient{schedule.recipients.split(',').length !== 1 ? 's' : ''}
										</div>
									{:else}
										<span class="no-recipients-warn">⚠️ No recipients configured</span>
									{/if}
									{#if schedule.lastRunAt}
										<span class="schedule-last-run">Last: {formatDateTime(schedule.lastRunAt)}</span>
									{/if}
									{#if schedule.nextRunAt}
										<span class="schedule-next-run">Next: {formatDateTime(schedule.nextRunAt)}</span>
									{/if}
								</div>
								<div class="schedule-actions">
									<button
										class="toggle-btn"
										class:active={schedule.enabled}
										onclick={() => toggleSchedule(schedule.id, !schedule.enabled)}
										title={schedule.enabled ? 'Disable' : 'Enable'}
									>
										{schedule.enabled ? '✅' : '⏸️'}
									</button>
									<button class="delete-btn" onclick={() => deleteSchedule(schedule.id)} title="Delete schedule">
										<svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M2 4h10M5 4V2.5A.5.5 0 015.5 2h3a.5.5 0 01.5.5V4m1.5 0l-.5 8a1 1 0 01-1 1h-5a1 1 0 01-1-1l-.5-8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
									</button>
								</div>
							</div>
						{/each}
					</div>
				{:else if !showNewSchedule}
					<div class="empty-state">
						<span class="empty-icon">📅</span>
						<p>No scheduled reports yet. Create one to receive regular PDF reports by email.</p>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
{/if}

<style>
	.reports-page {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		background: var(--bg-deep);
	}

	.reports-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-lg) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		flex-shrink: 0;
	}

	.reports-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.reports-header-right {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.reports-icon { font-size: 1.75rem; }

	.reports-title {
		font-size: 1.25rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.reports-subtitle {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 1px;
	}

	.back-btn {
		font-size: 0;
		padding: var(--space-sm);
		color: var(--text-secondary);
	}

	.back-btn:hover { color: var(--text-primary); }

	/* Tab Bar */
	.tab-bar {
		display: flex;
		gap: var(--space-xs);
		padding: var(--space-md) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		background: var(--bg-base);
	}

	.tab-btn {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		padding: var(--space-sm) var(--space-lg);
		border-radius: var(--radius-md);
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: all var(--duration-normal) var(--ease-out);
		border: 1px solid transparent;
	}

	.tab-btn:hover { background: var(--glass-hover); color: var(--text-primary); }
	.tab-btn.active {
		background: var(--accent-purple-glow);
		color: var(--accent-purple);
		border-color: var(--accent-purple);
	}

	.tab-count {
		font-size: 0.65rem;
		background: var(--bg-elevated);
		padding: 1px 6px;
		border-radius: var(--radius-full);
	}

	.tab-btn.active .tab-count {
		background: var(--accent-purple);
		color: white;
	}

	/* Content */
	.reports-content {
		flex: 1;
		padding: var(--space-xl);
		max-width: 800px;
		margin: 0 auto;
		width: 100%;
	}

	.panel {
		padding: var(--space-xl);
		border-radius: var(--radius-lg);
		background: var(--bg-surface);
		border: 1px solid var(--glass-border);
	}

	.panel-heading {
		font-size: 1.1rem;
		margin-bottom: var(--space-xs);
	}

	.panel-desc {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-bottom: var(--space-xl);
	}

	.panel-header-row {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: var(--space-md);
		margin-bottom: var(--space-lg);
	}

	.panel-header-row .panel-heading { margin-bottom: 0; }
	.panel-header-row .panel-desc { margin-bottom: 0; }

	/* Form */
	.form-row {
		display: flex;
		gap: var(--space-md);
		margin-bottom: var(--space-lg);
		flex-wrap: wrap;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		flex: 1;
		min-width: 140px;
	}

	.form-group.full-width { flex-basis: 100%; }

	.form-group label {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.form-group select,
	.form-group input,
	.form-group textarea {
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		border: 1px solid var(--glass-border);
		background: var(--bg-base);
		color: var(--text-primary);
		font-size: 0.82rem;
		font-family: inherit;
		resize: vertical;
	}

	.form-group select:focus,
	.form-group input:focus,
	.form-group textarea:focus {
		border-color: var(--accent-purple);
		outline: none;
	}

	.form-hint {
		font-size: 0.68rem;
		color: var(--text-tertiary);
	}

	.generate-btn {
		margin-top: var(--space-sm);
	}

	.error-msg {
		color: var(--priority-critical);
		font-size: 0.8rem;
		margin-bottom: var(--space-md);
		padding: var(--space-sm) var(--space-md);
		border-radius: var(--radius-sm);
		background: rgba(239, 68, 68, 0.1);
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border: 2px solid rgba(255,255,255,0.3);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.6s linear infinite;
	}

	@keyframes spin { to { transform: rotate(360deg); } }

	/* PDF Preview Overlay */
	.pdf-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: var(--bg-deep);
		display: flex;
		flex-direction: column;
		animation: fadeIn 0.2s ease;
	}

	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

	.pdf-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-md) var(--space-xl);
		border-bottom: 1px solid var(--glass-border);
		background: var(--bg-base);
		flex-shrink: 0;
	}

	.pdf-title-area {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.pdf-icon { font-size: 1.25rem; }

	.pdf-title {
		font-size: 1rem;
		background: linear-gradient(135deg, var(--text-primary), var(--accent-purple));
		-webkit-background-clip: text;
		-webkit-text-fill-color: transparent;
		background-clip: text;
	}

	.pdf-actions {
		display: flex;
		gap: var(--space-sm);
	}

	.download-btn {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}

	.close-preview-btn {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
	}

	.pdf-iframe {
		flex: 1;
		width: 100%;
		border: none;
		background: #333;
	}

	/* Schedules */
	.new-schedule-form {
		padding: var(--space-lg);
		border-radius: var(--radius-md);
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		margin-bottom: var(--space-lg);
	}

	.schedules-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.schedule-card {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: var(--space-md) var(--space-lg);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		transition: all var(--duration-normal) var(--ease-out);
	}

	.schedule-card:hover { border-color: var(--accent-purple); transform: translateY(-1px); box-shadow: var(--shadow-md); }
	.schedule-card.disabled { opacity: 0.5; }

	.schedule-info { display: flex; flex-direction: column; gap: 2px; }
	.schedule-name { font-size: 0.85rem; font-weight: 600; }
	.schedule-meta { display: flex; gap: var(--space-xs); flex-wrap: wrap; align-items: center; }
	.schedule-last-run, .schedule-next-run { font-size: 0.7rem; color: var(--text-tertiary); }

	.schedule-recipients {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.no-recipients-warn {
		font-size: 0.68rem;
		color: var(--priority-high);
	}

	.scope-badge {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		background: var(--accent-purple-glow);
		color: var(--accent-purple);
	}

	.freq-badge {
		font-size: 0.65rem;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: var(--bg-elevated);
		color: var(--text-secondary);
	}

	.schedule-actions {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
	}

	.toggle-btn, .delete-btn {
		padding: var(--space-xs) var(--space-sm);
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-tertiary);
		font-size: 0.85rem;
		cursor: pointer;
		transition: all var(--duration-fast);
	}

	.toggle-btn:hover { background: var(--glass-hover); }
	.delete-btn:hover { background: rgba(239, 68, 68, 0.1); color: var(--priority-critical); }

	/* Empty state */
	.empty-state {
		text-align: center;
		padding: var(--space-3xl) var(--space-xl);
		color: var(--text-tertiary);
	}

	.empty-state :global(.empty-icon) { font-size: 2.5rem; display: block; margin-bottom: var(--space-md); }
	.empty-state p { font-size: 0.85rem; }

	@media (max-width: 600px) {
		.reports-content { padding: var(--space-md); }
		.form-row { flex-direction: column; }
		.tab-bar { overflow-x: auto; }
		.pdf-header { flex-direction: column; gap: var(--space-sm); }
	}

	/* Email button */
	.btn-email {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		background: var(--accent-emerald, #059669);
		color: #fff;
		border: none;
		border-radius: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease;
	}
	.btn-email:hover { background: #047857; }

	/* Email Modal */
	.email-modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1001;
		backdrop-filter: blur(4px);
	}
	.email-modal {
		background: var(--bg-surface);
		border-radius: 12px;
		border: 1px solid var(--glass-border);
		width: 100%;
		max-width: 460px;
		box-shadow: 0 16px 48px rgba(0,0,0,0.4);
	}
	.email-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-md) var(--space-lg);
		border-bottom: 1px solid var(--glass-border);
	}
	.email-modal-header h3 {
		margin: 0;
		font-size: 1rem;
		color: var(--text-primary);
	}
	.email-modal-body {
		padding: var(--space-lg);
	}
	.email-label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: var(--space-sm);
	}
	.email-hint {
		display: block;
		font-weight: 400;
		font-size: 0.72rem;
		color: var(--text-tertiary);
		margin-top: 2px;
	}
	.email-input {
		width: 100%;
		padding: 10px 12px;
		background: var(--bg-base);
		border: 1px solid var(--glass-border);
		border-radius: 8px;
		color: var(--text-primary);
		font-size: 0.85rem;
		font-family: inherit;
		resize: vertical;
		transition: border-color 0.15s ease;
	}
	.email-input:focus {
		outline: none;
		border-color: var(--accent-primary);
	}
	.email-result {
		margin-top: var(--space-sm);
		padding: 8px 12px;
		border-radius: 6px;
		font-size: 0.8rem;
		font-weight: 500;
	}
	.email-result.success {
		background: rgba(5, 150, 105, 0.15);
		color: #059669;
	}
	.email-result.error {
		background: rgba(220, 38, 38, 0.15);
		color: #dc2626;
	}
	.email-modal-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-sm);
		padding: var(--space-md) var(--space-lg);
		border-top: 1px solid var(--glass-border);
	}
</style>

