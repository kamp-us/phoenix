import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {Accent} from "../Accent.tsx";
import {SAFE, SAFE_WIDTH} from "../frame.ts";
import {useLook} from "../looks/look.ts";

const Label = ({text, color}: {readonly text: string; readonly color: string}) => (
	<div
		style={{
			font: "600 30px/1 var(--font-mono)",
			color,
			letterSpacing: "0.14em",
			textTransform: "uppercase",
			marginBottom: 22,
		}}
	>
		{text}
	</div>
);

/** The old way struck through, then the way this product does it. `afterAt` is in seconds. */
export const Versus = ({
	before,
	after,
	afterAt,
}: {
	readonly before: string;
	readonly after: string;
	readonly afterAt: number;
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const {display} = useLook();
	const strike = interpolate(frame, [afterAt * fps - 14, afterAt * fps - 2], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	const arrive = spring({frame: frame - Math.round(afterAt * fps), fps, config: {damping: 14}});
	return (
		<div style={{position: "absolute", top: SAFE.top + 140, left: SAFE.left, width: SAFE_WIDTH}}>
			<Label text="the usual" color="var(--text-muted)" />
			<div
				style={{
					font: "600 62px/1.15 var(--font-body)",
					color: strike > 0.5 ? "var(--text-muted)" : "var(--text-secondary)",
					opacity: interpolate(frame, [0, 8], [0, 1], {extrapolateRight: "clamp"}),
				}}
			>
				<span
					style={{
						backgroundImage: "linear-gradient(var(--danger), var(--danger))",
						backgroundRepeat: "no-repeat",
						backgroundPosition: "0 58%",
						backgroundSize: `${strike * 100}% 7px`,
						boxDecorationBreak: "clone",
						WebkitBoxDecorationBreak: "clone",
					}}
				>
					{before}
				</span>
			</div>
			<div
				style={{marginTop: 110, opacity: arrive, transform: `translateY(${(1 - arrive) * 60}px)`}}
			>
				<Label text="what we do" color="var(--accent)" />
				<div
					style={{
						font: `${display.weight} ${Math.round(80 * display.scale)}px/1.08 var(--font-body)`,
						letterSpacing: display.tracking,
						color: "var(--text-primary)",
					}}
				>
					<Accent text={after} from={Math.round(afterAt * fps)} />
				</div>
			</div>
		</div>
	);
};
