/**
 * The `cli-invocation-guard` tool — `pipeline-cli cli-invocation-guard check <file>…`.
 *
 * Reds on any bare `pipeline-cli <verb>` inside a runnable bash/sh fence in the pipeline
 * corpus (#3314). See the formats contract's §CLI for the canonical resolution this enforces
 * and the exit-code taxonomy it protects. Follows the `adoption-lint` / `gh-phoenix
 * lint-skills` shape — an IO-free core over handed-in file contents, with a thin CLI that maps
 * the verdict to a fail-closed exit contract (ADR 0092):
 *
 *   exit 0 — clean (no bare invocation in any runnable fence)
 *   exit 2 — one or more bare invocations
 *   exit 3 — zero scope (no file scanned, or no runnable fence found)
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
		"one or more corpus file paths (SKILL.md / agent defs / plugin docs) to scan for bare `pipeline-cli` invocations",
	),
);

const judge = (result: GuardResult): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		if (isZeroScope(result)) {
			yield* Console.error(
				`cli-invocation-guard: FAIL — scanned ${result.scanned.length} file(s) containing ${result.fenceCount} runnable fence(s); a zero scope on either axis is fail-closed (ADR 0092).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}

		if (result.findings.length === 0) {
			yield* Console.log(
				"cli-invocation-guard: clean — every `pipeline-cli` call in a runnable fence resolves the shim by path (§CLI).",
			);
			return;
		}

		yield* Console.error(
			`cli-invocation-guard: FAIL — ${result.findings.length} bare \`pipeline-cli\` invocation(s) in runnable fences. \`pipeline-cli\` is NOT on PATH where agents spawn (ADR 0207 retired PATH-shadowing), so these die \`command not found\` at a gate — and a fail-closed wrapper turns that miss into a wrong verdict (#3314):`,
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

		// ADR 0092: emit the scanned scope before judging it.
		yield* Console.log(
			`cli-invocation-guard: scanned ${result.scanned.length} file(s), ${result.fenceCount} runnable bash/sh fence(s)`,
		);

		yield* judge(result).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Red on any bare `pipeline-cli` invocation in a runnable bash/sh fence (fails closed on zero scope)",
	),
);

export const cliInvocationGuardCommand = Command.make("cli-invocation-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Enforce §CLI: every `pipeline-cli` call in the corpus resolves the shim by path, never bare on PATH (#3314)",
	),
);
