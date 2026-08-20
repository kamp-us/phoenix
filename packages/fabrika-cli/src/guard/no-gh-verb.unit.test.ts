/**
 * `guard no-gh check` — the scope walk, its fail-closed floors and the exit taxonomy, over a
 * scripted filesystem.
 *
 * Each floor is asserted rather than trusted, because each one is a way this guard could go green
 * having judged nothing: a root that resolves elsewhere, an empty walk, and a directory the walk
 * never entered (#5004).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runNoGh} from "./no-gh-verb.ts";

const ROOT = "/repo";
const SOURCE = `${ROOT}/packages/fabrika-cli/src`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(Effect.provide(runNoGh({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer));

/** A source tree of `group → {file → contents}`, with every directory a walk touches scripted. */
const tree = (
	groups: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FakeFsOptions => {
	const dirs: Record<string, ReadonlyArray<string>> = {[SOURCE]: Object.keys(groups)};
	const files: Record<string, string> = {};
	const directories = [SOURCE];
	for (const [group, held] of Object.entries(groups)) {
		const dir = `${SOURCE}/${group}`;
		directories.push(dir);
		dirs[dir] = Object.keys(held);
		for (const [name, content] of Object.entries(held)) files[`${dir}/${name}`] = content;
	}
	return {dirs, files, directories};
};

describe("runNoGh", () => {
	it("passes a package that reaches GitHub over HTTP, naming what it walked", async () => {
		const outcome = await run(
			tree({io: {"pulls.ts": 'const r = yield* restRead(token, "GET", path);\n'}}),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("clean — 1 file(s)");
		expect(outcome.stderr).toEqual([]);
	});

	it("reds a call on the violation seat, with nothing on stdout", async () => {
		const outcome = await run(
			tree({io: {"pulls.ts": 'const r = yield* execCapture("gh", ["api", path]);\n'}}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("packages/fabrika-cli/src/io/pulls.ts:1");
	});

	it("emits one ::error per finding under Actions, and none outside it", async () => {
		const dirty = tree({io: {"pulls.ts": 'execFileSync("gh", ["pr", "merge"]);\n'}});
		const annotated = await run(dirty, {GITHUB_ACTIONS: "true"});
		expect(annotated.stderr.some((line) => line.startsWith("::error file="))).toBe(true);
		const plain = await run(dirty, {GITHUB_ACTIONS: "false"});
		expect(plain.stderr.some((line) => line.startsWith("::error"))).toBe(false);
	});

	it("reds a walk that matched no file rather than passing it (ADR 0092)", async () => {
		const outcome = await run(tree({}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("ZERO .ts files");
	});

	it("reds a directory the walk never reached (#5004)", async () => {
		const scoped = tree({io: {"pulls.ts": "export const x = 1;\n"}});
		const outcome = await run({
			...scoped,
			dirs: {...scoped.dirs, [SOURCE]: ["io", "uncovered"], [`${SOURCE}/uncovered`]: []},
			directories: [...(scoped.directories ?? []), `${SOURCE}/uncovered`],
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("uncovered");
	});

	it("reds a scan root that physically resolves somewhere else", async () => {
		const outcome = await run({
			...tree({io: {"pulls.ts": "export const x = 1;\n"}}),
			real: {[SOURCE]: "/elsewhere/src"},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("another tree");
	});

	it("reds a walk whose every file is self-exempt, so the scan itself saw nothing", async () => {
		const outcome = await run(tree({guard: {"no-gh.ts": "export const x = 1;\n"}}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("zero of the 1 file(s)");
	});

	it("answers UNKNOWN when a source file cannot be read, never clean", async () => {
		const outcome = await run({
			...tree({io: {"pulls.ts": "export const x = 1;\n"}}),
			unreadable: [`${SOURCE}/io/pulls.ts`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when no repo root can be discovered", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runNoGh({root: null, cwd: "/nowhere", env: {}}), fakeFs({}).layer),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
