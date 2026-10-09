import {useMemo} from "react";
import {AbsoluteFill, random, useCurrentFrame, useVideoConfig} from "remotion";
import {HEIGHT, WIDTH} from "./frame.ts";

const CELL_W = 18;
const CELL_H = 30;
const GROUND = 1240;
const COLS = Math.ceil(WIDTH / CELL_W);
const ROWS = Math.ceil((HEIGHT - GROUND) / CELL_H);
const RAMP = " .·:;+=*#%@";

interface Cell {
	readonly distance: number;
	readonly along: number;
}

/** A root system: polylines branching down from one point, grown from a seed. */
const grow = (seed: string): ReadonlyArray<ReadonlyArray<readonly [number, number]>> => {
	const roots: Array<Array<readonly [number, number]>> = [];
	const branch = (
		x: number,
		y: number,
		angle: number,
		length: number,
		depth: number,
		key: string,
	) => {
		const path: Array<readonly [number, number]> = [[x, y]];
		let cx = x;
		let cy = y;
		let heading = angle;
		for (let step = 0; step < length; step++) {
			heading += (random(`${key}-${step}`) - 0.5) * 0.5;
			cx += Math.cos(heading) * 40;
			cy += Math.sin(heading) * 40;
			path.push([cx, cy]);
			if (depth < 3 && random(`${key}-split-${step}`) < 0.1) {
				branch(
					cx,
					cy,
					heading + (random(`${key}-dir-${step}`) < 0.5 ? -0.7 : 0.7),
					length - step,
					depth + 1,
					`${key}-${step}`,
				);
			}
		}
		roots.push(path);
	};
	for (let index = 0; index < 5; index++) {
		branch(WIDTH / 2, GROUND, Math.PI / 2 + (index - 2) * 0.42, 22, 0, `${seed}-${index}`);
	}
	return roots;
};

const nearest = (roots: ReturnType<typeof grow>, px: number, py: number): Cell => {
	let best = Number.POSITIVE_INFINITY;
	let along = 0;
	for (const path of roots) {
		let walked = 0;
		for (let i = 1; i < path.length; i++) {
			const [ax, ay] = path[i - 1] ?? [0, 0];
			const [bx, by] = path[i] ?? [0, 0];
			const dx = bx - ax;
			const dy = by - ay;
			const span = Math.hypot(dx, dy);
			const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (span * span)));
			const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			if (distance < best) {
				best = distance;
				along = walked + t * span;
			}
			walked += span;
		}
	}
	return {distance: best, along};
};

/** The brand's cutaway: content stands above ground, glowing roots run below it. */
export const Backdrop = ({seed}: {readonly seed: string}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const cells = useMemo(() => {
		const roots = grow(seed);
		return Array.from({length: ROWS}, (_, row) =>
			Array.from({length: COLS}, (_, col) =>
				nearest(roots, col * CELL_W + CELL_W / 2, GROUND + row * CELL_H + CELL_H / 2),
			),
		);
	}, [seed]);

	const time = frame / fps;
	const bands = [0, 1, 2].map((band) =>
		cells
			.map((row, rowIndex) =>
				row
					.map((cell, colIndex) => {
						const pulse = 0.55 + 0.45 * Math.sin(cell.along / 90 - time * 3.2);
						const shimmer =
							random(`${seed}-${rowIndex}-${colIndex}-${Math.floor(frame / 4)}`) * 0.1;
						const level =
							Math.exp(-(cell.distance * cell.distance) / 380) * pulse +
							shimmer * Math.exp(-cell.distance / 50);
						const index = Math.min(RAMP.length - 1, Math.floor(level * RAMP.length));
						const cellBand = level > 0.62 ? 2 : level > 0.3 ? 1 : 0;
						return cellBand === band ? (RAMP[index] ?? " ") : " ";
					})
					.join(""),
			)
			.join("\n"),
	);

	const bandStyle = [
		{color: "color-mix(in oklab, var(--accent) 30%, transparent)", textShadow: "none"},
		{
			color: "color-mix(in oklab, var(--accent) 70%, transparent)",
			textShadow: "0 0 8px color-mix(in oklab, var(--accent) 50%, transparent)",
		},
		{
			color: "var(--accent)",
			textShadow:
				"0 0 14px var(--accent), 0 0 30px color-mix(in oklab, var(--accent) 60%, transparent)",
		},
	];

	return (
		<AbsoluteFill style={{background: "var(--surface-sunken)"}}>
			<AbsoluteFill
				style={{
					background: `radial-gradient(ellipse 70% 30% at 50% ${GROUND + 260}px, color-mix(in oklab, var(--accent) 22%, transparent), transparent 70%)`,
				}}
			/>
			<div
				style={{
					position: "absolute",
					top: GROUND - 2,
					left: 0,
					width: WIDTH,
					height: 2,
					background:
						"linear-gradient(90deg, transparent, var(--border-strong) 20%, var(--border-strong) 80%, transparent)",
				}}
			/>
			{bands.map((text, band) => (
				<pre
					key={band}
					style={{
						position: "absolute",
						top: GROUND,
						left: 0,
						margin: 0,
						font: `500 30px/${CELL_H}px var(--font-mono)`,
						letterSpacing: `${CELL_W - 18}px`,
						width: WIDTH,
						...bandStyle[band],
					}}
				>
					{text}
				</pre>
			))}
		</AbsoluteFill>
	);
};

/** The phosphor screen in front of everything: scanlines, flicker and a vignette. */
export const Screen = () => {
	const frame = useCurrentFrame();
	return (
		<AbsoluteFill style={{pointerEvents: "none"}}>
			<AbsoluteFill
				style={{
					background:
						"repeating-linear-gradient(180deg, transparent 0 3px, rgb(0 0 0 / 0.22) 3px 4px)",
					opacity: 0.85 + random(`flicker-${frame}`) * 0.15,
				}}
			/>
			<AbsoluteFill
				style={{
					background:
						"radial-gradient(ellipse 85% 75% at 50% 45%, transparent 55%, rgb(0 0 0 / 0.55) 100%)",
				}}
			/>
		</AbsoluteFill>
	);
};
