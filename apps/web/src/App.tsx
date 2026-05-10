import {useEffect, useState} from "react";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {COMMENTS, POSTS, TERMS} from "./fixtures";
import {AuthPage} from "./pages/AuthPage";
import {PanoCreateDialog} from "./pages/PanoCreateDialog";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {SozlukHome} from "./pages/SozlukHome";

type Route = "pano" | "pano-detail" | "sozluk" | "auth";
type Mode = "dark" | "light";

export function App() {
	const session = useSession();
	const [route, setRoute] = useState<Route>("pano");
	const [mode, setMode] = useState<Mode>("dark");
	const [createOpen, setCreateOpen] = useState(false);

	useEffect(() => {
		document.documentElement.dataset.theme = mode;
		/* color theme + density default to ember/compact via index.html attrs;
		   no in-product picker yet — bring back the Controls strip if/when needed. */
	}, [mode]);

	useEffect(() => {
		if (session.data && route === "auth") setRoute("pano");
	}, [session.data, route]);

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	const userProps = session.data?.user
		? {user: {name: session.data.user.name ?? session.data.user.email.split("@")[0] ?? "user"}}
		: {};
	const isSignedIn = !!session.data;

	return (
		<TooltipProvider>
			<AppShell>
				<Topbar
					brandName="kamp.us"
					nav={[
						{
							href: "#pano",
							label: "pano",
							current: route === "pano" || route === "pano-detail",
						},
						{href: "#sozluk", label: "sözlük", current: route === "sozluk"},
					]}
					{...userProps}
					onBrandClick={() => setRoute("pano")}
					onToggleTheme={() => setMode(mode === "dark" ? "light" : "dark")}
					onLogout={onSignOut}
					actions={
						isSignedIn ? (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => setCreateOpen(true)}
							>
								+ gönderi
							</button>
						) : (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => setRoute("auth")}
							>
								giriş yap
							</button>
						)
					}
				/>
				<Main>
					{route === "auth" ? <AuthPage /> : null}
					{route === "pano" ? <PanoFeed posts={POSTS} /> : null}
					{route === "pano-detail" && POSTS[0] ? (
						<PanoPostDetail post={POSTS[0]} comments={COMMENTS} />
					) : null}
					{route === "sozluk" ? <SozlukHome terms={TERMS} /> : null}
				</Main>
				<Footer />
				<PanoCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
			</AppShell>
		</TooltipProvider>
	);
}
