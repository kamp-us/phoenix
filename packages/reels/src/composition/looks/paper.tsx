import {AbsoluteFill, interpolate, useCurrentFrame} from "remotion";
import {HEIGHT, SAFE} from "../frame.ts";
import type {Look} from "./look.ts";

const INK = "var(--text-primary)";

/** Grain from an SVG turbulence tile, so the paper reads as paper and not as a flat fill. */
const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.09 0"/></filter><rect width="240" height="240" filter="url(#n)"/></svg>',
)}")`;

/** A notebook page: warm paper, a dot grid, and a coral margin rule. */
const Backdrop: Look["Backdrop"] = () => (
	<AbsoluteFill
		style={{
			background: "color-mix(in oklab, var(--surface-sunken) 94%, var(--warning) 6%)",
		}}
	>
		<AbsoluteFill
			style={{
				backgroundImage: "radial-gradient(circle, var(--border) 1.8px, transparent 2.2px)",
				backgroundSize: "40px 40px",
				backgroundPosition: "20px 20px",
				opacity: 0.7,
			}}
		/>
		<div
			style={{
				position: "absolute",
				left: SAFE.left - 30,
				top: 0,
				width: 3,
				height: HEIGHT,
				background: "color-mix(in oklab, var(--accent) 55%, transparent)",
			}}
		/>
		<AbsoluteFill style={{backgroundImage: GRAIN}} />
	</AbsoluteFill>
);

/** A new sheet slides up over the page, with its page number in the corner. */
const Scene: Look["Scene"] = ({index, children}) => {
	const frame = useCurrentFrame();
	const lift = interpolate(frame, [0, 9], [140, 0], {
		extrapolateRight: "clamp",
		easing: (t) => 1 - (1 - t) ** 3,
	});
	const appear = interpolate(frame, [0, 5], [0, 1], {extrapolateRight: "clamp"});
	return (
		<AbsoluteFill style={{transform: `translateY(${lift}px)`, opacity: appear}}>
			<div
				style={{
					position: "absolute",
					right: SAFE.right - 40,
					top: SAFE.top - 100,
					font: "600 30px/1 var(--font-mono)",
					color: "var(--text-muted)",
					letterSpacing: "0.08em",
				}}
			>
				{String(index + 1).padStart(2, "0")}
			</div>
			{children}
		</AbsoluteFill>
	);
};

/** A highlighter swipe across the lower half of the words, drawn left to right. */
const AccentSpan: Look["AccentSpan"] = ({children, from}) => {
	const frame = useCurrentFrame();
	const swipe = interpolate(frame, [from + 2, from + 10], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	return (
		<span
			style={{
				backgroundImage:
					"linear-gradient(transparent 50%, color-mix(in oklab, var(--accent) 55%, transparent) 50%, color-mix(in oklab, var(--accent) 55%, transparent) 92%, transparent 92%)",
				backgroundRepeat: "no-repeat",
				backgroundSize: `${swipe * 100}% 100%`,
				boxDecorationBreak: "clone",
				WebkitBoxDecorationBreak: "clone",
				padding: "0 0.06em",
			}}
		>
			{children}
		</span>
	);
};

/** Editorial print: ink on warm paper, dark windows pasted on with a hard offset shadow. */
export const paper: Look = {
	theme: "light",
	windowTheme: "dark",
	glow: () => undefined,
	Backdrop,
	Overlay: () => null,
	Scene,
	AccentSpan,
	window: {
		borderRadius: 6,
		border: `3px solid ${INK}`,
		boxShadow: `14px 14px 0 ${INK}`,
		transform: "rotate(-0.8deg)",
	},
	display: {weight: 700, tracking: "-0.045em", scale: 1.06},
};
