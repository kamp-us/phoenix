import type * as React from "react";
import {Collapsible} from "../../../components/ui/Collapsible";
import {defineExhibit} from "../exhibit";

function CollapsibleDemo({defaultOpen}: {defaultOpen?: boolean}) {
	return (
		<Collapsible.Root defaultOpen={defaultOpen}>
			<div style={{display: "flex", alignItems: "center", gap: "var(--s-2)"}}>
				<Collapsible.Trigger open={defaultOpen} />
				<span>Ayrıntılar</span>
			</div>
			<Collapsible.Panel>
				<p style={{margin: "var(--s-2) 0 0"}}>Katlanabilir içerik burada görünür.</p>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

export const collapsibleExhibit = defineExhibit<React.ComponentProps<typeof CollapsibleDemo>>({
	id: "collapsible",
	title: "Collapsible",
	summary: "A content panel that opens and closes from a trigger — built on base-ui Collapsible.",
	component: CollapsibleDemo,
	knobs: {
		defaultOpen: {kind: "boolean", label: "Start open", default: true},
	},
});
