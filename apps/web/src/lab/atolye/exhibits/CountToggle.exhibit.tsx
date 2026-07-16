import type * as React from "react";
import {CountToggle} from "../../../components/ui/CountToggle";
import {defineExhibit} from "../exhibit";

export const countToggleExhibit = defineExhibit<React.ComponentProps<typeof CountToggle>>({
	id: "count-toggle",
	title: "Sayaç Düğmesi",
	summary: "Basılı durumu aria-pressed ve aksan tintiyle taşıyan, sayı rozetli tepki hapı.",
	component: CountToggle,
	knobs: {
		pressed: {kind: "boolean", label: "Basılı", default: false},
		count: {kind: "number", label: "Sayı", default: 12, min: 0, step: 1},
		showZero: {kind: "boolean", label: "Sıfırı göster", default: false},
		disabled: {kind: "boolean", label: "Devre dışı", default: false},
	},
	fixedProps: {icon: "♥", children: "beğen", "aria-label": "beğen"},
});
