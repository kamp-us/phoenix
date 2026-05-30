import {useRequest, useView, view} from "react-fate";
import {Link} from "react-router";
import type {LandingStats} from "../../worker/features/fate/views";
import type {PanoPostData} from "../components/pano";
import type {TermRow} from "../components/sozluk";
import {Screen} from "../fate/Screen";
import "./LandingPage.css";

export type LandingTerm = TermRow & {
	gloss?: string;
	author?: string;
	agoLabel?: string;
};

/**
 * The landing-stats selection — the four counters + the build `version` the SPA
 * renders. `LandingStats` is a singleton entity (constant `id`) served by the
 * `queries.landingStats` client root.
 */
const LandingStatsView = view<LandingStats>()({
	id: true,
	totalDefinitions: true,
	totalPosts: true,
	totalComments: true,
	totalAuthors: true,
	version: true,
});

function formatStat(n: number): string {
	if (n < 1000) return String(n);
	// Turkish convention: thousands separator is `.` (e.g. 1.247).
	return n.toLocaleString("tr-TR");
}

function LiveStats() {
	const {landingStats} = useRequest({landingStats: {view: LandingStatsView}});
	const s = useView(LandingStatsView, landingStats);
	const stats = [
		{value: formatStat(s.totalDefinitions), label: "tanım"},
		{value: formatStat(s.totalPosts), label: "başlık"},
		{value: formatStat(s.totalAuthors), label: "yazar"},
		{value: formatStat(s.totalComments), label: "yorum"},
		{value: s.version, label: "phoenix"},
	];
	return (
		<div className="kp-landing__stats" data-testid="kp-landing-stats">
			{stats.map((stat) => (
				<div key={stat.label} className="kp-landing__stat" data-testid={`stat-${stat.label}`}>
					<div className="n">{stat.value}</div>
					<div className="l">{stat.label}</div>
				</div>
			))}
		</div>
	);
}

function LandingStatsSection() {
	return (
		<Screen
			fallback={
				<div className="kp-landing__stats" data-testid="kp-landing-stats-loading">
					<div className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">tanım</div>
					</div>
					<div className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">başlık</div>
					</div>
					<div className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">yazar</div>
					</div>
					<div className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">yorum</div>
					</div>
					<div className="kp-landing__stat">
						<div className="n">…</div>
						<div className="l">phoenix</div>
					</div>
				</div>
			}
			error={() => (
				<div className="kp-landing__stats" data-testid="kp-landing-stats-error">
					<div className="kp-landing__stat">
						<div className="n">—</div>
						<div className="l">istatistikler şu an yok</div>
					</div>
				</div>
			)}
		>
			<LiveStats />
		</Screen>
	);
}

export function LandingPage({posts, terms}: {posts: PanoPostData[]; terms: LandingTerm[]}) {
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
				</div>
				<div className="kp-landing__cta">
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

			<div className="kp-landing__cols">
				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>panoda son 24 saat</h3>
						<Link to="/pano">hepsini gör →</Link>
					</header>
					<ul>
						{posts.slice(0, 5).map((p, i) => (
							<li key={p.id} className="kp-landing-row">
								<span className="kp-landing-row__rank">{String(i + 1).padStart(2, "0")}</span>
								<div>
									<Link className="kp-landing-row__title" to={`/pano/${p.id}`}>
										{p.title}
									</Link>
									<div className="kp-landing-row__meta">
										<span>{p.score} oy</span>
										<span className="dot">·</span>
										<span className="author">@{p.author}</span>
										<span className="dot">·</span>
										<span>{p.agoLabel}</span>
										<span className="dot">·</span>
										<span>{p.commentCount} yorum</span>
									</div>
								</div>
							</li>
						))}
					</ul>
				</section>

				<section className="kp-landing__col">
					<header className="kp-landing__col-head">
						<h3>sözlüğe son eklenenler</h3>
						<Link to="/sozluk">hepsini gör →</Link>
					</header>
					<ul>
						{terms.slice(0, 5).map((t) => (
							<li key={t.slug} className="kp-landing-row">
								<span className="kp-landing-row__rank">·</span>
								<div>
									<Link className="kp-landing-row__title" to={`/sozluk/${t.slug}`}>
										{t.title}
										{t.gloss ? <span className="gloss"> — {t.gloss}</span> : null}
									</Link>
									<div className="kp-landing-row__meta">
										{t.author ? (
											<>
												<span className="author">@{t.author}</span>
												<span className="dot">·</span>
											</>
										) : null}
										{t.agoLabel ? (
											<>
												<span>{t.agoLabel}</span>
												<span className="dot">·</span>
											</>
										) : null}
										<span>{t.count} tanım</span>
									</div>
								</div>
							</li>
						))}
					</ul>
				</section>
			</div>

			<LandingStatsSection />
		</div>
	);
}
