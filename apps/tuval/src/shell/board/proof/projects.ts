/**
 * The two open projects the board's proof pages draw from: `/code/kamp-us/phoenix` and
 * `/code/usirin/phoenix`. The labels are what `projectLabels` (`../../../projects/open-projects.ts`)
 * gives those two folders — written out here because that module reads Node's path separator and
 * this is a browser page — and the keys are what `projectKey` gives them.
 */

import {ProjectLabels} from "../../../projects/labels.ts";

const KAMP_US = "-code-kamp_-us-phoenix";
const USIRIN = "-code-usirin-phoenix";

export const projects = ProjectLabels.of([
	{key: KAMP_US, label: "kamp-us/phoenix"},
	{key: USIRIN, label: "usirin/phoenix"},
]);

/** `local` as the kamp-us checkout's program id. */
export const kampUs = (local: string): string => `${KAMP_US}/${local}`;

/** `local` as the usirin checkout's program id. */
export const usirin = (local: string): string => `${USIRIN}/${local}`;
