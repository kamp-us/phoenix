/**
 * `FlagGate` — the demonstrated gated UI path for the flag hook (epic #488,
 * #510). Renders `children` only when the named flag's server-evaluated value is
 * on; otherwise renders `fallback` (default `null`). This is the SPA mirror of
 * the server's branch-on-a-flag dark-ship primitive: a component renders the new
 * path only when the flag says so for this request's user, with the safe/off path
 * showing until/unless the server flips it.
 *
 * The gate inherits the hook's safe-default contract wholesale: while the value
 * is loading, on a fetch error, or for an undeclared flag, `value` stays `false`,
 * so the gate shows the fallback (the off/old/safe UI) — a Flagship outage never
 * exposes the gated path.
 */
import type {ReactNode} from "react";
import {useFlag} from "./useFlag";

export interface FlagGateProps {
	/** The flag key to evaluate server-side. */
	readonly flag: string;
	/** The off/old/safe path shown until the flag evaluates on. Defaults to `null`. */
	readonly fallback?: ReactNode;
	/** The gated UI, rendered only when the flag is on for this request. */
	readonly children: ReactNode;
}

export function FlagGate({flag, fallback = null, children}: FlagGateProps) {
	// Default `false`: the gated path stays dark until the server evaluates the
	// flag on for this user — and through every failure mode (loading, error,
	// undeclared flag), since each resolves to this default.
	const {value} = useFlag(flag, false);
	return <>{value ? children : fallback}</>;
}
