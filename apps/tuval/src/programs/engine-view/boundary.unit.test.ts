/**
 * The two boundaries this child keeps: the projected domain names no rendering library's type
 * (type-level, so `tsc` over this file is half the proof), and nothing under
 * `src/programs/engine-view/` imports React, the DOM, a socket or the kernel's `src/process/`.
 */

import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, expectTypeOf, it} from "vitest";
import type {ProcessId, ProgramId} from "../../protocol/ids.ts";
import type {PortDeclaration, TableStateSummary} from "../../table/row.ts";
import type {LaidOutNode} from "./layout.ts";
import type {EngineEdge, EngineNode} from "./projection.ts";

describe("engine-view boundary", () => {
	it("the projected node is a process and nothing library-shaped", () => {
		expectTypeOf<keyof EngineNode>().toEqualTypeOf<"id" | "programId" | "ports" | "stateSummary">();
		expectTypeOf<EngineNode["id"]>().toEqualTypeOf<ProcessId>();
		expectTypeOf<EngineNode["programId"]>().toEqualTypeOf<ProgramId>();
		expectTypeOf<EngineNode["ports"][string]>().toEqualTypeOf<PortDeclaration>();
		expectTypeOf<EngineNode["stateSummary"]>().toEqualTypeOf<TableStateSummary>();
		// `@xyflow/react`'s `Node` carries these; a domain that grew one would be the library's shape.
		expectTypeOf<EngineNode>().not.toHaveProperty("data");
		expectTypeOf<EngineNode>().not.toHaveProperty("type");
		expectTypeOf<EngineNode>().not.toHaveProperty("position");
		expectTypeOf<EngineNode>().not.toHaveProperty("selected");
		expectTypeOf<EngineNode>().not.toHaveProperty("measured");
		// The POC's session domain does not survive the port.
		expectTypeOf<EngineNode>().not.toHaveProperty("session");
		expectTypeOf<EngineEdge>().not.toHaveProperty("markerEnd");
		expectTypeOf<EngineEdge>().not.toHaveProperty("sourceHandle");
		expectTypeOf<keyof EngineEdge>().toEqualTypeOf<"id" | "source" | "target">();
		// The layout adds a box and nothing else, so placement never leaks back into the domain.
		expectTypeOf<keyof LaidOutNode>().toEqualTypeOf<keyof EngineNode | "size" | "position">();
	});

	it("nothing here imports React, the DOM, a socket or the kernel's process slice", () => {
		const dir = import.meta.dirname;
		const forbidden = [
			/^react/,
			/^@react/,
			/^@xyflow/,
			/^react-dom/,
			/^node:(fs|net|http)$/,
			/^ws$/,
			/\.\.\/\.\.\/process\//,
			/\.\.\/\.\.\/table\/ProcessTablePort/,
		];
		const names = readdirSync(dir);
		expect(names.filter((name) => name.endsWith(".tsx"))).toEqual([]);
		const offenders = names
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"))
			.flatMap((name) => {
				const source = readFileSync(join(dir, name), "utf8");
				const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
				return specifiers
					.filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
					.map((specifier) => `${name}: ${specifier}`);
			});
		expect(offenders).toEqual([]);
	});

	it("touches no `document` or `window` global", () => {
		const dir = import.meta.dirname;
		const offenders = readdirSync(dir)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".unit.test.ts"))
			.filter((name) => /\b(document|globalThis)\s*\./.test(readFileSync(join(dir, name), "utf8")));
		expect(offenders).toEqual([]);
	});
});
