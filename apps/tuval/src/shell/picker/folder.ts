/**
 * The folder a picker open hands the process it spawns (#9694, rulings #9668 R3.1 and R6.3).
 *
 * A session entry names its place (`./place.ts`): a project's entry runs in that project's folder,
 * and a home entry runs where the desk itself does, the home folder the shell already carries. A
 * project's own row, opened with no place, runs in its project's folder, because a program runs in
 * its project's folder. Anything else runs where the shell runs, which is the home folder.
 *
 * Kernel-side only: it reads the open projects, which carry absolute paths the page never holds.
 */

import {scopedIdParts} from "@kampus/tuval-sdk/kernel/registry/scoped-id";
import {Option, Result} from "effect";
import type {OpenProject} from "../../projects/open-projects.ts";
import type {SessionPlace} from "./place.ts";
import {type PickerRefusal, projectClosed} from "./refusal.ts";

/**
 * `Some(folder)` to hand the spawn a folder of its own, `None` to let it inherit the shell's, or a
 * refusal when the entry named a project that has closed since the list was drawn.
 */
export const openFolder = (
	programId: string,
	place: SessionPlace | undefined,
	projects: ReadonlyArray<OpenProject>,
): Result.Result<Option.Option<string>, PickerRefusal> => {
	if (place?._tag === "Home") return Result.succeed(Option.none());
	if (place?._tag === "Project") {
		const project = projects.find((open) => open.id.key === place.key);
		return project === undefined
			? Result.fail(projectClosed(programId, place.label))
			: Result.succeed(Option.some(project.folder));
	}
	const {scope} = scopedIdParts(programId);
	const owner = scope === undefined ? undefined : projects.find((open) => open.id.key === scope);
	return Result.succeed(Option.fromNullishOr(owner?.folder));
};
