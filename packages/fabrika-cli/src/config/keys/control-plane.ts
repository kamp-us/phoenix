/**
 * The control-plane key group: what a repo does when `.github/CODEOWNERS` cannot be read.
 *
 * **Nothing reads this key.** `ship/boundary.ts` consulted it until that was reverted: a failed
 * CODEOWNERS read is the caller's `11` in every repo, and a proven-absent one is the `unknown` hold.
 * Collapsing `unknown` → `not-control-plane` is the recurring fail-open defect, and the
 * control-plane classification has no residual gate behind it. The key is left declared, and what
 * becomes of it is the repo owner's to rule.
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
	jsonSchema: {
		type: "string",
		description:
			"What a §CP read does when `.github/CODEOWNERS` itself cannot be read: `ship` treats the boundary as absent, `refuse` raises the caller's UNKNOWN. Nothing reads this key today.",
		enum: ["ship", "refuse"],
	},
};
