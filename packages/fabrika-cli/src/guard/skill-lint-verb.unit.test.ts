/**
 * `guard skill-lint check` — the scope walk, the three fail-closed floors and the exit taxonomy,
 * over a scripted filesystem.
 *
 * The floors are what the port moved out of `skill-gh-lint.yml`'s bash and into a tested verb, so
 * each one is asserted here rather than trusted: a symlinked corpus root, an empty walk, and a
 * plugin dir the walk never reached (#5004).
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {type FakeFsOptions, fakeFs} from "../fakes.test-support.ts";
import {PRECONDITION_UNKNOWN, VIOLATION, ZERO_SCOPE} from "./codes.ts";
import {runSkillLint} from "./skill-lint-verb.ts";

const ROOT = "/repo";
const CORPUS = `${ROOT}/claude-plugins`;

const run = (options: FakeFsOptions, env: Record<string, string | undefined> = {}) =>
	Effect.runPromise(
		Effect.provide(runSkillLint({root: ROOT, cwd: ROOT, env}), fakeFs(options).layer),
	);

/** A skill file that satisfies every scope axis: frontmatter, a fence, and clean text. */
const skill = (body = "") =>
	["---", "name: x", "description: does a thing.", "---", "", "```bash", body, "```", ""].join(
		"\n",
	);

/**
 * A corpus of `plugin → {file → contents}`. Every path a walk touches is scripted: the plugin dir
 * listings, the skills dir under each, and the file bodies.
 */
const corpus = (
	plugins: Readonly<Record<string, Readonly<Record<string, string>>>>,
): FakeFsOptions => {
	const dirs: Record<string, ReadonlyArray<string>> = {
		[CORPUS]: Object.keys(plugins),
	};
	const files: Record<string, string> = {};
	const directories = [CORPUS];
	for (const [plugin, held] of Object.entries(plugins)) {
		const dir = `${CORPUS}/${plugin}`;
		directories.push(dir);
		dirs[dir] = Object.keys(held);
		for (const [name, content] of Object.entries(held)) files[`${dir}/${name}`] = content;
	}
	return {dirs, files, directories};
};

describe("runSkillLint", () => {
	it("passes a clean corpus, naming what it walked", async () => {
		const outcome = await run(corpus({fabrika: {"SKILL.md": skill("fabrika build push")}}));
		expect(outcome.code).toBe(0);
		expect(outcome.stdout).toContain("clean — 1 file(s)");
		expect(outcome.stderr).toEqual([]);
	});

	it("reds a GraphQL-path gh call on the violation seat, with nothing on stdout", async () => {
		const outcome = await run(corpus({fabrika: {"SKILL.md": skill("gh pr edit 5 --body x")}}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("GraphQL-path gh call");
		expect(outcome.stderr.join("\n")).toContain("claude-plugins/fabrika/SKILL.md:7");
	});

	it("reds a bare `git push` in a fence and names the sanctioned verb", async () => {
		const outcome = await run(corpus({fabrika: {"SKILL.md": skill("git push -u origin main")}}));
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("fabrika build push");
	});

	it("reds unparseable frontmatter", async () => {
		const broken = ["---", "name: x", "description: do a thing: then another", "---", ""].join(
			"\n",
		);
		const outcome = await run(
			corpus({fabrika: {"SKILL.md": skill(), "agents/x.md": broken}, other: {"SKILL.md": skill()}}),
		);
		expect(outcome.code).toBe(VIOLATION);
		expect(outcome.stderr.join("\n")).toContain("invalid YAML frontmatter");
	});

	it("emits one ::error per finding under Actions, and none outside it", async () => {
		const dirty = corpus({fabrika: {"SKILL.md": skill("gh project list --owner x")}});
		const annotated = await run(dirty, {GITHUB_ACTIONS: "true"});
		expect(annotated.stderr.some((line) => line.startsWith("::error file="))).toBe(true);
		const plain = await run(dirty, {GITHUB_ACTIONS: "false"});
		expect(plain.stderr.some((line) => line.startsWith("::error"))).toBe(false);
	});

	it("reds a walk that matched no file rather than passing it (ADR 0092)", async () => {
		const outcome = await run(corpus({}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("ZERO .md/.sh files");
	});

	it("reds a plugin dir the walk never reached (#5004)", async () => {
		const scoped = corpus({fabrika: {"SKILL.md": skill()}});
		const outcome = await run({
			...scoped,
			dirs: {...scoped.dirs, [CORPUS]: ["fabrika", "uncovered"], [`${CORPUS}/uncovered`]: []},
			directories: [...(scoped.directories ?? []), `${CORPUS}/uncovered`],
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("claude-plugins/uncovered");
	});

	it("reds a corpus root that physically resolves somewhere else", async () => {
		const outcome = await run({
			...corpus({fabrika: {"SKILL.md": skill()}}),
			real: {[CORPUS]: "/elsewhere/claude-plugins"},
		});
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("another tree");
	});

	it("reds a scope axis that saw no file, even when the walk found some", async () => {
		// `.sh` files carry no frontmatter, so a corpus of nothing but shell empties that scope.
		const outcome = await run(corpus({fabrika: {"run.sh": "echo hi\n"}}));
		expect(outcome.code).toBe(ZERO_SCOPE);
		expect(outcome.stderr.join("\n")).toContain("frontmatter");
	});

	it("answers UNKNOWN when a corpus file cannot be read, never clean", async () => {
		const outcome = await run({
			...corpus({fabrika: {"SKILL.md": skill()}}),
			unreadable: [`${CORPUS}/fabrika/SKILL.md`],
		});
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
		expect(outcome.stdout).toBe("");
		expect(outcome.stderr.join("\n")).toContain("UNKNOWN");
	});

	it("answers UNKNOWN when no repo root can be discovered", async () => {
		const outcome = await Effect.runPromise(
			Effect.provide(runSkillLint({root: null, cwd: "/nowhere", env: {}}), fakeFs({}).layer),
		);
		expect(outcome.code).toBe(PRECONDITION_UNKNOWN);
	});
});
