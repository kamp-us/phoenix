import type * as React from "react";
import {Switch} from "../../../components/ui/Switch";
import {defineExhibit} from "../exhibit";

export const switchExhibit = defineExhibit<React.ComponentProps<typeof Switch>>({
	id: "switch",
	title: "Anahtar",
	summary: "İki durumlu aç/kapa anahtarı — base-ui Switch üstünde, rol token'larıyla.",
	component: Switch,
	knobs: {
		defaultChecked: {kind: "boolean", label: "Açık", default: true},
		disabled: {kind: "boolean", label: "Devre dışı", default: false},
	},
	fixedProps: {"aria-label": "Bildirimler"},
});
