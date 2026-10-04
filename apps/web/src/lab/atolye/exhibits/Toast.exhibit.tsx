import {Button, ToastProvider, useToast} from "@kampus/design";
import type * as React from "react";
import {defineExhibit} from "../exhibit";

// zag keeps a toast up only when its duration is exactly `Infinity`; a `0` is a zero-millisecond
// timer that dismisses at once (`@zag-js/toast@1.43.0` `dist/toast.machine.mjs:22`, `:71`).
function toastDuration(knobMs: number): number {
	return knobMs === 0 ? Number.POSITIVE_INFINITY : knobMs;
}

function ToastTrigger({durationMs}: {durationMs: number}) {
	const {show} = useToast();
	return (
		<Button
			variant="secondary"
			onClick={() =>
				show({message: "Değişiklikler kaydedildi.", durationMs: toastDuration(durationMs)})
			}
		>
			Bildirim göster
		</Button>
	);
}

function ToastDemo({durationMs}: {durationMs?: number}) {
	return (
		<ToastProvider>
			<ToastTrigger durationMs={durationMs ?? 4000} />
		</ToastProvider>
	);
}

export const toastExhibit = defineExhibit<React.ComponentProps<typeof ToastDemo>>({
	id: "toast",
	title: "Toast",
	summary:
		"A transient, self-dismissing notification strip that appears at the edge of the screen.",
	component: ToastDemo,
	knobs: {
		durationMs: {
			kind: "number",
			label: "Duration (ms, 0=persistent)",
			default: 4000,
			min: 0,
			step: 500,
		},
	},
});
