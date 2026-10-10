import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {Accent} from "../Accent.tsx";
import {SAFE, SAFE_WIDTH} from "../frame.ts";
import {useLook} from "../looks/look.ts";

export const Outro = ({text, cta}: {readonly text: string; readonly cta: string}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const {glow, display} = useLook();
	const rise = spring({frame, fps, config: {damping: 16}});
	const chip = spring({frame: frame - 12, fps, config: {damping: 11}});
	return (
		<div style={{position: "absolute", top: SAFE.top + 240, left: SAFE.left, width: SAFE_WIDTH}}>
			<div
				style={{
					font: `${display.weight} ${Math.round(92 * display.scale)}px/1.05 var(--font-body)`,
					letterSpacing: display.tracking,
					color: "var(--text-primary)",
					opacity: rise,
					transform: `translateY(${(1 - rise) * 40}px)`,
				}}
			>
				<Accent text={text} from={4} />
			</div>
			<div
				style={{
					display: "inline-block",
					marginTop: 70,
					padding: "22px 36px",
					borderRadius: 999,
					background: "var(--accent)",
					color: "var(--accent-fg)",
					font: "700 40px/1 var(--font-body)",
					boxShadow: glow(20),
					transform: `scale(${chip})`,
				}}
			>
				{cta}
			</div>
			<div
				style={{
					marginTop: 44,
					font: "500 32px/1 var(--font-mono)",
					color: "var(--text-muted)",
					opacity: interpolate(frame, [20, 30], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
					}),
				}}
			>
				github.com/kamp-us/phoenix
			</div>
		</div>
	);
};
