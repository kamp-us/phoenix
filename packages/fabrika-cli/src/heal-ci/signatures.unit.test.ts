import {describe, expect, it} from "vitest";
import {classifyLog, isSignatureId, SIGNATURE_IDS, SIGNATURES} from "./signatures.ts";

/** One fixture per row, so the table is exercised by its own contract rather than by a sample. */
const FIXTURES: ReadonlyArray<readonly [string, string]> = [
	["runner-oom", "##[error]The operation was terminated: exit code 137"],
	["runner-cancelled-infra", "The runner has received a shutdown signal."],
	["rate-limited", "API rate limit exceeded for installation."],
	["preview-warmup", "preview at https://x.workers.dev did not become reachable after 60s"],
	["readiness-stall", "readiness probe timed out after 120s"],
	["network-transient", "Error: connect ETIMEDOUT registry.npmjs.org:443"],
	["assertion-failure", "AssertionError: expected 3 to be 2"],
	["typecheck-failure", "src/a.ts(3,1): error TS2345: Argument of type 'x'."],
	["lint-failure", "biome check found 1 error in src/a.ts"],
	["build-failure", "Error: Cannot find module './missing'"],
];

describe("the taxonomy is a table, and every row is reachable", () => {
	it("ships exactly the ten contracted rows in order", () => {
		expect(SIGNATURE_IDS).toEqual(FIXTURES.map(([id]) => id));
	});

	it.each(FIXTURES)("`%s` matches its own fixture", (id, line) => {
		const found = classifyLog(line);
		expect(found._tag).toBe("Matched");
		expect(found._tag === "Matched" ? found.signature.id : null).toBe(id);
	});

	it("puts every transient row above every logic row", () => {
		const firstLogic = SIGNATURES.findIndex((row) => row.class === "logic");
		expect(SIGNATURES.slice(0, firstLogic).every((row) => row.class === "transient")).toBe(true);
		expect(SIGNATURES.slice(firstLogic).every((row) => row.class === "logic")).toBe(true);
	});
});

describe("precedence is the table's, not the log's", () => {
	it("reads an OOM-killed suite as the infrastructure death it is, not the assertion it printed", () => {
		const found = classifyLog(
			["AssertionError: expected 3 to be 2", "##[error]exit code 137"].join("\n"),
		);
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("runner-oom");
	});

	it("reads a preview target answering 502 as a warmup, not as generic network trouble", () => {
		const found = classifyLog("deployment target returned 502 Bad Gateway");
		expect(found._tag === "Matched" ? found.signature.id : null).toBe("preview-warmup");
	});

	it("reports the matched line 1-based within the block", () => {
		const found = classifyLog(["a", "b", "AssertionError: boom"].join("\n"));
		expect(found._tag === "Matched" ? found.line : null).toBe(3);
	});
});

describe("default-deny", () => {
	it("recognises nothing rather than guessing transient", () => {
		const found = classifyLog("Something went wrong.");
		expect(found._tag).toBe("Unclassified");
	});

	it("names only its own ids as signatures", () => {
		expect(isSignatureId("preview-warmup")).toBe(true);
		expect(isSignatureId("flaky")).toBe(false);
	});
});
