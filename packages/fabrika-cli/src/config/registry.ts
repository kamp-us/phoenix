/**
 * Every key group `.fabrika.jsonc` carries, one line each.
 *
 * This file is the whole coupling between key groups. Adding a key is a new module under `keys/`
 * plus one line here — the shape the epic requires, because concurrent slices each add a key group
 * and a single growing reader would make them serialize on one file.
 */

import {type Registration, register} from "./key-group.ts";
import {boardVocabularyKey} from "./keys/board-vocabulary.ts";
import {campaignAuthorsKey} from "./keys/campaign-authors.ts";
import {capClearAuthorsKey} from "./keys/cap-clear-authors.ts";
import {ciKey} from "./keys/ci.ts";
import {codeValidatorsKey} from "./keys/code-validators.ts";
import {containmentVocabularyKey} from "./keys/containment-vocabulary.ts";
import {unreadableCodeownersKey} from "./keys/control-plane.ts";
import {dependencyReconcilerKey} from "./keys/dependency-reconciler.ts";
import {docLeakExemptKey} from "./keys/doc-leak-exempt.ts";
import {governedRootsKey} from "./keys/governed-roots.ts";
import {cycleDocKey, decisionsDirKey, designHarnessKey, roadmapFileKey} from "./keys/paths.ts";
import {surfaceDispositionsKey} from "./keys/surface-dispositions.ts";
import {triageFacetsKey} from "./keys/triage-facets.ts";
import {workflowValidatorsKey} from "./keys/workflow-validators.ts";

export const KEY_GROUPS: ReadonlyArray<Registration> = [
	register(boardVocabularyKey),
	register(campaignAuthorsKey),
	register(capClearAuthorsKey),
	register(ciKey),
	register(codeValidatorsKey),
	register(containmentVocabularyKey),
	register(cycleDocKey),
	register(decisionsDirKey),
	register(dependencyReconcilerKey),
	register(designHarnessKey),
	register(docLeakExemptKey),
	register(governedRootsKey),
	register(roadmapFileKey),
	register(surfaceDispositionsKey),
	register(triageFacetsKey),
	register(unreadableCodeownersKey),
	register(workflowValidatorsKey),
];
