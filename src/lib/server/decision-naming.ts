/**
 * decision-naming.ts — what a signed-in viewer may be told of another
 * decision (card 2679, decision 5, S8; card 2680, decision 16).
 *
 * One rule, in one place, for every page that names a decision from another:
 * the participant page's supersede links (decision-view.ts) and the record
 * view's `recordEntryOf` (decision-register.ts). Its own module so that
 * neither imports the other for it (card 2680 code review, F3).
 *
 * A plain read: it takes the signed-in account, `user: SessionUser`, never
 * `caller` and never `SessionUser | null`, imports no `inWrite` and writes
 * nothing, so it is no service and needs no excuse on
 * tests/check-at-the-write.test.ts's NOT_SERVICES (code review S1). A
 * personal link holder, with no session, is told nothing: the caller who has
 * no account answers that itself, before it asks here.
 */
import type { Decision } from './db/schema';
import type { SessionUser } from './auth';
import { decisionAccess, mayDo } from './decision-access';

/**
 * The decision `other` as `user` may be told of it: its id and title to a
 * signed-in viewer who may view it, and nothing to anyone else.
 */
export function namedFor(user: SessionUser, other: Decision): { id?: number; title?: string } {
	if (!mayDo(decisionAccess(user, other), 'view', other)) return {};
	return { id: other.id, title: other.title };
}
