import type { PageServerLoad } from './$types';
import { usableEnrolmentLink } from '$lib/server/mfa-store';
import { setEnrolLinkCookie } from '$lib/server/sign-in-challenges';
import { LINK_DEAD, SIGN_OUT_FIRST } from '$lib/server/second-step';

/**
 * A set-up link's page (card 2769, decisions 19 and 20): a public route,
 * where the token decides. It asks nothing and posts nothing. A link that
 * can still be used, of an account that holds no second factor, names the
 * account and leaves the browser the link cookie (Path=/login, an hour), and
 * the page sends the holder to sign in: the password is asked at `/login`,
 * with all its throttles, and only then is a set-up challenge opened, on the
 * link. Any other link is the dead-link words, with no cookie.
 *
 * A browser that is signed in is told to sign out first, and is left no
 * cookie: a link should not vanish into a redirect home, nor be held by a
 * browser signed in as somebody else.
 *
 * Its answers carry `no-referrer`, no index and no cache (`ROUTE_HEADERS`),
 * and its address is masked in the log (`secret-paths.ts`).
 */
export const load: PageServerLoad = async ({ params, locals, url, cookies }) => {
	if (locals.user) return { state: 'signed in' as const, words: SIGN_OUT_FIRST };
	const link = usableEnrolmentLink(params.token);
	if (link === null) return { state: 'dead' as const, words: LINK_DEAD };
	setEnrolLinkCookie(cookies, url, params.token);
	return { state: 'good' as const, username: link.username };
};
