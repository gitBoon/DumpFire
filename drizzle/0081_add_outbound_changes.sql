-- Every change of where this server sends (card 3004, 2026-11-21).
--
-- A row says that, after a change made here, the item of this `kind` is in
-- this `state`: a webhook, a report schedule or one of its addresses, a backup
-- destination, the mail server or the App URL. Removals, moves, holds and
-- re-adds, switch-offs and switch-ons alike, so that they rank. An item with
-- an id is named by its row id (`item_id`) and its creation time
-- (`item_created`, its `created_at` in the stored form, or '' where that does
-- not read): a webhook, a schedule, and a recipient's schedule. A place is
-- named by a digest of where it sends (`place`): a destination's, the mail's
-- and the App URL's as SHA-256 (`placeKey`, as `setting_holds` names them), a
-- recipient's address as a keyed digest. A webhook's address is a keyed
-- digest too (`address`): `k<key id>:<64 hex>`, an HMAC under a subkey of the
-- MFA key, never an address in plain. The kinds, how each is named and their
-- words, open to closed:
--
--   webhook       id and creation time, its address       on < off < held < deleted
--   schedule      id and creation time                    on < off < deleted
--   recipient     its schedule's, and its address keyed   added < removed
--   destination   its place                               set < held < removed
--   mail          its place                               set < held < removed
--   app_url       its place                               set < held < removed
--   seeded        the marker, one row                     yes
--
-- `origin` is `here` for a row this server wrote, `seed` for one its once-only
-- seed wrote, and `backup` for one a restore brought. `seq` orders this
-- server's writes, and this server's rows rank by it alone, never by
-- `changed_at`, so that a clock stepped back never reorders them; a `seed` row
-- ranks below every `here` row of its item. `changed_at` is when, in the
-- stored form, a backup's clamped; `stated_changed` is the moment as the row's
-- writer stated it, before any clamp, and with `state` and `address` it is the
-- union's key, so that importing the same backup again adds nothing. Every
-- writer adds its row in the transaction that makes the change, with a plain
-- INSERT, and no write deletes, changes or replaces a row.
--
-- No foreign key: a row outlives its webhook, schedule and setting.
--
-- Three indexes: `outbound_changes_item`, the latest row of an item by origin
-- in seq order (the rowid ends every index entry); `outbound_changes_union`,
-- the restore's union; and `outbound_changes_changed`, the start and
-- five-minute pass's one read of whether any row is dated after now.
--
-- No seed here: the digests need the MFA key, which a migration has not got.
-- The server seeds the table once, from what is here then, and marks it so
-- with the `seeded` row. The two creation columns are not `*_at` columns, so
-- the timestamp normaliser never rewrites them; `changed_at` is one.
--
-- A restore keeps this table, as it keeps the record of changes of access, and
-- Reset Everything keeps it. Changes no existing row. Nothing is declared in
-- tests/rehearsal/one-offs.ts.
--
-- Going back to an older image leaves it unwritten there, and that image's
-- restore clears it and copies the backup's rows in as they are: dump it
-- before going back and put the dump back on return (see the release notes of
-- card 3004).
--
-- No guard, as 0076 and 0077 have: it writes no row.

CREATE TABLE `outbound_changes` (
	`seq` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` integer DEFAULT 0 NOT NULL,
	`item_created` text DEFAULT '' NOT NULL,
	`place` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`changed_at` text NOT NULL,
	`stated_changed` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'here' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbound_changes_item` ON `outbound_changes` (`kind`,`item_id`,`item_created`,`place`,`origin`);
--> statement-breakpoint
CREATE INDEX `outbound_changes_union` ON `outbound_changes` (`kind`,`item_id`,`item_created`,`place`,`stated_changed`,`state`,`address`);
--> statement-breakpoint
CREATE INDEX `outbound_changes_changed` ON `outbound_changes` (`changed_at`);
