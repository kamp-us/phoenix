-- #1590 — stamp when an account was promoted `çaylak → yazar`, so time-to-promotion
-- becomes measurable going forward. A thin nullable timestamp (D1-direct, ADR 0009),
-- NOT an event-log/analytics stream. Null = never promoted, or promoted before this
-- column existed (the founding cohort predates it — v1 measures forward, no backfill).
-- Stamped atomically inside `Pasaport.promoteToYazar` in the same batch as the `tier`
-- flip (ADR 0013/0014); server-only, `input:false` to better-auth so no client write
-- can reach it.

ALTER TABLE `user` ADD `promoted_at` integer;
