/**
 * The three boundaries this slice keeps. Two are type-level, so `tsc` over this file is the proof:
 * the view the picker stores fits the window's JSON slot, and so does everything a refusal carries.
 * The third is textual — nothing here imports React, a socket or the transport, because the picker
 * is data the browser page renders and not the rendering itself.
 *
 * Every `=` probe below is a claim on the right of an assignment and each was flip-verified — see
 * `.patterns/unconditional-test-assertions.md`, "the type-level sibling".
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import type {ViewState} from "../window/host.ts";
import type {PickerRefusal} from "./refusal.ts";
import type {PickerView} from "./view.ts";

type FitsTheSlot<V> = V extends ViewState ? true : false;

const viewFits: FitsTheSlot<PickerView> = true;
const refusalFits: FitsTheSlot<PickerRefusal> = true;
const rendererDoesNot: FitsTheSlot<{readonly render: () => string}> = false;

describe("picker boundary", () => {
	it("everything the picker stores or sends fits the window's JSON slot", () => {
		expect([viewFits, refusalFits]).toEqual([true, true]);
		expect(rendererDoesNot).toBe(false);
	});

	it("nothing in src/shell/picker/ imports React, a socket, or the transport", () => {
		const dir = import.meta.dirname;
		const forbidden = [
			/^react/,
			/^@react/,
			/^ws$/,
			/^socket\.io/,
			/^node:net$/,
			/^node:http/,
			/\/shell\/transport\//,
			/^\.\.\/transport\//,
			/\.tsx$/,
		];
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tsx"))).toEqual([]);
		const offenders = names
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers
					.filter((s) => forbidden.some((pattern) => pattern.test(s)))
					.map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
