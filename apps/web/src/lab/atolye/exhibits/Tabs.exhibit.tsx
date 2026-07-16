import type * as React from "react";
import {Tabs} from "../../../components/ui/Tabs";
import {defineExhibit} from "../exhibit";

function TabsDemo({variant}: {variant?: "underline" | "pill"}) {
	return (
		<Tabs.Root variant={variant} defaultValue="genel">
			<Tabs.List>
				<Tabs.Tab value="genel">Genel</Tabs.Tab>
				<Tabs.Tab value="ayarlar">Ayarlar</Tabs.Tab>
				<Tabs.Tab value="gelismis">Gelişmiş</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="genel" style={{paddingTop: "var(--s-3)"}}>
				Genel içerik.
			</Tabs.Panel>
			<Tabs.Panel value="ayarlar" style={{paddingTop: "var(--s-3)"}}>
				Ayarlar içeriği.
			</Tabs.Panel>
			<Tabs.Panel value="gelismis" style={{paddingTop: "var(--s-3)"}}>
				Gelişmiş içerik.
			</Tabs.Panel>
		</Tabs.Root>
	);
}

export const tabsExhibit = defineExhibit<React.ComponentProps<typeof TabsDemo>>({
	id: "tabs",
	title: "Sekmeler",
	summary: "Altı çizili veya hap görünümlü sekme grubu — base-ui Tabs üstünde.",
	component: TabsDemo,
	knobs: {
		variant: {
			kind: "enum",
			label: "Görünüm",
			default: "underline",
			options: [
				{value: "underline", label: "Altı çizili"},
				{value: "pill", label: "Hap"},
			],
		},
	},
});
