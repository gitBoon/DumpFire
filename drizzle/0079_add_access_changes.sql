-- Every change of who may open a board, who is in a team and which account a person is linked to (card 3002, 2026-11-20).
--
-- A row says that, after a change made here, the item of this `kind` gives
-- this `access`. What is opened, the subject, is a board, a team or a person,
-- named by its row id (`subject_id`) and its creation time (`subject_created`,
-- its `created_at` in the stored form); who gets it, the holder, is an account,
-- or a team for a share, named the same way (`holder_id`, `holder_created`), or
-- holder 0 with '' for none. Grants and narrowings alike. The kinds, their
-- holders and their words, low to high:
--
--   board           a board's creator, or 0 for none       tracked
--   board_public    always 0                               private < public
--   product_owner   the account for yes, 0 for none        none, yes
--   board_member    an account                             none < viewer < editor < owner
--   board_team      a team                                 none < viewer < editor
--   team            always 0                               tracked, deleted
--   team_member     an account                             none < member < owner
--   person_link     the account for linked, 0 for none     none, linked
--
-- A board, team or person is tracked while the record holds its marker: a
-- `board` row, a `team` row, or any `person_link` row.
--
-- `origin` is `here` for a row this server wrote and `backup` for one a
-- restore brought. `seq` orders this server's writes, and this server's rows
-- rank by it alone, never by `changed_at`, so that a clock stepped back never
-- reorders them. `changed_at` is when, in the stored form, a backup's clamped;
-- `stated_changed` is the moment as the row's writer stated it, before any
-- clamp, and with `access` it is the union's key, so that importing the same
-- backup again adds nothing. Every writer adds its row in the transaction that
-- makes the change (`recordAccessChange`, src/lib/server/access-changes.ts),
-- with a plain INSERT, and no write deletes, changes or replaces a row.
--
-- No foreign key: a row outlives its board, team, person and account.
--
-- One reading of a creation time: the stored form `YYYY-MM-DD HH:MM:SS`, as
-- `isStamp` reads it. The runner brings every creation time it can read to
-- that form only after the migrations have run (`normaliseTimestamps`), so the
-- seed reads each the same way first: a value in the stored form, ISO 8601
-- with a `T`, a fraction or a zone, the stored form to the minute, or a bare
-- date, each only where its day, hour, minute, second and zone are ones the
-- calendar and the clock have, and written as the stored form the runner will
-- give it (strftime, which moves a zone to UTC and drops a fraction). The
-- seed's stamps are worked out once, in pure SQL with no function of this
-- build's, into a TEMP table dropped at the end of the file. A board, team or
-- person whose time cannot be read so is not tracked; a member, share or
-- Product Owner whose account's or team's time cannot is not written; and a
-- board's creator or a person's link whose account's time cannot is not
-- written either (card 3002 R21): held as none, the first start would clear
-- the creator or unlink the person. Only the creator and the guess are then
-- skipped: such a board has no `board` row, so no start or restore clears its
-- creator and a restore guesses nothing on it, while its members, shares,
-- visibility and Product Owner are written and capped as any board's; such a
-- person has no link row, and is never unlinked by the record. A creator or
-- link naming no account is written as holder 0. No row has a
-- real holder with `holder_created` ''. The two creation columns are not `*_at`
-- columns, so the timestamp normaliser never rewrites them.
--
-- The seed, once: every board, team and person present here whose creation
-- time reads as a moment, and the access each gives today: a board's creator,
-- its visibility, its Product Owner, its members (a role that is not owner or
-- editor as viewer) and its shares (a role that is not editor as viewer); a
-- team, and its members (a role that is not owner as member); a person's link.
-- A member or share naming no board, team or account opens nothing, and is
-- skipped. Each seed row is dated at the earliest stamp, 0001-01-01 00:00:00,
-- so that a row written after it, here or by a backup, always outranks it.
-- Changes no existing row. Nothing is declared in tests/rehearsal/one-offs.ts.
--
-- A restore keeps this table, as it keeps the record of account endings, and
-- adds the backup's rows to it; Reset Everything keeps it. Going back to an
-- older image leaves it unwritten there, and that image's restore clears it and
-- copies the backup's rows in as they are: dump it before going back and put
-- the dump back on return (see docs/deployment.md and the release notes of
-- card 3002).
--
-- No guard, as 0076 and 0077 have: the seed writes one row for each row that
-- exists, never a range of ids.

CREATE TABLE `access_changes` (
	`seq` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` integer NOT NULL,
	`subject_created` text NOT NULL,
	`holder_id` integer DEFAULT 0 NOT NULL,
	`holder_created` text DEFAULT '' NOT NULL,
	`access` text NOT NULL,
	`changed_at` text NOT NULL,
	`stated_changed` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'here' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `access_changes_pair` ON `access_changes` (`subject_id`,`kind`,`subject_created`,`holder_id`,`holder_created`,`origin`);
--> statement-breakpoint
CREATE INDEX `access_changes_subject` ON `access_changes` (`subject_id`,`kind`,`subject_created`,`origin`);
--> statement-breakpoint
CREATE INDEX `access_changes_union` ON `access_changes` (`subject_id`,`kind`,`subject_created`,`holder_id`,`holder_created`,`stated_changed`,`access`);
--> statement-breakpoint
CREATE TEMP TABLE `migration_0079_stamps` (
	`written` text PRIMARY KEY NOT NULL,
	`stored` text NOT NULL
);
--> statement-breakpoint
INSERT INTO temp.`migration_0079_stamps` (`written`, `stored`)
SELECT `v`, strftime('%Y-%m-%d %H:%M:%S', `v`) FROM (
	SELECT `v`,
		CASE WHEN `v` GLOB '*Z' THEN substr(`v`, 1, length(`v`) - 1)
			WHEN length(`v`) > 16 AND `v` GLOB '*[+-][0-9][0-9]:[0-9][0-9]' THEN substr(`v`, 1, length(`v`) - 6)
			ELSE `v` END AS `body`,
		CASE WHEN `v` GLOB '*Z' THEN 'Z'
			WHEN length(`v`) > 16 AND `v` GLOB '*[+-][0-9][0-9]:[0-9][0-9]' THEN substr(`v`, -6)
			ELSE '' END AS `zone`
	FROM (
		SELECT created_at AS `v` FROM boards UNION SELECT created_at FROM teams
		UNION SELECT created_at FROM people UNION SELECT created_at FROM users
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
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'board', b.id, bs.stored,
	CASE WHEN us.stored IS NOT NULL THEN u.id ELSE 0 END, coalesce(us.stored, ''),
	'tracked', '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM boards AS b JOIN temp.`migration_0079_stamps` AS bs ON bs.written = b.created_at
	LEFT JOIN users AS u ON u.id = b.created_by LEFT JOIN temp.`migration_0079_stamps` AS us ON us.written = u.created_at
WHERE u.id IS NULL OR us.stored IS NOT NULL
ORDER BY b.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'board_public', b.id, bs.stored, CASE WHEN b.is_public = 1 THEN 'public' ELSE 'private' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM boards AS b JOIN temp.`migration_0079_stamps` AS bs ON bs.written = b.created_at
ORDER BY b.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'product_owner', b.id, bs.stored, u.id, us.stored, 'yes', '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM boards AS b JOIN temp.`migration_0079_stamps` AS bs ON bs.written = b.created_at
	JOIN users AS u ON u.id = b.product_owner_user_id JOIN temp.`migration_0079_stamps` AS us ON us.written = u.created_at
ORDER BY b.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'board_member', b.id, bs.stored, u.id, us.stored,
	CASE WHEN m.role IN ('owner', 'editor') THEN m.role ELSE 'viewer' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM board_members AS m JOIN boards AS b ON b.id = m.board_id JOIN temp.`migration_0079_stamps` AS bs ON bs.written = b.created_at
	JOIN users AS u ON u.id = m.user_id JOIN temp.`migration_0079_stamps` AS us ON us.written = u.created_at
ORDER BY m.board_id, m.user_id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'board_team', b.id, bs.stored, t.id, ts.stored,
	CASE WHEN s.role = 'editor' THEN 'editor' ELSE 'viewer' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM board_teams AS s JOIN boards AS b ON b.id = s.board_id JOIN temp.`migration_0079_stamps` AS bs ON bs.written = b.created_at
	JOIN teams AS t ON t.id = s.team_id JOIN temp.`migration_0079_stamps` AS ts ON ts.written = t.created_at
ORDER BY s.board_id, s.team_id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'team', t.id, ts.stored, 'tracked', '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM teams AS t JOIN temp.`migration_0079_stamps` AS ts ON ts.written = t.created_at
ORDER BY t.id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'team_member', t.id, ts.stored, u.id, us.stored,
	CASE WHEN m.role = 'owner' THEN 'owner' ELSE 'member' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM team_members AS m JOIN teams AS t ON t.id = m.team_id JOIN temp.`migration_0079_stamps` AS ts ON ts.written = t.created_at
	JOIN users AS u ON u.id = m.user_id JOIN temp.`migration_0079_stamps` AS us ON us.written = u.created_at
ORDER BY m.team_id, m.user_id;
--> statement-breakpoint
INSERT INTO `access_changes` (`kind`, `subject_id`, `subject_created`, `holder_id`, `holder_created`, `access`, `changed_at`, `stated_changed`)
SELECT 'person_link', p.id, ps.stored,
	CASE WHEN us.stored IS NOT NULL THEN u.id ELSE 0 END, coalesce(us.stored, ''),
	CASE WHEN us.stored IS NOT NULL THEN 'linked' ELSE 'none' END, '0001-01-01 00:00:00', '0001-01-01 00:00:00'
FROM people AS p JOIN temp.`migration_0079_stamps` AS ps ON ps.written = p.created_at
	LEFT JOIN users AS u ON u.id = p.user_id LEFT JOIN temp.`migration_0079_stamps` AS us ON us.written = u.created_at
WHERE u.id IS NULL OR us.stored IS NOT NULL
ORDER BY p.id;
--> statement-breakpoint
DROP TABLE temp.`migration_0079_stamps`;
