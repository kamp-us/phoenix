import {useEffect, useState} from "react";
import {AuthPanel} from "./auth/AuthPanel";
import {authClient, clearBearerToken, useSession} from "./auth/client";
import {AppShell, Main} from "./components/layout/AppShell";
import {Footer} from "./components/layout/Footer";
import {Topbar} from "./components/layout/Topbar";
import {Controls, type ColorTheme, type Density, type Mode} from "./components/controls/Controls";
import {Button} from "./components/ui/Button";
import { Dialog } from "./components/ui/Dialog";
import {Provider as TooltipProvider} from "./components/ui/Tooltip";
import {COMMENTS, POSTS, TERMS} from "./fixtures";
import {PanoCreateDialog} from "./pages/PanoCreateDialog";
import {PanoFeed} from "./pages/PanoFeed";
import {PanoPostDetail} from "./pages/PanoPostDetail";
import {SozlukHome} from "./pages/SozlukHome";

type Route = "pano" | "pano-detail" | "sozluk";

export function App() {
	const session = useSession();
	const [route, setRoute] = useState<Route>("pano");
	const [theme, setTheme] = useState<ColorTheme>("ember");
	const [mode, setMode] = useState<Mode>("dark");
	const [density, setDensity] = useState<Density>("compact");
	const [createOpen, setCreateOpen] = useState(false);
	const [authOpen, setAuthOpen] = useState(false);

	useEffect(() => {
		document.documentElement.dataset.colorTheme = theme;
		document.documentElement.dataset.theme = mode;
		document.documentElement.dataset.density = density;
	}, [theme, mode, density]);

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
					brand="kampüs"
					nav={[
						{
							href: "#pano",
							label: "pano",
							current: route === "pano" || route === "pano-detail",
						},
						{href: "#sozluk", label: "sözlük", current: route === "sozluk"},
					]}
					{...userProps}
					onLogout={onSignOut}
					actions={
						<>
							<Button variant="tertiary" onClick={() => setRoute("pano")}>
								pano
							</Button>
							<Button variant="tertiary" onClick={() => setRoute("pano-detail")}>
								başlık
							</Button>
							<Button variant="tertiary" onClick={() => setRoute("sozluk")}>
								sözlük
							</Button>
							{isSignedIn ? (
								<Button variant="primary" onClick={() => setCreateOpen(true)}>
									+ ekle
								</Button>
							) : (
								<Button variant="primary" onClick={() => setAuthOpen(true)}>
									giriş
								</Button>
							)}
						</>
					}
				/>
				<div
					style={{
						display: "flex",
						justifyContent: "flex-end",
						gap: "var(--s-3)",
						padding: "var(--s-2) var(--s-4)",
						borderBottom: "1px solid var(--border-faint)",
					}}
				>
					<Controls
						theme={theme}
						onThemeChange={setTheme}
						mode={mode}
						onModeChange={setMode}
						density={density}
						onDensityChange={setDensity}
					/>
				</div>
				<Main>
					{route === "pano" ? <PanoFeed posts={POSTS} /> : null}
					{route === "pano-detail" && POSTS[0] ? (
						<PanoPostDetail post={POSTS[0]} comments={COMMENTS} />
					) : null}
					{route === "sozluk" ? <SozlukHome terms={TERMS} /> : null}
				</Main>
				<Footer />
				<PanoCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
				<Dialog.Root open={authOpen} onOpenChange={setAuthOpen}>
					<Dialog.Popup>
						<Dialog.Head title="giriş" description="kampüs hesabı" />
						<Dialog.Body>
							<AuthPanel />
						</Dialog.Body>
					</Dialog.Popup>
				</Dialog.Root>
			</AppShell>
		</TooltipProvider>
	);
}
