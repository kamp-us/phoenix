import {describe, expect, it} from "vitest";
import {describeFile} from "./file.ts";

describe("describeFile", () => {
	it("names the layer and the path inside that layer's directory", () => {
		expect(
			describeFile({
				layer: "global",
				path: "/home/someone/.tuval/tuval.config.ts",
				base: "/home/someone",
			}),
		).toBe("global .tuval/tuval.config.ts");
	});

	it("names the project layer the same way", () => {
		expect(
			describeFile({
				layer: "project",
				path: "/home/someone/code/demo/.tuval/tuval.config.ts",
				base: "/home/someone/code/demo",
			}),
		).toBe("project .tuval/tuval.config.ts");
	});

	it("falls back to the bare file name when the module sits outside its own base", () => {
		expect(
			describeFile({layer: "global", path: "/etc/tuval/tuval.config.ts", base: "/home/someone"}),
		).toBe("global tuval.config.ts");
	});
});
