/**
 * The UI kit's source (card 3074, the plan's cases 7 and 8): what it adds to
 * app.css, and the reach of its CSS.
 *
 *   - The --ui-* tokens are defined once each, in one :root block of their
 *     own, each read from a token app.css already has; no theme block and no
 *     other rule names one. So nothing the board view draws reads them, and
 *     the board's .glass, .hdr-* and theme rules are as they were (the
 *     assertions on them in tests/page-failures.test.ts keep passing).
 *   - No file under src/lib/components/ui/ styles anything outside the kit:
 *     a component's `:global(...)` only within a .ui- class of its own, and
 *     the kit's plain CSS (ui-field.css) only .ui- classes.
 *
 * The components, mounted, are in `tests/ui-kit.svelte.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/** The tokens the plan names, in the order app.css gives them. */
const TOKENS = [
	'--ui-background',
	'--ui-surface',
	'--ui-card',
	'--ui-muted',
	'--ui-foreground',
	'--ui-muted-foreground',
	'--ui-subtle-foreground',
	'--ui-border',
	'--ui-input',
	'--ui-primary',
	'--ui-primary-hover',
	'--ui-primary-foreground',
	'--ui-ring',
	'--ui-destructive',
	'--ui-success',
	'--ui-warning',
	'--ui-info',
	'--ui-radius',
	'--ui-radius-sm',
	'--ui-radius-lg',
	'--ui-shadow-sm',
	'--ui-shadow',
	'--ui-content-max',
	'--ui-reading-max',
	'--ui-rail'
];

/** The themes whose indigo is light, given dark words on the primary colour. */
const LIGHT_INDIGO = ['solarized', 'cappuccino', 'ocean', 'sunset', 'nord', 'dracula', 'monokai', 'hacker'];

/** Each innermost rule of a stylesheet: its selector, comments taken out, and its body. */
function blocksOf(css: string): { selector: string; body: string }[] {
	return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((found) => ({ selector: found[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), body: found[2] }));
}

/** The custom properties a rule's body declares, in order. */
function declaredIn(body: string): string[] {
	return [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((found) => found[1]);
}

/** Each rule's selector list in a stylesheet, its comments taken out; at-rules and keyframe steps left out. */
function selectorsOf(css: string): string[] {
	const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
	return [...plain.matchAll(/([^{};]+)\{/g)]
		.map((found) => found[1].trim())
		.filter((selector) => !selector.startsWith('@') && !/^(from|to|[\d.]+%)(\s*,\s*(from|to|[\d.]+%))*$/.test(selector));
}

describe('the UI kit’s tokens in app.css (card 3074)', () => {
	it('7. defines each --ui-* token once, in a :root block of its own, from tokens app.css has; no theme block or other rule names one', () => {
		const css = read('src/app.css');
		const blocks = blocksOf(css);
		const naming = blocks.filter((block) => block.body.includes('--ui-'));

		// Two blocks: the kit's own :root, and the light-indigo themes' primary on :root[data-theme] (not a theme block).
		expect(naming.map((block) => block.selector)).toEqual([':root', LIGHT_INDIGO.map((theme) => `:root[data-theme="${theme}"]`).join(',\n')]);
		const [kit, light] = naming;
		expect(declaredIn(kit.body)).toEqual(TOKENS);
		expect(declaredIn(light.body)).toEqual(['--ui-primary', '--ui-primary-hover', '--ui-primary-foreground']);
		// Each defined once in the whole file, but those three, once more for those themes.
		for (const token of TOKENS) {
			expect(css.match(new RegExp(`${token}\\s*:`, 'g')), token).toHaveLength(declaredIn(light.body).includes(token) ? 2 : 1);
		}

		// Each value reads only tokens the first :root block (the one each theme overrides) defines.
		const base = blocks.find((block) => block.selector === ':root' && block.body.includes('--glass-bg:'))!;
		const known = new Set(declaredIn(base.body));
		const used = [...(kit.body + light.body).matchAll(/var\((--[a-z0-9-]+)\)/g)].map((found) => found[1]);
		expect(used.length).toBeGreaterThan(10);
		expect(used.filter((token) => !known.has(token))).toEqual([]);

		// The rules the board view draws with name none of them: the themes, .glass and the header controls.
		const themes = blocks.filter((block) => /^html\[data-theme="[a-z]+"\]$/.test(block.selector));
		expect(themes).toHaveLength(16);
		for (const block of [...themes, ...blocks.filter((b) => /(^|\s|,)\.(glass|hdr-|btn-primary|btn-ghost)/.test(b.selector))]) {
			expect(block.body, block.selector).not.toContain('--ui-');
		}
		expect(css.indexOf('--ui-')).toBeGreaterThan(css.indexOf('--font-mono:'));
		expect(css.lastIndexOf('--ui-')).toBeLessThan(css.indexOf('html[data-theme="dark"] {'));
	});
});

describe('the UI kit’s CSS stays inside the kit (card 3074)', () => {
	it('8. uses :global( only within a .ui- class in a component, and only .ui- classes in its plain CSS', () => {
		const dir = 'src/lib/components/ui';
		const files = readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}`);
		const components = files.filter((file) => file.endsWith('.svelte'));
		const sheets = files.filter((file) => file.endsWith('.css'));
		expect(components.length).toBeGreaterThanOrEqual(14);
		expect(sheets).toEqual([`${dir}/ui-field.css`]);

		const faults: string[] = [];
		for (const file of components) {
			const source = read(file);
			const styles = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((found) => found[1]);
			expect(styles.length, `${file} has one scoped <style>`).toBeLessThanOrEqual(1);
			expect(source, file).not.toMatch(/<style[^>]*\bglobal\b/);
			for (const selectorList of styles.flatMap(selectorsOf)) {
				// `:global { ... }` and `:global .x` (a block or a bare global) are never allowed.
				if (/:global(?!\()/.test(selectorList)) faults.push(`${file}: ${selectorList}`);
				for (const selector of selectorList.split(',').map((s) => s.trim())) {
					if (selector.includes(':global(') && !/^\.ui-[a-z0-9-]+/.test(selector)) faults.push(`${file}: ${selector}`);
				}
			}
		}
		for (const file of sheets) {
			for (const selector of selectorsOf(read(file)).flatMap((list) => list.split(',').map((s) => s.trim()))) {
				if (!/^\.ui-[a-z0-9-]+/.test(selector)) faults.push(`${file}: ${selector}`);
			}
		}
		expect(faults).toEqual([]);

		// The check finds what it is for: a global outside a .ui- class, and a bare one in the plain CSS.
		expect(selectorsOf('.ui-table :global(td) { color: red; } :global(body) { margin: 0; }')).toEqual(['.ui-table :global(td)', ':global(body)']);
		expect(selectorsOf('@media (max-width: 640px) { .ui-input { font-size: 16px; } input { x: y; } }')).toEqual(['.ui-input', 'input']);
	});
});

// ─── Contrast, worked out from app.css as a browser would ───────────────────

type Rgba = [number, number, number, number];

/** Each theme's custom properties, as the page's root has them: the base, the kit's, the theme's, then the kit's for that theme. */
function themesOf(css: string): Map<string, Map<string, string>> {
	const blocks = blocksOf(css);
	const declarations = (body: string) => [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((found) => [found[1], found[2].trim()] as const);
	const base = blocks.find((block) => block.selector === ':root' && block.body.includes('--glass-bg:'))!;
	const kit = blocks.find((block) => block.selector === ':root' && block.body.includes('--ui-background:'))!;
	const themes = new Map<string, Map<string, string>>([['light', new Map([...declarations(base.body), ...declarations(kit.body)])]]);
	for (const block of blocks) {
		const name = /^html\[data-theme="([a-z]+)"\]$/.exec(block.selector)?.[1];
		if (name && !themes.has(name)) themes.set(name, new Map([...declarations(base.body), ...declarations(kit.body), ...declarations(block.body)]));
	}
	for (const block of blocks) {
		const names = block.selector.split(',').map((s) => /^:root\[data-theme="([a-z]+)"\]$/.exec(s.trim())?.[1]);
		if (names.length === 0 || names.some((name) => !name)) continue;
		for (const name of names) for (const [key, value] of declarations(block.body)) themes.get(name!)!.set(key, value);
	}
	return themes;
}

/** The arguments of a function call, split at its top-level commas. */
function argumentsOf(inner: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === '(') depth++;
		else if (inner[i] === ')') depth--;
		else if (inner[i] === ',' && depth === 0) {
			out.push(inner.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(inner.slice(start).trim());
	return out;
}

/** A CSS colour: a hex, `transparent`, `var()` or `color-mix(in srgb, ...)` of those, as the browser computes it. */
function colourOf(expression: string, vars: Map<string, string>): Rgba {
	const text = expression.trim();
	const named = /^var\((--[a-z0-9-]+)\)$/.exec(text);
	if (named) {
		const value = vars.get(named[1]);
		if (value === undefined) throw new Error(`${named[1]} is not defined`);
		return colourOf(value, vars);
	}
	if (text === 'transparent') return [0, 0, 0, 0];
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
	if (hex) {
		const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : [hex[1].slice(0, 2), hex[1].slice(2, 4), hex[1].slice(4, 6)];
		return [...digits.map((d) => parseInt(d, 16)), 1] as Rgba;
	}
	const mix = /^color-mix\((.*)\)$/.exec(text);
	if (mix) {
		const [space, ...parts] = argumentsOf(mix[1]);
		expect(space).toBe('in srgb');
		const [a, b] = parts.map((part) => {
			const share = /\s+([\d.]+)%$/.exec(part);
			return { colour: colourOf(share ? part.slice(0, share.index) : part, vars), share: share ? Number(share[1]) / 100 : undefined };
		});
		const p = a.share ?? (b.share === undefined ? 0.5 : 1 - b.share);
		const q = b.share ?? 1 - p;
		// Premultiplied, as CSS mixes colours with alpha.
		const alpha = a.colour[3] * p + b.colour[3] * q;
		if (alpha === 0) return [0, 0, 0, 0];
		const channel = (i: number) => (a.colour[i] * a.colour[3] * p + b.colour[i] * b.colour[3] * q) / alpha;
		return [channel(0), channel(1), channel(2), alpha];
	}
	throw new Error(`not a colour this test reads: ${text}`);
}

/** A colour drawn over an opaque one. */
function over(top: Rgba, under: Rgba): Rgba {
	const a = top[3];
	return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

/** WCAG 2's contrast ratio of two opaque colours. */
function contrast(x: Rgba, y: Rgba): number {
	const linear = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const luminance = (c: Rgba) => 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2]);
	const [lx, ly] = [luminance(x), luminance(y)];
	return (Math.max(lx, ly) + 0.05) / (Math.min(lx, ly) + 0.05);
}

describe('the UI kit’s colours in every theme (card 3074)', () => {
	it('9. meets WCAG AA in all 17 themes: 4.5:1 for every kit text on every surface it is drawn on, 3:1 for the focus ring and a field’s edge', () => {
		const themes = themesOf(read('src/app.css'));
		expect([...themes.keys()]).toHaveLength(17);

		/** A colour expression as the component writes it: it must be in that file, so the pair is the one drawn. */
		const as = (file: string, expression: string) => {
			expect(read(`src/lib/components/ui/${file}`), file).toContain(expression);
			return expression;
		};
		const PAGE = ['var(--ui-background)'];
		const CARD = ['var(--ui-card)'];
		const SURFACE = ['var(--ui-surface)'];
		const SURFACES = [PAGE, CARD, SURFACE];
		const FG = 'var(--ui-foreground)';
		const MUTED_FG = 'var(--ui-muted-foreground)';

		/** [what, text colour, layers of the background from the bottom up, the least ratio]. */
		const pairs: [string, string, string[], number][] = [];
		const text = (what: string, fg: string, layers: string[][]) => layers.forEach((bg, i) => pairs.push([`${what} #${i + 1}`, fg, bg, 4.5]));

		text('text', FG, [...SURFACES, ['var(--ui-muted)']]);
		text('muted text', MUTED_FG, SURFACES);
		text('primary button, default badge', 'var(--ui-primary-foreground)', [['var(--ui-primary)'], ['var(--ui-primary-hover)']]);
		text('secondary button, hovered', FG, [[as('Button.svelte', 'color-mix(in srgb, var(--ui-muted) 70%, var(--ui-background))')]]);
		text('destructive button', '#fff', [
			[as('Button.svelte', 'color-mix(in srgb, var(--ui-destructive) 82%, #000)')],
			[as('Button.svelte', 'color-mix(in srgb, var(--ui-destructive) 72%, #000)')]
		]);
		text('link button', as('Button.svelte', 'color-mix(in srgb, var(--ui-primary) 40%, var(--ui-foreground))'), SURFACES);
		for (const [tone, share] of [['destructive', 12], ['success', 12], ['warning', 14], ['info', 12]] as const) {
			const tint = as('Badge.svelte', `color-mix(in srgb, var(--ui-${tone}) ${share}%, transparent)`);
			text(`${tone} badge`, FG, SURFACES.map((surface) => [...surface, tint]));
		}
		for (const tone of ['info', 'success', 'warning', 'destructive'] as const) {
			const share = tone === 'warning' ? 7 : 6;
			const tint = [as('Alert.svelte', `color-mix(in srgb, var(--ui-${tone}) ${share}%, var(--ui-background))`)];
			text(`${tone} alert title`, FG, [tint]);
			text(`${tone} alert body`, MUTED_FG, [tint]);
		}
		// Tabs and segments: muted words on the track (a surface), the current one's on the page colour: both above.
		as('Tabs.svelte', 'background: var(--ui-surface);');
		as('SegmentedControl.svelte', 'background: var(--ui-surface);');
		text('table row, hovered', FG, [[...CARD, as('Table.svelte', 'color-mix(in srgb, var(--ui-muted) 40%, transparent)')]]);
		// Not text: the focus ring on whatever it is drawn over, and a field's edge on the page, a card or a track.
		for (const bg of [...SURFACES, ['var(--ui-muted)']]) pairs.push(['focus ring', 'var(--ui-ring)', bg, 3]);
		for (const bg of SURFACES) pairs.push(['field edge', 'var(--ui-input)', bg, 3]);

		const faults: string[] = [];
		for (const [theme, vars] of themes) {
			for (const [what, fg, layers, min] of pairs) {
				const bg = layers.map((layer) => colourOf(layer, vars)).reduce((under, top) => over(top, under), [0, 0, 0, 1] as Rgba);
				const ratio = contrast(over(colourOf(fg, vars), bg), bg);
				if (ratio < min) faults.push(`${theme}: ${what} ${ratio.toFixed(2)} < ${min}`);
			}
		}
		expect(pairs.length).toBeGreaterThan(40);
		expect(faults).toEqual([]);

		// The reckoning is a browser's: white on the light theme's indigo is 4.47:1, the figure the review measured.
		const light = themes.get('light')!;
		expect(contrast(colourOf('#fff', light), colourOf('var(--accent-indigo)', light))).toBeCloseTo(4.47, 2);
	});
});
