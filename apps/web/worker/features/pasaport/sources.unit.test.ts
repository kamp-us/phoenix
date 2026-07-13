/**
 * Unit coverage for the pasaport fate **loader** seam — the logic that lives ONLY
 * in `sources.ts` and is exercised by no other test through the source interface
 * (#1361). Two handlers carry source-local logic:
 *
 *   - `userSource.byIds` — the per-row `isModerator` merge (ADR 0107): joins the
 *     `(id, "moderates", platform)` membership read onto each `UserRow`. Its tested
 *     twin is the self `me` path (`queries.unit.test.ts`), a DIFFERENT code path.
 *   - `profileSource.byId` — the `toProfile`-wrap (stamps the client-normalization
 *     `id === userId`) plus the silent-miss return.
 *
 * Plus the two loader-contract invariants the seam exists to uphold (ADR 0016):
 * **membership-stability** (`byIds` rows are a pure function of the id SET — reorder
 * the ids, get the same rows) and **silent-read** (a miss is `null`/fewer rows,
 * never a raised failure). `Pasaport` and `RelationStore` are substituted; no DB,
 * no live worker (ADR 0082 — the unit tier).
 */

import {it} from "@effect/vitest";
import {AgentAuthority, CurrentActor, human, RelationStore, unauthenticated} from "@kampus/authz";
import {CurrentUser, type CurrentUserInfo} from "@kampus/fate-effect";
import {Effect} from "effect";
import {assert} from "vitest";
import type {SandboxViewer} from "../lifecycle/EntityLifecycle.ts";
import type {ProfileRow, UserRow} from "./Pasaport.ts";
import {Pasaport} from "./Pasaport.ts";
import {profileSource, userSource} from "./sources.ts";

/** Narrow an optional handler without a non-null assertion (mirrors Source.unit.test.ts). */
const required = <T>(value: T | undefined): T => {
	if (value === undefined) {
		throw new Error("expected the handler to be present");
	}
	return value;
};

const userByIds = required(userSource.handlers.byIds);
const profileById = required(profileSource.handlers.byId);

const storedUser = (id: string): UserRow => ({
	id,
	email: `${id}@kamp.us`,
	name: `User ${id}`,
	image: null,
	username: id,
	tier: "çaylak",
});

// An IN-shaped `getUsersByIds`: returns the rows that exist for the requested id
// set, in the corpus's order — the membership-stable shape every real loader has.
const corpus: ReadonlyArray<UserRow> = [storedUser("u1"), storedUser("u2"), storedUser("u3")];
const pasaportWithCorpus = {
	getUsersByIds: (ids: ReadonlyArray<string>) =>
		Effect.succeed(corpus.filter((row) => ids.includes(row.id))),
} as never;

// A `RelationStore` answering the `(subject, "moderates", platform)` membership per
// subject — the tuple `isModerator` reads (`kunye/moderate.ts`). Membership in
// `moderatorIds` ⇒ `true`.
const relationStoreFor = (moderatorIds: ReadonlySet<string>) =>
	({
		has: ({subject}: {subject: string}) => Effect.succeed(moderatorIds.has(subject)),
		hasSubjects: ({subjects}: {subjects: ReadonlyArray<string>}) =>
			Effect.succeed(new Set(subjects.filter((id) => moderatorIds.has(id)))),
	}) as never;

const profileRow = (userId: string): ProfileRow => ({
	userId,
	username: userId,
	displayName: `Display ${userId}`,
	image: null,
	totalKarma: 7,
	definitionCount: 1,
	postCount: 2,
	commentCount: 3,
});

const pasaportWithProfile = (row: ProfileRow | null) =>
	({lookupProfileById: () => Effect.succeed(row)}) as never;

// A `Pasaport` whose `lookupProfileById` records the `viewer` option it was handed,
// so a test can assert `profileSource.byId` threads the resolved sandbox viewer
// (#1406) rather than calling the loader sandbox-blind.
const pasaportCapturingViewer = (row: ProfileRow | null) => {
	// `viewer` admits `undefined` (exactOptionalPropertyTypes) since the loader's option
	// arg is itself optional — the anonymous case threads `{sandboxViewer: anonymous}`,
	// never a bare `undefined`, but the field type must permit what the param can be.
	const captured: {viewer: {sandboxViewer?: SandboxViewer} | undefined} = {viewer: undefined};
	const pasaport = {
		lookupProfileById: (_userId: string, viewer?: {sandboxViewer?: SandboxViewer}) => {
			captured.viewer = viewer;
			return Effect.succeed(row);
		},
	} as never;
	return {pasaport, captured};
};

// A `moderates`-tuple `RelationStore` (the `Moderate.over(platform)` probe shape, per
// `moderate.unit.test.ts`): a subject in `holders` holds the platform-moderation tuple.
const moderatesStore = (holders: ReadonlySet<string>) =>
	({
		has: (tuple: {relation: string; object: {type: string}; subject: string}) =>
			Effect.succeed(
				tuple.relation === "moderates" &&
					tuple.object.type === "platform" &&
					holders.has(tuple.subject),
			),
		hasSubjects: ({
			subjects,
			relation,
			object,
		}: {
			subjects: ReadonlyArray<string>;
			relation: string;
			object: {type: string};
		}) =>
			Effect.succeed(
				new Set(
					relation === "moderates" && object.type === "platform"
						? subjects.filter((subject) => holders.has(subject))
						: [],
				),
			),
	}) as never;

// The full request context `currentSandboxViewer` resolves from: the signed-in user
// (`CurrentUser`), the actor + moderation ports the `Moderate.over(platform)` probe
// discharges against (`CurrentActor`/`AgentAuthority`/`RelationStore`). Anonymous ⇒
// `{user: undefined}` + the `unauthenticated` actor.
const withRequestViewer = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	user: CurrentUserInfo | undefined,
	moderatorIds: ReadonlySet<string> = new Set(),
) =>
	effect.pipe(
		Effect.provideService(CurrentUser, {user}),
		Effect.provideService(CurrentActor, {actor: user ? human(user.id) : unauthenticated}),
		Effect.provideService(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Effect.provideService(RelationStore, moderatesStore(moderatorIds)),
	);

// --- userSource.byIds: the per-row moderator merge --------------------------

it.effect("userSource.byIds joins isModerator per row off the moderates tuple (ADR 0107)", () =>
	Effect.gen(function* () {
		// u1 holds the moderates tuple, u2 does not — the merge must be per-row, not
		// a single batch-wide verdict.
		const rows = yield* userByIds(["u1", "u2"]).pipe(
			Effect.provideService(Pasaport, pasaportWithCorpus),
			Effect.provideService(RelationStore, relationStoreFor(new Set(["u1"]))),
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		assert.strictEqual(byId.get("u1")?.isModerator, true);
		assert.strictEqual(byId.get("u2")?.isModerator, false);
	}),
);

it.effect("userSource.byIds carries through the underlying row fields unchanged", () =>
	Effect.gen(function* () {
		const rows = yield* userByIds(["u1"]).pipe(
			Effect.provideService(Pasaport, pasaportWithCorpus),
			Effect.provideService(RelationStore, relationStoreFor(new Set())),
		);
		// The batch stamps `emailFailing: false` flat — it is the reader's OWN signal,
		// resolved only on the self `me` read (#2693), never another account's here.
		assert.deepStrictEqual(rows[0], {...storedUser("u1"), isModerator: false, emailFailing: false});
	}),
);

// --- userSource.byIds: membership-stability (ADR 0016) ----------------------

it.effect("userSource.byIds is membership-stable: a reordered id set yields the same rows", () =>
	Effect.gen(function* () {
		const moderators = relationStoreFor(new Set(["u2"]));
		const forward = yield* userByIds(["u1", "u2", "u3"]).pipe(
			Effect.provideService(Pasaport, pasaportWithCorpus),
			Effect.provideService(RelationStore, moderators),
		);
		const reversed = yield* userByIds(["u3", "u2", "u1"]).pipe(
			Effect.provideService(Pasaport, pasaportWithCorpus),
			Effect.provideService(RelationStore, moderators),
		);
		// The rows are a function of the id SET, not its order — sorting both by id
		// must collapse them to the same rows (the masking the interpreter's merged
		// batch window relies on, `.patterns/fate-effect-sources.md`).
		const byKey = (rows: ReadonlyArray<{id: string}>) =>
			[...rows].sort((a, b) => a.id.localeCompare(b.id));
		assert.deepStrictEqual(byKey(forward), byKey(reversed));
	}),
);

// --- userSource.byIds: silent-read (ADR 0016) -------------------------------

it.effect(
	"userSource.byIds is silent on a miss: an absent id yields fewer rows, never a failure",
	() =>
		Effect.gen(function* () {
			const exit = yield* userByIds(["u1", "nope"]).pipe(
				Effect.provideService(Pasaport, pasaportWithCorpus),
				Effect.provideService(RelationStore, relationStoreFor(new Set())),
				Effect.exit,
			);
			assert.isTrue(exit._tag === "Success");
			if (exit._tag === "Success") {
				// Two ids requested, one exists — fewer rows is success, not a raised miss.
				assert.deepStrictEqual(
					exit.value.map((row) => row.id),
					["u1"],
				);
			}
		}),
);

// --- profileSource.byId: the toProfile-wrap + silent miss -------------------

it.effect("profileSource.byId wraps the row via toProfile (stamps id === userId)", () =>
	Effect.gen(function* () {
		const profile = yield* withRequestViewer(
			profileById("u1").pipe(
				Effect.provideService(Pasaport, pasaportWithProfile(profileRow("u1"))),
			),
			{id: "u1", email: "u1@kamp.us", name: "U One", image: null},
		);
		// `toProfile` stamps `__typename` (not on the handler's view-row return type) and
		// `id === userId`; widen to a record to assert the full runtime shape.
		assert.deepStrictEqual(profile as Record<string, unknown>, {
			__typename: "Profile",
			id: "u1",
			userId: "u1",
			username: "u1",
			displayName: "Display u1",
			image: null,
			totalKarma: 7,
			definitionCount: 1,
			postCount: 2,
			commentCount: 3,
		});
	}),
);

it.effect(
	"profileSource.byId is silent on a miss: an absent userId returns null, never a failure",
	() =>
		Effect.gen(function* () {
			const exit = yield* withRequestViewer(
				profileById("ghost").pipe(Effect.provideService(Pasaport, pasaportWithProfile(null))),
				{id: "u1", email: "u1@kamp.us", name: "U One", image: null},
			).pipe(Effect.exit);
			assert.isTrue(exit._tag === "Success");
			if (exit._tag === "Success") {
				assert.isNull(exit.value);
			}
		}),
);

// --- profileSource.byId: threads the resolved sandbox viewer (#1406) ---------

it.effect(
	"profileSource.byId threads the resolved currentSandboxViewer into lookupProfileById",
	() =>
		Effect.gen(function* () {
			// The author is signed in but NOT a moderator ⇒ the resolved viewer is keyed to
			// their id with `canSeeSandboxed: false`. Threading this (vs. calling the loader
			// sandbox-blind) is what makes the by-id counts agree with the root query (#1406).
			const {pasaport, captured} = pasaportCapturingViewer(profileRow("u1"));
			yield* withRequestViewer(profileById("u1").pipe(Effect.provideService(Pasaport, pasaport)), {
				id: "u1",
				email: "u1@kamp.us",
				name: "U One",
				image: null,
			});
			assert.deepStrictEqual(captured.viewer?.sandboxViewer, {
				viewerId: "u1",
				canSeeSandboxed: false,
			});
		}),
);

it.effect("profileSource.byId resolves an anonymous viewer when no user is signed in", () =>
	Effect.gen(function* () {
		const {pasaport, captured} = pasaportCapturingViewer(profileRow("u1"));
		yield* withRequestViewer(
			profileById("u1").pipe(Effect.provideService(Pasaport, pasaport)),
			undefined,
		);
		assert.deepStrictEqual(captured.viewer?.sandboxViewer, {
			viewerId: null,
			canSeeSandboxed: false,
		});
	}),
);

it.effect("profileSource.byId resolves canSeeSandboxed for a moderator viewer", () =>
	Effect.gen(function* () {
		const {pasaport, captured} = pasaportCapturingViewer(profileRow("u1"));
		yield* withRequestViewer(
			profileById("u1").pipe(Effect.provideService(Pasaport, pasaport)),
			{id: "mod", email: "mod@kamp.us", name: "Mod", image: null},
			new Set(["mod"]),
		);
		assert.deepStrictEqual(captured.viewer?.sandboxViewer, {
			viewerId: "mod",
			canSeeSandboxed: true,
		});
	}),
);
