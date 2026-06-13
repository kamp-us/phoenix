// Vite's `?raw` suffix imports a file's contents as a string — used by the
// node/unit test pool for `.sql` fixtures (the node pool, unlike pool-workers,
// doesn't transform `.sql` to a string directly).
declare module "*?raw" {
	const content: string;
	export default content;
}
