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
		adapter: adapter()
	}
};

export default config;
