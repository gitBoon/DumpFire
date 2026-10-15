/**
 * How the /docs page draws what the OpenAPI document says.
 *
 * The page is drawn from `/api/v1/openapi.json`, and it drew that document's
 * text wrongly in five ways:
 *
 *   - `info.description`, which holds the failure rules, the rule for a body,
 *     the dated note of what changed and the answers that are not JSON,
 *     was drawn nowhere.
 *   - Every description was drawn as one plain paragraph: its line breaks were
 *     lost, and its `backticks` and `**asterisks**` were shown as typed.
 *   - The Python sample pasted the request body as JSON, so `true`, `false`
 *     and `null` were names Python does not have.
 *   - The samples for the one operation that answers a file ended by parsing
 *     the PDF as JSON.
 *   - A parameter's allowed values were not shown.
 *
 * What draws the text is in `src/lib/docs-format.ts`, so that it can be
 * called here: these tests have no browser and no DOM. What the page does
 * with it cannot be run, so, as `tests/page-failures.test.ts` does, the page
 * is read as source: its script with the TypeScript compiler, and its markup
 * for every place it draws HTML.
 *
 * It needs no database. `tests/setup.ts` still runs, as it does for every file.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
	answerFile,
	curlSample,
	formatDescription,
	powershellSample,
	pythonLiteral,
	pythonSample,
	typeLabel,
	type Sample
} from '$lib/docs-format';
import { escapeHtml } from '$lib/escape-html';
import { api } from './helpers/api';

const ROOT = process.cwd();
const PAGE = 'src/routes/docs/+page.svelte';

/** The document, as the page is given it. */
const spec: any = (await api('GET', '/api/v1/openapi.json')).body;

/** Every tag in a piece of HTML, as it is written: `<code>`, `</strong>`, `<br>`. */
const tagsIn = (html: string) => html.match(/<[^>]*>/g) ?? [];

/** The only tags `formatDescription` may write. */
const ALLOWED = ['<code>', '</code>', '<strong>', '</strong>', '<br>'];

describe('formatDescription', () => {
	it('escapes the five characters HTML reads as markup', () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
		expect(formatDescription('one that is not "Bearer <key>", security & compliance')).toBe(
			'one that is not &quot;Bearer &lt;key&gt;&quot;, security &amp; compliance'
		);
		// What is already an entity is text too, and is escaped again.
		expect(formatDescription('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
	});

	it('draws a description that holds <script> as text, wherever it is put', () => {
		const attack = '<script>alert(1)</script>';
		const inert = '&lt;script&gt;alert(1)&lt;/script&gt;';

		expect(formatDescription(attack)).toBe(inert);
		expect(formatDescription(`\`${attack}\``)).toBe(`<code>${inert}</code>`);
		expect(formatDescription(`**${attack}**`)).toBe(`<strong>${inert}</strong>`);
		expect(formatDescription(`a\n${attack}\nb`)).toBe(`a<br>${inert}<br>b`);

		for (const text of [
			attack,
			'<img src=x onerror=alert(1)>',
			'`<img src=x onerror=alert(1)>`',
			'**<svg onload=alert(1)>**',
			'<code onclick="alert(1)">x</code>',
			'</code><script>alert(1)</script>',
			'`a` <iframe src="javascript:alert(1)"></iframe> **b**'
		]) {
			const html = formatDescription(text);
			// Nothing but the three tags it writes itself, none of them with an attribute. What was
			// typed as a tag is still there to be read, as text: `onerror=` between `&lt;` and `&gt;`.
			for (const tag of tagsIn(html)) expect(ALLOWED).toContain(tag);
			expect(html).not.toMatch(/<script|<img|<svg|<iframe|<code /i);
		}
	});

	it('applies its three rules: backticks are code, double asterisks are bold, a line break is a line break', () => {
		expect(formatDescription('Send `links` or `chain`.')).toBe('Send <code>links</code> or <code>chain</code>.');
		expect(formatDescription('**All or nothing.** The whole batch is checked.')).toBe('<strong>All or nothing.</strong> The whole batch is checked.');
		expect(formatDescription('one\ntwo\n\nthree')).toBe('one<br>two<br><br>three');
		expect(formatDescription('one\r\ntwo')).toBe('one<br>two');
		// All three at once, and bold round a code span.
		expect(formatDescription('**Limits.** `tokens` is not 0.\nWith `apiCalls`, more.')).toBe(
			'<strong>Limits.</strong> <code>tokens</code> is not 0.<br>With <code>apiCalls</code>, more.'
		);
		expect(formatDescription('**The `message` key**')).toBe('<strong>The <code>message</code> key</strong>');
	});

	it('reads nothing inside a code span, and nothing across a line', () => {
		expect(formatDescription('`**not bold**`')).toBe('<code>**not bold**</code>');
		expect(formatDescription('`dependsOn*` and `blocks*`')).toBe('<code>dependsOn*</code> and <code>blocks*</code>');
		expect(formatDescription('**one\ntwo**')).toBe('**one<br>two**');
		expect(formatDescription('`one\ntwo`')).toBe('`one<br>two`');
	});

	it('interprets nothing else: a mark with no partner, a single asterisk, a link, a heading and a tag are drawn as typed', () => {
		for (const text of [
			'a ` alone',
			'a ** alone',
			'the dependsOn*/blocks* fields',
			'*emphasis* and _emphasis_',
			'[a link](https://example.com)',
			'# A heading',
			'- a list item',
			'1. a numbered item',
			'~~struck~~',
			'a | table | row',
			'``',
			'****'
		]) {
			expect(formatDescription(text)).toBe(text);
		}
		expect(formatDescription('> quoted, <b>bold</b>')).toBe('&gt; quoted, &lt;b&gt;bold&lt;/b&gt;');
		expect(formatDescription('![alt](x.png)')).toBe('![alt](x.png)');
	});

	it('gives nothing for nothing', () => {
		expect(formatDescription(undefined)).toBe('');
		expect(formatDescription(null)).toBe('');
		expect(formatDescription('')).toBe('');
	});

	it('cannot be made to draw a code span that was not typed, by a text that holds its own markers', () => {
		// The characters a code span is held under while bold is read are stripped from the text first.
		expect(formatDescription('\uE0000\uE001 and `real`')).toBe('0 and <code>real</code>');
		expect(formatDescription('\uE0007\uE001')).toBe('7');
	});

	it('draws every description of the real document with those three tags and no other', () => {
		const descriptions: string[] = [];
		const collect = (node: any) => {
			if (node === null || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node)) {
				if (key === 'description' && typeof value === 'string') descriptions.push(value);
				else collect(value);
			}
		};
		collect(spec);

		// The document has the three marks, or this test asks nothing: over 800 descriptions when it was
		// written, of which 19 had a line break, 7 had bold and 74 had backticks.
		expect(descriptions.length).toBeGreaterThan(500);
		expect(descriptions.filter((d) => d.includes('\n')).length).toBeGreaterThan(10);
		expect(descriptions.filter((d) => d.includes('**')).length).toBeGreaterThan(3);
		expect(descriptions.filter((d) => d.includes('`')).length).toBeGreaterThan(10);

		const faults: string[] = [];
		for (const description of descriptions) {
			const html = formatDescription(description);
			for (const tag of tagsIn(html)) if (!ALLOWED.includes(tag)) faults.push(`${tag} in: ${description.slice(0, 60)}`);
			// Every mark that had a partner was read: no backtick is left, and no pair of asterisks.
			if (html.includes('`')) faults.push(`a backtick is left in: ${description.slice(0, 60)}`);
			if (/\*\*[^*<]+\*\*/.test(html)) faults.push(`bold is left unread in: ${description.slice(0, 60)}`);
			if (/[\r\n]/.test(html)) faults.push(`a line break is left in: ${description.slice(0, 60)}`);
		}
		expect(faults).toEqual([]);

		// The document's description of itself is drawn in full: its headings bold, its names in code.
		const overview = formatDescription(spec.info.description);
		expect(overview).toContain('<strong>Failures.</strong>');
		expect(overview).toContain('<strong>Changed on 2026-10-14 (version 1.2.0).</strong>');
		expect(overview).toContain('<strong>Changed on 2026-10-13 (version 1.1.0).</strong>');
		expect(overview).toContain('<code>message</code>');
		expect(overview).toContain('<br><br>');
	});
});

describe('what the samples are made of', () => {
	it('typeLabel shows the allowed values of a parameter or a field that has them, and otherwise its type', () => {
		expect(typeLabel({ type: 'string', enum: ['blocked-by', 'blocks', 'both'] })).toBe('blocked-by | blocks | both');
		expect(typeLabel({ type: 'integer' })).toBe('integer');
		expect(typeLabel({ type: ['integer', 'null'] })).toBe('integer | null');
		expect(typeLabel({})).toBe('any');
		expect(typeLabel(undefined)).toBe('any');

		// The document has parameters with allowed values, and each is shown by them.
		const withEnum: string[] = [];
		for (const item of Object.values<any>(spec.paths)) {
			for (const op of Object.values<any>(item)) {
				for (const p of op.parameters ?? []) {
					if (Array.isArray(p.schema?.enum)) {
						withEnum.push(p.name);
						expect(typeLabel(p.schema)).toBe(p.schema.enum.join(' | '));
					}
				}
			}
		}
		expect(withEnum).toContain('direction');
		expect(withEnum.length).toBeGreaterThanOrEqual(4);
	});

	it('pythonLiteral writes true, false and null as Python does, and leaves a word in a string alone', () => {
		expect(pythonLiteral(true)).toBe('True');
		expect(pythonLiteral(false)).toBe('False');
		expect(pythonLiteral(null)).toBe('None');
		expect(pythonLiteral('true, false and null')).toBe('"true, false and null"');
		expect(pythonLiteral(12.5)).toBe('12.5');
		expect(pythonLiteral([])).toBe('[]');
		expect(pythonLiteral({})).toBe('{}');
		expect(pythonLiteral({ pinned: true, dueDate: null, title: 'It\'s "null"', tags: [false, 1] }, '  ')).toBe(
			['{', '  "pinned": True,', '  "dueDate": None,', '  "title": "It\'s \\"null\\"",', '  "tags": [', '    False,', '    1', '  ]', '}'].join('\n')
		);
	});

	it('pythonLiteral of every request example in the real document has no JSON true, false or null left outside a string', () => {
		const examples: unknown[] = [];
		for (const item of Object.values<any>(spec.paths)) {
			for (const op of Object.values<any>(item)) {
				const media = op.requestBody?.content?.['application/json'];
				if (media?.example !== undefined) examples.push(media.example);
				for (const example of Object.values<any>(media?.examples ?? {})) examples.push(example.value);
			}
		}
		expect(examples.length).toBeGreaterThan(30);
		// The document has examples that hold one of the three, or this asks nothing.
		expect(examples.filter((e) => /\b(true|false|null)\b/.test(JSON.stringify(e).replace(/"(?:[^"\\]|\\.)*"/g, '""'))).length).toBeGreaterThan(0);

		for (const example of examples) {
			const outsideStrings = pythonLiteral(example).replace(/"(?:[^"\\]|\\.)*"/g, '""');
			expect(outsideStrings).not.toMatch(/\b(true|false|null)\b/);
		}
	});

	const sample = (over: Partial<Sample> = {}): Sample => ({ method: 'put', path: '/api/v1/cards/{cardId}', keyed: true, body: '', saveAs: '', ...over });

	it('the Python sample sends the body as a Python literal', () => {
		const code = pythonSample(sample({ body: JSON.stringify({ pinned: true, archivedAt: null, title: 'not null' }, null, 2) }));

		expect(code).toContain('requests.put(');
		expect(code).toContain('"pinned": True');
		expect(code).toContain('"archivedAt": None');
		expect(code).toContain('"title": "not null"');
		expect(code).not.toMatch(/: (true|false|null)\b/);
		expect(code.endsWith('print(resp.json())')).toBe(true);
		// And a request with no body is as it was.
		expect(pythonSample(sample({ method: 'get' }))).toContain('resp = requests.get(f"{BASE}/api/v1/cards/{cardId}", headers=HEADERS)\nprint(resp.json())');
	});

	it('answerFile names a file for an operation whose success is not JSON, and none for one whose success is', () => {
		expect(answerFile({ '200': { content: { 'application/pdf': {} } }, '404': { content: { 'application/json': {} } } })).toBe('answer.pdf');
		expect(answerFile({ '200': { content: { 'application/json': {} } } })).toBe('');
		expect(answerFile({ '204': {}, '400': { content: { 'text/plain': {} } } })).toBe('');
		expect(answerFile({ '200': { content: { 'application/vnd.ms-excel; charset=x': {} } } })).toBe('answer.bin');
		expect(answerFile(undefined)).toBe('');

		// In the real document that is one operation: the plan of a milestone as a PDF.
		const files: string[] = [];
		for (const [path, item] of Object.entries<any>(spec.paths)) {
			for (const [method, op] of Object.entries<any>(item)) {
				// A response that is a $ref is one of the shared failures: none of them is a success.
				const responses = Object.fromEntries(Object.entries<any>(op.responses).filter(([, r]) => !r.$ref));
				if (answerFile(responses)) files.push(`${method.toUpperCase()} ${path}: ${answerFile(responses)}`);
			}
		}
		expect(files).toEqual(['GET /api/v1/milestones/{milestoneId}/pdf: answer.pdf']);
	});

	it('the samples of an operation that answers a file save it, and none of them parses it as JSON', () => {
		const pdf = sample({ method: 'get', path: '/api/v1/milestones/{milestoneId}/pdf', saveAs: 'answer.pdf' });

		const curl = curlSample(pdf);
		expect(curl).toContain('-o answer.pdf');
		expect(curl.endsWith('"$BASE_URL/api/v1/milestones/:milestoneId/pdf"')).toBe(true);

		const python = pythonSample(pdf);
		expect(python).not.toContain('.json()');
		expect(python.endsWith('with open("answer.pdf", "wb") as f:\n    f.write(resp.content)')).toBe(true);

		const powershell = powershellSample(pdf);
		expect(powershell).toBe('$Headers = @{ "Authorization" = "Bearer $ApiKey" }\nInvoke-RestMethod -Uri "$Base/api/v1/milestones/$milestoneId/pdf" -Headers $Headers -OutFile "answer.pdf"');

		// An operation that answers JSON is given none of that.
		const json = sample({ method: 'get' });
		expect(curlSample(json)).not.toContain(' -o ');
		expect(powershellSample(json)).not.toContain('-OutFile');
		expect(pythonSample(json)).not.toContain('open(');
	});

	it('the samples are otherwise what the page drew before: a body, a key, and the one operation that needs none', () => {
		const body = '{\n  "title": "Review"\n}';
		expect(curlSample(sample({ method: 'post', path: '/api/v1/boards/{boardId}/columns', body }))).toBe(
			`curl -s -X POST \\\n  -H "Authorization: Bearer $API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${body}' \\\n  "$BASE_URL/api/v1/boards/:boardId/columns"`
		);
		expect(powershellSample(sample({ method: 'delete', path: '/api/v1/cards/{cardId}' }))).toBe(
			'$Headers = @{ "Authorization" = "Bearer $ApiKey" }\nInvoke-RestMethod -Method Delete -Uri "$Base/api/v1/cards/$cardId" -Headers $Headers'
		);
		expect(powershellSample(sample({ method: 'post', path: '/api/v1/boards', body }))).toBe(
			`$Headers = @{ "Authorization" = "Bearer $ApiKey" }\n$Headers["Content-Type"] = "application/json"\n$Body = '${body}'\nInvoke-RestMethod -Method Post -Uri "$Base/api/v1/boards" -Headers $Headers -Body $Body`
		);
		// No key: no header, in any of the three.
		const open = sample({ method: 'get', path: '/api/v1/openapi.json', keyed: false });
		expect(curlSample(open)).toBe('curl -s \\\n  "$BASE_URL/api/v1/openapi.json"');
		expect(pythonSample(open)).not.toContain('HEADERS');
		expect(powershellSample(open)).toBe('Invoke-RestMethod -Uri "$Base/api/v1/openapi.json"');
	});
});

// ─── The page itself ─────────────────────────────────────────────────────────

/** A Svelte file's `<script lang="ts">`, parsed, and everything between the script and the style: its markup. */
function partsOf(file: string, source = readFileSync(join(ROOT, file), 'utf8')): { script: ts.SourceFile; markup: string } {
	const script = /<script lang="ts">([\s\S]*?)<\/script>/.exec(source);
	if (!script) throw new Error(`${file} has no <script lang="ts">`);
	const markup = source.slice(script.index + script[0].length).replace(/<style>[\s\S]*<\/style>/, '');
	return { script: ts.createSourceFile(file, script[1], ts.ScriptTarget.Latest, true), markup };
}

/** The names a script imports from `module`. */
function importedFrom(script: ts.SourceFile, module: string): string[] {
	const names: string[] = [];
	for (const statement of script.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== module) continue;
		const named = statement.importClause?.namedBindings;
		if (named && ts.isNamedImports(named)) names.push(...named.elements.map((element) => element.name.text));
	}
	return names;
}

/** The text of the function declared as `name` at the top of a script, or '' if there is none. */
function functionText(script: ts.SourceFile, name: string): string {
	const found = script.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
	return found ? found.getText(script) : '';
}

describe('the /docs page', () => {
	const { script, markup } = partsOf(PAGE);

	it('draws HTML only through formatDescription, which escapes first', () => {
		expect(importedFrom(script, '$lib/docs-format')).toContain('formatDescription');

		const drawn = markup.match(/\{@html[^}]*\}/g) ?? [];
		// The overview, a group's description, an operation's, a parameter's, a field's and a response's.
		expect(drawn.length).toBeGreaterThanOrEqual(6);
		for (const expression of drawn) expect(expression).toMatch(/^\{@html formatDescription\([\w.?]+\)\}$/);
	});

	it('draws no description as plain text', () => {
		// `{op.description}` is a description put on the page as typed: its breaks lost, its marks shown.
		const plain = markup.match(/\{[^{}@#:/]*\.description\b[^{}]*\}/g) ?? [];
		expect(plain).toEqual([]);

		for (const drawn of ['tagInfo.description', 'op.description', 'p.description', 'f.description', 'resp.description']) {
			expect(markup).toContain(`{@html formatDescription(${drawn})}`);
		}
	});

	it('draws the document\'s description of itself, a paragraph at a time, and opens on it', () => {
		expect(functionText(script, 'overviewParagraphs')).toContain('spec?.info?.description');
		expect(markup).toMatch(/\{#if activeTag === '__overview'\}[\s\S]*\{#each overviewParagraphs\(\) as paragraph\}\s*<p>\{@html formatDescription\(paragraph\)\}<\/p>/);
		// A way to it from the sidebar, and the page's first view once the document is read.
		expect(markup).toContain("activeTag = '__overview'; sidebarOpen = false;");
		expect(script.getText()).toMatch(/if \(spec\?\.info\?\.description\) activeTag = '__overview';/);
	});

	it('shows a parameter\'s allowed values where it shows a field\'s: through typeLabel', () => {
		expect(importedFrom(script, '$lib/docs-format')).toContain('typeLabel');
		expect(markup).toMatch(/<td><code>\{typeLabel\(p\.schema \? resolveSchema\(p\.schema\) : undefined\)\}<\/code><\/td>/);
		expect(functionText(script, 'getRequestBodyFields')).toContain('typeLabel(resolved)');
		// And nowhere as its bare type.
		expect(markup).not.toContain('p.schema?.type');
	});

	it('makes its three samples in $lib/docs-format, from the operation\'s key, body and the file its answer is', () => {
		const imported = importedFrom(script, '$lib/docs-format');
		for (const name of ['curlSample', 'pythonSample', 'powershellSample', 'answerFile']) expect(imported).toContain(name);

		const made = functionText(script, 'sampleOf');
		expect(made).toContain('keyed: needsKey(op)');
		expect(made).toContain('body: getRequestExample(op)');
		expect(made).toMatch(/saveAs: answerFile\(responses\)/);
		// The responses it is given are resolved, so that a shared response is read as what it refers to.
		expect(made).toContain('resolveResponse(r)');

		expect(functionText(script, 'generateCurl')).toContain('curlSample(sampleOf(method, path, op))');
		expect(functionText(script, 'generatePython')).toContain('pythonSample(sampleOf(method, path, op))');
		expect(functionText(script, 'generatePowershell')).toContain('powershellSample(sampleOf(method, path, op))');
		// No sample is put together in the page any longer, where it cannot be tested.
		expect(script.getText()).not.toContain('resp.json()');
	});

	it('says which request needs no key', () => {
		expect(markup).not.toContain('All API requests require an API key');
		expect(markup).toMatch(/The one exception is <code>GET \/api\/v1\/openapi\.json<\/code>/);
		// Which is what the document says: one operation, with `security: []`.
		const open: string[] = [];
		for (const [path, item] of Object.entries<any>(spec.paths)) {
			for (const [method, op] of Object.entries<any>(item)) {
				if (Array.isArray(op.security) && op.security.length === 0) open.push(`${method.toUpperCase()} ${path}`);
			}
		}
		expect(open).toEqual(['GET /api/v1/openapi.json']);
	});
});
