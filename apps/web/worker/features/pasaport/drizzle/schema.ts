import {id} from "@usirin/forge";
import {integer, sqliteTable, text} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, {mode: "timestamp"});

const timestamps = {
	createdAt: timestamp("created_at").$defaultFn(() => new Date()),
	updatedAt: timestamp("updated_at").$defaultFn(() => new Date()),
};

export const user = sqliteTable("user", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("user")),
	name: text("name"),
	email: text("email").notNull(),
	image: text("image"),
	type: text("type", {enum: ["human", "bot"]})
		.notNull()
		.default("human"),
	emailVerified: integer("email_verified", {mode: "boolean"}),
	...timestamps,
});

export const session = sqliteTable("session", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("sesh")),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").unique(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	...timestamps,
});

export const account = sqliteTable("account", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("acc")),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	accountId: text("account_id"),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	idToken: text("id_token"),
	password: text("password"),
	...timestamps,
});

export const verification = sqliteTable("verification", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("vxn")),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	...timestamps,
});

export const apikey = sqliteTable("apiKey", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => id("api_key")),
	name: text("name"),
	start: text("start"),
	prefix: text("prefix"),
	key: text("key").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, {onDelete: "cascade"}),
	refillInterval: integer("refill_interval"),
	refillAmount: integer("refill_amount"),
	lastRefillAt: integer("last_refill_at", {mode: "timestamp"}),
	enabled: integer("enabled", {mode: "boolean"}).notNull().default(true),
	rateLimitEnabled: integer("rate_limit_enabled", {mode: "boolean"}).notNull().default(false),
	rateLimitTimeWindow: integer("rate_limit_time_window"),
	rateLimitMax: integer("rate_limit_max"),
	requestCount: integer("request_count").notNull().default(0),
	remaining: integer("remaining"),
	lastRequest: integer("last_request", {mode: "timestamp"}),
	expiresAt: integer("expires_at", {mode: "timestamp"}),
	permissions: text("permissions"),
	metadata: text("metadata"),
	...timestamps,
});
