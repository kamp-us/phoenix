-- #2691 (epic #2687) — the append-only transactional-email delivery-failure log. The
-- SINGLE source of both the audit trail and the current per-address failing-state: state
-- is a projection of the latest row (see `features/pasaport/email-delivery.ts`), so it can
-- never drift from history. Keyed by `address` (always known from the send) with a nullable
-- `user_id` FK when the address resolves to an account; `ON DELETE set null` keeps the
-- delivery history when the account is deleted. Fed today by the synchronous send-time
-- `SendEmailError` (Child #2691); the admin mark/clear (#2692) and CF async ingestion
-- (#2694) append to the same log.

CREATE TABLE `email_delivery_event` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`address` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `email_delivery_event_address_created` ON `email_delivery_event` (`address`,"created_at" DESC);--> statement-breakpoint
CREATE INDEX `email_delivery_event_user_created` ON `email_delivery_event` (`user_id`,"created_at" DESC);
