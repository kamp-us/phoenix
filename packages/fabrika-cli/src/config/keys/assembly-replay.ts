/**
 * `assemblyReplay` — whether a colliding child is replayed onto the assembly tip, or the collision
 * stops the integration.
 *
 * `onCollision` says what `lane integrate` does when the child's merge conflicts: `off` aborts and
 * refuses, `on` replays the child's commits onto the tip, keeps both sides of a plain keep-both hunk,
 * and sends the child back for one review round over the moved range. A hunk that is not a plain
 * keep-both parks either way — resolving content is a judgment no verb makes.
 *
 * **The shipped default is `off`, which is today's behaviour byte for byte.** A replay rewrites a
 * child's commits onto a head its reviewer never saw, so the range a repo's epic review binds to
 * moves. That is worth having and it is a repo's own call, so a repo turns it on for itself and one
 * declaring nothing keeps the refusal it already has.
 *
 * `lockfileRegenerator` is the one collision the replay rebuilds rather than merges: a pick whose
 * every unmerged path is a declared lockfile `.gitattributes` marks `merge=binary`. Git cannot merge
 * such a file, and the repo's package manager can regenerate it from the manifests the pick merged.
 * It is its own command rather than `dependencyReconciler` because that one is the fail-closed install
 * (`--frozen-lockfile`) that refuses to write a lockfile; `lockfiles` names the paths it owns, so no
 * other binary file is ever regenerated. Absent or `null`, a lockfile collision parks as it always did.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9867#issuecomment-5851529523
 */

import {isRecord} from "../../io/json.ts";
import {trimmedStrings} from "../entries.ts";
import type {Decoded, KeyGroup} from "../key-group.ts";
import type {Argv} from "./workflow-validators.ts";

export const ASSEMBLY_REPLAY = "assemblyReplay";

/** What a colliding child gets: the refusal, or the replay. */
export type OnCollision = "off" | "on";

const ON_COLLISION_VALUES: ReadonlyArray<OnCollision> = ["off", "on"];

/** The repo's write-mode lockfile command, and the repo-relative lockfile paths it regenerates. */
export interface LockfileRegenerator {
	readonly argv: Argv;
	readonly lockfiles: readonly [string, ...ReadonlyArray<string>];
}

export interface AssemblyReplaySurface {
	readonly onCollision: OnCollision;
	/** `null` when the repo declares none, and a lockfile collision parks like any other. */
	readonly lockfileRegenerator: LockfileRegenerator | null;
}

/** The shipped surface — what a repo declaring nothing still gets: the refusal it has today. */
export const SHIPPED_ASSEMBLY_REPLAY: AssemblyReplaySurface = {
	onCollision: "off",
	lockfileRegenerator: null,
};

const named = (path: string): string => `\`${ASSEMBLY_REPLAY}\`'s \`${path}\``;

const asRecord = (raw: unknown): Record<string, unknown> | null =>
	typeof raw === "object" && raw !== null && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: null;

const KNOWN: ReadonlyArray<string> = ["onCollision", "lockfileRegenerator"];

const decodeOnCollision = (raw: unknown): Decoded<OnCollision> =>
	typeof raw === "string" && (ON_COLLISION_VALUES as ReadonlyArray<string>).includes(raw.trim())
		? {_tag: "Value", value: raw.trim() as OnCollision}
		: {
				_tag: "Malformed",
				reason: `${named("onCollision")} is not one of ${ON_COLLISION_VALUES.join(", ")}`,
			};

const REGENERATOR_KEYS: ReadonlyArray<string> = ["command", "lockfiles"];

const REGENERATOR_MALFORMED = `${named("lockfileRegenerator")} is not {"command": [non-empty argv of strings], "lockfiles": [non-empty list of repo-relative paths]} — e.g. {"command": ["pnpm", "install", "--lockfile-only"], "lockfiles": ["pnpm-lock.yaml"]}`;

const decodeLockfileRegenerator = (raw: unknown): Decoded<LockfileRegenerator | null> => {
	if (raw === null) return {_tag: "Value", value: null};
	if (!isRecord(raw) || Object.keys(raw).some((key) => !REGENERATOR_KEYS.includes(key))) {
		return {_tag: "Malformed", reason: REGENERATOR_MALFORMED};
	}
	const [binary, ...args] = trimmedStrings(raw.command) ?? [];
	const [lockfile, ...more] = trimmedStrings(raw.lockfiles) ?? [];
	if (binary === undefined || lockfile === undefined) {
		return {_tag: "Malformed", reason: REGENERATOR_MALFORMED};
	}
	return {_tag: "Value", value: {argv: [binary, ...args], lockfiles: [lockfile, ...more]}};
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

	const lockfileRegenerator =
		record.lockfileRegenerator === undefined
			? ({_tag: "Value", value: SHIPPED_ASSEMBLY_REPLAY.lockfileRegenerator} as const)
			: decodeLockfileRegenerator(record.lockfileRegenerator);
	if (lockfileRegenerator._tag === "Malformed") return lockfileRegenerator;

	return {
		_tag: "Value",
		value: {onCollision: onCollision.value, lockfileRegenerator: lockfileRegenerator.value},
	};
};

export const assemblyReplayKey: KeyGroup<AssemblyReplaySurface> = {
	key: ASSEMBLY_REPLAY,
	shippedDefault: SHIPPED_ASSEMBLY_REPLAY,
	decode,
	// `argv` is the spawn shape; the file's key is `command`, and a readout prints what the repo wrote.
	render: ({onCollision, lockfileRegenerator}) => ({
		onCollision,
		lockfileRegenerator:
			lockfileRegenerator === null
				? null
				: {command: [...lockfileRegenerator.argv], lockfiles: [...lockfileRegenerator.lockfiles]},
	}),
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
			lockfileRegenerator: {
				type: ["object", "null"],
				description:
					"The repo's write-mode command that regenerates a lockfile from the merged manifests. When every unmerged path of a replayed pick is one of `lockfiles` and `.gitattributes` marks it `merge=binary`, the replay runs `command` in the assembly worktree, stages the regenerated lockfile(s), and continues the pick. Absent or null, that collision parks like any other.",
				properties: {
					command: {
						type: "array",
						description: 'The argv to spawn — e.g. ["pnpm", "install", "--lockfile-only"].',
						items: {type: "string"},
						minItems: 1,
					},
					lockfiles: {
						type: "array",
						description:
							'The repo-relative lockfile paths the command regenerates — e.g. ["pnpm-lock.yaml"].',
						items: {type: "string"},
						minItems: 1,
					},
				},
				required: ["command", "lockfiles"],
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
};
