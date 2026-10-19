-- Every card in a milestone of a board it is not on taken out of that
-- milestone, once (card 2155, 2026-10-19).
--
-- A one-off change to data, the file's only statement. A milestone that
-- belongs to a board holds only that board's cards: putting a card of another
-- board in one is refused (setCardMilestone, the bulk attach), and from this
-- build a move to another board takes the card out of one (applyCardMove).
-- Until now a move left it in, so a card moved off a board stayed in that
-- board's goal: everyone who can open the goal's board read the card's title
-- in the goal (GET /api/v1/milestones/{id}, the plan page), and its counts
-- took in work of another board. This takes out the cards already in that
-- state: those whose milestone has a board, and that board is not the board of
-- the card's column. A goal across boards (no board) keeps every card, and so
-- does a goal whose card is on its own board. Archived cards and closed goals
-- are included. A goal whose board row is gone (deleted while foreign keys
-- were off, as a restore runs) loses its cards too: no column is on a board
-- that is not there. A card naming a goal that no longer exists is left
-- alone: there is no goal to read. updated_at is left as it is, because
-- nobody edited the cards, and no activity entry is written.
--
-- What people see: each card it takes out is no longer in its goal, on the
-- plan page, the goal's counts and the milestone's API answers, and its
-- milestone reads as none. The card itself, its board, its dependencies and
-- everything else are untouched. Before the deploy the owner runs query 3 of
-- docs/deployment.md (the same WHERE as this statement) on a copy of
-- production; a card it lists that should stay with its goal is moved back to
-- the goal's board, or the goal is made one across boards, beforehand.
--
-- Harmless where it finds nothing: a new database has no cards. It is
-- declared to the rehearsal in tests/rehearsal/one-offs.ts as a one-off that
-- keeps every row, so the rehearsal still expects `cards` to keep all of its
-- rows, and notes the change.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and nothing repeats it at start-up or after a restore: a milestone moved to
-- another board can still take its cards with it until card 2179 refuses
-- that, and a repair at start-up would then take cards out of a goal with
-- nobody having asked.

UPDATE `cards` SET `milestone_id` = NULL
WHERE `milestone_id` IN (SELECT `id` FROM `milestones` WHERE `board_id` IS NOT NULL)
  AND (SELECT `board_id` FROM `milestones` WHERE `id` = `cards`.`milestone_id`)
      <> (SELECT `board_id` FROM `columns` WHERE `id` = `cards`.`column_id`);
