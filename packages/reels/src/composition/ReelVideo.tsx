import {useEffect, useState} from "react";
import {
	AbsoluteFill,
	continueRender,
	delayRender,
	Html5Audio,
	interpolate,
	Sequence,
	staticFile,
	useCurrentFrame,
} from "remotion";
import type {Reel, Scene} from "../reel.ts";
import {planTimeline, sceneBeats} from "../timeline.ts";
import {Backdrop, Screen} from "./Backdrop.tsx";
import {SAFE, WIDTH} from "./frame.ts";
import {Desk} from "./scenes/Desk.tsx";
import {Hook} from "./scenes/Hook.tsx";
import {Outro} from "./scenes/Outro.tsx";
import {Pipeline} from "./scenes/Pipeline.tsx";
import {Stat} from "./scenes/Stat.tsx";
import {Terminal} from "./scenes/Terminal.tsx";
import {Versus} from "./scenes/Versus.tsx";

export interface ReelProps extends Record<string, unknown> {
	readonly reel: Reel;
	/** The soundtrack's path under the bundle's public dir; absent renders silent. */
	readonly soundtrack?: string;
}

const FACES = [
	'700 100px "IBM Plex Sans"',
	'600 100px "IBM Plex Sans"',
	'500 30px "JetBrains Mono"',
	'700 30px "JetBrains Mono"',
];

const SceneBody = ({scene}: {readonly scene: Scene}) => {
	switch (scene._tag) {
		case "hook":
			return (
				<Hook text={scene.text} {...(scene.kicker === undefined ? {} : {kicker: scene.kicker})} />
			);
		case "terminal":
			return <Terminal {...scene} />;
		case "pipeline":
			return <Pipeline {...scene} />;
		case "versus":
			return (
				<Versus before={scene.before} after={scene.after} afterAt={sceneBeats(scene)[1] ?? 1} />
			);
		case "stat":
			return <Stat {...scene} />;
		case "desk":
			return <Desk {...scene} />;
		case "outro":
			return <Outro text={scene.text} cta={scene.cta} />;
	}
};

/** Each cut lands with a short glitch: a sideways jolt and an accent ghost behind the content. */
const Cut = ({children}: {readonly children: React.ReactNode}) => {
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

const Chrome = ({reel, total}: {readonly reel: Reel; readonly total: number}) => {
	const frame = useCurrentFrame();
	return (
		<>
			<div
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					height: 10,
					width: WIDTH * (frame / total),
					background: "var(--accent)",
					boxShadow: "0 0 18px var(--accent)",
				}}
			/>
			<div
				style={{
					position: "absolute",
					left: SAFE.left,
					top: SAFE.top - 92,
					font: "600 32px/1 var(--font-mono)",
					color: "var(--text-secondary)",
					display: "flex",
					gap: 14,
					alignItems: "center",
				}}
			>
				<span style={{color: "var(--accent)"}}>◆</span>
				<span>{reel.brand}</span>
				<span style={{color: "var(--text-faint)"}}>· kamp.us</span>
			</div>
		</>
	);
};

export const ReelVideo = ({reel, soundtrack}: ReelProps) => {
	const [fonts] = useState(() => delayRender("brand faces"));
	useEffect(() => {
		Promise.all(FACES.map((face) => document.fonts.load(face))).then(
			() => continueRender(fonts),
			() => continueRender(fonts),
		);
	}, [fonts]);
	const timeline = planTimeline(reel);

	return (
		<AbsoluteFill
			data-theme="dark"
			style={{fontFamily: "var(--font-body)", color: "var(--text-primary)"}}
		>
			<Backdrop seed={reel.id} />
			{timeline.scenes.map((window) => {
				const scene = reel.scenes[window.index];
				return scene === undefined ? null : (
					<Sequence
						key={window.index}
						from={window.startFrame}
						durationInFrames={window.frames}
						name={scene._tag}
					>
						<Cut>
							<SceneBody scene={scene} />
						</Cut>
					</Sequence>
				);
			})}
			<Chrome reel={reel} total={timeline.totalFrames} />
			<Screen />
			{soundtrack === undefined ? null : <Html5Audio src={staticFile(soundtrack)} />}
		</AbsoluteFill>
	);
};
