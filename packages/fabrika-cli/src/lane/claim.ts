/**
 * The driver's claim namespace, and what a lane key can race on.
 *
 * `operate` drives a lane; nothing above the issue level said who was driving it, so two drivers ran
 * epic #5492's children at once, each folding its own machine-local ledger, and `build claim` only
 * caught the collision one level down — after both had spawned a builder on the same repair (#5761).
 * A driver now claims the number it was handed, and nothing else.
 *
 * **The namespace is `lane-claim:`/`lane:`, not `build-claim:`/`build:`.** The build marker is
 * purpose-blind — `MARKER_RE` matches every `build-claim:` line whatever the claim was taken for — so
 * a driver claiming issue N under that grammar would be read as a foreign holder by the builder it
 * then spawns on N, locking itself out of its own lane. Two grammars are two races on one thread,
 * which is the one property the driver's claim must have.
 *
 * **The ledger is untouched.** Claims live on GitHub (#5680's phase-3 ruling on #5734); nothing here
 * writes `events.jsonl`, and no claim state is derivable from a fold.
 */

import {type ClaimGrammar, claimGrammar} from "../build/claim.ts";
import {CHORE_PREFIX, type LaneKey} from "./key.ts";

/** The driver's namespace. Separate from the builder's by construction — see the module note. */
export const LANE_CLAIM: ClaimGrammar = claimGrammar("lane-claim", "lane");

/** A board number is a number: a key that is not one names no thread to race on. */
const BOARD_NUMBER = /^[1-9][0-9]*$/;

/**
 * What a lane key races on.
 *
 * `Inert` is a fact, not a refusal: a chore lane is keyed by name precisely because it has no issue
 * number (#5840), so there is nowhere for a marker to be posted and nothing for a second driver to
 * read. The verbs answer it at exit 0 and say so, rather than inventing a substrate for it.
 */
export type ClaimTarget =
	| {readonly _tag: "Number"; readonly number: number}
	| {readonly _tag: "Inert"; readonly why: string};

export const claimTarget = (key: LaneKey): ClaimTarget =>
	key._tag === "Chore"
		? {
				_tag: "Inert",
				why: `a ${CHORE_PREFIX}<name> lane has no board number, so there is no thread to race a claim on`,
			}
		: BOARD_NUMBER.test(key.lane)
			? {_tag: "Number", number: Number.parseInt(key.lane, 10)}
			: {
					_tag: "Inert",
					why: `"${key.lane}" is not a board number, so there is no thread to race a claim on`,
				};
