import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {defineExhibit} from "../exhibit";

/**
 * The worked exemplar — proves the harness end to end: an enum knob per literal-union prop
 * (`variant`/`size`), a boolean knob per flag, and `children` pinned as a fixed prop because
 * `ReactNode` is not knobbable. Every later exhibit (#3094/#3095) follows this shape.
 */
export const buttonExhibit = defineExhibit<React.ComponentProps<typeof Button>>({
	id: "button",
	title: "Düğme",
	summary: "Birincil eylem düğmesi — görünüm, boyut ve durum varyantlarıyla.",
	component: Button,
	knobs: {
		variant: {
			kind: "enum",
			label: "Görünüm",
			default: "primary",
			options: [
				{value: "primary", label: "Birincil"},
				{value: "secondary", label: "İkincil"},
				{value: "tertiary", label: "Üçüncül"},
				{value: "danger", label: "Tehlike"},
			],
		},
		size: {
			kind: "enum",
			label: "Boyut",
			default: "md",
			options: [
				{value: "sm", label: "Küçük"},
				{value: "md", label: "Orta"},
				{value: "lg", label: "Büyük"},
			],
		},
		pressed: {kind: "boolean", label: "Basılı", default: false},
		loading: {kind: "boolean", label: "Yükleniyor", default: false},
		block: {kind: "boolean", label: "Tam genişlik", default: false},
		disabled: {kind: "boolean", label: "Devre dışı", default: false},
	},
	fixedProps: {children: "Kaydet"},
});
