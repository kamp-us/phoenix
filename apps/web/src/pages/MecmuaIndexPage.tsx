/**
 * `/mecmua` — the public index of published posts, distinct from the personalized
 * subscribed-author feed (`/mecmua/akis`). Ships dark behind `MECMUA_PUBLIC_READ`
 * (default-off; `.patterns/flag-dark-page-gate.md`) — the route 404s server-side too, this gate
 * just saves a fetch.
 */

import {Alert, Card, EmptyState, MetaRow} from "@kampus/design";
import {BookOpenText} from "lucide-react";
import {useEffect, useState} from "react";
import {Link} from "react-router";
import {Icon} from "../components/Icon";
import {MECMUA_PUBLIC_READ} from "../flags/keys";
import {useFlag} from "../flags/useFlag";
import {formatDateTR} from "../lib/datetime";
import {NotFoundPage} from "./NotFoundPage";
import "./MecmuaIndexPage.css";

interface MecmuaIndexEntry {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string;
	readonly publishedAt: string | null;
}

type FetchState =
	| {kind: "loading"}
	| {kind: "ok"; posts: ReadonlyArray<MecmuaIndexEntry>}
	| {kind: "error"};

export function MecmuaIndexPage() {
	const {value: flagOn, loading: flagLoading} = useFlag(MECMUA_PUBLIC_READ, false);

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
			<Alert variant="danger" className="kp-alert--inline kp-mecmua-index__status">
				yazılar yüklenemedi, tekrar dene.
			</Alert>
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
