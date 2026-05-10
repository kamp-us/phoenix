import {id} from "@usirin/forge";
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

const timestamps = {
	createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
};

export const term = sqliteTable("term", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("term")),
	slug: text("slug").notNull().unique(),
	title: text("title").notNull(),
	...timestamps,
});

/**
 * `authorId` references `user.id` from the Pasaport DO. DOs are storage-isolated,
 * so the FK is intentionally un-enforced — denormalize `authorName` here so the
 * sözlük read path never has to cross-DO call to render a definition.
 */
export const definition = sqliteTable("definition", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("def")),
	termId: text("term_id")
		.notNull()
		.references(() => term.id, {onDelete: "cascade"}),
	authorId: text("author_id").notNull(),
	authorName: text("author_name").notNull(),
	body: text("body").notNull(),
	score: integer("score").notNull().default(0),
	...timestamps,
});
