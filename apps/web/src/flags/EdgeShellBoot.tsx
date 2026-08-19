/**
 * The boot-mode observer for the edge-resolved shell (ADR 0179). It has no user-facing surface of
 * its own: it reports whether the edge injected `__BOOT__` for this render, as a geometry-inert
 * marker the first-paint e2e can observe.
 */
import type {ReactElement} from "react";
import {readBoot} from "./boot.ts";

/** Absent `__BOOT__` is a first-class state, not an error — see ADR 0179 §4. */
export function useEdgeShellBootActive(): boolean {
	return readBoot() !== undefined;
}

/**
 * A geometry-inert marker exposing the boot mode. `hidden` keeps it out of layout entirely, so it
 * can never contribute the layout shift the vertical exists to eliminate — mounting it in the
 * shell is free of first-paint cost.
 */
export function EdgeShellBootMarker(): ReactElement {
	const active = useEdgeShellBootActive();
	return <div hidden data-testid="edge-shell-boot" data-active={active ? "true" : "false"} />;
}
