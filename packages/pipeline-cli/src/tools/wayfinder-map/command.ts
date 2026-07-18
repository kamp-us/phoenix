/**
 * The `wayfinder-map` tool — `pipeline-cli wayfinder-map <map> [--json]`.
 *
 * The machine-readable substrate the `wayfinder` skill's fog-graduation (#S3) and
 * emission (#S5) modes read instead of prose-guessing a map's state (epic #2421):
 * parse a `wayfinder:map` issue body into its four sections, validate it against
 * the structural floor, and report graduation-readiness. Read-only — it never
 * mutates the map.
 *
 * Default output is a human verdict (PASS/FAIL + the graduation-ready flag);
 * `--json` emits the full parsed state + defects as one JSON object, the form the
 * skill modes and any CI hook consume. The handler requires `Github`, and
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union — per the registry seam, a tool
 * self-contains its services.
 */
import {Console, Effect} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import type {Defect} from "./Defect.ts";
import {Github, GithubLive} from "./github.ts";
import {answerableFrontier, isGraduationReady, mapSignature, validateMap} from "./validate.ts";

const refList = (refs: ReadonlyArray<number>): string => refs.map((n) => `#${n}`).join(", ");

const printDefects = (defects: ReadonlyArray<Defect>) =>
	Effect.forEach(defects, (d) => Console.log(`  - ${d.type} (${refList(d.refs)}) — ${d.message}`), {
		concurrency: 1,
		discard: true,
	});

const mapArg = Argument.integer("map").pipe(
	Argument.withDescription("the wayfinder:map issue number to parse and validate"),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full parsed map state + defects as one JSON object"),
);

export const wayfinderMapCommand = Command.make(
	"wayfinder-map",
	{map: mapArg, json: jsonFlag},
	Effect.fn(function* ({map, json}) {
		const ledger = yield* (yield* Github).mapLedger(map);
		const defects = validateMap(ledger);
		const ready = isGraduationReady(ledger.map);

		if (json) {
			yield* Console.log(
				JSON.stringify(
					{
						number: ledger.number,
						map: ledger.map,
						subIssues: ledger.subIssues,
						graduationReady: ready,
						answerableFrontier: answerableFrontier(ledger.map).map((t) => t.issue),
						valid: defects.length === 0,
						signature: mapSignature(ledger),
						defects,
					},
					null,
					2,
				),
			);
			return;
		}

		const readyLine = ready
			? "  graduation-ready: open frontier holds no answerable unknown"
			: `  not graduation-ready: ${answerableFrontier(ledger.map).length} answerable frontier ticket(s) remain`;

		if (defects.length === 0) {
			yield* Console.log(`✓ map #${map} — valid (0 defects)`);
			yield* Console.log(readyLine);
			return;
		}
		yield* Console.log(`✗ map #${map} — malformed (${defects.length} defect(s))`);
		yield* printDefects(defects);
		yield* Console.log(`  signature: ${mapSignature(ledger)}`);
		yield* Console.log(readyLine);
	}),
).pipe(
	Command.withDescription("Parse and validate a wayfinder:map issue's state (read-only)"),
	Command.provide(GithubLive),
);
