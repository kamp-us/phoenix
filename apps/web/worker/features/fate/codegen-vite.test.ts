/**
 * The REAL fate Vite plugin generates a native client
 * from a `FateExecutor.toCodegenServer(...)` schema module, end to end through
 * its actual `runnerImport` path (a programmatic `vite build` in a temp root).
 *
 * T0 in spirit (no worker, no storage), but it lives here because the plugin
 * (`react-fate/vite`) and Vite itself are this app's dependencies — the same
 * plugin instance `vite.config.ts` runs in the real build. The schema module
 * is `codegen-schema.fixture.ts`, whose handlers close over a throw-on-touch
 * Proxy database: successful generation doubles as the "no D1 at build time"
 * proof on the plugin's own import path.
 */
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {fate} from "react-fate/vite";
import {build} from "vite";
import {describe, expect, it} from "vitest";

// `fileURLToPath(import.meta.url)` (the string form): the worker tsconfig mixes
// workers-types and node globals, and node's `fileURLToPath` rejects the
// workers-typed `URL` instance.
const schemaModule = join(dirname(fileURLToPath(import.meta.url)), "codegen-schema.fixture.ts");

describe("fate vite plugin × FateExecutor.toCodegenServer", () => {
	it("runnerImports the codegen schema module and generates the native client", async () => {
		const root = await mkdtemp(join(tmpdir(), "fate-codegen-"));
		try {
			const entry = join(root, "entry.ts");
			await writeFile(entry, "export const ok = true;\n");
			await build({
				configFile: false,
				logLevel: "error",
				root,
				plugins: [
					fate({
						module: schemaModule,
						transport: "native",
						generatedFile: "client.generated.ts",
						tsconfigFile: false,
					}),
				],
				build: {
					write: false,
					lib: {entry, formats: ["es"], fileName: "entry"},
				},
			});

			const generated = await readFile(join(root, "client.generated.ts"), "utf8");
			// The generated client types itself off the EXPORTED codegen server —
			// exactly the InferFateAPI contract the codegen suite settles.
			expect(generated).toContain("type FateAPI = InferFateAPI<typeof fateServer>;");
			// Mutations come from the codegen manifest, typed through FateAPI.
			expect(generated).toContain("'definition.add': mutation<");
			expect(generated).toContain("FateAPI['mutations']['definition.add']['input']");
			// The Root entry becomes a typed client root over the `term` query.
			expect(generated).toContain(
				"'term': clientRoot<FateAPI['queries']['term']['output'], 'Term'>('Term'),",
			);
			// The schema walk saw the kernel views (fields block in the generated types).
			expect(generated).toContain("type: 'Term',");
			expect(generated).toContain("type: 'Definition',");
		} finally {
			await rm(root, {recursive: true, force: true});
		}
	}, 60_000);
});
