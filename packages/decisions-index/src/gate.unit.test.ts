/**
 * `checkIndex` / `generateIndex` over a fake `.decisions` dir — the capability-seam
 * test (#855). The pure derivation (`buildIndex` + parse/sort/dup helpers) is
 * covered in `decisions-index.unit.test.ts`; this crosses the filesystem gate seam
 * over a real temp dir (the fake `.decisions`), asserting the exit-code contract
 * (ADR 0066) from observable outcomes — never by spawning the bin:
 *   - clean (committed index matches the build) → `checkIndex` succeeds (exit 0);
 *   - stale (committed index differs) → `CheckFailed` (the non-zero gate);
 *   - duplicate ADR id → `CheckFailed` (the dup-id gate, same step);
 *   - `generateIndex` writes the index a subsequent `checkIndex` then passes.
 */
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, beforeEach, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit} from "effect";
import {buildIndex} from "./decisions-index.ts";
import {CheckFailed, checkIndex, generateIndex} from "./gate.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "decisions-index-gate-"));
});
afterEach(() => {
	rmSync(dir, {recursive: true, force: true});
});

const adr = (id: string, title: string, slug = "x"): {name: string; text: string} => ({
	name: `${id}-${slug}.md`,
	text: `---\nid: ${id}\ntitle: ${title}\nstatus: accepted\ndate: 2026-06-20\ntags: [a]\n---\n\n# ${id} — ${title}\n\nbody\n`,
});

const writeAdr = (a: {name: string; text: string}) =>
	writeFileSync(join(dir, a.name), a.text, "utf8");
const writeIndex = (content: string) => writeFileSync(join(dir, "index.md"), content, "utf8");

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromiseExit(effect);

describe("checkIndex — the CI exit-code gate over a fake .decisions dir (ADR 0066)", () => {
	it("PASSES (exit 0) when the committed index.md matches the build", async () => {
		const files = [adr("0001", "First"), adr("0002", "Second")];
		for (const f of files) writeAdr(f);
		// A fresh index, built the same way `checkIndex` builds it.
		writeIndex(buildIndex(files.map((f) => ({file: f.name, text: f.text}))));

		const exit = await run(checkIndex(dir));
		assert.isTrue(Exit.isSuccess(exit));
	});

	it("FAILS (CheckFailed → non-zero) when the committed index.md is stale", async () => {
		writeAdr(adr("0001", "First"));
		writeIndex("# Decisions\n\nstale, hand-edited, does not match\n");

		const exit = await run(checkIndex(dir));
		assert.isTrue(Exit.isFailure(exit));
		if (Exit.isFailure(exit)) {
			const error = Cause.squash(exit.cause);
			assert.isTrue(error instanceof CheckFailed);
			if (error instanceof CheckFailed) assert.include(error.reason, "stale");
		}
	});

	it("FAILS (CheckFailed → non-zero) on a duplicate ADR id, even if the index is fresh", async () => {
		// Two files share id 0001 — the dup-id gate fires inside `build` regardless of index.
		writeAdr(adr("0001", "First", "a"));
		writeAdr(adr("0001", "Dup", "b"));

		const exit = await run(checkIndex(dir));
		assert.isTrue(Exit.isFailure(exit));
		if (Exit.isFailure(exit)) {
			const error = Cause.squash(exit.cause);
			assert.isTrue(error instanceof CheckFailed);
			if (error instanceof CheckFailed) assert.include(error.reason, "0001");
		}
	});
});

describe("generateIndex — writes the index a subsequent checkIndex passes", () => {
	it("writes index.md from the ADR files; checkIndex then PASSES on it", async () => {
		const files = [adr("0001", "First"), adr("0002", "Second")];
		for (const f of files) writeAdr(f);

		const genExit = await run(generateIndex(dir));
		assert.isTrue(Exit.isSuccess(genExit));

		// The written index is exactly the build, and the gate now passes.
		const written = readFileSync(join(dir, "index.md"), "utf8");
		assert.strictEqual(written, buildIndex(files.map((f) => ({file: f.name, text: f.text}))));
		const checkExit = await run(checkIndex(dir));
		assert.isTrue(Exit.isSuccess(checkExit));
	});
});
