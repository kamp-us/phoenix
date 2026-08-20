/**
 * `BildirimPopover` — the topbar status-zone bell as an interactive disclosure (#2787).
 *
 * A button can't also be a live region, so the two roles split: the trigger keeps the
 * unread count as its accessible name, and the separate visually-hidden `role="status"`
 * span preserves the announcement the old display-only bell gave (#2613).
 */
import {Bell} from "lucide-react";
import {useState} from "react";
import {Link} from "react-router";
import {Screen} from "../../fate/Screen";
import {Icon} from "../Icon";
import {Alert} from "../ui/Alert";
import {Badge} from "../ui/Badge";
import {Button} from "../ui/Button";
import {Popover} from "../ui/Popover";
import {ScrollArea} from "../ui/ScrollArea";
import {BildirimList} from "./BildirimList";
import {formatUnreadBadge} from "./bildirim";
import "./Bildirim.css";
import "./BildirimPopover.css";

export function BildirimPopover({to, unread}: {to: string; unread: number}) {
	const [open, setOpen] = useState(false);
	const label = `${unread} okunmamış bildirim`;

	return (
		<>
			<span role="status" className="kp-visually-hidden">
				{label}
			</span>
			<Popover
				open={open}
				onOpenChange={setOpen}
				placement="bottom-end"
				className="kp-bildirim-pop__popup"
				title={<span className="kp-bildirim-pop__title">bildirimler</span>}
				trigger={
					<Button
						type="button"
						variant="tertiary"
						size="sm"
						iconOnly
						className="kp-bildirim-pop__trigger"
						data-testid="topbar-bildirim-badge"
						aria-label={label}
					>
						<Icon icon={Bell} size={16} />
						<Badge
							variant="secondary"
							size="sm"
							className="kp-bildirim-pop__count"
							aria-hidden="true"
						>
							{formatUnreadBadge(unread)}
						</Badge>
					</Button>
				}
			>
				<ScrollArea
					orientation="vertical"
					type="auto"
					className="kp-bildirim-pop__body"
					data-testid="topbar-bildirim-popover"
				>
					<Screen
						fallback={<p className="kp-bildirim__loading">yükleniyor…</p>}
						error={({code}) => (
							<Alert variant="danger" className="kp-alert--inline kp-bildirim__error">
								{code === "UNAUTHORIZED" || code === "FORBIDDEN"
									? "bildirimlerini görmek için giriş yapmalısın."
									: "bildirimler yüklenemedi, tekrar dene."}
							</Alert>
						)}
					>
						<BildirimList />
					</Screen>
				</ScrollArea>
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
			</Popover>
		</>
	);
}
