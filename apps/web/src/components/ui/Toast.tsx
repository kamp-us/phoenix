import * as React from "react";
import "./Toast.css";

export interface ToastDescriptor {
	id: string;
	message: React.ReactNode;
	/**
	 * Duration in ms before the toast auto-dismisses. `0` keeps the toast
	 * visible until the user dismisses it manually (useful for the session-
	 * expired toast where the user needs time to click the relogin link).
	 */
	durationMs?: number;
	testId?: string;
}

interface ToastContextValue {
	show: (toast: Omit<ToastDescriptor, "id"> & {id?: string}) => string;
	dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let nextId = 0;

/**
 * @component ToastProvider
 * @whenToUse The transient-notification host. Mount it once near the app root; child
 *   surfaces raise toasts via the `useToast` hook (`show`/`dismiss`). Reach for it
 *   for ephemeral status messages (a saved confirmation, a session-expired notice) —
 *   re-showing the same id replaces rather than stacks.
 * @slot children The subtree that can raise toasts via `useToast`.
 */
export function ToastProvider({children}: {children: React.ReactNode}) {
	const [toasts, setToasts] = React.useState<ToastDescriptor[]>([]);

	const dismiss = React.useCallback((id: string) => {
		setToasts((current) => current.filter((t) => t.id !== id));
	}, []);

	const show = React.useCallback((input: Omit<ToastDescriptor, "id"> & {id?: string}) => {
		const id = input.id ?? `toast-${++nextId}`;
		setToasts((current) => {
			// Re-showing the same id replaces the row instead of stacking — the
			// session-expired flow relies on this to avoid N copies on N failed mutations.
			const filtered = current.filter((t) => t.id !== id);
			return [...filtered, {id, ...input}];
		});
		return id;
	}, []);

	React.useEffect(() => {
		const timers: ReturnType<typeof setTimeout>[] = [];
		for (const t of toasts) {
			const duration = t.durationMs ?? 7000;
			if (duration > 0) {
				timers.push(setTimeout(() => dismiss(t.id), duration));
			}
		}
		return () => {
			for (const id of timers) clearTimeout(id);
		};
	}, [toasts, dismiss]);

	const value = React.useMemo(() => ({show, dismiss}), [show, dismiss]);

	return (
		<ToastContext.Provider value={value}>
			{children}
			<section className="kp-toast-region" aria-label="Bildirimler">
				{toasts.map((t) => (
					<div
						key={t.id}
						className="kp-toast"
						role="status"
						data-testid={t.testId ? `toast-${t.testId}` : "toast"}
					>
						<div className="kp-toast__body">{t.message}</div>
						<button
							type="button"
							className="kp-toast__close"
							aria-label="Kapat"
							onClick={() => dismiss(t.id)}
							data-testid={t.testId ? `toast-close-${t.testId}` : undefined}
						>
							×
						</button>
					</div>
				))}
			</section>
		</ToastContext.Provider>
	);
}

export function useToast(): ToastContextValue {
	const ctx = React.useContext(ToastContext);
	if (!ctx) {
		throw new Error("useToast must be used inside a <ToastProvider />");
	}
	return ctx;
}
