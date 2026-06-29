import {assert, describe, it} from "@effect/vitest";
import {
	type BackedPermissionGroup,
	CI_TOKEN_PERMISSION_GROUPS,
	permissionGroupNames,
	unbackedGrants,
} from "./permission-groups.ts";

describe("CI-token permission groups — least-privilege guard (#1437)", () => {
	it("grants no permission with a blank backing resource (no ahead-of-resource over-grant)", () => {
		assert.deepStrictEqual(unbackedGrants(), []);
	});

	it("does NOT grant `Workers R2 Storage Write` — no R2 resource backs it (ADR 0044 designed-not-built)", () => {
		assert.isFalse(permissionGroupNames().includes("Workers R2 Storage Write"));
	});

	it("keeps Secrets Store Read+Write — the `Cloudflare.state()` bootstrap needs both", () => {
		const names = permissionGroupNames();
		assert.isTrue(names.includes("Secrets Store Read"));
		assert.isTrue(names.includes("Secrets Store Write"));
	});

	it("derives the literal name list from the backed pairs, in order (no hand-duplicated second list)", () => {
		assert.deepStrictEqual(
			permissionGroupNames(),
			CI_TOKEN_PERMISSION_GROUPS.map((g) => g.group),
		);
	});

	it("pins the granted set, so any drift is a visible diff", () => {
		assert.deepStrictEqual(permissionGroupNames(), [
			"Workers Scripts Write",
			"Workers KV Storage Write",
			"D1 Write",
			"Workers Tail Read",
			"Account Settings Read",
			"Secrets Store Read",
			"Secrets Store Write",
		]);
	});
});

describe("unbackedGrants — the guard fires on an unbacked grant", () => {
	it("flags a group whose backing resource is blank (the over-grant it exists to catch)", () => {
		const drifted: readonly BackedPermissionGroup[] = [
			{group: "D1 Write", backedBy: "PhoenixDb"},
			{group: "Workers R2 Storage Write", backedBy: "   "},
		];
		assert.deepStrictEqual(unbackedGrants(drifted), ["Workers R2 Storage Write"]);
	});

	it("passes a fully-backed list", () => {
		const ok: readonly BackedPermissionGroup[] = [{group: "D1 Write", backedBy: "PhoenixDb"}];
		assert.deepStrictEqual(unbackedGrants(ok), []);
	});
});
