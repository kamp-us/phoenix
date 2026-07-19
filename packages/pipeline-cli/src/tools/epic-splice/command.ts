/**
 * The `epic-splice` tool — `pipeline-cli epic-splice apply --body-file <f> --deps-file <f>
 * [--plan-file <f>]`.
 *
 * The deterministic epic-body splice `plan-epic` Step 5 used to hand-compose inline (#261 / #3689):
 * given the live epic body and a freshly-derived `## Dependencies` block (plus, on a re-plan, a
 * `## Plan (plan-epic)` block via `--plan-file`), it prints the spliced body to stdout — a
 * first-time APPEND or a re-plan in-place REPLACE — with the anchor-count guards. `--plan-file`
 * present ⇒ re-plan mode; absent ⇒ first-time (or a deps-only re-splice).
 *
 * Exit 0 = a clean splice printed to stdout (raw bytes, no trailing newline added, so the caller's
 * PATCH round-trips byte-for-byte). Exit 1 = a corrupt-heading refusal (the reason on stderr) — the
 * caller must inspect by hand rather than blind-write. Pure text transform: no `gh` boundary, so it
 * needs no `Github` layer — the optimistic `updated_at` recheck + PATCH orchestration stay in the
 * skill prose (#3689 scope).
 */
import {readFileSync} from "node:fs";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {spliceEpicBody} from "./epic-splice.ts";

const CORRUPT_EXIT_CODE = 1;

const bodyFileFlag = Flag.string("body-file").pipe(
	Flag.withDescription("path to the live epic body the splice preserves around"),
);
const depsFileFlag = Flag.string("deps-file").pipe(
	Flag.withDescription(
		"path to the freshly-derived `## Dependencies` block to append or splice in place",
	),
);
const planFileFlag = Flag.string("plan-file").pipe(
	Flag.optional,
	Flag.withDescription(
		"path to the freshly-derived `## Plan (plan-epic)` block — its presence marks a re-plan (both sections re-spliced)",
	),
);

const apply = Command.make(
	"apply",
	{bodyFile: bodyFileFlag, depsFile: depsFileFlag, planFile: planFileFlag},
	Effect.fn(function* ({bodyFile, depsFile, planFile}) {
		const body = yield* Effect.sync(() => readFileSync(bodyFile, "utf8"));
		const deps = yield* Effect.sync(() => readFileSync(depsFile, "utf8"));
		const plan = yield* Effect.sync(() =>
			Option.match(planFile, {
				onNone: () => null,
				onSome: (path) => readFileSync(path, "utf8"),
			}),
		);

		const outcome = spliceEpicBody({body, deps, plan});
		if (outcome._tag === "Corrupt") {
			process.stderr.write(`epic-splice: ${outcome.reason}\n`);
			return yield* Effect.sync(() => process.exit(CORRUPT_EXIT_CODE));
		}
		// Raw bytes, no trailing newline added — the caller PATCHes this verbatim (byte-preservation).
		yield* Effect.sync(() => process.stdout.write(outcome.body));
		process.stderr.write(
			`epic-splice: ${outcome.mode === "append" ? "appended" : "spliced"} the section(s)\n`,
		);
	}),
).pipe(
	Command.withDescription(
		"Splice/append the `## Dependencies` (and, with --plan-file, `## Plan (plan-epic)`) block into the live epic body — exit 0 = printed, exit 1 = corrupt heading",
	),
);

export const epicSpliceCommand = Command.make("epic-splice").pipe(
	Command.withSubcommands([apply]),
	Command.withDescription(
		"Deterministic epic-body splice for plan-epic — first-time append vs re-plan in-place, with heading-count guards (#3689)",
	),
);
