/**
 * `assemblyReplay` — whether a colliding child is replayed onto the assembly tip, or the collision
 * stops the integration.
 *
 * One sub-key. `onCollision` says what `lane integrate` does when the child's merge conflicts: `off`
 * aborts and refuses, `on` replays the child's commits onto the tip, keeps both sides of a plain
 * keep-both hunk, and sends the child back for one review round over the moved range. A hunk that is
 * not a plain keep-both parks either way — resolving content is a judgment no verb makes.
 *
 * **The shipped default is `off`, which is today's behaviour byte for byte.** A replay rewrites a
 * child's commits onto a head its reviewer never saw, so the range a repo's epic review binds to
 * moves. That is worth having and it is a repo's own call, so a repo turns it on for itself and one
 * declaring nothing keeps the refusal it already has.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const ASSEMBLY_REPLAY = "assemblyReplay";

/** What a colliding child gets: the refusal, or the replay. */
export type OnCollision = "off" | "on";

const ON_COLLISION_VALUES: ReadonlyArray<OnCollision> = ["off", "on"];

export interface AssemblyReplaySurface {
	readonly onCollision: OnCollision;
}

/** The shipped surface — what a repo declaring nothing still gets: the refusal it has today. */
export const SHIPPED_ASSEMBLY_REPLAY: AssemblyReplaySurface = {onCollision: "off"};

const named = (path: string): string => `\`${ASSEMBLY_REPLAY}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["onCollision"];

const decodeOnCollision = (raw: unknown): Decoded<OnCollision> =>
	typeof raw === "string" && (ON_COLLISION_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as OnCollision}
		: {
				_tag: "Malformed",
				reason: `${named("onCollision")} is not one of ${ON_COLLISION_VALUES.join(", ")}`,
			};

const decode = (raw: unknown): Decoded<AssemblyReplaySurface> => {
	const record = asRecord(raw);
	if (record === null) {
		return {_tag: "Malformed", reason: `\`${ASSEMBLY_REPLAY}\` is not an object`};
	}
	const stray = Object.keys(record).find((key) => !KNOWN.includes(key));
	if (stray !== undefined) {
		return {
			_tag: "Malformed",
			reason: `${named(stray)} is not an assembly-replay setting — one of ${KNOWN.join(", ")}`,
		};
	}

	const onCollision =
		record.onCollision === undefined
			? ({_tag: "Value", value: SHIPPED_ASSEMBLY_REPLAY.onCollision} as const)
			: decodeOnCollision(record.onCollision);
	if (onCollision._tag === "Malformed") return onCollision;

	return {_tag: "Value", value: {onCollision: onCollision.value}};
};

export const assemblyReplayKey: KeyGroup<AssemblyReplaySurface> = {
	key: ASSEMBLY_REPLAY,
	shippedDefault: SHIPPED_ASSEMBLY_REPLAY,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"Whether a child whose merge collides with the epic run's assembly branch is replayed onto its tip.",
		properties: {
			onCollision: {
				type: "string",
				description:
					"What `lane integrate` does with a colliding child: `off` (abort the merge and refuse — the shipped default, and today's behaviour) or `on` (replay the child's commits onto the tip, keep both sides of a plain keep-both hunk, and send the child back for one review round over the moved range). A hunk that is not a plain keep-both parks under either.",
				enum: ["off", "on"],
			},
		},
		additionalProperties: false,
	},
};
