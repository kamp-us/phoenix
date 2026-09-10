/**
 * `ledger topology` — validate the declared edges against the recorded children and render the block.
 *
 * A total function from edges to a verdict: cycles, dangling refs and orphans are all decidable, and
 * the verb decides them. **What it cannot see is a shared-file conflict** — whether two children in one
 * phase write the same module is a judgment the skill carries, and the verb does not pretend otherwise.
 *
 * Zero scope reds on `7` rather than `24`, because nothing was validated: an empty manifest means the
 * epic has no children at all, and rendering a topology over none would produce a block the gate reads
 * as an epic every one of whose children is orphaned. A refused scope is not an invalid topology.
 *
 * **The external half of the check is this verb's, because it is the boundary.** `checkTopology` is
 * pure and hands back every prerequisite outside the run manifest — bar the epic's own number, which
 * it refuses itself, since that target *does* exist and so would probe Present here; proving the rest
 * name real issues is a read, and it happens here — before anything is staged, so a topology naming a target that is proven
 * absent, unreadable, or a pull request leaves the run directory untouched. A pull request refuses
 * because the decision corpus names a blocking pull request by the issue its merge closes, and the
 * issues endpoint serves PRs too — so the 404 arm never fires for one and only this check catches it.
 */

import {Effect, type FileSystem, type Path} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {readAuthored} from "../build/authored.ts";
import {scannedLine} from "../build/target.ts";
import {capAndCount} from "../evidence.ts";
import {edgeTarget} from "../io/edges.ts";
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

/** Enough pairs to recognise the parse, not enough to reprint the caller's own stdin. */
const EDGE_CAP = 5;

/** Bounded like every other fan in this package. */
const FAN_OUT = 8;

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
	| ChildProcessSpawner.ChildProcessSpawner
	| FileSystem.FileSystem
	| HttpClient.HttpClient
	| Path.Path
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
		const {repo, epic, dir, notes} = ground;

		const run = yield* loadRun(MESSAGES, dir, notes);
		if (run._tag === "Refused") return run.outcome;

		const manifest = yield* loadManifest(MESSAGES, dir, notes);
		if (manifest._tag === "Refused") return manifest.outcome;
		if (manifest.value.length === 0) {
			return refuse(
				ZERO_SCOPE,
				`${VERB}: the run manifest holds zero children — refusing to render a topology over zero scope.`,
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

		const probed = yield* Effect.forEach(
			checked.external,
			(number) => edgeTarget(repo, number).pipe(Effect.map((found) => [number, found] as const)),
			{concurrency: FAN_OUT},
		);
		for (const [number, found] of probed) {
			if (found._tag === "Absent") {
				return refuse(
					TOPOLOGY_INVALID,
					`${VERB}: #${number} is named as an external prerequisite and is proven absent — no edge can point at it.`,
					notes,
				);
			}
			if (found._tag === "Unknown") {
				return refuse(PRECONDITION_UNKNOWN, MESSAGES.unreadable(`#${number}`, found.reason), notes);
			}
			if (found.value.pullRequest) {
				return refuse(
					TOPOLOGY_INVALID,
					`${VERB}: #${number} is named as an external prerequisite and is a pull request — a blocking pull request is named by the issue its merge closes.`,
					notes,
				);
			}
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
				external: checked.external.length,
				bytes: new TextEncoder().encode(checked.block).length,
			}),
			[...notes, scannedLine(VERB, manifest.value.length, "recorded child")],
		);
	});
