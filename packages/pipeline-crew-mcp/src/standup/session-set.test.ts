/**
 * standup/session-set — the roster-driven session set (AC 1–4, ADR 0189; #3524). These tests pin the
 * derivation against the AUTOBOOTED roster (the self-driving roles — the two self-driving bridges +
 * the engine pool) and a sample engine count: bridge cardinality 1, engine cardinality N, distinct
 * per-instance engine identities, that the set is derived from the kind-typed roster contract rather
 * than a re-declared role list, and that a human-in-the-loop role (the cartographer) is NOT stood up.
 */
import {assert, describe, it} from "@effect/vitest";
import {Schema} from "effect";
import {CREW_ROLES, isAutobooted, kindOf} from "../crew/index.ts";
import {EngineCount} from "./config.ts";
import {type CrewSession, deriveSessionSet} from "./session-set.ts";

// The autobooted roster — the self-driving roles the stand-up brings up. A human-in-the-loop role
// (the cartographer) is excluded: on-demand, never in the standing drain crew (#3524).
const AUTOBOOTED = CREW_ROLES.filter(isAutobooted);

// N as the real branded EngineCount (≥1) the launcher hands the derivation, not a bare cast.
const n = (count: number): EngineCount => Schema.decodeUnknownSync(EngineCount)(count);

// A deterministic instance-id generator so the derived engine addresses are pinnable: e0, e1, ….
const counter = () => {
	let i = 0;
	return () => `e${i++}`;
};

const bridges = (set: readonly CrewSession[]) => set.filter((s) => s.kind === "bridge");
const engines = (set: readonly CrewSession[]) => set.filter((s) => s.kind === "engine");

describe("standup/session-set — roster-driven session set (ADR 0189)", () => {
	it("stands up exactly one instance per autobooted bridge kind and N of the engine kind (AC1)", () => {
		const N = 3;
		const set = deriveSessionSet({engineCount: n(N), instanceId: counter()});

		const bridgeRoles = AUTOBOOTED.filter((r) => kindOf(r) === "bridge");
		const engineRoles = AUTOBOOTED.filter((r) => kindOf(r) === "engine");

		// one session per bridge kind — the exact confirmed bridges, each cardinality 1.
		assert.deepStrictEqual(
			bridges(set)
				.map((s) => s.role)
				.sort(),
			[...bridgeRoles].sort(),
		);
		// N engine sessions total, all for the (single) engine role.
		assert.strictEqual(engines(set).length, N * engineRoles.length);
		for (const role of engineRoles) {
			assert.strictEqual(engines(set).filter((s) => s.role === role).length, N);
		}
		assert.strictEqual(set.length, bridgeRoles.length + N * engineRoles.length);
	});

	it("addresses each bridge as its singleton lease key inbox://<role> — no instance (AC3)", () => {
		const set = deriveSessionSet({engineCount: n(2), instanceId: counter()});
		for (const bridge of bridges(set)) {
			assert.strictEqual(bridge.address, `inbox://${bridge.role}`);
			// A bridge carries no per-instance identity — the discriminated union makes it unrepresentable.
			assert.isFalse("instance" in bridge);
		}
	});

	it("gives each engine instance a distinct per-instance identity + address — no collisions (AC2)", () => {
		const N = 4;
		const set = deriveSessionSet({engineCount: n(N), instanceId: counter()});
		const eng = engines(set);

		const instances = eng.map((s) => s.instance);
		const addresses = eng.map((s) => s.address);
		// distinct identities and distinct addresses — no two engine inboxes collide.
		assert.strictEqual(new Set(instances).size, eng.length);
		assert.strictEqual(new Set(addresses).size, eng.length);
		// the address bakes the role + the per-instance discriminator (inboxAddressFor's engine form).
		for (const s of eng) {
			assert.strictEqual(s.address, `inbox://${s.role}/${s.instance}`);
		}
	});

	it("derives from the kind-typed roster, not a re-declared list — every autobooted role is present (AC3)", () => {
		const set = deriveSessionSet({engineCount: n(1), instanceId: counter()});
		// every AUTOBOOTED (self-driving) roster role appears at least once, kinded exactly as the roster says.
		for (const role of AUTOBOOTED) {
			const forRole = set.filter((s) => s.role === role);
			assert.isTrue(forRole.length >= 1, `role ${role} missing from the session set`);
			for (const s of forRole) {
				assert.strictEqual(s.kind, kindOf(role));
			}
		}
		// no session names a role outside the roster.
		for (const s of set) {
			assert.isTrue(new Set<string>(CREW_ROLES).has(s.role));
		}
	});

	it("excludes a human-in-the-loop role (the cartographer) from the stand-up set (#3524)", () => {
		const set = deriveSessionSet({engineCount: n(3), instanceId: counter()});
		const roles = new Set(set.map((s) => s.role));
		// the cartographer is a known/addressable roster role but NOT autobooted — on-demand only.
		assert.isFalse(roles.has("cartographer"), "cartographer must not be autobooted (#3524)");
		// exactly the self-driving roster is stood up — no HITL role sneaks in.
		for (const s of set) {
			assert.isTrue(isAutobooted(s.role), `${s.role} is not autobooted but appears in the set`);
		}
	});

	it("scales the engine pool with the config engine count, bridges fixed at 1 (AC1,AC4)", () => {
		const bridgeCount = AUTOBOOTED.filter((r) => kindOf(r) === "bridge").length;
		for (const N of [1, 2, 5, 10]) {
			const set = deriveSessionSet({engineCount: n(N), instanceId: counter()});
			assert.strictEqual(bridges(set).length, bridgeCount);
			assert.strictEqual(engines(set).length, N);
			assert.strictEqual(new Set(engines(set).map((s) => s.address)).size, N);
		}
	});
});
