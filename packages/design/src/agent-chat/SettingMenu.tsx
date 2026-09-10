import {ChevronDown, ChevronUp, type LucideIcon} from "lucide-react";
import {useState} from "react";
import {Button} from "../Button";
import {useDesignT} from "../i18n";
import {Menu} from "../Menu";
import {Icon} from "./Icon";
import "./SettingMenu.css";

/** One row of a settings picker. Exported as `AgentSettingItem`, which is what a host's slot binds. */
export interface PickerItem {
	readonly value: string;
	readonly label: string;
	/** Secondary text beside the label, for a row the label alone does not tell apart. */
	readonly note?: string;
	readonly icon?: LucideIcon;
}

export interface SettingMenuProps {
	/** The control's accessible name, and the group heading inside the menu. */
	readonly label: string;
	/**
	 * What the host offers, or `undefined` while the offer is unresolved. `[]` is a resolved answer
	 * — the host knows and offers nothing — and reads that way rather than as loading (#8425).
	 */
	readonly items: readonly PickerItem[] | undefined;
	readonly value?: string;
	/**
	 * The selection as the host describes it, for when `items` carries no row for it — a pick held
	 * with no live catalog behind it (#8542). The trigger names this rather than the empty offer's
	 * copy, so the control never contradicts the selection the host is holding.
	 */
	readonly held?: PickerItem;
	readonly onValueChange: (value: string) => void;
	readonly disabled?: boolean;
}

/**
 * One settings picker of the composer's fieldset. Exported as `AgentSettingMenu` so a host filling
 * the `settings` slot builds its control out of this rather than reaching for a bare `Select`,
 * which would put a differently-shaped control in a row of these.
 */
export function SettingMenu({
	label,
	items,
	value,
	held,
	onValueChange,
	disabled,
}: SettingMenuProps) {
	const t = useDesignT();
	const [open, setOpen] = useState(false);
	// The highlight is ours to drive, not the machine's: Zag clears it on close and re-seeds it to
	// row 1 on the next open, so a catalogue taller than the popover always opens away from the
	// checked row. Seeding it to `value` at the open makes the machine's own scroll-into-view land
	// there and the first arrow key move from there. See ADR 0361.
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const offered = items ?? [];
	// Three unselected states, and only the first is loading: `undefined` items is a host that has
	// not resolved what it offers, `[]` is one that resolved and offers nothing, and a populated
	// list with no `value` is a setting the session has not picked yet (#8190, #8425). Reading the
	// middle one as loading left an operator waiting on rows that were never coming.
	const unselectedName = t(
		items === undefined
			? "admin.agent.picker.loading"
			: items.length === 0
				? "admin.agent.picker.empty"
				: "admin.agent.picker.none",
	);
	// A pick the offer carries no row for is still a pick: the trigger names it and the empty copy
	// rides as its note, so an operator reads both what is held and that nothing live sits behind
	// it. A control that showed the copy alone said the opposite of the model it was on (#8542).
	const selected =
		offered.find((item) => item.value === value) ??
		(held !== undefined && held.value === value ? {...held, note: unselectedName} : undefined);
	// Nothing to pick is nothing to open, either way round: an unresolved offer has no rows yet and
	// a resolved-empty one never will, so the trigger does not advertise an operation the host
	// cannot perform. `disabled` from the host still wins on top of this.
	const operable = offered.length > 0;
	const selectedName = selected
		? selected.note
			? `${selected.label} (${selected.note})`
			: selected.label
		: unselectedName;
	return (
		<Menu
			open={open}
			onOpenChange={(next) => {
				if (next) setHighlighted(value ?? null);
				setOpen(next);
			}}
			highlightedValue={highlighted}
			onHighlightChange={setHighlighted}
			placement="top-start"
			ariaLabel={label}
			className="kp-agent-chat__picker-menu"
			trigger={
				<Button
					type="button"
					variant="tertiary"
					size="sm"
					className="kp-agent-chat__picker-trigger"
					aria-label={`${label}: ${selectedName}`}
					disabled={disabled || !operable}
				>
					{selected?.icon ? <Icon icon={selected.icon} size={14} /> : null}
					<span>{selected?.label ?? unselectedName}</span>
					{selected?.note ? (
						<span className="kp-agent-chat__picker-note">{selected.note}</span>
					) : null}
					<Icon icon={open ? ChevronUp : ChevronDown} size={14} />
				</Button>
			}
			items={[
				{
					type: "group",
					label,
					items: offered.map((item) => ({
						type: "radio",
						value: item.value,
						label: item.note ? (
							<span className="kp-agent-chat__picker-option">
								<span>{item.label}</span>
								<span className="kp-agent-chat__picker-note">{item.note}</span>
							</span>
						) : (
							item.label
						),
						checked: item.value === value,
						...(item.icon ? {icon: <Icon icon={item.icon} size={16} />} : {}),
					})),
				},
			]}
			onSelect={(nextValue) => {
				onValueChange(nextValue);
				setOpen(false);
			}}
		/>
	);
}
