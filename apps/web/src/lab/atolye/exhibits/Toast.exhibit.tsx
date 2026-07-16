import type * as React from "react";
import {Button} from "../../../components/ui/Button";
import {ToastProvider, useToast} from "../../../components/ui/Toast";
import {defineExhibit} from "../exhibit";

function ToastTrigger({durationMs}: {durationMs: number}) {
	const {show} = useToast();
	return (
		<Button
			variant="secondary"
			onClick={() => show({message: "Değişiklikler kaydedildi.", durationMs})}
		>
			Bildirim göster
		</Button>
	);
}

// The toast is imperative (a `useToast().show` call), so the exhibit wraps a
// trigger in its own `ToastProvider`; `durationMs=0` keeps the toast until dismissed.
function ToastDemo({durationMs}: {durationMs?: number}) {
	return (
		<ToastProvider>
			<ToastTrigger durationMs={durationMs ?? 4000} />
		</ToastProvider>
	);
}

export const toastExhibit = defineExhibit<React.ComponentProps<typeof ToastDemo>>({
	id: "toast",
	title: "Bildirim",
	summary: "Ekranın kenarında beliren, kendiliğinden kapanan geçici bildirim şeridi.",
	component: ToastDemo,
	knobs: {
		durationMs: {kind: "number", label: "Süre (ms, 0=kalıcı)", default: 4000, min: 0, step: 500},
	},
});
