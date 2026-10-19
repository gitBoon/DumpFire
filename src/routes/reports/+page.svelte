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
	import { deleteFailure, failureMessage } from '$lib/api';
	import Toast from '$lib/components/Toast.svelte';
	import { toasts } from '$lib/stores/toast';
	import { MAX_REPORT_RECIPIENTS, reportRecipients } from '$lib/report-recipients';
	import { parseStamp } from '$lib/timestamps';
	import { calendarPeriod, canonicalTimeZone, isCalendarPreset, nextRunAfter } from '$lib/report-schedule-time';
	import { onMount } from 'svelte';

	let { data }: { data: PageData } = $props();
	let currentTheme = $state('light');
	theme.subscribe((v) => (currentTheme = v));

	let user = $derived($page.data.user);
	let isAdmin = $derived(data.isAdmin);

	// ─── Generate Report Form ───────────────────────────────────────────
	// Unified target: 'all', 'cat:<id>', or '<boardId>'
	let genTarget = $state<string>(data.isAdmin ? 'all' : (data.boards.length > 0 ? String(data.boards[0].id) : 'all'));
	let genPeriod = $state('30d');
	let genCustomStart = $state('');
	let genCustomEnd = $state('');
	let genDetailLevel = $state<'summary' | 'detailed'>('detailed');
	let genStatusFilter = $state<StatusFilter>('all');
	/**
	 * Narrow the report to one person's assigned work. 'all' means everyone —
	 * every figure in the report then derives from the filtered card set, so a
	 * person report's totals agree with the lists beneath them.
	 */
	let genAssignee = $state<string>('all');
	let generating = $state(false);
	let genError = $state('');

	// ─── Status filter (shared by the Generate and Schedule forms) ──────
	// Mirrors ReportStatusFilter on the server. 'all' leads with completed work
	// then lists everything still open; the others draw only their own slice.
	type StatusFilter = 'all' | 'completed' | 'in_progress' | 'todo';
	const statusFilterOptions: { value: StatusFilter; label: string; short: string; hint: string }[] = [
		{ value: 'all', label: '🗂️ All work — completed first, then outstanding', short: '🗂️ All work', hint: 'Completed in period leads the report, followed by every open card.' },
		{ value: 'completed', label: '✅ Completed only', short: '✅ Completed only', hint: 'Only cards completed within the period. Summary metrics still cover the whole scope.' },
		{ value: 'in_progress', label: '🔧 In Progress only', short: '🔧 In Progress only', hint: 'Open cards that have left To Do — In Progress, On Hold, Review and similar columns.' },
		{ value: 'todo', label: '📥 To Do only', short: '📥 To Do only', hint: 'Cards still sitting in a To Do / Backlog column, not yet started.' }
	];
	function statusFilterHint(v: string): string {
		return statusFilterOptions.find(o => o.value === v)?.hint ?? '';
	}
	function statusFilterShort(v: string | null | undefined): string {
		return statusFilterOptions.find(o => o.value === v)?.short ?? '🗂️ All work';
	}

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

		// The dates as chosen. The server reads a bare date as the start of that
		// day for periodStart and its last second for periodEnd, in UTC, so
		// "1 to 14 October" includes the 14th; midnight at the start of the end
		// date, which was sent, left it out (card 2095).
		if (genPeriod === 'custom') {
			return { start: genCustomStart || endStr, end: genCustomEnd || endStr };
		}

		// Every other period is calendar days, sent as dates and read as a
		// custom range is: from its first day to today, both as the clock reads
		// them in the zone sent for the Overdue figure (UTC when the browser
		// gives none this server knows). Each was built on the browser's clock
		// and sent as moments, which the PDF printed in UTC: a day out away from
		// UTC (cards 2271 and 2275). One this page does not know is the last 30
		// days, as it was.
		return calendarPeriod(isCalendarPreset(genPeriod) ? genPeriod : '30d', end, browserZone);
	}

	/**
	 * What the report routes say of a zone they do not know, in `readTimeZone`'s
	 * words. A browser newer than the server can name one (a zone renamed since
	 * the server's own list was made).
	 */
	const ZONE_REFUSED = 'timeZone must be a time zone name, such as Europe/London';

	/** Whether an answer is the refusal of the zone sent, and nothing else. Reads a copy. */
	async function refusesZone(res: Response): Promise<boolean> {
		return browserZone !== null && res.status === 400 && (await failureMessage(res.clone(), '')) === ZONE_REFUSED;
	}

	/**
	 * Said once a report is made after its zone was refused: it was asked for
	 * again without one, so its Overdue figure counts from the UTC day (group
	 * B's review). The period is the browser's own dates either way.
	 */
	function zoneNotice() {
		toasts.add(`This server does not know your time zone, ${browserZone}, so the Overdue figure is counted from the UTC day.`, 'warning');
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
			const request = {
				scope: genScope,
				scopeId: genScopeId,
				periodStart: start,
				periodEnd: end,
				detailLevel: genDetailLevel,
				statusFilter: genStatusFilter,
				assigneeUserId: genAssignee === 'all' ? null : Number(genAssignee)
			};
			let res = await fetch('/api/reports', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// The day the Overdue figure counts from is the viewer's (card 2258).
				body: JSON.stringify({ ...request, timeZone: browserZone ?? undefined })
			});
			// A zone the server does not know: asked once more without it, in UTC.
			let zoneLeftOut = false;
			if (await refusesZone(res)) {
				zoneLeftOut = true;
				res = await fetch('/api/reports', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(request)
				});
			}
			if (!res.ok) {
				// The server's own message if the answer carries one. An answer
				// that is not JSON, a proxy's error page among them, gets the
				// plain one: read with a bare `res.json()` it showed the reader
				// a parser error.
				genError = await failureMessage(res, 'Failed to generate report');
			} else {
				// Typed as a PDF whatever the answer says it is: the preview frame
				// shows this blob: address as this page's own origin, where an
				// answer that is HTML would be drawn as a page (card 2162's review).
				const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
				pdfUrl = URL.createObjectURL(blob);
				if (zoneLeftOut) zoneNotice();
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

		// Read as the server reads it (card 2182): commas, semicolons, spaces or
		// lines between addresses, each sent once. A part that is not an
		// address is said here, and not left out without a word.
		const { addresses: recipients, notAddresses } = reportRecipients(emailRecipients);
		if (notAddresses.length > 0) {
			const named = notAddresses.map((part) => `"${part}"`).join(', ');
			emailResult = {
				message: `${named} ${notAddresses.length === 1 ? 'is not an email address' : 'are not email addresses'}. Nothing was sent.`,
				type: 'error'
			};
			emailSending = false;
			return;
		}
		if (recipients.length === 0) {
			emailResult = { message: 'Please enter at least one email address', type: 'error' };
			emailSending = false;
			return;
		}

		try {
			const { start, end } = getPeriodDates();
			const request = {
				scope: genScope,
				scopeId: genScopeId,
				periodStart: start,
				periodEnd: end,
				recipients,
				detailLevel: genDetailLevel,
				statusFilter: genStatusFilter,
				assigneeUserId: genAssignee === 'all' ? null : Number(genAssignee)
			};
			let res = await fetch('/api/reports/email', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// The day the Overdue figure counts from is the viewer's (card 2258).
				body: JSON.stringify({ ...request, timeZone: browserZone ?? undefined })
			});
			// A zone the server does not know: asked once more without it, in UTC.
			// The route reads every field before it sends, so the refused one
			// reached nobody.
			let zoneLeftOut = false;
			if (await refusesZone(res)) {
				zoneLeftOut = true;
				res = await fetch('/api/reports/email', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(request)
				});
			}
			if (res.ok) {
				if (zoneLeftOut) zoneNotice();
				const data = await res.json();
				// A report that reached some recipients and not others is answered
				// 200, with each one's result (card 2113). It is shown as a failure
				// and the dialog stays open, with only the addresses not reached left
				// in the box: sending again goes to those, and not a second time to
				// everyone who has it.
				const notSent: string[] = Array.isArray(data.results)
					? data.results.filter((r: { success?: unknown }) => r?.success === false).map((r: { email: string }) => r.email)
					: [];
				if (notSent.length > 0) {
					emailRecipients = notSent.join(', ');
					emailResult = {
						message: `${data.message} Only ${notSent.length === 1 ? 'the address' : 'the addresses'} not reached ${notSent.length === 1 ? 'is' : 'are'} left in the box, to send to again.`,
						type: 'error'
					};
				} else {
					emailResult = { message: data.message, type: 'success' };
					setTimeout(() => { showEmailModal = false; emailResult = null; emailRecipients = ''; }, 2500);
				}
			} else {
				// As for the report above: the body of a failure is read as JSON
				// only by failureMessage, which has a plain text for one that is not.
				emailResult = { message: await failureMessage(res, 'Failed to send'), type: 'error' };
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
	let schedStatusFilter = $state<StatusFilter>('all');
	let schedCreating = $state(false);

	/**
	 * The viewer's own time zone, as the browser gives it (card 2159). Read on
	 * mount only: during the server's render it would be the server's zone. A
	 * new schedule is sent with it, so "09:00" is 09:00 where its creator is.
	 * Null until then, and where the browser gives none it knows.
	 */
	let browserZone = $state<string | null>(null);
	onMount(() => {
		browserZone = canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	/**
	 * Whether a schedule is read in a zone other than the viewer's: then it
	 * offers "Use my time zone". Both names through this browser's
	 * `canonicalTimeZone`, since engines spell some zones differently
	 * (`Asia/Kolkata` and `Asia/Calcutta`): a raw comparison would offer the
	 * button for ever (the review's R7).
	 */
	function inAnotherZone(zone: string): boolean {
		return browserZone !== null && canonicalTimeZone(zone) !== browserZone;
	}

	/** Why a schedule cannot be sent, as the scheduler would say, or null when it can. */
	function timingFault(schedule: PageData['schedules'][number]): string | null {
		const next = nextRunAfter(schedule, new Date());
		return 'fault' in next ? next.fault : null;
	}

	let schedScope = $derived<'board' | 'category' | 'all'>(
		schedTarget === 'all' ? 'all' : schedTarget.startsWith('cat:') ? 'category' : 'board'
	);
	let schedScopeId = $derived<number | null>(
		schedTarget === 'all' ? null : schedTarget.startsWith('cat:') ? Number(schedTarget.slice(4)) : Number(schedTarget)
	);

	// The three say what the server said when it is refused. They used to say
	// nothing, and creating one closed the form and emptied it as if it had
	// been saved.

	async function createSchedule() {
		schedCreating = true;
		const started = toasts.navigation();
		try {
			let res: Response;
			try {
				res = await fetch('/api/report-schedules', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					// The name trimmed, as the server trims it: one of spaces alone is
					// refused. The recipients in the one form a schedule holds, addresses
					// separated by commas (card 2117); the server reads them as
					// `reportRecipients` does, and holds them to 10 (card 2182).
					body: JSON.stringify({
						name: schedName.trim() || 'Scheduled Report',
						scope: schedScope,
						scopeId: schedScopeId,
						frequency: schedFrequency,
						dayOfWeek: schedDayOfWeek,
						dayOfMonth: schedDayOfMonth,
						timeOfDay: schedTime,
						// Without one the server reads the time in UTC.
						timeZone: browserZone ?? undefined,
						recipients: schedRecipients
							.split(/[,;\n]/)
							.map((e) => e.trim())
							.filter((e) => e.length > 0)
							.join(', '),
						periodDays: schedPeriodDays,
						detailLevel: schedDetailLevel,
						statusFilter: schedStatusFilter
					})
				});
			} catch {
				toasts.add('No answer from the server. The schedule may not have been created.', 'error', started);
				return;
			}
			if (!res.ok) {
				// The form stays as it was filled in, to be put right and sent again.
				toasts.add(await failureMessage(res, 'The schedule was not created.'), 'error', started);
				return;
			}
			showNewSchedule = false;
			schedName = '';
			schedRecipients = '';
			await invalidateAll();
		} finally {
			schedCreating = false;
		}
	}

	async function toggleSchedule(scheduleId: number, enabled: boolean) {
		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/report-schedules/${scheduleId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled })
			});
		} catch {
			toasts.add('No answer from the server. The schedule may not have been changed.', 'error', started);
			return;
		}
		if (!res.ok) {
			toasts.add(await failureMessage(res, 'The schedule was not changed.'), 'error', started);
			return;
		}
		await invalidateAll();
	}

	/**
	 * Read a schedule's time in the viewer's zone from now on (card 2159): the
	 * server works its next run out again. How a schedule made before there
	 * were zones, which reads its time in UTC, is moved to UK time.
	 */
	async function useMyTimeZone(scheduleId: number) {
		const started = toasts.navigation();
		let res: Response;
		try {
			res = await fetch(`/api/report-schedules/${scheduleId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ timeZone: browserZone })
			});
		} catch {
			toasts.add('No answer from the server. The schedule may not have been changed.', 'error', started);
			return;
		}
		if (!res.ok) {
			toasts.add(await failureMessage(res, 'The schedule was not changed.'), 'error', started);
			return;
		}
		await invalidateAll();
	}

	async function deleteSchedule(scheduleId: number) {
		const started = toasts.navigation();
		const failure = await deleteFailure(() => fetch(`/api/report-schedules/${scheduleId}`, { method: 'DELETE' }), 'schedule');
		if (failure) {
			toasts.add(failure, 'error', started);
			return;
		}
		await invalidateAll();
	}

	// Helpers
	const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	/**
	 * A schedule's last or next run, written in the schedule's own zone with the
	 * zone's short name ("19 Oct 2026, 09:00 BST"), as its time of day is
	 * (card 2159): in the viewer's zone, "at 09:00" sat beside "Next: 10:00".
	 * In the viewer's zone where this browser does not know the schedule's.
	 */
	function formatDateTime(dateStr: string, zone: string): string {
		if (!dateStr) return '—';
		// A schedule's times are in the stored form, UTC with no zone: read as UTC.
		const d = parseStamp(dateStr);
		if (!d) return '—';
		const timeZone = canonicalTimeZone(zone) ?? undefined;
		return d.toLocaleString('en-GB', {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			timeZone,
			timeZoneName: timeZone ? 'short' : undefined
		});
	}

	/**
	 * A schedule's next run in the viewer's own time, to follow it where the two
	 * zones differ (the review's O-S3): " (10:00 your time)", with the date too
	 * when it is another day there. Empty where the zones are the same, or where
	 * this browser does not know the schedule's zone, as Next is then written in
	 * the viewer's zone already.
	 */
	function viewerTime(dateStr: string, zone: string): string {
		const scheduleZone = canonicalTimeZone(zone);
		if (!browserZone || !scheduleZone || !inAnotherZone(zone)) return '';
		const d = parseStamp(dateStr);
		if (!d) return '';
		const viewer = browserZone;
		const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: viewer });
		const day = (timeZone: string) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone });
		return day(viewer) === day(scheduleZone) ? ` (${time} your time)` : ` (${day(viewer)}, ${time} your time)`;
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
					<span class="email-hint">Up to {MAX_REPORT_RECIPIENTS} addresses, separated by commas</span>
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
							<option value="14d">Last 14 days</option>
							<option value="30d">Last 30 days</option>
							<option value="60d">Last 60 days</option>
							<option value="90d">Last 90 days</option>
							<option value="month">This month</option>
							<option value="quarter">This quarter</option>
							<option value="ytd">Year to date</option>
							<option value="year">Last 12 months</option>
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
					<div class="form-group">
						<label for="gen-assignee">Person</label>
						<select id="gen-assignee" bind:value={genAssignee}>
							<option value="all">👥 Everyone</option>
							{#each data.assignableUsers as u}
								<option value={String(u.id)}>{u.emoji} {u.username}</option>
							{/each}
						</select>
						<span class="form-hint">
							{genAssignee === 'all'
								? 'Every assignee on the selected boards.'
								: 'Only cards assigned to this person — a card they share with someone else still counts for both.'}
						</span>
					</div>
					<div class="form-group">
						<label for="gen-status">Include</label>
						<select id="gen-status" bind:value={genStatusFilter}>
							{#each statusFilterOptions as opt}
								<option value={opt.value}>{opt.label}</option>
							{/each}
						</select>
						<span class="form-hint">{statusFilterHint(genStatusFilter)}</span>
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
								<span class="form-hint">{browserZone ? `In your time zone, ${browserZone}` : 'In UTC'}</span>
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
								<span class="form-hint">Up to {MAX_REPORT_RECIPIENTS} addresses, separated by commas. The report is emailed to each.</span>
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
							<div class="form-group">
								<label for="sched-status">Include</label>
								<select id="sched-status" bind:value={schedStatusFilter}>
									{#each statusFilterOptions as opt}
										<option value={opt.value}>{opt.short}</option>
									{/each}
								</select>
								<span class="form-hint">{statusFilterHint(schedStatusFilter)}</span>
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
							{@const sentTo = reportRecipients(schedule.recipients).addresses}
							{@const fault = timingFault(schedule)}
							<div class="schedule-card" class:disabled={!schedule.enabled}>
								<div class="schedule-info">
									<div class="schedule-name">{schedule.name}</div>
									<div class="schedule-meta">
										<span class="scope-badge">{getScopeLabel(schedule.scope, schedule.scopeId)}</span>
										<span class="freq-badge">{schedule.frequency === 'weekly' ? `Weekly on ${dayNames[schedule.dayOfWeek]}` : `Monthly on day ${schedule.dayOfMonth}`} at {schedule.timeOfDay} {schedule.timeZone}</span>
										<span class="freq-badge">Last {schedule.periodDays} days</span>
										<span class="freq-badge">{schedule.detailLevel === 'summary' ? '📊 Summary' : '📋 Detailed'}</span>
										{#if schedule.statusFilter && schedule.statusFilter !== 'all'}
											<span class="freq-badge">{statusFilterShort(schedule.statusFilter)}</span>
										{/if}
									</div>
									{#if sentTo.length > MAX_REPORT_RECIPIENTS}
										<!-- Kept from before there was a cap (card 2182): the scheduler switches it
										     off and sends nothing. Its addresses are shown, to be copied into a new
										     schedule, since this page cannot edit one. -->
										<div class="schedule-recipients over-cap">
											{sentTo.length} recipients: the most is {MAX_REPORT_RECIPIENTS}, so it is not sent
										</div>
										<div class="over-cap-addresses">{sentTo.join(', ')}</div>
										<span class="over-cap-hint">Copy the ones to keep into a new schedule of at most {MAX_REPORT_RECIPIENTS}, then delete this one.</span>
									{:else if sentTo.length > 0}
										<div class="schedule-recipients">
											<svg width="10" height="10" viewBox="0 0 14 14" fill="none"><path d="M2 4l5 4 5-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><rect x="1" y="3" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/></svg>
											{sentTo.length} recipient{sentTo.length !== 1 ? 's' : ''}
										</div>
									{:else}
										<span class="no-recipients-warn">⚠️ No recipients configured</span>
									{/if}
									{#if schedule.lastRunAt}
										<span class="schedule-last-run">Last: {formatDateTime(schedule.lastRunAt, schedule.timeZone)}</span>
									{/if}
									{#if fault}
										<!-- The scheduler switches such a schedule off and sends nothing (card 2144),
										     and clears a next run it cannot read. Turning it on is refused unless the
										     same request sends a timing that can be read, which this page cannot
										     send. The zone button is not offered: a new zone is refused for any other
										     fault, and would leave the schedule off for that one. -->
										<span class="schedule-fault">Cannot be sent: {fault}. Delete it and make it again, or turn it on through the API with a time, day and zone that can be read.</span>
									{:else if schedule.nextRunAt}
										<span class="schedule-next-run">Next: {formatDateTime(schedule.nextRunAt, schedule.timeZone)}{viewerTime(schedule.nextRunAt, schedule.timeZone)}</span>
									{/if}
									{#if !fault && inAnotherZone(schedule.timeZone)}
										<button class="zone-btn" onclick={() => useMyTimeZone(schedule.id)}>Use my time zone ({browserZone})</button>
										<span class="zone-hint">Reads its time in {browserZone} from now on, and works its next run out again.</span>
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

<Toast />

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
	/* The page's last line stops above the user badge (card 2239). */
	.reports-content {
		flex: 1;
		padding: var(--space-xl) var(--space-xl) var(--user-badge-space);
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

	.schedule-recipients.over-cap { color: var(--priority-high); font-weight: 600; }
	.over-cap-addresses {
		font-size: 0.7rem;
		color: var(--text-secondary);
		user-select: text;
		overflow-wrap: anywhere;
	}
	.over-cap-hint { font-size: 0.68rem; color: var(--text-tertiary); }
	.schedule-fault { font-size: 0.7rem; color: var(--priority-high); font-weight: 600; }
	.zone-btn {
		align-self: flex-start;
		margin-top: 2px;
		padding: 1px 8px;
		border-radius: var(--radius-full);
		background: var(--bg-elevated);
		color: var(--accent-purple);
		font-size: 0.68rem;
		cursor: pointer;
	}
	.zone-btn:hover { background: var(--glass-hover); }
	.zone-hint { font-size: 0.65rem; color: var(--text-tertiary); }

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
		.reports-content { padding: var(--space-md) var(--space-md) var(--user-badge-space); }
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

