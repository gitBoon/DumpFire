/**
 * Highlight @username mentions in text by wrapping them in styled spans.
 * Call this BEFORE passing to the markdown renderer.
 */
export function highlightMentions(text: string): string {
	return text.replace(
		/@(\w+)/g,
		'<span class="mention-chip">@$1</span>'
	);
}
