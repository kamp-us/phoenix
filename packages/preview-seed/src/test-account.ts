/**
 * Provision the tier-keyed test accounts a `review-ui` capture authenticates as, and the session
 * row whose token becomes that capture's cookie (issues #7051, #7398).
 *
 * **One account per tier, because a tier is an audience.** A surface whose whole point is that it
 * renders *below* yazar — a çaylak nudge, a pre-promotion prompt — cannot be rendered by an
 * identity that clears the floor, and the shot comes back clean showing the state the PR did not
 * add (#7398). So the identity set is keyed by {@link PREVIEW_TIERS} and a caller provisions
 * whichever tiers it holds a token for; a tier with no token is left unseeded, and the capture verb
 * refuses a surface naming it rather than falling back to a seeded one.
 *
 * **A tier is not a standing.** Where the çaylak sits on the promotion path — its karma and whether
 * a kefil exists — is a second axis, and the path forks on it into two compositions that look
 * nothing alike (#7708). {@link CaylakStanding} names a point on it; a run that names none leaves
 * both standing tables untouched.
 *
 * Direct-D1 like the rest of this package — never a runtime worker route (CLAUDE.md, "Sözlük
 * seed"). Moderation authority is the `(id, "moderates", key(platform))` tuple, not `user.role`
 * (ADR 0107 §4); the vestigial column is written beside it only so a coarse role read agrees. Only
 * the yazar identity carries that tuple: a çaylak with moderation authority is not a çaylak.
 *
 * The throwaway fence is the load-bearing part, and what it reads is the database's NAME. A
 * caller-asserted "this is a preview" proves nothing, so the fence reads a fact the deploy stack
 * sets and the caller cannot: Cloudflare's own record for the given `--database-id`. A per-PR
 * preview is `phoenix-phoenix-db-pr-<n>-…`; anything else — `…-prod-…`, a renamed stage, a name
 * the API declines to give — is refused before any write. `ResolvedDatabaseName` holds that origin
 * open in the type: `resolveDatabaseName` is its only mint, so the fence's own parameter refuses a
 * name a caller composed before any rule about its shape is applied. It replaced an emptiness check that
 * could never pass in practice, because CI's e2e suite signs human users up on every preview it
 * tests — see ADR 0349 (#7740, founder ruling
 * https://github.com/kamp-us/phoenix/issues/7740#issuecomment-5535874078).
 *
 * No `account` row is written, and that is deliberate rather than an omission: better-auth
 * resolves a session through `internalAdapter.findSession` (`dist/db/internal-adapter.mjs` at the
 * `1.6.23` pin), which reads `session` by `token` with `join: {user: true}` and touches no
 * `account` table. A session + its user is the whole of what a signed-in request needs; `account`
 * carries credentials for signing IN, which this path skips by construction.
 */
import {key, platform} from "@kampus/authz";
import type {ResolvedDatabaseName} from "@kampus/d1-rest";
import {eq} from "drizzle-orm";
import type {BatchItem} from "drizzle-orm/batch";
import {drizzle} from "drizzle-orm/d1";
import {defineRelations} from "drizzle-orm/relations";
import {authorshipVouch, relationTuple, seedSchema, session, user, userProfile} from "./schema.ts";

const relations = defineRelations(seedSchema);

export type SeedDb = ReturnType<typeof drizzle<typeof relations>>;

export const makeTestAccountDb = (d1: D1Database): SeedDb => drizzle(d1, {relations});

export const MODERATES = "moderates";
export const PLATFORM = key(platform);

/** better-auth's default session lifetime (`sec("7d")`), so the row expires like a signed-in one. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The authorship tiers a preview identity can be provisioned at — the `user.tier` enum's own
 * values, so a tier that does not exist in the schema cannot be named here.
 */
export const PREVIEW_TIERS = ["yazar", "çaylak"] as const;
export type PreviewTier = (typeof PREVIEW_TIERS)[number];

export interface TestAccount {
	readonly id: string;
	readonly email: string;
	readonly username: string;
	readonly name: string;
	readonly role: "member" | "moderator";
	readonly tier: PreviewTier;
	readonly sessionId: string;
	/** Whether this identity is granted the platform `moderates` tuple. */
	readonly moderates: boolean;
}

/**
 * The test identities, one per tier. Each is fixed so every provision is an upsert on the same row
 * rather than a new account per run, and `.invalid` per RFC 2606 so no address can reach a mailbox.
 * The yazar's id is the one #7051 shipped and is unchanged — `admin-grant` invocations and preview
 * D1s in flight name it.
 */
export const TEST_ACCOUNTS = {
	yazar: {
		id: "preview-test-moderator",
		email: "preview-test-moderator@preview.invalid",
		username: "onizleme-mod",
		name: "Önizleme Moderatörü",
		role: "moderator",
		tier: "yazar",
		sessionId: "preview-test-moderator-session",
		moderates: true,
	},
	çaylak: {
		id: "preview-test-caylak",
		email: "preview-test-caylak@preview.invalid",
		username: "onizleme-caylak",
		name: "Önizleme Çaylağı",
		role: "member",
		tier: "çaylak",
		sessionId: "preview-test-caylak-session",
		moderates: false,
	},
} as const satisfies Record<PreviewTier, TestAccount>;

declare const SessionTokenBrand: unique symbol;
/** A session token that has passed {@link parseSessionToken} — the only thing provisioning accepts. */
export type SessionToken = string & {readonly [SessionTokenBrand]: true};

/**
 * better-auth mints a 32-byte session token, and each one here is the whole credential for a live
 * preview identity, so a short one is refused rather than written.
 */
export const MIN_SESSION_TOKEN_LEN = 32;

export const parseSessionToken = (raw: string): SessionToken | null =>
	raw.trim().length >= MIN_SESSION_TOKEN_LEN && !/[\s;,]/.test(raw.trim())
		? (raw.trim() as SessionToken)
		: null;

/**
 * One token per tier to provision. A tier absent here is a tier this run does not seed — the
 * record shape is what makes "the same tier twice" unrepresentable.
 */
export type PreviewCredentials = Partial<Readonly<Record<PreviewTier, SessionToken>>>;

/** The tier a standing is about, and the tier whose identity can vouch for it (ADR 0107 §4). */
export const CANDIDATE_TIER = "çaylak" satisfies PreviewTier;
export const VOUCHER_TIER = "yazar" satisfies PreviewTier;

declare const KarmaBrand: unique symbol;
/** A karma total that has passed {@link parseStanding} — a non-negative safe integer. */
export type Karma = number & {readonly [KarmaBrand]: true};

/**
 * Where on the çaylak→yazar promotion path a provisioned identity stands (#7708). Both fields
 * always travel together, because the path forks on `kefil` and reads `karma` against a bar chosen
 * by that fork (`promotionBarFor` in the worker's `features/kunye/standing.ts`) — a standing
 * carrying one without the other names no renderable state.
 */
export interface CaylakStanding {
	readonly karma: Karma;
	readonly kefil: boolean;
}

/** The suffix that turns a karma total into a vouched standing: `15+kefil`. */
export const KEFIL_SUFFIX = "+kefil";

/**
 * The single operand form, so a partial standing is unrepresentable at the CLI boundary too: one
 * flag either yields both fields or is refused. `\d+` and not a signed parse — a negative total is
 * not a point on the ladder, and `Number("-1")` would otherwise seed one.
 */
export const parseStanding = (raw: string): CaylakStanding | null => {
	const trimmed = raw.trim();
	const kefil = trimmed.endsWith(KEFIL_SUFFIX);
	const karmaText = kefil ? trimmed.slice(0, -KEFIL_SUFFIX.length) : trimmed;
	if (!/^\d+$/.test(karmaText)) return null;
	const karma = Number(karmaText);
	return Number.isSafeInteger(karma) ? {karma: karma as Karma, kefil} : null;
};

export interface ProvisionReport {
	/** The tiers provisioned, in {@link PREVIEW_TIERS} order — one `user` + one `session` row each. */
	readonly tiers: readonly PreviewTier[];
	/** `moderates` tuples newly minted — `0` on a re-run, and `0` when no moderating tier was seeded. */
	readonly tuples: number;
	readonly expiresAt: Date;
}

/**
 * Four arms, never one: a refusal must not read as a provision that wrote nothing. `NotThrowaway`
 * names the database name that failed the fence, which is the fact the operator acts on;
 * `NoCredentials` says the run named no tier at all rather than seeding a default one; and
 * `StandingNeedsTier` names the tier whose absence makes the requested standing unwritable — the
 * `candidate` this standing is about, or the `voucher` a `kefil` needs. `authorship_vouch` carries
 * no foreign keys (migration `0013`), so a vouch written past that refusal would be a dangling
 * `voucher_id` nothing in the database catches and no read resolves.
 */
export type ProvisionOutcome =
	| {readonly _tag: "Provisioned"; readonly report: ProvisionReport}
	| {readonly _tag: "NotThrowaway"; readonly databaseName: string}
	| {readonly _tag: "NoCredentials"}
	| {
			readonly _tag: "StandingNeedsTier";
			readonly missing: PreviewTier;
			readonly role: "candidate" | "voucher";
	  };

/**
 * The substring that makes a D1 name a per-PR preview's. alchemy composes a preview database as
 * `phoenix-phoenix-db-pr-<n>-<hash>`, so the PR segment is the one part of the name no other stage
 * carries: production is `…-db-prod-…` and a named dev stage is `…-db-<stage>-…`, neither of which
 * contains it.
 */
export const PREVIEW_NAME_MARKER = "-pr-";

/**
 * Whether a D1 name is a throwaway per-PR preview's. Fail closed: only a name carrying
 * {@link PREVIEW_NAME_MARKER} is throwaway, and everything else — production, a renamed stage, an
 * empty string — is not.
 *
 * `string`, not {@link ResolvedDatabaseName}, and deliberately: this is the shape rule, total over
 * any text, and it answers `false` for text no mint could ever produce. Where the name has to have
 * come from Cloudflare is {@link provisionTestAccounts}'s parameter, which is the fence itself.
 */
export const isThrowawayDatabaseName = (name: string): boolean =>
	name.includes(PREVIEW_NAME_MARKER);

type Statement = BatchItem<"sqlite">;

const accountRows = (
	db: SeedDb,
	tier: PreviewTier,
	token: SessionToken,
	now: Date,
	expiresAt: Date,
): readonly [Statement, Statement] => {
	const account = TEST_ACCOUNTS[tier];
	const accountRow = {
		id: account.id,
		name: account.name,
		email: account.email,
		type: "human",
		role: account.role,
		tier: account.tier,
		emailVerified: true,
		username: account.username,
		createdAt: now,
		updatedAt: now,
	} as const;
	const sessionRow = {
		id: account.sessionId,
		userId: account.id,
		token,
		expiresAt,
		createdAt: now,
		updatedAt: now,
	};
	return [
		db.insert(user).values(accountRow).onConflictDoUpdate({target: user.id, set: accountRow}),
		db.insert(session).values(sessionRow).onConflictDoUpdate({target: session.id, set: sessionRow}),
	];
};

/**
 * The standing rows for the çaylak, written beside its account and session in the same batch.
 * Karma is SET, never incremented, and a standing without a `kefil` DELETES any vouch the previous
 * run left — re-seeding the other fork of the promotion path is the whole capture route (#7708),
 * so a leftover row would render the state the operator just asked to leave.
 */
const standingRows = (
	db: SeedDb,
	standing: CaylakStanding,
	now: Date,
): readonly [Statement, Statement] => {
	const candidate = TEST_ACCOUNTS[CANDIDATE_TIER];
	const profileRow = {
		userId: candidate.id,
		username: candidate.username,
		displayName: candidate.name,
		totalKarma: standing.karma,
		updatedAt: now,
	};
	const vouchRow = {
		voucherId: TEST_ACCOUNTS[VOUCHER_TIER].id,
		candidateId: candidate.id,
		createdAt: now,
	};
	return [
		db
			.insert(userProfile)
			.values(profileRow)
			.onConflictDoUpdate({target: userProfile.userId, set: profileRow}),
		standing.kefil
			? db.insert(authorshipVouch).values(vouchRow).onConflictDoNothing()
			: db.delete(authorshipVouch).where(eq(authorshipVouch.candidateId, candidate.id)),
	];
};

/**
 * `databaseName` is Cloudflare's record for the target id, and {@link ResolvedDatabaseName} is what
 * makes that a type fact rather than a docblock: `resolveDatabaseName` is the only mint, so a label
 * the caller composed does not fit this parameter and cannot reach the fence. The fence is decided
 * first, so a run against a real database is refused on the same answer whatever tokens it was
 * handed.
 */
export const provisionTestAccounts = async (
	db: SeedDb,
	databaseName: ResolvedDatabaseName,
	credentials: PreviewCredentials,
	standing: CaylakStanding | null = null,
	now: Date = new Date(),
): Promise<ProvisionOutcome> => {
	if (!isThrowawayDatabaseName(databaseName)) return {_tag: "NotThrowaway", databaseName};

	const requested = PREVIEW_TIERS.flatMap((tier) => {
		const token = credentials[tier];
		return token === undefined ? [] : [{tier, token}];
	});
	const [head, ...rest] = requested;
	if (head === undefined) return {_tag: "NoCredentials"};

	if (standing !== null) {
		const seeded = requested.map(({tier}) => tier);
		if (!seeded.includes(CANDIDATE_TIER)) {
			return {_tag: "StandingNeedsTier", missing: CANDIDATE_TIER, role: "candidate"};
		}
		if (standing.kefil && !seeded.includes(VOUCHER_TIER)) {
			return {_tag: "StandingNeedsTier", missing: VOUCHER_TIER, role: "voucher"};
		}
	}

	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	const rows = [
		...accountRows(db, head.tier, head.token, now, expiresAt),
		...rest.flatMap(({tier, token}) => accountRows(db, tier, token, now, expiresAt)),
		...(standing === null ? [] : standingRows(db, standing, now)),
	] as const;
	const tuples = requested
		.filter(({tier}) => TEST_ACCOUNTS[tier].moderates)
		.map(({tier}) =>
			db
				.insert(relationTuple)
				.values({subject: TEST_ACCOUNTS[tier].id, relation: MODERATES, object: PLATFORM})
				.onConflictDoNothing(),
		);

	// One `batch` so every account, its session, its moderation tuple and its standing land together
	// or not at all — a session pointing at an unpromoted account renders a çaylak's view under the
	// yazar's name, and a karma row without its vouch row renders a standing nobody asked for.
	const results = await db.batch([...rows, ...tuples]);

	return {
		_tag: "Provisioned",
		report: {
			tiers: requested.map(({tier}) => tier),
			tuples: results.slice(rows.length).reduce((total, result) => total + result.meta.changes, 0),
			expiresAt,
		},
	};
};
