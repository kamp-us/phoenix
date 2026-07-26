import type * as React from "react";
import {Collapsible} from "../../../components/ui/Collapsible";
import {defineExhibit} from "../exhibit";

function CollapsibleDemo({defaultOpen}: {defaultOpen?: boolean}) {
	return (
		<Collapsible defaultOpen={defaultOpen} trigger="Ayrıntılar">
			<p style={{margin: "var(--s-2) 0 0"}}>Katlanabilir içerik burada görünür.</p>
		</Collapsible>
	);
}

export const collapsibleExhibit = defineExhibit<React.ComponentProps<typeof CollapsibleDemo>>({
	id: "collapsible",
	title: "Collapsible",
	summary: "Manti Collapsible ile açılıp kapanan içerik paneli.",
	component: CollapsibleDemo,
	knobs: {
		defaultOpen: {kind: "boolean", label: "Start open", default: true},
	},
});
