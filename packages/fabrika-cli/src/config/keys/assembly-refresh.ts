/**
 * `assemblyRefresh` — whether the driver refreshes an epic's assembly branch before the two moments
 * a shell is sent at it.
 *
 * Two sub-keys, one per automatic call. `onReview` says what `lane refresh --on-review` does on the
 * tail's way into review; `onDispatch` says what the pre-dispatch call inside `lane dispatch` does
 * before a child shell is cut from the branch. `off` declines and merges nothing, `on` performs the
 * merge. The verb called by hand is never gated — a driver that types `lane refresh <epic>` means
 * it, and the key exists to decide whether the *automatic* calls happen at all.
 *
 * **Both ship `off`, which is today's behaviour byte for byte.** Each is a new step on a path every
 * epic run walks, and a step that merges trunk into an assembly branch changes what the tail review
 * binds to and which tree a child builds in. So a repo turns each on for itself, and a repo that
 * declares nothing keeps the path it already has.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const ASSEMBLY_REFRESH = "assemblyRefresh";

/** What one automatic call gets: declined, or performed. */
export type OnReview = "off" | "on";

const ON_REVIEW_VALUES: ReadonlyArray<OnReview> = ["off", "on"];

export interface AssemblyRefreshSurface {
	readonly onReview: OnReview;
	readonly onDispatch: OnReview;
}

/** The shipped surface — what a repo declaring nothing still gets: the path it has today. */
export const SHIPPED_ASSEMBLY_REFRESH: AssemblyRefreshSurface = {
	onReview: "off",
	onDispatch: "off",
};

const named = (path: string): string => `\`${ASSEMBLY_REFRESH}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["onReview", "onDispatch"];

const decodeArm = (name: string, raw: unknown): Decoded<OnReview> =>
	typeof raw === "string" && (ON_REVIEW_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as OnReview}
		: {
				_tag: "Malformed",
				reason: `${named(name)} is not one of ${ON_REVIEW_VALUES.join(", ")}`,
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
			: decodeArm("onReview", record.onReview);
	if (onReview._tag === "Malformed") return onReview;

	const onDispatch =
		record.onDispatch === undefined
			? ({_tag: "Value", value: SHIPPED_ASSEMBLY_REFRESH.onDispatch} as const)
			: decodeArm("onDispatch", record.onDispatch);
	if (onDispatch._tag === "Malformed") return onDispatch;

	return {_tag: "Value", value: {onReview: onReview.value, onDispatch: onDispatch.value}};
};

export const assemblyRefreshKey: KeyGroup<AssemblyRefreshSurface> = {
	key: ASSEMBLY_REFRESH,
	shippedDefault: SHIPPED_ASSEMBLY_REFRESH,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Whether the driver merges the trunk into an epic's assembly branch before the tail enters review and before a child shell is dispatched off it.",
		properties: {
			onReview: {
				type: "string",
				description:
					"What `lane refresh --on-review` does: `off` (declines and merges nothing — the shipped default, and today's path into review) or `on` (performs the merge, so the tail review binds to a head the queue can take). A hand-called `lane refresh` is never gated by this.",
				enum: ["off", "on"],
			},
			onDispatch: {
				type: "string",
				description:
					"What `lane dispatch`'s pre-dispatch refresh does before it cuts a child's worktree off the assembly branch: `off` (declines and merges nothing — the shipped default, and today's dispatch path) or `on` (performs the merge, so the child builds and runs its verbs in a tree at least as new as the trunk). A hand-called `lane refresh` is never gated by this.",
				enum: ["off", "on"],
			},
		},
		additionalProperties: false,
	},
};
