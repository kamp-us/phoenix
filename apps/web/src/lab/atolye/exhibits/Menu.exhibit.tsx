import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {Menu} from "../../../components/ui/Menu";
import {defineExhibit} from "../exhibit";

function MenuDemo({
	side,
	align,
	defaultOpen,
}: {
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	defaultOpen?: boolean;
}) {
	return (
		<Menu.Root defaultOpen={defaultOpen}>
			<Menu.Trigger render={<Button variant="secondary">Menü</Button>} />
			<Menu.Popup side={side} align={align}>
				<Menu.Item>Profil</Menu.Item>
				<Menu.Item shortcut="⌘K">Ara</Menu.Item>
				<Menu.Separator />
				<Menu.Item danger>Sil</Menu.Item>
			</Menu.Popup>
		</Menu.Root>
	);
}

export const menuExhibit = defineExhibit<React.ComponentProps<typeof MenuDemo>>({
	id: "menu",
	title: "Menü",
	summary: "Kısayol, ayraç ve tehlike öğesiyle açılır menü — base-ui Menu üstünde.",
	component: MenuDemo,
	knobs: {
		side: {
			kind: "enum",
			label: "Yön",
			default: "bottom",
			options: [
				{value: "top", label: "Üst"},
				{value: "right", label: "Sağ"},
				{value: "bottom", label: "Alt"},
				{value: "left", label: "Sol"},
			],
		},
		align: {
			kind: "enum",
			label: "Hizalama",
			default: "start",
			options: [
				{value: "start", label: "Başa"},
				{value: "center", label: "Ortaya"},
				{value: "end", label: "Sona"},
			],
		},
		defaultOpen: {kind: "boolean", label: "Açık başlat", default: false},
	},
});
