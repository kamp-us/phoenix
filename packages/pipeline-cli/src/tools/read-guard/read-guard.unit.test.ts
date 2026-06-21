import {assert, describe, it} from "@effect/vitest";
import {blockReason, decide, type ReadSet} from "./read-guard.ts";

const T0 = 1_000_000; // an arbitrary epoch-ms read instant

describe("decide — the three AC cases", () => {
	it("never-read → inject-read (target absent from the read-set)", () => {
		const d = decide("/repo/a.ts", [], 500_000);
		assert.strictEqual(d.kind, "inject-read");
		assert.strictEqual(d.kind === "inject-read" ? d.reason : "", "never-read");
		assert.strictEqual(d.kind === "inject-read" ? d.path : "", "/repo/a.ts");
	});

	it("stale-read (file changed on disk since the recorded Read) → inject-read", () => {
		const readSet: ReadSet = [{path: "/repo/a.ts", readAtMs: T0}];
		// current mtime is strictly newer than when we read it → stale
		const d = decide("/repo/a.ts", readSet, T0 + 5_000);
		assert.strictEqual(d.kind, "inject-read");
		assert.strictEqual(d.kind === "inject-read" ? d.reason : "", "modified-since-read");
	});

	it("current-read → no-op (the edit proceeds with no extra Read)", () => {
		const readSet: ReadSet = [{path: "/repo/a.ts", readAtMs: T0}];
		// file unchanged since read (older or equal mtime) → proceed
		const d = decide("/repo/a.ts", readSet, T0 - 5_000);
		assert.strictEqual(d.kind, "no-op");
	});
});

describe("decide — edges", () => {
	it("mtime exactly equal to read instant is NOT stale (the read saw that write)", () => {
		const readSet: ReadSet = [{path: "/repo/a.ts", readAtMs: T0}];
		assert.strictEqual(decide("/repo/a.ts", readSet, T0).kind, "no-op");
	});

	it("latest read wins — a re-read after a change clears staleness", () => {
		const readSet: ReadSet = [
			{path: "/repo/a.ts", readAtMs: T0},
			{path: "/repo/a.ts", readAtMs: T0 + 10_000}, // re-read after the change
		];
		// file changed at T0+5_000, but the latest read (T0+10_000) is newer → fresh
		assert.strictEqual(decide("/repo/a.ts", readSet, T0 + 5_000).kind, "no-op");
	});

	it("new file (never read, not on disk) → no-op (Write may create it)", () => {
		assert.strictEqual(decide("/repo/new.ts", [], null).kind, "no-op");
	});

	it("read recorded but file now absent (deleted) → no-op (nothing to re-read)", () => {
		const readSet: ReadSet = [{path: "/repo/a.ts", readAtMs: T0}];
		assert.strictEqual(decide("/repo/a.ts", readSet, null).kind, "no-op");
	});

	it("distinguishes paths — a read of one file does not vouch for another", () => {
		const readSet: ReadSet = [{path: "/repo/a.ts", readAtMs: T0}];
		assert.strictEqual(decide("/repo/b.ts", readSet, 500_000).kind, "inject-read");
	});

	it("normalizes backslash paths so a windows-style target matches its read", () => {
		const readSet: ReadSet = [{path: "C:/repo/a.ts", readAtMs: T0}];
		assert.strictEqual(decide("C:\\repo\\a.ts", readSet, T0 - 1).kind, "no-op");
	});
});

describe("blockReason — actionable, names the path", () => {
	it("never-read reason names the path and why", () => {
		const r = blockReason("/repo/a.ts", "never-read");
		assert.include(r, "/repo/a.ts");
		assert.include(r, "not been read");
	});

	it("modified-since-read reason names the path and why", () => {
		const r = blockReason("/repo/a.ts", "modified-since-read");
		assert.include(r, "/repo/a.ts");
		assert.include(r, "changed on disk");
	});
});
