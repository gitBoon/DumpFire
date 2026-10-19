/**
 * markdown.ts — the one way a card's description and its comments become HTML.
 *
 * Cards 2202 and 2210; the rules and why are in docs/authentication-security.md
 * ("Markdown in Descriptions and Comments"). This is the only module that
 * imports `marked` or `dompurify`; `tests/markdown.test.ts` holds that, and
 * holds every rule below.
 *
 * A description or comment is written by one person and drawn for everyone
 * who opens the card, so what it may hold is decided here:
 *
 * - marked turns the text into HTML and passes raw HTML through.
 * - DOMPurify, an instance of our own so these hooks reach nothing else, keeps
 *   its HTML profile (no SVG, no MathML) and drops:
 *   `<style>` with its content, which would restyle the whole page;
 *   the attributes `style` (an overlay drawn over the window), and `srcset`,
 *   `background` and `poster` (each fetches from wherever it names);
 *   forms and their controls (`form`, `button`, `select`, `option`,
 *   `textarea`, `fieldset`, `label`), drawn as their text alone, so a comment
 *   cannot ask everyone who opens the card to "sign in again";
 *   for the same reason `dialog` (an open one is drawn over the window) and
 *   the `popover`, `popovertarget` and `popovertargetaction` attributes;
 *   `template`, with what it holds, which the passes below would not reach;
 *   and image maps (`map`, `area`, `usemap`), whose areas cover a picture
 *   with links. An `id` or a `name` is prefixed `user-content-`
 *   (`SANITIZE_NAMED_PROPS`), so none can stand for one of the page's own.
 * - `class` keeps only `language-<name>`, which marked puts on a fenced code
 *   block. Any other class is one of the page's own (`modal-overlay` covers
 *   the window), so it goes.
 * - On DOMPurify's DOM, after it: every `input` goes but the disabled
 *   checkbox marked makes for a task list; a `src` stays only when it is a
 *   card attachment here (`isAttachmentAddress`) or a `data:` address where
 *   DOMPurify allowed one. Any other image, another site's or another address
 *   here, becomes a link to its address reading "🖼 " and its alt text, or the
 *   address when it has none, and so is not fetched; inside a link it becomes
 *   that text alone, so links never nest. Any other element's `src` is removed.
 * - Mentions, for a comment only: chips are made last, in text nodes only,
 *   with `createElement` and `textContent`, never HTML. Made before the
 *   sanitiser, a chip's HTML would land inside attributes (an email link's
 *   address, a title, an alt text) and break them, and a chip typed by hand
 *   would have to survive the class rule. Where a mention is is
 *   `findMentions` (`$lib/mentions`), the rule the server mails by, so for
 *   text written as text the page chips what the server mails, code and link
 *   text included, for the names it is given (card 2207: a name is a
 *   username, and the card window gives its board's people). The server
 *   reads the stored text, not this HTML, so the two differ where the text is
 *   written as HTML: a mention in an HTML comment, an attribute or a link's
 *   address is mailed and not chipped, and one written with an entity
 *   (`&#64;name`) is chipped and not mailed.
 *
 * With no DOM (a server render) nothing is cleaned, so nothing is rendered:
 * the text comes back HTML-escaped, and nothing throws.
 *
 * Text is stored exactly as written; these rules decide only what is drawn.
 * SQL 4 in docs/deployment.md ("The Update That Brings the
 * Content-Security-Policy") counts, on production, the stored text these rules
 * draw differently: change it with them.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { findMentions } from '$lib/mentions';

export type MarkdownOptions = {
	/**
	 * Draw @mentions as chips (comments). The names that may be mentioned:
	 * for the card window, its board's users. None, no chips (descriptions).
	 */
	mentions?: readonly string[];
};

export type MarkdownRenderer = (text: string, opts?: MarkdownOptions) => string;

/** What DOMPurify is told: its HTML profile, less what is described above. */
const SANITISE = {
	USE_PROFILES: { html: true },
	FORBID_TAGS: ['style', 'form', 'button', 'select', 'option', 'textarea', 'fieldset', 'label', 'dialog', 'template', 'map', 'area'],
	FORBID_ATTR: ['style', 'srcset', 'background', 'poster', 'popover', 'popovertarget', 'popovertargetaction', 'usemap'],
	SANITIZE_NAMED_PROPS: true,
	RETURN_DOM_FRAGMENT: true as const
};

/** The class tokens a description or comment may keep: marked's on a code block. */
const KEPT_CLASS = /^language-[^\s]+$/;

/** A card attachment's path: the one address here a picture may ask for. */
const ATTACHMENT_PATH = /^\/api\/cards\/\d+\/attachments\/\d+$/;

/**
 * Is `value`, as a `src`, a file attached to a card on this DumpFire? True for
 * the path `/api/cards/<id>/attachments/<id>`, exactly, and for a full
 * `http(s)` address whose origin is `origin` (the page's own) with that same
 * path and nothing more: no query, no fragment, no name or password. Read as
 * the browser's URL parser reads it: leading and trailing spaces and control
 * characters removed, tabs and new lines taken out.
 *
 * Nothing else is, wherever it points. An outside address (`//host`, `/\host`,
 * `HTTPS://host`, `ht<tab>tp://host`) tells another server who opened the card,
 * and when. Any other address here (`/api/admin/export`, `/api/events`,
 * `x.png`) would make the browser of everyone who opens the card call that
 * route, signed in as them.
 */
export function isAttachmentAddress(value: string, origin?: string): boolean {
	const v = value.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
	if (ATTACHMENT_PATH.test(v)) return true;
	if (!origin || origin === 'null' || !/^https?:\/\//i.test(v)) return false;
	try {
		const url = new URL(v);
		return url.origin === origin && !url.username && !url.password && !url.search && !url.hash && ATTACHMENT_PATH.test(url.pathname);
	} catch {
		return false;
	}
}

const isDataAddress = (value: string) => /^data:/i.test(value.replace(/^[\x00-\x20]+/, ''));

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** The text, HTML-escaped: what is drawn where there is no DOM to clean with. */
function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * A renderer for `win`, the window whose DOM it cleans with. With no window,
 * or one DOMPurify cannot use, it gives back the text HTML-escaped.
 */
export function createMarkdownRenderer(win?: Window & typeof globalThis): MarkdownRenderer {
	const purify = win ? DOMPurify(win) : undefined;
	if (!win || !purify?.isSupported) return (text) => escapeHtml(String(text ?? ''));
	const doc = win.document;
	const origin = win.location?.origin;

	purify.addHook('uponSanitizeAttribute', (_node, event) => {
		if (event.attrName !== 'class') return;
		const kept = event.attrValue.split(/\s+/).filter((token) => KEPT_CLASS.test(token));
		if (kept.length) event.attrValue = kept.join(' ');
		else event.keepAttr = false;
	});

	/** After DOMPurify: inputs, addresses and other images, as the header says. */
	function clean(root: DocumentFragment) {
		for (const input of Array.from(root.querySelectorAll('input'))) {
			if (input.getAttribute('type')?.toLowerCase() !== 'checkbox' || !input.hasAttribute('disabled')) input.remove();
		}
		for (const el of Array.from(root.querySelectorAll('[src]'))) {
			const src = el.getAttribute('src') ?? '';
			if (isAttachmentAddress(src, origin) || isDataAddress(src)) continue;
			if (el.localName !== 'img') {
				el.removeAttribute('src');
				continue;
			}
			const alt = el.getAttribute('alt') ?? '';
			const label = `🖼 ${alt || src}`;
			if (el.closest('a')) {
				el.replaceWith(doc.createTextNode(label));
			} else {
				const link = doc.createElement('a');
				link.setAttribute('href', src);
				link.textContent = label;
				el.replaceWith(link);
			}
		}
	}

	/** Each mention in a text node becomes a chip; attributes are never touched. */
	function chipMentions(root: DocumentFragment, usernames: readonly string[]) {
		const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
		const texts: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
		for (const node of texts) {
			const found = findMentions(node.data, usernames);
			if (!found.length) continue;
			const parts = doc.createDocumentFragment();
			let at = 0;
			for (const m of found) {
				if (m.start > at) parts.append(node.data.slice(at, m.start));
				const chip = doc.createElement('span');
				chip.className = 'mention-chip';
				chip.textContent = node.data.slice(m.start, m.end);
				parts.append(chip);
				at = m.end;
			}
			if (at < node.data.length) parts.append(node.data.slice(at));
			node.replaceWith(parts);
		}
	}

	return (text, opts = {}) => {
		const html = marked.parse(String(text ?? ''), { async: false });
		const fragment = purify.sanitize(html, SANITISE);
		clean(fragment);
		if (opts.mentions) chipMentions(fragment, opts.mentions);
		const out = doc.createElement('div');
		out.append(fragment);
		return out.innerHTML;
	};
}

let pageRenderer: MarkdownRenderer | undefined;

/**
 * `text` as HTML that is safe to draw with `{@html}`, for the page's own
 * window; escaped text where there is none. Made once, on first use.
 */
export function renderMarkdown(text: string, opts?: MarkdownOptions): string {
	pageRenderer ??= createMarkdownRenderer(typeof window === 'undefined' ? undefined : window);
	return pageRenderer(text, opts);
}
