/**
 * Where `@kampus/tuval-ui`'s source sits on disk, for the tests here that read its stylesheets and
 * modules as text rather than import them. Found through the package's own `package.json` export,
 * so it follows the package wherever the workspace links it and never hard-codes a path into
 * `packages/`.
 */

import {createRequire} from "node:module";
import {dirname, join} from "node:path";

/** The package's `src/` directory. */
export const uiSrc = join(
	dirname(createRequire(import.meta.url).resolve("@kampus/tuval-ui/package.json")),
	"src",
);

/** The chat window's stylesheet. */
export const chatSheetPath = join(uiSrc, "shell", "chat", "chat.css");
