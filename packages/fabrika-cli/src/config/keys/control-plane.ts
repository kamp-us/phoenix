/**
 * The control-plane key group: what a repo does when `.github/CODEOWNERS` cannot be read.
 *
 * Founder-ruled on #5603 (comment 28), built as #6299, recorded as ADR 0307: the answer is repo
 * configuration, not one
 * compiled-in reading, because the two repos that hold fabrika want opposite answers. In a repo
 * where CODEOWNERS is decoration, a transient read fault must not deadlock every PR. In phoenix
 * CODEOWNERS **is** the control-plane gate, so shipping a control-plane PR unreviewed on a failed
 * read is exactly the failure #4216 exists to prevent — phoenix declares `refuse` in its own
 * `.fabrika.jsonc`.
 *
 * **The shipped default deliberately does NOT reproduce today's behaviour**, which is the one place
 * this key departs from the rule in `.patterns/fabrika-config-key-groups.md`. Today every unreadable
 * CODEOWNERS is an exit `11` in every repo; the ruling is that `ship` is the default and the strict
 * value is declared. The departure is safe only because it is paired: the repo whose gate this
 * protects declares `refuse`, and a test holds that declaration in place.
 *
 * A **proven-absent** CODEOWNERS is not this key's business at all — an absent boundary means the
 * repo has no control plane and the PR ships (R3.1, #5603 comment 8). Absent is a fact about the
 * repo; unreadable is the absence of a fact, and only the second one needs a policy.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const UNREADABLE_CODEOWNERS = "unreadableCodeowners";

/** What a §CP read does when the boundary file itself could not be read. */
export type UnreadableCodeowners =
	/** Treat the boundary as absent: no control plane, the PR ships. */
	| "ship"
	/** Refuse the read as UNKNOWN — the caller's `11`. */
	| "refuse";

const VALUES: ReadonlyArray<UnreadableCodeowners> = ["ship", "refuse"];

const isValue = (raw: unknown): raw is UnreadableCodeowners =>
	typeof raw === "string" && (VALUES as ReadonlyArray<string>).includes(raw);

const decode = (raw: unknown): Decoded<UnreadableCodeowners> =>
	isValue(raw)
		? {_tag: "Value", value: raw}
		: {
				_tag: "Malformed",
				reason: `\`${UNREADABLE_CODEOWNERS}\` is ${JSON.stringify(raw)} — expected ${VALUES.map((value) => `"${value}"`).join(" or ")}`,
			};

export const unreadableCodeownersKey: KeyGroup<UnreadableCodeowners> = {
	key: UNREADABLE_CODEOWNERS,
	shippedDefault: "ship",
	decode,
};
