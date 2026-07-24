import * as React from "react";

/**
 * The `+ yeni tanım` create dialog's open-state, hoisted OUT of `SozlukSubnavCta`'s local
 * `useState` so an ancestor unmount can no longer silently destroy it (#3840).
 *
 * #3600 pinned the closer: `open` lived in the CTA's local `useState`, so any unmount of an
 * ancestor — `FateProvider`'s `key={userId}` re-key or `LayoutContent`'s `needsBootstrap`
 * Outlet swap — reset it to `false`, reproducing the CI artifact (dialog gone, no backdrop,
 * page un-`aria-hidden`, no error, still on `/sozluk`). Crucially NO `onOpenChange` reason
 * fires on that path — the state is destroyed by React unmounting the CTA, not dismissed via
 * `outside-press`/`escape` — which is how the closer is named: an absent dismiss reason ⇒
 * ancestor unmount (base-ui 1.4.1's `outsidePress` only fires on a real backdrop-targeted
 * pointer event, which the trigger-only open cannot produce).
 *
 * The fix owns the open-state in a provider mounted ABOVE that unmounting boundary (the
 * `App.tsx` shell frame, above `FateProvider`) and lets the CTA read it through context — the
 * same bridge shape `SetTopbarChipsContext` already uses to carry state across the session
 * gate. A remount of the CTA subtree re-reads a surviving `open`, so the dialog re-appears
 * instead of vanishing.
 */
type SozlukCreateDialogState = {
	open: boolean;
	setOpen: (open: boolean) => void;
};

const SozlukCreateDialogContext = React.createContext<SozlukCreateDialogState | null>(null);

export function SozlukCreateDialogProvider({children}: {children: React.ReactNode}) {
	const [open, setOpen] = React.useState(false);
	const value = React.useMemo(() => ({open, setOpen}), [open]);
	return (
		<SozlukCreateDialogContext.Provider value={value}>
			{children}
		</SozlukCreateDialogContext.Provider>
	);
}

/**
 * Read the hoisted create-dialog open-state. Falls back to a component-local `useState` when
 * rendered with no provider (isolated tests, an atölye exhibit) so the CTA stays
 * self-contained; the fallback pair is inert whenever the provider is present, which in the
 * real app it always is (mounted above the unmounting boundary in `App.tsx`).
 */
export function useSozlukCreateDialog(): SozlukCreateDialogState {
	const hoisted = React.useContext(SozlukCreateDialogContext);
	const [open, setOpen] = React.useState(false);
	return hoisted ?? {open, setOpen};
}
