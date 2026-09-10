/**
 * `assemblyRefresh` — whether the driver refreshes an epic's assembly branch on its way into review.
 *
 * One sub-key. `onReview` says what `lane refresh --on-review` does: `off` declines and merges
 * nothing, `on` performs the merge. The verb called by hand is never gated — a driver that types
 * `lane refresh <epic>` means it, and the key exists to decide whether the *automatic* call at
 * review entry happens at all.
 *
 * **The shipped default is `off`, which is today's behaviour byte for byte.** The automatic call is
 * a new step on a path every epic run walks, and a step that merges trunk into an assembly branch
 * changes what the tail review binds to. So a repo turns it on for itself once it wants the
 * refreshed head, and a repo that declares nothing keeps the path it already has.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const ASSEMBLY_REFRESH = "assemblyRefresh";

/** What the automatic call at review entry gets: declined, or performed. */
export type OnReview = "off" | "on";

const ON_REVIEW_VALUES: ReadonlyArray<OnReview> = ["off", "on"];

export interface AssemblyRefreshSurface {
	readonly onReview: OnReview;
}

/** The shipped surface — what a repo declaring nothing still gets: the path it has today. */
export const SHIPPED_ASSEMBLY_REFRESH: AssemblyRefreshSurface = {onReview: "off"};

const named = (path: string): string => `\`${ASSEMBLY_REFRESH}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["onReview"];

const decodeOnReview = (raw: unknown): Decoded<OnReview> =>
	typeof raw === "string" && (ON_REVIEW_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as OnReview}
		: {
				_tag: "Malformed",
				reason: `${named("onReview")} is not one of ${ON_REVIEW_VALUES.join(", ")}`,
			};

const decode = (raw: unknown): Decoded<AssemblyRefreshSurface> => {
	const record = asRecord(raw);
	if (record === null) {
		return {_tag: "Malformed", reason: `\`${ASSEMBLY_REFRESH}\` is not an object`};
	}
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not an assembly-refresh setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const onReview =
		record.onReview === undefined
			? ({_tag: "Value", value: SHIPPED_ASSEMBLY_REFRESH.onReview} as const)
			: decodeOnReview(record.onReview);
	if (onReview._tag === "Malformed") return onReview;

	return {_tag: "Value", value: {onReview: onReview.value}};
};

export const assemblyRefreshKey: KeyGroup<AssemblyRefreshSurface> = {
	key: ASSEMBLY_REFRESH,
	shippedDefault: SHIPPED_ASSEMBLY_REFRESH,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Whether the driver merges the trunk into an epic's assembly branch on its way into review.",
		properties: {
			onReview: {
				type: "string",
				description:
					"What `lane refresh --on-review` does: `off` (declines and merges nothing — the shipped default, and today's path into review) or `on` (performs the merge, so the tail review binds to a head the queue can take). A hand-called `lane refresh` is never gated by this.",
				enum: ["off", "on"],
			},
		},
		additionalProperties: false,
	},
};
