import {type CSSProperties, createContext, type ReactNode, useContext} from "react";

/**
 * An art direction: everything a reel's picture takes from its look rather than its script.
 * Scenes stay look-blind; they read surfaces, glow and accent treatment from here.
 */
export interface Look {
	/** The theme the frame and its text paint in. */
	readonly theme: "dark" | "light";
	/** The theme a terminal or desk window paints in, which may differ from the frame's. */
	readonly windowTheme: "dark" | "light";
	readonly glow: (strength: number) => string | undefined;
	readonly Backdrop: (props: {readonly seed: string}) => ReactNode;
	readonly Overlay: () => ReactNode;
	/** Wraps one scene: its field, and the cut that brings it in. */
	readonly Scene: (props: {readonly index: number; readonly children: ReactNode}) => ReactNode;
	/** How an `*accent*` span is painted; `from` is the scene frame it arrives on. */
	readonly AccentSpan: (props: {readonly children: ReactNode; readonly from: number}) => ReactNode;
	readonly window: CSSProperties;
	readonly display: {readonly weight: number; readonly tracking: string; readonly scale: number};
}

export const LookContext = createContext<Look | null>(null);

export const useLook = (): Look => {
	const look = useContext(LookContext);
	if (look === null) throw new Error("a scene rendered outside a LookContext");
	return look;
};
