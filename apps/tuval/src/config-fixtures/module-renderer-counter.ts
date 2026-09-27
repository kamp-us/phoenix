/**
 * `one-counter`'s row with a `kind: "module"` renderer naming `@tuval-fixture/win/window`. A project
 * config re-exporting this is the module that declared the row, so the specifier resolves from that
 * project's `.tuval` — where the test installs the package.
 */
import oneCounter from "./one-counter.ts";

export default {
	version: 1,
	programs: oneCounter.programs.map((row) => ({
		...row,
		renderer: {kind: "module", ref: "@tuval-fixture/win/window"},
	})),
};
