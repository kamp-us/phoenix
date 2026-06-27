-- #107 — imge per-object metadata (ADR 0044 Decision 1): bytes live in R2, this row
-- holds owner / content-type / byte-size / optional pixel dimensions / R2 key /
-- created-at. `id` is the opaque, non-enumerable object key (content-hash or random
-- id, never sequential — Decision 5b) that appears in the public delivery URL. No FK
-- to `user`: deleting the uploader (or their apiKey) must NOT cascade-delete the
-- object — "URLs never break" is a v1 contract (Decision 5). The (owner_id,
-- created_at) index serves the per-user count/sum-per-window quota query (#110).

CREATE TABLE `imge_object` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`r2_key` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `imge_object_owner_created` ON `imge_object` (`owner_id`,`created_at`);
