import {fileURLToPath} from "node:url";
import {DefaultPackageManager, SettingsManager} from "@earendil-works/pi-coding-agent";
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Effect} from "effect";
import {startTuval} from "../../dist/backend/server.js";

const port = Number(process.argv[2] ?? "0");
const packages = process.argv.slice(3).map((path) => fileURLToPath(new URL(path, import.meta.url)));
const root = fileURLToPath(new URL("../fixtures", import.meta.url));
const settingsManager = SettingsManager.inMemory({packages}, {projectTrusted: true});
const packageManager = new DefaultPackageManager({cwd: root, agentDir: root, settingsManager});
NodeRuntime.runMain(
	Effect.scoped(
		Effect.gen(function* () {
			yield* startTuval({
				port,
				...(process.env.TUVAL_SESSION_ROOT === undefined
					? {}
					: {sessionRoots: [process.env.TUVAL_SESSION_ROOT]}),
				openBrowser: () => Effect.void,
				packageContributions: {cwd: root, agentDir: root, settingsManager, packageManager},
				log: (line) => console.log(line),
			});
			yield* Effect.never;
		}),
	).pipe(Effect.provide(NodeServices.layer)),
);
