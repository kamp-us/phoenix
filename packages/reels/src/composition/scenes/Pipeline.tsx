import {interpolate, spring, useCurrentFrame, useVideoConfig} from "remotion";
import {PIPELINE_STEP} from "../../timeline.ts";
import {Caption} from "../Caption.tsx";
import {glow, SAFE, SAFE_WIDTH} from "../frame.ts";

export const Pipeline = ({
	caption,
	stages,
	stamp,
}: {
	readonly caption?: string;
	readonly stages: ReadonlyArray<{readonly name: string; readonly detail: string}>;
	readonly stamp?: string;
}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const top = SAFE.top + (caption === undefined ? 40 : 230);
	const rowHeight = Math.min(150, 760 / stages.length);
	const lit = (index: number) => frame - Math.round((0.5 + index * PIPELINE_STEP) * fps);
	const stampAt = Math.round((0.6 + stages.length * PIPELINE_STEP) * fps);
	const slam = spring({frame: frame - stampAt, fps, config: {damping: 9, stiffness: 260}});

	return (
		<>
			{caption === undefined ? null : <Caption text={caption} />}
			<div style={{position: "absolute", top, left: SAFE.left, width: SAFE_WIDTH}}>
				{stages.map((stage, index) => {
					const on = lit(index);
					const done = index < stages.length - 1 ? lit(index + 1) >= 0 : frame >= stampAt;
					const reveal = interpolate(on, [0, 8], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
					});
					const trace = interpolate(on, [4, Math.round(PIPELINE_STEP * fps)], [0, 1], {
						extrapolateLeft: "clamp",
						extrapolateRight: "clamp",
					});
					return (
						<div
							key={index}
							style={{position: "relative", height: rowHeight, display: "flex", gap: 36}}
						>
							{index < stages.length - 1 ? (
								<div
									style={{
										position: "absolute",
										left: 27,
										top: 58,
										width: 4,
										height: (rowHeight - 58) * trace,
										background: "var(--accent)",
										boxShadow: glow(12),
									}}
								/>
							) : null}
							<div
								style={{
									flex: "none",
									width: 58,
									height: 58,
									borderRadius: 29,
									border: `4px solid ${on >= 0 ? "var(--accent)" : "var(--border)"}`,
									background: done ? "var(--accent)" : "var(--surface)",
									boxShadow: on >= 0 ? glow(done ? 10 : 22) : undefined,
									display: "grid",
									placeItems: "center",
									font: "700 30px/1 var(--font-mono)",
									color: "var(--accent-fg)",
								}}
							>
								{done ? "✓" : ""}
							</div>
							<div
								style={{
									opacity: 0.25 + reveal * 0.75,
									transform: `translateX(${(1 - reveal) * 30}px)`,
								}}
							>
								<div style={{font: "700 52px/1.05 var(--font-body)", color: "var(--text-primary)"}}>
									{stage.name}
								</div>
								<div
									style={{
										font: "500 28px/1.4 var(--font-mono)",
										color: "var(--text-muted)",
										marginTop: 8,
									}}
								>
									{stage.detail}
								</div>
							</div>
						</div>
					);
				})}
			</div>
			{stamp === undefined || frame < stampAt ? null : (
				<div
					style={{
						position: "absolute",
						top: top + stages.length * rowHeight - 40,
						left: SAFE.left + 300,
						padding: "16px 34px",
						border: "6px solid var(--accent)",
						borderRadius: 12,
						font: "800 72px/1 var(--font-mono)",
						color: "var(--accent)",
						textShadow: glow(16),
						boxShadow: glow(16),
						transform: `rotate(-9deg) scale(${2.4 - slam * 1.4})`,
						opacity: Math.min(1, slam * 2),
						background: "color-mix(in oklab, var(--surface-sunken) 80%, transparent)",
					}}
				>
					{stamp}
				</div>
			)}
		</>
	);
};
