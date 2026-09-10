import {Effect, FileSystem, Path, Result, Stream} from "effect";
import {ChildProcess, ChildProcessSpawner} from "effect/unstable/process";
import {dependencyReconcilerKey} from "../config/keys/dependency-reconciler.ts";
import {readKey} from "../config/read-key.ts";
import {execCapture, execStatus} from "../io/exec.ts";
import {sessionIdFrom, sessionIdUnset} from "../io/session-id.ts";
import {collectCodexDispatch} from "../spend/codex-dispatch-collector.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {read as readBrief} from "../wire/lane-brief.ts";
import type {BriefOptions} from "./brief-verb.ts";
import {LANE_UNREADABLE, NO_SHELL, PROOF_ABSENT} from "./codes.ts";
import {CODEX_ROLE_SKILLS, codexPrompt, reportedTerminal} from "./codex-dispatch.ts";
import {applyEvent, foldLog} from "./fold.ts";
import {bareEvent} from "./machine.ts";
import type {ProveOptions} from "./prove-verb.ts";
import {loadRefusal, replayRefusal} from "./refusals.ts";
import {type LoadedLane, loadLane} from "./store.ts";

const VERB = "fabrika lane dispatch";
type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
type Snapshot = Extract<LoadedLane, {_tag: "Loaded"}>;

export interface DispatchOptions extends BriefOptions {
	readonly cwd: string;
	readonly harness: string;
	readonly skills: string;
	readonly worktree: string;
}

export const runDispatch = Effect.fn("lane.dispatch")(function* (
	options: DispatchOptions,
	brief: (options: BriefOptions) => Effect.Effect<VerbOutcome, never, Services>,
	prove: (options: ProveOptions, snapshot: Snapshot) => Effect.Effect<VerbOutcome, never, Services>,
): Effect.fn.Return<VerbOutcome, never, Services> {
	if (options.harness !== "codex") return refuse(NO_SHELL, `${VERB}: unsupported harness.`);
	const identity = sessionIdFrom(options.env);
	if (identity === null) return refuse(LANE_UNREADABLE, `${VERB}: ${sessionIdUnset}.`);
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (!path.isAbsolute(options.worktree) || !path.isAbsolute(options.skills)) {
		return refuse(LANE_UNREADABLE, `${VERB}: --worktree and --skills must be absolute paths.`);
	}
	const emitted = yield* brief(options);
	if (emitted.code !== 0) return emitted;
	const parsed = readBrief(emitted.stdout);
	if (parsed._tag !== "Found") return refuse(LANE_UNREADABLE, `${VERB}: ${parsed.reason}.`);
	const task = parsed.value.task;
	const loaded = yield* loadLane(options);
	if (loaded._tag !== "Loaded") return loadRefusal(VERB, loaded);
	const folded = foldLog(loaded.lane, loaded.entries);
	if (folded._tag !== "Folded") return replayRefusal(VERB, loaded.logPath, folded);
	if (
		folded.states[task]?.type !== parsed.value.state ||
		applyEvent(loaded.lane, folded.states, task, "BLOCKED", new Date().toISOString())._tag ===
			"Refused"
	)
		return refuse(NO_SHELL, `${VERB}: task is not active in the brief's state.`);
	const skills: string[] = [];
	for (const name of CODEX_ROLE_SKILLS[parsed.value.shell]) {
		const file = path.join(options.skills, name, "SKILL.md");
		const read = yield* Effect.result(fs.readFileString(file));
		if (Result.isFailure(read) || read.success.trim() === "") {
			return refuse(LANE_UNREADABLE, `${VERB}: required stage skill is unreadable: ${file}.`);
		}
		skills.push(file);
	}
	const exists = yield* Effect.result(fs.exists(options.worktree));
	if (Result.isFailure(exists) || exists.success) {
		return refuse(
			LANE_UNREADABLE,
			`${VERB}: worktree path must be absent; retain existing work for recovery.`,
		);
	}
	const source = yield* execCapture("git", ["-C", options.cwd, "rev-parse", "--show-toplevel"]);
	const common = yield* execCapture("git", [
		"-C",
		options.cwd,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (!source.ok || !common.ok)
		return refuse(LANE_UNREADABLE, `${VERB}: cannot establish source repository.`);
	const parent = yield* Effect.result(fs.realPath(path.dirname(options.worktree)));
	if (Result.isFailure(parent))
		return refuse(LANE_UNREADABLE, `${VERB}: worktree parent must exist and be readable.`);
	const destination = path.join(parent.success, path.basename(options.worktree));
	const primary = path.dirname(common.stdout.trim());
	if (
		[source.stdout.trim(), primary].some(
			(root) => destination === root || destination.startsWith(`${root}/`),
		)
	) {
		return refuse(
			LANE_UNREADABLE,
			`${VERB}: worktree must be outside the source and primary checkout.`,
		);
	}
	const ground = parsed.value.ground;
	const base = ground._tag === "Epic" || ground._tag === "EpicRange" ? ground.branch : "HEAD";
	const revision = yield* execCapture("git", [
		"-C",
		options.cwd,
		"rev-parse",
		"--verify",
		`${base}^{commit}`,
	]);
	if (!revision.ok)
		return refuse(LANE_UNREADABLE, `${VERB}: cannot resolve worktree base: ${revision.reason}.`);
	const lock = path.join(loaded.dir, `dispatch-${task}.lock`);
	const acquired = yield* Effect.result(fs.makeDirectory(lock));
	if (Result.isFailure(acquired))
		return refuse(LANE_UNREADABLE, `${VERB}: dispatch is held or unreadable: ${lock}.`);
	return yield* Effect.gen(function* () {
		const fresh = yield* loadLane(options);
		if (
			fresh._tag !== "Loaded" ||
			JSON.stringify(fresh.entries) !== JSON.stringify(loaded.entries)
		) {
			return refuse(LANE_UNREADABLE, `${VERB}: lane moved before dispatch; re-read it.`);
		}
		const created = yield* execCapture("git", [
			"-C",
			options.cwd,
			"worktree",
			"add",
			"--detach",
			options.worktree,
			revision.stdout.trim(),
		]);
		if (!created.ok)
			return refuse(LANE_UNREADABLE, `${VERB}: worktree creation failed: ${created.reason}.`);
		const actual = yield* fs.realPath(options.worktree);
		const root = yield* execCapture("git", ["-C", actual, "rev-parse", "--show-toplevel"]);
		const head = yield* execCapture("git", ["-C", actual, "rev-parse", "HEAD"]);
		const shared = yield* execCapture("git", [
			"-C",
			actual,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		const clean = yield* execCapture("git", ["-C", actual, "status", "--porcelain"]);
		if (
			!root.ok ||
			root.stdout.trim() !== actual ||
			!head.ok ||
			head.stdout !== revision.stdout ||
			!shared.ok ||
			shared.stdout !== common.stdout ||
			!clean.ok ||
			clean.stdout !== ""
		) {
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: new worktree identity or cleanliness is unproven; retained ${actual}.`,
			);
		}
		const reconciler = yield* readKey(actual, dependencyReconcilerKey);
		if (reconciler._tag === "Refused")
			return refuse(LANE_UNREADABLE, `${VERB}: ${reconciler.reason}.`);
		if (reconciler.value !== null) {
			const [binary, ...args] = reconciler.value.argv;
			const installed = yield* execStatus(binary, args, actual);
			if (installed._tag === "Unstartable" || !installed.ok)
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: dependency reconciliation failed; retained ${actual}.`,
				);
			const unchanged = yield* execCapture("git", [
				"-C",
				actual,
				"status",
				"--porcelain",
				"--untracked-files=no",
			]);
			if (!unchanged.ok || unchanged.stdout !== "")
				return refuse(
					LANE_UNREADABLE,
					`${VERB}: dependency reconciliation changed tracked files; retained ${actual}.`,
				);
		}
		const codexHome = options.env.CODEX_HOME ?? path.join(options.env.HOME ?? "", ".codex");
		const usage = {
			sessions: path.join(codexHome, "sessions"),
			ledger: path.join(primary, ".fabrika", "spend-ledger.jsonl"),
			state: path.join(common.stdout.trim(), "fabrika-codex-usage", "dispatch"),
			worktree: actual,
			work: {
				repo: options.repo,
				issue: Number(parsed.value.issue.split("/").at(-1)),
				run: `lane:${options.lane}:${task}`,
			},
		};
		yield* collectCodexDispatch(usage);
		const child = yield* Effect.scoped(
			Effect.gen(function* () {
				yield* Effect.forkScoped(
					Effect.forever(
						Effect.gen(function* () {
							yield* Effect.sleep("5 seconds");
							yield* collectCodexDispatch(usage);
						}),
					),
				);
				const handle = yield* ChildProcess.make("codex", ["exec", "--cd", actual, "-"], {
					cwd: actual,
					env: {...options.env, FABRIKA_SESSION_ID: identity},
					extendEnv: false,
					stdin: Stream.fromIterable([
						new TextEncoder().encode(codexPrompt(skills, emitted.stdout)),
					]),
				});
				const [, , code] = yield* Effect.all(
					[
						Stream.run(handle.stdout, fs.sink(path.join(loaded.dir, `dispatch-${task}.stdout`))),
						Stream.run(handle.stderr, fs.sink(path.join(loaded.dir, `dispatch-${task}.stderr`))),
						handle.exitCode,
					],
					{concurrency: "unbounded"},
				);
				return code;
			}),
		).pipe(Effect.ensuring(collectCodexDispatch(usage)));
		if (child !== 0)
			return refuse(
				LANE_UNREADABLE,
				`${VERB}: codex exited ${child}; worktree retained at ${actual}.`,
			);
		const after = yield* loadLane(options);
		if (after._tag !== "Loaded") return loadRefusal(VERB, after);
		const replay = foldLog(after.lane, after.entries);
		if (replay._tag !== "Folded") return replayRefusal(VERB, after.logPath, replay);
		const report = reportedTerminal(loaded.entries, after.entries, task);
		if (report === null)
			return refuse(
				PROOF_ABSENT,
				`${VERB}: child recorded no unique task terminal; retained ${actual}.`,
			);
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const proof = yield* prove(
			{
				...options,
				cwd: actual,
				task,
				event: bareEvent(report.event),
				classes: report.classes ?? null,
				pr: report.pr ?? null,
			},
			loaded,
		).pipe(
			Effect.provideService(
				ChildProcessSpawner.ChildProcessSpawner,
				ChildProcessSpawner.make((command) => spawner.spawn(ChildProcess.setCwd(command, actual))),
			),
		);
		if (proof.code !== 0) return proof;
		return answer(
			JSON.stringify({harness: "codex", task, event: report.event, worktree: actual}),
			proof.stderr,
		);
	}).pipe(
		Effect.ensuring(Effect.ignore(fs.remove(lock, {recursive: true}))),
		Effect.catchTag("PlatformError", (error) =>
			Effect.succeed(
				refuse(
					LANE_UNREADABLE,
					`${VERB}: ${error.message}; worktree retained at ${options.worktree}.`,
				),
			),
		),
	);
});
