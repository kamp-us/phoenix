/**
 * The `cli-invocation-guard` tool — `pipeline-cli cli-invocation-guard check <file>…`.
 *
 * Reds on any non-canonical `pipeline-cli` invocation inside runnable shell in the pipeline
 * corpus — a bare `pipeline-cli <verb>` (#3314) or a cwd-relative
 * `node …/pipeline-cli/src/bin.ts <verb>` (#4236) — across **both** corpus surfaces: a runnable
 * fence in a `.md`, and a `.sh` file scanned whole as one implicit fence (#4486). See the formats
 * contract's §CLI for the canonical resolution this enforces and the exit-code taxonomy it
 * protects. Follows the `adoption-lint` / `gh-phoenix
 * lint-skills` shape — an IO-free core over handed-in file contents, with a thin CLI that maps
 * the verdict to a fail-closed exit contract (ADR 0092):
 *
 *   exit 0 — clean (no non-canonical invocation in either surface)
 *   exit 2 — one or more non-canonical invocations
 *   exit 3 — zero scope on any axis: no file scanned, no runnable `.md` fence, or no `.sh` file
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command} from "effect/unstable/cli";
import {type GuardResult, isZeroScope, type ScanFile, scanCorpus} from "./cli-invocation-guard.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

class FindingsFound extends Schema.TaggedErrorClass<FindingsFound>()("FindingsFound", {
	count: Schema.Number,
}) {}
class ZeroScope extends Schema.TaggedErrorClass<ZeroScope>()("ZeroScope", {}) {}

const readFileOrSkip = (file: string): string | null =>
	Result.getOrElse(
		Result.try(() => readFileSync(file, "utf8")),
		() => null,
	);

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription(
		"one or more corpus file paths (SKILL.md / agent defs / plugin docs / extracted `scripts/*.sh`) to scan for non-canonical `pipeline-cli` invocations",
	),
);

const judge = (result: GuardResult): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		if (isZeroScope(result)) {
			yield* Console.error(
				`cli-invocation-guard: FAIL — scanned ${result.scanned.length} file(s): ${result.fenceCount} runnable fence(s) in markdown, ${result.shellFileCount} shell file(s); a zero scope on ANY axis is fail-closed, per surface (ADR 0092, #4486).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}

		if (result.findings.length === 0) {
			yield* Console.log(
				"cli-invocation-guard: clean — every `pipeline-cli` call in runnable shell (fenced or `.sh`) resolves the shim by path (§CLI).",
			);
			return;
		}

		yield* Console.error(
			`cli-invocation-guard: FAIL — ${result.findings.length} non-canonical \`pipeline-cli\` invocation(s) in runnable shell. A bare name is NOT on PATH where agents spawn (ADR 0207 retired PATH-shadowing) and dies \`command not found\` (exit 127); a cwd-relative \`node …/src/bin.ts\` dies \`Cannot find module\` (exit 1, empty stdout) from any dir but the repo root. Either way a fail-closed wrapper turns the miss into a wrong verdict (#3314, #4236):`,
		);
		for (const f of result.findings) {
			yield* Console.error(`  ${f.file}:${f.line}: ${f.text}`);
		}
		yield* Console.error(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the remediation literal a reader pastes, not a JS template
			'  FIX: resolve the shim once per fence — PCLI="${CLAUDE_PLUGIN_ROOT:-$(git rev-parse --show-toplevel)/claude-plugins/kampus-pipeline}/bin/pipeline-cli" — then call "$PCLI" <verb>. See §CLI in claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md.',
		);
		return yield* Effect.fail(new FindingsFound({count: result.findings.length}));
	});

const onZeroScope = (_e: ZeroScope) => Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE));
const onFindingsFound = (_e: FindingsFound) => Effect.sync(() => process.exit(FINDING_EXIT_CODE));

const check = Command.make(
	"check",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const scanInput: ScanFile[] = [];
		for (const file of files) {
			const content = readFileOrSkip(file);
			if (content !== null) scanInput.push({file, content});
		}

		const result = scanCorpus(scanInput);

		// ADR 0092: emit the scanned scope before judging it — one number per surface, so a
		// collapsed surface is legible from the log instead of hiding inside a total.
		yield* Console.log(
			`cli-invocation-guard: scanned ${result.scanned.length} file(s), ${result.fenceCount} runnable bash/sh fence(s) in markdown, ${result.shellFileCount} shell file(s) as implicit fences`,
		);

		yield* judge(result).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Red on any bare or `node …/src/bin.ts` `pipeline-cli` invocation in runnable shell — a bash/sh fence or a whole `.sh` file (fails closed on zero scope, per surface)",
	),
);

export const cliInvocationGuardCommand = Command.make("cli-invocation-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Enforce §CLI: every `pipeline-cli` call in the corpus resolves the shim by path, never bare on PATH (#3314)",
	),
);
