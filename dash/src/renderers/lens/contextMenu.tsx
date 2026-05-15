import { For, Match, Show, Switch, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

export type DashContextMenuItem =
	| {
			label: string;
			onSelect: () => void | Promise<void>;
			disabled?: boolean;
			hidden?: boolean;
			danger?: boolean;
	  }
	| {
			type: "separator";
			hidden?: boolean;
	  };

type DashContextMenuState = {
	x: number;
	y: number;
	items: DashContextMenuItem[];
};

const [menuState, setMenuState] = createSignal<DashContextMenuState | null>(null);
const [menuPosition, setMenuPosition] = createSignal({ x: 0, y: 0 });

function normalizeMenuItems(items: DashContextMenuItem[]) {
	const visibleItems = items.filter((item) => !item.hidden);
	const normalized: DashContextMenuItem[] = [];

	for (const item of visibleItems) {
		if (item.type === "separator") {
			const previous = normalized[normalized.length - 1];
			if (!previous || previous.type === "separator") {
				continue;
			}
		}

		normalized.push(item);
	}

	while (normalized[normalized.length - 1]?.type === "separator") {
		normalized.pop();
	}

	return normalized;
}

export function closeDashContextMenu() {
	setMenuState(null);
}

export function openDashContextMenu(
	event: Pick<MouseEvent, "clientX" | "clientY">,
	items: DashContextMenuItem[],
) {
	const normalizedItems = normalizeMenuItems(items);
	if (normalizedItems.length === 0) {
		closeDashContextMenu();
		return;
	}

	setMenuPosition({
		x: Math.max(8, Number(event.clientX || 0)),
		y: Math.max(8, Number(event.clientY || 0)),
	});
	setMenuState({
		x: Math.max(8, Number(event.clientX || 0)),
		y: Math.max(8, Number(event.clientY || 0)),
		items: normalizedItems,
	});
}

const DashContextMenuRow = (props: {
	item: Extract<DashContextMenuItem, { label: string }>;
	onSelect: () => void;
}) => {
	const [isHovered, setIsHovered] = createSignal(false);

	return (
		<button
			type="button"
			disabled={props.item.disabled}
			onClick={props.onSelect}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			style={{
				display: "block",
				width: "100%",
				border: "none",
				background: isHovered()
					? props.item.disabled
						? "transparent"
						: "rgba(16, 84, 96, 0.14)"
					: "transparent",
				color: props.item.disabled
					? "rgba(0, 0, 0, 0.35)"
					: props.item.danger
						? "#8d2a2a"
						: "#1a1a1a",
				"font-size": "13px",
				"font-weight": "500",
				"text-align": "left",
				padding: "7px 10px",
				"border-radius": "6px",
				cursor: props.item.disabled ? "default" : "pointer",
				"font-family":
					"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
			}}
		>
			{props.item.label}
		</button>
	);
};

export function DashContextMenuHost() {
	let menuRef: HTMLDivElement | undefined;

	const updatePlacement = () => {
		const activeMenu = menuState();
		if (!activeMenu || !menuRef) {
			return;
		}

		const rect = menuRef.getBoundingClientRect();
		const padding = 8;
		setMenuPosition({
			x: Math.max(padding, Math.min(activeMenu.x, window.innerWidth - rect.width - padding)),
			y: Math.max(padding, Math.min(activeMenu.y, window.innerHeight - rect.height - padding)),
		});
	};

	const handlePointerDown = (event: PointerEvent) => {
		if (!menuRef) {
			closeDashContextMenu();
			return;
		}

		const target = event.target;
		if (target instanceof Node && menuRef.contains(target)) {
			return;
		}

		closeDashContextMenu();
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") {
			closeDashContextMenu();
		}
	};

	onMount(() => {
		document.addEventListener("pointerdown", handlePointerDown, true);
		document.addEventListener("keydown", handleKeyDown, true);
		window.addEventListener("blur", closeDashContextMenu);
		window.addEventListener("resize", closeDashContextMenu);
		window.addEventListener("scroll", closeDashContextMenu, true);
	});

	onCleanup(() => {
		document.removeEventListener("pointerdown", handlePointerDown, true);
		document.removeEventListener("keydown", handleKeyDown, true);
		window.removeEventListener("blur", closeDashContextMenu);
		window.removeEventListener("resize", closeDashContextMenu);
		window.removeEventListener("scroll", closeDashContextMenu, true);
	});

	createEffect(() => {
		if (!menuState()) {
			return;
		}
		queueMicrotask(updatePlacement);
	});

	return (
		<Show when={menuState()}>
			{(activeMenu) => (
				<Portal mount={document.body}>
					<div
						ref={menuRef}
						onContextMenu={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
						style={{
							position: "fixed",
							left: `${menuPosition().x}px`,
							top: `${menuPosition().y}px`,
							"z-index": "2147483647",
							"min-width": "196px",
							"max-width": "280px",
							padding: "6px",
							background: "rgba(241, 237, 233, 0.98)",
							border: "1px solid rgba(0, 0, 0, 0.14)",
							"border-radius": "10px",
							"box-shadow":
								"0 12px 32px rgba(0, 0, 0, 0.24), 0 2px 8px rgba(0, 0, 0, 0.12)",
							"backdrop-filter": "blur(16px)",
						}}
					>
						<For each={activeMenu().items}>
							{(item) => (
								<Switch>
									<Match when={item.type === "separator"}>
										<div
											style={{
												height: "1px",
												margin: "6px 4px",
												background: "rgba(0, 0, 0, 0.12)",
											}}
										/>
									</Match>
									<Match when={item.type !== "separator"}>
										<DashContextMenuRow
											item={item as Extract<DashContextMenuItem, { label: string }>}
											onSelect={() => {
												if ("disabled" in item && item.disabled) {
													return;
												}
												closeDashContextMenu();
												void Promise.resolve(
													(item as Extract<DashContextMenuItem, { label: string }>).onSelect(),
												).catch((error) => {
													console.error("Context menu action failed:", error);
												});
											}}
										/>
									</Match>
								</Switch>
							)}
						</For>
					</div>
				</Portal>
			)}
		</Show>
	);
}
