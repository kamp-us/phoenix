import {describe, expect, it} from "vitest";
import type {UiSurface} from "../config/keys/ui-surfaces.ts";
import {appForSurface, surfacePath, surfaceSlug, surfaceUrl} from "./surfaces.ts";

const app = (overrides: Partial<UiSurface>): UiSurface => ({
	name: "x",
	prefix: "src/",
	command: "x {{port}}",
	mount: "/",
	basePath: null,
	readyPath: "/",
	...overrides,
});

describe("appForSurface", () => {
	const multi = [
		app({name: "web", mount: "/"}),
		app({name: "desk-chat", mount: "/desk/chat", basePath: "/"}),
		app({name: "web-lab", mount: "/lab"}),
	];
	const named = (surface: string) => appForSurface(multi, surface)?.name ?? null;

	it.each([
		["/", "web"],
		["/pano", "web"],
		["/labs/x", "web"],
		["/lab", "web-lab"],
		["/lab/atolye/agent-chat-input", "web-lab"],
		["/desk/chat", "desk-chat"],
		["/desk/chat/deep", "desk-chat"],
		["/desk", "web"],
	])("resolves %s to the app with the longest claiming mount (%s)", (surface, name) => {
		expect(named(surface)).toBe(name);
	});

	it("answers null when no mount claims the surface", () => {
		expect(appForSurface([app({mount: "/desk/chat"})], "/pano")).toBeNull();
	});
});

describe("surfacePath and surfaceUrl", () => {
	it.each([
		["a catch-all mount is the identity", {mount: "/"}, "/lab/atolye/x", "/lab/atolye/x"],
		["a mount with no basePath is the identity", {mount: "/lab"}, "/lab/atolye/x", "/lab/atolye/x"],
		["a basePath rewrites the mount", {mount: "/desk/chat", basePath: "/"}, "/desk/chat", "/"],
		[
			"a basePath rewrites the mount and keeps the remainder",
			{mount: "/desk/chat", basePath: "/"},
			"/desk/chat/deep",
			"/deep",
		],
		[
			"a basePath may be deeper than the mount",
			{mount: "/pi", basePath: "/window/proof"},
			"/pi/a",
			"/window/proof/a",
		],
	])("%s", (_label, overrides, surface, path) => {
		expect(surfacePath(app(overrides), surface)).toBe(path);
	});

	it("builds the URL on the origin its app actually bound, trailing slash trimmed", () => {
		expect(surfaceUrl("http://127.0.0.1:51234/", app({mount: "/"}), "/pano")).toBe(
			"http://127.0.0.1:51234/pano",
		);
	});
});

describe("surfaceSlug", () => {
	it.each([
		["/", "root"],
		["/pano", "pano"],
		["/pano/yeni", "pano-yeni"],
		["/desk/chat", "desk-chat"],
	])("slugs %s as %s", (route, slug) => {
		expect(surfaceSlug(route)).toBe(slug);
	});
});
