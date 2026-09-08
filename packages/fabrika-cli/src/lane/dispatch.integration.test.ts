import {execFileSync} from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {execCapture} from "../io/exec.ts";
import {answer, refuse} from "../verb.ts";
import {read as readBrief} from "../wire/lane-brief.ts";
import {runBrief} from "./brief-verb.ts";
import {PROOF_ABSENT} from "./codes.ts";
import {runDispatch} from "./dispatch-verb.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

const fixture = (mode = "report") => {
	const seat = realpathSync(mkdtempSync(join(tmpdir(), "fabrika-codex-dispatch-")));
	const cwd = join(seat, "primary");
	const root = join(seat, "lanes");
	const skills = join(seat, "skills");
	const bin = join(seat, "bin");
	for (const dir of [cwd, join(root, "8617"), join(skills, "build"), bin])
		mkdirSync(dir, {recursive: true});
	git(cwd, "init", "--initial-branch=main");
	git(cwd, "config", "user.name", "fixture");
	git(cwd, "config", "user.email", "fixture@example.test");
	writeFileSync(join(cwd, "tracked.txt"), "primary bytes\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "fixture");
	writeFileSync(join(root, "8617", "workflow.json"), coderTemplateText());
	writeFileSync(
		join(root, "8617", "events.jsonl"),
		`${JSON.stringify({task: "issue", event: "ISSUE.WIP", at: "2026-09-08T00:00:00Z"})}\n`,
	);
	writeFileSync(
		join(skills, "build", "SKILL.md"),
		"---\nname: build\ndescription: Fixture.\n---\nBuild.\n",
	);
	const fake = join(bin, "codex");
	writeFileSync(
		fake,
		`#!${process.execPath}\nconst fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync('observed.json', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),input,identity:process.env.FABRIKA_SESSION_ID,model:process.env.FIXTURE_MODEL}));\nif(process.env.FIXTURE_MODE === 'fail') process.exit(9);\nif(process.env.FIXTURE_MODE === 'report') fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({task:'issue',event:'ISSUE.DONE',at:'2026-09-08T00:01:00Z',pr:'https://example.test/pr/1'})+'\\n');\n`,
	);
	chmodSync(fake, 0o755);
	return {
		cwd,
		root,
		skills,
		worktree: join(seat, "child"),
		harness: "codex",
		lane: "8617",
		task: "issue",
		repo: "o/r",
		entrypoint: {_tag: "Entrypoint" as const, entrypoint: "/installed/fabrika/bin.js"},
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			CODEX_THREAD_ID: "codex-thread",
			CODEX_SESSION_ID: undefined,
			FABRIKA_SESSION_ID: undefined,
			CLAUDE_CODE_SESSION_ID: undefined,
			PI_SUBAGENT_PARENT_SESSION: undefined,
			FIXTURE_MODE: mode,
			FIXTURE_MODEL: "kept",
			FIXTURE_LOG: join(root, "8617", "events.jsonl"),
		},
	};
};

// The production emitter is separately tested against board replies; this fixture uses its wire format.
import {artifactUrl, emit, fabrikaEntry, lanesRoot} from "../wire/lane-brief.ts";

const briefFor = (options: ReturnType<typeof fixture>) =>
	emit({
		lane: "8617",
		root: lanesRoot(options.root)!,
		fabrika: fabrikaEntry(options.entrypoint.entrypoint)!,
		task: "issue",
		state: "build",
		shell: "builder",
		issue: artifactUrl("https://example.test/issues/8617")!,
		ground: {_tag: "Pull", pr: null},
	});

describe("Codex dispatch against real git and a fake child process", () => {
	it("isolates actual child cwd, preloads the role, preserves brief and configuration, and proves the report", async () => {
		const options = fixture();
		const original = git(options.cwd, "rev-parse", "HEAD");
		const brief = briefFor(options);
		let proved = false;
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(brief)),
				(proof, snapshot) => {
					proved = true;
					expect(proof.event).toBe("DONE");
					expect(snapshot.entries).toHaveLength(1);
					return Effect.gen(function* () {
						const root = yield* execCapture("git", ["rev-parse", "--show-toplevel"]);
						expect(root.stdout.trim()).toBe(options.worktree);
						return answer("proven");
					});
				},
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(0);
		expect(proved).toBe(true);
		const observation = JSON.parse(readFileSync(join(options.worktree, "observed.json"), "utf8"));
		expect(observation.cwd).toBe(options.worktree);
		expect(observation.args).toEqual(["exec", "--cd", options.worktree, "-"]);
		expect(observation.input.endsWith(brief)).toBe(true);
		expect(readBrief(brief)._tag).toBe("Found");
		expect(observation.input).toContain(join(options.skills, "build", "SKILL.md"));
		expect(observation.identity).toBe("codex-thread");
		expect(observation.model).toBe("kept");
		expect(git(options.cwd, "rev-parse", "HEAD")).toBe(original);
		expect(git(options.cwd, "branch", "--show-current")).toBe("main");
		expect(git(options.cwd, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(options.cwd, "tracked.txt"), "utf8")).toBe("primary bytes\n");
	});
	it.each([
		"fail",
		"silent",
	])("refuses %s children and retains their dirty worktree", async (mode) => {
		const options = fixture(mode);
		let proved = false;
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(briefFor(options))),
				() => {
					proved = true;
					return Effect.succeed(answer("proven"));
				},
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(mode === "fail" ? 11 : PROOF_ABSENT);
		expect(result.stdout).toBe("");
		expect(proved).toBe(false);
		expect(existsSync(join(options.worktree, "observed.json"))).toBe(true);
	});
	it("refuses an unproven terminal despite a successful reporting child", async () => {
		const options = fixture();
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(briefFor(options))),
				() => Effect.succeed(refuse(PROOF_ABSENT, "missing artifact")),
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(PROOF_ABSENT);
	});
	it("refuses unsupported harnesses before reading the board or starting a child", async () => {
		const options = {...fixture(), harness: "unknown"};
		const result = await Effect.runPromise(
			runDispatch(options, runBrief, () => Effect.succeed(answer("unused"))).pipe(
				Effect.provide(NodeServices.layer),
			),
		);
		expect(result.code).toBe(18);
		expect(existsSync(options.worktree)).toBe(false);
	});
	it.each([
		"identity",
		"skill",
		"state",
	])("refuses missing %s before worktree creation", async (missing) => {
		const options = fixture();
		if (missing === "identity") options.env.CODEX_THREAD_ID = "";
		if (missing === "skill") options.skills = join(options.skills, "absent");
		if (missing === "state") writeFileSync(join(options.root, "8617", "events.jsonl"), "");
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(briefFor(options))),
				() => Effect.succeed(answer("unused")),
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).not.toBe(0);
		expect(existsSync(options.worktree)).toBe(false);
	});
	it("rejects a symlinked parent that would create the child inside the primary checkout", async () => {
		const options = fixture();
		const alias = join(options.root, "alias");
		symlinkSync(options.cwd, alias);
		options.worktree = join(alias, "child");
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(briefFor(options))),
				() => Effect.succeed(answer("unused")),
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(11);
		expect(existsSync(join(options.cwd, "child"))).toBe(false);
	});
});
