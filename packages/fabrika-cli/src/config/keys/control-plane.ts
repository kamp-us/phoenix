/**
 * The control-plane key group: what a repo does when `.github/CODEOWNERS` cannot be read.
 *
 * **Nothing reads this key.** `ship/boundary.ts` consulted it (#6299, ADR 0307) until the founder
 * reverted that on #5631: a failed CODEOWNERS read is the caller's `11` in every repo, and a
 * proven-absent one is the `unknown` hold — ADR 0220 §4 names collapsing `unknown` →
 * `not-control-plane` the recurring fail-open defect, and §CP has no residual gate behind it. The
 * key is left declared, and what becomes of it is the founder's to rule.
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
