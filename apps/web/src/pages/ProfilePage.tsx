import {useEffect, useRef, useState} from "react";
import {Navigate} from "react-router";
import {authClient, clearBearerToken, useSession} from "../auth/client";
import {type ThemeChoice, useTheme} from "../lib/theme";
import "./ProfilePage.css";

function initialsOf(name: string) {
	return name
		.split(/\s+|_|-/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? "")
		.join("");
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function ProfilePage() {
	const session = useSession();
	const {choice: themeChoice, setChoice: setThemeChoice} = useTheme();
	const [revokingAll, setRevokingAll] = useState(false);
	const [revokeAllError, setRevokeAllError] = useState<string | null>(null);

	const u = session.data?.user;
	const name = u?.name ?? u?.email.split("@")[0] ?? "user";
	const handle = u?.email.split("@")[0] ?? "user";

	const [draftName, setDraftName] = useState(name);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	// better-auth's session atom starts {data:null, isPending:true} and resolves
	// asynchronously with no synchronous hydration, so on a hard load these hooks run
	// before the session is known and `name` is the "user" fallback — draftName would
	// lock to it and never re-seed. Re-seed the draft when the server name changes out
	// from under the draft we're still showing (initial resolution, or another tab's
	// edit), so a refresh shows the saved name. A draft the user has since edited away
	// from the old server name is left alone, and a save's own refetch doesn't fire the
	// reset because draftName already equals the new name — preserving the "saved" note.
	const serverName = useRef(name);
	useEffect(() => {
		if (draftName === serverName.current) setDraftName(name);
		serverName.current = name;
	}, [name, draftName]);

	if (session.isPending) return null;
	if (!session.data || !u) return <Navigate to="/auth" replace />;

	const trimmed = draftName.trim();
	const canSave = saveState !== "saving" && trimmed.length > 0 && trimmed !== name;

	async function onSaveName() {
		const next = draftName.trim();
		if (!next || next === name) return;
		setSaveState("saving");
		const {error} = await authClient.updateUser({name: next});
		if (error) {
			setSaveState("error");
			return;
		}
		await session.refetch();
		setSaveState("saved");
	}

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	// "tüm cihazlardan çık" — the label says ALL devices, so revoke every session
	// (current included) and clear the local bearer like onSignOut; the <Navigate>
	// guard then lands the now-sessionless user on /auth.
	async function onSignOutAll() {
		setRevokingAll(true);
		setRevokeAllError(null);
		const {error} = await authClient.revokeSessions();
		if (error) {
			setRevokeAllError("oturumlar sonlandırılamadı, tekrar dene.");
			setRevokingAll(false);
			return;
		}
		clearBearerToken();
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
							<input
								value={draftName}
								onChange={(e) => {
									setDraftName(e.target.value);
									setSaveState("idle");
								}}
								aria-invalid={saveState === "error"}
								disabled={saveState === "saving"}
							/>
							{saveState === "error" && (
								<span className="kp-profile__feedback error" role="alert">
									kaydedilemedi, tekrar dene
								</span>
							)}
							{saveState === "saved" && <span className="kp-profile__feedback ok">kaydedildi</span>}
						</span>
						<button type="button" className="edit-btn" onClick={onSaveName} disabled={!canSave}>
							{saveState === "saving" ? "kaydediliyor…" : "kaydet"}
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
						<button type="button" onClick={onSignOutAll} disabled={revokingAll}>
							{revokingAll ? "çıkış yapılıyor…" : "tüm cihazlardan çık"}
						</button>
					</div>
					{revokeAllError ? (
						<p className="kp-profile__error" role="alert">
							{revokeAllError}
						</p>
					) : null}
				</section>

				<section className="kp-profile__section kp-profile__section--last">
					<h3 className="danger">tehlikeli alan</h3>
					<p>
						hesabını kaldırırsan başlıkların ve tanımların 30 gün arşivde tutulur, sonra silinir.
						yorumlar @[silinen]'e atanır.
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
