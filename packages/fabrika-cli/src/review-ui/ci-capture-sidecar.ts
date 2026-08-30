/** Trusted capture entrypoint sharing the PR server's Docker `none` network namespace. */
import {readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Effect} from "effect";
import {captureLocalhost} from "./ci-produce-verb.ts";
import {LOCALHOST_DECLARATIONS_PATH, parseLocalhostDeclarations} from "./localhost-evidence.ts";

const [port, outputDir, harnessId] = process.argv.slice(2);
if (port === undefined || outputDir === undefined || harnessId === undefined) {
	throw new Error("ci capture sidecar requires port, output, and harness");
}
const declarations = parseLocalhostDeclarations(
	await readFile(LOCALHOST_DECLARATIONS_PATH, "utf8"),
);
if (declarations._tag === "Malformed") {
	throw new Error(`localhost declaration is malformed: ${declarations.reason}`);
}
const harness = declarations.value.harnesses.find((candidate) => candidate.id === harnessId);
if (harness === undefined) {
	throw new Error(`localhost declaration has no ${harnessId} harness`);
}
const captures = await Effect.runPromise(
	captureLocalhost(
		`http://127.0.0.1:${port}`,
		outputDir,
		harness.captureReadySelector,
		harness.surfaces,
	),
);
await writeFile(
	join(outputDir, "capture-result.json"),
	JSON.stringify(captures.map(({pngBytes: _, localPath: __, ...capture}) => capture)),
);
