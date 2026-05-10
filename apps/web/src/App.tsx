import {useEffect, useState} from "react";
import {AuthPanel} from "./auth/AuthPanel";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {gqlFetch} from "./graphql/client";

interface Health {
	status: string;
	environment: string;
}

interface Me {
	id: string;
	email: string;
	name: string | null;
}

type Result<T> = {kind: "loading"} | {kind: "ok"; value: T} | {kind: "error"; message: string};

const HEALTH_QUERY = "{ health { status environment } }";
const ME_QUERY = "{ me { id email name } }";

function useGraphQL<T>(query: string, run: boolean): Result<T> {
	const [result, setResult] = useState<Result<T>>({kind: "loading"});
	useEffect(() => {
		if (!run) return;
		let cancelled = false;
		setResult({kind: "loading"});
		gqlFetch<T>(query)
			.then((value) => {
				if (!cancelled) setResult({kind: "ok", value});
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const message = err instanceof Error ? err.message : String(err);
				setResult({kind: "error", message});
			});
		return () => {
			cancelled = true;
		};
	}, [query, run]);
	return result;
}

function ResultView<T>({result}: {result: Result<T>}) {
	if (result.kind === "loading") return <p>loading…</p>;
	if (result.kind === "error") return <pre data-error>error: {result.message}</pre>;
	return <pre>{JSON.stringify(result.value, null, 2)}</pre>;
}

export function App() {
	const session = useSession();
	const health = useGraphQL<{health: Health}>(HEALTH_QUERY, true);
	const me = useGraphQL<{me: Me | null}>(ME_QUERY, !!session.data);

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	return (
		<main>
			<header>
				<h1>kamp.us</h1>
				<p>phoenix — single worker rebirth</p>
			</header>

			<section>
				<h2>health</h2>
				<ResultView result={health} />
			</section>

			<section>
				<h2>session</h2>
				{session.isPending ? (
					<p>checking session…</p>
				) : session.data ? (
					<div className="session">
						<dl>
							<dt>user</dt>
							<dd>
								{session.data.user.name ?? "—"} &lt;{session.data.user.email}&gt;
							</dd>
							<dt>id</dt>
							<dd>
								<code>{session.data.user.id}</code>
							</dd>
						</dl>
						<button type="button" onClick={onSignOut}>
							sign out
						</button>
						<h3>me (graphql)</h3>
						<ResultView result={me} />
					</div>
				) : (
					<AuthPanel />
				)}
			</section>
		</main>
	);
}
