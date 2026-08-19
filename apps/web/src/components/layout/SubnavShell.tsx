import type * as React from "react";
import {Subnav} from "./Subnav";

// One ReactNode prop per zone, and `utility` is deliberately omitted — adding it back is a law
// change, not a gap to fill. See ADR 0182.
export type SubnavShellProps = {
	leading?: React.ReactNode;
	destinations?: React.ReactNode;
	primaryAction?: React.ReactNode;
	signal?: React.ReactNode;
};

export function SubnavShell({leading, destinations, primaryAction, signal}: SubnavShellProps) {
	return <Subnav leading={leading} destinations={destinations} cta={primaryAction} meta={signal} />;
}
