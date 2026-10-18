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
import {Console, Deferred, Effect, Fiber, FileSystem, Layer} from "effect";
import {TestClock} from "effect/testing";
import {ChildProcessSpawner} from "effect/unstable/process";
import {describe, expect, it} from "vitest";
import {execCapture} from "../io/exec.ts";
import {readUsageLedger} from "../spend/usage-ledger.ts";
import {SUBPROCESS_TEST_TIMEOUT_MS} from "../test-budget.ts";
import {answer, refuse} from "../verb.ts";
import {read as readBrief} from "../wire/lane-brief.ts";
import {runBrief} from "./brief-verb.ts";
import {PROOF_ABSENT} from "./codes.ts";
import {runDispatch} from "./dispatch-verb.ts";
import {coderTemplateText} from "./fixtures.test-support.ts";

/**
 * Every lane here is a single-issue one, which owns no assembly branch: a refresher reached at all
 * would be dispatch refreshing a branch that does not exist.
 */
const neverRefreshed = () => {
	throw new Error("a single-issue lane dispatched through a pre-dispatch assembly refresh");
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {cwd, encoding: "utf8"}).trim();

const fixture = (mode = "report", policy?: unknown) => {
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
	writeFileSync(join(cwd, ".gitignore"), ".fabrika/\n");
	if (policy !== undefined)
		writeFileSync(join(cwd, ".fabrika.jsonc"), JSON.stringify({codexUsage: policy}));
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
	const codexHome = join(seat, "codex-home");
	mkdirSync(join(codexHome, "sessions"), {recursive: true});
	writeFileSync(
		fake,
		`#!${process.execPath}\nconst fs = require('node:fs');\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync('observed.json', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),input,identity:process.env.FABRIKA_SESSION_ID,model:process.env.FIXTURE_MODEL}));
const usage={input_tokens:100,cached_input_tokens:20,cache_write_input_tokens:5,output_tokens:10,reasoning_output_tokens:3,total_tokens:110};
for(const [id,parent] of [['native-root',null],['native-child','native-root'],['native-grandchild','native-child']]) {
const rows=[{type:'session_meta',payload:{id,parent_thread_id:parent,session_id:'native-root',cwd:process.cwd(),cli_version:'0.154.0',model_provider:'openai'}},{type:'turn_context',payload:{turn_id:'turn',model:'native-model'}},{type:'token_usage_record',payload:{thread_id:id,session_id:'native-root',turn_id:'turn',root_turn_id:'turn',response_id:'response',usage,turn_token_usage:usage,thread_token_usage:usage}}];
fs.writeFileSync(process.env.CODEX_HOME+'/sessions/'+id+'.jsonl',rows.map(row=>JSON.stringify(row)).join('\\n')+'\\n');
}
if(process.env.FIXTURE_MODE === 'fail') process.exit(9);\nif(process.env.FIXTURE_MODE === 'report') fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({task:'issue',event:'ISSUE.DONE',at:'2026-09-08T00:01:00Z',pr:'https://example.test/pr/1'})+'\\n');\n`,
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
			CODEX_HOME: codexHome,
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
		ownerComments: {_tag: "None"},
	});

describe("Codex dispatch against real git and a fake child process", {
	timeout: SUBPROCESS_TEST_TIMEOUT_MS,
}, () => {
	it.each([
		"on",
		"off",
	])("honors %s through repeated ticks, completion and interruption", async (policy) => {
		for (const ending of ["report", "interrupt"]) {
			const options = fixture("report", policy);
			const touched: string[] = [],
				notices: string[] = [];
			let proved = false;
			const program = Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const started = yield* Deferred.make<void>(),
					finish = yield* Deferred.make<void>();
				const ledger = join(options.cwd, ".fabrika", "spend-ledger.jsonl");
				const forbidden = [
					options.env.CODEX_HOME,
					join(options.cwd, ".git", "fabrika-codex-usage"),
					ledger,
				];
				const layerStub = new Proxy(fs, {
					get(target, property) {
						const method = Reflect.get(target, property);
						if (typeof method !== "function") return method;
						return (...args: unknown[]) => {
							const file = args[0];
							if (typeof file === "string" && forbidden.some((prefix) => file.startsWith(prefix))) {
								touched.push(`${String(property)}:${file}`);
								if (policy === "off")
									return Effect.die("disabled dispatch touched collection storage");
							}
							return Reflect.apply(method, target, args);
						};
					},
				});
				const dispatch = runDispatch(
					options,
					() => Effect.succeed(answer(briefFor(options))),
					() => {
						proved = true;
						return Effect.succeed(answer("proven"));
					},
					neverRefreshed,
				).pipe(
					Effect.provideService(FileSystem.FileSystem, layerStub),
					Effect.provideService(Console.Console, {
						...console,
						warn: (...args: unknown[]) => {
							notices.push(args.join(" "));
						},
					}),
					Effect.provideService(
						ChildProcessSpawner.ChildProcessSpawner,
						ChildProcessSpawner.make((command) =>
							Effect.map(spawner.spawn(command), (handle) =>
								command._tag !== "StandardCommand" || command.command !== "codex"
									? handle
									: {
											...handle,
											exitCode: Effect.gen(function* () {
												const code = yield* handle.exitCode;
												yield* Deferred.succeed(started, undefined);
												yield* Deferred.await(finish);
												return code;
											}),
										},
							),
						),
					),
				);
				const fiber = yield* Effect.forkChild(dispatch);
				yield* Effect.raceFirst(
					Deferred.await(started),
					Fiber.join(fiber).pipe(Effect.andThen(Effect.die("dispatch ended before child"))),
				);
				const initial = touched.length;
				yield* TestClock.adjust("5 seconds");
				yield* TestClock.adjust("5 seconds");
				const ticks = touched.length;
				if (ending === "interrupt") yield* Fiber.interrupt(fiber);
				else {
					yield* Deferred.succeed(finish, undefined);
					const result = yield* Fiber.join(fiber);
					expect(result.code).toBe(0);
				}
				expect(proved).toBe(ending === "report");
				if (policy === "off") {
					expect(touched).toEqual([]);
					expect(notices).toHaveLength(1);
					expect(notices[0]).toContain("`codexUsage` as declared in .fabrika.jsonc");
					expect(notices[0]).toContain("unavailable");
					expect(existsSync(ledger)).toBe(false);
				} else {
					expect(initial).toBeGreaterThan(0);
					expect(ticks).toBeGreaterThan(initial);
					expect(touched.length).toBeGreaterThan(ticks);
				}
			});
			await Effect.runPromise(
				program.pipe(Effect.provide(Layer.merge(NodeServices.layer, TestClock.layer()))),
			);
		}
	});
	it.each([
		"malformed",
		"unreadable",
	])("refuses %s policy before preparing or launching a stage", async (kind) => {
		const options = fixture("report", kind === "malformed" ? false : undefined);
		if (kind === "unreadable") mkdirSync(join(options.cwd, ".fabrika.jsonc"));
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => {
					throw new Error("brief reached");
				},
				() => {
					throw new Error("proof reached");
				},
				neverRefreshed,
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(11);
		expect(result.stderr.join(" ")).toContain(kind === "malformed" ? "`codexUsage`" : ".fabrika");
		expect(existsSync(options.worktree)).toBe(false);
		expect(existsSync(join(options.cwd, ".git", "fabrika-codex-usage"))).toBe(false);
	});
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
				neverRefreshed,
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
		// The codex tree is on the lane's record, so `lane cleanup` can remove it when the run ends.
		expect(
			JSON.parse(readFileSync(join(options.root, "8617", "worktrees.jsonl"), "utf8")),
		).toMatchObject({kind: "handed", worktree: options.worktree, task: "issue"});
		const usage = readUsageLedger(
			readFileSync(join(options.cwd, ".fabrika", "spend-ledger.jsonl"), "utf8"),
		).records.filter((row) => row.kind === "measurement" && row.basis.kind === "response");
		expect(usage).toHaveLength(3);
		expect(
			usage.every((row) => row.work.issue === 8617 && row.work.run === "lane:8617:issue"),
		).toBe(true);
		expect(usage.map((row) => row.agent.session).sort()).toEqual([
			"native-child",
			"native-grandchild",
			"native-root",
		]);
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
				neverRefreshed,
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(mode === "fail" ? 11 : PROOF_ABSENT);
		expect(result.stdout).toBe("");
		expect(proved).toBe(false);
		expect(existsSync(join(options.worktree, "observed.json"))).toBe(true);
		const records = readUsageLedger(
			readFileSync(join(options.cwd, ".fabrika", "spend-ledger.jsonl"), "utf8"),
		).records;
		expect(
			records.filter((row) => row.kind === "measurement" && row.basis.kind === "response"),
		).toHaveLength(3);
	});
	it("refuses an unproven terminal despite a successful reporting child", async () => {
		const options = fixture();
		const result = await Effect.runPromise(
			runDispatch(
				options,
				() => Effect.succeed(answer(briefFor(options))),
				() => Effect.succeed(refuse(PROOF_ABSENT, "missing artifact")),
				neverRefreshed,
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(PROOF_ABSENT);
	});
	it("refuses unsupported harnesses before reading the board or starting a child", async () => {
		const options = {...fixture(), harness: "unknown"};
		const result = await Effect.runPromise(
			runDispatch(options, runBrief, () => Effect.succeed(answer("unused")), neverRefreshed).pipe(
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
				neverRefreshed,
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
				neverRefreshed,
			).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(result.code).toBe(11);
		expect(existsSync(join(options.cwd, "child"))).toBe(false);
	});
});
