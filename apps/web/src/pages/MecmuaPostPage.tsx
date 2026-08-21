/**
 * `/mecmua/:slug` — the public reader for one published post. The body renders through
 * `@kampus/composer` in read-only mode, so write and read share one tiptap render path and
 * can't re-diverge (the raw-markdown bug #2578). Client-only; SEO/prerender is deferred.
 * Ships dark behind `MECMUA_PUBLIC_READ` (default-off; `.patterns/flag-dark-page-gate.md`).
 */
import {lazy, Suspense, useEffect, useState} from "react";
import {useParams} from "react-router";
import {MecmuaSubscribeButton} from "../components/mecmua/MecmuaSubscribeButton";
import {Alert} from "../components/ui/Alert";
import {MECMUA_PUBLIC_READ} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {NotFoundPage} from "./NotFoundPage";

// Lazy on purpose: this is the only reference to the composer, which keeps tiptap off
// public first-paint. A static import here would pull it into every route's chunk.
const MecmuaPostBody = lazy(() => import("../components/mecmua/MecmuaPostBody"));

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
				// 404 covers a masked draft and the flag being off, not just a genuine miss.
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
					<Alert variant="danger" className="kp-alert--inline">
						yazı yüklenemedi, tekrar dene.
					</Alert>
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
