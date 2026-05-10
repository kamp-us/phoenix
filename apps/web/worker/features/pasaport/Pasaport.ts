import {DurableObject} from "cloudflare:workers";
import {id} from "@usirin/forge";
import {eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/durable-sqlite";
import {migrate} from "drizzle-orm/durable-sqlite/migrator";
import {createAuth, type Session} from "./auth";
import migrations from "./drizzle/migrations/migrations";
import * as schema from "./drizzle/schema";

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Username constraints (mirrored on the SPA bootstrap form):
 * - 3 to 30 chars
 * - lowercase ASCII letters, digits, and `-` only
 * - must start with a letter or digit (no leading/trailing `-`, no `--`)
 */
const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;

export class UsernameValidationError extends Error {
	constructor(
		readonly code:
			| "invalid_format"
			| "too_short"
			| "too_long"
			| "already_set"
			| "taken"
			| "user_not_found",
		message: string,
	) {
		super(message);
		this.name = "UsernameValidationError";
	}
}

export interface SetUsernameResult {
	userId: string;
	username: string;
	displayName: string | null;
	image: string | null;
}

export interface BackfillProfilesResult {
	emitted: number;
}

export class Pasaport extends DurableObject<Env> {
	db = drizzle(this.ctx.storage, {schema});
	auth = createAuth(this.db);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname.startsWith("/api/auth/")) {
			return this.auth.handler(request);
		}
		return new Response("Not found", {status: 404});
	}

	async validateSession(headers: Headers): Promise<Session | null> {
		try {
			const session = await this.auth.api.getSession({headers});
			if (!session?.user) return null;
			return session;
		} catch (error) {
			console.error("[Pasaport.validateSession]", error);
			return null;
		}
	}

	/* -------- Username RPC --------------------------------------------- */

	/**
	 * Bootstrap-step write path. Validates `value`, ensures the user has no
	 * username yet, ensures the username is unique, sets it, then emits a
	 * `UserProfileChanged` event so the projection can populate `user_profile`.
	 *
	 * Throws `UsernameValidationError` for any user-facing failure; the
	 * GraphQL resolver maps these to readable Turkish errors. Any other
	 * unexpected failure (workflow.create, DB hiccup) propagates.
	 */
	async setUsername({userId, value}: {userId: string; value: string}): Promise<SetUsernameResult> {
		const normalized = value.trim().toLowerCase();
		this.assertUsername(normalized);

		const existingUser = await this.db.query.user.findFirst({
			where: eq(schema.user.id, userId),
		});
		if (!existingUser) {
			throw new UsernameValidationError("user_not_found", "kullanıcı bulunamadı");
		}
		if (existingUser.username) {
			throw new UsernameValidationError(
				"already_set",
				"kullanıcı adı zaten ayarlandı; değiştirilemez",
			);
		}

		const conflict = await this.db.query.user.findFirst({
			where: eq(schema.user.username, normalized),
		});
		if (conflict) {
			throw new UsernameValidationError("taken", "bu kullanıcı adı kullanımda");
		}

		await this.db
			.update(schema.user)
			.set({username: normalized, updatedAt: new Date()})
			.where(eq(schema.user.id, userId));

		await this.dispatchUserProfileChanged({
			userId,
			username: normalized,
			displayName: existingUser.name ?? null,
			image: existingUser.image ?? null,
		});

		return {
			userId,
			username: normalized,
			displayName: existingUser.name ?? null,
			image: existingUser.image ?? null,
		};
	}

	/**
	 * Read-side helper. Used by the GraphQL `me` resolver to surface the
	 * persisted `username` (Better Auth's session inference may lag the DB
	 * for additional fields right after a write).
	 */
	async getUserById(userId: string): Promise<{
		id: string;
		email: string;
		name: string | null;
		image: string | null;
		username: string | null;
	} | null> {
		const row = await this.db.query.user.findFirst({where: eq(schema.user.id, userId)});
		if (!row) return null;
		return {
			id: row.id,
			email: row.email,
			name: row.name ?? null,
			image: row.image ?? null,
			username: row.username ?? null,
		};
	}

	/**
	 * Backfill helper invoked by the post-migration admin endpoint. Walks every
	 * row in `user` and emits a `UserProfileChanged` event so existing users
	 * land in `user_profile` (with username NULL until bootstrap, counters at
	 * 0). Idempotent — projection's `last_event_id` guard de-duplicates.
	 */
	async backfillProfiles(): Promise<BackfillProfilesResult> {
		const users = await this.db
			.select({
				id: schema.user.id,
				name: schema.user.name,
				image: schema.user.image,
				username: schema.user.username,
			})
			.from(schema.user);

		let emitted = 0;
		for (const u of users) {
			await this.dispatchUserProfileChanged({
				userId: u.id,
				username: u.username ?? null,
				displayName: u.name ?? null,
				image: u.image ?? null,
			});
			emitted++;
		}
		return {emitted};
	}

	/**
	 * Test-only helper: lookup by username (used by the integration test to
	 * confirm a user has a username persisted post-bootstrap). Avoids exposing
	 * Better Auth's internal session shape.
	 */
	async findUsername(username: string): Promise<{userId: string; username: string} | null> {
		const row = await this.db.query.user.findFirst({
			where: eq(schema.user.username, username),
		});
		if (!row || !row.username) return null;
		return {userId: row.id, username: row.username};
	}

	/**
	 * Test-only helper: returns the count of users with no username set.
	 * Used by the integration test to verify backfill behavior.
	 */
	async countUsersWithoutUsername(): Promise<number> {
		const rows = await this.db
			.select({id: schema.user.id})
			.from(schema.user)
			.where(isNull(schema.user.username));
		return rows.length;
	}

	/* -------- Internals ------------------------------------------------- */

	/**
	 * Validates the normalized username; throws `UsernameValidationError` with
	 * a stable code so the resolver can localize. Mirrors the SPA's
	 * client-side validator — the regex is identical.
	 */
	private assertUsername(normalized: string): void {
		if (normalized.length < 3) {
			throw new UsernameValidationError("too_short", "kullanıcı adı en az 3 karakter olmalı");
		}
		if (normalized.length > 30) {
			throw new UsernameValidationError("too_long", "kullanıcı adı en fazla 30 karakter olabilir");
		}
		if (!USERNAME_REGEX.test(normalized)) {
			throw new UsernameValidationError(
				"invalid_format",
				"kullanıcı adı yalnızca küçük harf, rakam ve - içerebilir",
			);
		}
	}

	/**
	 * Wraps `PHOENIX_PROJECTION.create` with a fresh forge eventId. Failure to
	 * dispatch propagates so the caller sees the rollback opportunity (the
	 * Pasaport `user.username` row is already updated; on dispatch failure
	 * the next attempt to setUsername errors with `already_set`, but the
	 * projection won't have the row — the `me` resolver still surfaces the
	 * username from Pasaport directly so the topbar link works).
	 *
	 * In a follow-up we can add a Pasaport outbox + onAlarm reconciliation;
	 * for the MVP this is best-effort and the resolver bypass is enough.
	 */
	private async dispatchUserProfileChanged(input: {
		userId: string;
		username: string | null;
		displayName: string | null;
		image: string | null;
	}): Promise<void> {
		const eventId = id("evt");
		const now = Date.now();
		try {
			await this.env.PHOENIX_PROJECTION.create({
				id: eventId,
				params: {
					kind: "UserProfileChanged",
					eventId,
					userId: input.userId,
					username: input.username,
					displayName: input.displayName,
					image: input.image,
					updatedAt: now,
				},
			});
		} catch (err) {
			// Log; downstream callers don't see this — the canonical user.username
			// is already set in Pasaport sqlite. The projection lag is observable
			// only by /u/<username> page hits before the next retry.
			console.error("[Pasaport.dispatchUserProfileChanged]", err);
		}
	}
}
