/**
 * The driver's claim namespace, and what a lane key can race on.
 *
 * `operate` drives a lane; nothing above the issue level said who was driving it, so two drivers ran
 * one epic's children at once, each folding its own machine-local ledger, and `build claim` only
 * caught the collision one level down — after both had spawned a builder on the same repair.
 * A driver now claims the number it was handed, and nothing else.
 *
 * **The namespace is `lane-claim:`/`lane:`, not `build-claim:`/`build:`.** The build marker is
 * purpose-blind — `MARKER_RE` matches every `build-claim:` line whatever the claim was taken for — so
 * a driver claiming issue N under that grammar would be read as a foreign holder by the builder it
 * then spawns on N, locking itself out of its own lane. Two grammars are two races on one thread,
 * which is the one property the driver's claim must have.
 *
 * **The ledger is untouched.** Claims live on the board; nothing here
 * writes `events.jsonl`, and no claim state is derivable from a fold.
 */

import {type ClaimGrammar, claimGrammar} from "../build/claim.ts";
import {CHORE_PREFIX, type LaneKey, parseKey, resolveKeyIssue} from "./key.ts";

/** The driver's namespace. Separate from the builder's by construction — see the module note. */
export const LANE_CLAIM: ClaimGrammar = claimGrammar("lane-claim", "lane");

/**
 * What a lane key races on.
 *
 * `Inert` is a fact, not a refusal: a chore lane is keyed by name precisely because it has no issue
 * number, so there is nowhere for a marker to be posted and nothing for a second driver to
 * read. The verbs answer it at exit 0 and say so, rather than inventing a substrate for it.
 *
 * The number comes off {@link resolveKeyIssue} rather than a second regex over the whole directory
 * name. A quarantined key drives issue 8012 for `lane open`, `lane archive` and `lane settle`, so a
 * claim rule that read the same key as nameless would have let a second driver race an already-held
 * thread while every other verb agreed the lane was 8012's.
 */
export type ClaimTarget =
	| {readonly _tag: "Number"; readonly number: number}
	| {readonly _tag: "Inert"; readonly why: string};

export const claimTarget = (key: LaneKey): ClaimTarget => {
	if (key._tag === "Chore") {
		return {
			_tag: "Inert",
			why: `a ${CHORE_PREFIX}<name> lane has no board number, so there is no thread to race a claim on`,
		};
	}
	const resolved = resolveKeyIssue(key);
	return resolved._tag === "Issue"
		? {_tag: "Number", number: resolved.number}
		: {
				_tag: "Inert",
				why: `"${key.lane}" carries no leading board number, so there is no thread to race a claim on`,
			};
};

/**
 * The same target from a raw directory name — the seat count's reader, which holds entries read off
 * a lanes root rather than keys an operator addressed.
 *
 * It parses instead of casting, so a padded directory races the issue it drives and a name no key
 * could spell is `Inert` rather than a guess at a number. `Inert` is what the caller reads as
 * "nobody can be holding this", which is exactly true of a name with no thread behind it.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8853
 */
export const rawClaimTarget = (raw: string): ClaimTarget => {
	const parsed = parseKey(raw);
	return parsed._tag === "Key"
		? claimTarget(parsed.key)
		: {
				_tag: "Inert",
				why: `"${raw}" is not a lane key — ${parsed.reason} — so there is no thread to race a claim on`,
			};
};
