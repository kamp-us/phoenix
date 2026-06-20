/**
 * read-guard runtime tail — the ONLY module that imports `@effect/platform-node`
 * (issue #777). `bin.ts` dynamically imports this *after* its dependency preflight
 * passes, so a stale-`node_modules` tree never reaches the heavy import: it degrades
 * to a loud fail-open ALLOW instead of an unhandled module-load crash.
 *
 * Wired per effect-smol's CLI guidance (mirrors `@kampus/leak-guard`):
 * run via `NodeRuntime.runMain` over `NodeServices.layer`.
 */
import {NodeRuntime, NodeServices} from "@effect/platform-node";
import {Console, Effect} from "effect";

/**
 * Compute the hook output via `render` and print it; any throw → fail-open `allow`
 * body (the catch keeps the read→decide path inside the Effect's fail-open boundary,
 * exactly as the pre-#777 inline runtime did — a hook crash never wedges an edit).
 */
export const run = (render: () => string, allow: string): void => {
	Effect.sync(render).pipe(
		Effect.flatMap((line) => Console.log(line)),
		Effect.catch(() => Console.log(allow)),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	);
};
