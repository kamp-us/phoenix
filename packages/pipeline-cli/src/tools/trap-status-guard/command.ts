/**
 * The `trap-status-guard` tool — `pipeline-cli trap-status-guard check <file>…`.
 *
 * Reds on `errexit` enabled together with an `EXIT` trap inside one runnable shell unit — the
 * bash 3.2 shape that turns a `set -u` abort into exit 0 (#4479). The *why* lives once in the
 * core's docblock and in `.patterns/skill-script-shell-shape.md`; this is the thin CLI mapping
 * the verdict onto a fail-closed exit contract (ADR 0092):
 *
 *   exit 0 — clean (no unit pairs errexit with an EXIT trap)
 *   exit 2 — one or more banned co-occurrences
 *   exit 3 — zero scope on any axis: no file scanned, no runnable `.md` fence, or no `.sh` file
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command} from "effect/unstable/cli";
import {type GuardResult, isZeroScope, type ScanFile, scanCorpus} from "./trap-status-guard.ts";

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
		"one or more corpus file paths (`*.sh` scripts, SKILL.md / plugin docs carrying runnable fences) to scan for an errexit + EXIT-trap pairing",
	),
);

const judge = (result: GuardResult): Effect.Effect<void, ZeroScope | FindingsFound> =>
	Effect.gen(function* () {
		if (isZeroScope(result)) {
			yield* Console.error(
				`trap-status-guard: FAIL — scanned ${result.scanned.length} file(s): ${result.fenceCount} runnable fence(s) in markdown, ${result.shellFileCount} shell file(s); a zero scope on ANY axis is fail-closed, per surface (ADR 0092).`,
			);
			return yield* Effect.fail(new ZeroScope());
		}

		if (result.findings.length === 0) {
			yield* Console.log(
				"trap-status-guard: clean — no runnable shell unit pairs `errexit` with an `EXIT` trap.",
			);
			return;
		}

		yield* Console.error(
			`trap-status-guard: FAIL — ${result.findings.length} runnable shell unit(s) enable \`errexit\` alongside an \`EXIT\` trap. On bash 3.2 a \`set -u\` abort then reaches the trap with \`$?\` already 0, so a cleanup trap ending in a succeeding command exits **0** — the guard reports success on a path it never evaluated (#4479):`,
		);
		for (const f of result.findings) {
			yield* Console.error(`  ${f.file}:${f.errexitLine}: ${f.errexitText}`);
			yield* Console.error(`  ${f.file}:${f.trapLine}: ${f.trapText}`);
		}
		yield* Console.error(
			"  FIX: drop `e` from the options — `set -uo pipefail` is the house shape, and its abort status survives the same cleanup trap (measured: exit 1). A status-preserving trap does NOT rescue this under `-e`; `$?` is already 0 when the trap runs. See .patterns/skill-script-shell-shape.md.",
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
			`trap-status-guard: scanned ${result.scanned.length} file(s), ${result.fenceCount} runnable bash/sh fence(s) in markdown, ${result.shellFileCount} shell file(s) as implicit units`,
		);

		yield* judge(result).pipe(
			Effect.catchTag("ZeroScope", onZeroScope),
			Effect.catchTag("FindingsFound", onFindingsFound),
		);
	}),
).pipe(
	Command.withDescription(
		"Red on any runnable shell unit that enables `errexit` alongside an `EXIT` trap — the bash 3.2 shape that swallows a `set -u` abort into exit 0 (fails closed on zero scope, per surface)",
	),
);

export const trapStatusGuardCommand = Command.make("trap-status-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"Keep a cleanup `EXIT` trap from laundering a failing shell guard into exit 0 (#4479)",
	),
);
