import {
	Environment,
	type FetchFunction,
	type GraphQLResponse,
	Network,
	RecordSource,
	Store,
} from "relay-runtime";
import {getBearerToken} from "../auth/client";

/**
 * Relay's network layer wants the full `{ data, errors }` envelope, while our
 * `gqlFetch` helper unwraps `data` and throws on `errors`. So we can't reuse
 * `gqlFetch` here directly — instead we share the auth primitive
 * (`getBearerToken`) and let Relay see the raw GraphQL response.
 */
const fetchFn: FetchFunction = async (operation, variables) => {
	const headers: Record<string, string> = {"Content-Type": "application/json"};
	const token = getBearerToken();
	if (token) headers.Authorization = `Bearer ${token}`;

	const response = await fetch("/graphql", {
		method: "POST",
		headers,
		body: JSON.stringify({query: operation.text, variables}),
	});

	return (await response.json()) as GraphQLResponse;
};

export const createRelayEnvironment = (): Environment =>
	new Environment({
		network: Network.create(fetchFn),
		store: new Store(new RecordSource()),
	});

export const environment = createRelayEnvironment();
