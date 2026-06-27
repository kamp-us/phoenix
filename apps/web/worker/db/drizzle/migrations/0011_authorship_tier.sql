-- ADR 0107 §4 — the server-managed authorship tier.
-- `user.tier`: the GLOBAL account-level earned standing on the
-- `visitor < çaylak < yazar` ladder. The column holds only `çaylak | yazar` (an
-- account is always ≥ çaylak; `visitor` is the no-account read, never stored).
-- Born 'çaylak'; promoted to 'yazar' only by the server promotion path (#1206) /
-- founding seed — declared `input:false` to better-auth (`better-auth-live.ts`),
-- so no client/session write can set or escalate it. Read at the point of use via
-- `Kunye.tierOf` (through Pasaport), never trusted from session state. Existing
-- rows backfill to 'çaylak' via the NOT NULL DEFAULT.

ALTER TABLE `user` ADD `tier` text DEFAULT 'çaylak' NOT NULL;
