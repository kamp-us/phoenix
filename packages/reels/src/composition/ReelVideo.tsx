import {useEffect, useState} from "react";
import {
	AbsoluteFill,
	continueRender,
	delayRender,
	Html5Audio,
	Sequence,
	staticFile,
	useCurrentFrame,
} from "remotion";
import {DEFAULT_LOOK, type LookName, type Reel, type Scene} from "../reel.ts";
import {planTimeline, sceneBeats} from "../timeline.ts";
import {SAFE, WIDTH} from "./frame.ts";
import {LOOKS} from "./looks/index.ts";
import {LookContext, useLook} from "./looks/look.ts";
import {ThemeScope} from "./looks/ThemeScope.tsx";
import {Desk} from "./scenes/Desk.tsx";
import {Hook} from "./scenes/Hook.tsx";
import {Outro} from "./scenes/Outro.tsx";
import {Pipeline} from "./scenes/Pipeline.tsx";
import {Stat} from "./scenes/Stat.tsx";
import {Terminal} from "./scenes/Terminal.tsx";
import {Versus} from "./scenes/Versus.tsx";

export interface ReelProps extends Record<string, unknown> {
	readonly reel: Reel;
	/** Overrides the look the script names, so one script can be rendered in every look. */
	readonly look?: LookName;
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

/** The progress bar and brand label, drawn inside each scene so they take its field's colours. */
const Chrome = ({
	reel,
	total,
	offset,
}: {
	readonly reel: Reel;
	readonly total: number;
	readonly offset: number;
}) => {
	const frame = useCurrentFrame() + offset;
	const look = useLook();
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
					boxShadow: look.glow(9),
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

export const ReelVideo = ({reel, look: lookName, soundtrack}: ReelProps) => {
	const look = LOOKS[lookName ?? reel.look ?? DEFAULT_LOOK];
	const [fonts] = useState(() => delayRender("brand faces"));
	useEffect(() => {
		Promise.all(FACES.map((face) => document.fonts.load(face))).then(
			() => continueRender(fonts),
			() => continueRender(fonts),
		);
	}, [fonts]);
	const timeline = planTimeline(reel);

	return (
		<LookContext.Provider value={look}>
			<AbsoluteFill style={{fontFamily: "var(--font-body)"}}>
				<ThemeScope theme={look.theme} style={{position: "absolute", inset: 0}}>
					<look.Backdrop seed={reel.id} />
					{timeline.scenes.map((window) => {
						const scene = reel.scenes[window.index];
						return scene === undefined ? null : (
							<Sequence
								key={window.index}
								from={window.startFrame}
								durationInFrames={window.frames}
								name={scene._tag}
							>
								<look.Scene index={window.index}>
									<SceneBody scene={scene} />
									<Chrome reel={reel} total={timeline.totalFrames} offset={window.startFrame} />
								</look.Scene>
							</Sequence>
						);
					})}
					<look.Overlay />
				</ThemeScope>
				{soundtrack === undefined ? null : <Html5Audio src={staticFile(soundtrack)} />}
			</AbsoluteFill>
		</LookContext.Provider>
	);
};
