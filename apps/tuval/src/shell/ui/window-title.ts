/**
 * What a window's title row says, as a pure function of its mount (#8721, epic ruling R3.1).
 *
 * The shell composes nothing: a bound window's title is the line its process published on `title@1`
 * and no more, so a Claude session reads `claude · fable · phoenix` because the AI-agent program
 * said that string, not because this function knows what a Claude session is (ruling R8.1).
 *
 * Every arm is a value. A process that published no title is named by its program rather than by
 * its uuid, and the two arms that name no process — an empty window, a gone one — keep the strings
 * they have always had.
 */

import type {ProcessId} from "../../process/process.ts";
import type {ProcessName, WindowMount} from "./mount.ts";

/** The pre-#8721 title, and still what a window whose desk names no windows shows. */
const byId = (processId: ProcessId): string => `process ${processId}`;

/**
 * A published title only counts as one when it has ink in it. A program that emitted `""` — or a
 * line of spaces — has named nothing, and a blank title row is worse than the program's own id.
 */
const named = (name: ProcessName): string =>
	name.title !== null && name.title.trim() !== "" ? name.title : name.programId;

export const windowTitle = (mount: WindowMount): string => {
	switch (mount._tag) {
		case "Bound":
			return mount.name === null ? byId(mount.host.processId) : named(mount.name);
		case "NoRenderer":
			return mount.name === null ? byId(mount.processId) : named(mount.name);
		case "ProcessGone":
			return `process ${mount.processId} — gone`;
		case "Empty":
			return "empty window";
	}
};
