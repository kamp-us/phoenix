import {getBearerToken} from "../auth/client";

export interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{message: string}>;
}

export class GraphQLRequestError extends Error {
	constructor(
		message: string,
		readonly errors: Array<{message: string}>,
	) {
		super(message);
		this.name = "GraphQLRequestError";
	}
}

export async function gqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
	const headers: Record<string, string> = {"Content-Type": "application/json"};
	const token = getBearerToken();
	if (token) headers.Authorization = `Bearer ${token}`;

	const res = await fetch("/graphql", {
		method: "POST",
		headers,
		body: JSON.stringify({query, variables}),
	});

	const text = await res.text();
	const contentType = res.headers.get("content-type") ?? "";

	if (!res.ok || !contentType.includes("application/json")) {
		throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
	}

	const body = JSON.parse(text) as GraphQLResponse<T>;
	if (body.errors?.length) {
		throw new GraphQLRequestError(body.errors.map((e) => e.message).join("\n"), body.errors);
	}
	if (!body.data) throw new Error("GraphQL response missing data");
	return body.data;
}
