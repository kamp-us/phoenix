import {Link} from "react-router";
import type {PanoPostData} from "../components/pano";
import type {TermRow} from "../components/sozluk";
import "./LandingPage.css";

export type LandingTerm = TermRow & {
	gloss?: string;
	author?: string;
	agoLabel?: string;
};

export function LandingPage({
	posts,
	terms,
	stats,
}: {
	posts: PanoPostData[];
	terms: LandingTerm[];
	stats?: {label: string; value: string}[];
}) {
	const defaultStats = stats ?? [
		{value: "1.247", label: "tanım"},
		{value: "8.392", label: "başlık"},
		{value: "412", label: "yazar"},
		{value: "6.201", label: "yorum"},
		{value: "v0.3", label: "phoenix"},
	];

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
						<strong>sözlükte</strong> terimleri kendi cümlelerimizle yazıyoruz. türkçe
						öncelikli; reklam, takipçi sayısı, sansasyon yok — sadece okumaya değer
						şeyler ve onları yazan birkaç yüz kişi.
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

			<div className="kp-landing__stats">
				{defaultStats.map((s) => (
					<div key={s.label} className="kp-landing__stat">
						<div className="n">{s.value}</div>
						<div className="l">{s.label}</div>
					</div>
				))}
			</div>
		</div>
	);
}
