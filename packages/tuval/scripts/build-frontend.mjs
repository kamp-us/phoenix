import {mkdir, readFile, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "vite";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = await build({
	root: packageRoot,
	configFile: false,
	logLevel: "error",
	build: {
		write: false,
		cssCodeSplit: false,
		rollupOptions: {
			input: resolve(packageRoot, "src/frontend-shell/app.tsx"),
			output: {codeSplitting: false},
		},
	},
});
if (Array.isArray(output)) throw new Error("Tuval frontend produced more than one build output");
const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
const stylesheet = output.output.find(
	(item) => item.type === "asset" && item.fileName.endsWith(".css"),
);
if (entry?.type !== "chunk" || stylesheet?.type !== "asset") {
	throw new Error("Tuval frontend build did not produce one script and stylesheet");
}
const template = await readFile(resolve(packageRoot, "src/frontend-shell/index.html"), "utf8");
const styleMarker = "/* TUVAL_STYLES */";
const appMarker = "/* TUVAL_APP */";
if (!template.includes(styleMarker) || !template.includes(appMarker)) {
	throw new Error("Tuval static template is missing its style or application marker");
}
const styles = String(stylesheet.source).replaceAll("</style", "<\\/style");
const app = entry.code.replaceAll("</script", "<\\/script");
const html = template.replace(styleMarker, () => styles).replace(appMarker, () => app);
const target = resolve(packageRoot, "dist/frontend-shell/index.html");
await mkdir(dirname(target), {recursive: true});
await writeFile(target, html);
