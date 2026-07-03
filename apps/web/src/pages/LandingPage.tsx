/**
 * Landing page (`/`) — the public front door. Stats + the two lists ("panoda son
 * 24 saat", "sözlüğe son eklenenler") all read live through fate, batched into one
 * per-screen `useRequest({landingStats, landingPosts, landingTerms})` under a single
 * `Screen` (ADR 0021). Server types are the source of truth (ADR 0022) — the rows
 * read the `Post`/`Term` views directly, no hand-written shadow shapes.
 */
import {useListView, useRequest, useView, type ViewRef, view} from "react-fate";
import {Link} from "react-router";
import type {LandingStats, Post, Term} from "../../worker/features/fate/views";
import {Screen} from "../fate/Screen";
import {toIso} from "../fate/wire";
import {formatAgoTR} from "../lib/datetime";
import "./LandingPage.css";

const LANDING_LIST_SIZE = 5;

/** `LandingStats` is a singleton entity (constant `id`), served by `queries.landingStats`. */
const LandingStatsView = view<LandingStats>()({
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
});

const LandingPostView = view<Post>()({
	id: true,
	slug: true,
	title: true,
	score: true,
	author: true,
	createdAt: true,
	commentCount: true,
});

const LandingTermView = view<Term>()({
	id: true,
	slug: true,
	title: true,
	definitionCount: true,
	excerpt: true,
	lastActivityAt: true,
});

/** A connection "view" is a plain `{items: {node: View}}` selection, not a `view<T>()`. */
const PostConnectionView = {items: {node: LandingPostView}} as const;
const TermConnectionView = {items: {node: LandingTermView}} as const;

const landingRequest = {
	landingStats: {view: LandingStatsView},
	landingPosts: {list: PostConnectionView, args: {first: LANDING_LIST_SIZE}},
	landingTerms: {list: TermConnectionView, args: {first: LANDING_LIST_SIZE}},
} as const;

function formatStat(n: number): string {
	if (n < 1000) return String(n);
	// Turkish convention: thousands separator is `.` (e.g. 1.247).
	return n.toLocaleString("tr-TR");
}

export function LandingPage() {
	return (
		<div className="kp-landing">
			<div className="kp-landing__hero">
				<div>
					<h1 className="kp-landing__brand">
						kamp<span className="dot">.</span>us
					</h1>
					<p className="kp-landing__tagline">
						geliştiricilerin kendi kendine bir şey öğrettiği, yavaş bir köşe.
					</p>
					<p className="kp-landing__manifesto">
						<strong>panoda</strong> bağlantı ve yazı paylaşıyor, tartışıyoruz.{" "}
						<strong>sözlükte</strong> terimleri kendi cümlelerimizle yazıyoruz. türkçe öncelikli;
						reklam, takipçi sayısı, sansasyon yok — sadece okumaya değer şeyler ve onları yazan
						birkaç yüz kişi.
					</p>
					<p className="kp-landing__rite">
						<strong>kapı açık:</strong> hesap açmak herkese serbest.{" "}
						<strong>söz hakkı kazanılır:</strong> ilk yazdıkların çaylak olarak divanda incelenir;
						katkı verdikçe bir yazar sana kefil olur, yazar olursun — o zaman yazdıkların doğrudan
						yayına girer.
					</p>
				</div>
				<div className="kp-landing__cta">
					<Link className="kp-landing__join" to="/auth" data-testid="landing-join-cta">
						<span className="label">hesap aç →</span>
						<span className="sub">kapı açık · söz hakkı kazanılır</span>
					</Link>
					<div className="kp-landing__browse">
						<Link to="/pano">
							<span className="label">pano →</span>
							<span className="sub">başlıklar · tartışmalar</span>
						</Link>
						<Link to="/sozluk">
							<span className="label">sözlük →</span>
							<span className="sub">terimler · tanımlar</span>
						</Link>
					</div>
				</div>
			</div>

			<Screen fallback={<LandingBodyFallback />} error={() => <LandingBodyError />}>
				<LandingBody />
			</Screen>
		</div>
	);
}

function LandingBody() {
	const {landingStats, landingPosts, landingTerms} = useRequest(landingRequest);
	const stats = useView(LandingStatsView, landingStats);
	const [postItems] = useListView(PostConnectionView, landingPosts);
	const [termItems] = useListView(TermConnectionView, landingTerms);

	return (
		<>
			<div className="kp-landing__cols">
				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>panoda son 24 saat</h3>
						<Link to="/pano">hepsini gör →</Link>
					</header>
					<ul>
						{postItems.length === 0 ? (
							<li className="kp-landing-row">
								<span className="kp-landing-row__rank">·</span>
								<div>
									<span className="kp-landing-row__meta">henüz başlık yok.</span>
								</div>
							</li>
						) : (
							postItems.map(({node}, i) => (
								<LandingPostRow key={String(node.id)} node={node} rank={i + 1} />
							))
						)}
					</ul>
				</section>

				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>sözlüğe son eklenenler</h3>
						<Link to="/sozluk">hepsini gör →</Link>
					</header>
					<ul>
						{termItems.length === 0 ? (
							<li className="kp-landing-row">
								<span className="kp-landing-row__rank">·</span>
								<div>
									<span className="kp-landing-row__meta">henüz terim yok.</span>
								</div>
							</li>
						) : (
							termItems.map(({node}) => <LandingTermRow key={String(node.id)} node={node} />)
						)}
					</ul>
				</section>
			</div>

			<div className="kp-landing__stats" data-testid="kp-landing-stats">
				{[
					{value: formatStat(stats.totalDefinitions), label: "tanım"},
					{value: formatStat(stats.totalPosts), label: "başlık"},
					{value: formatStat(stats.totalAuthors), label: "yazar"},
					{value: formatStat(stats.totalComments), label: "yorum"},
					{value: stats.version, label: "phoenix"},
				].map((stat) => (
					<div key={stat.label} className="kp-landing__stat" data-testid={`stat-${stat.label}`}>
						<div className="n">{stat.value}</div>
						<div className="l">{stat.label}</div>
					</div>
				))}
			</div>
		</>
	);
}

function LandingPostRow({node, rank}: {node: ViewRef<"Post">; rank: number}) {
	const p = useView(LandingPostView, node);
	return (
		<li className="kp-landing-row">
			<span className="kp-landing-row__rank">{String(rank).padStart(2, "0")}</span>
			<div>
				<Link className="kp-landing-row__title" to={`/pano/${p.slug ?? p.id}`}>
					{p.title}
				</Link>
				<div className="kp-landing-row__meta">
					<span>{p.score} oy</span>
					<span className="dot">·</span>
					<span className="author">@{p.author}</span>
					<span className="dot">·</span>
					<span>{formatAgoTR(toIso(p.createdAt))}</span>
					<span className="dot">·</span>
					<span>{p.commentCount} yorum</span>
				</div>
			</div>
		</li>
	);
}

function LandingTermRow({node}: {node: ViewRef<"Term">}) {
	const t = useView(LandingTermView, node);
	return (
		<li className="kp-landing-row">
			<span className="kp-landing-row__rank">·</span>
			<div>
				<Link className="kp-landing-row__title" to={`/sozluk/${t.slug}`}>
					{t.title}
					{t.excerpt ? <span className="gloss"> — {t.excerpt}</span> : null}
				</Link>
				<div className="kp-landing-row__meta">
					{t.lastActivityAt ? (
						<>
							<span>{formatAgoTR(toIso(t.lastActivityAt))}</span>
							<span className="dot">·</span>
						</>
					) : null}
					<span>{t.definitionCount} tanım</span>
				</div>
			</div>
		</li>
	);
}

function LandingColsSkeleton({status}: {status: "loading" | "error"}) {
	const label = status === "loading" ? "yükleniyor…" : "şu an yüklenemedi";
	return (
		<div className="kp-landing__cols">
			<section className="kp-landing__col">
				<header className="kp-landing__col-head">
					<h3>panoda son 24 saat</h3>
					<Link to="/pano">hepsini gör →</Link>
				</header>
				<ul>
					<li className="kp-landing-row">
						<span className="kp-landing-row__rank">·</span>
						<div>
							<span className="kp-landing-row__meta">{label}</span>
						</div>
					</li>
				</ul>
			</section>
			<section className="kp-landing__col">
				<header className="kp-landing__col-head">
					<h3>sözlüğe son eklenenler</h3>
					<Link to="/sozluk">hepsini gör →</Link>
				</header>
				<ul>
					<li className="kp-landing-row">
						<span className="kp-landing-row__rank">·</span>
						<div>
							<span className="kp-landing-row__meta">{label}</span>
						</div>
					</li>
				</ul>
			</section>
		</div>
	);
}

function LandingBodyFallback() {
	return (
		<>
			<LandingColsSkeleton status="loading" />
			<div className="kp-landing__stats" data-testid="kp-landing-stats-loading">
				{["tanım", "başlık", "yazar", "yorum", "phoenix"].map((label) => (
					<div key={label} className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">{label}</div>
					</div>
				))}
			</div>
		</>
	);
}

function LandingBodyError() {
	return (
		<>
			<LandingColsSkeleton status="error" />
			<div className="kp-landing__stats" data-testid="kp-landing-stats-error">
				<div className="kp-landing__stat">
					<div className="n">—</div>
					<div className="l">istatistikler şu an yok</div>
				</div>
			</div>
		</>
	);
}
