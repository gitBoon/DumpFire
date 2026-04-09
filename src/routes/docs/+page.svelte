<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';

	type Schema = { type?: string | string[]; properties?: Record<string, any>; items?: any; $ref?: string; enum?: string[]; required?: string[]; description?: string; format?: string; default?: any; maxLength?: number };
	type Param = { name: string; in: string; required?: boolean; schema?: Schema; description?: string };
	type OpResponse = { description?: string; content?: Record<string, { schema?: Schema; example?: any }> };
	type Operation = { tags?: string[]; summary?: string; description?: string; operationId?: string; parameters?: (Param | { $ref: string })[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema; example?: any }> }; responses?: Record<string, OpResponse | { $ref: string }> };
	type PathItem = Record<string, Operation>;
	type OASSpec = { openapi: string; info: { title: string; version: string; description: string }; paths: Record<string, PathItem>; tags?: { name: string; description: string }[]; components?: any };

	let spec: OASSpec | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let activeTag = $state('');
	let expandedEndpoint = $state('');
	let activeCodeTab: Record<string, string> = $state({});
	let sidebarOpen = $state(false);

	const METHOD_COLORS: Record<string, string> = {
		get: '#10b981',
		post: '#6366f1',
		put: '#f59e0b',
		delete: '#ef4444',
		patch: '#8b5cf6'
	};

	onMount(async () => {
		try {
			const res = await fetch('/api/v1/openapi.json');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			spec = await res.json();
			if (spec?.tags?.[0]) activeTag = spec.tags[0].name;
		} catch (e: any) {
			error = e.message || 'Failed to load API spec';
		} finally {
			loading = false;
		}
	});

	function getEndpointsByTag(tag: string): { path: string; method: string; op: Operation }[] {
		if (!spec) return [];
		const results: { path: string; method: string; op: Operation }[] = [];
		for (const [path, methods] of Object.entries(spec.paths)) {
			for (const [method, op] of Object.entries(methods)) {
				if (op.tags?.includes(tag)) {
					results.push({ path, method, op });
				}
			}
		}
		return results;
	}

	function toggleEndpoint(id: string) {
		expandedEndpoint = expandedEndpoint === id ? '' : id;
	}

	function resolveRef(ref: string): any {
		if (!spec || !ref.startsWith('#/')) return {};
		const parts = ref.substring(2).split('/');
		let obj: any = spec;
		for (const p of parts) {
			obj = obj?.[p];
			if (!obj) return {};
		}
		return obj;
	}

	function resolveSchema(s: Schema | undefined): Schema {
		if (!s) return {};
		if (s.$ref) return resolveRef(s.$ref);
		return s;
	}

	function resolveParam(p: Param | { $ref: string }): Param {
		if ('$ref' in p && p.$ref) return resolveRef(p.$ref);
		return p as Param;
	}

	function resolveResponse(r: OpResponse | { $ref: string }): OpResponse {
		if ('$ref' in r && r.$ref) return resolveRef(r.$ref);
		return r as OpResponse;
	}

	function schemaToExample(s: Schema): any {
		const resolved = resolveSchema(s);
		if (!resolved) return null;
		const t = Array.isArray(resolved.type) ? resolved.type[0] : resolved.type;
		if (t === 'object' && resolved.properties) {
			const obj: Record<string, any> = {};
			for (const [k, v] of Object.entries(resolved.properties)) {
				obj[k] = schemaToExample(v);
			}
			return obj;
		}
		if (t === 'array' && resolved.items) return [schemaToExample(resolved.items)];
		if (resolved.enum) return resolved.enum[0];
		if (t === 'integer') return 1;
		if (t === 'number') return 0.0;
		if (t === 'boolean') return false;
		if (t === 'string') {
			if (resolved.format === 'email') return 'user@example.com';
			if (resolved.format === 'date') return '2026-04-15';
			return 'string';
		}
		if (t === 'null') return null;
		return null;
	}

	function getResponseExample(r: OpResponse): string {
		if (!r.content) return '';
		const ct = r.content['application/json'];
		if (!ct) return '';
		if (ct.example) return JSON.stringify(ct.example, null, 2);
		if (ct.schema) return JSON.stringify(schemaToExample(ct.schema), null, 2);
		return '';
	}

	function getRequestExample(op: Operation): string {
		if (!op.requestBody?.content?.['application/json']) return '';
		const ct = op.requestBody.content['application/json'];
		if (ct.example) return JSON.stringify(ct.example, null, 2);
		if (ct.schema) {
			const s = resolveSchema(ct.schema);
			if (s.properties) {
				const obj: Record<string, any> = {};
				for (const [k, v] of Object.entries(s.properties)) {
					obj[k] = schemaToExample(v);
				}
				return JSON.stringify(obj, null, 2);
			}
		}
		return '';
	}

	function getRequestBodyFields(op: Operation): { name: string; type: string; required: boolean; description: string }[] {
		if (!op.requestBody?.content?.['application/json']?.schema) return [];
		const s = resolveSchema(op.requestBody.content['application/json'].schema);
		if (!s.properties) return [];
		const req = s.required || [];
		return Object.entries(s.properties).map(([name, prop]: [string, any]) => {
			const resolved = resolveSchema(prop);
			let type = Array.isArray(resolved.type) ? resolved.type.join(' | ') : (resolved.type || 'any');
			if (resolved.enum) type = resolved.enum.join(' | ');
			return { name, type, required: req.includes(name), description: resolved.description || '' };
		});
	}

	function generateCurl(method: string, path: string, op: Operation): string {
		const upperM = method.toUpperCase();
		let cmd = `curl -s`;
		if (upperM !== 'GET') cmd += ` -X ${upperM}`;
		cmd += ` \\\n  -H "Authorization: Bearer \$API_KEY"`;
		const body = getRequestExample(op);
		if (body) {
			cmd += ` \\\n  -H "Content-Type: application/json"`;
			cmd += ` \\\n  -d '${body}'`;
		}
		const displayPath = path.replace(/\{(\w+)\}/g, ':$1');
		cmd += ` \\\n  "$BASE_URL${displayPath}"`;
		return cmd;
	}

	function generatePython(method: string, path: string, op: Operation): string {
		const body = getRequestExample(op);
		const displayPath = path.replace(/\{(\w+)\}/g, (_, k) => `{${k}}`);
		let code = `import requests\n\nAPI_KEY = "df_your_key"\nBASE = "https://your-instance.com"\nHEADERS = {"Authorization": f"Bearer {API_KEY}"}\n\n`;
		if (method === 'get') {
			code += `resp = requests.get(f"{BASE}${displayPath}", headers=HEADERS)\nprint(resp.json())`;
		} else if (method === 'delete' && !body) {
			code += `resp = requests.delete(f"{BASE}${displayPath}", headers=HEADERS)\nprint(resp.json())`;
		} else {
			const m = method === 'delete' ? 'delete' : (method === 'put' ? 'put' : 'post');
			code += `resp = requests.${m}(\n    f"{BASE}${displayPath}",\n    headers=HEADERS,\n    json=${body || '{}'}\n)\nprint(resp.json())`;
		}
		return code;
	}

	function generatePowershell(method: string, path: string, op: Operation): string {
		const body = getRequestExample(op);
		const displayPath = path.replace(/\{(\w+)\}/g, (_, k) => `$${k}`);
		let code = `$Headers = @{ "Authorization" = "Bearer $ApiKey" }\n`;
		if (method === 'get') {
			code += `Invoke-RestMethod -Uri "$Base${displayPath}" -Headers $Headers`;
		} else {
			const psMethod = method.charAt(0).toUpperCase() + method.slice(1);
			if (body) {
				code += `$Headers["Content-Type"] = "application/json"\n`;
				code += `$Body = '${body}'\n`;
				code += `Invoke-RestMethod -Method ${psMethod} -Uri "$Base${displayPath}" -Headers $Headers -Body $Body`;
			} else {
				code += `Invoke-RestMethod -Method ${psMethod} -Uri "$Base${displayPath}" -Headers $Headers`;
			}
		}
		return code;
	}

	function getCodeTab(id: string): string {
		return activeCodeTab[id] || 'curl';
	}

	function setCodeTab(id: string, tab: string) {
		activeCodeTab = { ...activeCodeTab, [id]: tab };
	}
</script>

<svelte:head>
	<title>API Documentation — DumpFire</title>
	<meta name="description" content="DumpFire REST API documentation — OpenAPI 3.1 specification for automation and integrations." />
</svelte:head>

<div class="docs-page">
	<!-- Header -->
	<header class="docs-header glass">
		<div class="docs-header-inner">
			<a href="/" class="docs-logo" title="Back to DumpFire">
				<span class="logo-fire">🔥</span>
				<span class="logo-text">DumpFire</span>
			</a>
			<div class="docs-header-center">
				<h1 class="docs-title">API Reference</h1>
				{#if spec}
					<span class="docs-version">v{spec.info.version}</span>
					<span class="docs-oas-badge">OpenAPI {spec.openapi}</span>
				{/if}
			</div>
			<div class="docs-header-actions">
				<a href="/api/v1/openapi.json" target="_blank" rel="noopener" class="btn-spec" title="Download OpenAPI spec">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
					<span>JSON Spec</span>
				</a>
				<button class="btn-sidebar-toggle" onclick={() => sidebarOpen = !sidebarOpen}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
				</button>
			</div>
		</div>
	</header>

	{#if loading}
		<div class="docs-loading">
			<div class="loading-spinner"></div>
			<p>Loading API specification…</p>
		</div>
	{:else if error}
		<div class="docs-error glass">
			<span class="error-icon">⚠️</span>
			<p>{error}</p>
		</div>
	{:else if spec}
		<div class="docs-layout">
			<!-- Sidebar -->
			<nav class="docs-sidebar glass" class:open={sidebarOpen}>
				<div class="sidebar-section">
					<div class="sidebar-label">Overview</div>
					<button class="sidebar-link" class:active={activeTag === '__auth'} onclick={() => { activeTag = '__auth'; sidebarOpen = false; }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
						Authentication
					</button>
					<button class="sidebar-link" class:active={activeTag === '__errors'} onclick={() => { activeTag = '__errors'; sidebarOpen = false; }}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
						Errors & Rate Limits
					</button>
				</div>
				<div class="sidebar-divider"></div>
				<div class="sidebar-section">
					<div class="sidebar-label">Endpoints</div>
					{#each spec.tags || [] as tag}
						{@const endpoints = getEndpointsByTag(tag.name)}
						<button class="sidebar-link" class:active={activeTag === tag.name} onclick={() => { activeTag = tag.name; sidebarOpen = false; }}>
							<span class="sidebar-tag-count">{endpoints.length}</span>
							{tag.name}
						</button>
					{/each}
				</div>
			</nav>

			<!-- Content area -->
			<main class="docs-main">
				{#if activeTag === '__auth'}
					<section class="docs-section animate-fade-in">
						<div class="section-header">
							<h2>🔒 Authentication</h2>
						</div>
						<div class="info-card glass">
							<p>All API requests require an API key sent via the <code>Authorization</code> header as a Bearer token.</p>
							<div class="code-block">
								<div class="code-block-header">Header</div>
								<pre><code>Authorization: Bearer df_your_api_key_here</code></pre>
							</div>
							<h3>Generating a Key</h3>
							<ol>
								<li>Log in to DumpFire</li>
								<li>Navigate to <strong>My Account</strong> (⚙️)</li>
								<li>Scroll to the <strong>🔑 API Keys</strong> section</li>
								<li>Enter a descriptive name (e.g. "CI Pipeline", "n8n Automation")</li>
								<li>Click <strong>Generate Key</strong></li>
								<li><strong>Copy the key immediately</strong> — it is only displayed once</li>
							</ol>
							<div class="info-callout">
								<span class="callout-icon">💡</span>
								<p>API keys inherit the permissions of the user who created them. A regular user can only access boards they have edit/view access to. Admin users have global access.</p>
							</div>
							<h3>Revoking a Key</h3>
							<p>Go to <strong>My Account → API Keys</strong> and click <strong>Revoke</strong> on any key. The key is immediately invalidated.</p>
						</div>
					</section>
				{:else if activeTag === '__errors'}
					<section class="docs-section animate-fade-in">
						<div class="section-header">
							<h2>⚡ Errors & Rate Limits</h2>
						</div>
						<div class="info-card glass">
							<h3>Rate Limits</h3>
							<p>API requests are rate-limited to <strong>60 requests per minute</strong> per API key.</p>
							<p>When exceeded, you'll receive a <code>429</code> response with a <code>Retry-After</code> header:</p>
							<div class="code-block">
								<div class="code-block-header">429 Response</div>
								<pre><code>{JSON.stringify({ error: "Rate limit exceeded", retryAfterSecs: 42 }, null, 2)}</code></pre>
							</div>

							<h3>Error Format</h3>
							<p>All errors return JSON with an <code>error</code> field:</p>
							<div class="code-block">
								<div class="code-block-header">Error Response</div>
								<pre><code>{JSON.stringify({ error: "Description of what went wrong" }, null, 2)}</code></pre>
							</div>

							<h3>HTTP Status Codes</h3>
							<div class="status-table">
								<table>
									<thead><tr><th>Code</th><th>Meaning</th></tr></thead>
									<tbody>
										<tr><td><span class="status-badge s2xx">200</span></td><td>Success</td></tr>
										<tr><td><span class="status-badge s2xx">201</span></td><td>Resource created</td></tr>
										<tr><td><span class="status-badge s4xx">400</span></td><td>Bad request (missing or invalid fields)</td></tr>
										<tr><td><span class="status-badge s4xx">401</span></td><td>Unauthorized (missing or invalid API key)</td></tr>
										<tr><td><span class="status-badge s4xx">403</span></td><td>Forbidden (no access to the requested resource)</td></tr>
										<tr><td><span class="status-badge s4xx">404</span></td><td>Resource not found</td></tr>
										<tr><td><span class="status-badge s4xx">429</span></td><td>Rate limit exceeded</td></tr>
										<tr><td><span class="status-badge s5xx">500</span></td><td>Internal server error</td></tr>
									</tbody>
								</table>
							</div>
						</div>
					</section>
				{:else}
					{@const endpoints = getEndpointsByTag(activeTag)}
					{@const tagInfo = spec.tags?.find(t => t.name === activeTag)}
					<section class="docs-section animate-fade-in" id="tag-{activeTag}">
						<div class="section-header">
							<h2>{activeTag}</h2>
							{#if tagInfo?.description}
								<p class="section-desc">{tagInfo.description}</p>
							{/if}
						</div>

						<div class="endpoints-list stagger-children">
							{#each endpoints as { path, method, op }}
								{@const eid = `${method}-${path}`}
								{@const isExpanded = expandedEndpoint === eid}
								<div class="endpoint-card glass" class:expanded={isExpanded}>
									<button class="endpoint-header" onclick={() => toggleEndpoint(eid)}>
										<span class="method-badge" style="background: {METHOD_COLORS[method] || '#888'}">
											{method.toUpperCase()}
										</span>
										<span class="endpoint-path">{path}</span>
										<span class="endpoint-summary">{op.summary || ''}</span>
										<svg class="expand-icon" class:rotated={isExpanded} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
									</button>

									{#if isExpanded}
										<div class="endpoint-body">
											{#if op.description}
												<p class="endpoint-desc">{op.description}</p>
											{/if}

											<!-- Parameters -->
											{#if op.parameters && op.parameters.length > 0}
												{@const params = op.parameters.map(resolveParam)}
												<div class="endpoint-section">
													<h4>Parameters</h4>
													<div class="param-table">
														<table>
															<thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
															<tbody>
																{#each params as p}
																	<tr>
																		<td><code>{p.name}</code></td>
																		<td><span class="param-in">{p.in}</span></td>
																		<td><code>{p.schema?.type || 'any'}</code></td>
																		<td>{p.required ? '✅' : '—'}</td>
																		<td>{p.description || ''}</td>
																	</tr>
																{/each}
															</tbody>
														</table>
													</div>
												</div>
											{/if}

											<!-- Request Body -->
											{#if op.requestBody}
												{@const fields = getRequestBodyFields(op)}
												{@const example = getRequestExample(op)}
												<div class="endpoint-section">
													<h4>Request Body</h4>
													{#if fields.length > 0}
														<div class="param-table">
															<table>
																<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
																<tbody>
																	{#each fields as f}
																		<tr>
																			<td><code>{f.name}</code></td>
																			<td><code>{f.type}</code></td>
																			<td>{f.required ? '✅' : '—'}</td>
																			<td>{f.description}</td>
																		</tr>
																	{/each}
																</tbody>
															</table>
														</div>
													{/if}
													{#if example}
														<div class="code-block">
															<div class="code-block-header">Example</div>
															<pre><code>{example}</code></pre>
														</div>
													{/if}
												</div>
											{/if}

											<!-- Responses -->
											{#if op.responses}
												<div class="endpoint-section">
													<h4>Responses</h4>
													{#each Object.entries(op.responses) as [status, rawResp]}
														{@const resp = resolveResponse(rawResp)}
														{@const respExample = getResponseExample(resp)}
														<div class="response-block">
															<div class="response-status">
																<span class="status-badge" class:s2xx={status.startsWith('2')} class:s4xx={status.startsWith('4')} class:s5xx={status.startsWith('5')}>
																	{status}
																</span>
																<span>{resp.description || ''}</span>
															</div>
															{#if respExample}
																<div class="code-block">
																	<div class="code-block-header">Response Body</div>
																	<pre><code>{respExample}</code></pre>
																</div>
															{/if}
														</div>
													{/each}
												</div>
											{/if}

											<!-- Code examples -->
											<div class="endpoint-section">
												<h4>Code Examples</h4>
												<div class="code-tabs">
													<button class="code-tab" class:active={getCodeTab(eid) === 'curl'} onclick={() => setCodeTab(eid, 'curl')}>curl</button>
													<button class="code-tab" class:active={getCodeTab(eid) === 'python'} onclick={() => setCodeTab(eid, 'python')}>Python</button>
													<button class="code-tab" class:active={getCodeTab(eid) === 'powershell'} onclick={() => setCodeTab(eid, 'powershell')}>PowerShell</button>
												</div>
												<div class="code-block">
													<div class="code-block-header">{getCodeTab(eid)}</div>
													{#if getCodeTab(eid) === 'curl'}
														<pre><code>{generateCurl(method, path, op)}</code></pre>
													{:else if getCodeTab(eid) === 'python'}
														<pre><code>{generatePython(method, path, op)}</code></pre>
													{:else}
														<pre><code>{generatePowershell(method, path, op)}</code></pre>
													{/if}
												</div>
											</div>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					</section>
				{/if}
		</main>
	</div>
{/if}
</div>

<style>
	/* ── Layout ─────────────────────────────────────── */
	.docs-page {
		min-height: 100vh;
		background: var(--bg-deep);
		padding-top: 64px;
	}

	.docs-header {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 200;
		height: 64px;
		border-bottom: 1px solid var(--glass-border);
		backdrop-filter: blur(24px);
		-webkit-backdrop-filter: blur(24px);
	}

	.docs-header-inner {
		max-width: 1400px;
		margin: 0 auto;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 var(--space-xl);
	}

	.docs-logo {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		text-decoration: none;
		color: var(--text-primary);
		font-weight: 700;
		font-size: 1.1rem;
		flex-shrink: 0;
	}

	.logo-fire { font-size: 1.4rem; }

	.docs-header-center {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.docs-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-primary);
		letter-spacing: -0.01em;
	}

	.docs-version {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.15);
		color: var(--accent-indigo);
	}

	.docs-oas-badge {
		font-size: 0.65rem;
		font-weight: 600;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		background: rgba(16, 185, 129, 0.12);
		color: var(--accent-emerald);
		letter-spacing: 0.02em;
	}

	.docs-header-actions {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.btn-spec {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 14px;
		font-size: 0.78rem;
		font-weight: 600;
		border-radius: var(--radius-sm);
		background: var(--glass-bg);
		border: 1px solid var(--glass-border);
		color: var(--text-secondary);
		text-decoration: none;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.btn-spec:hover {
		background: var(--glass-hover);
		color: var(--text-primary);
	}

	.btn-sidebar-toggle {
		display: none;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-secondary);
	}

	.btn-sidebar-toggle:hover {
		background: var(--glass-hover);
		color: var(--text-primary);
	}

	/* ── Docs Layout ────────────────────────────────── */
	.docs-layout {
		max-width: 1400px;
		margin: 0 auto;
		display: flex;
		gap: 0;
		min-height: calc(100vh - 64px);
	}

	/* ── Sidebar ──────────────────────────────────── */
	.docs-sidebar {
		width: 240px;
		flex-shrink: 0;
		position: sticky;
		top: 64px;
		height: calc(100vh - 64px);
		overflow-y: auto;
		padding: var(--space-xl) var(--space-lg);
		border-right: 1px solid var(--glass-border);
		border-radius: 0;
		background: transparent;
		backdrop-filter: none;
		border-top: none;
		border-left: none;
		border-bottom: none;
	}

	.sidebar-section {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.sidebar-label {
		font-size: 0.65rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--text-tertiary);
		padding: var(--space-sm) var(--space-sm);
		margin-bottom: var(--space-xs);
	}

	.sidebar-divider {
		height: 1px;
		background: var(--glass-border);
		margin: var(--space-md) 0;
	}

	.sidebar-link {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		padding: 8px 10px;
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--text-secondary);
		background: transparent;
		border-radius: var(--radius-sm);
		text-align: left;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.sidebar-link:hover {
		background: var(--glass-hover);
		color: var(--text-primary);
	}

	.sidebar-link.active {
		background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo);
		font-weight: 600;
	}

	.sidebar-link svg {
		flex-shrink: 0;
		opacity: 0.7;
	}

	.sidebar-tag-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		font-size: 0.65rem;
		font-weight: 700;
		border-radius: var(--radius-full);
		background: var(--glass-bg);
		border: 1px solid var(--glass-border);
		color: var(--text-tertiary);
		flex-shrink: 0;
	}

	/* ── Main content ─────────────────────────────── */
	.docs-main {
		flex: 1;
		min-width: 0;
		padding: var(--space-2xl) var(--space-2xl);
	}

	.docs-section {
		max-width: 900px;
	}

	.section-header {
		margin-bottom: var(--space-xl);
	}

	.section-header h2 {
		font-size: 1.5rem;
		font-weight: 800;
		color: var(--text-primary);
		letter-spacing: -0.02em;
	}

	.section-desc {
		margin-top: var(--space-sm);
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	/* ── Info card (auth, errors) ─────────────────── */
	.info-card {
		padding: var(--space-xl);
		border-radius: var(--radius-lg);
		line-height: 1.7;
		font-size: 0.88rem;
		color: var(--text-secondary);
	}

	.info-card h3 {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text-primary);
		margin-top: var(--space-xl);
		margin-bottom: var(--space-sm);
	}

	.info-card h3:first-of-type {
		margin-top: var(--space-md);
	}

	.info-card ol {
		padding-left: var(--space-xl);
		margin: var(--space-sm) 0;
	}

	.info-card ol li {
		margin: var(--space-xs) 0;
	}

	.info-card p {
		margin: var(--space-sm) 0;
	}

	.info-card code {
		font-family: var(--font-mono);
		font-size: 0.82rem;
		padding: 2px 6px;
		border-radius: 4px;
		background: var(--bg-elevated);
		color: var(--text-accent);
	}

	.info-callout {
		display: flex;
		gap: var(--space-md);
		padding: var(--space-md) var(--space-lg);
		margin: var(--space-lg) 0;
		border-radius: var(--radius-md);
		background: rgba(99, 102, 241, 0.06);
		border-left: 3px solid var(--accent-indigo);
	}

	.callout-icon { font-size: 1.1rem; flex-shrink: 0; }

	.info-callout p {
		margin: 0;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	/* ── Endpoint cards ───────────────────────────── */
	.endpoints-list {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
	}

	.endpoint-card {
		border-radius: var(--radius-lg);
		overflow: hidden;
		transition: box-shadow var(--duration-normal) var(--ease-out);
	}

	.endpoint-card.expanded {
		box-shadow: var(--shadow-md);
	}

	.endpoint-header {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		width: 100%;
		padding: var(--space-md) var(--space-lg);
		background: transparent;
		color: var(--text-primary);
		font-size: 0.85rem;
		text-align: left;
	}

	.endpoint-header:hover {
		background: var(--glass-hover);
	}

	.method-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 54px;
		padding: 3px 10px;
		border-radius: var(--radius-sm);
		font-size: 0.68rem;
		font-weight: 800;
		letter-spacing: 0.05em;
		color: white;
		flex-shrink: 0;
	}

	.endpoint-path {
		font-family: var(--font-mono);
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.endpoint-summary {
		flex: 1;
		font-size: 0.8rem;
		color: var(--text-tertiary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.expand-icon {
		flex-shrink: 0;
		color: var(--text-tertiary);
		transition: transform var(--duration-fast) var(--ease-out);
	}

	.expand-icon.rotated {
		transform: rotate(180deg);
	}

	/* ── Endpoint body ────────────────────────────── */
	.endpoint-body {
		padding: 0 var(--space-lg) var(--space-xl);
		animation: fadeIn var(--duration-normal) var(--ease-out);
	}

	.endpoint-desc {
		font-size: 0.85rem;
		color: var(--text-secondary);
		margin-bottom: var(--space-lg);
		line-height: 1.6;
	}

	.endpoint-section {
		margin-top: var(--space-xl);
	}

	.endpoint-section h4 {
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-tertiary);
		margin-bottom: var(--space-md);
	}

	/* ── Tables ────────────────────────────────────── */
	.param-table, .status-table {
		overflow-x: auto;
		border-radius: var(--radius-md);
		border: 1px solid var(--glass-border);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
	}

	thead {
		background: var(--bg-elevated);
	}

	th {
		padding: 8px 14px;
		font-weight: 600;
		text-align: left;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-tertiary);
		border-bottom: 1px solid var(--glass-border);
	}

	td {
		padding: 8px 14px;
		border-bottom: 1px solid var(--glass-border);
		color: var(--text-secondary);
	}

	tr:last-child td {
		border-bottom: none;
	}

	td code {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		padding: 1px 5px;
		border-radius: 3px;
		background: var(--bg-elevated);
		color: var(--text-accent);
	}

	.param-in {
		font-size: 0.7rem;
		font-weight: 600;
		padding: 1px 6px;
		border-radius: var(--radius-full);
		background: rgba(99, 102, 241, 0.1);
		color: var(--accent-indigo);
	}

	/* ── Status badges ─────────────────────────────── */
	.status-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 36px;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.72rem;
		font-weight: 700;
		font-family: var(--font-mono);
	}

	.s2xx {
		background: rgba(16, 185, 129, 0.15);
		color: var(--accent-emerald);
	}

	.s4xx {
		background: rgba(245, 158, 11, 0.15);
		color: var(--accent-amber);
	}

	.s5xx {
		background: rgba(239, 68, 68, 0.15);
		color: #ef4444;
	}

	/* ── Response blocks ───────────────────────────── */
	.response-block {
		margin-bottom: var(--space-md);
	}

	.response-status {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		margin-bottom: var(--space-sm);
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	/* ── Code blocks ───────────────────────────────── */
	.code-block {
		margin: var(--space-md) 0;
		border-radius: var(--radius-md);
		overflow: hidden;
		border: 1px solid var(--glass-border);
		background: var(--bg-base);
	}

	.code-block-header {
		padding: 6px 14px;
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-tertiary);
		background: var(--bg-elevated);
		border-bottom: 1px solid var(--glass-border);
	}

	.code-block pre {
		margin: 0;
		padding: var(--space-md) var(--space-lg);
		overflow-x: auto;
	}

	.code-block code {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		line-height: 1.6;
		color: var(--text-primary);
		white-space: pre;
	}

	/* ── Code tabs ──────────────────────────────────── */
	.code-tabs {
		display: flex;
		gap: 2px;
		margin-bottom: 0;
		border-radius: var(--radius-md) var(--radius-md) 0 0;
		overflow: hidden;
		background: var(--bg-elevated);
		border: 1px solid var(--glass-border);
		border-bottom: none;
	}

	.code-tab {
		padding: 8px 16px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-tertiary);
		background: transparent;
		border-radius: 0;
		transition: all var(--duration-fast) var(--ease-out);
	}

	.code-tab:hover {
		color: var(--text-primary);
		background: var(--glass-hover);
	}

	.code-tab.active {
		color: var(--accent-indigo);
		background: var(--bg-base);
		box-shadow: inset 0 -2px 0 var(--accent-indigo);
	}

	.code-tabs + .code-block {
		border-top-left-radius: 0;
		border-top-right-radius: 0;
		margin-top: 0;
	}

	.code-tabs + .code-block .code-block-header {
		display: none;
	}

	/* ── Loading & Error ───────────────────────────── */
	.docs-loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 60vh;
		gap: var(--space-lg);
		color: var(--text-tertiary);
	}

	.loading-spinner {
		width: 32px;
		height: 32px;
		border: 3px solid var(--glass-border);
		border-top-color: var(--accent-indigo);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}

	.docs-error {
		max-width: 500px;
		margin: 15vh auto;
		padding: var(--space-2xl);
		text-align: center;
		border-radius: var(--radius-lg);
	}

	.error-icon { font-size: 2rem; }

	/* ── Responsive ────────────────────────────────── */
	@media (max-width: 768px) {
		.docs-header-center { display: none; }

		.btn-sidebar-toggle { display: flex; }
		.btn-spec span { display: none; }

		.docs-sidebar {
			position: fixed;
			top: 64px;
			left: 0;
			bottom: 0;
			z-index: 150;
			width: 260px;
			transform: translateX(-100%);
			transition: transform var(--duration-normal) var(--ease-out);
			background: var(--bg-surface);
			backdrop-filter: blur(24px);
			border-right: 1px solid var(--glass-border);
		}

		.docs-sidebar.open {
			transform: translateX(0);
		}

		.docs-main {
			padding: var(--space-lg);
		}

		.endpoint-header {
			flex-wrap: wrap;
		}

		.endpoint-summary {
			width: 100%;
			margin-top: var(--space-xs);
		}
	}
</style>
