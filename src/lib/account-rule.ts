/**
 * account-rule.ts — whose account a caller may manage: set its password, send
 * it an invite, change it or delete it.
 *
 *   an ordinary user's account    any administrator
 *   an administrator's account    the superadmin
 *   the superadmin's account      nobody else
 *
 * One copy, for the server and the page alike. `requireManagedAccount` in
 * `$lib/server/route-guards.ts` asks it once it has read the account, and the
 * admin page asks it for each row, to show only the controls the server would
 * let the caller use. The page cannot import the server's module, and a copy
 * of the table on the page would drift from it.
 *
 * The caller's own account passes, for an administrator: what a caller may do
 * to their own account is each route's to say, and the page offers only the
 * password there (the 🔑 dialog asks for the one they have).
 */

/** The two things the rule reads of an account. */
export type AccountHolder = { id: number; role: string };

/** Whether `caller` may manage `target`'s account. Never for a caller who is not an administrator. */
export function mayManageAccount(caller: AccountHolder, target: AccountHolder): boolean {
	if (caller.role !== 'admin' && caller.role !== 'superadmin') return false;
	if (target.id === caller.id) return true;
	if (target.role === 'superadmin') return false;
	if (target.role === 'admin') return caller.role === 'superadmin';
	return true;
}
