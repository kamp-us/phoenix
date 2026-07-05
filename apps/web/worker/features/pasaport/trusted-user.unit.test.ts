/**
 * `trusted-user` compose coverage (#1360) — the one home for the trusted `User`
 * wire shape (`me` / `setUsername` / the by-id loader all route through it):
 *
 * - `toTrustedUser` resolves the SELF standing (tier via `Kunye.tierOf`, the
 *   moderator signal via the `moderates` tuple) and stamps the `toUser` shape.
 * - `getUsersWithModerationByIds` joins moderator standing onto a batch of user
 *   rows through ONE `RelationStore.hasSubjects` read — no per-row probe — and each
 *   row already carries its stored `tier`.
 *
 * The three ports are scripted (`Pasaport` the rows, `Kunye` the tier, `RelationStore`
 * the membership); the real D1 reads live in their own integration/adapter tiers.
 */
import {assert, describe, it} from "@effect/vitest";
import {RelationStore} from "@kampus/authz";
import {Effect, Layer} from "effect";
import {Kunye} from "../kunye/Kunye.ts";
import {Pasaport, type UserRow} from "./Pasaport.ts";
import {getUsersWithModerationByIds, toTrustedUser} from "./trusted-user.ts";

const row = (over: Partial<UserRow> & {id: string}): UserRow => ({
	email: `${over.id}@kamp.us`,
	name: null,
	image: null,
	username: null,
	tier: "çaylak",
	...over,
});

// A `Pasaport` answering `getUsersByIds` off a fixed row set, in id order.
const pasaportOf = (rows: ReadonlyArray<UserRow>): Layer.Layer<Pasaport> =>
	Layer.succeed(Pasaport, {
		getUsersByIds: (ids: ReadonlyArray<string>) =>
			Effect.succeed(ids.flatMap((id) => rows.filter((r) => r.id === id))),
	} as never);

// A `Kunye` whose `tierOf` answers by id (visitor when absent), exercising the SELF
// trusted-tier read; the other methods are unreached.
const kunyeOf = (tierById: Record<string, "çaylak" | "yazar">): Layer.Layer<Kunye> =>
	Layer.succeed(Kunye, {
		tierOf: (id: string) => Effect.succeed(tierById[id] ?? "visitor"),
	} as never);

// A `RelationStore` where exactly `mods` hold the `(moderates, platform)` tuple,
// answering both the single `has` and the batched `hasSubjects`.
const relationStoreOf = (mods: ReadonlyArray<string>): Layer.Layer<RelationStore> =>
	Layer.succeed(RelationStore, {
		has: (tuple) => Effect.succeed(tuple.relation === "moderates" && mods.includes(tuple.subject)),
		hasSubjects: ({subjects, relation}) =>
			Effect.succeed(
				new Set(relation === "moderates" ? subjects.filter((s) => mods.includes(s)) : []),
			),
		subjectsOf: ({relation}) => Effect.succeed(new Set(relation === "moderates" ? mods : [])),
	});

describe("toTrustedUser — the SELF trusted User shape", () => {
	it.effect("stamps the trusted tier + moderator signal onto toUser", () =>
		Effect.gen(function* () {
			const user = yield* toTrustedUser({
				id: "u1",
				email: "u1@kamp.us",
				name: "U One",
				image: null,
				username: "u-one",
			}).pipe(Effect.provide(Layer.mergeAll(kunyeOf({u1: "yazar"}), relationStoreOf(["u1"]))));
			assert.deepStrictEqual(user, {
				__typename: "User",
				id: "u1",
				email: "u1@kamp.us",
				name: "U One",
				image: null,
				username: "u-one",
				tier: "yazar",
				isModerator: true,
			});
		}),
	);

	it.effect("a non-moderator reads isModerator false, tier off the stored column", () =>
		Effect.gen(function* () {
			const user = yield* toTrustedUser({
				id: "u2",
				email: "u2@kamp.us",
				name: null,
				image: null,
				username: null,
			}).pipe(Effect.provide(Layer.mergeAll(kunyeOf({u2: "çaylak"}), relationStoreOf([]))));
			assert.strictEqual(user.tier, "çaylak");
			assert.isFalse(user.isModerator);
		}),
	);
});

describe("getUsersWithModerationByIds — the batched by-id user rows + moderator standing", () => {
	it.effect("joins moderator standing per row off a single membership read", () =>
		Effect.gen(function* () {
			const users = yield* getUsersWithModerationByIds(["u1", "u2", "u3"]).pipe(
				Effect.provide(
					Layer.mergeAll(
						pasaportOf([
							row({id: "u1", tier: "yazar"}),
							row({id: "u2", tier: "çaylak"}),
							row({id: "u3", tier: "yazar"}),
						]),
						relationStoreOf(["u1", "u3"]),
					),
				),
			);
			assert.deepStrictEqual(
				users.map((u) => ({id: u.id, tier: u.tier, isModerator: u.isModerator})),
				[
					{id: "u1", tier: "yazar", isModerator: true},
					{id: "u2", tier: "çaylak", isModerator: false},
					{id: "u3", tier: "yazar", isModerator: true},
				],
			);
		}),
	);

	it.effect("an empty id set resolves to no rows", () =>
		Effect.gen(function* () {
			const users = yield* getUsersWithModerationByIds([]).pipe(
				Effect.provide(Layer.mergeAll(pasaportOf([]), relationStoreOf([]))),
			);
			assert.deepStrictEqual(users, []);
		}),
	);
});
