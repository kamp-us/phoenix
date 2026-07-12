/**
 * `/mecmua/:slug` — the PUBLIC reader for a single published mecmua post (#2498, epic
 * #2467). Client-only per the map (#2466 — SEO/prerender explicitly deferred): it
 * fetches the anonymous `GET /fate/mecmua/post/:slug` route and renders the published
 * post's başlık + markdown body through `@kampus/composer` in read-only mode (#2581) —
 * the reader is the editor with editing switched off, so write and read share ONE tiptap
 * render path (editor≈reader parity) and can't re-diverge (the raw-markdown bug #2578).
 * A draft / miss / off-flag all 404 server-side, surfaced here as the shared NotFoundPage.
 *
 * Tiptap is kept OFF public first-paint: the body renders through `MecmuaPostBody`, a
 * `React.lazy` chunk that alone imports the composer (the #2523 lazy-split applied to the
 * reader) — landing/index/other routes carry no tiptap; opening a post loads that chunk.
 *
 * The whole surface ships dark behind `MECMUA_PUBLIC_READ` (default-off): the page
 * self-gates (off ⇒ 404), mirroring `DivanPage`, so the route is absent until a human
 * flips the flag at release (ADR 0083). The route itself also 404s while the flag is
 * off — the page gate just avoids a fetch and a flash.
 */
import {lazy, Suspense, useEffect, useState} from "react";
import {useParams} from "react-router";
import {MecmuaSubscribeButton} from "../components/mecmua/MecmuaSubscribeButton";
import {MECMUA_PUBLIC_READ} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";

// The composer (and tiptap) live behind this dynamic import so they stay off mecmua public
// first-paint — the reader route's own module graph never statically references tiptap.
const MecmuaPostBody = lazy(() => import("../components/mecmua/MecmuaPostBody"));

/**
 * The wire shape the anon read route returns. `authorId` is the subscribe target — the
 * follow toggle (#2527) subscribes the reader to this post's author.
 */
interface MecmuaPostWire {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly authorId: string;
}

type FetchState =
	| {kind: "loading"}
	| {kind: "ok"; post: MecmuaPostWire}
	| {kind: "not-found"}
	| {kind: "error"};

export function MecmuaPostPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_PUBLIC_READ, false);
	const {slug} = useParams<{slug: string}>();

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first (the
	// DivanPage self-gate idiom).
	if (flagLoading) {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p>yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (!flagOn) return <NotFoundPage />;

	return <MecmuaPostReader slug={slug ?? ""} />;
}

function MecmuaPostReader({slug}: {slug: string}) {
	const [state, setState] = useState<FetchState>({kind: "loading"});

	useEffect(() => {
		let cancelled = false;
		setState({kind: "loading"});
		fetch(`/fate/mecmua/post/${encodeURIComponent(slug)}`, {headers: {accept: "application/json"}})
			.then(async (res) => {
				if (cancelled) return;
				// 404 = a draft (masked), a genuine miss, or the flag off — all render as the
				// not-found state. Any other non-2xx is a transient read error.
				if (res.status === 404) return setState({kind: "not-found"});
				if (!res.ok) return setState({kind: "error"});
				const post = (await res.json()) as MecmuaPostWire;
				if (!cancelled) setState({kind: "ok", post});
			})
			.catch(() => {
				if (!cancelled) setState({kind: "error"});
			});
		return () => {
			cancelled = true;
		};
	}, [slug]);

	if (state.kind === "loading") {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p>yükleniyor…</p>
				</div>
			</div>
		);
	}

	if (state.kind === "not-found") {
		return (
			<NotFoundPage
				title="yazı bulunamadı"
				message={`"${slug}" diye bir yazı bulamadık. başka bir şeye bakmak ister misin?`}
			/>
		);
	}

	if (state.kind === "error") {
		return (
			<div className="kp-page">
				<div className="kp-page__inner">
					<p role="alert">yazı yüklenemedi, tekrar dene.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<article data-testid="mecmua-post">
					<h1>{state.post.title}</h1>
					<MecmuaSubscribeButton authorId={state.post.authorId} />
					<Suspense
						fallback={
							<div className="kp-prose">
								<p>yükleniyor…</p>
							</div>
						}
					>
						<MecmuaPostBody body={state.post.body} />
					</Suspense>
				</article>
			</div>
		</div>
	);
}
