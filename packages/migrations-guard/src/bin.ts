#!/usr/bin/env node
/**
 * `migrations-guard` CLI (issue #1435, ADR 0108). Two commands over the flat D1 migrations tree:
 *
 *   check     — the fail-closed CI gate. Loads the tree + committed baseline, evaluates
 *               consistency / ordering / immutability, prints the verdict, and EXITS NON-ZERO
 *               on any violation so a CI step fails loudly (mirrors leak-guard/readme-guard).
 *   baseline  — regenerate the committed immutability baseline (tag → current SQL sha256) after
 *               a DELIBERATE, audited re-baseline (e.g. the #1306 flat→per-dir cutover). Writing
 *               the baseline is a human-reviewed control-plane act, not something CI does.
 *
 * The pure core (`migrations-guard.ts`) decides; this bin is the thin `effect/unstable/cli`
 * shell over the `fs.ts` disk boundary (same idiom as `@kampus/flake-rate`).
 */
import {writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {loadBaseline, loadMigrationTree, serializeBaseline} from "./fs.ts";
import {deriveBaseline, evaluate, renderVerdict} from "./migrations-guard.ts";

// The committed migrations tree + the guard's own baseline file, resolved relative to this
// package's src/ so `check` runs the same from any CWD (a CI step, a local invocation).
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
	new URL("../../../apps/web/worker/db/drizzle/migrations", import.meta.url),
);
const DEFAULT_BASELINE = fileURLToPath(new URL("../migration-hashes.json", import.meta.url));

// Non-zero on a violation; any OTHER non-zero means the guard could not run.
const VIOLATION_EXIT_CODE = 1;

const migrationsFlag = Flag.string("migrations").pipe(
	Flag.withDefault(DEFAULT_MIGRATIONS_DIR),
	Flag.withDescription("path to the flat migrations directory (default apps/web/…/migrations)"),
);

const baselineFlag = Flag.string("baseline").pipe(
	Flag.withDefault(DEFAULT_BASELINE),
	Flag.withDescription("path to the committed immutability baseline (migration-hashes.json)"),
);

class GuardViolation extends Error {
	readonly _tag = "GuardViolation";
}

const check = Command.make(
	"check",
	{migrations: migrationsFlag, baseline: baselineFlag},
	Effect.fn(function* ({migrations, baseline}) {
		const tree = loadMigrationTree(migrations);
		const verdict = evaluate(tree, loadBaseline(baseline));
		yield* Console.log(renderVerdict(verdict));
		if (!verdict.ok) return yield* Effect.fail(new GuardViolation());
	}),
).pipe(
	Command.withDescription(
		"Fail-closed gate: assert the flat D1 migrations tree is consistent, ordered, and immutable vs the committed baseline",
	),
);

const baselineCmd = Command.make(
	"baseline",
	{migrations: migrationsFlag, baseline: baselineFlag},
	Effect.fn(function* ({migrations, baseline}) {
		const tree = loadMigrationTree(migrations);
		writeFileSync(baseline, serializeBaseline(deriveBaseline(tree)));
		yield* Console.log(
			`migrations-guard: wrote baseline for ${tree.sqlTags.length} migration(s) → ${baseline}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Regenerate the committed immutability baseline (tag → current SQL sha256) after a deliberate re-baseline",
	),
);

const migrationsGuard = Command.make("migrations-guard").pipe(
	Command.withSubcommands([check, baselineCmd]),
	Command.withDescription(
		"Fail-closed guard over the hand-authored flat D1 migrations tree (issue #1435)",
	),
);

migrationsGuard.pipe(
	Command.run({version: "0.0.0"}),
	Effect.catchTag("GuardViolation", () => Effect.sync(() => process.exit(VIOLATION_EXIT_CODE))),
	Effect.provide(NodeServices.layer),
	NodeRuntime.runMain,
);
