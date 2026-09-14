-- Measured token breakdown: cache reads, cache writes, and their TTL tier.
--
-- 0045 added an optional input/output split, which assumed those were the only
-- two components that mattered. Measuring a real Claude Code session on
-- 2026-09-14 showed that is badly wrong for agentic work: of 442,394,933 tokens,
-- 99.3% were cache reads and only 0.2% were output. A cache read is billed at a
-- tenth of fresh input, and a cache write at 1.25x (5-minute TTL) or 2x (1-hour
-- TTL), so pricing without these components is not a rounding error — the same
-- session priced as plain input/output comes out about 12x too high, while the
-- session-budget counter previously used as the token source was 1,236x too low.
--
-- With these columns an entry can be costed exactly from what was measured,
-- rather than from an assumed ratio.
--
-- All nullable and purely additive. Entries that predate this keep working and
-- fall back to the blended estimate; nothing is backfilled or inferred. The
-- `tokens` column stays the grand total, so every existing rollup is unchanged.
ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER;
-->statement-breakpoint
ALTER TABLE token_usage ADD COLUMN cache_write_5m_tokens INTEGER;
-->statement-breakpoint
ALTER TABLE token_usage ADD COLUMN cache_write_1h_tokens INTEGER;
