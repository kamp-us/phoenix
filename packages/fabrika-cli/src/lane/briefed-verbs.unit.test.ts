/**
 * Whether the assembly branch carries the lane verbs a brief names — proven off the branch's own
 * tree, with "the read failed" kept apart from "the path is not there".
 */
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {Effect, Layer, Path} from "effect";
import {describe, expect, it} from "vitest";
import {errOut, fakeFs, fakeShell, okOut} from "../fakes.test-support.ts";
import type {ExecResult} from "../io/exec.ts";
import {fabrikaEntry, gitRef} from "../wire/lane-brief.ts";
import {BRIEFED_LANE_VERBS, carriedVerbs, VERB_MODULES} from "./briefed-verbs.ts";

const BRANCH = gitRef("epic/5817")!;
const SOURCE = fabrikaEntry("packages/fabrika-cli/src/bin.ts")!;
const INSTALLED = fabrikaEntry("/checkout/node_modules/@kampus/fabrika-cli/dist/bin.js")!;
const REPORT = "packages/fabrika-cli/src/lane/report-verb.ts";
const SHA = "6f1a2c4d8e0b3a5f7c9d1e2b4a6c8e0d2f4a6b8c";

const RESOLVE = /^git rev-parse --verify --quiet epic\/5817\^\{commit\}$/;
const LS_TREE = /^git ls-tree --full-tree --name-only /;

/** One scripted command line, matched whole so a pathspec that differs cannot answer for it. */
const argv = (line: string): RegExp =>
	new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

/**
 * The `ls-tree` reads that answer non-empty in a repo whose tree holds `tree`, run with cwd `cwd`.
 *
 * Git resolves a `--full-tree` pathspec against the repository root and a bare one against the
 * process's directory, so one file is reached by two different argv lines depending on where the
 * process stands. Everything else falls through to the caller's empty-stdout fallback — the exit-0
 * answer git gives an unmatched pathspec, which is what this module reads as absence.
 */
const treeReadsFrom = (
	cwd: string,
	tree: ReadonlyArray<string>,
): ReadonlyArray<readonly [RegExp, ExecResult]> =>
	tree.flatMap((file) => {
		const fromCwd =
			cwd === "" ? file : file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : null;
		return [
			[argv(`git ls-tree --full-tree --name-only ${SHA} -- ${file}`), okOut(`${file}\n`)] as const,
			...(fromCwd === null
				? []
				: [[argv(`git ls-tree --name-only ${SHA} -- ${fromCwd}`), okOut(`${file}\n`)] as const]),
		];
	});

const run = (
	script: ReadonlyArray<readonly [RegExp, ExecResult]>,
	entrypoint = SOURCE,
	fallback?: ExecResult,
) => {
	const shell = fakeShell(script, fallback);
	return Effect.runPromise(
		Effect.provide(
			Effect.gen(function* () {
				const path = yield* Path.Path;
				return yield* carriedVerbs(path, BRANCH, entrypoint);
			}),
			Layer.merge(shell.layer, fakeFs({}).layer),
		),
	).then((carriage) => ({carriage, calls: shell.calls}));
};

describe("carriedVerbs", () => {
	it("answers carried when the branch's tree holds every briefed verb's module", async () => {
		const {carriage, calls} = await run([
			[RESOLVE, okOut(`${SHA}\n`)],
			[LS_TREE, okOut(`${REPORT}\n`)],
		]);

		expect(carriage._tag).toBe("Carried");
		// The path is read out of the branch's tree by sha, never out of the working tree on disk.
		expect(calls).toContain(`git ls-tree --full-tree --name-only ${SHA} -- ${REPORT}`);
	});

	it("names every verb the tree does not hold, and reads it as absence rather than as a failure", async () => {
		const {carriage} = await run([
			[RESOLVE, okOut(`${SHA}\n`)],
			[LS_TREE, okOut("")],
		]);

		expect(carriage).toEqual({_tag: "Missing", verbs: ["report"]});
	});

	it("is UNKNOWN when the branch does not resolve in this tree", async () => {
		const {carriage, calls} = await run([[RESOLVE, errOut("fatal: bad revision")]]);

		expect(carriage._tag).toBe("Unreadable");
		expect(calls.some((call) => call.includes("ls-tree"))).toBe(false);
	});

	it("is UNKNOWN when the tree read itself fails, never 'the verb is missing'", async () => {
		const {carriage} = await run([
			[RESOLVE, okOut(`${SHA}\n`)],
			[LS_TREE, errOut("fatal: not a tree object")],
		]);

		expect(carriage._tag).toBe("Unreadable");
	});

	it("reads no branch at all for an installed entrypoint the branch cannot carry", async () => {
		const {carriage, calls} = await run([], INSTALLED);

		expect(carriage._tag).toBe("Carried");
		expect(calls).toEqual([]);
	});

	for (const cwd of ["", "packages/fabrika-cli"]) {
		const where = cwd === "" ? "the repository root" : cwd;

		it(`answers carried for a present module from ${where}`, async () => {
			const {carriage} = await run(
				[[RESOLVE, okOut(`${SHA}\n`)], ...treeReadsFrom(cwd, [REPORT])],
				SOURCE,
				okOut(""),
			);

			expect(carriage._tag).toBe("Carried");
		});

		it(`answers missing for a genuinely absent module from ${where}`, async () => {
			const {carriage} = await run(
				[[RESOLVE, okOut(`${SHA}\n`)], ...treeReadsFrom(cwd, [])],
				SOURCE,
				okOut(""),
			);

			expect(carriage).toEqual({_tag: "Missing", verbs: ["report"]});
		});
	}

	it("maps every briefed verb to a module this tree actually has", () => {
		for (const verb of BRIEFED_LANE_VERBS) {
			const file = fileURLToPath(new URL(`../${VERB_MODULES[verb]}.ts`, import.meta.url));
			expect(existsSync(file), `${verb} maps to ${file}`).toBe(true);
		}
	});
});
