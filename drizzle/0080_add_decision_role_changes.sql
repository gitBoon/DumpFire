-- Every decision role in the record of changes of access, seeded once (card 3033, 2026-11-21).
--
-- No new table, and no new column of `access_changes`: its `kind` is free
-- text, and its indexes, rule, union and ranking serve any kind (card 3002,
-- migration 0079). One index is added, last, on `changed_at` alone
-- (`access_changes_changed`): the start and five-minute pass asks once whether
-- any row of this server's is dated after now, and without it that one read
-- scans the whole record. Four kinds are added, each named by a decision's
-- creation time, their holders and their words, low to high:
--
--   decision               always 0                               tracked, deleted
--   decision_decider       the account for yes, 0 for none        none, yes
--   decision_participant   a place                                removed < informed < consulted
--   decision_account       an account                             none < held
--
-- A decision is the subject of `decision`, `decision_decider` and
-- `decision_participant`: its row id (`subject_id`) and its creation time
-- (`subject_created`, its `created_at` in the stored form). A place is one
-- `decision_participants` row, named by its row id and its decision's creation
-- time, never its own `included_at`, which opening a decision takes again: it
-- is the holder of `decision_participant` (`holder_id`, `holder_created`) and
-- the subject of `decision_account`, whose holder is the account the place
-- holds. A decision is tracked while the record holds its `decision` row, and a
-- place through its decision.
--
-- One reading of a creation time, as 0079's: the stored form
-- `YYYY-MM-DD HH:MM:SS`, as `isStamp` reads it. The runner brings every creation
-- time it can read to that form only after the migrations have run
-- (`normaliseTimestamps`), so the seed reads each the same way first, through
-- card 3002 R19's stamps: worked out once, in pure SQL with no function of this
-- build's, from `decisions.created_at` and `users.created_at`, into a TEMP
-- table dropped at the end of the file. A decision whose creation time cannot
-- be read so is not tracked, and no row of any kind is written for it or its
-- places. A decider whose account's time cannot is not written (card 3002
-- R21): held as none, the first start would clear the decider. A decider
-- naming no account, or an account that is not here, is written as `none`,
-- holder 0. A place's account whose time cannot is not written either. No row
-- has a real holder with `holder_created` ''. The two creation columns are not
-- `*_at` columns, so the timestamp normaliser never rewrites them.
--
-- The seed, once: every decision present here whose creation time reads as a
-- moment, and the roles it gives today: the decision, its decider, each place's
-- standing (a removed place as removed, a role that is not consulted as
-- informed) and each place's account. Each seed row is dated at the earliest
-- stamp, 0001-01-01 00:00:00, so that a row written after it, here or by a
-- backup, always outranks it. Changes no existing row. Nothing is declared in
-- tests/rehearsal/one-offs.ts.
--
-- Going back to an older image is as card 3002's: see the release notes of
-- card 3033.
--
-- No guard, as 0076 and 0077 have: the seed writes one row for each row that
-- exists, never a range of ids.

CREATE TEMP TABLE `migration_0080_stamps` (
	`written` text PRIMARY KEY NOT NULL,
	`stored` text NOT NULL
);
--> statement-breakpoint
INSERT INTO temp.`migration_0080_stamps` (`written`, `stored`)
SELECT `v`, strftime('%Y-%m-%d %H:%M:%S', `v`) FROM (
	SELECT `v`,
		CASE WHEN `v` GLOB '*Z' THEN substr(`v`, 1, length(`v`) - 1)
			WHEN length(`v`) > 16 AND `v` GLOB '*[+-][0-9][0-9]:[0-9][0-9]' THEN substr(`v`, 1, length(`v`) - 6)
			ELSE `v` END AS `body`,
		CASE WHEN `v` GLOB '*Z' THEN 'Z'
			WHEN length(`v`) > 16 AND `v` GLOB '*[+-][0-9][0-9]:[0-9][0-9]' THEN substr(`v`, -6)
			ELSE '' END AS `zone`
	FROM (
		SELECT created_at AS `v` FROM decisions UNION SELECT created_at FROM users
	) WHERE typeof(`v`) = 'text'
)
WHERE substr(`body`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(substr(`body`, 1, 10)) = substr(`body`, 1, 10)
	AND ((length(`body`) = 10 AND `zone` = '')
		OR (substr(`body`, 11, 6) GLOB '[T ][0-9][0-9]:[0-9][0-9]' AND substr(`body`, 12, 2) <= '23' AND substr(`body`, 15, 2) <= '59'
			AND (length(`body`) = 16
				OR (substr(`body`, 17, 3) GLOB ':[0-9][0-9]' AND substr(`body`, 18, 2) <= '59'
					AND (length(`body`) = 19
						OR (length(`body`) BETWEEN 21 AND 29 AND substr(`body`, 20, 1) = '.' AND substr(`body`, 21) NOT GLOB '*[^0-9]*'))))))
	AND (`zone` IN ('', 'Z') OR (substr(`zone`, 2, 2) <= '23' AND substr(`zone`, 5, 2) <= '59'))
	AND strftime('%Y-%m-%d %H:%M:%S', `v`) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]';
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'decision', d.id, ds.stored, 'tracked', '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM decisions AS d JOIN temp.`migration_0080_stamps` AS ds ON ds.written = d.created_at
ORDER BY d.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'decision_decider', d.id, ds.stored,
	CASE WHEN u.id IS NULL THEN 0 ELSE u.id END, CASE WHEN u.id IS NULL THEN '' ELSE us.stored END,
	CASE WHEN u.id IS NULL THEN 'none' ELSE 'yes' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM decisions AS d JOIN temp.`migration_0080_stamps` AS ds ON ds.written = d.created_at
	LEFT JOIN users AS u ON u.id = d.decider_user_id LEFT JOIN temp.`migration_0080_stamps` AS us ON us.written = u.created_at
WHERE u.id IS NULL OR us.stored IS NOT NULL
ORDER BY d.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'decision_participant', d.id, ds.stored, p.id, ds.stored,
	CASE WHEN p.removed_at IS NOT NULL THEN 'removed' WHEN p.role = 'consulted' THEN 'consulted' ELSE 'informed' END,
	'0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM decision_participants AS p JOIN decisions AS d ON d.id = p.decision_id
	JOIN temp.`migration_0080_stamps` AS ds ON ds.written = d.created_at
ORDER BY p.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'decision_account', p.id, ds.stored, u.id, us.stored, 'held', '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM decision_participants AS p JOIN decisions AS d ON d.id = p.decision_id
	JOIN temp.`migration_0080_stamps` AS ds ON ds.written = d.created_at
	JOIN users AS u ON u.id = p.user_id JOIN temp.`migration_0080_stamps` AS us ON us.written = u.created_at
ORDER BY p.id;
--> statement-breakpoint
DROP TABLE temp.`migration_0080_stamps`;
--> statement-breakpoint
CREATE INDEX `access_changes_changed` ON `access_changes` (`changed_at`);
