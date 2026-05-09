// Wrangler's Text rule (see wrangler.jsonc) lets us import .sql files as strings.
declare module "*.sql" {
	const content: string;
	export default content;
}
