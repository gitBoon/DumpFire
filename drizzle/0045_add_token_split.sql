-- Optional input/output split on a token entry.
--
-- Input and output tokens are priced ~5x apart on every current model, so a
-- cost figure derived from a bare total rests on an assumed ratio. That
-- assumption is fine as a default and is stated wherever a cost is shown, but
-- a caller who knows the real split should be able to say so and get an exact
-- number instead of an estimate.
--
-- Both nullable, and deliberately so: every entry written before this — and
-- every entry from a caller that only knows its total — keeps working and
-- falls back to the blended estimate. Nothing is backfilled or inferred.
--
-- Purely additive: two nullable columns on a table introduced in 0044. No
-- existing column is altered and no existing row is rewritten.
ALTER TABLE token_usage ADD COLUMN input_tokens INTEGER;
-->statement-breakpoint
ALTER TABLE token_usage ADD COLUMN output_tokens INTEGER;
