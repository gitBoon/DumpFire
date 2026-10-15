import adapter from '@sveltejs/adapter-node';
import { relative, sep } from 'node:path';

// Warnings to suppress — intentional in a drag-and-drop Kanban UI
const suppressedWarnings = new Set([
	'a11y_autofocus',
	'a11y_click_events_have_key_events',
	'a11y_consider_explicit_label',
	'a11y_interactive_supports_focus',
	'a11y_label_has_associated_control',
	'a11y_no_noninteractive_element_interactions',
	'a11y_no_noninteractive_element_to_interactive_role',
	'a11y_no_static_element_interactions',
	'css_unused_selector',
	'state_referenced_locally'
]);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// defaults to rune mode for the project, execept for `node_modules`. Can be removed in svelte 6.
		runes: ({ filename }) => {
			const relativePath = relative(import.meta.dirname, filename);
			const pathSegments = relativePath.toLowerCase().split(sep);
			const isExternalLibrary = pathSegments.includes('node_modules');

			return isExternalLibrary ? undefined : true;
		},
		warningFilter: (warning) => !suppressedWarnings.has(warning.code)
	},
	onwarn: (warning, handler) => {
		if (suppressedWarnings.has(warning.code)) return;
		handler(warning);
	},
	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		adapter: adapter(),
		// An open page asks once a minute whether a new version has been deployed
		// (/_app/version.json, served before the gate), and the root layout says
		// so when one has (card 2167). With no interval a page never asked, so a
		// tab left open across a deploy ran the old scripts until reloaded by hand.
		version: { pollInterval: 60_000 },
		// The Content-Security-Policy of every page (card 2162; why each directive
		// is here, and what was not chosen, is in
		// docs/authentication-security.md#the-content-security-policy).
		// SvelteKit sets it on every page it renders, its error pages included,
		// with a fresh nonce each time ('auto' is a nonce, since no page is
		// prerendered), on its own start-up script and on the theme script in
		// src/app.html (`%sveltekit.nonce%`). Nothing else gets it: an API answer,
		// a redirect and the gate's own refusals carry none, and an attachment
		// keeps its own `sandbox`. `secured()` in src/lib/server/gate-answers.ts
		// sends it to report only while CSP_MODE=report-only. Every directive is
		// 'self' or narrower but two: no page asks another site for anything.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				// And the page's nonce, which SvelteKit adds. Every other script is
				// a file under /_app/; no page has an inline handler, a
				// `javascript:` address or `eval`.
				'script-src': ['self'],
				// Read only by a browser that knows neither of the next two; it
				// keeps such a browser working, at the cost of letting it have
				// <style> elements.
				'style-src': ['self', 'unsafe-inline'],
				// No <style> element: a built page links its CSS from files, so
				// one smuggled into a description cannot restyle the page. (Under
				// `vite dev`, which injects them, SvelteKit allows them itself.)
				'style-src-elem': ['self'],
				// Svelte writes style="..." into the server's HTML and its own
				// templates: every colour strip, bar width and menu position.
				// What makes one safe is that a colour is checked when it is
				// written and again when it is drawn, and img-src below.
				'style-src-attr': ['unsafe-inline'],
				// Attachments are DumpFire's; the tab icon and the select arrow are
				// data:. This is what stops a url() in any style from fetching
				// from another site. Not https:, which would allow it again.
				'img-src': ['self', 'data:'],
				// Inter, from DumpFire (card 2203): src/lib/fonts/inter.css.
				'font-src': ['self'],
				// Every fetch and the live streams (/api/events, a board's
				// events, /api/logs/stream) are DumpFire's own.
				'connect-src': ['self'],
				// The reports page shows its PDF in a frame from a blob: address,
				// and the browser's PDF viewer in it is a plugin. Only the page's
				// own script can make a blob: address.
				'frame-src': ['blob:'],
				'object-src': ['blob:'],
				'base-uri': ['self'],
				// The sign-in, set-up, invite and sign-out forms post to DumpFire.
				'form-action': ['self']
				// Not set: upgrade-insecure-requests, which would break an
				// installation served over plain HTTP; frame-ancestors, since
				// X-Frame-Options, set by secured() route by route, is the frame
				// rule and the request form's pages may be framed; and report-uri
				// or report-to, since nothing is collected.
			}
		}
	}
};

export default config;
