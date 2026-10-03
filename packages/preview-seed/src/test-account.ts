/**
 * Provision the audience-keyed test accounts a `review-ui` capture authenticates as, the session row
 * whose token becomes that capture's cookie (issues #7051, #7398), and the `user_profile` row every
 * profile surface reads (issue #9286).
 *
 * **One account per audience.** A surface whose whole point is that it renders *below* yazar — a
 * çaylak nudge, a pre-promotion prompt — cannot be rendered by an identity that clears the floor,
 * and the shot comes back clean showing the state the PR did not add (#7398). Tier is one axis of
 * an audience and a verified email is another: a çaylak whose address is unverified is refused a
 * write a verified one is granted (#10264). So the identity set is keyed by
 * {@link PREVIEW_IDENTITIES} and a caller provisions whichever identities it holds a token for; an
 * identity with no token is left unseeded, and the capture verb refuses a surface naming it rather
 * than falling back to a seeded one.
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
import {Redacted} from "effect";
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

/**
 * The preview identities, one per audience. The two verified ones are named by their tier alone
 * because they shipped that way (#7051, #7398), and every token variable and capture state written
 * against them still means what it said.
 */
export const PREVIEW_IDENTITIES = ["yazar", "çaylak", "çaylak-unverified"] as const;
export type PreviewIdentity = (typeof PREVIEW_IDENTITIES)[number];

export interface TestAccount {
	readonly id: string;
	readonly email: string;
	readonly username: string;
	readonly name: string;
	readonly role: "member" | "moderator";
	readonly tier: PreviewTier;
	/** better-auth's core `emailVerified` column, which the email-verified write gate reads. */
	readonly emailVerified: boolean;
	readonly sessionId: string;
	/** Whether this identity is granted the platform `moderates` tuple. */
	readonly moderates: boolean;
}

/**
 * The test identities, one per audience. Each is fixed so every provision is an upsert on the same
 * row rather than a new account per run, and `.invalid` per RFC 2606 so no address can reach a
 * mailbox. The yazar's id is the one #7051 shipped and is unchanged — `admin-grant` invocations and
 * preview D1s in flight name it.
 */
export const TEST_ACCOUNTS = {
	yazar: {
		id: "preview-test-moderator",
		email: "preview-test-moderator@preview.invalid",
		username: "onizleme-mod",
		name: "Önizleme Moderatörü",
		role: "moderator",
		tier: "yazar",
		emailVerified: true,
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
		emailVerified: true,
		sessionId: "preview-test-caylak-session",
		moderates: false,
	},
	"çaylak-unverified": {
		id: "preview-test-caylak-unverified",
		email: "preview-test-caylak-unverified@preview.invalid",
		username: "onizleme-caylak-dogrulanmamis",
		name: "Önizleme Çaylağı (doğrulanmamış)",
		role: "member",
		tier: "çaylak",
		emailVerified: false,
		sessionId: "preview-test-caylak-unverified-session",
		moderates: false,
	},
} as const satisfies Record<PreviewIdentity, TestAccount>;

declare const SessionTokenBrand: unique symbol;
/**
 * A session token that has passed {@link parseSessionToken} — the only thing provisioning accepts.
 * It stays `Redacted` from the read to the one row that stores it, so a log line, an error or a
 * `JSON.stringify` of anything holding it prints `<redacted>` rather than a live login.
 */
export type SessionToken = Redacted.Redacted<string> & {readonly [SessionTokenBrand]: true};

/**
 * better-auth mints a 32-byte session token, and each one here is the whole credential for a live
 * preview identity, so a short one is refused rather than written.
 */
export const MIN_SESSION_TOKEN_LEN = 32;

export const parseSessionToken = (raw: Redacted.Redacted<string>): SessionToken | null => {
	const trimmed = Redacted.value(raw).trim();
	return trimmed.length >= MIN_SESSION_TOKEN_LEN && !/[\s;,]/.test(trimmed)
		? (Redacted.make(trimmed) as SessionToken)
		: null;
};

/**
 * One token per identity to provision. An identity absent here is one this run does not seed — the
 * record shape is what makes "the same identity twice" unrepresentable.
 */
export type PreviewCredentials = Partial<Readonly<Record<PreviewIdentity, SessionToken>>>;

/**
 * The identity a standing is about, and the identity that can vouch for it (ADR 0107 §4). The
 * standing is the verified çaylak's: the unverified one is its own audience and never carries one.
 */
export const CANDIDATE_IDENTITY = "çaylak" satisfies PreviewIdentity;
export const VOUCHER_IDENTITY = "yazar" satisfies PreviewIdentity;

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
	/**
	 * The identities provisioned, in {@link PREVIEW_IDENTITIES} order — one `user`, one `session`
	 * and one `user_profile` row each.
	 */
	readonly identities: readonly PreviewIdentity[];
	/** `moderates` tuples newly minted — `0` on a re-run, and `0` when no moderating identity was seeded. */
	readonly tuples: number;
	readonly expiresAt: Date;
}

/**
 * Four arms, never one: a refusal must not read as a provision that wrote nothing. `NotThrowaway`
 * names the database name that failed the fence, which is the fact the operator acts on;
 * `NoCredentials` says the run named no identity at all rather than seeding a default one; and
 * `StandingNeedsIdentity` names the identity whose absence makes the requested standing unwritable — the
 * `candidate` this standing is about, or the `voucher` a `kefil` needs. `authorship_vouch` carries
 * no foreign keys (migration `0013`), so a vouch written past that refusal would be a dangling
 * `voucher_id` nothing in the database catches and no read resolves.
 */
export type ProvisionOutcome =
	| {readonly _tag: "Provisioned"; readonly report: ProvisionReport}
	| {readonly _tag: "NotThrowaway"; readonly databaseName: string}
	| {readonly _tag: "NoCredentials"}
	| {
			readonly _tag: "StandingNeedsIdentity";
			readonly missing: PreviewIdentity;
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

/**
 * The base rows for one identity: its `user`, its `session`, and the `user_profile` row every profile
 * surface reads. `Pasaport.lookupProfile` and `Pasaport.lookupProfileById` in
 * `apps/web/worker/features/pasaport/Pasaport.ts` both answer `null` when that row is absent, so an
 * identity seeded without one is a 404 on `/u/<username>` and has nothing to hydrate on `/profile`
 * (#9286) — which reads as a seeding failure, since the verb exits 0 either way.
 *
 * The profile upsert sets `total_karma` on INSERT only: the `do update set` list omits it, so a
 * re-run against an already-seeded preview leaves the karma standing where it was, and the standing
 * rows later in the same batch still win for the run that names one.
 */
const accountRows = (
	db: SeedDb,
	identity: PreviewIdentity,
	token: SessionToken,
	now: Date,
	expiresAt: Date,
): readonly [Statement, Statement, Statement] => {
	const account = TEST_ACCOUNTS[identity];
	const accountRow = {
		id: account.id,
		name: account.name,
		email: account.email,
		type: "human",
		role: account.role,
		tier: account.tier,
		emailVerified: account.emailVerified,
		username: account.username,
		createdAt: now,
		updatedAt: now,
	} as const;
	const sessionRow = {
		id: account.sessionId,
		userId: account.id,
		// The one place a token is unwrapped: the row that stores it.
		token: Redacted.value(token),
		expiresAt,
		createdAt: now,
		updatedAt: now,
	};
	const profileRow = {
		userId: account.id,
		username: account.username,
		displayName: account.name,
		updatedAt: now,
	};
	return [
		db.insert(user).values(accountRow).onConflictDoUpdate({target: user.id, set: accountRow}),
		db.insert(session).values(sessionRow).onConflictDoUpdate({target: session.id, set: sessionRow}),
		db
			.insert(userProfile)
			.values(profileRow)
			.onConflictDoUpdate({target: userProfile.userId, set: profileRow}),
	];
};

/**
 * The standing rows for the çaylak, written beside its account, session and base profile row in the
 * same batch — and after them, so this upsert's `total_karma` is what the run lands.
 * Karma is SET, never incremented, and a standing without a `kefil` DELETES any vouch the previous
 * run left — re-seeding the other fork of the promotion path is the whole capture route (#7708),
 * so a leftover row would render the state the operator just asked to leave.
 */
const standingRows = (
	db: SeedDb,
	standing: CaylakStanding,
	now: Date,
): readonly [Statement, Statement] => {
	const candidate = TEST_ACCOUNTS[CANDIDATE_IDENTITY];
	const profileRow = {
		userId: candidate.id,
		username: candidate.username,
		displayName: candidate.name,
		totalKarma: standing.karma,
		updatedAt: now,
	};
	const vouchRow = {
		voucherId: TEST_ACCOUNTS[VOUCHER_IDENTITY].id,
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

	const requested = PREVIEW_IDENTITIES.flatMap((identity) => {
		const token = credentials[identity];
		return token === undefined ? [] : [{identity, token}];
	});
	const [head, ...rest] = requested;
	if (head === undefined) return {_tag: "NoCredentials"};

	if (standing !== null) {
		const seeded = requested.map(({identity}) => identity);
		if (!seeded.includes(CANDIDATE_IDENTITY)) {
			return {_tag: "StandingNeedsIdentity", missing: CANDIDATE_IDENTITY, role: "candidate"};
		}
		if (standing.kefil && !seeded.includes(VOUCHER_IDENTITY)) {
			return {_tag: "StandingNeedsIdentity", missing: VOUCHER_IDENTITY, role: "voucher"};
		}
	}

	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
	const rows = [
		...accountRows(db, head.identity, head.token, now, expiresAt),
		...rest.flatMap(({identity, token}) => accountRows(db, identity, token, now, expiresAt)),
		...(standing === null ? [] : standingRows(db, standing, now)),
	] as const;
	const tuples = requested
		.filter(({identity}) => TEST_ACCOUNTS[identity].moderates)
		.map(({identity}) =>
			db
				.insert(relationTuple)
				.values({subject: TEST_ACCOUNTS[identity].id, relation: MODERATES, object: PLATFORM})
				.onConflictDoNothing(),
		);

	// One `batch` so every account, its session, its profile, its moderation tuple and its standing
	// land together or not at all — a session pointing at an unpromoted account renders a çaylak's
	// view under the yazar's name, and a karma row without its vouch row renders a standing nobody
	// asked for.
	const results = await db.batch([...rows, ...tuples]);

	return {
		_tag: "Provisioned",
		report: {
			identities: requested.map(({identity}) => identity),
			tuples: results.slice(rows.length).reduce((total, result) => total + result.meta.changes, 0),
			expiresAt,
		},
	};
};
