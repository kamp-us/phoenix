import type {CSSProperties} from "react";
import {AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig} from "remotion";
import {WIDTH} from "../frame.ts";
import type {Look} from "./look.ts";
import {ThemeScope} from "./ThemeScope.tsx";

/**
 * The fields scenes cycle through. `--field` names the ground so an accent block can knock its
 * text out to it. On the coral field the roles invert: ink text, and ink where the accent was.
 */
const FIELDS: ReadonlyArray<{readonly theme: "dark" | "light"; readonly style: CSSProperties}> = [
	{
		theme: "dark",
		style: {
			"--field": "var(--accent-9)",
			"--text-primary": "var(--mauve-1)",
			"--text-secondary": "color-mix(in oklab, var(--mauve-1) 88%, var(--accent-9))",
			"--text-muted": "color-mix(in oklab, var(--mauve-1) 74%, var(--accent-9))",
			"--text-faint": "color-mix(in oklab, var(--mauve-1) 55%, var(--accent-9))",
			"--border": "var(--mauve-1)",
			"--accent": "var(--mauve-1)",
			"--accent-fg": "var(--accent-9)",
		} as CSSProperties,
	},
	{theme: "dark", style: {"--field": "var(--gray-1)"} as CSSProperties},
	{theme: "light", style: {"--field": "var(--gray-1)"} as CSSProperties},
];

/** One huge circle per scene, drifting across the field: the Swiss-poster counterweight to the type. */
const Disc = ({index}: {readonly index: number}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const size = 1100 + random(`disc-${index}`) * 500;
	const x = -300 + random(`disc-x-${index}`) * (WIDTH - 200);
	const y = 900 + random(`disc-y-${index}`) * 600;
	const drift = (frame / fps) * 26;
	return (
		<div
			style={{
				position: "absolute",
				left: x - drift,
				top: y - drift * 0.5,
				width: size,
				height: size,
				borderRadius: "50%",
				background: "color-mix(in oklab, var(--field) 82%, var(--text-primary))",
			}}
		/>
	);
};

/** A hard wipe: the new field cuts in from the left edge in a handful of frames. */
const Scene: Look["Scene"] = ({index, children}) => {
	const frame = useCurrentFrame();
	const field = FIELDS[index % FIELDS.length] ?? FIELDS[0];
	const wipe = interpolate(frame, [0, 6], [100, 0], {
		extrapolateRight: "clamp",
		easing: (t) => 1 - (1 - t) ** 4,
	});
	const settle = interpolate(frame, [3, 12], [60, 0], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	return (
		<AbsoluteFill style={{clipPath: `inset(0 ${wipe}% 0 0)`}}>
			<ThemeScope
				theme={field?.theme ?? "dark"}
				style={{...field?.style, position: "absolute", inset: 0}}
			>
				<AbsoluteFill style={{background: "var(--field)", overflow: "hidden"}}>
					<Disc index={index} />
					<div
						style={{
							position: "absolute",
							left: 0,
							bottom: 470,
							width: WIDTH,
							height: 14,
							background: "var(--text-primary)",
						}}
					/>
				</AbsoluteFill>
				<AbsoluteFill style={{transform: `translateX(${settle}px)`}}>{children}</AbsoluteFill>
			</ThemeScope>
		</AbsoluteFill>
	);
};

/** The accent knocks out of a solid block in the accent color, drawn left to right. */
const AccentSpan: Look["AccentSpan"] = ({children, from}) => {
	const frame = useCurrentFrame();
	const fill = interpolate(frame, [from + 1, from + 7], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	return (
		<span
			style={{
				backgroundImage: "linear-gradient(var(--accent), var(--accent))",
				backgroundRepeat: "no-repeat",
				backgroundPosition: "0 80%",
				backgroundSize: `${fill * 100}% 84%`,
				color: fill > 0.5 ? "var(--field)" : undefined,
				boxDecorationBreak: "clone",
				WebkitBoxDecorationBreak: "clone",
				padding: "0 0.1em",
			}}
		>
			{children}
		</span>
	);
};

/** Flat Swiss poster: colour fields, huge type, hard cuts, no texture and no glow. */
export const poster: Look = {
	theme: "dark",
	windowTheme: "dark",
	glow: () => undefined,
	Backdrop: () => <AbsoluteFill style={{background: "var(--surface-sunken)"}} />,
	Overlay: () => null,
	Scene,
	AccentSpan,
	window: {borderRadius: 0, border: "6px solid var(--text-primary)"},
	display: {weight: 700, tracking: "-0.055em", scale: 1.28},
};
