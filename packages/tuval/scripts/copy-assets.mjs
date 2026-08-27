import {cp, mkdir} from "node:fs/promises";

await mkdir(new URL("../dist/frontend-shell/", import.meta.url), {recursive: true});
await cp(
	new URL("../frontend-shell/index.html", import.meta.url),
	new URL("../dist/frontend-shell/index.html", import.meta.url),
);
