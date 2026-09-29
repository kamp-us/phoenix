/** @jsxRuntime automatic @jsxImportSource react */

import {Button, EmptyState} from "@kampus/design";
import type {AnyWindowRenderer, WindowHost} from "@kampus/tuval-sdk/window";
import {windowRenderer} from "@kampus/tuval-sdk/window";
import {Effect, Fiber, Stream} from "effect";
import type {ReactElement} from "react";
import {useEffect, useRef, useState} from "react";
import {boardSlots, cardArtUrl, minionAbilities} from "./board-layout.ts";
import type {BoardScene, ProjectedSlot} from "./board-scene.ts";
import type {HSBGSpectatorState} from "./hsbg-state.ts";
import {defaultHSBGState, isHSBGSpectatorState} from "./hsbg-state.ts";
import {spectatorStyles} from "./spectator-styles.ts";

export const admits = isHSBGSpectatorState;
export type HSBGHost = WindowHost<HSBGSpectatorState>;

const useHSBGState = (host: HSBGHost): HSBGSpectatorState | null => {
	const [state, setState] = useState<HSBGSpectatorState | null>(null);
	const read = host.readProcess;
	useEffect(() => {
		const fiber = Effect.runFork(
			Stream.runForEach(read, (view) =>
				Effect.sync(() => {
					if (view._tag === "Live") setState(view.state);
				}),
			),
		);
		return () => void Effect.runFork(Fiber.interrupt(fiber));
	}, [read]);
	return state;
};

function Board({
	state,
	selected,
	onSelect,
}: {
	readonly state: HSBGSpectatorState;
	readonly selected: string | null;
	readonly onSelect: (key: string) => void;
}): ReactElement {
	const canvas = useRef<HTMLCanvasElement>(null);
	const runtime = useRef<BoardScene | null>(null);
	const latest = useRef(state);
	latest.current = state;
	const [layout, setLayout] = useState<ReadonlyArray<ProjectedSlot>>([]);
	const [fallback, setFallback] = useState(false);
	const [assetError, setAssetError] = useState(false);
	useEffect(() => {
		let active = true;
		const element = canvas.current;
		if (!element) return;
		const lost = () => {
			runtime.current?.dispose();
			runtime.current = null;
			setFallback(true);
		};
		element.addEventListener("webglcontextlost", lost);
		void import("./board-scene.ts")
			.then(({createBoardScene}) => {
				if (!active) return;
				runtime.current = createBoardScene(element, latest.current, setLayout, () =>
					setAssetError(true),
				);
			})
			.catch(() => {
				if (active) setFallback(true);
			});
		return () => {
			active = false;
			element.removeEventListener("webglcontextlost", lost);
			runtime.current?.dispose();
			runtime.current = null;
		};
	}, []);
	useEffect(() => {
		runtime.current?.update(state);
	}, [state]);
	const slots = boardSlots(state);
	const hasCards = slots.some((slot) => slot.minion);
	return (
		<div className="hsbg-board-scroll">
			<section className="hsbg-board" data-fallback={fallback} aria-label="Battlegrounds board">
				<canvas ref={canvas} aria-hidden="true" tabIndex={-1} />
				<div
					className="hsbg-row-label hsbg-row-label--upper"
					style={{top: `calc(${layout.find((slot) => slot.key === "upper-0")?.y ?? 33}% - 100px)`}}
				>
					{state.phase === "COMBAT"
						? `${state.p1.opponent_hero || "Opponent"} · enemy warband`
						: "Bob’s tavern · shop"}
				</div>
				<div
					className="hsbg-row-label hsbg-row-label--player"
					style={{top: `calc(${layout.find((slot) => slot.key === "player-0")?.y ?? 68}% - 100px)`}}
				>
					Your warband · {state.p1.board.length} / 7
				</div>
				{slots.map((slot) => {
					const projection = layout.find((item) => item.key === slot.key);
					const position = projection ?? {
						x: 14 + slot.index * 12,
						y: slot.row === "upper" ? 33 : 68,
						width: 88,
					};
					const m = slot.minion;
					const abilities = m ? minionAbilities(m) : [];
					const isSpell = m?.card_type === "SPELL" || m?.tribe === "Tavern Spell";
					return (
						<div
							key={slot.key}
							className="hsbg-slot"
							style={{left: `${position.x}%`, top: `${position.y}%`, width: position.width}}
						>
							{m ? (
								<button
									type="button"
									className="hsbg-token"
									aria-pressed={selected === slot.key}
									aria-label={`${m.name}, ${isSpell ? `${m.cost ?? 1} gold spell` : `${m.attack} attack, ${m.health} health, tier ${m.tier || 1}`}${abilities.length ? `, ${abilities.join(", ")}` : ""}`}
									onMouseEnter={() => runtime.current?.hover(slot.key)}
									onMouseLeave={() => runtime.current?.hover(null)}
									onFocus={() => runtime.current?.hover(slot.key)}
									onBlur={() => runtime.current?.hover(null)}
									onClick={() => {
										onSelect(slot.key);
									}}
								>
									<span className="hsbg-portrait">
										<img
											key={m.card_id}
											className="hsbg-portrait-image"
											src={cardArtUrl(m.card_id)}
											alt=""
											onError={(event) => {
												event.currentTarget.style.visibility = "hidden";
											}}
										/>
									</span>
									<span className="hsbg-tier" aria-hidden="true">
										{isSpell ? "Spell" : `T${m.tier || 1}`}
									</span>
									<span className="hsbg-token-name" aria-hidden="true">
										{m.name}
									</span>
									<span className="hsbg-token-stats" aria-hidden="true">
										{isSpell ? (
											<span className="hsbg-spell-cost">{m.cost ?? 1} gold</span>
										) : (
											<>
												<span className="hsbg-stat hsbg-stat--attack">{m.attack}</span>
												<span className="hsbg-token-abilities">
													{[
														m.divine_shield && "DS",
														m.taunt && "T",
														m.reborn && "R",
														m.poisonous && "P",
													]
														.filter(Boolean)
														.join(" · ")}
												</span>
												<span className="hsbg-stat hsbg-stat--health">{m.health}</span>
											</>
										)}
									</span>
								</button>
							) : (
								<div className="hsbg-slot-empty">
									<span>{slot.index + 1}</span>
								</div>
							)}
						</div>
					);
				})}
				{!hasCards && (
					<div className="hsbg-empty-overlay">
						<EmptyState
							title={state.isConnected ? "Waiting for the board" : "Take a seat at the tavern"}
							description={
								state.isConnected
									? "Minions will appear when the next snapshot arrives."
									: "Connect a room or local bridge to watch a match."
							}
						/>
					</div>
				)}
				{(fallback || assetError) && (
					<p className="hsbg-board-notice" role="status">
						{fallback
							? "3D unavailable. Showing the readable board view."
							: "Table detail unavailable. Live cards remain available."}
					</p>
				)}
			</section>
		</div>
	);
}

export function HSBGSpectatorView({
	state,
	onConnect,
}: {
	readonly state: HSBGSpectatorState;
	readonly onConnect: (url: string) => void;
}): ReactElement {
	const [inputUrl, setInputUrl] = useState(state.streamUrl);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const selected = boardSlots(state).find((slot) => slot.key === selectedKey)?.minion;
	const combat = state.phase === "COMBAT";
	const player = state.p1;
	useEffect(() => {
		setInputUrl(state.streamUrl);
	}, [state.streamUrl]);
	useEffect(() => {
		setSelectedKey(null);
	}, [state.phase]);
	return (
		<section
			className="hsbg-spectator"
			data-theme="dark"
			aria-label="Hearthstone Battlegrounds spectator"
		>
			<style>{spectatorStyles}</style>
			<header className="hsbg-toolbar">
				<div className="hsbg-brand">
					Battlegrounds<small>Tuval spectator</small>
				</div>
				<span className="hsbg-status" role="status">
					{state.isConnected ? "Connected" : "Disconnected"}
				</span>
				<form
					className="hsbg-connection"
					onSubmit={(event) => {
						event.preventDefault();
						if (inputUrl.trim()) onConnect(inputUrl.trim());
					}}
				>
					<input
						aria-label="Room code or bridge URL"
						placeholder="Room code or bridge URL"
						value={inputUrl}
						onChange={(event) => setInputUrl(event.target.value)}
					/>
					<Button type="submit" variant="secondary">
						Connect
					</Button>
				</form>
			</header>
			{state.error && (
				<div className="hsbg-error" role="alert">
					Connection interrupted: {state.error}. The last received board is shown.
				</div>
			)}
			<div className="hsbg-main">
				<main className="hsbg-arena">
					<div className="hsbg-matchbar">
						<div>
							<span className="hsbg-phase">{combat ? "Combat" : "Recruit"}</span>
							<h2>
								{combat ? `Facing ${player.opponent_hero || "opponent"}` : "Choose your next move"}
							</h2>
						</div>
						<div className="hsbg-round">
							Turn<strong>{state.turn}</strong>
						</div>
					</div>
					<Board state={state} selected={selectedKey} onSelect={setSelectedKey} />
					<div className="hsbg-playerbar">
						<div className="hsbg-player-name">
							<small>Your hero</small>
							<strong>{player.name}</strong>
						</div>
						<div className="hsbg-player-stat">
							<small>Health</small>
							<strong>{player.hp}</strong>
						</div>
						<div className="hsbg-player-stat">
							<small>Armor</small>
							<strong>{player.armor}</strong>
						</div>
						<div className="hsbg-player-stat hsbg-player-stat--gold">
							<small>Gold</small>
							<strong>{combat ? "Locked" : `${player.gold} / ${player.max_gold}`}</strong>
						</div>
						<div className="hsbg-player-stat">
							<small>Tavern</small>
							<strong>Tier {player.tavern_tier}</strong>
						</div>
						{!combat && (
							<div className="hsbg-player-stat">
								<small>Upgrade</small>
								<strong>{player.tavern_upgrade_cost}g</strong>
							</div>
						)}
					</div>
					{!state.isConnected && player.board.length > 0 && (
						<p className="hsbg-offline-note">Disconnected · showing the last received snapshot.</p>
					)}
				</main>
				<aside className="hsbg-advisor" aria-label="Jev recruit advice">
					<div className="hsbg-advisor-heading">
						<h2>{combat ? "Last recruit plan" : "Recruit plan"}</h2>
						<small>JEV · {state.best_line?.source || "jev-latest"}</small>
					</div>
					{combat && (
						<p className="hsbg-advice-note">
							Recruit advice is paused during combat. This is the previous plan.
						</p>
					)}
					{state.best_line ? (
						<>
							<div className="hsbg-advice-summary">
								<span>
									Score<strong>{state.best_line.score.toFixed(1)} / 10</strong>
								</span>
								<span>
									Confidence<strong>{Math.round(state.best_line.confidence * 100)}%</strong>
								</span>
							</div>
							<ol className="hsbg-actions">
								{state.best_line.actions.map((action, index) => (
									<li key={`${index}-${action}`}>{action}</li>
								))}
							</ol>
						</>
					) : (
						<EmptyState
							title={combat ? "Watching combat" : "Waiting for advice"}
							description={
								combat
									? "The next recruit plan appears in the tavern phase."
									: "Jev recommendations appear when supplied by the stream."
							}
						/>
					)}
					{state.runner_up && state.runner_up.actions.length > 0 && (
						<details className="hsbg-runner">
							<summary>Alternative · {state.runner_up.score.toFixed(1)} / 10</summary>
							<ol>
								{state.runner_up.actions.map((action, index) => (
									<li key={`${index}-${action}`}>{action}</li>
								))}
							</ol>
						</details>
					)}
					<div className="hsbg-inspector" aria-live="polite">
						{selected ? (
							<>
								<h3>{selected.name}</h3>
								<small>
									Tier {selected.tier || 1} · {selected.tribe || "Neutral"}
								</small>
								<p>{minionAbilities(selected).join(" · ") || "No listed keywords"}</p>
								<p>
									{selected.card_type === "SPELL"
										? `${selected.cost ?? 1} gold`
										: `${selected.attack} attack · ${selected.health} health`}
								</p>
							</>
						) : (
							<>
								<h3>Inspect a minion</h3>
								<p>Select a piece to read its stats and keywords. The board is read-only.</p>
							</>
						)}
					</div>
				</aside>
			</div>
		</section>
	);
}

export function HSBGSpectatorWindow({host}: {readonly host: HSBGHost}): ReactElement {
	const state = useHSBGState(host);
	return (
		<HSBGSpectatorView
			state={state ?? defaultHSBGState}
			onConnect={(url) => {
				void Effect.runFork(host.dispatch({type: "set_stream_url", url}));
			}}
		/>
	);
}

const renderer: AnyWindowRenderer = windowRenderer("module", (host: HSBGHost) => (
	<HSBGSpectatorWindow host={host} />
));
export default renderer;
