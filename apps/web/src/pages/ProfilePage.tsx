import {useState} from "react";
import {Navigate} from "react-router";
import {authClient, clearBearerToken, useSession} from "../auth/client";
import "./ProfilePage.css";

type ThemeChoice = "light" | "dark" | "auto";

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

export function ProfilePage() {
	const session = useSession();
	const [themeChoice, setThemeChoice] = useState<ThemeChoice>("dark");

	if (session.isPending) return null;
	if (!session.data) return <Navigate to="/auth" replace />;

	const u = session.data.user;
	const name = u.name ?? u.email.split("@")[0] ?? "user";
	const handle = u.email.split("@")[0] ?? "user";

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	return (
		<div className="kp-profile">
			<div className="kp-profile__inner">
				<header className="kp-profile__head">
					<div className="kp-profile__avatar">{initialsOf(name)}</div>
					<div className="kp-profile__id">
						<div className="kp-profile__name">{name}</div>
						<div className="kp-profile__handle">@{handle} · yeni üye</div>
					</div>
					<div className="kp-profile__stats-strip">
						<div className="kp-profile__stat">
							<div className="n">0</div>
							<div className="l">başlık</div>
						</div>
						<div className="kp-profile__stat">
							<div className="n">0</div>
							<div className="l">yorum</div>
						</div>
						<div className="kp-profile__stat">
							<div className="n">0</div>
							<div className="l">tanım</div>
						</div>
					</div>
				</header>

				<section className="kp-profile__section">
					<h3>hesap</h3>
					<div className="kp-profile__row">
						<span className="label">görünen ad</span>
						<span className="value">
							<input defaultValue={name} />
						</span>
						<button type="button" className="edit-btn">
							kaydet
						</button>
					</div>
					<div className="kp-profile__row">
						<span className="label">kullanıcı adı</span>
						<span className="value">@{handle}</span>
						<span className="edit-btn" style={{color: "var(--text-faint)"}}>
							değiştirilemez
						</span>
					</div>
					<div className="kp-profile__row readonly">
						<span className="label">e-posta</span>
						<span className="value">{u.email}</span>
						<button type="button" className="edit-btn">
							değiştir
						</button>
					</div>
				</section>

				<section className="kp-profile__section">
					<h3>görünüm</h3>
					<div className="kp-profile__row">
						<span className="label">tema</span>
						<span className="value">
							<span className="kp-profile__theme-toggle">
								{(["light", "dark", "auto"] as ThemeChoice[]).map((t) => (
									<button
										key={t}
										type="button"
										aria-pressed={themeChoice === t}
										onClick={() => setThemeChoice(t)}
									>
										{t === "light" ? "açık" : t === "dark" ? "koyu" : "otomatik"}
									</button>
								))}
							</span>
						</span>
						<span />
					</div>
				</section>

				<section className="kp-profile__section">
					<h3>oturum</h3>
					<p>bu cihazda aktif. çıkış yaparak oturumu sonlandırabilirsin.</p>
					<div className="kp-profile__danger">
						<button type="button" onClick={onSignOut}>
							çıkış yap
						</button>
						<button type="button">tüm cihazlardan çık</button>
					</div>
				</section>

				<section className="kp-profile__section kp-profile__section--last">
					<h3 className="danger">tehlikeli alan</h3>
					<p>
						hesabını kaldırırsan başlıkların ve tanımların 30 gün arşivde tutulur, sonra
						silinir. yorumlar @[silinen]'e atanır.
					</p>
					<div className="kp-profile__danger">
						<button type="button" className="danger">
							hesabı kaldır
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}
