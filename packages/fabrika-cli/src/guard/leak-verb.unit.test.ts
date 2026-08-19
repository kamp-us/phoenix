/**
 * `guard leak-guard scan`'s file boundary and exit taxonomy, over a scripted filesystem — including
 * the two seats v1 did not have: an empty file list reds, and an unreadable handed file is UNKNOWN.
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runLeakGuard} from "./leak-verb.ts";

const ROOT = "/repo";

const run = (
	files: ReadonlyArray<string>,
	options: FakeFsOptions,
	env: Record<string, string | undefined> = {},
) =>
	Effect.runPromise(Effect.provide(runLeakGuard({files, cwd: ROOT, env}), fakeFs(options).layer));

const tree = (files: Readonly<Record<string, string>>): FakeFsOptions => ({
	files: Object.fromEntries(Object.entries(files).map(([name, text]) => [`${ROOT}/${name}`, text])),
});

describe("runLeakGuard", () => {
	it("passes a clean diff and names what each surface contributed", async () => {
		const outcome = await run(
			["docs/guide.md", "scripts/run.sh", "src/a.ts"],
			tree({
				"docs/guide.md": "see apps/web/worker/index.ts",
				"scripts/run.sh": "pnpm build",
				"src/a.ts": "const p = '/Users/alice/x'",
			}),
		);
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("1 doc surface, 1 shell surface");
		expect(outcome.stdout).toContain("1 out of scope");
		expect(outcome.stderr).toEqual([]);
	});

	it("reds a leaking doc on the violation seat, with nothing on stdout", async () => {
		const outcome = await run(
			["docs/guide.md"],
			tree({"docs/guide.md": "notes at /Users/alice/vault"}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("docs/guide.md: /Users/alice");
	});

	it("reds a leaking shell script — the surface that used to walk off the scan", async () => {
		const outcome = await run(
			["scripts/run.sh"],
			tree({"scripts/run.sh": "# from ~/code/github.com/acme/thing"}),
		);
		expect(outcome.code).toBe(VIOLATION);
	});

	it("leaves a self-exempt doc alone", async () => {
		const outcome = await run(["CLAUDE.md"], tree({"CLAUDE.md": "rebuilt from ~/code/x/y/z"}));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("1 self-exempt");
	});

	it("annotates each finding on its own file under Actions", async () => {
		const outcome = await run(
			["docs/guide.md"],
			tree({"docs/guide.md": "notes at /Users/alice/vault"}),
			{GITHUB_ACTIONS: "true"},
		);
		expect(outcome.stderr.some((line) => line.startsWith("::error file=docs/guide.md::"))).toBe(
			true,
		);
	});

	it("emits no annotation off a runner", async () => {
		const outcome = await run(
			["docs/guide.md"],
			tree({"docs/guide.md": "notes at /Users/alice/vault"}),
		);
		expect(outcome.stderr.some((line) => line.startsWith("::"))).toBe(false);
	});

	// v1 answered this clean. A scan that covered nothing has proven nothing (ADR 0092).
	it("fails closed on an empty file list", async () => {
		const outcome = await run([], tree({}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("ZERO files");
	});

	// A path that is simply gone carries no bytes to leak; a rename's source can still be handed in.
	it("passes over a handed file that is not there", async () => {
		const outcome = await run(["docs/gone.md"], tree({}));
		expect(outcome.code).toBe(0);
	});

	// v1 skipped an unreadable file silently, which reads exactly like a clean one.
	it("answers UNKNOWN when a handed file exists and cannot be read", async () => {
		const outcome = await run(["docs/guide.md"], {
			...tree({"docs/guide.md": "x"}),
			unreadable: [`${ROOT}/docs/guide.md`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});
});
