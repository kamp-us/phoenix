/**
 * `readKey`'s note, over the two layers — the sentence a reader debugging a number follows back to
 * the file that set it. A note naming the wrong layer sends an operator to edit a file they never
 * declared the value in, so the layer is asserted through the real working-tree door rather than
 * off `resolve`'s tag.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9020#issuecomment-5625285600
 */
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {fakeFs} from "../fakes.test-support.ts";
import {CONFIG_PATH, LOCAL_CONFIG_PATH} from "./document.ts";
import {LANE_CONCURRENCY_CAP, laneConcurrencyCapKey} from "./keys/lane-concurrency-cap.ts";
import {readKey} from "./read-key.ts";

const repo = {
	"/repo/package.json": '{"workspaces":["apps/*"]}',
	"/repo/apps/site/package.json": "{}",
};

const capAt = (files: Record<string, string>) =>
	Effect.runPromise(
		Effect.provide(
			readKey("/repo/apps/site", laneConcurrencyCapKey),
			fakeFs({files: {...repo, ...files}}).layer,
		),
	);

describe("readKey's note names the layer the value came from", () => {
	it("names the machine-local file for a key that file declares", async () => {
		const read = await capAt({
			[`/repo/${CONFIG_PATH}`]: `{"${LANE_CONCURRENCY_CAP}": 2}`,
			[`/repo/${LOCAL_CONFIG_PATH}`]: `{"${LANE_CONCURRENCY_CAP}": 10}`,
		});
		expect(read).toEqual({
			_tag: "Value",
			value: 10,
			note: `\`${LANE_CONCURRENCY_CAP}\` as declared in ${LOCAL_CONFIG_PATH}`,
		});
	});

	it("names the tracked file where the machine declares nothing", async () => {
		const read = await capAt({
			[`/repo/${CONFIG_PATH}`]: `{"${LANE_CONCURRENCY_CAP}": 2}`,
			[`/repo/${LOCAL_CONFIG_PATH}`]: "{}",
		});
		expect(read).toEqual({
			_tag: "Value",
			value: 2,
			note: `\`${LANE_CONCURRENCY_CAP}\` as declared in ${CONFIG_PATH}`,
		});
	});

	it("names the tracked file with no machine-local file present at all", async () => {
		const read = await capAt({[`/repo/${CONFIG_PATH}`]: `{"${LANE_CONCURRENCY_CAP}": 2}`});
		expect(read).toEqual({
			_tag: "Value",
			value: 2,
			note: `\`${LANE_CONCURRENCY_CAP}\` as declared in ${CONFIG_PATH}`,
		});
	});

	// The default arm names no layer: there is no file to send a reader to, and naming one would be
	// a claim about a declaration nobody made.
	it("names the shipped value rather than a layer where neither file declares the key", async () => {
		const read = await capAt({[`/repo/${CONFIG_PATH}`]: "{}"});
		expect(read._tag).toBe("Value");
		expect(read._tag === "Value" && read.note).toContain(`the shipped \`${LANE_CONCURRENCY_CAP}\``);
		expect(read._tag === "Value" && read.note).not.toContain(LOCAL_CONFIG_PATH);
	});
});
