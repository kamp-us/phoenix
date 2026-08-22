/**
 * `ledger topology` — validate the declared edges against the recorded children and render the block.
 *
 * A total function from edges to a verdict: cycles, dangling refs and orphans are all decidable, and
 * the verb decides them. **What it cannot see is a shared-file conflict** — whether two children in one
 * phase write the same module is a judgment the skill carries (#3709), and the verb does not pretend
 * otherwise.
 *
 * Zero scope reds on `7` rather than `24`, because nothing was validated: an empty manifest means the
 * epic has no children at all, and rendering a topology over none would produce a block the gate reads
 * as an epic every one of whose children is orphaned. A refused scope is not an invalid topology
 * (ADR 0092).
 */

import {Effect, type FileSystem, type Path} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readAuthored} from "../build/authored.ts";
import {scannedLine} from "../build/target.ts";
import {capAndCount} from "../evidence.ts";
import type {StdinRead} from "../io/stdin.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {
	BAD_SECTIONS,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	TOPOLOGY_INVALID,
	ZERO_SCOPE,
} from "./codes.ts";
import {type LedgerMessages, type OpenOptions, openGround} from "./preconditions.ts";
import {topologyPath} from "./run.ts";
import {loadManifest, loadRun, stage} from "./run-io.ts";
import {checkTopology, type DeclaredLine, parseLine} from "./topology-doc.ts";

const VERB = "ledger topology";

/** Enough pairs to recognise the parse, not enough to reprint the caller's own stdin (ADR 0308). */
const EDGE_CAP = 5;

export const MESSAGES: LedgerMessages = {
	verb: VERB,
	notAnEpic: (epic) =>
		`${VERB}: #${epic} is not a type:epic — refusing to declare a topology for it.`,
	unreadable: (what, reason) => `${VERB}: cannot read ${what}: ${reason} — nothing was staged.`,
};

export interface TopologyOptions extends OpenOptions {
	readonly stdin: Effect.Effect<StdinRead>;
}

export const runTopology = (
	options: TopologyOptions,
): Effect.Effect<
	VerbOutcome,
	never,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const authored = readAuthored(
			{
				verb: VERB,
				emptyMessage: `${VERB}: stdin held nothing — there is no topology to declare.`,
				bareAtMessage: `${VERB}: the declared topology is a bare @ path reference — it cannot be redacted.`,
			},
			yield* options.stdin,
		);
		if (authored._tag === "Refused") return authored.outcome;

		const ground = yield* openGround(MESSAGES, options);
		if (ground._tag === "Refused") return ground.outcome;
		const {epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const manifest = yield* loadManifest(MESSAGES, dir, notes);
		if (manifest._tag === "Refused") return manifest.outcome;
		if (manifest.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the run manifest holds zero children — refusing to render a topology over zero scope (ADR 0092).`,
				notes,
			);
		}

		const lines: DeclaredLine[] = [];
		for (const [index, text] of authored.text.split("\n").entries()) {
			if (text.trim() === "") continue;
			const parsed = parseLine(text, index + 1);
			if (parsed._tag === "Unparseable") {
				return refuse(
					BAD_SECTIONS,
					`${VERB}: line ${parsed.index} does not parse: "${parsed.text}" — want "#<ref> phase <n> [requires #<a>]".`,
					notes,
				);
			}
			if (parsed._tag === "OffVocabulary") {
				return refuse(
					OFF_VOCABULARY,
					`${VERB}: phase "${parsed.phase}" is not a positive integer.`,
					notes,
				);
			}
			lines.push(parsed.line);
		}

		const checked = checkTopology(
			epic.number,
			lines,
			manifest.value.map((record) => record.number),
		);
		if (checked._tag === "Invalid") {
			return refuse(TOPOLOGY_INVALID, `${VERB}: ${checked.reason}`, notes);
		}

		const failed = yield* stage(topologyPath(dir), checked.block);
		if (failed !== null) {
			return refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(topologyPath(dir), failed), notes);
		}

		return answer(
			JSON.stringify({
				answer: "staged",
				epic: epic.number,
				document: "topology",
				phases: checked.phases,
				children: lines.length,
				edges: capAndCount(checked.edges, EDGE_CAP),
				bytes: new TextEncoder().encode(checked.block).length,
			}),
			[...notes, scannedLine(VERB, manifest.value.length, "recorded child")],
		);
	});
