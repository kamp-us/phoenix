import type * as React from "react";
import {Card} from "../../../components/ui/Card";
import {defineExhibit} from "../exhibit";

export const cardExhibit = defineExhibit<React.ComponentProps<typeof Card>>({
	id: "card",
	title: "Kart",
	summary: "Sınırlı, hafif yükseltilmiş yüzey — ton, yükseklik, köşe ve dolgu token'larıyla.",
	component: Card,
	knobs: {
		tone: {
			kind: "enum",
			label: "Ton",
			default: "default",
			options: [
				{value: "default", label: "Varsayılan"},
				{value: "raised", label: "Yükseltilmiş"},
				{value: "sunken", label: "Çökük"},
			],
		},
		elevation: {
			kind: "enum",
			label: "Yükseklik",
			default: "raised",
			options: [
				{value: "flat", label: "Düz"},
				{value: "raised", label: "Yükseltilmiş"},
				{value: "dropdown", label: "Açılır"},
				{value: "overlay", label: "Katman"},
			],
		},
		radius: {
			kind: "enum",
			label: "Köşe",
			default: "md",
			options: [
				{value: "none", label: "Yok"},
				{value: "sm", label: "Küçük"},
				{value: "md", label: "Orta"},
				{value: "lg", label: "Büyük"},
			],
		},
		padding: {
			kind: "enum",
			label: "Dolgu",
			default: "md",
			options: [
				{value: "none", label: "Yok"},
				{value: "sm", label: "Küçük"},
				{value: "md", label: "Orta"},
				{value: "lg", label: "Büyük"},
			],
		},
		border: {kind: "boolean", label: "Kenarlık", default: true},
		interactive: {kind: "boolean", label: "Tıklanabilir", default: false},
	},
	fixedProps: {children: "Kartın içeriği burada yer alır."},
});
