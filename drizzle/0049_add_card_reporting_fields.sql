-- Reporting fields: the five facts a management report needs that a card's
-- own technical text cannot supply.
--
-- The first 30-day report took 229 API calls and about 18 minutes, and the bulk
-- of that was hand-writing 196 plain-English summaries, because card titles are
-- written for engineers. Worse, four very different outcomes — delivered, not
-- needed, superseded, parked — all land in the Complete column and are
-- indistinguishable afterwards, so "145 completed" overstated what was built.
--
-- Every column is nullable and nothing is backfilled. A card with no summary
-- reads as "not recorded", which is honest; inventing one would put words in
-- someone's mouth in a document that goes to management.
--
--   summary         plain English, ~12 words, used verbatim in report appendices
--   theme           new capability | customer issue | security & compliance | maintenance
--   customer_impact none | internal | live customers (optionally naming them)
--   close_reason    delivered | not needed | superseded | parked
--   release_state   built | on UAT | live
--
-- Values are validated in the application rather than by CHECK constraints:
-- the vocabularies will change, and a CHECK constraint in SQLite cannot be
-- altered without rebuilding the table.
ALTER TABLE cards ADD COLUMN summary TEXT;
-->statement-breakpoint
ALTER TABLE cards ADD COLUMN theme TEXT;
-->statement-breakpoint
ALTER TABLE cards ADD COLUMN customer_impact TEXT;
-->statement-breakpoint
ALTER TABLE cards ADD COLUMN close_reason TEXT;
-->statement-breakpoint
ALTER TABLE cards ADD COLUMN release_state TEXT;
-->statement-breakpoint
-- The report buckets by completedAt over a window, for every board at once.
CREATE INDEX IF NOT EXISTS idx_cards_completed_at ON cards(completed_at);
