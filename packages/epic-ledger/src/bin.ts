/**
 * `epic-ledger` CLI — the operable surface for the `review-plan` gate (ADR 0047).
 *
 * The `review-plan` skill names `runGate(<EPIC>)` as its action; this executable
 * is what backs it. `epic-ledger gate <epic>` runs the deterministic gate for
 * real (validate → flip `status:planned → triaged` on a clean ledger, or post a
 * per-defect FAIL and flip nothing); `--dry-run` validates and prints the verdict
 * without touching a label or posting a comment — the read-only path for seeing
 * what the floor makes of an epic before the gate is allowed to mutate anything.
 *
 * Wired per effect-smol's CLI guidance: `effect/unstable/cli` for the typed arg +
 * flag, the live `Github` capability provided over `NodeServices.layer` (which
 * supplies the `ChildProcessSpawner` that shells `gh`), run as a process via
 * `NodeRuntime.runMain`. The handler only requires `Github`; the two layers at the
 * run boundary satisfy it (`GithubLive` needs `ChildProcessSpawner`, `NodeServices`
 * provides it).
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect, Layer} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import type {Defect} from "./Defect.ts";
import {runGate} from "./gate.ts";
import {Github, GithubLive} from "./github.ts";
import {validateLedger} from "./validate.ts";

const PLANNED_LABEL = "status:planned";

const refList = (refs: ReadonlyArray<number>): string => refs.map((n) => `#${n}`).join(", ");

const printDefects = (defects: ReadonlyArray<Defect>) =>
	Effect.forEach(defects, (d) => Console.log(`  - ${d.type} (${refList(d.refs)}) — ${d.message}`), {
		discard: true,
	});

const epicArg = Argument.integer("epic").pipe(
	Argument.withDescription("the epic issue number whose ledger to gate"),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription(
		"validate and print the verdict only — never flip a label or post a comment",
	),
);

const gate = Command.make(
	"epic-ledger",
	{epic: epicArg, dryRun: dryRunFlag},
	Effect.fn(function* ({epic, dryRun}) {
		if (dryRun) {
			const ledger = yield* (yield* Github).epicLedger(epic);
			const defects = validateLedger(ledger);
			const planned = ledger.children
				.filter((c) => c.labels.includes(PLANNED_LABEL))
				.map((c) => c.number);

			if (defects.length === 0) {
				yield* Console.log(`✓ epic #${epic} — PASS (0 hard defects) [dry-run]`);
				yield* Console.log(
					planned.length === 0
						? "  no status:planned child to flip (children already triaged)"
						: `  would flip ${planned.length}: ${refList(planned)}`,
				);
				return;
			}

			yield* Console.log(`✗ epic #${epic} — FAIL (${defects.length} hard defect(s)) [dry-run]`);
			yield* printDefects(defects);
			return;
		}

		const verdict = yield* runGate(epic);
		if (verdict._tag === "pass") {
			yield* Console.log(
				`✓ epic #${epic} — PASS, flipped ${verdict.flipped.length} child(ren) status:planned → status:triaged`,
			);
			if (verdict.flipped.length > 0) yield* Console.log(`  ${refList(verdict.flipped)}`);
			return;
		}
		yield* Console.log(
			`✗ epic #${epic} — FAIL (${verdict.defects.length} hard defect(s)); nothing flipped`,
		);
		yield* printDefects(verdict.defects);
		yield* Console.log(`  signature: ${verdict.signature}`);
	}),
).pipe(Command.withDescription("Run the review-plan structural gate over an epic's ledger"));

// `GithubLive` requires `ChildProcessSpawner`, which `NodeServices.layer`
// provides; `provideMerge` satisfies that and keeps the Node services the CLI
// runtime itself needs (argv, stdout) — one combined layer, one `Effect.provide`.
const AppLayer = GithubLive.pipe(Layer.provideMerge(NodeServices.layer));

gate.pipe(Command.run({version: "0.0.0"}), Effect.provide(AppLayer), NodeRuntime.runMain);
