/**
 * `publish-guard` CLI — the CI-callable surface for epic #803, child #807.
 *
 * Two subcommands, both offline/deterministic (config only, no network):
 *  - `list`  — print the derived required-published set (`requiredPackages`).
 *  - `check` — run `checkDrift`, print a per-package table, exit non-zero on any
 *              drift (a required package that is private or lacks
 *              `publishConfig.access: "public"`), exit 0 when clean.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * `effect/unstable/cli` for the subcommands, the Node platform over
 * `NodeServices.layer`, run via `NodeRuntime.runMain` (a failed effect → a
 * non-zero process exit). It is run from source (`node src/bin.ts`), the
 * guard-family idiom; `publish-guard` is not itself published (#803 Resolved q).
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Data, Effect} from "effect";
import {Command} from "effect/unstable/cli";
import {checkDrift, type DriftStatus, loadManifests} from "./drift.ts";
import {PACKAGES_DIR, SKILLS_DIR} from "./paths.ts";
import {requiredPackages} from "./required.ts";

const DRIFT_EXIT_CODE = 1;

// Carries the non-zero process exit; the table is already printed to stdout.
class DriftFound extends Data.TaggedError("DriftFound")<{readonly count: number}> {}

const STATUS_NOTE: Record<DriftStatus, string> = {
	ok: "publishable (publishConfig.access: public, not private)",
	"private-but-required": "required by the plugin but private: true",
	"missing-publishConfig": 'missing publishConfig.access: "public"',
	"not-found": "no package.json found under packages/",
};

const list = Command.make(
	"list",
	{},
	Effect.fn(function* () {
		const required = requiredPackages(SKILLS_DIR);
		if (required.length === 0) {
			yield* Console.log("publish-guard: no @kampus/* packages referenced under the skills tree");
			return;
		}
		for (const name of required) yield* Console.log(`@kampus/${name}`);
	}),
).pipe(Command.withDescription("Print the derived required-published @kampus/* set"));

const check = Command.make(
	"check",
	{},
	Effect.fn(function* () {
		const required = requiredPackages(SKILLS_DIR);
		const report = checkDrift(required, loadManifests(PACKAGES_DIR, required));

		yield* Console.log("publish-guard check — required @kampus/* packages:");
		for (const {name, status} of report.verdicts) {
			const mark = status === "ok" ? "ok  " : "DRIFT";
			yield* Console.log(`  [${mark}] @kampus/${name} — ${STATUS_NOTE[status]}`);
		}

		if (!report.hasDrift) {
			yield* Console.log(
				`publish-guard: clean — all ${report.verdicts.length} required package(s) are publishable`,
			);
			return;
		}

		const drifted = report.verdicts.filter((v) => v.status !== "ok");
		yield* Console.error(
			`publish-guard: blocked — ${drifted.length} required package(s) are not publishable (epic #803).`,
		);
		yield* Console.error(
			'Fix each: set `"publishConfig": {"access": "public"}` and remove `"private": true` in its package.json.',
		);
		return yield* Effect.fail(new DriftFound({count: drifted.length}));
	}),
).pipe(
	Command.withDescription("Check that every required @kampus/* package is publishable (offline)"),
);

const guard = Command.make("publish-guard").pipe(
	Command.withSubcommands([list, check]),
	Command.withDescription(
		"Derive the plugin's required-published @kampus/* set and check it for publish drift",
	),
);

guard.pipe(
	Command.run({version: "0.0.0"}),
	// DriftFound is the expected CI-fail signal, its table already printed — turn it
	// into a bare non-zero exit so NodeRuntime doesn't also dump a stack trace, while
	// genuine crashes still get the default error report.
	Effect.catchTag("DriftFound", () => Effect.sync(() => process.exit(DRIFT_EXIT_CODE))),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
