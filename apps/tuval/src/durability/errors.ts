import {Schema} from "effect";
import {ProcessId} from "../process/process.ts";

/**
 * A snapshot exists for the process but was written under another definition — a different
 * program version, or a different program altogether. Refused, never migrated and never
 * fresh-booted over (#7467, #7514): the process stays absent until a person decides.
 */
export class SnapshotRefused extends Schema.TaggedError<SnapshotRefused>()(
	"tuval/durability/SnapshotRefused",
	{
		processId: ProcessId,
		expected: Schema.Struct({programId: Schema.String, version: Schema.String}),
		found: Schema.Struct({programId: Schema.String, version: Schema.String}),
	},
) {
	override get message(): string {
		return `snapshot for process "${this.processId}" refused: written by ${this.found.programId}@${this.found.version}, the program is now ${this.expected.programId}@${this.expected.version}`;
	}
}

/** The bytes at the process's snapshot are not a snapshot. A refusal too, for the same reason. */
export class SnapshotMalformed extends Schema.TaggedError<SnapshotMalformed>()(
	"tuval/durability/SnapshotMalformed",
	{processId: ProcessId},
) {
	override get message(): string {
		return `snapshot for process "${this.processId}" refused: not a snapshot`;
	}
}

/** The manifest exists but is not a manifest; restore cannot know what to spawn. */
export class ManifestMalformed extends Schema.TaggedError<ManifestMalformed>()(
	"tuval/durability/ManifestMalformed",
	{},
) {
	override get message(): string {
		return "checkpoint manifest refused: not a manifest";
	}
}

/** A live process already holds this checkpoint; restoring it twice would replay its effects twice. */
export class CheckpointHeld extends Schema.TaggedError<CheckpointHeld>()(
	"tuval/durability/CheckpointHeld",
	{processId: ProcessId},
) {
	override get message(): string {
		return `checkpoint for process "${this.processId}" is held by a live process`;
	}
}
