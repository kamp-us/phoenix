import {useEffect, useState} from "react";
import {gqlFetch} from "./client";

export type GraphQLResult<T> =
	| {kind: "loading"}
	| {kind: "ok"; data: T}
	| {kind: "error"; message: string};

/**
 * Tiny fetch-on-mount hook over `gqlFetch`. Re-runs when the query string or
 * the JSON-stringified variables change. Cancels the in-flight set on unmount.
 *
 * Not a cache — every component that wants the same data re-fetches. Real
 * caching arrives with Relay or a dedicated client; this is the bridge.
 */
export function useGraphQL<T>(
	query: string,
	variables?: Record<string, unknown>,
): GraphQLResult<T> {
	const [result, setResult] = useState<GraphQLResult<T>>({kind: "loading"});
	const variablesKey = variables ? JSON.stringify(variables) : "";

	useEffect(() => {
		let cancelled = false;
		setResult({kind: "loading"});
		gqlFetch<T>(query, variables)
			.then((data) => {
				if (!cancelled) setResult({kind: "ok", data});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : String(err);
				setResult({kind: "error", message});
			});
		return () => {
			cancelled = true;
		};
	// `variablesKey` deliberately replaces `variables` in the deps so a fresh
	// object literal with the same shape doesn't re-trigger.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [query, variablesKey]);

	return result;
}
