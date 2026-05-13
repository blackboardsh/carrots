// import { render } from "solid-js/web";
import { produce } from "solid-js/store";
import { dirname, basename } from "../../utils/pathUtils";
import { getProjectForNodePath } from "../files";
import { electrobun } from "../init";
import {
  type BunnyDashCloudWorkspaceTreeType,
  type BunnyDashWorkspaceTreeType,
  state,
  setState,
  openNewTabForNode,
  getWindow,
  focusTabWithId,
  openFileAt,
  updateSyncedState,
  getCurrentTab,
} from "../store";
import { For, type JSX, Show, createEffect, createSignal, createMemo } from "solid-js";

export const TopBar = () => {
  const isCloudConnected = () => {
    return !!(
      state.appSettings.bunnyCloud?.accessToken &&
      state.appSettings.bunnyCloud?.email
    );
  };

  const toggleBunnyCloudSettings = () => {
    if (state.settingsPane.type === "bunny-cloud-settings") {
      setState("settingsPane", { type: "", data: {} });
      return;
    }
    setState("settingsPane", { type: "bunny-cloud-settings", data: {} });
  };

  const setCommandPaletteOpen = (value: boolean) => {
    setState("ui", "showCommandPalette", value);
    if (!value) {
      electrobun.rpc?.request.cancelFileSearch();
    }
  };

  const onClickToggleSidebar = () => {
    const currentWindow = getWindow();
    if (!currentWindow) return;

    const showSidebar = !currentWindow.ui.showSidebar;
    // isResizingPane will cause active webviews to go into mirroring mode
    setState("isResizingPane", true);
    // give it a second to start before toggling the ui so the animation is smoother
    setTimeout(() => {
      // Update the workspace window state and persist to database
      setState(
        "workspace",
        "windows",
        (w) => w.id === currentWindow.id,
        "ui",
        "showSidebar",
        showSidebar
      );
      updateSyncedState();
    }, 200);
    // then after the animation is complete turn off mirroring mode
    setTimeout(() => {
      setState("isResizingPane", false);
    }, 800);
  };

  // todo (yoav): make this a util that follows the currentTabPath
  return (
    <div
      style={{
        height: "40px",
        width: "100%",
        background: "#222",
        display: "flex",
      }}
    >
      <div
        style={{
          "margin-left": "80px",
          width: "24px",
          height: "24px",
          background: "#333",
          color: "#888",
          "border-radius": "4px",
          "text-align": "center",
          "vertical-align": "middle",
          "line-height": "24px",
          "margin-top": "7px",
          cursor: "pointer",
          "-webkit-user-select": "none",
          border: "1px solid #1f1f1f",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
        }}
        onClick={onClickToggleSidebar}
      >
        <img
          width="16px"
          height="16px"
          src={`views://assets/file-icons/sidebar-left${
            getWindow()?.ui.showSidebar ? "-filled" : ""
          }.svg`}
        />
      </div>

      {/* New Window button */}
      <div
        title="New Window"
        style={{
          width: "24px",
          height: "24px",
          "border-radius": "4px",
          "text-align": "center",
          "vertical-align": "middle",
          "line-height": "24px",
          "margin-top": "7px",
          cursor: "pointer",
          "-webkit-user-select": "none",
          border: "1px solid #1f1f1f",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
        }}
        onClick={() => {
          const pos = getWindow()?.position;
          const offset = {
            x: (pos?.x || 0) + 75,
            y: (pos?.y || 0) + 75,
          };
          electrobun.rpc?.send.createWindow({ offset });
        }}
      >
        <img
          width="16px"
          height="16px"
          src="views://assets/file-icons/new-window.svg"
        />
      </div>

      <WorkspaceLensSwitcher />

      <div
        class="electrobun-webkit-app-region-drag"
        style="flex-grow:1; height: 100%; cursor: move; "
      ></div>

      <Update />

      {/* Electrobun bunny */}
      <div
        style="position: relative; display: flex; align-items: center; margin-right: 4px; -webkit-user-select: none;"
        onMouseEnter={(e) => {
          const tip = e.currentTarget.querySelector("[data-bunny-tip]") as HTMLElement;
          const bunnyImg = e.currentTarget.querySelector("[data-bunny-btn]") as HTMLElement;
          if (tip) { tip.style.opacity = "1"; tip.style.transform = "translateX(0)"; tip.style.pointerEvents = "auto"; }
          if (bunnyImg) bunnyImg.style.filter = "drop-shadow(2px 0 0 #000) drop-shadow(-2px 0 0 #000) drop-shadow(0 2px 0 #000) drop-shadow(0 -2px 0 #000)";
        }}
        onMouseLeave={(e) => {
          const tip = e.currentTarget.querySelector("[data-bunny-tip]") as HTMLElement;
          const bunnyImg = e.currentTarget.querySelector("[data-bunny-btn]") as HTMLElement;
          if (tip) { tip.style.opacity = "0"; tip.style.transform = "translateX(8px)"; tip.style.pointerEvents = "none"; }
          if (bunnyImg) bunnyImg.style.filter = "none";
        }}
      >
        <div
          data-bunny-tip
          style="position: absolute; right: 100%; top: 50%; transform: translateX(8px); margin-right: 6px; white-space: nowrap; background: #111; color: #c0c0c0; font-size: 12px; padding: 4px 10px; border-radius: 4px; border: 1px solid #333; z-index: 9999; pointer-events: none; opacity: 0; transition: opacity 0.3s ease, transform 0.3s ease; translate: 0 -50%;"
        >Bunny Dash is built with Electrobun</div>
        <div
          data-bunny-btn
          style={{
            cursor: "pointer",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "28px",
            height: "28px",
            "border-radius": "4px",
            transition: "filter 0.2s ease",
            filter: "none",
            "flex-shrink": "0",
          }}
          onClick={(e) => {
            electrobun.rpc?.send.openBunnyWindow({ screenX: e.screenX, screenY: e.screenY });
          }}
        >
          <img
            src="views://bunny/assets/bunny.png"
            alt="Electrobun Bunny"
            style={{ width: "22px", height: "22px" }}
            draggable={false}
          />
        </div>
      </div>

      {/* Bunny Cloud button */}
      <div
        style={`font-size: 13px; margin: 8px 4px; cursor: pointer; display: flex; align-items: center; gap: 4px; background: ${
          isCloudConnected() ? "#2d4a3e" : "#303030"
        }; border-radius: 4px; padding: 2px 8px; border: 1px solid ${
          isCloudConnected() ? "#356047" : "#3d3d3d"
        };`}
        title={
          isCloudConnected()
            ? "Bunny Cloud connected - click to manage cloud settings"
            : "Local mode active - click to sign in to Bunny Cloud"
        }
        onClick={() => {
          toggleBunnyCloudSettings();
        }}
      >
        <svg
          style="width: 14px; height: 14px;"
          viewBox="0 0 24 24"
          fill="none"
          stroke={isCloudConnected() ? "#4ade80" : "#a3a3a3"}
          stroke-width="2"
        >
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
        </svg>
        <span
          style={{
            color: isCloudConnected() ? "#4ade80" : "#d0d0d0",
            "font-weight": "500",
            "font-size": "12px",
          }}
        >
          {isCloudConnected() ? "Cloud" : "Sign In"}
        </span>
      </div>

      {/* Bunny Dash button */}
      <div
        style={`font-size: 13px;margin: 8px 0px; margin-right: -2px; cursor: pointer; display: flex; align-items: center; gap: 6px; background: ${
          state.buildVars.channel === "dev" ? "#5a1616" :
          (state.buildVars.channel === "canary" || state.buildVars.channel === "staging") ? "#076310" :
          "#184d8b"
        }; border-radius: 4px; padding: 2px 8px 2px 4px;`}
        title="This is a beta version of Bunny Dash"
        onClick={() => openNewTabForNode("__BUNNY_INTERNAL__/web", false, { url: "https://github.com/blackboardsh/electrobun" })}
      >
        <img
          style={{
            height: "20px",
            width: "20px",
          }}
          src="views://assets/icon_32x32@2x.png"
        />
        <span style="color: #fff; font-weight: bold;">Bunny Dash{state.buildVars.channel === "dev" ? " - dev" :
          state.buildVars.channel === "canary" ? " - canary" :
          state.buildVars.channel === "staging" ? " - staging" :
          ""}</span>
      </div>

      <CommandPalette setOpen={setCommandPaletteOpen} />
    </div>
  );
};

type WorkspaceSwitcherLens = {
  id: string;
  name: string;
  isCurrent: boolean;
};

type WorkspaceSwitcherGroup = {
  id: string;
  name: string;
  subtitle: string;
  isCloud: boolean;
  isCurrent: boolean;
  lenses: WorkspaceSwitcherLens[];
};

const WorkspaceLensSwitcher = () => {
  const openMenu = () => {
    if (state.ui.showWorkspaceMenu) {
      return;
    }
    setState("isResizingPane", true);
    setState("ui", "showWorkspaceMenu", true);
  };

  const closeMenu = () => {
    setState("ui", "showWorkspaceMenu", false);
    setState("isResizingPane", false);
  };

  const workspaceGroups = createMemo<WorkspaceSwitcherGroup[]>(() => {
    const localGroups = state.bunnyDash.workspaces.map(
      (workspace: BunnyDashWorkspaceTreeType) => ({
        id: workspace.id,
        name: workspace.name,
        subtitle: workspace.subtitle || "Workspace",
        isCloud: false,
        isCurrent: workspace.isCurrent,
        lenses: workspace.lenses.map((lens) => ({
          id: lens.id,
          name: lens.name,
          isCurrent: lens.isCurrent,
        })),
      })
    );

    const cloudGroups = state.bunnyDash.cloudWorkspaces.map(
      (workspace: BunnyDashCloudWorkspaceTreeType) => ({
        id: workspace.runtimeWorkspaceId,
        name: workspace.name,
        subtitle: workspace.subtitle || "Cloud Workspace",
        isCloud: true,
        isCurrent: workspace.isCurrent,
        lenses: workspace.lenses.map((lens) => ({
          id: lens.runtimeLensId,
          name: lens.name,
          isCurrent: lens.isCurrent,
        })),
      })
    );

    return [...localGroups, ...cloudGroups];
  });

  const currentWorkspace = createMemo(() =>
    workspaceGroups().find(
      (workspace) => workspace.id === state.bunnyDash.currentWorkspaceId
    )
  );

  const currentLens = createMemo(() =>
    workspaceGroups()
      .flatMap((workspace) => workspace.lenses)
      .find((lens) => lens.id === state.bunnyDash.currentLensId)
  );

  const currentWorkspaceName = () =>
    currentWorkspace()?.name || state.workspace?.name || "Select Context";

  const currentLensName = () => {
    const lensName = currentLens()?.name?.trim();
    if (lensName && lensName !== "Current") {
      return lensName;
    }

    return "Current Lens";
  };

  const currentWorkspacePill = () =>
    currentWorkspace()?.isCloud ? "Cloud Workspace" : "Workspace";

  const currentContextLabel = () =>
    `${currentWorkspaceName()} · ${currentLensName()}`;

  const openWorkspace = async (workspaceId: string, inNewWindow: boolean) => {
    closeMenu();
    if (inNewWindow) {
      await electrobun.rpc?.request.openWorkspaceInNewWindow({ workspaceId });
    } else {
      await electrobun.rpc?.request.openWorkspace({ workspaceId });
    }
  };

  const openLens = async (lensId: string, inNewWindow: boolean) => {
    closeMenu();
    if (inNewWindow) {
      await electrobun.rpc?.request.openLensInNewWindow({ lensId });
    } else {
      await electrobun.rpc?.request.openLens({ lensId });
    }
  };

  const createLensForWorkspace = async (workspaceId: string) => {
    closeMenu();
    const name = String(
      (await electrobun.rpc?.request.getUniqueLensName({
        workspaceId,
        baseName: "Lens",
      })) || "Lens"
    );

    setState("settingsPane", {
      type: "lens-settings",
      data: {
        mode: "create",
        workspaceId,
        name,
        description: "",
      },
    });
  };

  const onWorkspaceRowMouseDown = (
    e: MouseEvent,
    workspaceId: string
  ) => {
    e.preventDefault();
    e.stopPropagation();
    void openWorkspace(workspaceId, e.metaKey || e.ctrlKey);
  };

  const onLensRowMouseDown = (e: MouseEvent, lensId: string) => {
    e.preventDefault();
    e.stopPropagation();
    void openLens(lensId, e.metaKey || e.ctrlKey);
  };

  const onNewLensRowMouseDown = (e: MouseEvent, workspaceId: string) => {
    e.preventDefault();
    e.stopPropagation();
    void createLensForWorkspace(workspaceId);
  };

  return (
    <Show when={workspaceGroups().length > 0}>
      <div
        style={{
          position: "relative",
          display: "flex",
          "align-items": "center",
          "align-self": "center",
          "margin-left": "10px",
          height: "26px",
        }}
      >
        <button
          class="webview-overlay"
          title="Switch workspace or lens"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (state.ui.showWorkspaceMenu) {
              closeMenu();
              return;
            }
            openMenu();
          }}
          style={`
            width: 340px;
            height: 26px;
            border-radius: 6px;
            border: 1px solid ${state.ui.showWorkspaceMenu ? "#3f5f95" : "#343434"};
            background: ${state.ui.showWorkspaceMenu ? "#1e2b42" : "#2a2a2a"};
            color: #e8e8e8;
            padding: 0 10px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: pointer;
            gap: 10px;
            box-sizing: border-box;
          `}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              "min-width": "0",
              flex: "1",
            }}
          >
            <div
              style={{
                "font-size": "10px",
                "font-weight": "700",
                color: currentWorkspace()?.isCloud ? "#8fe7ff" : "#cfcfcf",
                "letter-spacing": "0.08em",
                "text-transform": "uppercase",
                "flex-shrink": "0",
              }}
            >
              {currentWorkspacePill()}
            </div>
            <div
              style={{
                "min-width": "0",
                flex: "1",
                "text-align": "left",
                "font-size": "13px",
                "font-weight": "600",
                color: "#f4f4f4",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "white-space": "nowrap",
              }}
            >
              {currentContextLabel()}
            </div>
          </div>
          <div style={{ color: "#9d9d9d", "font-size": "12px", "flex-shrink": "0" }}>
            {state.ui.showWorkspaceMenu ? "▲" : "▼"}
          </div>
        </button>

        <Show when={state.ui.showWorkspaceMenu}>
          <div
            class="webview-overlay"
            style="position: fixed; inset: 0; z-index: 999998;"
            onMouseDown={() => closeMenu()}
          />

          <div
            class="webview-overlay"
            style={`
              position: absolute;
              top: 32px;
              left: 0;
              z-index: 999999;
              width: 360px;
              max-height: calc(100vh - 70px);
              overflow-y: auto;
              background: #1a1a1a;
              border: 1px solid #3a3a3a;
              border-radius: 10px;
              box-shadow: 0 16px 40px rgba(0,0,0,0.45);
              padding: 8px;
              box-sizing: border-box;
            `}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                "justify-content": "space-between",
                "align-items": "center",
                padding: "6px 8px 10px 8px",
                color: "#8a8a8a",
                "font-size": "11px",
                "text-transform": "uppercase",
                "letter-spacing": "0.08em",
              }}
            >
              <span>Contexts</span>
              <span style={{ "text-transform": "none", "letter-spacing": "0" }}>
                Cmd/Ctrl-click opens a new window
              </span>
            </div>

            <For each={workspaceGroups()}>
              {(workspace) => (
                <>
                  <div
                    style={{
                      margin: "0 0 8px 0",
                      border: workspace.isCurrent
                        ? "1px solid #355789"
                        : "1px solid #2b2b2b",
                      "border-radius": "8px",
                      background: workspace.isCurrent ? "#202a39" : "#171717",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      onMouseDown={(e) => onWorkspaceRowMouseDown(e, workspace.id)}
                      style={`
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 10px;
                        padding: 10px 12px;
                        cursor: pointer;
                        background: ${workspace.isCurrent ? "#22324c" : "transparent"};
                        border-bottom: 1px solid #242424;
                      `}
                    >
                      <div style={{ "min-width": "0", flex: "1" }}>
                        <div
                          style={{
                            display: "flex",
                            "align-items": "center",
                            gap: "8px",
                            "min-width": "0",
                          }}
                        >
                          <span style={{ color: workspace.isCloud ? "#8fe7ff" : "#cfcfcf" }}>
                            {workspace.isCloud ? "☁" : "◉"}
                          </span>
                          <span
                            style={{
                              color: "#f0f0f0",
                              "font-size": "13px",
                              "font-weight": "600",
                              overflow: "hidden",
                              "text-overflow": "ellipsis",
                              "white-space": "nowrap",
                            }}
                          >
                            {workspace.name}
                          </span>
                          <Show when={workspace.isCurrent}>
                            <span
                              style={{
                                "font-size": "10px",
                                color: "#9fd0ff",
                                border: "1px solid #4b6a93",
                                "border-radius": "999px",
                                padding: "1px 6px",
                                "flex-shrink": "0",
                              }}
                            >
                              Current
                            </span>
                          </Show>
                        </div>
                        <div
                          style={{
                            color: "#8f8f8f",
                            "font-size": "11px",
                            "margin-left": "20px",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {workspace.subtitle}
                        </div>
                      </div>
                      <div style={{ color: "#7f7f7f", "font-size": "11px", "flex-shrink": "0" }}>
                        {workspace.isCloud ? "Cloud Workspace" : "Workspace"}
                      </div>
                    </div>

                    <div style={{ padding: "6px 6px 8px 6px" }}>
                      <For each={workspace.lenses}>
                        {(lens) => (
                          <div
                            onMouseDown={(e) => onLensRowMouseDown(e, lens.id)}
                            style={`
                              display: flex;
                              align-items: center;
                              justify-content: space-between;
                              gap: 10px;
                              padding: 8px 10px 8px 28px;
                              border-radius: 6px;
                              cursor: pointer;
                              color: ${lens.isCurrent ? "#f3f7ff" : "#d0d0d0"};
                              background: ${lens.isCurrent ? "#2a3d5d" : "transparent"};
                              margin-bottom: 2px;
                            `}
                          >
                            <span
                              style={{
                                overflow: "hidden",
                                "text-overflow": "ellipsis",
                                "white-space": "nowrap",
                                "font-size": "12px",
                                flex: "1",
                              }}
                            >
                              {lens.name === "Current" ? "Current Lens" : lens.name}
                            </span>
                            <Show when={lens.isCurrent}>
                              <span
                                style={{
                                  "font-size": "10px",
                                  color: "#9fd0ff",
                                  "flex-shrink": "0",
                                }}
                              >
                                Open
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>

                      <div
                        onMouseDown={(e) => onNewLensRowMouseDown(e, workspace.id)}
                        style={`
                          display: flex;
                          align-items: center;
                          gap: 10px;
                          padding: 8px 10px 8px 28px;
                          border-radius: 6px;
                          cursor: pointer;
                          color: #7ed3ff;
                          background: rgba(66, 139, 202, 0.08);
                          margin-top: 4px;
                          font-size: 12px;
                          font-weight: 600;
                        `}
                      >
                        <span>+</span>
                        <span>New Lens…</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
};

const CommandPalette = ({ setOpen }: { setOpen: (value: boolean) => void }) => {
  const toggleOpen = (value = !state.ui.showCommandPalette) => {
    setOpen(value);
  };

  const open = () => {
    return state.ui.showCommandPalette;
  };

  // todo:
  // 3. add a way to open the file in the current pane
  // 4. add a section for open tabs that focuses the tab when clicked
  // 5. add search functionality

  // decide if we can ship before continuing
  // 2. move the workspace menu into the command palette
  // 1. move state to store so it can be opened and modified globally
  // 2. add selection mechanism connected to hover and keyboard up/down
  // 4. when first opening it should show the active tabs organized by last used
  // 5. open tabs should be shown first even when filtering with a grey line and heading

  const [fileMatches, setFileMatches] = createSignal<
    { name: string; description: string; project: string }[]
  >([]);

  const [openTabs, setOpenTabs] = createSignal<
    { name: string; description: string; project: string }[]
  >([]);

  const [workspaceCommands, setWorkspaceCommands] = createSignal<
    { name: string; description: string; action: () => void }[]
  >([]);

  const [bunnyCommands, setBunnyCommands] = createSignal<
    { name: string; description: string; action: () => void }[]
  >([]);

  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let lastQuery = "";

  // Flatten all items into a single array for navigation - needs to be a memo for reactivity
  const getAllItems = createMemo(() => {
    const items: any[] = [];

    openTabs().forEach((tab) => {
      items.push({ type: 'tab', ...tab });
    });

    workspaceCommands().forEach((cmd) => {
      items.push({ type: 'workspace', ...cmd });
    });

    bunnyCommands().forEach((cmd) => {
      items.push({ type: 'bunny', ...cmd });
    });

    const files = fileMatches();
    files.forEach((file) => {
      items.push({ type: 'file', ...file });
    });

    return items;
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    const allItems = getAllItems();
    const totalItems = allItems.length;

    if (totalItems === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((selectedIndex() + 1) % totalItems);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((selectedIndex() - 1 + totalItems) % totalItems);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selectedItem = allItems[selectedIndex()];
      if (selectedItem) {
        if (selectedItem.type === 'tab') {
          focusTabWithId(selectedItem.tabId);
        } else if (selectedItem.type === 'workspace' || selectedItem.type === 'bunny') {
          selectedItem.action();
        } else if (selectedItem.type === 'file') {
          openFileAt(selectedItem.path, 0, 0);
        }
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      toggleOpen(false);
    }
  };

  const onCommandPaletteInput = (e: InputEvent) => {
    const value = e.target?.value;

    if (value !== state.commandPalette.query) {
      setState(
        produce((_state: AppState) => {
          _state.commandPalette = { query: value, results: {} };
        })
      );
    }

    // Trigger file search - results will stream in via findFilesInWorkspaceResult handler
    electrobun.rpc?.request.findFilesInWorkspace({ query: value });
  };

  createEffect((lastValue) => {
    if (open()) {
      resetOpenTabs();
      filterCommands();
      if (!lastValue) {
        setState("commandPalette", "query", "");
      }

      return true;
    }

    return false;
  });

  const resetOpenTabs = () => {
    const query = state.commandPalette.query;
    const queryRegex = new RegExp(query.split("").join(".*"), "i");
    const tabs = Object.values(getWindow(state)?.tabs || {}).reduce(
      (acc, tab) => {
        if (tab.type === "file") {
          // const node = state.fileCache[tab.path];
          const project = getProjectForNodePath(tab.path);
          const name = basename(tab.path);
          const folder = dirname(tab.path).replace(project?.path || "", "");
          const projectName = project?.name || (project?.path ? basename(project.path) : "");
          if (name.match(queryRegex)) {
            acc.push({
              name: name,
              description: `${projectName} ${folder}`,
              path: tab.path,
              tabId: tab.id,
            });
          }
        } else if (tab.type === "web") {
          if (tab.url.match(queryRegex)) {
            acc.push({
              name: new URL(tab.url).host,
              description: tab.url,
              tabId: tab.id,
              // todo: tabs need to store which project they were opened under
              // project: "web",
            });
          }
        }

        return acc;
      },
      []
    );

    setOpenTabs(tabs);
  };

  const openWebTab = (url: string) => {
    openNewTabForNode("__BUNNY_INTERNAL__/web", false, { url });
  };

  const globalSettingsClick = () => {
    setState("settingsPane", {
      type:
        state.settingsPane.type === "global-settings" ? "" : "global-settings",
      data: {},
    });
  };

  const workspaceSettingsClick = () => {
    setState("settingsPane", {
      type:
        state.settingsPane.type === "workspace-settings"
          ? ""
          : "workspace-settings",
      data: {},
    });
  };

  const pluginsClick = () => {
    setState("settingsPane", {
      type:
        state.settingsPane.type === "plugin-marketplace" ? "" : "plugin-marketplace",
      data: {},
    });
  };

  const llamaSettingsClick = () => {
    setState("settingsPane", {
      type:
        state.settingsPane.type === "llama-settings" ? "" : "llama-settings",
      data: {},
    });
  };

  const filterCommands = () => {
    const query = state.commandPalette.query;
    const queryRegex = new RegExp(query.split("").join(".*"), "i");

    // Define all workspace commands
    const allWorkspaceCommands = [
      { name: "New Window", description: "Open a new window", action: () => electrobun.rpc?.send.createWindow() },
      { name: "Hide Workspace", description: "Hide the current workspace", action: () => electrobun.rpc?.send.hideWorkspace() },
      { name: "Plugins", description: "Browse and manage plugins", action: pluginsClick },
      { name: "Llama Settings", description: "Configure local AI model", action: llamaSettingsClick },
      { name: "Bunny Dash Settings", description: "Configure global Bunny Dash settings", action: globalSettingsClick },
      { name: "Workspace Settings", description: "Configure workspace settings", action: workspaceSettingsClick },
      { name: "New Workspace", description: "Create a new workspace", action: () => electrobun.rpc?.send.createWorkspace() },
      {
        name: "Format Document",
        description: "Format the current code editor",
        action: () => {
          const activeTab = getCurrentTab();
          if (!activeTab || activeTab.type !== 'file') return;

          electrobun.rpc?.send("formatFile", { path: activeTab.path });
        }
      },
    ];

    // Define all Bunny Dash commands
    const allBunnyCommands = [
      { name: "Submit an issue", description: "Report a Bug / Request a Feature", action: () => openWebTab("https://github.com/blackboardsh/electrobun") },
      { name: "Changelog", description: "View Bunny Dash changelog", action: () => openWebTab("https://github.com/blackboardsh/electrobun/tags") },
      { name: "Blackboard Blog", description: "Updates from the Blackboard Labs", action: () => openWebTab("https://blackboard.sh/blog/") },
      { name: "Join Discord", description: "Join the community Discord", action: () => openWebTab("https://discord.gg/ueKE4tjaCE") },
      { name: "Yoav", description: "Things Yoav says", action: () => openWebTab("https://bsky.app/profile/yoav.codes") },
    ];

    // Filter workspace commands
    const filteredWorkspace = allWorkspaceCommands.filter((cmd) => {
      const combined = `${cmd.name} ${cmd.description}`;
      return combined.match(queryRegex);
    });

    // Filter Bunny Dash commands
    const filteredBunnyCommands = allBunnyCommands.filter((cmd) => {
      const combined = `${cmd.name} ${cmd.description}`;
      return combined.match(queryRegex);
    });

    setWorkspaceCommands(filteredWorkspace);
    setBunnyCommands(filteredBunnyCommands);
  };

  // resetOpenTabs();

  createEffect(() => {
    const matches: any[] = [];
    const query = state.commandPalette.query;
    const results = state.commandPalette.results;

    if (query) {
      // Collect matches per project with scoring, limit to top 5 per project
      Object.entries(results).forEach(([key, value]) => {
        const project = state.projects[key];
        const projectMatches: any[] = [];

        value.forEach((path) => {
          const name = basename(path);

          // Get path from project folder (including project folder name)
          const projectFolderName = basename(project.path);
          const pathFromProject = path.replace(dirname(project.path) + "/", "");

          // Simple scoring: prefer shorter paths and exact substring matches
          const lowerQuery = query.toLowerCase();
          let score = 0;

          // Exact filename match gets highest score
          if (name.toLowerCase() === lowerQuery) score += 1000;
          // Filename starts with query
          else if (name.toLowerCase().startsWith(lowerQuery)) score += 500;
          // Filename contains query
          else if (name.toLowerCase().includes(lowerQuery)) score += 250;

          // Shorter paths rank higher
          score -= path.length / 100;

          projectMatches.push({
            name,
            description: pathFromProject,
            path,
            score,
          });
        });

        // Sort by score and take top 5 from this project
        projectMatches.sort((a, b) => b.score - a.score);
        matches.push(...projectMatches.slice(0, 5));
      });

      // Sort all matches by score for final display
      matches.sort((a, b) => b.score - a.score);
    }

    setFileMatches(matches);

    // Update filtered commands when query changes
    resetOpenTabs();
    filterCommands();

    // Only reset selected index when the query changes, not when results stream in
    if (query !== lastQuery) {
      lastQuery = query;
      setSelectedIndex(0);
    }
  });

  let input: HTMLInputElement;

  createEffect(() => {
    if (open()) {
      // trigger webview rapid sync so show animation plays smoothly
      document
        .querySelectorAll("electrobun-webview")
        .forEach((el) => el?.syncDimensions(true));
      input?.focus();
    } else {
      // remove the mask cutout when closing
      document
        .querySelectorAll("electrobun-webview")
        .forEach((el) => el?.syncDimensions(true));
    }
  });

  return (
    <div
      style={`
      position: absolute;
      height: 40px;          
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
      pointer-events: none;
    `}
    >
      <button
        onClick={() => setOpen(!open())}
        style={`
        pointer-events: auto;
        width: 300px;
        border-radius: 7px;
        border: none;
        background: #444;
        padding: 4px;
        text-align: center;
        font-family: Helvetica;
        font-size: 14px;
        color: #999;
        cursor: pointer;
      `}
      >
        {state.workspace?.name || 'Search'}
      </button>
      <style>
        {`@keyframes fadeIn {
        to {
          opacity: 1;
          transform: translateY(0);           
        }
      }`}
      </style>
      {open() && (
        <div
          class="webview-overlay"
          style={`
          position: absolute;
          top: 8px;
          background: #222;
          z-index: 999999;
          width: 500px;
          min-height: 200px;
          padding: 10px;
          border-radius: 8px;
          border: 1px solid #444;
          display: flex;
          flex-direction: column;
          pointer-events: auto;
          box-shadow: 0 9px 10px 2px #170808;
          opacity: 0;
          transform: translateY(-10px);
          animation: fadeIn 0.4s forwards;          
        `}
        >
          <input
            ref={(r) => (input = r)}
            style={`
              background: #393939;
              border: 1px solid #444;
              border-radius: 4px;
              padding: 4px;
              color: #ddd;
              margin-bottom: 6px;
            `}
            autofocus={true}
            onBlur={() => toggleOpen(false)}
            type="text"
            placeholder="Search"
            onInput={onCommandPaletteInput}
            onKeyDown={handleKeyDown}
          />
          <div
            style={`max-height: 80vh;
          overflow-y: scroll;`}
          >
            <For each={getAllItems()}>
              {(item, index) => {
                const isFirstInSection = () => {
                  if (index() === 0) return true;
                  const prevItem = getAllItems()[index() - 1];
                  return item.type !== prevItem?.type;
                };

                const sectionTitle = () => {
                  if (item.type === 'tab') return 'Tabs';
                  if (item.type === 'workspace') return 'Workspace';
                  if (item.type === 'bunny') return 'Bunny Dash';
                  if (item.type === 'file') return 'Files';
                  return '';
                };

                return (
                  <>
                    {isFirstInSection() && (
                      <h3
                        style={`
                      color: #888;
                      padding: 5px;
                      font-size: 12px;
                      border-bottom: 1px solid #333;
                      margin: 0 3px;
                      margin-top: ${index() > 0 ? '10px' : '0'};`}
                      >
                        {sectionTitle()}
                      </h3>
                    )}
                    <CommandPaletteItem
                      icon={
                        item.type === 'tab' ? '✨' :
                        item.type === 'workspace' ? '⚙️' :
                        item.type === 'bunny' ? '🔧' :
                        '✨'
                      }
                      name={item.name}
                      description={item.description}
                      isSelected={() => index() === selectedIndex()}
                      onSelect={() => {
                        if (item.type === 'tab') {
                          focusTabWithId(item.tabId);
                        } else if (item.type === 'workspace' || item.type === 'bunny') {
                          item.action();
                        } else if (item.type === 'file') {
                          openFileAt(item.path, 0, 0);
                        }
                        toggleOpen(false);
                      }}
                    />
                  </>
                );
              }}
            </For>
          </div>
        </div>
      )}
    </div>
  );
};

const CommandPaletteItem = ({ icon, name, description, onSelect, isSelected }: {
  icon: string;
  name: string;
  description: string;
  onSelect: () => void;
  isSelected?: () => boolean;
}) => {
  const [hover, setHover] = createSignal(false);
  let itemRef: HTMLDivElement;

  createEffect(() => {
    if (isSelected?.() && itemRef) {
      itemRef.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  return (
    <div
      ref={(el) => (itemRef = el)}
      style={`
    display: flex;
    background: ${isSelected?.() ? "#094771" : hover() ? "#2a2d2e" : "transparent"};
    color: ${hover() || isSelected?.() ? "#cccccc" : "#cccccc"};
    padding: 3px 6px;
    border-radius: 3px;
    align-items: center;
    cursor: pointer;
    text-wrap-mode: nowrap;
    border: 1px solid transparent;
    font-size: 13px;
    gap: 8px;
    `}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={onSelect}
    >
      <div style="display: flex; align-items: center; flex-shrink: 0; width: 16px; justify-content: center;">{icon}</div>
      <div style="flex: 1; min-width: 0;">{name}</div>
      <div style={`font-size: 11px; opacity: .5; flex-shrink: 0;`}>
        {description}
      </div>
    </div>
  );
};

const WorkspaceMenu = ({ children }: { children: JSX.Element }) => {
  return (
    <Show when={state.workspace.id}>
      <div style="-webkit-user-select: none; font-size: 13px; color: #ddd;margin: 8px 0px; padding: 5px; ">
        <span
          style={`border-radius: 4px;padding: 5px 17px;   font-size: 13px; cursor: pointer;`}
          class="workspace-menu-button"
          onClick={() => {
            if (!state.ui.showWorkspaceMenu) {
              setState("isResizingPane", true);
              setTimeout(() => {
                setState(
                  "ui",
                  "showWorkspaceMenu",
                  !state.ui.showWorkspaceMenu
                );
              }, 100);
            } else {
              setState("ui", "showWorkspaceMenu", !state.ui.showWorkspaceMenu);
              setState("isResizingPane", false);
            }
          }}
        >
          {state.workspace?.name || "Workspace"}
        </span>
        <div style="position:relative;">
          <Show when={state.ui.showWorkspaceMenu}>
            <div
              class="workspace-menu webview-overlay"
              style="border-radius: 4px; position: absolute; top: 8px; right: 0px;min-width:200px; text-align: right; border: 2px solid black; padding:2px; z-index: 2; background: #000"
              onClick={() => setState("ui", "showWorkspaceMenu", false)}
            >
              <ul style="list-style: none;">{children}</ul>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
};

const Update = () => {
  const isReady = () => Boolean(state.update.downloadedFile);
  const updateInfo = () => state.update.info;
  const hasError = () =>
    state.update.status === "error" || Boolean(state.update.error);
  const updateAvailable = () =>
    Boolean(updateInfo()?.updateAvailable) || isReady() || hasError();
  const updateErrorMessage = () =>
    state.update.error?.message || "Update failed. Please download manually.";

  const buttonLabel = () => {
    if (hasError()) {
      return "Update Failed";
    }

    if (isReady()) {
      return "Restart to Update";
    }

    return "Installing Update…";
  };

  const buttonTitle = () => {
    const version = updateInfo()?.version;

    if (hasError()) {
      return updateErrorMessage();
    }

    if (isReady()) {
      return version ? `Click to restart and update to v${version}` : "Click to restart and update";
    }

    if (state.update.status === "update-not-downloaded") {
      return "Download failed, retrying shortly";
    }

    return version ? `Downloading v${version}…` : "Downloading update…";
  };

  const onClick = () => {
    if (!isReady()) {
      return;
    }

    electrobun.rpc?.send.installUpdateNow();
  };

  return (
    <Show when={updateAvailable()}>
      <div
        class={`update-button${hasError() ? " error" : ""}`}
        onClick={onClick}
        title={buttonTitle()}
        style={`font-size: 13px;margin: 8px 0px; padding: 5px; cursor: ${
          isReady() ? "pointer" : "default"
        };`}
      >
        <span
          style={`-webkit-user-select: none;border-radius: 4px;  padding: 5px 17px; font-size: 13px; box-sizing: border-box; color: ${
            hasError() ? "#fff" : "#222"
          }; opacity: ${
            hasError() || isReady() ? 1 : 0.7
          };`}
        >
          {buttonLabel()}
        </span>
      </div>
    </Show>
  );
};
