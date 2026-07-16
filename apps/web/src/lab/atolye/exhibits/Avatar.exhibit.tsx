import type * as React from "react";
import {Avatar} from "../../../components/ui/Avatar";
import {defineExhibit} from "../exhibit";

export const avatarExhibit = defineExhibit<React.ComponentProps<typeof Avatar>>({
	id: "avatar",
	title: "Avatar",
	summary: "Kullanıcı avatarı — görsel yoksa ada göre baş harflere düşer, dört boyutta.",
	component: Avatar,
	knobs: {
		name: {kind: "string", label: "Ad", default: "Ada Lovelace"},
		src: {kind: "string", label: "Görsel URL", default: "", placeholder: "boşsa baş harfler"},
		size: {
			kind: "enum",
			label: "Boyut",
			default: "md",
			options: [
				{value: "sm", label: "Küçük"},
				{value: "md", label: "Orta"},
				{value: "lg", label: "Büyük"},
				{value: "xl", label: "Çok büyük"},
			],
		},
	},
});
