import {Search} from "lucide-react";
import {
	cloneElement,
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import {Dialog} from "./Dialog";
import {Input} from "./Form";
import "./CommandPalette.css";

export interface CommandPaletteItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly group?: string;
	readonly keywords?: readonly string[];
	readonly icon?: ReactNode;
	readonly shortcut?: string;
	readonly disabled?: boolean;
	/** The `CommandPaletteScope.sigil` this result belongs to. Only read by the default filter. */
	readonly scope?: string;
}

export interface CommandPaletteScope {
	readonly sigil: string;
	readonly label: string;
}

export interface CommandPaletteProps {
	readonly items: readonly CommandPaletteItem[];
	readonly title: string;
	readonly placeholder: string;
	readonly emptyLabel: string;
	readonly loadingLabel?: string;
	readonly loading?: boolean;
	readonly disabled?: boolean;
	readonly trigger?: ReactElement<{disabled?: boolean}>;
	readonly open?: boolean;
	readonly defaultOpen?: boolean;
	readonly onOpenChange?: (open: boolean) => void;
	readonly query?: string;
	readonly defaultQuery?: string;
	readonly onQueryChange?: (query: string) => void;
	readonly onSelect?: (item: CommandPaletteItem) => void;
	readonly filter?: (item: CommandPaletteItem, query: string) => boolean;
	readonly maxResults?: number;
	readonly closeOnSelect?: boolean;
	/** Hand Escape to the caller's own key handling instead of letting the dialog close on it. */
	readonly closeOnEscape?: boolean;
	readonly shortcut?: boolean;
	readonly variant?: "flush" | "inset";
	readonly showSearchIcon?: boolean;
	readonly scopes?: readonly CommandPaletteScope[];
	readonly scopeHintLabel?: string;
	readonly onScopeChange?: (sigil: string | undefined) => void;
	readonly footer?: ReactNode;
	readonly className?: string;
	/**
	 * Runs before the palette's own key handling, with the option `aria-activedescendant` currently
	 * names. Calling `preventDefault` claims the key, so a caller can spend Tab on its own completion
	 * without re-implementing arrow / Home / End movement.
	 */
	readonly onKeyDown?: (
		event: KeyboardEvent<HTMLInputElement>,
		active: CommandPaletteItem | undefined,
	) => void;
	/**
	 * Asked before Enter selects the active item. Returning `true` spends the key on the caller's
	 * action instead; anything else leaves the default — the active item wins — in place.
	 */
	readonly onEnter?: () => boolean;
	/** Reports the option `aria-activedescendant` names, so a caller can describe it beside the list. */
	readonly onActiveChange?: (active: CommandPaletteItem | undefined) => void;
	/** A sentence the polite live region holds until the caller replaces it. */
	readonly announcement?: ReactNode;
	/** A refusal. Its presence marks the field invalid and shows the message under it. */
	readonly error?: ReactNode;
}

const parseScope = (query: string, scopes: readonly CommandPaletteScope[]) => {
	const match = scopes.find((scope) => scope.sigil !== "" && query.startsWith(scope.sigil));
	if (!match) return {scope: undefined, term: query};
	return {scope: match.sigil, term: query.slice(match.sigil.length)};
};

const defaultFilter = (item: CommandPaletteItem, query: string) => {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return true;
	return [item.label, item.description, ...(item.keywords ?? [])]
		.filter((value): value is string => Boolean(value))
		.some((value) => value.toLocaleLowerCase().includes(needle));
};

const nextEnabledIndex = (
	items: readonly CommandPaletteItem[],
	current: number,
	direction: 1 | -1,
) => {
	if (items.length === 0) return -1;
	for (let step = 1; step <= items.length; step += 1) {
		const index = (current + direction * step + items.length) % items.length;
		if (!items[index]?.disabled) return index;
	}
	return -1;
};

/**
 * @component CommandPalette
 * @whenToUse A modal, keyboard-first search surface over a caller-owned result set.
 *   The caller owns copy, filtering overrides and what selecting a result does.
 * @slot trigger Optional element that opens the palette. Rendered disabled, not removed,
 *   when the palette is disabled.
 * @slot footer Optional key legend or contextual hint below the results.
 * @slot announcement Optional sentence for the palette's polite live region, held until the caller
 *   replaces it. It is heard, never seen — the visible copy is the caller's own.
 * @slot error Optional refusal for the search field: the invalid state and the message under it.
 */
export function CommandPalette({
	items,
	title,
	placeholder,
	emptyLabel,
	loadingLabel = emptyLabel,
	loading = false,
	disabled = false,
	trigger,
	open,
	defaultOpen = false,
	onOpenChange,
	query,
	defaultQuery = "",
	onQueryChange,
	onSelect,
	filter,
	maxResults,
	closeOnSelect = true,
	closeOnEscape = true,
	shortcut = true,
	variant = "flush",
	showSearchIcon = true,
	scopes,
	scopeHintLabel,
	onScopeChange,
	footer,
	className = "",
	onKeyDown,
	onEnter,
	onActiveChange,
	announcement,
	error,
}: CommandPaletteProps) {
	const baseId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const keyboardIntentRef = useRef(false);
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const [internalQuery, setInternalQuery] = useState(defaultQuery);
	const [activeIndex, setActiveIndex] = useState(-1);
	const [keyboardFocused, setKeyboardFocused] = useState(false);
	const isOpen = !disabled && (open ?? internalOpen);
	const searchQuery = query ?? internalQuery;

	const setOpen = (next: boolean) => {
		if (disabled && next) return;
		if (open === undefined) setInternalOpen(next);
		onOpenChange?.(next);
	};

	const setQuery = (next: string) => {
		if (query === undefined) setInternalQuery(next);
		onQueryChange?.(next);
	};

	const {scope: activeScope, term} = useMemo(
		() =>
			scopes === undefined
				? {scope: undefined, term: searchQuery}
				: parseScope(searchQuery, scopes),
		[scopes, searchQuery],
	);

	useEffect(() => onScopeChange?.(activeScope), [activeScope, onScopeChange]);

	const visibleItems = useMemo(() => {
		const matches = items.filter((item) =>
			filter
				? filter(item, term)
				: (activeScope === undefined || item.scope === activeScope) && defaultFilter(item, term),
		);
		return maxResults === undefined ? matches : matches.slice(0, Math.max(0, maxResults));
	}, [activeScope, filter, items, maxResults, term]);

	useEffect(() => {
		if (!isOpen) return;
		const currentValue = visibleItems[activeIndex]?.value;
		const preserved = visibleItems.findIndex(
			(item) => item.value === currentValue && !item.disabled,
		);
		setActiveIndex(preserved >= 0 ? preserved : visibleItems.findIndex((item) => !item.disabled));
	}, [isOpen, visibleItems, activeIndex]);

	useEffect(() => {
		if (!isOpen || activeIndex < 0) return;
		document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView({block: "nearest"});
	}, [activeIndex, baseId, isOpen]);

	useEffect(() => {
		onActiveChange?.(activeIndex < 0 ? undefined : visibleItems[activeIndex]);
	}, [activeIndex, visibleItems, onActiveChange]);

	useEffect(() => {
		if (!shortcut) return;
		const handleShortcut = (event: globalThis.KeyboardEvent) => {
			if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) return;
			event.preventDefault();
			setOpen(!isOpen);
		};
		window.addEventListener("keydown", handleShortcut);
		return () => window.removeEventListener("keydown", handleShortcut);
	}, [isOpen, shortcut]);

	useEffect(() => {
		const clearKeyboardIntent = () => {
			keyboardIntentRef.current = false;
		};
		document.addEventListener("pointerdown", clearKeyboardIntent);
		return () => document.removeEventListener("pointerdown", clearKeyboardIntent);
	}, []);

	const select = (item: CommandPaletteItem) => {
		if (item.disabled) return;
		onSelect?.(item);
		if (closeOnSelect) setOpen(false);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		onKeyDown?.(event, visibleItems[activeIndex]);
		if (event.defaultPrevented) return;
		if (event.key === "Tab") {
			keyboardIntentRef.current = true;
			setKeyboardFocused(true);
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex((current) =>
				nextEnabledIndex(visibleItems, current, event.key === "ArrowDown" ? 1 : -1),
			);
			return;
		}
		if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			const start = event.key === "Home" ? -1 : 0;
			setActiveIndex(nextEnabledIndex(visibleItems, start, event.key === "Home" ? 1 : -1));
			return;
		}
		if (event.key !== "Enter") return;
		if (onEnter?.() === true) {
			event.preventDefault();
			return;
		}
		if (activeIndex < 0) return;
		event.preventDefault();
		const item = visibleItems[activeIndex];
		if (item) select(item);
	};

	let previousGroup: string | undefined;
	const activeOptionId = activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined;
	const hasScopeHint = scopes !== undefined && scopes.length > 0;
	// The popup is the list of options, so a palette showing the empty or loading status is not
	// expanded — a combobox that always claims one sends a reader to a listbox holding nothing.
	const expanded = !loading && visibleItems.length > 0;

	return (
		<Dialog
			trigger={disabled && trigger ? cloneElement(trigger, {disabled: true}) : trigger}
			title={title}
			showCloseButton={false}
			closeOnEscape={closeOnEscape}
			open={isOpen}
			onOpenChange={setOpen}
			size="lg"
			className={`kp-command-palette kp-command-palette--${variant} ${className}`.trim()}
		>
			<div className="kp-command-palette__header">
				<Input
					ref={inputRef}
					autoFocus
					type="text"
					role="combobox"
					aria-label={title}
					aria-autocomplete="list"
					aria-expanded={expanded}
					aria-controls={`${baseId}-results`}
					aria-activedescendant={activeOptionId}
					aria-describedby={hasScopeHint ? `${baseId}-scopes` : undefined}
					aria-busy={loading || undefined}
					error={error}
					focusRing={keyboardFocused ? "control" : "none"}
					placeholder={placeholder}
					value={searchQuery}
					left={showSearchIcon ? <Search size={20} aria-hidden="true" /> : undefined}
					fullWidth
					className={`kp-command-palette__search${keyboardFocused ? " kp-command-palette__search--keyboard-focus" : ""}`}
					onChange={(event) => setQuery(event.currentTarget.value)}
					onFocus={() => setKeyboardFocused(keyboardIntentRef.current)}
					onPointerDown={() => {
						keyboardIntentRef.current = false;
						setKeyboardFocused(false);
					}}
					onKeyDown={handleKeyDown}
				/>
			</div>

			{/* Mounted empty rather than conditionally: a region inserted with its first sentence
			    already inside it is a mutation no screen reader was watching for. */}
			<div className="kp-command-palette__announce" aria-live="polite">
				{announcement}
			</div>

			<div
				id={`${baseId}-results`}
				className="kp-command-palette__results"
				role="listbox"
				aria-label={title}
			>
				{loading ? (
					<div className="kp-command-palette__status" role="status">
						{loadingLabel}
					</div>
				) : visibleItems.length === 0 ? (
					<div className="kp-command-palette__status" role="status">
						{emptyLabel}
					</div>
				) : (
					visibleItems.map((item, index) => {
						const showGroup = item.group !== undefined && item.group !== previousGroup;
						previousGroup = item.group;
						return (
							<div key={item.value} className="kp-command-palette__entry" role="presentation">
								{showGroup ? <div className="kp-command-palette__group">{item.group}</div> : null}
								<div
									id={`${baseId}-option-${index}`}
									className="kp-command-palette__option"
									role="option"
									tabIndex={-1}
									aria-selected={index === activeIndex}
									aria-disabled={item.disabled || undefined}
									data-active={index === activeIndex ? "" : undefined}
									onPointerMove={() => !item.disabled && setActiveIndex(index)}
									onPointerDown={(event) => {
										event.preventDefault();
										select(item);
									}}
								>
									{item.icon ? (
										<span className="kp-command-palette__icon" aria-hidden="true">
											{item.icon}
										</span>
									) : null}
									<span className="kp-command-palette__copy">
										<span className="kp-command-palette__label">{item.label}</span>
										{item.description ? (
											<span className="kp-command-palette__description">{item.description}</span>
										) : null}
									</span>
									{item.shortcut ? (
										<kbd className="kp-command-palette__shortcut">{item.shortcut}</kbd>
									) : null}
								</div>
							</div>
						);
					})
				)}
			</div>

			{hasScopeHint || footer ? (
				<div className="kp-command-palette__footer">
					{hasScopeHint ? (
						<div id={`${baseId}-scopes`} className="kp-command-palette__scopes">
							{scopeHintLabel ? (
								<span className="kp-command-palette__scopes-label">{scopeHintLabel}</span>
							) : null}
							{scopes.map((scope) => (
								<span
									key={scope.sigil}
									className="kp-command-palette__scope"
									data-active={scope.sigil === activeScope ? "" : undefined}
								>
									<kbd className="kp-command-palette__scope-sigil">{scope.sigil}</kbd>
									{scope.label}
								</span>
							))}
						</div>
					) : null}
					{footer ? <div className="kp-command-palette__legend">{footer}</div> : null}
				</div>
			) : null}
		</Dialog>
	);
}
