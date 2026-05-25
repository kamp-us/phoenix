/**
 * The fate codegen entry module — the single module the fate Vite plugin reads
 * (`fate({module: ".../worker/fate/schema.ts", transport: "native"})`).
 *
 * The plugin imports this module at build time (`runnerImport`) and needs three
 * things from one place:
 *   1. the runtime data-view objects (it filters `Object.values` for views to
 *      build the schema + manifest),
 *   2. the `fateServer` value (it reads `fateServer.manifest` and
 *      `InferFateAPI<typeof fateServer>` for the typed client roots/mutations),
 *   3. the entity *type* names (`User`, `Term`, `Definition`, `Post`, `Comment`,
 *      `Tag`, `Profile`, `Contribution`) — imported verbatim as the client's
 *      view types — and `Root`.
 *
 * `views.ts` owns 1 + 3; `server.ts` owns 2. This barrel re-exports both so the
 * plugin has one `module` to point at. Nothing else imports this file — the
 * worker entry imports `server.ts` directly.
 */

export {fateServer} from "./server";
export * from "./views";
