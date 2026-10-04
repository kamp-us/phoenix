import {createToaster} from "@manti-ui/react";
import * as React from "react";
import "./Toast.css";
import {useDesignT} from "./i18n";

export interface ToastDescriptor {
	id: string;
	message: React.ReactNode;
	durationMs?: number;
	testId?: string;
}

interface ToastContextValue {
	show: (toast: Omit<ToastDescriptor, "id"> & {id?: string}) => string;
	dismiss: (id: string) => void;
}

// Manti binds `translations` once, when the toaster is built: `createToaster` destructures it into
// the closure its `Toaster` host renders every toast from (`@manti-ui/react@0.9.0`
// `dist/index.js:3790`, `:3808`), and `ToasterProps` is `{className?}` alone
// (`dist/components/Toast/Toast.d.ts`). So the label cannot be handed to an already-built toaster,
// and the toaster cannot live at module scope where `useDesignT` is unreachable. Building it per
// provider, keyed on the label, is what keeps the two in lockstep.
function buildToaster(closeTriggerLabel: string) {
	return {
		closeTriggerLabel,
		...createToaster({
			placement: "bottom-end",
			overlap: false,
			max: 5,
			gap: 8,
			duration: 7000,
			translations: {closeTriggerLabel},
		}),
	};
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

/**
 * @component ToastProvider
 * @whenToUse The Manti-backed transient-notification host. Mount it once near the
 *   application root and raise ephemeral status through `useToast`; stable ids replace.
 * @slot children The subtree that can call `useToast`.
 */
export function ToastProvider({children}: {children: React.ReactNode}) {
	const closeTriggerLabel = useDesignT()("ui.toast.close");
	// React's adjust-state-during-render shape. A catalog swap rebuilds the store, so a toast in
	// flight when the locale flips is dropped — the trade the paragraph above buys.
	const [built, setBuilt] = React.useState(() => buildToaster(closeTriggerLabel));
	if (built.closeTriggerLabel !== closeTriggerLabel) setBuilt(buildToaster(closeTriggerLabel));
	const {toaster, Toaster} = built;

	const value = React.useMemo<ToastContextValue>(
		() => ({
			show: ({id, message, durationMs, testId}) =>
				toaster.create({
					// The key must be absent, not undefined: zag's store spreads the caller's data over
					// the id it just generated (`@zag-js/toast@1.43.0` `dist/toast.store.mjs:81-89`), so
					// an explicit `id: undefined` erases it and the toast machine throws `missing
					// required props: id` (`dist/toast.machine.mjs:10`) — in production too, since
					// `ensureProps` is unguarded.
					...(id === undefined ? {} : {id}),
					title: testId ? <span data-testid={`toast-${testId}`}>{message}</span> : message,
					duration: durationMs,
					closable: true,
				}),
			dismiss: (id) => toaster.dismiss(id),
		}),
		[toaster],
	);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<Toaster className="kp-toast-region" />
		</ToastContext.Provider>
	);
}

export function useToast(): ToastContextValue {
	const context = React.useContext(ToastContext);
	if (!context) throw new Error("useToast must be used inside a <ToastProvider />");
	return context;
}
