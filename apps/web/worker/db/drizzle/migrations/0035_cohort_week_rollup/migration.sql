CREATE TABLE `cohort_week_rollup` (
	`cohort_week` text PRIMARY KEY NOT NULL,
	`signed_up` integer NOT NULL,
	`returned_days_2_to_7` integer NOT NULL,
	`first_contributed_7d` integer NOT NULL,
	`vouched_7d` integer NOT NULL,
	`promoted_7d` integer NOT NULL,
	`d1_returned` integer NOT NULL,
	`d7_returned` integer NOT NULL,
	`d1_return_rate` real NOT NULL,
	`d7_return_rate` real NOT NULL
);
