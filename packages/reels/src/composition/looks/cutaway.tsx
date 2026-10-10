import {AbsoluteFill, interpolate, useCurrentFrame} from "remotion";
import {Backdrop, Screen} from "../Backdrop.tsx";
import type {Look} from "./look.ts";

const glow = (strength: number): string =>
	`0 0 ${strength}px color-mix(in oklab, var(--accent) 70%, transparent), 0 0 ${strength * 3}px color-mix(in oklab, var(--accent) 35%, transparent)`;

/** Each cut lands with a short glitch: a sideways jolt and an accent ghost behind the content. */
const Scene: Look["Scene"] = ({children}) => {
	const frame = useCurrentFrame();
	const jolt = interpolate(frame, [0, 2, 4, 6], [18, -10, 4, 0], {extrapolateRight: "clamp"});
	const ghost = interpolate(frame, [0, 6], [0.6, 0], {extrapolateRight: "clamp"});
	return (
		<AbsoluteFill style={{transform: `translateX(${jolt}px)`}}>
			<AbsoluteFill
				style={{
					opacity: ghost,
					transform: "translate(8px, 0)",
					filter: "blur(1px) sepia(1) saturate(6) hue-rotate(-30deg)",
				}}
			>
				{children}
			</AbsoluteFill>
			<AbsoluteFill>{children}</AbsoluteFill>
		</AbsoluteFill>
	);
};

/** The brand-imagery cutaway: a phosphor CRT, the scene above ground, coral roots below. */
export const cutaway: Look = {
	theme: "dark",
	windowTheme: "dark",
	glow,
	Backdrop,
	Overlay: Screen,
	Scene,
	AccentSpan: ({children}) => (
		<span style={{color: "var(--accent)", textShadow: glow(18)}}>{children}</span>
	),
	window: {
		borderRadius: 16,
		border: "2px solid var(--border)",
		boxShadow: "var(--shadow-overlay)",
	},
	display: {weight: 700, tracking: "-0.035em", scale: 1},
};
