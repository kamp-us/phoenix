import * as React from "react";
import "./Toast.css";

/**
 * Minimal toast / notification primitive (T17). The session-expired flow
 * surfaces these toasts when a write mutation fails with `UNAUTHORIZED`; the
 * toast carries a link back to `/auth?returnTo=<current>` so the user can
 * recover without losing their place.
 *
 * Designed to stay tiny — no portal, no animation library, no third-party
 * dependency. Renders in a fixed-position region at the bottom-right.
 * Multi-toast support: each `show()` call appends a row; rows dismiss
 * individually via the close button or after a 7s auto-timeout.
 */

export interface ToastDescriptor {
	id: string;
	message: React.ReactNode;
	/**
	 * Duration in ms before the toast auto-dismisses. `0` keeps the toast
	 * visible until the user dismisses it manually (useful for the session-
	 * expired toast where the user needs time to click the relogin link).
	 */
	durationMs?: number;
	/** Stable testid suffix for Playwright assertions. */
	testId?: string;
}

interface ToastContextValue {
	show: (toast: Omit<ToastDescriptor, "id"> & {id?: string}) => string;
	dismiss: (id: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({children}: {children: React.ReactNode}) {
	const [toasts, setToasts] = React.useState<ToastDescriptor[]>([]);

	const dismiss = React.useCallback((id: string) => {
		setToasts((current) => current.filter((t) => t.id !== id));
	}, []);

	const show = React.useCallback(
		(input: Omit<ToastDescriptor, "id"> & {id?: string}) => {
			const id = input.id ?? `toast-${++nextId}`;
			setToasts((current) => {
				// Stable id collapse — re-showing the same id replaces the row
				// instead of stacking duplicates. The session-expired flow uses
				// this to avoid N copies on N failed mutations in a row.
				const filtered = current.filter((t) => t.id !== id);
				return [...filtered, {id, ...input}];
			});
			return id;
		},
		[],
	);

	// Auto-dismiss timers — one per toast with `durationMs > 0`.
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
			<div className="kp-toast-region" role="region" aria-label="Bildirimler">
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
			</div>
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
