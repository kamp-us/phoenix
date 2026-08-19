/**
 * Every key group `.fabrika.jsonc` carries, one line each.
 *
 * This file is the whole coupling between key groups. Adding a key is a new module under `keys/`
 * plus one line here — the shape the epic requires, because concurrent slices each add a key group
 * and a single growing reader would make them serialize on one file.
 */

import {type Registration, register} from "./key-group.ts";
import {capClearAuthorsKey} from "./keys/cap-clear-authors.ts";
import {docLeakExemptKey} from "./keys/doc-leak-exempt.ts";
import {governedRootsKey} from "./keys/governed-roots.ts";
import {triageFacetsKey} from "./keys/triage-facets.ts";
import {workflowValidatorsKey} from "./keys/workflow-validators.ts";

export const KEY_GROUPS: ReadonlyArray<Registration> = [
	register(capClearAuthorsKey),
	register(docLeakExemptKey),
	register(governedRootsKey),
	register(triageFacetsKey),
	register(workflowValidatorsKey),
];
