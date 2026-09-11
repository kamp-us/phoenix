/**
 * The proof gate the two appending verbs run before their append.
 *
 * `lane report` and `lane transition` are the only two paths onto a lane's log, and an event that
 * claims an artifact must clear the same bar on both — the driver's own records used to reach the
 * ledger with the gate advisory prose, so a chained `lane prove …; lane transition …` appended
 * whatever the proof said. The read itself is `lane prove`'s and so are its codes and remedies; this
 * seats the call and the refusal once so the two paths cannot answer differently about one event.
 *
 * The prover is a parameter rather than an import so both verbs' unit tiers stay offline; the CLI
 * hands each of them `runProve`, the only prover either verb ever invokes.
 */
import {Effect} from "effect";
import {ANSWER, refuse, type VerbOutcome} from "../verb.ts";
import type {ProofOutcome, ProveOptions} from "./prove-verb.ts";

const PROVE_VERB = "fabrika lane prove";

export type Proven =
	| {readonly _tag: "Proven"; readonly proof: ProofOutcome}
	| {readonly _tag: "Refused"; readonly outcome: VerbOutcome};

/**
 * Run the proof and seat its verdict.
 *
 * `claim` names what the caller is about to record, in the calling verb's own words — the shell's
 * path names the token behind the event, the driver's names the event alone.
 */
export const gateOnProof = <R>(
	verb: string,
	prove: (options: ProveOptions) => Effect.Effect<ProofOutcome, never, R>,
	options: ProveOptions,
	claim: string,
): Effect.Effect<Proven, never, R> =>
	Effect.map(prove(options), (proof) =>
		proof.code === ANSWER
			? ({_tag: "Proven", proof} as const)
			: ({
					_tag: "Refused",
					outcome: refuse(
						proof.code,
						`${verb}: refused (log unappended): ${claim} is not proven — the reasons above are ${PROVE_VERB}'s and so are their remedies.`,
						proof.stderr,
					),
				} as const),
	);
