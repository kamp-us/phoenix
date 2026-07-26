import {createToaster} from "@manti-ui/react";
import * as React from "react";
import "./Toast.css";

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

const {toaster, Toaster} = createToaster({
	placement: "bottom-end",
	overlap: false,
	max: 5,
	gap: 8,
	duration: 7000,
});

const ToastContext = React.createContext<ToastContextValue | null>(null);

/**
 * @component ToastProvider
 * @whenToUse The Manti-backed transient-notification host. Mount it once near the
 *   application root and raise ephemeral status through `useToast`; stable ids replace.
 * @slot children The subtree that can call `useToast`.
 */
export function ToastProvider({children}: {children: React.ReactNode}) {
	const value = React.useMemo<ToastContextValue>(
		() => ({
			show: ({id, message, durationMs, testId}) =>
				toaster.create({
					id,
					title: testId ? <span data-testid={`toast-${testId}`}>{message}</span> : message,
					duration: durationMs,
					closable: true,
				}),
			dismiss: (id) => toaster.dismiss(id),
		}),
		[],
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
