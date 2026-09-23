/**
 * The shared read-back's pure core: the render call, the signed link it yields, the anonymous
 * probe, and the two checks that hold the served asset to the capture.
 */
import {createHash} from "node:crypto";
import {describe, expect, it} from "@effect/vitest";
import {
	classifyBytes,
	classifyDigest,
	classifyProbe,
	probeRequest,
	renderCall,
	servedAssetUrl,
} from "./attachment-read-back.ts";

const UUID = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const HOSTED = `https://github.com/user-attachments/assets/${UUID}`;
const SIGNED = `https://private-user-images.githubusercontent.com/1783869/657136403-${UUID}.png?jwt=a.b.c&X-Amz-Expires=300`;
/** GitHub's renderer output for one stored asset, `&` entity-escaped as the live HTML carries it. */
const rendered = (src: string = SIGNED): string =>
	`<p dir="auto"><a target="_blank" href="${src.replaceAll("&", "&amp;")}"><img src="${src.replaceAll("&", "&amp;")}" alt="evidence" style="max-width: 100%;"></a></p>`;
const BYTES = new Uint8Array([1, 2, 3]);

describe("renderCall", () => {
	it("renders the hosted URL as an image in the target repo's context", () => {
		expect(renderCall(HOSTED, "o/r")).toEqual({
			method: "POST",
			path: "markdown",
			body: {text: `![evidence](${HOSTED})`, mode: "gfm", context: "o/r"},
			accept: "text/html",
		});
	});
});

describe("servedAssetUrl", () => {
	it("takes the signed image link whose path names the asset's uuid, unescaping `&`", () => {
		expect(servedAssetUrl(rendered(), HOSTED)).toBe(SIGNED);
	});

	it("picks this asset's link out of a comment embedding several", () => {
		const other = SIGNED.replace(UUID, "ffffffff-0000-1111-2222-333333333333");
		expect(servedAssetUrl(rendered(other) + rendered(), HOSTED)).toBe(SIGNED);
	});

	it("finds nothing when the HTML carries no image naming the asset", () => {
		expect(servedAssetUrl("<p>no image</p>", HOSTED)).toBeNull();
		expect(
			servedAssetUrl(
				rendered(SIGNED.replace(UUID, "ffffffff-0000-1111-2222-333333333333")),
				HOSTED,
			),
		).toBeNull();
	});

	it("never takes a non-https link", () => {
		expect(servedAssetUrl(rendered(SIGNED.replace("https:", "http:")), HOSTED)).toBeNull();
	});
});

describe("probeRequest", () => {
	it("GETs the served link with no credential — the token never travels to the CDN host", () => {
		const request = probeRequest(SIGNED);
		expect(request.method).toBe("GET");
		expect(request.url).toBe(SIGNED);
		expect(request.headers.authorization).toBeUndefined();
	});
});

describe("classifyProbe", () => {
	it("accepts only the 200 the served link answers with", () => {
		expect(classifyProbe(200)).toBeNull();
		expect(classifyProbe(302)).toMatch(/probed back HTTP 302/);
	});

	it("keeps a 404 a failure — a URL that does not resolve is not evidence (#3925)", () => {
		expect(classifyProbe(404)).toMatch(/probed back HTTP 404/);
		expect(classifyProbe(500)).toMatch(/probed back HTTP 500/);
	});
});

describe("classifyBytes", () => {
	it("passes only the capture's exact bytes", () => {
		expect(classifyBytes(new Uint8Array([1, 2, 3]), BYTES)).toBeNull();
		expect(classifyBytes(new Uint8Array([1, 2, 4]), BYTES)).toMatch(/not the 3-byte capture/);
		expect(classifyBytes(new Uint8Array([1, 2]), BYTES)).toMatch(/served 2 bytes/);
	});
});

describe("classifyDigest", () => {
	it("passes only bytes hashing to the recorded digest", () => {
		const digest = createHash("sha256").update(BYTES).digest("hex");
		expect(classifyDigest(new Uint8Array([1, 2, 3]), digest)).toBeNull();
		expect(classifyDigest(new Uint8Array([1, 2, 4]), digest)).toMatch(
			new RegExp(`not the recorded ${digest.slice(0, 12)}`),
		);
	});
});
