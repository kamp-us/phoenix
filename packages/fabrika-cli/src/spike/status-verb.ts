/**
 * `spike status` — one run's spike state, workspace presence, and evidence count.
 *
 * **Deliberately near-total: it reports per-field state inside exit `0` rather than refusing**,
 * because its consumer is a session resuming cold, and a resuming session that gets a refusal learns
 * nothing about where it is. So an absent workspace is a **fact** here (`workspace: "absent"`, every
 * workspace-derived field `null`) while the same absence is a refusal (`12`) in the mutating verbs —
 * two consumers, two correct treatments, and the asymmetry is stated rather than left to be "fixed".
 *
 * **The bound on that near-totality is ADR 0092.** `4` and `11` still refuse: a workspace that cannot
 * be described is not "absent", and an unreadable state rendered as a plausible default is exactly the
 * failure that rule exists to prevent.
 *
 * An **absent `evidence.jsonl` under a present workspace** yields `runs: 0`, `lastCommandExit: null`
 * and `evidenceDigest: null`, also a fact: a log that was never written is not a log that hashes to
 * the empty string.
 */

import {Effect} from "effect";
import {getIssue, listComments} from "../io/issues.ts";
import {answer, refuse, type VerbOutcome} from "../verb.ts";
import {newestCapture} from "./bodies.ts";
import {READ_OR_EXEC_UNKNOWN} from "./codes.ts";
import {
	nonceGrammar,
	probe,
	readEvidence,
	readManifest,
	readTree,
	type SpikeEffect,
	targetRepo,
} from "./guards.ts";
import {workspacePath} from "./workspace.ts";

export interface StatusOptions {
	readonly nonce: string;
	readonly repo: string | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly tmpRoot: string;
}

const VERB = "spike status";

const ABSENT_FIELDS = {
	workspace: "absent",
	spike: null,
	kind: null,
	question: null,
	spikeState: null,
	captured: false,
	runs: null,
	lastCommandExit: null,
	evidenceDigest: null,
	treeMatched: null,
} as const;

export const runStatus = (options: StatusOptions): SpikeEffect<VerbOutcome> =>
	Effect.gen(function* () {
		const grammar = nonceGrammar(VERB, options.nonce, "");
		if (grammar !== null) return grammar;

		const workspace = workspacePath(options.tmpRoot, options.nonce);
		const present = yield* probe(VERB, "the workspace", workspace);
		if (present._tag === "Refused") return present.outcome;
		const scope = `${VERB}: nonce ${options.nonce}, workspace ${present.value ? "present" : "absent"}.`;
		if (!present.value) {
			return answer(JSON.stringify({nonce: options.nonce, ...ABSENT_FIELDS}), [scope]);
		}

		const manifest = yield* readManifest(
			VERB,
			workspace,
			options.nonce,
			"it was disposed between the probe and the read.",
		);
		if (manifest._tag === "Refused") return manifest.outcome;
		const evidence = yield* readEvidence(VERB, workspace);
		if (evidence._tag === "Refused") return evidence.outcome;
		const last = evidence.value.records[evidence.value.records.length - 1];

		const tree = yield* readTree(VERB, manifest.value.treeRoot);
		if (tree._tag === "Refused") return tree.outcome;

		const state = yield* spikeState(manifest.value.spike, options);
		if (state._tag === "Refused") return state.outcome;

		return answer(
			JSON.stringify({
				nonce: options.nonce,
				workspace: "present",
				spike: manifest.value.spike,
				kind: manifest.value.kind,
				question: manifest.value.question,
				spikeState: state.value.spikeState,
				captured: state.value.captured,
				runs: evidence.value.records.length,
				lastCommandExit: last?.commandExit ?? null,
				evidenceDigest: evidence.value.digest,
				treeMatched: tree.value.digest === manifest.value.treeDigest,
			}),
			[scope, ...state.value.notes],
		);
	});

interface SpikeState {
	readonly spikeState: string | null;
	readonly captured: boolean;
	readonly notes: ReadonlyArray<string>;
}

type Resolved =
	| {readonly _tag: "Ok"; readonly value: SpikeState}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * The issue half of the answer.
 *
 * A **provisional** manifest names no spike, so there is nothing to read and `spikeState` is `null`.
 * A spike that is **proven absent** is also reported as `null` rather than refused — this verb holds
 * no `7` seat and its consumer cannot act on a refusal — but the stderr note says which of the two it
 * was, so the proven case is never silently indistinguishable from "no spike named". A read that
 * *failed* is `11`, as everywhere else in this group.
 */
const spikeState = (spike: number | null, options: StatusOptions): SpikeEffect<Resolved> =>
	Effect.gen(function* () {
		if (spike === null) {
			return {
				_tag: "Ok" as const,
				value: {
					spikeState: null,
					captured: false,
					notes: [`${VERB}: the manifest is provisional and names no spike.`],
				},
			};
		}
		const target = yield* targetRepo(VERB, options.repo, options.env);
		if (target._tag === "Refused") return {_tag: "Refused" as const, outcome: target.outcome};
		const repo = target.value;

		const issue = yield* getIssue(repo, spike);
		if (issue._tag === "Unknown") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					READ_OR_EXEC_UNKNOWN,
					`${VERB}: cannot read spike #${spike}: ${issue.reason} — the state is UNKNOWN, never reported as a default.`,
				),
			};
		}
		if (issue._tag === "Absent") {
			return {
				_tag: "Ok" as const,
				value: {
					spikeState: null,
					captured: false,
					notes: [`${VERB}: spike #${spike} is proven absent on ${repo}.`],
				},
			};
		}
		const comments = yield* listComments(repo, spike);
		if (comments._tag === "Failure") {
			return {
				_tag: "Refused" as const,
				outcome: refuse(
					READ_OR_EXEC_UNKNOWN,
					`${VERB}: cannot read the comments of spike #${spike}: ${comments.reason} — the state is UNKNOWN, never reported as a default.`,
				),
			};
		}
		return {
			_tag: "Ok" as const,
			value: {
				spikeState: issue.value.state === "closed" ? "closed" : "open",
				captured: newestCapture(comments.value, options.nonce) !== null,
				notes: [`${VERB}: ${comments.value.length} comment(s) scanned on #${spike}.`],
			},
		};
	});
