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
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect} from "effect";
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

/** The workflow-script surface this guard owns (ADR 0062 — repo-relative). */
const WORKFLOWS_DIR = join(".claude", "workflows");

/** List the `*.js` workflow scripts under `<root>/.claude/workflows`, repo-relative. */
export const listWorkflowScripts = (root: string): Effect.Effect<ReadonlyArray<string>, IoError> =>
	Effect.try({
		try: () => {
			const base = join(root, WORKFLOWS_DIR);
			if (!existsSync(base)) return [];
			return readdirSync(base, {withFileTypes: true})
				.filter((e) => e.isFile() && e.name.endsWith(".js"))
				.map((e) => join(WORKFLOWS_DIR, e.name))
				.sort();
		},
		catch: (cause) => new IoError({path: join(root, WORKFLOWS_DIR), cause}),
	});

/** Read + judge every workflow script under `root` into per-script verdicts. */
export const scanWorkflowScripts = (
	root: string,
): Effect.Effect<ReadonlyArray<ScriptVerdict>, IoError> =>
	Effect.gen(function* () {
		const files = yield* listWorkflowScripts(root);
		const verdicts: ScriptVerdict[] = [];
		for (const file of files) {
			const text = yield* Effect.try({
				try: () => readFileSync(join(root, file), "utf8"),
				catch: (cause) => new IoError({path: file, cause}),
			});
			verdicts.push(judgeScript(file, text));
		}
		return verdicts;
	});

/**
 * The CI gate: succeed when every `.claude/workflows/*.js` conforms to the runtime
 * contract, else `CheckFailed` with the per-violation report. An empty set passes
 * clean; a present-but-violating (or unparseable) script reds — fail-closed (ADR 0092).
 */
export const checkWorkflows = (root: string): Effect.Effect<void, IoError | CheckFailed> =>
	Effect.gen(function* () {
		const verdicts = yield* scanWorkflowScripts(root);
		const verdict = judge(verdicts);
		if (verdict.pass) {
			yield* Console.log(renderReport(verdict));
			return;
		}
		return yield* Effect.fail(new CheckFailed({reason: renderReport(verdict)}));
	});
