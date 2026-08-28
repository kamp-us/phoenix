import {mkdir, readFile, writeFile} from "node:fs/promises";

const source = new URL("../src/frontend-shell/", import.meta.url);
const output = new URL("../dist/frontend-shell/", import.meta.url);

await mkdir(output, {recursive: true});
const [template, styles, compiledApp] = await Promise.all([
	readFile(new URL("index.html", source), "utf8"),
	readFile(new URL("styles.css", source), "utf8"),
	readFile(new URL("app.js", output), "utf8"),
]);
const styleMarker = "/* TUVAL_STYLES */";
const appMarker = "/* TUVAL_APP */";
if (!template.includes(styleMarker) || !template.includes(appMarker)) {
	throw new Error("Tuval static template is missing its style or application marker");
}
const app = compiledApp.replace(/^\/\/# sourceMappingURL=.*$/mu, "");
const html = template.replace(styleMarker, styles).replace(appMarker, app);
await writeFile(new URL("index.html", output), html);
