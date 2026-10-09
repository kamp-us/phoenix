import * as Schema from "effect/Schema";
import {Composition} from "remotion";
import {Reel} from "../reel.ts";
import {soundtrackFile} from "../soundtrack-file.ts";
import {FPS, planTimeline} from "../timeline.ts";
import {HEIGHT, WIDTH} from "./frame.ts";
import {ReelVideo} from "./ReelVideo.tsx";

interface WebpackContext {
	(key: string): unknown;
	keys(): ReadonlyArray<string>;
}

declare global {
	namespace NodeJS {
		interface Require {
			/** Webpack's static directory import; Remotion bundles this file with webpack. */
			context(directory: string, recursive: boolean, match: RegExp): WebpackContext;
		}
	}
}

/** Every reel script under `content/`, decoded the same way the CLI decodes them. */
const decodeReelSync = Schema.decodeUnknownSync(Reel);
const content = require.context("../../content", false, /\.json$/);
const reels = content
	.keys()
	.filter((key) => key.startsWith("./"))
	.map((key) => decodeReelSync(content(key)));

export const Root = () => (
	<>
		{reels.map((reel) => (
			<Composition
				key={reel.id}
				id={reel.id}
				component={ReelVideo}
				width={WIDTH}
				height={HEIGHT}
				fps={FPS}
				durationInFrames={planTimeline(reel).totalFrames}
				defaultProps={{reel, soundtrack: soundtrackFile(reel.id)}}
				calculateMetadata={({props}) => ({durationInFrames: planTimeline(props.reel).totalFrames})}
			/>
		))}
	</>
);
