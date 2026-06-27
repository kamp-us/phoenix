-- #1206 — the authorship-vouch ledger (ADR 0107): a recorded `yazar`-vouches-for-`caylak`
-- act. NOT a relation_tuple (that store has no runtime write path, offline-minted
-- only); a vouch is a runtime write by a signed-in yazar, so it gets its own table
-- with the vouching actor preserved. The composite PK (voucher_id, candidate_id)
-- makes a re-vouch by the same yazar idempotent (onConflictDoNothing) and makes a
-- vouch with no voucher / no candidate unrepresentable (both NOT NULL). No FK to
-- `user` — an account-anonymize must not cascade-erase the historical act.

CREATE TABLE `authorship_vouch` (
	`voucher_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `authorship_vouch_voucher_id_candidate_id_pk` PRIMARY KEY(`voucher_id`, `candidate_id`)
);
--> statement-breakpoint
CREATE INDEX `authorship_vouch_candidate` ON `authorship_vouch` (`candidate_id`);
