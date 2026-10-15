/**
 * A card's description and its comments, drawn one way (cards 2202 and 2210,
 * `docs/planning/card-2162-colours-and-csp.md`, sections 9 and 10 and the
 * cross-plan ruling on mentions).
 *
 * Both were drawn with `DOMPurify.sanitize(marked(...))` and DOMPurify's own
 * defaults, which keep `style` attributes, `<style>` elements, any class, SVG,
 * forms and images from any address, so one editor's text could cover the
 * card window, restyle the page, ask for a password or tell another server who
 * opened the card. Mentions were made by rewriting the HTML, which broke an
 * email address's link, a title and an alt text. Now `src/lib/markdown.ts` is
 * the only way, and this file holds its rules.
 *
 * The suite has no browser, so each test hands the renderer a jsdom window,
 * the DOM DOMPurify itself recommends outside a browser (happy-dom is not
 * considered safe with it). jsdom is a devDependency used only here. The
 * suite's own environment is Node, which has no DOM: that is the "no DOM" case.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { JSDOM } from 'jsdom';
import { createMarkdownRenderer, isAttachmentAddress, renderMarkdown } from '$lib/markdown';
import { findMentions } from '$lib/mentions';
import { parseMentions } from '$lib/server/mentions';

// An address of its own, so that a failing assertion can print an element.
const win = new JSDOM('', { url: 'https://dumpfire.test/board/1' }).window as unknown as Window & typeof globalThis;
const render = createMarkdownRenderer(win);
const comment = (text: string) => render(text, { mentions: ['alice', 'bob', 'example'] });

/** The HTML, parsed back, to ask about its elements. */
function dom(html: string): HTMLElement {
	const box = win.document.createElement('div');
	box.innerHTML = html;
	return box;
}

/** Every attribute value of every element, `except` those of the elements given. */
function attributeValues(box: HTMLElement, except: Element[] = []): string[] {
	return Array.from(box.querySelectorAll('*'))
		.filter((el) => !except.includes(el))
		.flatMap((el) => Array.from(el.attributes).map((a) => a.value));
}

const chips = (box: HTMLElement) => Array.from(box.querySelectorAll('span.mention-chip')).map((s) => s.textContent);

// Addresses another server would be asked for: decision 12's refused forms.
const OUTSIDE = [
	'https://o.example/i.png',
	'http://o.example/i.png',
	'HTTPS://o.example/i.png',
	'//o.example/i.png',
	'/\\o.example/i.png',
	'\\\\o.example/i.png',
	'\\/o.example/i.png',
	'/\t/o.example/i.png',
	'\nhttps://o.example/i.png',
	'\u0000//o.example/i.png',
	' //o.example/i.png ',
	'ht\ttp://o.example/i.png',
	'http:o.example/i.png',
	'http:\\\\o.example/i.png',
	'ftp://o.example/i.png',
	'blob:https://o.example/1'
];
// The page's own origin (the window above), and a card attachment's address.
const ORIGIN = 'https://dumpfire.test';
const ATTACHMENT = '/api/cards/1/attachments/2';
// A card attachment, written as its path or as a full address on this origin.
const ATTACHMENTS = [ATTACHMENT, '/api/cards/12/attachments/345', ' /api/cards/1/attachments/2 ', '/api/cards/1/attach\tments/2', `${ORIGIN}${ATTACHMENT}`, `HTTPS://DUMPFIRE.TEST${ATTACHMENT}`, `${ORIGIN}:443${ATTACHMENT}`];
// Addresses that stay on this server but are no attachment: a picture there
// would make the viewer's browser call that route, as the viewer.
const OWN = [
	'/api/admin/export?1', '/api/events', '/api/attachments/1/file', 'x.png', '../x.png', './x.png', '?q', '#f',
	'/%2F/o.example/i.png', '/%5Co.example/i.png', '/x//o.example',
	'/api/cards/1/attachments', '/api/cards/1/attachments/2/', '/api/cards/1/attachments/2?x', '/api/cards/1/attachments/2#f',
	'/api/cards/x/attachments/2', '/api/cards/1/attachments/%32', 'api/cards/1/attachments/2', '/api/cards/1/attachments/2/../../../admin/export',
	`${ORIGIN}/api/admin/export`, `${ORIGIN}${ATTACHMENT}/../../../admin/export`, `${ORIGIN}${ATTACHMENT}?x`,
	`https://u:p@dumpfire.test${ATTACHMENT}`, `http://dumpfire.test${ATTACHMENT}`, `https://dumpfire.test:8443${ATTACHMENT}`
];

/** An HTML attribute value that reads as `value` once parsed. */
const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');

describe('isAttachmentAddress', () => {
	// Each outside form, with an attachment's path on the other host.
	const outside = OUTSIDE.map((v) => v.replace('/i.png', ATTACHMENT));

	it.each(outside.map((v) => [JSON.stringify(v), v]))('refuses %s, which a browser would fetch from elsewhere or by a scheme', (_label, value) => {
		expect(isAttachmentAddress(value, ORIGIN)).toBe(false);
	});

	it.each(OWN.map((v) => [JSON.stringify(v), v]))('refuses %s, which is on this server but no card attachment', (_label, value) => {
		expect(isAttachmentAddress(value, ORIGIN)).toBe(false);
	});

	it.each(ATTACHMENTS.map((v) => [JSON.stringify(v), v]))('keeps %s, a card attachment', (_label, value) => {
		expect(isAttachmentAddress(value, ORIGIN)).toBe(true);
	});

	it('keeps a full address only on the origin given, and the path with none', () => {
		expect(isAttachmentAddress(`https://o.example${ATTACHMENT}`, 'https://o.example')).toBe(true);
		expect(isAttachmentAddress(`${ORIGIN}${ATTACHMENT}`)).toBe(false);
		expect(isAttachmentAddress(`${ORIGIN}${ATTACHMENT}`, 'null')).toBe(false);
		expect(isAttachmentAddress(ATTACHMENT)).toBe(true);
	});

	it('refuses every other scheme, data: included (an image keeps a data: address apart from this)', () => {
		for (const v of ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'mailto:a@example.com']) expect(isAttachmentAddress(v, ORIGIN)).toBe(false);
	});
});

describe('what a description or comment may hold', () => {
	it('drops style: the <style> element with its content, and style attributes', () => {
		const a = render('<style>body{display:none}</style>x');
		expect(a).not.toContain('<style');
		expect(a).not.toContain('display:none');
		expect(render('<p style="position:fixed">x</p>')).toBe('<p>x</p>');
	});

	it('drops a class of the page’s own, and a typed mention chip; keeps a code block’s language', () => {
		expect(render('<div class="modal-overlay">x</div>')).toBe('<div>x</div>');
		expect(comment('<div class="mention-chip modal-overlay">x</div>')).toBe('<div>x</div>');
		// The typed span loses its class; the chip inside it is the renderer's own.
		expect(comment('<span class="mention-chip">@nobody</span>')).toBe('<p><span><span class="mention-chip">@nobody</span></span></p>\n');
		const code = dom(render('```js\nlet a = 1;\n```'));
		expect(code.querySelector('pre > code')?.getAttribute('class')).toBe('language-js');
		expect(render('<code class="language-ts modal-overlay">x</code>')).toContain('<code class="language-ts">x</code>');
	});

	it('draws an outside image as a link to its address, fetching nothing', () => {
		// A NUL in HTML is read as U+FFFD, which makes a path here, and DOMPurify
		// itself drops a blob: src: both are below.
		for (const address of OUTSIDE.filter((a) => !a.startsWith('\u0000') && !a.startsWith('blob:'))) {
			const box = dom(render(`<img src="${attr(address)}" alt="a">`));
			expect(box.querySelector('img'), JSON.stringify(address)).toBeNull();
			const links = box.querySelectorAll('a');
			expect(links.length, JSON.stringify(address)).toBe(1);
			expect(links[0].textContent).toBe('🖼 a');
			expect(attributeValues(box, [links[0]]).join(' ')).not.toContain('o.example');
		}
		// The same written as Markdown.
		for (const address of ['https://o.example/i.png', '//o.example/i.png', 'HTTPS://o.example/i.png', 'http:o.example/i.png']) {
			const box = dom(render(`![a](${address})`));
			expect(box.querySelector('img'), address).toBeNull();
			expect(box.innerHTML).toContain(`<a href="${address}">🖼 a</a>`);
		}
		expect(render('<img src="blob:https://o.example/1" alt="a">')).toBe('<img alt="a">');
		// A path here, but no attachment: a link too.
		const nul = dom(render('<img src="&#0;//o.example/i.png" alt="a">'));
		expect(nul.querySelector('[src]')).toBeNull();
		expect(nul.querySelector('a')?.getAttribute('href')).toBe('\ufffd//o.example/i.png');
	});

	it('reads the address when the outside image has no alt text', () => {
		const box = dom(render('![](https://o.example/i.png)'));
		expect(box.querySelector('a')?.textContent).toBe('🖼 https://o.example/i.png');
		expect(box.querySelector('a')?.getAttribute('href')).toBe('https://o.example/i.png');
	});

	it('draws an outside image inside a link as its text alone, so links never nest', () => {
		const box = dom(render('[![a](https://o.example/i.png)](https://x.example)'));
		expect(box.querySelectorAll('a').length).toBe(1);
		expect(box.querySelector('a')?.getAttribute('href')).toBe('https://x.example');
		expect(box.querySelector('a')?.textContent).toBe('🖼 a');
		expect(box.querySelector('img')).toBeNull();
	});

	it('keeps a card attachment, as its path or a full address here, and a data: image', () => {
		for (const address of [ATTACHMENT, `${ORIGIN}${ATTACHMENT}`, 'data:image/png;base64,iVBORw0KGgo=']) {
			const box = dom(render(`![a](${address})`));
			expect(box.querySelector('img')?.getAttribute('src'), address).toBe(address);
			expect(box.querySelector('a'), address).toBeNull();
		}
	});

	it('draws any other image on this server as a link, so a picture cannot call a route as the viewer', () => {
		for (const address of ['/api/admin/export?1', '/api/events', '/api/attachments/1/file', 'x.png', '../x.png', `https://o.example${ATTACHMENT}`, `${ORIGIN}/api/admin/export`]) {
			const box = dom(render(`![](${address})`));
			expect(box.querySelector('img'), address).toBeNull();
			expect(box.querySelector('[src]'), address).toBeNull();
			expect(box.querySelector('a')?.getAttribute('href'), address).toBe(address);
			expect(box.querySelector('a')?.textContent, address).toBe(`🖼 ${address}`);
		}
		// Nor a video, an audio or their source: the address is removed.
		const media = render('<video src="/api/admin/export"></video><audio><source src="/api/events"></audio><video src="/api/cards/1/attachments/2"></video>');
		expect(media).not.toContain('/api/admin/export');
		expect(media).not.toContain('/api/events');
		expect(media).toContain(`<video src="${ATTACHMENT}">`);
	});

	it('drops the other attributes that fetch, and an outside src on anything but an image', () => {
		const html = render([
			`<img src="${ATTACHMENT}" srcset="https://o.example/a.png 2x">`,
			'<video src="https://o.example/v.mp4" poster="https://o.example/p.png"></video>',
			'<video><source src="https://o.example/v.mp4"></video>',
			'<audio src="//o.example/a.mp3"></audio>',
			'<table background="https://o.example/b.png"><tr><td>x</td></tr></table>',
			'<input type="image" src="https://o.example/i.png">'
		].join('\n'));
		expect(html).not.toContain('o.example');
		expect(html).not.toContain('srcset');
		expect(html).not.toContain('poster');
		expect(html).not.toContain('background');
		expect(dom(html).querySelector('img')?.getAttribute('src')).toBe(ATTACHMENT);
	});

	it('drops a dialog, which could cover the card window, open, asking to "sign in again"', () => {
		const box = dom(render('<dialog open><p>Your session has ended.</p><a href="https://o.example/login">Sign in again</a></dialog>'));
		expect(box.querySelector('dialog, [open]')).toBeNull();
	});

	it('drops a template, with what it holds', () => {
		const html = render('<template><img src="https://o.example/i.png" alt="a"></template>x');
		expect(html).not.toContain('<template');
		expect(dom(html).querySelector('img, [src]')).toBeNull();
	});

	it('drops an image map: its map, its areas and the image’s usemap', () => {
		const html = render(`<map name="m"><area shape="rect" coords="0,0,9999,9999" href="https://o.example/login" alt="x"></map><img src="${ATTACHMENT}" usemap="#m" alt="a">`);
		const box = dom(html);
		expect(box.querySelector('map, area, [usemap]')).toBeNull();
		expect(box.querySelector('img')?.getAttribute('src')).toBe(ATTACHMENT);
	});

	it('drops popover and the attributes that open one', () => {
		const html = render('<div popover="manual" id="p">Sign in again</div><a popovertarget="p" popovertargetaction="show">x</a><img usemap="#p" popover>');
		expect(html).not.toMatch(/popover|usemap/);
		expect(dom(html).textContent).toContain('Sign in again');
	});

	it('prefixes an id or a name, so none can stand for one of the page’s own', () => {
		const box = dom(render('<a id="modal" name="location">x</a>'));
		expect(box.querySelector('a')?.getAttribute('id')).toBe('user-content-modal');
		expect(box.querySelector('a')?.getAttribute('name')).toBe('user-content-location');
	});

	it('drops SVG and MathML', () => {
		const html = render('<svg><image href="https://o.example/i.png"/></svg>\n\n<math><mi>x</mi></math>');
		for (const s of ['<svg', '<image', '<math', '<mi', 'o.example']) expect(html).not.toContain(s);
	});

	it('draws a form and its controls as their text alone; keeps a task list’s disabled checkboxes', () => {
		const html = render([
			'<form action="https://o.example/steal"><label>Password <input type="password" name="p"></label><button>Sign in again</button></form>',
			'<select><option>One</option></select><textarea>Two</textarea><fieldset>Three</fieldset>',
			'<input type="checkbox"> <input type="text" value="x"> <input type="checkbox" disabled checked>'
		].join('\n'));
		const box = dom(html);
		expect(box.querySelector('form, button, select, option, textarea, fieldset, label')).toBeNull();
		expect(box.textContent).toContain('Sign in again');
		expect(box.textContent).toContain('One');
		expect(html).not.toContain('o.example');
		// Only the disabled checkbox stays.
		expect(Array.from(box.querySelectorAll('input')).map((i) => i.outerHTML)).toEqual(['<input type="checkbox" disabled="" checked="">']);

		const tasks = dom(render('- [x] done\n- [ ] to do'));
		const boxes = Array.from(tasks.querySelectorAll('input'));
		expect(boxes.length).toBe(2);
		for (const b of boxes) {
			expect(b.getAttribute('type')).toBe('checkbox');
			expect(b.hasAttribute('disabled')).toBe(true);
		}
		expect(boxes[0].hasAttribute('checked')).toBe(true);
	});

	it('still does what DOMPurify does: no handlers, no javascript: links, no scripts (a guard)', () => {
		expect(render('<img src=x onerror=alert(1)>')).not.toContain('onerror');
		// An image's address is made a link only once DOMPurify has accepted it.
		expect(render('<img src="javascript:alert(1)" alt="a">')).not.toContain('javascript');
		expect(render('<a href="javascript:alert(1)">x</a>')).toBe('<p><a>x</a></p>\n');
		const s = render('<script>alert(1)</script>x');
		expect(s).not.toContain('<script');
		expect(s).not.toContain('alert');
	});

	it('still renders Markdown as marked makes it (a guard)', () => {
		const box = dom(comment('# Head\n\n- one\n- two\n\n1. first\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://x.example) **bold** @alice'));
		expect(box.querySelector('h1')?.textContent).toBe('Head');
		expect(box.querySelectorAll('ul > li').length).toBe(2);
		expect(box.querySelector('ol > li')?.textContent).toBe('first');
		expect(box.querySelectorAll('table td').length).toBe(2);
		expect(box.querySelector('a')?.getAttribute('href')).toBe('https://x.example');
		expect(box.querySelector('strong')?.textContent).toBe('bold');
		expect(chips(box)).toEqual(['@alice']);
	});
});

describe('with no DOM', () => {
	const evil = '<style>body{display:none}</style><img src=x onerror=alert(1)> "q" & \'a\'';
	const escaped = '&lt;style&gt;body{display:none}&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &amp; &#39;a&#39;';

	it('a renderer made with no window gives the text back escaped, and does not throw', () => {
		expect(createMarkdownRenderer()(evil)).toBe(escaped);
		expect(createMarkdownRenderer()(evil, { mentions: ['alice'] })).toBe(escaped);
	});

	it('renderMarkdown, where there is no window (the suite’s Node environment), does the same', () => {
		expect(typeof window).toBe('undefined');
		const out = renderMarkdown(evil);
		expect(out).toBe(escaped);
		expect(out).not.toContain('<');
	});
});

describe('mentions are drawn in text, never in an attribute (card 2210)', () => {
	it('leaves an email address a working link', () => {
		for (const text of ['mail a@example.com', 'see <a@example.com>']) {
			const box = dom(comment(text));
			const links = box.querySelectorAll('a');
			expect(links.length, text).toBe(1);
			expect(links[0].getAttribute('href'), text).toBe('mailto:a@example.com');
			expect(links[0].textContent, text).toBe('a@example.com');
		}
	});

	it('leaves a link’s title and an image’s alt text as written', () => {
		const titled = comment('[x](https://x.example "ask @bob")');
		expect(titled).toContain('title="ask @bob"');
		expect(dom(titled).querySelector('a')?.getAttribute('title')).toBe('ask @bob');
		const own = comment(`![hi @bob](${ATTACHMENT})`);
		expect(dom(own).querySelector('img')?.getAttribute('alt')).toBe('hi @bob');
		const outside = dom(comment('![hi @bob](https://o.example/i.png)'));
		expect(outside.querySelector('a')?.textContent).toBe('🖼 hi @bob');
		expect(outside.querySelector('a')?.getAttribute('href')).toBe('https://o.example/i.png');
	});

	it('chips what the server mails: in code and in link text too, since those are mailed', () => {
		const code = dom(comment('`@decorator` and\n\n```ts\n@Component\n```'));
		expect(code.querySelector('p > code')?.textContent).toBe('@decorator');
		expect(code.querySelector('pre > code')?.textContent).toBe('@Component\n');
		expect(chips(code)).toEqual(['@decorator', '@Component']);
		const linked = dom(comment('[@alice](/u)'));
		expect(linked.querySelectorAll('a').length).toBe(1);
		expect(linked.querySelector('a > span.mention-chip')?.textContent).toBe('@alice');
		for (const text of ['`@decorator` and @alice', '[@alice](/u) **@Bob**', 'mail a@example.com', 'see <a@example.com> and @alice and @Alice']) {
			const drawn = [...new Set(chips(dom(comment(text))).map((c) => c!.slice(1).toLowerCase()))];
			expect(drawn, text).toEqual(parseMentions(text));
		}
	});

	it('draws a real mention as a chip, inside bold and before a full stop (a guard)', () => {
		const html = comment('**@alice** and @alice.');
		expect(html).toBe('<p><strong><span class="mention-chip">@alice</span></strong> and <span class="mention-chip">@alice</span>.</p>\n');
	});

	it('draws no chip in a description, which asks for none (a guard)', () => {
		expect(render('**@alice** and @alice.')).not.toContain('mention-chip');
	});
});

describe('one renderer and one mention rule (read from the source)', () => {
	const root = process.cwd();
	function files(dir: string, ext: RegExp): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
			const p = join(dir, e.name);
			return e.isDirectory() ? files(p, ext) : ext.test(e.name) ? [p] : [];
		});
	}
	const src = files(join(root, 'src'), /\.(ts|js|svelte)$/);
	const rel = (p: string) => relative(root, p).split(sep).join('/');

	it('only src/lib/markdown.ts imports marked or dompurify', () => {
		const importers = src.filter((f) => /from\s+['"](marked|dompurify)['"]|import\(\s*['"](marked|dompurify)['"]/.test(readFileSync(f, 'utf8'))).map(rel);
		expect(importers).toEqual(['src/lib/markdown.ts']);
	});

	it('every {@html} in a page draws renderMarkdown or formatDescription', () => {
		const offenders: string[] = [];
		for (const f of src.filter((p) => p.endsWith('.svelte'))) {
			const text = readFileSync(f, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '');
			for (const m of text.matchAll(/\{@html\s+([^}]*)/g)) {
				if (!/^(renderMarkdown|formatDescription)\(/.test(m[1].trim())) offenders.push(`${rel(f)}: ${m[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	// 3.4.3 fixed FORBID_TAGS; 3.4.16 and 3.4.17 the last of the advisories
	// `npm audit` listed on 2026-10-15 (none in what the renderer uses).
	it('package.json and the lock admit no dompurify below 3.4.17, and jsdom is for the tests only', () => {
		const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
		const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
		for (const version of [pkg.dependencies.dompurify, lock.packages[''].dependencies.dompurify, lock.packages['node_modules/dompurify'].version]) {
			const [major, minor, patch] = String(version).replace(/^[\^~]/, '').split('.').map(Number);
			expect(major, version).toBe(3);
			expect(minor * 1000 + patch, version).toBeGreaterThanOrEqual(4 * 1000 + 17);
		}
		expect(pkg.dependencies.jsdom).toBeUndefined();
		expect(pkg.devDependencies.jsdom).toBeDefined();
		expect(pkg.devDependencies['@types/jsdom']).toBeDefined();
	});

	it('the page and the server find mentions by findMentions alone', () => {
		const md = readFileSync(join(root, 'src/lib/markdown.ts'), 'utf8');
		expect(md).toMatch(/import \{ findMentions \} from '\$lib\/mentions';/);
		expect(md).not.toMatch(/\/@[^/]*\/[gimsuy]*/);
		const server = readFileSync(join(root, 'src/lib/server/mentions.ts'), 'utf8');
		expect(server).toContain('findMentions(');
		expect(server).not.toMatch(/\/@[^/]*\/[gimsuy]*/);
		expect(src.filter((f) => readFileSync(f, 'utf8').includes('highlightMentions')).map(rel)).toEqual([]);
	});

	it('parseMentions is findMentions’ names, lower-cased, each once', () => {
		const t = 'Hi @Alice, @bob and @alice; mail a@example.com';
		expect(findMentions(t).map((m) => t.slice(m.start, m.end))).toEqual(['@Alice', '@bob', '@alice', '@example']);
		expect(parseMentions(t)).toEqual([...new Set(findMentions(t).map((m) => m.username.toLowerCase()))]);
		expect(parseMentions(t)).toEqual(['alice', 'bob', 'example']);
	});
});
