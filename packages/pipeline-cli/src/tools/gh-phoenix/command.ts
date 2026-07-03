/**
 * The `gh-phoenix` tool — `pipeline-cli gh-phoenix lint-skills <file>…`.
 *
 * The skill grep-lint for issue #743 (the pure `lintCorpus` core), moved into the
 * pipeline-cli registry (epic #994, Phase 2 / #1002). Lints the handed skill-corpus
 * files for GraphQL-path `gh` invocations (Projects-classic-only on the kamp-us org)
 * AND for invalid YAML frontmatter (#1766 — the durable gate for the unquoted-scalar
 * colon-space defect), emits both checks' scanned scope, and FAILS CLOSED on zero
 * scope per ADR 0092:
 *
 *   exit 0 — clean (no GraphQL-path gh calls, all frontmatter parses as strict YAML)
 *   exit 2 — one or more findings (a gh-call finding OR an invalid-frontmatter finding)
 *   exit 3 — zero scope in EITHER check (ADR 0092: zero scope is a FAIL, never a silent PASS)
 *
 * The `lint-skills` surface + its exit-code/stdout contract is preserved byte-for-byte
 * from the former package's `bin.ts`. The exit-3/exit-2 mapping, formerly done at the
 * bin's run boundary via `catchTag`, is caught inside this handler so the contract
 * survives the fold into the shared `pipeline-cli` bin (which provides only
 * `NodeServices.layer`, no per-tool catch — mirrors `decisions-index`).
 *
 * The package's OTHER role — the `gh` REST shim (`runShim`/`router.ts`/`resolve.ts`),
 * which shadows `gh` on the subagent PATH and routes argv through `route` — is NOT a
 * pipeline-cli subcommand: it intercepts arbitrary `gh` verbs in a pre-runtime argv
 * dispatch (`process.argv[2]`), before any subcommand router runs. The `shim/gh`
 * wrapper on `.claude/settings.json` `env.PATH` still execs the OLD package's
 * `bin.ts`, so the shim keeps working until Phase 4 (#1003) rewires that PATH. The pure
 * shim cores (`router.ts`/`resolve.ts`) are moved here alongside `lint.ts` so the
 * package's logic lives in the registry, but only `lint-skills` is exposed as a verb.
 */
import {readFileSync} from "node:fs";
import {Console, Data, Effect} from "effect";
import {Argument, Command} from "effect/unstable/cli";
import {isZeroScope, type LintResult, lintCorpus, type ScanFile} from "./lint.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

class FindingsFound extends Data.TaggedError("FindingsFound")<{readonly count: number}> {}
class ZeroScope extends Data.TaggedError("ZeroScope")<{}> {}

const readFileOrSkip = (file: string): string | null => {
	try {
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
};

const fileArg = Argument.string("file").pipe(
	Argument.atLeast(1),
	Argument.withDescription(
		"one or more skill-corpus file paths to lint for GraphQL-path gh calls and invalid YAML frontmatter",
	),
);

/** The lint verdict: zero scope → ZeroScope, findings → FindingsFound, else clean (the print). */
const judge = (result: LintResult): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		// ADR 0092: zero scope is a FAIL, never a silent PASS.
		if (isZeroScope(result)) {
			yield* Console.error(
				"gh-phoenix lint-skills: FAIL — scanned zero files (zero-scope fail-closed, ADR 0092).",
			);
			return yield* Effect.fail(new ZeroScope());
		}

		const total = result.findings.length + result.frontmatterFindings.length;
		if (total === 0) {
			yield* Console.log(
				"gh-phoenix lint-skills: clean — no GraphQL-path gh calls and all frontmatter parses as strict YAML.",
			);
			return;
		}

		if (result.findings.length > 0) {
			yield* Console.error(
				`gh-phoenix lint-skills: FAIL — ${result.findings.length} GraphQL-path gh call(s) in the skill corpus (REST-only on this org, #743):`,
			);
			for (const f of result.findings) {
				yield* Console.error(`  ${f.file}:${f.line}: ${f.matched} — ${f.reason}`);
			}
		}

		if (result.frontmatterFindings.length > 0) {
			yield* Console.error(
				`gh-phoenix lint-skills: FAIL — ${result.frontmatterFindings.length} file(s) with invalid YAML frontmatter (a mid-sentence colon-space in an unquoted scalar reparses as a mapping; quote the value or use a block scalar — #1766):`,
			);
			for (const f of result.frontmatterFindings) {
				yield* Console.error(`  ${f.file}: ${f.reason}`);
			}
		}

		return yield* Effect.fail(new FindingsFound({count: total}));
	});

// The gate-fail signal → exit-code mapping, formerly done at the bin's run boundary via
// `catchTag`. Caught inside the handler (not at the shared bin, which has no per-tool
// catch) so the exit-3/exit-2 contract survives the fold — mirrors decisions-index.
const onZeroScope = (_e: ZeroScope) => Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE));
const onFindingsFound = (_e: FindingsFound) => Effect.sync(() => process.exit(FINDING_EXIT_CODE));

const lintSkills = Command.make(
	"lint-skills",
	{files: fileArg},
	Effect.fn(function* ({files}) {
		const scanInput: ScanFile[] = [];
		for (const file of files) {
			const content = readFileOrSkip(file);
			if (content !== null) scanInput.push({file, content});
		}

		const result = lintCorpus(scanInput);

		// ADR 0092: emit what each check scanned (scope is observable), THEN judge.
		yield* Console.log(
			`gh-phoenix lint-skills: gh-call scan scanned ${result.scanned.length} file(s)` +
				(result.scanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.scanned) yield* Console.log(`  scanned: ${f}`);
		yield* Console.log(
			`gh-phoenix lint-skills: frontmatter check scanned ${result.frontmatterScanned.length} file(s)` +
				(result.frontmatterScanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.frontmatterScanned) yield* Console.log(`  frontmatter-scanned: ${f}`);

		yield* judge(result).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Lint the skill corpus for GraphQL-path gh invocations and invalid YAML frontmatter (fails closed on zero scope)",
	),
);

export const ghPhoenixCommand = Command.make("gh-phoenix").pipe(
	Command.withSubcommands([lintSkills]),
	Command.withDescription("gh REST shim + skill grep-lint vs Projects-classic GraphQL (#743)"),
);
