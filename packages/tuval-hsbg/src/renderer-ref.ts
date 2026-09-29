/**
 * Hearthstone Battlegrounds Spectator & Jev Advisor program constants and renderer references.
 */

export interface RendererRef {
	readonly kind: "module";
	readonly ref: string;
}

export const HSBG_SPECTATOR_PROGRAM = "hsbg-spectator";

export const HSBG_SPECTATOR_WINDOW_REF: RendererRef = {
	kind: "module",
	ref: "@kampus/tuval-hsbg/window",
};
