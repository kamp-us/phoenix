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
	title: "Menu",
	summary: "A dropdown menu with a shortcut, separator, and danger item — built on base-ui Menu.",
	component: MenuDemo,
	knobs: {
		side: {
			kind: "enum",
			label: "Side",
			default: "bottom",
			options: [
				{value: "top", label: "Top"},
				{value: "right", label: "Right"},
				{value: "bottom", label: "Bottom"},
				{value: "left", label: "Left"},
			],
		},
		align: {
			kind: "enum",
			label: "Align",
			default: "start",
			options: [
				{value: "start", label: "Start"},
				{value: "center", label: "Center"},
				{value: "end", label: "End"},
			],
		},
		defaultOpen: {kind: "boolean", label: "Start open", default: false},
	},
});
