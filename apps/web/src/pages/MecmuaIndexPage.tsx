/**
 * `/mecmua` — the PUBLIC chronological index of published mecmua posts (#2512, epic
 * #2467), the discovery surface the reader (`/mecmua/:slug`) lacked. It fetches the
 * anonymous `GET /fate/mecmua/index` route (published-only, newest-first) and lists each
 * post as a card linking to its reader. This is the PUBLIC index (all published posts) —
 * distinct from the personalized subscribed-author feed (#2500).
 *
 * The whole surface ships dark behind `MECMUA_PUBLIC_READ` (default-off): the page
 * self-gates (off => 404), mirroring `MecmuaPostPage` / `DivanPage`, so the route is
 * absent until a human flips the flag at release (ADR 0083). The index route itself also
 * 404s while the flag is off — the page gate just avoids a fetch and a flash.
 */
import {BookOpenText} from "lucide-react";
import {useEffect, useState} from "react";
import {Link} from "react-router";
import {Icon} from "../components/Icon";
import {Card} from "../components/ui/Card";
import {EmptyState} from "../components/ui/EmptyState";
import {MetaRow} from "../components/ui/MetaRow";
import {MECMUA_PUBLIC_READ} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {formatDateTR} from "../lib/datetime";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaIndexPage.css";

/** The lean wire shape `GET /fate/mecmua/index` returns — no body, the reader fetches that. */
interface MecmuaIndexEntry {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string;
	/** ISO string (a serialized `Date`); always set for a published post. */
	readonly publishedAt: string | null;
}

type FetchState =
	| {kind: "loading"}
	| {kind: "ok"; posts: ReadonlyArray<MecmuaIndexEntry>}
	| {kind: "error"};

export function MecmuaIndexPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_PUBLIC_READ, false);

	// Don't decide 404-vs-page until the flag resolves, or the 404 flashes first (the
	// MecmuaPostPage / DivanPage self-gate idiom).
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

	return <MecmuaIndex />;
}

function MecmuaIndex() {
	const [state, setState] = useState<FetchState>({kind: "loading"});

	useEffect(() => {
		let cancelled = false;
		setState({kind: "loading"});
		fetch("/fate/mecmua/index", {headers: {accept: "application/json"}})
			.then(async (res) => {
				if (cancelled) return;
				if (!res.ok) return setState({kind: "error"});
				const posts = (await res.json()) as ReadonlyArray<MecmuaIndexEntry>;
				if (!cancelled) setState({kind: "ok", posts});
			})
			.catch(() => {
				if (!cancelled) setState({kind: "error"});
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div className="kp-page">
			<div className="kp-page__inner">
				<header className="kp-mecmua-index__head">
					<div className="kp-mecmua-index__head-row">
						<h1 className="kp-mecmua-index__title">mecmua</h1>
					</div>
					<p className="kp-mecmua-index__lede">topluluğun uzun yazıları</p>
				</header>
				<MecmuaIndexBody state={state} />
			</div>
		</div>
	);
}

function MecmuaIndexBody({state}: {state: FetchState}) {
	if (state.kind === "loading") {
		return <p className="kp-mecmua-index__status">yükleniyor…</p>;
	}

	if (state.kind === "error") {
		return (
			<p className="kp-mecmua-index__status" role="alert">
				yazılar yüklenemedi, tekrar dene.
			</p>
		);
	}

	if (state.posts.length === 0) {
		return (
			<EmptyState
				icon={<Icon icon={BookOpenText} size={24} />}
				title="henüz yazı yok"
				description="ilk mecmua yazısı yayımlandığında burada görünecek."
			/>
		);
	}

	return (
		<ul className="kp-mecmua-index__list">
			{state.posts.map((post) => (
				<Card
					as="li"
					interactive
					key={post.id}
					className="kp-mecmua-index__item"
					data-testid="mecmua-index-item"
				>
					<Link to={`/mecmua/${post.slug ?? post.id}`} className="kp-mecmua-index__link">
						<span className="kp-mecmua-index__item-title">{post.title}</span>
						{post.publishedAt ? (
							<MetaRow as="div" className="kp-mecmua-index__meta">
								<time dateTime={post.publishedAt}>{formatDateTR(post.publishedAt)}</time>
							</MetaRow>
						) : null}
					</Link>
				</Card>
			))}
		</ul>
	);
}
