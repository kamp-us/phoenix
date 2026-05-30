// Vite's `?raw` suffix imports a file's contents as a string. The node/unit
// test pool uses it for `.sql` fixtures (the pool-workers project transforms
// `.sql` to a string directly; the node pool does not). Deploy-time
// configuration is owned by `apps/web/alchemy.run.ts` (the alchemy stack
// replaced `wrangler.jsonc` per ADR 0026), so no `*.sql` wrangler Text-rule
// shim is needed here.
declare module "*?raw" {
	const content: string;
	export default content;
}
