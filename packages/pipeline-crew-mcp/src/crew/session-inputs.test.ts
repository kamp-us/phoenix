/**
 * crew/session-inputs — the flag-or-env resolution the `session` command uses so a static marketplace
 * plugin-channel `.mcp.json` (one declaration, no per-pane `--role`) resolves each pane's role from
 * `$CREW_ROLE`, while the dev-mode `--role` argv path is untouched (the flag still wins). These tests
 * pin: the flag wins over env, env is the plugin-channel fallback, role fails closed when neither
 * resolves, and project-root/instance degrade to their safe defaults. See #3366 / ADR 0201.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	resolveSessionInstance,
	resolveSessionProjectRoot,
	resolveSessionRole,
	SessionRoleUnresolvedError,
} from "./session-inputs.ts";

describe("crew/session-inputs — resolveSessionRole (fail-closed)", () => {
	it.effect("the --role flag wins over $CREW_ROLE (dev-mode argv path unchanged)", () =>
		Effect.gen(function* () {
			const role = yield* resolveSessionRole("intake-desk", {CREW_ROLE: "chief-of-staff"});
			assert.strictEqual(role, "intake-desk");
		}),
	);

	it.effect(
		"falls back to a valid $CREW_ROLE when the flag is absent (plugin-channel env path)",
		() =>
			Effect.gen(function* () {
				const role = yield* resolveSessionRole(undefined, {CREW_ROLE: "engineering-manager"});
				assert.strictEqual(role, "engineering-manager");
			}),
	);

	it.effect("trims surrounding whitespace on $CREW_ROLE before validating", () =>
		Effect.gen(function* () {
			const role = yield* resolveSessionRole(undefined, {CREW_ROLE: "  cartographer  "});
			assert.strictEqual(role, "cartographer");
		}),
	);

	it.effect("fails closed when neither flag nor env resolves a role (attempted = empty)", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(resolveSessionRole(undefined, {}));
			assert.instanceOf(error, SessionRoleUnresolvedError);
			assert.strictEqual(error.attempted, "");
			assert.deepStrictEqual(
				[...error.validRoles],
				["chief-of-staff", "cartographer", "intake-desk", "engineering-manager"],
			);
		}),
	);

	it.effect("a blank $CREW_ROLE reads as absent and fails closed", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(resolveSessionRole(undefined, {CREW_ROLE: "   "}));
			assert.instanceOf(error, SessionRoleUnresolvedError);
			assert.strictEqual(error.attempted, "");
		}),
	);

	it.effect("fails closed on an invalid $CREW_ROLE, surfacing the offending value", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(resolveSessionRole(undefined, {CREW_ROLE: "not-a-role"}));
			assert.instanceOf(error, SessionRoleUnresolvedError);
			assert.strictEqual(error.attempted, "not-a-role");
		}),
	);
});

describe("crew/session-inputs — resolveSessionProjectRoot (total, cwd default)", () => {
	it("the --project-root flag wins over env and cwd", () => {
		assert.strictEqual(
			resolveSessionProjectRoot("/flag/root", {CREW_PROJECT_ROOT: "/env/root"}, "/cwd/root"),
			"/flag/root",
		);
	});

	it("falls back to $CREW_PROJECT_ROOT when the flag is absent", () => {
		assert.strictEqual(
			resolveSessionProjectRoot(undefined, {CREW_PROJECT_ROOT: "/env/root"}, "/cwd/root"),
			"/env/root",
		);
	});

	it("falls back to cwd when neither flag nor env is set", () => {
		assert.strictEqual(resolveSessionProjectRoot(undefined, {}, "/cwd/root"), "/cwd/root");
	});

	it("a blank $CREW_PROJECT_ROOT reads as absent and degrades to cwd", () => {
		assert.strictEqual(
			resolveSessionProjectRoot(undefined, {CREW_PROJECT_ROOT: "  "}, "/cwd/root"),
			"/cwd/root",
		);
	});
});

describe("crew/session-inputs — resolveSessionInstance (optional)", () => {
	it("the --instance flag wins over env", () => {
		assert.strictEqual(resolveSessionInstance("flag-id", {CREW_INSTANCE: "env-id"}), "flag-id");
	});

	it("falls back to $CREW_INSTANCE when the flag is absent", () => {
		assert.strictEqual(resolveSessionInstance(undefined, {CREW_INSTANCE: "env-id"}), "env-id");
	});

	it("is undefined when neither is set (a bridge singleton / direct run mints its own)", () => {
		assert.strictEqual(resolveSessionInstance(undefined, {}), undefined);
	});

	it("a blank $CREW_INSTANCE reads as absent", () => {
		assert.strictEqual(resolveSessionInstance(undefined, {CREW_INSTANCE: "  "}), undefined);
	});
});
