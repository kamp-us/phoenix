CREATE TABLE `relation_tuple` (
	`subject` text NOT NULL,
	`relation` text NOT NULL,
	`object` text NOT NULL,
	CONSTRAINT `relation_tuple_subject_relation_object_pk` PRIMARY KEY(`subject`, `relation`, `object`)
);
--> statement-breakpoint
CREATE INDEX `relation_tuple_object` ON `relation_tuple` (`object`,`relation`);