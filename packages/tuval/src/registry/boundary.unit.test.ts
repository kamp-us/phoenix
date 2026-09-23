/**
 * The boundary this slice keeps: nothing under `src/registry/` imports `src/host/`. The slice
 * describes a program and never runs one, and the founder's 2026-09-05 ruling on #7933 kept that
 * rule when ADR 0346's Sub-failure policy needed a type both slices could name — the type moved to
 * `src/sub-failure.ts` rather than the import moving here.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Cmd, NoCtx, Sub, SubId} from "@demlik/tea";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {SubFailure} from "../sub-failure.ts";
import type {Program} from "./program.ts";

type State = {readonly armed: boolean};
type Msg = {readonly type: "noted"; readonly note: string};
type Ticker = {readonly id: SubId; readonly type: "ticker"};
type Row = Program<State, Msg, Cmd<never>, Ticker, NoCtx, never, never>;

describe("registry boundary", () => {
	it("types a row's subFailure at the shared policy, so a row may declare one", () => {
		expectTypeOf<NonNullable<Row["core"]["subFailure"]>>().toEqualTypeOf<
			(sub: Ticker, failure: SubFailure) => Msg | undefined
		>();
		// A Sub the policy is not written against is not one it can be handed.
		expectTypeOf<NonNullable<Row["core"]["subFailure"]>>().parameter(0).not.toEqualTypeOf<Sub>();
	});

	it("nothing in src/registry/ imports from src/host/", () => {
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers.filter((s) => /(^|\/)host(\/|$)/.test(s)).map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
