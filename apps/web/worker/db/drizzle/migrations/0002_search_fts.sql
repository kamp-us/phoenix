-- Site search FTS5 tables (ADR 0080). Lexical search bar over term + post titles.
-- Hand-written, NOT drizzle-generated: drizzle-kit's schema DSL cannot express an
-- FTS5 virtual table, so these live only here (and not in schema.ts). The
-- application write path dual-writes these rows in lockstep with term_summary /
-- post_summary (see features/search/fts-sync.ts) — no triggers.
--
-- Tokenizer: unicode61 remove_diacritics 2. prefix='2 3 4' indexes 2/3/4-char
-- prefixes as a poor-man's stemmer for Turkish agglutination. NO porter stemmer
-- (English; harmful for Turkish). The `norm` column is the app-side
-- Turkish-folded title (Turkish-correct casing + ç/ş/ğ/ö/ü/ı diacritic fold); the
-- slug/id column is UNINDEXED, carried only to join a match back to its summary.
--
-- Export caveat: D1 cannot export a database containing virtual tables; a future
-- export must DROP these first and recreate them after.
CREATE VIRTUAL TABLE `term_search` USING fts5(
	slug UNINDEXED,
	norm,
	tokenize = "unicode61 remove_diacritics 2",
	prefix = "2 3 4"
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `post_search` USING fts5(
	id UNINDEXED,
	norm,
	tokenize = "unicode61 remove_diacritics 2",
	prefix = "2 3 4"
);
