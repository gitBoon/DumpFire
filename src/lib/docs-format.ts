/**
 * docs-format.ts — how the /docs page draws what the OpenAPI document says.
 *
 * The page is drawn from `/api/v1/openapi.json`. That document is written by
 * hand, in plain text with three marks in it: a line break, `backticks` round
 * a name, and `**` round a heading. The page used to draw each description as
 * one plain paragraph, so the breaks were lost and the marks were shown as
 * they are typed.
 *
 * `formatDescription` turns such a text into HTML for the page to draw with
 * `{@html}`. The document is public and anyone may be handed a copy of the
 * page drawn from another, so nothing in a description is trusted: the text
 * is escaped first, whole, and only then are the three marks read. No tag can
 * come out of it but `<code>`, `<strong>` and `<br>`, and those only from the
 * marks. Nothing else is interpreted: no links, no headings, no single `*`.
 *
 * The rest is what the page's code samples are made of, kept here so that it
 * can be tested without a browser: a request body as a Python literal, the
 * name a sample saves a file under, and the three samples themselves.
 *
 * The escaping is `escapeHtml` in `escape-html.ts`, the one function the mails
 * use too.
 */

import { escapeHtml } from '$lib/escape-html';

/** Where a `code` span is held while `**` is read, so that nothing inside it is. Never in a text: both are stripped first. */
const HELD_OPEN = '\uE000';
const HELD_CLOSE = '\uE001';

/**
 * A description from the document as HTML that is safe to draw with `{@html}`.
 *
 * The text is escaped, and then exactly three rules are applied, in this order:
 *
 *   1. `` `text` `` on one line becomes `<code>text</code>`. Nothing inside it
 *      is read further: `` `**` `` is the two asterisks, in code.
 *   2. `**text**` on one line, with no `*` inside it, becomes
 *      `<strong>text</strong>`. It may hold a code span.
 *   3. A line break becomes `<br>`.
 *
 * A mark with no partner is drawn as it is typed. Nothing and null are ''.
 */
export function formatDescription(text: string | null | undefined): string {
	if (text === null || text === undefined || text === '') return '';

	const escaped = escapeHtml(String(text)).split(HELD_OPEN).join('').split(HELD_CLOSE).join('');

	const code: string[] = [];
	const withoutCode = escaped.replace(/`([^`\r\n]+)`/g, (_match, inner: string) => {
		code.push(inner);
		return `${HELD_OPEN}${code.length - 1}${HELD_CLOSE}`;
	});

	const withBold = withoutCode.replace(/\*\*([^*\r\n]+)\*\*/g, (_match, inner: string) => `<strong>${inner}</strong>`);

	return withBold
		.replace(new RegExp(`${HELD_OPEN}(\\d+)${HELD_CLOSE}`, 'g'), (_match, index: string) => `<code>${code[Number(index)] ?? ''}</code>`)
		.replace(/\r\n|\r|\n/g, '<br>');
}

/** What a parameter or a field may be, as the page shows it: its enum values if it has them, and otherwise its type. */
export function typeLabel(schema: { type?: string | string[]; enum?: unknown[] } | null | undefined): string {
	if (!schema) return 'any';
	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(String).join(' | ');
	if (Array.isArray(schema.type)) return schema.type.join(' | ');
	return schema.type || 'any';
}

/**
 * A JSON value as a Python literal: `true`, `false` and `null` are `True`,
 * `False` and `None`, and everything else is written as JSON writes it, which
 * Python reads the same way. A word inside a string is left alone.
 *
 * `indent` is one level, and `at` is what the line the value starts on is
 * already indented by.
 */
export function pythonLiteral(value: unknown, indent = '    ', at = ''): string {
	if (value === null || value === undefined) return 'None';
	if (value === true) return 'True';
	if (value === false) return 'False';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
	if (typeof value === 'string') return JSON.stringify(value);

	const inner = at + indent;
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		return `[\n${value.map((item) => inner + pythonLiteral(item, indent, inner)).join(',\n')}\n${at}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return '{}';
		return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${pythonLiteral(item, indent, inner)}`).join(',\n')}\n${at}}`;
	}
	return 'None';
}

/**
 * The file a sample saves an operation's answer to, or '' for an operation
 * whose success is JSON.
 *
 * `responses` is the operation's responses by status, each resolved. The first
 * success that has a body and no JSON one decides: `application/pdf` is saved
 * as `answer.pdf`. A sample that parsed such an answer as JSON would fail.
 */
export function answerFile(responses: Record<string, { content?: Record<string, unknown> } | null | undefined> | null | undefined): string {
	for (const [status, response] of Object.entries(responses ?? {})) {
		if (!status.startsWith('2')) continue;
		const types = Object.keys(response?.content ?? {});
		if (types.length === 0 || types.some((type) => type.toLowerCase().includes('json'))) continue;
		const subtype = types[0].split(';')[0].split('/')[1] ?? '';
		return `answer.${/^[a-z0-9]{1,8}$/i.test(subtype) ? subtype.toLowerCase() : 'bin'}`;
	}
	return '';
}

/** What a sample is made from. */
export type Sample = {
	/** The method, in lower case as the document has it. */
	method: string;
	/** The path, with its `{parameters}`. */
	path: string;
	/** Whether the operation needs a key. */
	keyed: boolean;
	/** The example of the request body as JSON text, or '' when the operation takes none. */
	body: string;
	/** The file the answer is saved to, from `answerFile`, or '' when the answer is JSON. */
	saveAs: string;
};

/** The request as a curl command. */
export function curlSample({ method, path, keyed, body, saveAs }: Sample): string {
	const upper = method.toUpperCase();
	let command = 'curl -s';
	if (upper !== 'GET') command += ` -X ${upper}`;
	if (keyed) command += ' \\\n  -H "Authorization: Bearer $API_KEY"';
	if (body) {
		command += ' \\\n  -H "Content-Type: application/json"';
		command += ` \\\n  -d '${body}'`;
	}
	if (saveAs) command += ` \\\n  -o ${saveAs}`;
	command += ` \\\n  "$BASE_URL${path.replace(/\{(\w+)\}/g, ':$1')}"`;
	return command;
}

/** The request in Python, with `requests`. The body is a Python literal, and an answer that is a file is written to one. */
export function pythonSample({ method, path, keyed, body, saveAs }: Sample): string {
	let code = 'import requests\n\n';
	if (keyed) code += 'API_KEY = "df_your_key"\n';
	code += 'BASE = "https://your-instance.com"\n';
	if (keyed) code += 'HEADERS = {"Authorization": f"Bearer {API_KEY}"}\n';
	code += '\n';

	const url = `f"{BASE}${path}"`;
	const headers = keyed ? ', headers=HEADERS' : '';
	if (method === 'get' || (method === 'delete' && !body)) {
		code += `resp = requests.${method}(${url}${headers})\n`;
	} else {
		// requests has a function for each of these; anything else is shown as a POST.
		const call = ['delete', 'put', 'patch'].includes(method) ? method : 'post';
		let literal = '{}';
		if (body) {
			try {
				literal = pythonLiteral(JSON.parse(body), '    ', '    ');
			} catch {
				// Not JSON after all: shown as it is.
				literal = body;
			}
		}
		code += `resp = requests.${call}(\n    ${url},\n${keyed ? '    headers=HEADERS,\n' : ''}    json=${literal}\n)\n`;
	}

	code += saveAs ? `with open("${saveAs}", "wb") as f:\n    f.write(resp.content)` : 'print(resp.json())';
	return code;
}

/** The request in PowerShell. An answer that is a file is saved with -OutFile. */
export function powershellSample({ method, path, keyed, body, saveAs }: Sample): string {
	const uri = `"$Base${path.replace(/\{(\w+)\}/g, (_match, name: string) => `$${name}`)}"`;
	const headers = keyed ? ' -Headers $Headers' : '';
	const out = saveAs ? ` -OutFile "${saveAs}"` : '';
	let code = keyed ? '$Headers = @{ "Authorization" = "Bearer $ApiKey" }\n' : '';

	if (method === 'get') return `${code}Invoke-RestMethod -Uri ${uri}${headers}${out}`;

	const verb = method.charAt(0).toUpperCase() + method.slice(1);
	if (!body) return `${code}Invoke-RestMethod -Method ${verb} -Uri ${uri}${headers}${out}`;

	if (keyed) code += '$Headers["Content-Type"] = "application/json"\n';
	code += `$Body = '${body}'\n`;
	return `${code}Invoke-RestMethod -Method ${verb} -Uri ${uri}${keyed ? headers : ' -ContentType "application/json"'} -Body $Body${out}`;
}
