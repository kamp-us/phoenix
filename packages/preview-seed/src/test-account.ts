/**
 * Provision the single moderator-tier test account a `review-ui` capture authenticates as,
 * and the session row whose token becomes that capture's cookie (issue #7051).
 *
 * Direct-D1 like the rest of this package — never a runtime worker route (CLAUDE.md, "Sözlük
 * seed"). Moderation authority is the `(id, "moderates", key(platform))` tuple, not `user.role`
 * (ADR 0107 §4); the vestigial column is written beside it only so a coarse role read agrees.
 *
 * The throwaway fence is the load-bearing part. A caller-asserted "this is a preview" proves
 * nothing, so the refusal is grounded in the database itself: a preview/stage D1 is deployed
 * empty and this package's content fixtures denormalize their author, so a throwaway carries no
 * human `user` row at all. One that carries somebody else's account is somebody's real world and
 * is refused before any write. The check is emptiness, not throwaway-ness — the README's
 * "guard boundary" section states its exact reach, and the operator still owns `--database-id`.
 *
 * No `account` row is written, and that is deliberate rather than an omission: better-auth
 * resolves a session through `internalAdapter.findSession` (`dist/db/internal-adapter.mjs` at the
 * `1.6.23` pin), which reads `session` by `token` with `join: {user: true}` and touches no
 * `account` table. A session + its user is the whole of what a signed-in request needs; `account`
 * carries credentials for signing IN, which this path skips by construction.
 */
import {key, platform} from "@kampus/authz";
import {and, eq, ne} from "drizzle-orm";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {relationTuple, seedSchema, session, user} from "./schema.ts";

const relations = defineRelations(seedSchema);

export type SeedDb = ReturnType<typeof drizzle<typeof relations>>;

export const makeTestAccountDb = (d1: D1Database): SeedDb => drizzle(d1, {relations});

export const MODERATES = "moderates";
export const PLATFORM = key(platform);

/** better-auth's default session lifetime (`sec("7d")`), so the row expires like a signed-in one. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The one test identity. Fixed so every provision is an upsert on the same row rather than a new
 * account per run, and `.invalid` per RFC 2606 so the address can never reach a mailbox.
 */
export const TEST_ACCOUNT = {
	id: "preview-test-moderator",
	email: "preview-test-moderator@preview.invalid",
	username: "onizleme-mod",
	name: "Önizleme Moderatörü",
	role: "moderator",
	tier: "yazar",
	sessionId: "preview-test-moderator-session",
} as const;

declare const SessionTokenBrand: unique symbol;
/** A session token that has passed {@link parseSessionToken} — the only thing provisioning accepts. */
export type SessionToken = string & {readonly [SessionTokenBrand]: true};

/**
 * better-auth mints a 32-byte session token, and this one is the whole credential for a moderator
 * on a live preview, so a short one is refused rather than written.
 */
export const MIN_SESSION_TOKEN_LEN = 32;

export const parseSessionToken = (raw: string): SessionToken | null =>
	raw.trim().length >= MIN_SESSION_TOKEN_LEN && !/[\s;,]/.test(raw.trim())
		? (raw.trim() as SessionToken)
		: null;

export interface ProvisionReport {
	/** `user` rows written — always 1 (the upsert reports the row it touched). */
	readonly account: number;
	/** `session` rows written — always 1; the token is refreshed to the one just supplied. */
	readonly session: number;
	/** `moderates` tuples newly minted — `0` on a re-run. */
	readonly tuples: number;
	readonly expiresAt: Date;
}

/**
 * Two arms, never one: a refusal must not read as a provision that wrote nothing. `NotThrowaway`
 * names how many foreign accounts were found, which is the fact the operator acts on.
 */
export type ProvisionOutcome =
	| {readonly _tag: "Provisioned"; readonly report: ProvisionReport}
	| {readonly _tag: "NotThrowaway"; readonly foreignAccounts: number};

/**
 * Accounts on this database that are not the test identity and not the `@[silinen]` migration
 * sentinel (ADR 0097) — the evidence the target is somebody's real world.
 */
export const countForeignAccounts = async (db: SeedDb): Promise<number> => {
	const rows = await db
		.select({id: user.id})
		.from(user)
		.where(and(ne(user.id, TEST_ACCOUNT.id), eq(user.type, "human")))
		.all();
	return rows.length;
};

export const provisionTestAccount = async (
	db: SeedDb,
	token: SessionToken,
	now: Date = new Date(),
): Promise<ProvisionOutcome> => {
	const foreignAccounts = await countForeignAccounts(db);
	if (foreignAccounts > 0) return {_tag: "NotThrowaway", foreignAccounts};

	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	const accountRow = {
		id: TEST_ACCOUNT.id,
		name: TEST_ACCOUNT.name,
		email: TEST_ACCOUNT.email,
		type: "human",
		role: TEST_ACCOUNT.role,
		tier: TEST_ACCOUNT.tier,
		emailVerified: true,
		username: TEST_ACCOUNT.username,
		createdAt: now,
		updatedAt: now,
	} as const;
	const sessionRow = {
		id: TEST_ACCOUNT.sessionId,
		userId: TEST_ACCOUNT.id,
		token,
		expiresAt,
		createdAt: now,
		updatedAt: now,
	};

	// One `batch` so the account, its session and its moderation tuple land together or not at all
	// — a session pointing at an unpromoted account renders a çaylak's view and reads as a defect.
	const [, , tuple] = await db.batch([
		db.insert(user).values(accountRow).onConflictDoUpdate({target: user.id, set: accountRow}),
		db.insert(session).values(sessionRow).onConflictDoUpdate({target: session.id, set: sessionRow}),
		db
			.insert(relationTuple)
			.values({subject: TEST_ACCOUNT.id, relation: MODERATES, object: PLATFORM})
			.onConflictDoNothing(),
	]);

	return {
		_tag: "Provisioned",
		report: {account: 1, session: 1, tuples: tuple.meta.changes, expiresAt},
	};
};
