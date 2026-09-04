import {Button, Menu} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

function MenuDemo({
	placement,
	defaultOpen,
}: {
	placement?: "top-start" | "right-start" | "bottom-start" | "bottom-end";
	defaultOpen?: boolean;
}) {
	return (
		<Menu
			defaultOpen={defaultOpen}
			placement={placement}
			trigger={<Button variant="secondary">Menü</Button>}
			items={[
				{value: "profile", label: "Profil"},
				{value: "search", label: "Ara", shortcut: "⌘K"},
				{type: "separator"},
				{value: "delete", label: <span className="kp-menu-danger">Sil</span>},
			]}
		/>
	);
}

export const menuExhibit = defineExhibit<React.ComponentProps<typeof MenuDemo>>({
	id: "menu",
	title: "Menu",
	summary: "Manti Menu ile kısayol, ayırıcı ve Phoenix tehlike görünümü.",
	component: MenuDemo,
	knobs: {
		placement: {
			kind: "enum",
			label: "Placement",
			default: "bottom-start",
			options: [
				{value: "top-start", label: "Top start"},
				{value: "right-start", label: "Right start"},
				{value: "bottom-start", label: "Bottom start"},
				{value: "bottom-end", label: "Bottom end"},
			],
		},
		defaultOpen: {kind: "boolean", label: "Start open", default: false},
	},
});
