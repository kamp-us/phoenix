import type * as React from "react";
import {CaylakBadge} from "../../../components/ui/CaylakBadge";
import {defineExhibit} from "../exhibit";

// A propless badge, like its `ReviewBadge` sibling — no knob. Which of the two an item
// actually shows is `SandboxMarker`'s call, not the badge's.
export const caylakBadgeExhibit = defineExhibit<React.ComponentProps<typeof CaylakBadge>>({
	id: "caylak-badge",
	title: "CaylakBadge",
	summary: "The quiet marker a reader sees on a rookie's hazırlık-stage contribution.",
	component: CaylakBadge,
	knobs: {},
});
