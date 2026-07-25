/**
 * The `workflow-contract` filesystem gate — the IO seam behind #1219's Workflow-
 * script contract check, split from `command.ts` so it is crossable in unit tests
 * over a fake `.claude/workflows/` dir rather than only by spawning the bin (the
 * core-in-its-own-file idiom; #855).
 *
 * `checkWorkflows` is the CI gate: it enumerates `<root>/.claude/workflows/*.js`,
 * reads each, and delegates the verdict to the pure core (`workflow-contract.ts`).
 * It fails `CheckFailed` (exit non-zero) on ANY contract violation. It FAILS CLOSED
 * (ADR 0092): a script that exists but cannot be read is an `IoError` (non-zero), and
 * a script that cannot be parsed surfaces as an `unparseable` violation from the core
 * — neither silently passes. An EMPTY set (the dir is absent, or holds no `*.js`) is
 * a clean pass: there is nothing whose load shape could break, so there is nothing to
 * fail. A present-but-unparseable script is the case that must red, and it does.
 */
import {Console, Effect, FileSystem, Path} from "effect";
import * as Schema from "effect/Schema";
import {judge, judgeScript, renderReport, type ScriptVerdict} from "./workflow-contract.ts";

/** A directory/file IO failure: the run couldn't complete. */
export class IoError extends Schema.TaggedErrorClass<IoError>()("IoError", {
	path: Schema.String,
	cause: Schema.Unknown,
}) {}

/** Carries the non-zero gate-fail exit (the report is already on stderr). */
export class CheckFailed extends Schema.TaggedErrorClass<CheckFailed>()("CheckFailed", {
	reason: Schema.String,
}) {}

/** The workflow-script surface this guard owns (ADR 0062 — repo-relative, POSIX). */
const WORKFLOWS_DIR = ".claude/workflows";

/**
 * List the `*.js` workflow scripts under `<root>/.claude/workflows`, repo-relative.
 *
 * Directory/file IO goes through the Effect `FileSystem`/`Path` seam (over the bin's
 * `NodeServices.layer`), so a gate `unit` test substitutes an in-memory fs for the real
 * disk (.patterns/effect-platform-access.md); a fs fault folds `PlatformError` → the
 * `IoError` this gate already carries. This is the one why-note for the file's
 * platform-seam migration — `scanWorkflowScripts` below follows the same shape.
 */
export const listWorkflowScripts = (
	root: string,
): Effect.Effect<ReadonlyArray<string>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const base = path.join(root, WORKFLOWS_DIR);
		if (!(yield* fs.exists(base).pipe(Effect.orElseSucceed(() => false)))) return [];
		const names = yield* fs
			.readDirectory(base)
			.pipe(Effect.mapError((cause) => new IoError({path: base, cause})));
		const scripts: Array<string> = [];
		for (const name of names) {
			if (!name.endsWith(".js")) continue;
			const abs = path.join(base, name);
			// A symlinked `.js` is out of scope, reconstructing the pre-migration `Dirent.isFile()`
			// (lstat-based, so a link-to-file was excluded). `fs.stat` follows links and v4's
			// FileSystem exposes no `lstat`, but `readLink` succeeds only on a link — the equivalent
			// test (same reconstruction as `reachability-guard`'s walk, #3929).
			const isSymlink = yield* fs.readLink(abs).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
			);
			if (isSymlink) continue;
			const isFile =
				(yield* fs.stat(abs).pipe(Effect.mapError((cause) => new IoError({path: abs, cause}))))
					.type === "File";
			if (isFile) scripts.push(`${WORKFLOWS_DIR}/${name}`);
		}
		return scripts.sort();
	});

/** Read + judge every workflow script under `root` into per-script verdicts. */
export const scanWorkflowScripts = (
	root: string,
): Effect.Effect<ReadonlyArray<ScriptVerdict>, IoError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const files = yield* listWorkflowScripts(root);
		const verdicts: ScriptVerdict[] = [];
		for (const file of files) {
			const text = yield* fs
				.readFileString(path.join(root, file), "utf8")
				.pipe(Effect.mapError((cause) => new IoError({path: file, cause})));
			verdicts.push(judgeScript(file, text));
		}
		return verdicts;
	});

/**
 * The CI gate: succeed when every `.claude/workflows/*.js` conforms to the runtime
 * contract, else `CheckFailed` with the per-violation report. An empty set passes
 * clean; a present-but-violating (or unparseable) script reds — fail-closed (ADR 0092).
 */
export const checkWorkflows = (
	root: string,
): Effect.Effect<void, IoError | CheckFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const verdicts = yield* scanWorkflowScripts(root);
		const verdict = judge(verdicts);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
