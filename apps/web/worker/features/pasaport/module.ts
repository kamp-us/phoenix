/**
 * Pasaport — D1-direct module (task_3, d1-direct).
 *
 * Every function in this file writes (or reads) `env.PHOENIX_DB` directly via
 * drizzle. There is no Durable Object boundary, no workflow `create`, and no
 * projection step. The legacy `Pasaport` DO class still exists for one
 * structural-deletion task more (task_4 deletes it), but is unreferenced by
 * every production code path.
 *
 * Surface:
 *   - `handleAuth(env, request)` — better-auth handler, mounted at `/api/auth/*`.
 *   - `validateSession(env, headers)` — per-request session validation.
 *   - `setUsername(env, { userId, value })` — bootstrap-step write path.
 *   - `getUserById(env, id)` — read helper for the `me` resolver and Relay node().
 *   - `findUsername(env, username)` — test-only / admin helper.
 *   - `countUsersWithoutUsername(env)` — admin/backfill helper.
 *   - `backfillProfiles(env)` — populates `user_profile` rows for legacy users.
 *
 * `setUsername` and `backfillProfiles` upsert the canonical `user_profile`
 * row inline (no `UserProfileChanged` event, no projection workflow). The
 * read-side aggregates (`total_karma`, `*_count`) still derive live from the
 * per-kind tables in `userProfileReader.ts`.
 */
import {eq, isNull} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import * as schema from "../../db/drizzle/schema";
import {createAuth, type Session} from "./auth";

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

export interface UserRow {
	id: string;
	email: string;
	name: string | null;
	image: string | null;
	username: string | null;
}

function assertUsername(normalized: string): void {
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

/* -------------------------------------------------------------------------- */
/* Auth handler + session validation                                           */
/* -------------------------------------------------------------------------- */

/**
 * Handle a `/api/auth/*` request via better-auth. The router in
 * `worker/index.ts` forwards every matching request straight to here; the
 * better-auth instance is constructed per-call because `createAuth` is cheap
 * (it doesn't touch the network or D1 on init) and binding it to module scope
 * would couple the lifetime to the worker isolate rather than the request.
 */
export async function handleAuth(env: Env, request: Request): Promise<Response> {
	const auth = createAuth(env.PHOENIX_DB);
	return auth.handler(request);
}

/**
 * Resolve the per-request session via better-auth's `getSession`. Returns
 * `null` for anonymous traffic or on any internal failure (logged + swallowed
 * so a flaky auth lookup doesn't 500 every request).
 */
export async function validateSession(env: Env, headers: Headers): Promise<Session | null> {
	try {
		const auth = createAuth(env.PHOENIX_DB);
		const session = await auth.api.getSession({headers});
		if (!session?.user) return null;
		return session;
	} catch (error) {
		console.error("[pasaport.validateSession]", error);
		return null;
	}
}

/* -------------------------------------------------------------------------- */
/* User lookups                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read-side helper for the `me` resolver and the `node(id)` dispatch on
 * `User`. Returns the canonical row including the persisted `username`
 * (which may lag better-auth's inferred session shape immediately after a
 * `setUsername` write).
 */
export async function getUserById(env: Env, userId: string): Promise<UserRow | null> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.user.findFirst({where: eq(schema.user.id, userId)});
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
 * Lookup by username. Used by the integration test to verify a row was
 * persisted post-bootstrap.
 */
export async function findUsername(
	env: Env,
	username: string,
): Promise<{userId: string; username: string} | null> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const row = await db.query.user.findFirst({where: eq(schema.user.username, username)});
	if (!row || !row.username) return null;
	return {userId: row.id, username: row.username};
}

/**
 * Counts users with no username set. Used by the integration test to
 * verify backfill emits at least one event.
 */
export async function countUsersWithoutUsername(env: Env): Promise<number> {
	const db = drizzle(env.PHOENIX_DB, {schema});
	const rows = await db
		.select({id: schema.user.id})
		.from(schema.user)
		.where(isNull(schema.user.username));
	return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bootstrap-step write path. Validates `value`, ensures the user has no
 * username yet, ensures the username is unique, sets it, and upserts the
 * matching `user_profile` row in the same D1 batch.
 *
 * Throws `UsernameValidationError` for any user-facing failure; the
 * `resolver()` wrapper routes that through `encodeMutationError` for the
 * wire-format code. Other errors propagate as defects.
 */
export async function setUsername(
	env: Env,
	args: {userId: string; value: string},
): Promise<SetUsernameResult> {
	const {userId} = args;
	const normalized = args.value.trim().toLowerCase();
	assertUsername(normalized);

	const db = drizzle(env.PHOENIX_DB, {schema});

	const existingUser = await db.query.user.findFirst({where: eq(schema.user.id, userId)});
	if (!existingUser) {
		throw new UsernameValidationError("user_not_found", "kullanıcı bulunamadı");
	}
	if (existingUser.username) {
		throw new UsernameValidationError(
			"already_set",
			"kullanıcı adı zaten ayarlandı; değiştirilemez",
		);
	}

	const conflict = await db.query.user.findFirst({
		where: eq(schema.user.username, normalized),
	});
	if (conflict) {
		throw new UsernameValidationError("taken", "bu kullanıcı adı kullanımda");
	}

	const now = new Date();

	await db
		.update(schema.user)
		.set({username: normalized, updatedAt: now})
		.where(eq(schema.user.id, userId));

	await upsertProfileIdentity(env, {
		userId,
		username: normalized,
		displayName: existingUser.name ?? null,
		image: existingUser.image ?? null,
		updatedAtSec: Math.floor(now.getTime() / 1000),
	});

	return {
		userId,
		username: normalized,
		displayName: existingUser.name ?? null,
		image: existingUser.image ?? null,
	};
}

/**
 * Backfill `user_profile` rows for every existing user. Walks the `user`
 * table and upserts an identity row per user — username column stays NULL
 * for users that haven't completed bootstrap.
 *
 * Idempotent: re-running just re-asserts the same identity values for users
 * that already have a profile row, with no impact on counter columns.
 */
export async function backfillProfiles(env: Env): Promise<BackfillProfilesResult> {
	const db = drizzle(env.PHOENIX_DB, {schema});

	const users = await db
		.select({
			id: schema.user.id,
			name: schema.user.name,
			image: schema.user.image,
			username: schema.user.username,
		})
		.from(schema.user);

	const nowSec = Math.floor(Date.now() / 1000);
	let emitted = 0;
	for (const u of users) {
		await upsertProfileIdentity(env, {
			userId: u.id,
			username: u.username ?? null,
			displayName: u.name ?? null,
			image: u.image ?? null,
			updatedAtSec: nowSec,
		});
		emitted++;
	}
	return {emitted};
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Upsert the identity portion of a `user_profile` row. Counter columns
 * (`total_karma`, `*_count`) default to 0 on insert and are left untouched on
 * update — vote/contribution writes own those columns.
 *
 * `COALESCE` on username preserves a previously-set handle if a stale
 * backfill run hits the row after the bootstrap step.
 */
async function upsertProfileIdentity(
	env: Env,
	args: {
		userId: string;
		username: string | null;
		displayName: string | null;
		image: string | null;
		updatedAtSec: number;
	},
): Promise<void> {
	await env.PHOENIX_DB.prepare(
		`INSERT INTO user_profile (
			user_id, username, display_name, image,
			total_karma, definition_count, post_count, comment_count,
			updated_at
		) VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			username      = COALESCE(excluded.username, user_profile.username),
			display_name  = excluded.display_name,
			image         = excluded.image,
			updated_at    = excluded.updated_at`,
	)
		.bind(args.userId, args.username, args.displayName, args.image, args.updatedAtSec)
		.run();
}
