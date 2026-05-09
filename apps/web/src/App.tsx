import {useEffect, useState} from "react";

interface Health {
	status: string;
	environment: string;
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{message: string}>;
}

type Result<T> = {kind: "loading"} | {kind: "ok"; value: T} | {kind: "error"; message: string};

async function fetchHealth(): Promise<Health> {
	const res = await fetch("/graphql", {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({query: "{ health { status environment } }"}),
	});

	const text = await res.text();
	const contentType = res.headers.get("content-type") ?? "";

	if (!res.ok || !contentType.includes("application/json")) {
		throw new Error(`HTTP ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
	}

	const body = JSON.parse(text) as GraphQLResponse<{health: Health}>;
	if (body.errors?.length) {
		throw new Error(body.errors.map((e) => e.message).join("\n"));
	}
	if (!body.data) {
		throw new Error("GraphQL response missing data");
	}
	return body.data.health;
}

export function App() {
	const [result, setResult] = useState<Result<Health>>({kind: "loading"});

	useEffect(() => {
		fetchHealth()
			.then((value) => setResult({kind: "ok", value}))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				setResult({kind: "error", message});
			});
	}, []);

	return (
		<main>
			<h1>kamp.us</h1>
			<p>phoenix — single worker rebirth</p>
			{result.kind === "loading" && <p>loading…</p>}
			{result.kind === "ok" && <pre>{JSON.stringify(result.value, null, 2)}</pre>}
			{result.kind === "error" && <pre>error: {result.message}</pre>}
		</main>
	);
}
