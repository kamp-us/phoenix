import {assert, describe, it} from "@effect/vitest";
import {FolderNotTrusted, TrustedFolders} from "./trust.ts";

describe("TrustedFolders", () => {
	it("trusts nothing until a folder is trusted", () => {
		assert.isFalse(TrustedFolders.none.trusts("/work/a"));
		assert.isTrue(TrustedFolders.none.trust("/work/a").trusts("/work/a"));
	});

	it("trusts a folder under any spelling of its path, and records it once", () => {
		const trusted = TrustedFolders.none.trust("/work/a/").trust("/work/b/../a");
		assert.isTrue(trusted.trusts("/work/a"));
		assert.deepStrictEqual(trusted.folders, ["/work/a"]);
	});

	it("does not trust a folder beside, inside or above a trusted one", () => {
		const trusted = TrustedFolders.of(["/work/a"]);
		assert.isFalse(trusted.trusts("/work/ab"));
		assert.isFalse(trusted.trusts("/work/a/nested"));
		assert.isFalse(trusted.trusts("/work"));
	});

	it("reads a saved list back in the order it was trusted", () => {
		assert.deepStrictEqual(TrustedFolders.of(["/work/b", "/work/a", "/work/b/"]).folders, [
			"/work/b",
			"/work/a",
		]);
	});
});

describe("the open-path gate", () => {
	it("asks about a folder with a config nobody has trusted", () => {
		assert.strictEqual(TrustedFolders.none.gate("/work/a", true), "ask");
	});

	it("opens a trusted folder without asking again", () => {
		assert.strictEqual(TrustedFolders.none.trust("/work/a").gate("/work/a", true), "trusted");
	});

	it("never asks about a folder with no config, which has nothing to run", () => {
		assert.strictEqual(TrustedFolders.none.gate("/work/a", false), "nothing-to-run");
	});

	it("names the folder a refusal left untouched", () => {
		assert.strictEqual(
			new FolderNotTrusted({folder: "/work/a"}).message,
			"the folder /work/a was not trusted, so nothing from it runs",
		);
	});
});
