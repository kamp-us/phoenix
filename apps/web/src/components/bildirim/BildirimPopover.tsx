/**
 * `BildirimPopover` — the topbar status-zone bell as an INTERACTIVE disclosure
 * (#2787). #2613 placed a display-only bell + unread count in the status/signal
 * zone; this turns it into a proper button that opens an in-place popover of
 * recent bildirimler (reusing {@link BildirimList} as the body), with a
 * "tümünü gör" footer to the full `/bildirimler` center page — which stays the
 * canonical "see all" destination, not replaced.
 *
 * a11y: the trigger keeps the unread count as its accessible NAME (#2613 / ADR
 * 0166), and a polite visually-hidden live region preserves the announcement the
 * old `role="status"` bell gave — a button can't also be a live region, so the
 * two roles split. Base UI's Popover supplies the rest (aria-haspopup/expanded on
 * the trigger, Escape-to-close, focus trap + restore).
 */
import {Popover} from "@base-ui/react/popover";
import {Bell} from "lucide-react";
import {useState} from "react";
import {Link} from "react-router";
import {Screen} from "../../fate/Screen";
import {Icon} from "../Icon";
import {BildirimList} from "./BildirimList";
import {formatUnreadBadge} from "./bildirim";
import "./Bildirim.css";
import "./BildirimPopover.css";

export function BildirimPopover({to, unread}: {to: string; unread: number}) {
	const [open, setOpen] = useState(false);
	const label = `${unread} okunmamış bildirim`;

	return (
		<>
			{/* The live-unread announcement #2613's status bell carried — preserved as a
			    polite region since the interactive trigger below is a button, not a status. */}
			<span role="status" className="kp-visually-hidden">
				{label}
			</span>
			<Popover.Root open={open} onOpenChange={setOpen}>
				<Popover.Trigger
					className="kp-bildirim-pop__trigger"
					data-testid="topbar-bildirim-badge"
					aria-label={label}
				>
					<Icon icon={Bell} size={16} />
					<span className="kp-bildirim-pop__count" aria-hidden="true">
						{formatUnreadBadge(unread)}
					</span>
				</Popover.Trigger>
				<Popover.Portal>
					{/* z-index on the Positioner (the fixed portal-root), not the static Popup —
					    the same stacking-context rule the Menu/Tooltip wrappers document (#2041/#2046). */}
					<Popover.Positioner
						className="kp-bildirim-pop__positioner"
						side="bottom"
						align="end"
						sideOffset={6}
						positionMethod="fixed"
					>
						<Popover.Popup className="kp-bildirim-pop__popup" data-testid="topbar-bildirim-popover">
							<header className="kp-bildirim-pop__head">
								<Popover.Title className="kp-bildirim-pop__title">bildirimler</Popover.Title>
							</header>
							<div className="kp-bildirim-pop__body">
								<Screen
									fallback={<p className="kp-bildirim__loading">yükleniyor…</p>}
									error={({code}) => (
										<p className="kp-bildirim__error" role="alert">
											{code === "UNAUTHORIZED" || code === "FORBIDDEN"
												? "bildirimlerini görmek için giriş yapmalısın."
												: "bildirimler yüklenemedi, tekrar dene."}
										</p>
									)}
								>
									<BildirimList />
								</Screen>
							</div>
							<footer className="kp-bildirim-pop__foot">
								<Link
									to={to}
									className="kp-bildirim-pop__see-all"
									data-testid="topbar-bildirim-see-all"
									onClick={() => setOpen(false)}
								>
									tümünü gör
								</Link>
							</footer>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		</>
	);
}
