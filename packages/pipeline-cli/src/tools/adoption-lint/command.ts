/**
 * The `adoption-lint` tool — `pipeline-cli adoption-lint check <file>…`.
 *
 * The #3254 adoption corpus-lint: flags a crew-corpus file that inline-re-derives a
 * tool-owned decision instead of citing the owning `pipeline-cli` verb, the governing
 * AC of epic #3258 (it lands first so the verb sweep can't grow the unreferenced-tool
 * pile). Follows the `gh-phoenix lint-skills` shape — an IO-free core (`lintAdoption`)
 * over a declared manifest, with a thin CLI that reads the handed corpus files and
 * maps the verdict to a fail-closed exit contract (ADR 0092):
 *
 *   exit 0 — clean (no un-cited re-derivations, every declared exemption valid)
 *   exit 2 — one or more findings (a re-derivation OR a stale/unjustified exemption)
 *   exit 3 — zero scope (no corpus file scanned OR no decision declared)
 *
 * The exit mapping is caught inside this handler (not at the shared bin's run
 * boundary, which provides only `NodeServices.layer` and no per-tool catch), so the
 * contract survives the fold into `pipeline-cli` — mirrors `gh-phoenix` / `decisions-index`.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command} from "effect/unstable/cli";
import {type AdoptionResult, isZeroScope, lintAdoption, type ScanFile} from "./adoption-lint.ts";
import {DECISIONS, EXEMPTIONS} from "./manifest.ts";

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
		"one or more crew-corpus file paths (SKILL.md / agent defs / orchestrator surfaces) to lint for inline re-derivations of tool-owned decisions",
	),
);

/** The lint verdict: zero scope → ZeroScope, any finding → FindingsFound, else clean. */
const judge = (result: AdoptionResult): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		// ADR 0092: zero scope is a FAIL, never a silent PASS.
		if (isZeroScope(result)) {
			yield* Console.error(
				`adoption-lint: FAIL — scanned ${result.scanned.length} file(s) against ${result.decisionCount} declared decision(s); a zero scope on either axis is fail-closed (ADR 0092).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}

		const total = result.findings.length + result.exemptionFindings.length;
		if (total === 0) {
			yield* Console.log(
				"adoption-lint: clean — no un-cited re-derivations of a tool-owned decision, and every declared exemption is valid.",
			);
			return;
		}

		if (result.findings.length > 0) {
			yield* Console.error(
				`adoption-lint: FAIL — ${result.findings.length} inline re-derivation(s) of a tool-owned decision that never cite the owning verb (#3254):`,
			);
			for (const f of result.findings) {
				yield* Console.error(`  ${f.file}: ${f.reason}`);
			}
		}

		if (result.exemptionFindings.length > 0) {
			yield* Console.error(
				`adoption-lint: FAIL — ${result.exemptionFindings.length} declared exemption(s) failed their own lint (stale or unjustified — #3254 forbids a blanket skip):`,
			);
			for (const f of result.exemptionFindings) {
				yield* Console.error(`  [${f.kind}] ${f.path}: ${f.reason}`);
			}
		}

		return yield* Effect.fail(new FindingsFound({count: total}));
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

		const result = lintAdoption(scanInput, DECISIONS, EXEMPTIONS);

		// ADR 0092: emit what was scanned (scope is observable), THEN judge.
		yield* Console.log(
			`adoption-lint: scanned ${result.scanned.length} corpus file(s) against ${result.decisionCount} declared decision(s)` +
				(result.scanned.length > 0 ? `:` : ` (zero scope)`),
		);
		for (const f of result.scanned) yield* Console.log(`  scanned: ${f}`);
		for (const f of result.exempted) yield* Console.log(`  exempted (declared + linted): ${f}`);

		yield* judge(result).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Flag corpus files that inline-re-derive a tool-owned decision without citing the owning verb (fails closed on zero scope)",
	),
);

export const adoptionLintCommand = Command.make("adoption-lint").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Adoption corpus-lint: every extraction's decision must be cited, not re-derived (#3254 / epic #3258)",
	),
);
