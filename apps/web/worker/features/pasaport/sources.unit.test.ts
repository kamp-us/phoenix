/**
 * Unit coverage for the pasaport fate loader seam, plus the two loader-contract
 * invariants it upholds (ADR 0016): membership-stability and silent-read.
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

// Returns rows in the CORPUS's order, not the request's — the membership-stable shape
// every real loader has.
const corpus: ReadonlyArray<UserRow> = [storedUser("u1"), storedUser("u2"), storedUser("u3")];
const pasaportWithCorpus = {
	getUsersByIds: (ids: ReadonlyArray<string>) =>
		Effect.succeed(corpus.filter((row) => ids.includes(row.id))),
} as never;

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

it.effect("userSource.byIds joins isModerator per row off the moderates tuple (ADR 0107)", () =>
	Effect.gen(function* () {
		// u1 holds the moderates tuple, u2 does not — the merge must be per-row, never a
		// single batch-wide verdict.
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
		const byKey = (rows: ReadonlyArray<{id: string}>) =>
			[...rows].sort((a, b) => a.id.localeCompare(b.id));
		assert.deepStrictEqual(byKey(forward), byKey(reversed));
	}),
);

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
				assert.deepStrictEqual(
					exit.value.map((row) => row.id),
					["u1"],
				);
			}
		}),
);

it.effect("profileSource.byId wraps the row via toProfile (stamps id === userId)", () =>
	Effect.gen(function* () {
		const profile = yield* withRequestViewer(
			profileById("u1").pipe(
				Effect.provideService(Pasaport, pasaportWithProfile(profileRow("u1"))),
			),
			{id: "u1", email: "u1@kamp.us", name: "U One", image: null},
		);
		// Widened to a record because `toProfile` stamps `__typename`, which is not on the
		// handler's view-row return type.
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

it.effect(
	"profileSource.byId threads the resolved currentSandboxViewer into lookupProfileById",
	() =>
		Effect.gen(function* () {
			// Threading the viewer (vs. calling the loader sandbox-blind) is what makes the
			// by-id counts agree with the root query (#1406).
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
