/**
 * `userAdmin.list` gate + shaping coverage (#3200), run through the REAL `requireAdmin`
 * seam (ADR 0107) rather than a re-implemented admin check. Denied callers must never
 * touch the pasaport reads — the fail-on-contact stub dies if the gate let them through.
 * The real-D1 write→read seam lives in `tests/integration/kunye-admin-seam.test.ts`.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	type Actor,
	AgentAuthority,
	CurrentActor,
	human,
	RelationStore,
	unauthenticated,
} from "@kampus/authz";
import type {ConnectionResult} from "@nkzw/fate/server";
import {Effect, Exit, Layer} from "effect";
import {requireAdmin} from "../kunye/admin.ts";
import type {BanState} from "../pasaport/ban.ts";
import {makePasaportStub} from "../pasaport/Pasaport.testing.ts";
import type {AdminUserRow} from "../pasaport/Pasaport.ts";
import {userAdminListGated} from "./lists.ts";
import type {UserAdminEntity} from "./views.ts";

const at = (iso: string): Date => new Date(iso);

const userRow = (id: string, over: Partial<AdminUserRow> = {}): AdminUserRow => ({
	id,
	username: id,
	email: `${id}@test.local`,
	tier: "çaylak",
	createdAt: at("2026-01-01T00:00:00Z"),
	...over,
});

const BANNED: BanState = {banned: true, reason: "spam", expiresAt: null};

const run = (
	actor: Actor,
	opts: {
		admins?: ReadonlyArray<string>;
		mods?: ReadonlyArray<string>;
		rows?: ReadonlyArray<AdminUserRow>;
		banned?: ReadonlyArray<string>;
	} = {},
): Exit.Exit<ConnectionResult<UserAdminEntity>, unknown> => {
	const rows = opts.rows ?? [];
	const admins = opts.admins ?? [];
	const mods = opts.mods ?? [];
	// One store scripts BOTH the `admin` tuple (the gate) and the `moderates` tuple (the
	// role join). Inlined so TS infers the port shape from the tag, with no cast.
	const holdersFor = (relation: string) => (relation === "admin" ? admins : mods);
	const relevant = (relation: string, objectType: string) =>
		(relation === "admin" || relation === "moderates") && objectType === "platform";
	const banMap = new Map<string, BanState>((opts.banned ?? []).map((id) => [id, BANNED]));
	const layer = Layer.mergeAll(
		makePasaportStub({
			listUsersForAdmin: () =>
				Effect.succeed({rows: [...rows], hasNextPage: false, endCursor: null}),
			banStatesForAdmin: () => Effect.succeed(banMap),
		}),
		Layer.succeed(CurrentActor, {actor}),
		Layer.succeed(AgentAuthority, {admits: () => Effect.succeed(false)}),
		Layer.succeed(RelationStore, {
			has: (tuple) =>
				Effect.succeed(
					relevant(tuple.relation, tuple.object.type) &&
						holdersFor(tuple.relation).includes(tuple.subject),
				),
			hasSubjects: ({subjects, relation, object}) =>
				Effect.succeed(
					new Set(
						relevant(relation, object.type)
							? subjects.filter((s) => holdersFor(relation).includes(s))
							: [],
					),
				),
			subjectsOf: ({relation, object}) =>
				Effect.succeed(new Set(relevant(relation, object.type) ? holdersFor(relation) : [])),
		}),
	);
	return Effect.runSyncExit(
		requireAdmin(userAdminListGated({})).pipe(Effect.provide(layer)),
	) as Exit.Exit<ConnectionResult<UserAdminEntity>, unknown>;
};

describe("userAdmin.list — requireAdmin gate (ADR 0107)", () => {
	it("a non-admin is denied the invisible Denied — the roster read is never touched", () => {
		const exit = run(human("u1"), {admins: ["someone-else"], rows: [userRow("u1")]});
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("the anonymous actor is denied the SAME Denied — indistinguishable from a non-admin", () => {
		const exit = run(unauthenticated, {admins: ["u1"], rows: [userRow("u1")]});
		assert.isTrue(Exit.isFailure(exit));
		assert.match(String(Exit.isFailure(exit) ? exit.cause : ""), /kunye\/Denied/);
	});

	it("an admin gets the roster, with role joined off the moderates tuple and banned joined off the ban-state", () => {
		const exit = run(human("admin"), {
			admins: ["admin"],
			mods: ["u1"],
			banned: ["u2"],
			rows: [userRow("u1", {tier: "yazar"}), userRow("u2")],
		});
		assert.isTrue(Exit.isSuccess(exit));
		if (!Exit.isSuccess(exit)) return;
		const nodes = exit.value.items.map((item) => item.node);
		assert.deepStrictEqual(
			nodes.map((n) => [n.id, n.role, n.banned, n.tier]),
			[
				["u1", "moderator", false, "yazar"],
				["u2", "member", true, "çaylak"],
			],
		);
		assert.strictEqual(nodes[0]?.__typename, "UserAdmin");
		assert.strictEqual(nodes[0]?.createdAt, at("2026-01-01T00:00:00Z").getTime());
		assert.strictEqual(exit.value.pagination.hasNext, false);
	});
});
