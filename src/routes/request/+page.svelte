<script lang="ts">
	import { onMount } from 'svelte';

	type Target = { id: number; name: string; emoji: string; type: 'user' | 'team' };

	let targets = $state<Target[]>([]);
	let selectedTarget = $state('');
	let title = $state('');
	let description = $state('');
	let businessValue = $state('');
	let priority = $state('medium');
	let requesterName = $state('');
	let requesterEmail = $state('');
	let submitting = $state(false);
	let submitted = $state(false);
	let errorMsg = $state('');

	// Check if user is authenticated (injected by layout)
	let isAuthed = $state(false);

	onMount(async () => {
		// Check auth status by trying to see if layout data has user
		try {
			const layoutData = (window as any).__sveltekit_data;
			// Simpler: just check if we have a session cookie
		} catch {}

		// Load targets
		const res = await fetch('/api/requests/targets');
		if (res.ok) targets = await res.json();
	});

	async function submit() {
		if (!title.trim()) { errorMsg = 'Title is required'; return; }
		if (!selectedTarget) { errorMsg = 'Please select a target'; return; }
		if (!requesterName.trim()) { errorMsg = 'Your name is required'; return; }
		if (!requesterEmail.trim()) { errorMsg = 'Your email is required'; return; }

		const [type, idStr] = selectedTarget.split(':');
		const targetId = Number(idStr);

		submitting = true;
		errorMsg = '';

		const res = await fetch('/api/requests', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				targetType: type,
				targetId,
				title: title.trim(),
				description,
				businessValue,
				priority,
				requesterName: requesterName.trim() || undefined,
				requesterEmail: requesterEmail.trim() || undefined
			})
		});

		submitting = false;
		if (res.ok) {
			submitted = true;
		} else {
			const data = await res.json().catch(() => ({}));
			errorMsg = data.message || 'Failed to submit request';
		}
	}

	const priorities = [
		{ value: 'low', label: '🟢 Low', color: '#22c55e' },
		{ value: 'medium', label: '🟡 Medium', color: '#eab308' },
		{ value: 'high', label: '🟠 High', color: '#f97316' },
		{ value: 'critical', label: '🔴 Critical', color: '#ef4444' }
	];
</script>

<svelte:head>
	<title>Request a Task — DumpFire</title>
	<meta name="description" content="Submit a task request to a team or individual." />
</svelte:head>

<div class="request-page">
	<div class="request-container">
		{#if submitted}
			<div class="success-card">
				<div class="success-icon">✅</div>
				<h1>Request Submitted!</h1>
				<p>Your task request has been sent and will be reviewed shortly.</p>
				<div class="success-actions">
					<button class="btn-primary" onclick={() => { submitted = false; title = ''; description = ''; businessValue = ''; selectedTarget = ''; priority = 'medium'; requesterName = ''; requesterEmail = ''; }}>
						Submit Another
					</button>
					<a href="/" class="btn-home">🏠 Home</a>
				</div>
			</div>
		{:else}
			<div class="form-header">
				<a href="/" class="home-link" title="Home">🏠</a>
				<div class="form-icon">📋</div>
				<h1>Request a Task</h1>
				<p class="form-subtitle">Submit a feature request, bug report, or task to a team or person.</p>
			</div>

			<form class="request-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
				<!-- Target -->
				<div class="form-group">
					<label for="target">Send to <span class="required">*</span></label>
					<select id="target" bind:value={selectedTarget} class="form-select">
						<option value="">Choose a team or person...</option>
						<optgroup label="🏢 Teams">
							{#each targets.filter(t => t.type === 'team') as t}
								<option value="team:{t.id}">{t.emoji} {t.name}</option>
							{/each}
						</optgroup>
						<optgroup label="👤 People">
							{#each targets.filter(t => t.type === 'user') as t}
								<option value="user:{t.id}">{t.emoji} {t.name}</option>
							{/each}
						</optgroup>
					</select>
				</div>

				<!-- Title -->
				<div class="form-group">
					<label for="title">Title <span class="required">*</span></label>
					<input id="title" type="text" bind:value={title} placeholder="Brief summary of your request..." class="form-input" />
				</div>

				<!-- Description -->
				<div class="form-group">
					<label for="description">Description</label>
					<textarea id="description" bind:value={description} placeholder="Provide details, context, or steps to reproduce..." rows="5" class="form-textarea"></textarea>
				</div>

				<!-- Business Value -->
				<div class="form-group">
					<label for="business-value">Business Value / Justification</label>
					<textarea id="business-value" bind:value={businessValue} placeholder="Why is this important? What value does it deliver?" rows="3" class="form-textarea"></textarea>
				</div>

				<!-- Priority -->
				<div class="form-group">
					<label>Priority</label>
					<div class="priority-pills">
						{#each priorities as p}
							<button
								type="button"
								class="priority-pill"
								class:active={priority === p.value}
								style="--pill-color: {p.color}"
								onclick={() => priority = p.value}
							>
								{p.label}
							</button>
						{/each}
					</div>
				</div>

				<!-- Requester info -->
				<div class="form-group requester-fields">
					<label>Your details <span class="required">*</span></label>
					<div class="requester-row">
						<input type="text" bind:value={requesterName} placeholder="Your name" class="form-input" required />
						<input type="email" bind:value={requesterEmail} placeholder="Your email" class="form-input" required />
					</div>
				</div>

				{#if errorMsg}
					<div class="error-msg">{errorMsg}</div>
				{/if}

				<button type="submit" class="btn-submit" disabled={submitting}>
					{#if submitting}
						Submitting...
					{:else}
						📨 Submit Request
					{/if}
				</button>
			</form>
		{/if}
	</div>
</div>

<style>
	.request-page {
		min-height: 100vh;
		display: flex; align-items: center; justify-content: center;
		padding: var(--space-xl);
		background: var(--bg-primary);
	}
	.request-container {
		width: 100%; max-width: 580px;
		background: var(--bg-card);
		border: 1px solid var(--glass-border);
		border-radius: var(--radius-lg);
		padding: var(--space-2xl);
		box-shadow: var(--shadow-lg);
	}

	/* Header */
	.form-header { text-align: center; margin-bottom: var(--space-xl); }
	.form-icon { font-size: 2.5rem; margin-bottom: var(--space-sm); }
	.form-header h1 { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-xs); }
	.form-subtitle { color: var(--text-secondary); font-size: 0.88rem; }

	/* Form */
	.request-form { display: flex; flex-direction: column; gap: var(--space-lg); }
	.form-group { display: flex; flex-direction: column; gap: var(--space-xs); }
	.form-group label { font-size: 0.82rem; font-weight: 600; color: var(--text-secondary); }
	.required { color: var(--accent-rose); }
	.optional { font-weight: 400; color: var(--text-tertiary); font-size: 0.75rem; }

	.form-input, .form-select, .form-textarea {
		width: 100%; padding: 10px 14px;
		background: var(--bg-surface); border: 1px solid var(--glass-border);
		border-radius: var(--radius-md); color: var(--text-primary);
		font-family: var(--font-family); font-size: 0.88rem;
		transition: border-color var(--duration-fast) var(--ease-out);
	}
	.form-input:focus, .form-select:focus, .form-textarea:focus {
		outline: none; border-color: var(--accent-indigo);
		box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
	}
	.form-textarea { resize: vertical; min-height: 100px; }
	.form-select { cursor: pointer; }

	/* Priority pills */
	.priority-pills { display: flex; gap: var(--space-sm); flex-wrap: wrap; }
	.priority-pill {
		padding: 6px 14px; border-radius: var(--radius-full);
		border: 1px solid var(--glass-border); background: var(--bg-surface);
		color: var(--text-secondary); font-size: 0.78rem; font-weight: 600;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
	}
	.priority-pill:hover { border-color: var(--pill-color); color: var(--pill-color); }
	.priority-pill.active {
		background: color-mix(in srgb, var(--pill-color) 12%, transparent);
		border-color: var(--pill-color); color: var(--pill-color);
	}

	/* Requester */
	.requester-row { display: flex; gap: var(--space-sm); }
	.requester-row .form-input { flex: 1; }

	/* Error */
	.error-msg {
		background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2);
		border-radius: var(--radius-md); padding: 10px 14px;
		color: var(--accent-rose); font-size: 0.82rem; font-weight: 500;
	}

	/* Submit */
	.btn-submit {
		width: 100%; padding: 12px;
		background: var(--accent-indigo); color: white; border: none;
		border-radius: var(--radius-md); font-size: 0.92rem; font-weight: 700;
		cursor: pointer; transition: all var(--duration-fast) var(--ease-out);
		font-family: var(--font-family);
	}
	.btn-submit:hover:not(:disabled) { background: #5558e6; transform: translateY(-1px); box-shadow: var(--shadow-md); }
	.btn-submit:disabled { opacity: 0.6; cursor: not-allowed; }

	/* Success */
	.success-card { text-align: center; padding: var(--space-xl) 0; }
	.success-icon { font-size: 3rem; margin-bottom: var(--space-md); }
	.success-card h1 { font-size: 1.4rem; font-weight: 700; color: var(--text-primary); margin-bottom: var(--space-sm); }
	.success-card p { color: var(--text-secondary); margin-bottom: var(--space-lg); font-size: 0.9rem; }
	.btn-primary {
		padding: 10px 24px; background: var(--accent-indigo); color: white;
		border: none; border-radius: var(--radius-md); font-weight: 600;
		font-size: 0.85rem; cursor: pointer; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-primary:hover { background: #5558e6; }

	/* Home link */
	.home-link {
		position: absolute; top: 0; right: 0;
		font-size: 1.4rem; text-decoration: none;
		opacity: 0.5; transition: opacity var(--duration-fast) var(--ease-out);
	}
	.home-link:hover { opacity: 1; }
	.form-header { position: relative; }

	.success-actions { display: flex; gap: var(--space-sm); justify-content: center; align-items: center; }
	.btn-home {
		padding: 10px 24px; background: var(--bg-surface); color: var(--text-secondary);
		border: 1px solid var(--glass-border); border-radius: var(--radius-md); font-weight: 600;
		font-size: 0.85rem; text-decoration: none; font-family: var(--font-family);
		transition: all var(--duration-fast) var(--ease-out);
	}
	.btn-home:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
