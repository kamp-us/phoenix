-- #2734 (epic #2687) — add actor attribution to the email-delivery log. A manual admin
-- mark/clear (#2692) now stamps `actor_id` (the discharged `Admin` grant's account id, ADR
-- 0107), mirroring `user_ban_event.actor_id` so the audit trail attributes WHICH admin acted.
-- NULLABLE, unlike the ban precedent's NOT NULL: `email_delivery_event` is multi-writer — the
-- send-time `SendEmailError` capture (#2691) and the CF async ingestion (#2694) are non-admin
-- appenders with no actor, so a strict NOT NULL would reject their valid rows. Existing rows
-- (all pre-actor) keep a NULL actor — the attribution is never fabricated; only mark/clear stamps it.

ALTER TABLE `email_delivery_event` ADD `actor_id` text;
