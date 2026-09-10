/**
 * Does the parent epic's emitted machine actually hold a task for this child?
 *
 * `lane open`'s child refusal used to answer that from the board edge alone — the edge exists, so
 * the parent's lane "already carries it as a task". For a follow-up linked under an epic *after*
 * its lane was emitted the assertion is false, and the remedy it names sends the driver to a lane
 * with no cell for the issue — no operator can pick it up at all. So the edge is where the question
 * starts and the parent lane's compiled task set is where it is answered.
 *
 * Three outcomes, because their remedies differ: the parent lane holds the task (drive it), it
 * loaded and holds none (place the child in the epic's `## Dependencies` block, `lane amend`, then
 * drive it), or the task set did not read at all. The third is UNKNOWN and never collapses into
 * either of the first two — a parent lane that is absent from disk has said nothing about
 * membership, and reading it as "no task" would name a repair route over evidence nobody has.
 *
 * Nothing here writes. The read is the same guarded {@link loadLane} every other lane verb goes
 * through, so a malformed epic machine is a defect here exactly as it is there.
 */
import {Effect, type FileSystem, type Path} from "effect";
import {childTaskId} from "./emit.ts";
import {loadLane} from "./store.ts";

export type ChildMembership =
	| {readonly _tag: "Represented"; readonly parent: number; readonly taskId: string}
	| {readonly _tag: "Absent"; readonly parent: number; readonly taskId: string}
	| {readonly _tag: "Unknown"; readonly parent: number | null; readonly reason: string};

/**
 * Judge one child against its parent lane's emitted task set.
 *
 * `root` is the lanes root the boot resolved; the parent epic's lane is keyed by its issue number
 * under that same root, which is what makes this read need no second config.
 */
export const childMembership = (
	root: string,
	parent: number | null,
	child: number,
): Effect.Effect<ChildMembership, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const taskId = childTaskId(child);
		if (parent === null) {
			return {
				_tag: "Unknown",
				parent,
				reason:
					"the board carried the edge and no parent number that reads, so there is no lane to look in",
			} as const;
		}
		const loaded = yield* loadLane({root, lane: String(parent)});
		switch (loaded._tag) {
			case "Loaded":
				return Object.hasOwn(loaded.lane.tasks, taskId)
					? ({_tag: "Represented", parent, taskId} as const)
					: ({_tag: "Absent", parent, taskId} as const);
			case "Absent":
				return {_tag: "Unknown", parent, reason: `no lane is on disk at ${loaded.dir}`} as const;
			case "Unreadable":
				return {
					_tag: "Unknown",
					parent,
					reason: `${loaded.path} could not be read: ${loaded.reason}`,
				} as const;
			case "Malformed":
				return {
					_tag: "Unknown",
					parent,
					reason: `${loaded.path} does not compile: ${loaded.defects.join("; ")}`,
				} as const;
		}
	});
