import {useEffect, useState} from "react";
import {Outlet, Route, Routes, useLocation, useNavigate, useParams} from "react-router";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {useMe} from "./auth/useMe";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {LANDING_TERMS, POSTS} from "./fixtures";
import {AuthPage} from "./pages/AuthPage";
import {LandingPage} from "./pages/LandingPage";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {PanoSubmitPage} from "./pages/PanoSubmitPage";
import {ProfilePage} from "./pages/ProfilePage";
import {SozlukHome} from "./pages/SozlukHome";
import {SozlukTermPage} from "./pages/SozlukTermPage";
import {UsernameBootstrap} from "./pages/UsernameBootstrap";
import {UserProfilePage} from "./pages/UserProfilePage";

type Mode = "dark" | "light";

function Layout() {
	const session = useSession();
	const {me, refetch} = useMe();
	const navigate = useNavigate();
	const location = useLocation();
	const [mode, setMode] = useState<Mode>("dark");

	useEffect(() => {
		document.documentElement.dataset.theme = mode;
	}, [mode]);

	useEffect(() => {
		if (session.data && location.pathname === "/auth") navigate("/", {replace: true});
	}, [session.data, location.pathname, navigate]);

	async function onSignOut() {
		await authClient.signOut();
		clearBearerToken();
	}

	const sessionUser = session.data?.user;
	const fallbackName = sessionUser
		? (sessionUser.name ?? sessionUser.email.split("@")[0] ?? "user")
		: "";
	const userProps = sessionUser
		? {
				user: {
					name: me?.name ?? fallbackName,
					username: me?.username ?? null,
				},
			}
		: {};
	const isSignedIn = !!session.data;
	// Bootstrap is required when the session is established but the canonical
	// user row in Pasaport has no username yet. Block the page content until
	// the form is submitted — set-once write so this only happens on first
	// sign-in.
	const needsBootstrap = isSignedIn && me !== null && !me.username && location.pathname !== "/auth";

	return (
		<TooltipProvider>
			<AppShell>
				<Topbar
					brandName="kamp.us"
					nav={[
						{to: "/sozluk", label: "sözlük"},
						{to: "/pano", label: "pano"},
					]}
					{...userProps}
					onToggleTheme={() => setMode(mode === "dark" ? "light" : "dark")}
					onLogout={onSignOut}
					actions={
						isSignedIn ? (
							<button
								type="button"
								className="kp-topbar__btn"
								onClick={() => navigate("/pano/yeni")}
							>
								+ gönderi
							</button>
						) : (
							<button type="button" className="kp-topbar__btn" onClick={() => navigate("/auth")}>
								giriş yap
							</button>
						)
					}
				/>
				<Main>
					{needsBootstrap && sessionUser ? (
						<UsernameBootstrap email={sessionUser.email} onComplete={refetch} />
					) : (
						<Outlet />
					)}
				</Main>
				<Footer />
			</AppShell>
		</TooltipProvider>
	);
}

function PanoSiteFeedRoute() {
	const {host} = useParams<{host: string}>();
	return <PanoFeed {...(host ? {host} : {})} />;
}

export function App() {
	return (
		<Routes>
			<Route element={<Layout />}>
				<Route path="/" element={<LandingPage posts={POSTS} terms={LANDING_TERMS} />} />
				<Route path="/pano" element={<PanoFeed />} />
				<Route path="/pano/yeni" element={<PanoSubmitPage />} />
				<Route path="/pano/site/:host" element={<PanoSiteFeedRoute />} />
				<Route path="/pano/:id" element={<PanoPostDetail />} />
				<Route path="/sozluk" element={<SozlukHome />} />
				<Route path="/sozluk/:slug" element={<SozlukTermPage />} />
				<Route path="/auth" element={<AuthPage />} />
				<Route path="/profile" element={<ProfilePage />} />
				<Route path="/u/:username" element={<UserProfilePage />} />
			</Route>
		</Routes>
	);
}
