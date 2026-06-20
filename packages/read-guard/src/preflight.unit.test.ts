import {assert, describe, it} from "@effect/vitest";
import {depsInstalled, missingDepMessage, RUNTIME_DEP} from "./preflight.ts";

describe("preflight — runtime-dep resolution probe (#777)", () => {
	it("resolves the real runtime dep as installed (this tree has run pnpm install)", () => {
		assert.isTrue(depsInstalled(RUNTIME_DEP));
	});

	it("reports a non-existent package as NOT installed (the stale-node_modules case)", () => {
		assert.isFalse(depsInstalled("@kampus/this-package-does-not-exist-777"));
	});

	it("never throws — a bogus dep resolves to false, not an exception", () => {
		assert.doesNotThrow(() => depsInstalled("totally-bogus-specifier"));
	});

	it("missing-dep message names the bin, the dep, and `pnpm install`, and says NOT enforcing", () => {
		const msg = missingDepMessage("read-guard");
		assert.include(msg, "read-guard");
		assert.include(msg, RUNTIME_DEP);
		assert.include(msg, "pnpm install");
		assert.match(msg, /not enforcing/i);
	});
});
