/**
 * The dark-ship default-=-safe-state invariant for the edge-resolved shell-boot flag (#2928,
 * epic #2926, ADR 0179). Inspected off the exported `EDGE_SHELL_BOOT_FLAG` record (the same
 * object the factory spreads into `FlagshipFlag`), so no alchemy resource is constructed —
 * mirrors `member-mute.invariant.test.ts` (#3112). Off ⇒ the SPA HTML stays edge-direct today.
 */
import {assert, describe, it} from "@effect/vitest";
import {PHOENIX_EDGE_SHELL_BOOT} from "../../../src/flags/keys.ts";
import {EDGE_SHELL_BOOT_FLAG, edgeShellBootFlag} from "./resources.ts";

describe("edge-resolved shell-boot — the IaC default is the safe (off) state", () => {
	it("the flag config ships defaultVariation off and variations.off === false", () => {
		assert.strictEqual(EDGE_SHELL_BOOT_FLAG.defaultVariation, "off");
		assert.strictEqual(EDGE_SHELL_BOOT_FLAG.variations.off, false);
		assert.strictEqual(EDGE_SHELL_BOOT_FLAG.variations.on, true);
		assert.strictEqual(EDGE_SHELL_BOOT_FLAG.key, "phoenix-edge-shell-boot");
	});

	it("the flag key is the shared constant (gate and declaration never diverge)", () => {
		assert.strictEqual(EDGE_SHELL_BOOT_FLAG.key, PHOENIX_EDGE_SHELL_BOOT);
	});

	it("the factory is a function of appId (deploy-resolved, not a module constant)", () => {
		assert.strictEqual(typeof edgeShellBootFlag, "function");
	});
});
