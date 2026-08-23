CREATE TABLE `user_activity_day` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	PRIMARY KEY(`user_id`, `day`)
);
