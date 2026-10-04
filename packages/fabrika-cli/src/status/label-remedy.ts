/**
 * The remedy a verb names when it refuses over a label the repo lacks: the one
 * `fabrika status bootstrap <surface>` command that creates it.
 *
 * Every such refusal reads the surface off {@link labelSurface} rather than spelling it, so the
 * bootstrap sets stay the one place that says which command creates which label.
 */

import {CONFIG_PATH} from "../config/document.ts";
import type {BoardRead} from "../config/resolve-board.ts";
import {labelSurface} from "./bootstrap-verb.ts";

export {readBoard} from "./repo-board.ts";

/**
 * The sentence a missing-label refusal ends on.
 *
 * A refused board makes the surface UNKNOWN rather than the shipped default's answer, because the
 * repo may have declared a vocabulary under which another surface, or none, creates the label.
 */
export const missingLabelRemedy = (label: string, board: BoardRead): string => {
	if (board._tag === "Refused") {
		return `Which \`fabrika status bootstrap\` surface creates ${label} is UNKNOWN — ${CONFIG_PATH} is refused: ${board.reason.replace(/\.$/, "")}.`;
	}
	const surface = labelSurface(label, board.resolved.board);
	return surface === null
		? `No \`fabrika status bootstrap\` surface creates ${label} — create it by hand, then re-run.`
		: `Run \`fabrika status bootstrap ${surface}\` to create it, then re-run.`;
};
