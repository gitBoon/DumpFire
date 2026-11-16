/**
 * cookie-header.ts — a cookie read from a request's raw `Cookie` header, as
 * the challenge cookie (card 2769, decision 27) and the session cookie (card
 * 2775, decision 11) are read.
 *
 * A browser sends every cookie of a name that matches the request, so a
 * cookie planted beside the real one (by a sibling host, or a page over plain
 * HTTP) arrives as a second pair of the same name. SvelteKit's
 * `cookies.get` answers one of them. Read here, two or more of a name are no
 * value at all, and so is one that is not in the shape the server makes.
 */

/**
 * Every value of the cookie named `name` in the request's raw `Cookie`
 * header, in the order sent; none for no header. The session cookie's
 * sign-out ends each one, and the gate says when there is more than one
 * (card 2775, the code review's CS3).
 */
export function cookieValues(request: Request, name: string): string[] {
	const header = request.headers.get('cookie');
	if (!header) return [];
	const values: string[] = [];
	for (const pair of header.split(';')) {
		const at = pair.indexOf('=');
		if (at !== -1 && pair.slice(0, at).trim() === name) values.push(pair.slice(at + 1).trim());
	}
	return values;
}

/**
 * The one cookie named `name` in the request's raw `Cookie` header, when its
 * value is in `shape`; null for none, for two or more, and for any other
 * value.
 */
export function onlyCookieValue(request: Request, name: string, shape: RegExp): string | null {
	const values = cookieValues(request, name);
	return values.length === 1 && shape.test(values[0]) ? values[0] : null;
}

/** Whether the request's raw `Cookie` header holds any cookie named `name`, whatever its value. */
export function sendsCookie(request: Request, name: string): boolean {
	return cookieValues(request, name).length > 0;
}
