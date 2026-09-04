import {
	Button,
	CommandPalette,
	type CommandPaletteItem,
	type CommandPaletteScope,
	Kbd,
} from "@kampus/design";
import {BookOpen, Compass, FileText, Search, Users} from "lucide-react";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

const results: readonly CommandPaletteItem[] = [
	{
		value: "sozluk-effect",
		label: "Effect nedir?",
		description: "sözlük · 12 entry",
		group: "Sözlük",
		keywords: ["typescript", "functional"],
		icon: <BookOpen size={20} />,
		scope: ":",
	},
	{
		value: "pano-design",
		label: "kamp.us tasarım sistemi",
		description: "pano · umut · 8 yorum",
		group: "Pano",
		icon: <FileText size={20} />,
		scope: "#",
	},
	{
		value: "pano-search",
		label: "Arama deneyimini birleştirmek",
		description: "pano · can · 4 yorum",
		group: "Pano",
		icon: <Search size={20} />,
		scope: "#",
	},
	{
		value: "member-ada",
		label: "ada",
		description: "yazar · 142 katkı",
		group: "Kampüs",
		icon: <Users size={20} />,
		scope: "@",
	},
	{
		value: "route-mecmua",
		label: "mecmua",
		description: "yakında",
		group: "Kampüs",
		icon: <Compass size={20} />,
		disabled: true,
	},
];

const scopes: readonly CommandPaletteScope[] = [
	{sigil: "@", label: "kullanıcı"},
	{sigil: "#", label: "pano konusu"},
	{sigil: ":", label: "sözlük başlığı"},
];

function CommandPaletteDemo(props: Omit<React.ComponentProps<typeof CommandPalette>, "items">) {
	return <CommandPalette {...props} items={results} />;
}

export const commandPaletteExhibit = defineExhibit<React.ComponentProps<typeof CommandPaletteDemo>>(
	{
		id: "command-palette",
		title: "Command Palette",
		summary: "Kampüs’ün tek arama kontratı için modal, klavye odaklı ve gruplu sonuç yüzeyi.",
		component: CommandPaletteDemo,
		fixedProps: {
			scopes,
			scopeHintLabel: "tüyo",
			trigger: (
				<Button variant="secondary" icon={<Search size={16} />}>
					Paleti aç
				</Button>
			),
			footer: (
				<>
					<Kbd>↑↓</Kbd> gezin · <Kbd>↵</Kbd> aç · <Kbd>esc</Kbd> kapat
				</>
			),
		},
		knobs: {
			title: {kind: "string", label: "Erişilebilir başlık", default: "kamp.us’ta ara"},
			placeholder: {kind: "string", label: "Placeholder", default: "bir şeyler ara…"},
			emptyLabel: {kind: "string", label: "Boş durum", default: "eşleşen bir şey bulamadık"},
			loadingLabel: {kind: "string", label: "Yükleniyor", default: "kampüs aranıyor…"},
			defaultQuery: {kind: "string", label: "Başlangıç sorgusu", default: ""},
			defaultOpen: {kind: "boolean", label: "Başlangıçta açık", default: false},
			loading: {kind: "boolean", label: "Yükleniyor", default: false},
			disabled: {kind: "boolean", label: "Devre dışı", default: false},
			closeOnSelect: {kind: "boolean", label: "Seçince kapat", default: true},
			shortcut: {kind: "boolean", label: "⌘/Ctrl K", default: true},
			maxResults: {kind: "number", label: "Azami sonuç", default: 8, min: 0, max: 20},
			showSearchIcon: {kind: "boolean", label: "Arama ikonu", default: true},
			variant: {
				kind: "enum",
				label: "Görünüm",
				default: "flush",
				options: [
					{value: "flush", label: "Flush"},
					{value: "inset", label: "Inset"},
				],
			},
		},
	},
);
