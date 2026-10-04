/**
 * Reading `decision ruling`'s answer for the one question a ruling park asks: has a ruling been
 * made on the pointed-at issue since the lane parked.
 *
 * The verb exits `0` on `absent` as readily as on `current`, so its exit code says only that the
 * read ran. What decides is the `state` field and the marker's `at`, and this file is the pure
 * function over those two so each holding case is testable without a board.
 *
 * `stale` clears beside `current`. A marker binds a digest of the issue body, so re-triaging the
 * issue after its ruling flips the read to `stale`, and that is the ordinary path: the ruling the
 * lane waited for was made, and holding on `stale` would keep the lane parked after it. A
 * `type:decision` lane is the one that needs `current`, and it does not park on this cause.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10290#issuecomment-5974131397
 */
import {isRecord, parseJson} from "../io/json.ts";

export type RulingRead =
	/** A ruling marker newer than the park stands on the issue. */
	| {readonly _tag: "Made"; readonly state: "current" | "stale"; readonly at: string}
	/** The read is sound and the ruling the park waits on is not there. */
	| {readonly _tag: "Holds"; readonly reason: string}
	/** The answer or the park's own time does not read, so whether a ruling was made is UNKNOWN. */
	| {readonly _tag: "Unreadable"; readonly reason: string};

/** Whether `decision ruling`'s stdout names a ruling made after `parkedAt`. */
export const rulingSince = (stdout: string, parkedAt: string | null): RulingRead => {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed) || typeof parsed.state !== "string") {
		return {_tag: "Unreadable", reason: "decision ruling answered no `state`"};
	}
	if (parsed.state === "absent") {
		return {_tag: "Holds", reason: "no ruling marker stands on it"};
	}
	if (parsed.state !== "current" && parsed.state !== "stale") {
		return {_tag: "Unreadable", reason: `decision ruling answered the state "${parsed.state}"`};
	}
	const at = typeof parsed.at === "string" ? parsed.at : null;
	const ruled = at === null ? Number.NaN : Date.parse(at);
	if (at === null || Number.isNaN(ruled)) {
		return {
			_tag: "Unreadable",
			reason: `decision ruling answered "${parsed.state}" with no readable \`at\``,
		};
	}
	const parked = parkedAt === null ? Number.NaN : Date.parse(parkedAt);
	if (Number.isNaN(parked)) {
		return {
			_tag: "Unreadable",
			reason: "the park line carries no readable time to compare against",
		};
	}
	return ruled > parked
		? {_tag: "Made", state: parsed.state, at}
		: {
				_tag: "Holds",
				reason: `its ruling marker is dated ${at}, which is not later than the park at ${parkedAt}`,
			};
};
