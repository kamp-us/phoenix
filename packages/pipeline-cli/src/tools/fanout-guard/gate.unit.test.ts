/**
 * `checkFanout` over a fake repo dir — the filesystem-seam test (ADR 0155, #1898). The
 * pure verdict (drift, missing-publish, zero-scope) is covered in
 * `fanout-guard.unit.test.ts`; this crosses the IO gate over a real temp dir, asserting
 * the exit-code contract from observable outcomes — never by spawning the bin.
 *
 * The fixture pair is the working proof: a feature whose fanned mutation references the
 * publisher SUCCEEDS; the same tree with the publisher reference removed `CheckFailed`.
 */
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, describe, expect, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {CheckFailed, checkFanout} from "./gate.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fanout-guard-gate-"));
});
afterEach(() => {
	rmSync(root, {recursive: true, force: true});
});

const FEATURES = join("apps", "web", "worker", "features");

const writeManifest = (rows: ReadonlyArray<{key: string; fanned: boolean}>) => {
	const dir = join(root, FEATURES, "fate-live");
	mkdirSync(dir, {recursive: true});
	const body = rows
		.map((r) => `\t{key: "${r.key}", fanned: ${r.fanned}, rationale: "x"},`)
		.join("\n");
	writeFileSync(
		join(dir, "fanned-mutations.ts"),
		`export const FANNED_MUTATIONS = [\n${body}\n];\n`,
		"utf8",
	);
};

const writeFeature = (feature: string, keys: ReadonlyArray<string>, publishes: boolean) => {
	const dir = join(root, FEATURES, feature);
	mkdirSync(dir, {recursive: true});
	const decls = keys.map((k) => `\t"${k}": Fate.mutation({}, fn),`).join("\n");
	const publishLine = publishes ? "\tconst live = featLive(yield* WorkerLivePublisher);\n" : "";
	writeFileSync(
		join(dir, "mutations.ts"),
		`export const mutations = {\n${decls}\n};\n${publishLine}`,
		"utf8",
	);
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);
const isCheckFailed = (exit: Exit.Exit<unknown, unknown>): boolean =>
	Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof CheckFailed;

describe("checkFanout — the CI exit-code gate over a fake repo dir", () => {
	it("SUCCEEDS when a fanned mutation's feature references the publisher (the proof)", async () => {
		writeManifest([{key: "post.submit", fanned: true}]);
		writeFeature("pano", ["post.submit"], true);
		const exit = await run(checkFanout(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed) when a fanned mutation's feature omits the publisher (the falsification)", async () => {
		writeManifest([{key: "post.submit", fanned: true}]);
		writeFeature("pano", ["post.submit"], false);
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("SUCCEEDS for a not-fanned mutation whose feature omits the publisher", async () => {
		writeManifest([{key: "bildirim.markRead", fanned: false}]);
		writeFeature("bildirim", ["bildirim.markRead"], false);
		const exit = await run(checkFanout(root));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, drift) when a discovered mutation has no manifest row", async () => {
		writeManifest([{key: "post.submit", fanned: true}]);
		writeFeature("pano", ["post.submit", "post.newthing"], true);
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when zero mutations are discovered", async () => {
		writeManifest([{key: "post.submit", fanned: true}]);
		// a feature dir with no mutations.ts ⇒ zero discovered
		mkdirSync(join(root, FEATURES, "empty"), {recursive: true});
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});

	it("FAILS (CheckFailed, fail-closed) when the manifest is empty", async () => {
		mkdirSync(join(root, FEATURES, "fate-live"), {recursive: true});
		writeFileSync(
			join(root, FEATURES, "fate-live", "fanned-mutations.ts"),
			"export const FANNED_MUTATIONS = [];\n",
			"utf8",
		);
		writeFeature("pano", ["post.submit"], true);
		const exit = await run(checkFanout(root));
		expect(isCheckFailed(exit)).toBe(true);
	});
});
