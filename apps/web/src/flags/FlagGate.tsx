/**
 * `FlagGate` — the SPA mirror of the server's branch-on-a-flag dark-ship primitive (#488).
 * It inherits `useFlag`'s safe-default contract wholesale: loading, fetch error, and undeclared
 * flag all hold `value` at `false`, so a Flagship outage never exposes the gated path.
 */
import type {ReactNode} from "react";
import {useFlag} from "./useFlag";

export interface FlagGateProps {
	readonly flag: string;
	/** The off/old/safe path shown until the flag evaluates on. */
	readonly fallback?: ReactNode;
	readonly children: ReactNode;
}

/** Factored out so the gating contract is unit-testable without a DOM. */
export function flagGateChild(value: boolean, children: ReactNode, fallback: ReactNode): ReactNode {
	return value ? children : fallback;
}

export function FlagGate({flag, fallback = null, children}: FlagGateProps) {
	// Default `false`: the gated path stays dark until the server evaluates the
	// flag on for this user — and through every failure mode (loading, error,
	// undeclared flag), since each resolves to this default.
	const {value} = useFlag(flag, false);
	return <>{flagGateChild(value, children, fallback)}</>;
}
