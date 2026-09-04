/**
 * The two boundaries this slice keeps: the row is program-blind (type-level, so `tsc` over this
 * file is the proof), and nothing under `src/table/` renders or imports a UI dependency.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Option} from "effect";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {Lifecycle, ProcessId} from "../process/process.ts";
import type {ProgramId} from "../registry/program.ts";
import type {TableEvent, TableRow} from "./row.ts";

describe("table boundary", () => {
	it("the row type is program-blind", () => {
		// Every field is one of five, and each is plain data a projection can render.
		expectTypeOf<keyof TableRow>().toEqualTypeOf<
			"id" | "programId" | "parentId" | "ports" | "stateSummary"
		>();
		expectTypeOf<TableRow["id"]>().toEqualTypeOf<ProcessId>();
		expectTypeOf<TableRow["programId"]>().toEqualTypeOf<ProgramId>();
		expectTypeOf<TableRow["parentId"]>().toEqualTypeOf<Option.Option<ProcessId>>();
		// The state summary is lifecycle plus revision: no `state`, so no program's shape leaks.
		expectTypeOf<TableRow["stateSummary"]>().toEqualTypeOf<{
			readonly lifecycle: Lifecycle;
			readonly revision: number;
		}>();
		expectTypeOf<TableRow["stateSummary"]>().not.toHaveProperty("state");
		// A declared port is kind plus direction: no predicate, no queue, no payload type.
		expectTypeOf<TableRow["ports"][string]>().toEqualTypeOf<{
			readonly kind: string;
			readonly direction: "in" | "out";
		}>();
		expectTypeOf<TableRow>().not.toHaveProperty("core");
		expectTypeOf<TableRow>().not.toHaveProperty("handlers");
		expectTypeOf<TableRow>().not.toHaveProperty("renderer");
		expectTypeOf<TableEvent["row"]>().toEqualTypeOf<TableRow>();
	});

	it("nothing in src/table/ renders or imports a UI dependency", () => {
		const dir = import.meta.dirname;
		const ui = [/^react/, /^@react/, /^@xyflow/, /^vite$/, /\.tsx$/, /^@kampus\/ui/];
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tsx"))).toEqual([]);
		const offenders = names
			.filter((name) => name.endsWith(".ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
				return specifiers
					.filter((s) => ui.some((pattern) => pattern.test(s)))
					.map((s) => `${name}: ${s}`);
			});
		expect(offenders).toEqual([]);
	});
});
