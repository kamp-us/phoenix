// Wrangler's Text rule (see wrangler.jsonc) lets us import .sql files as strings.
declare module "*.sql" {
	const content: string;
	export default content;
}

// Vite's `?raw` suffix imports a file's contents as a string. The node/unit
// test pool uses it for `.sql` fixtures (the pool-workers project transforms
// `.sql` to a string directly; the node pool does not).
declare module "*?raw" {
	const content: string;
	export default content;
}
