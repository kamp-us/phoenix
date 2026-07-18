/**
 * `userAdmin.list` gate + shaping coverage (#3200) — the roster read run through the REAL
 * `requireAdmin` seam (ADR 0107), not a re-implemented admin check. The post-gate body
 * (`userAdminListGated`) is exercised end to end: an admin discharges the `Admin` grant and
 * gets the mapped roster (role joined off the `moderates` tuple, banned off the batched
 * ban-state); a non-admin and the anonymous actor are denied the invisible `Denied` — and
 * the pasaport reads are NEVER touched, proving the gate blocks before the read (the
 * fail-on-contact stub dies if reached).
 *
 * All ports are scripted (`Pasaport` the roster + ban-state, `RelationStore` the admin +
 * moderates tuples, `AgentAuthority` fail-closed, `CurrentActor` the actor) — no DB; the
 * real-D1 admin write→read seam lives in `apps/web/tests/integration/kunye-admin-seam.test.ts`.
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
	// One `RelationStore` scripting BOTH the `admin` tuple (the requireAdmin gate) and the
	// `moderates` tuple (the roster's role join) off two holder sets — inlined so TS infers
	// the port shape from the tag (the `divan/gate.unit.test.ts` idiom, no cast).
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
		// Every node carries its wire discriminant + the epoch-millis createdAt.
		assert.strictEqual(nodes[0]?.__typename, "UserAdmin");
		assert.strictEqual(nodes[0]?.createdAt, at("2026-01-01T00:00:00Z").getTime());
		assert.strictEqual(exit.value.pagination.hasNext, false);
	});
});
