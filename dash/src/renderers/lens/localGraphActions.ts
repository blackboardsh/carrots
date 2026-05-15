import { basename } from "../utils/pathUtils";
import { produce } from "solid-js/store";
import {
  electrobun,
  fsGetNode,
  fsSafeDeleteFileOrFolder,
  getDashHostBootState,
  getHydratedInitialState,
  hostCreateWindow,
  scheduleDashHostCacheSync,
} from "./init";
import {
  loadPersistedAppSettings,
  loadPersistedWorkspaceState,
  loadPersistedLocalDashGraph,
  mergeAppSettingsForBoot,
  persistAppSettings,
  persistLocalDashGraph,
  persistWorkspaceState,
  type PersistedLocalDashGraph,
} from "./localStateDb";
import type { DashHostWindowSummary } from "./dashHostCache";
import { getWindow, setState, state, syncWorkspaceNow } from "./store";
import {
  buildBootWindowTitle,
  buildLocalBunnyDashPayload,
  buildLocalProjectsForWorkspace,
  buildLocalWorkspaceForBoot,
  pickLocalBootTarget,
} from "./localBoot";

const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const CLOUD_LENS_SHADOW_PREFIX = "__cloud_lens__:";
const DEFAULT_WORKSPACE_COLOR = "#184d8b";
const LIVE_WINDOW_ID_SEPARATOR = "::";

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function uniqueKey(base: string, existingKeys: string[]) {
  let candidate = slugify(base);
  let index = 2;
  while (existingKeys.includes(candidate)) {
    candidate = `${slugify(base)}-${index}`;
    index += 1;
  }
  return candidate;
}

function workspaceCurrentLensKey(workspaceId: string) {
  return `${WORKSPACE_CURRENT_LENS_PREFIX}${workspaceId}`;
}

function makeLiveWindowId(lensId: string, baseWindowId = "main") {
  return `${lensId}${LIVE_WINDOW_ID_SEPARATOR}${baseWindowId}${LIVE_WINDOW_ID_SEPARATOR}${Date.now()}`;
}

function isCloudWorkspaceId(workspaceId: string) {
  return workspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX);
}

function isCloudLensId(lensId: string) {
  return lensId.startsWith(CLOUD_LENS_SHADOW_PREFIX);
}

function cloneGraph(graph: PersistedLocalDashGraph): PersistedLocalDashGraph {
  return structuredClone(graph);
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeDefaultBunnyWindow(id = "main") {
  return {
    id,
    ui: {
      showSidebar: true,
      sidebarWidth: 250,
    },
    position: {
      x: 0,
      y: 0,
      width: 1500,
      height: 900,
    },
    expansions: [],
    rootPane: {
      id: "root",
      type: "pane",
      tabIds: [],
      currentTabId: null,
    },
    tabs: {},
    currentPaneId: "root",
  };
}

function buildLiveWindowTitle(workspaceName: string, lensName: string, windowTitle?: string) {
  return windowTitle?.trim() || `${workspaceName} · ${lensName}`;
}

function buildDefaultCurrentLensForWorkspace(workspace: {
  key: string;
  name: string;
}, sortOrder: number) {
  return {
    key: workspaceCurrentLensKey(workspace.key),
    name: "Current",
    description: `Current working state for ${workspace.name}.`,
    workspaceId: workspace.key,
    windowStateJson: JSON.stringify(makeDefaultBunnyWindow("main")),
    sortOrder,
    windows: [
      {
        id: "main",
        title: buildLiveWindowTitle(workspace.name, "Current", "Main"),
        workspaceId: workspace.key,
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  };
}

function getCurrentWorkspaceWindowState() {
  const windows = Array.isArray(state.workspace?.windows) ? state.workspace.windows : [];
  const currentWindow =
    windows.find((window) => window.id === state.windowId) || windows[0] || null;
  return currentWindow ? structuredClone(currentWindow) : null;
}

function collectPaneLeaves(
  pane: any,
  result: Array<{ tabIds?: string[]; currentTabId?: string | null }> = [],
) {
  if (!pane || typeof pane !== "object") {
    return result;
  }
  if (pane.type === "pane") {
    result.push(pane);
    return result;
  }
  if (pane.type === "container" && Array.isArray(pane.panes)) {
    for (const childPane of pane.panes) {
      collectPaneLeaves(childPane, result);
    }
  }
  return result;
}

function getCurrentWorkspaceWindowStateJson() {
  const currentWindow = getCurrentWorkspaceWindowState();
  return currentWindow ? JSON.stringify(currentWindow) : null;
}

function parseWorkspaceWindowState(windowStateJson: string | undefined, windowId: string) {
  try {
    const parsed = windowStateJson ? JSON.parse(windowStateJson) : null;
    if (parsed && typeof parsed === "object") {
      return {
        ...parsed,
        id: windowId,
      };
    }
  } catch {}

  return {
    ...makeDefaultBunnyWindow(windowId),
    id: windowId,
  };
}

function getHostFrameForWindow(windowState: {
  position?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
}) {
  return {
    x: Number(windowState.position?.x || 120),
    y: Number(windowState.position?.y || 120),
    width: Number(windowState.position?.width || 1500),
    height: Number(windowState.position?.height || 900),
  };
}

function scheduleDashHostCacheForWindow(
  currentWindow: DashHostWindowSummary | null,
  workspaceId: string,
  lensId: string,
) {
  scheduleDashHostCacheSync({
    currentWorkspaceId: workspaceId,
    currentLensId: lensId,
    currentWindow,
    workspaces: clonePlain(state.bunnyDash.workspaces || []),
    cloudWorkspaces: clonePlain(state.bunnyDash.cloudWorkspaces || []),
    knownLocalProjects: clonePlain(state.bunnyDash.knownLocalProjects || []),
    peerDependencies: clonePlain(state.peerDependencies),
    account: {
      signedIn: Boolean(
        state.appSettings.bunnyCloud?.accessToken &&
          state.appSettings.bunnyCloud?.email,
      ),
      email: state.appSettings.bunnyCloud?.email || "",
      name: state.appSettings.bunnyCloud?.name || "",
      userId: state.appSettings.bunnyCloud?.userId || "",
      emailVerified: Boolean(state.appSettings.bunnyCloud?.emailVerified),
      connectedAt: state.appSettings.bunnyCloud?.connectedAt,
    },
    currentInstance: clonePlain(
      state.bunnyDash.instances?.find((instance) => instance.isCurrent) || null,
    ),
  });
}

function buildRuntimeTemplateFromLiveWindow(
  liveWindow: {
    rootPane?: unknown;
    currentPaneId?: string;
  },
  windowId: string,
  workspaceId: string,
  title: string,
) {
  const paneLeaves = collectPaneLeaves(liveWindow.rootPane);
  const mainPane = paneLeaves[0];
  const sidePane = paneLeaves[1];
  const mainTabIds =
    Array.isArray(mainPane?.tabIds) && mainPane.tabIds.length > 0
      ? [...mainPane.tabIds]
      : ["workspace"];
  const sideTabIds =
    Array.isArray(sidePane?.tabIds) && sidePane.tabIds.length > 0
      ? [...sidePane.tabIds]
      : ["current-state"];

  return {
    id: windowId,
    title,
    workspaceId,
    mainTabIds,
    sideTabIds,
    currentMainTabId:
      typeof mainPane?.currentTabId === "string"
        ? mainPane.currentTabId
        : mainTabIds[0] || "workspace",
    currentSideTabId:
      typeof sidePane?.currentTabId === "string"
        ? sidePane.currentTabId
        : sideTabIds[0] || "current-state",
  };
}

function getTemplateWindowsForWorkspace(
  graph: PersistedLocalDashGraph,
  workspace: { key: string; name: string },
  preferredLensId?: string,
) {
  const preferredLens =
    (preferredLensId
      ? graph.layouts.find((item) => item.key === preferredLensId)
      : null) ||
    graph.layouts.find((item) => item.key === state.bunnyDash.currentLensId) ||
    graph.layouts.find((item) => item.key === workspaceCurrentLensKey(workspace.key)) ||
    buildDefaultCurrentLensForWorkspace(workspace, graph.layouts.length);

  return preferredLens.windows.length > 0
    ? structuredClone(preferredLens.windows)
    : structuredClone(
        buildDefaultCurrentLensForWorkspace(workspace, graph.layouts.length).windows,
      );
}

function patchCurrentLensFlags(workspaceId: string, lensId: string) {
  setState("bunnyDash", "currentWorkspaceId", workspaceId);
  setState("bunnyDash", "currentLensId", lensId);
  setState(
    "bunnyDash",
    "workspaces",
    (workspace) => true,
    produce((workspace) => {
      workspace.isCurrent = workspace.id === workspaceId;
      workspace.currentLensIsActive =
        workspace.id === workspaceId &&
        lensId === workspaceCurrentLensKey(workspaceId);
      workspace.lenses = workspace.lenses.map((lens) => ({
        ...lens,
        isCurrent: workspace.id === workspaceId && lens.id === lensId,
        isDirty: false,
      }));
    }),
  );
}

async function syncCurrentLocalWindowToWorker(params: {
  workspaceId: string;
  lensId: string;
  windowId: string;
  activeTreeNodeId: string;
  window: {
    id: string;
    title: string;
    workspaceId: string;
    mainTabIds: string[];
    sideTabIds: string[];
    currentMainTabId: string;
    currentSideTabId: string;
  };
}) {
  await electrobun.rpc?.request.syncLocalCurrentWindow(params);
}

async function applyLocalLensToCurrentWindow(
  graph: PersistedLocalDashGraph,
  workspaceId: string,
  lensId: string,
  activeTreeNodeId: string,
) {
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  const lens = graph.layouts.find((item) => item.key === lensId);
  if (!workspace || !lens) {
    throw new Error(`Unable to load local workspace/lens: ${workspaceId}/${lensId}`);
  }

  const persistedWorkspace = await loadPersistedWorkspaceState(workspaceId);
  const templateWindow =
    structuredClone(lens.windows.find((window) => window.id === state.windowId) || lens.windows[0]) || {
      id: state.windowId,
      title: buildLiveWindowTitle(workspace.name, lens.name),
      workspaceId,
      mainTabIds: ["workspace"],
      sideTabIds: ["current-state"],
      currentMainTabId: "workspace",
      currentSideTabId: "current-state",
    };
  const liveWindowState = parseWorkspaceWindowState(lens.windowStateJson, state.windowId);

  const nextWorkspace = {
    id: workspace.key,
    name: workspace.name,
    color:
      persistedWorkspace?.color ||
      (state.workspace.id === workspace.key ? state.workspace.color : "") ||
      DEFAULT_WORKSPACE_COLOR,
    windows: [
      ...((persistedWorkspace?.windows || []).filter((window) => window.id !== state.windowId)),
      liveWindowState,
    ],
  };

  setState("workspace", nextWorkspace as any);
  patchCurrentLensFlags(workspaceId, lensId);
  setState("ui", "showCommandPalette", false);

  await persistWorkspaceState(nextWorkspace as any);
  await electrobun.rpc?.request.syncWorkspace({
    workspace: nextWorkspace,
  });
  await syncCurrentLocalWindowToWorker({
    workspaceId,
    lensId,
    windowId: state.windowId,
    activeTreeNodeId,
    window: {
      ...templateWindow,
      id: state.windowId,
      workspaceId,
    },
  });
  scheduleDashHostCacheForWindow(
    {
      windowId: state.windowId,
      title: templateWindow.title || buildLiveWindowTitle(workspace.name, lens.name),
      frame: getHostFrameForWindow(liveWindowState),
      workspaceId,
      lensId,
      activeTreeNodeId,
    },
    workspaceId,
    lensId,
  );
}

async function openLocalWindowInNewHostWindow(
  graph: PersistedLocalDashGraph,
  workspaceId: string,
  lensId: string,
  activeTreeNodeId: string,
) {
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  const lens = graph.layouts.find((item) => item.key === lensId);
  if (!workspace || !lens) {
    throw new Error(`Unable to load local workspace/lens: ${workspaceId}/${lensId}`);
  }

  const persistedWorkspace = await loadPersistedWorkspaceState(workspaceId);
  const templateWindow =
    structuredClone(lens.windows[0]) || {
      id: "main",
      title: buildLiveWindowTitle(workspace.name, lens.name),
      workspaceId,
      mainTabIds: ["workspace"],
      sideTabIds: ["current-state"],
      currentMainTabId: "workspace",
      currentSideTabId: "current-state",
    };
  const liveWindowId = makeLiveWindowId(lensId, templateWindow.id || "main");
  const liveWindowState = parseWorkspaceWindowState(lens.windowStateJson, liveWindowId);
  const nextWorkspace = {
    id: workspace.key,
    name: workspace.name,
    color:
      persistedWorkspace?.color ||
      (state.workspace.id === workspace.key ? state.workspace.color : "") ||
      DEFAULT_WORKSPACE_COLOR,
    windows: [
      ...((persistedWorkspace?.windows || []).filter((window) => window.id !== liveWindowId)),
      liveWindowState,
    ],
  };
  const nextRuntimeWindow = {
    ...templateWindow,
    id: liveWindowId,
    title: buildLiveWindowTitle(workspace.name, lens.name, templateWindow.title),
    workspaceId,
  };

  await persistWorkspaceState(nextWorkspace as any);
  await electrobun.rpc?.request.syncWorkspace({
    workspace: nextWorkspace,
  });
  await syncCurrentLocalWindowToWorker({
    workspaceId,
    lensId,
    windowId: liveWindowId,
    activeTreeNodeId,
    window: nextRuntimeWindow,
  });
  hostCreateWindow({
    windowId: liveWindowId,
    title: nextRuntimeWindow.title,
    frame: getHostFrameForWindow(liveWindowState),
  });
  scheduleDashHostCacheForWindow(
    {
      windowId: liveWindowId,
      title: nextRuntimeWindow.title,
      frame: getHostFrameForWindow(liveWindowState),
      workspaceId,
      lensId,
      activeTreeNodeId,
    },
    workspaceId,
    lensId,
  );
}

async function getEditableLocalDashGraph(): Promise<PersistedLocalDashGraph> {
  const persisted = await loadPersistedLocalDashGraph();
  if (persisted) {
    return structuredClone(persisted);
  }

  try {
    const graph = await electrobun.rpc?.request.getLocalDashGraph();
    if (graph) {
      return structuredClone(graph);
    }
  } catch {}
  return (
    {
      workspaces: [],
      projectMounts: [],
      layouts: [],
    }
  );
}

export async function refreshDashRendererStateFromWorker() {
  const [persistedGraph, persistedAppSettings, hostBoot] = await Promise.all([
    loadPersistedLocalDashGraph().catch(() => null),
    loadPersistedAppSettings().catch(() => null),
    getDashHostBootState().catch(() => null),
  ]);

  if (persistedGraph) {
    const windowId = state.windowId || hostBoot?.windowId || "main";
    const target = pickLocalBootTarget(
      persistedGraph,
      windowId,
      hostBoot?.windowTarget,
    );

    if (target) {
      const persistedWorkspace = await loadPersistedWorkspaceState(target.workspaceId);
      const nextWorkspace = buildLocalWorkspaceForBoot(
        persistedGraph,
        target.workspaceId,
        target.lensId,
        windowId,
        persistedWorkspace,
        hostBoot?.windowTarget,
      );

      if (nextWorkspace) {
        const nextAppSettings = mergeAppSettingsForBoot(
          state.appSettings,
          null,
          persistedAppSettings,
        );
        const currentInstance =
          hostBoot?.currentInstance ||
          state.bunnyDash.instances?.find((instance) => instance.isCurrent) ||
          null;
        const nextBunnyDash = buildLocalBunnyDashPayload({
          graph: persistedGraph,
          currentWorkspaceId: target.workspaceId,
          currentLensId: target.lensId,
          currentInstance,
          cloudWorkspaces:
            hostBoot?.dashCache?.cloudWorkspaces || state.bunnyDash.cloudWorkspaces || [],
          knownLocalProjects:
            hostBoot?.dashCache?.knownLocalProjects ||
            state.bunnyDash.knownLocalProjects ||
            [],
        });
        const nextProjects = buildLocalProjectsForWorkspace(
          persistedGraph,
          target.workspaceId,
        );

        setState({
          windowId,
          buildVars: hostBoot?.buildVars || state.buildVars,
          paths: hostBoot?.paths || state.paths,
          peerDependencies: hostBoot?.peerDependencies || state.peerDependencies,
          webBridgeOrigin: hostBoot?.webBridgeOrigin || state.webBridgeOrigin,
          workspace: nextWorkspace as any,
          bunnyDash: nextBunnyDash as any,
          projects: nextProjects,
          tokens: [],
          appSettings: nextAppSettings,
        });

        try {
          await persistWorkspaceState(nextWorkspace as any);
          await persistAppSettings(nextAppSettings);
        } catch (error) {
          console.warn("Failed to persist refreshed local Dash state:", error);
        }

        const activeWindow =
          nextWorkspace.windows.find((window) => window.id === windowId) ||
          nextWorkspace.windows[0];
        if (activeWindow) {
          scheduleDashHostCacheForWindow(
            {
              windowId,
              title: buildBootWindowTitle(
                persistedGraph,
                target.workspaceId,
                target.lensId,
                hostBoot?.windowTarget?.title,
              ),
              frame: getHostFrameForWindow(activeWindow),
              workspaceId: target.workspaceId,
              lensId: target.lensId,
              activeTreeNodeId: target.activeTreeNodeId,
            },
            target.workspaceId,
            target.lensId,
          );
        }

        return;
      }
    }
  }

  const nextState = await getHydratedInitialState();
  if (!nextState) {
    return;
  }

  const payload = nextState as {
    windowId?: string;
    workspace?: unknown;
    bunnyDash?: unknown;
    projects?: Array<{ id: string }>;
    tokens?: unknown[];
    appSettings?: Record<string, unknown>;
  };

  const projectsById = Array.isArray(payload.projects)
    ? payload.projects.reduce((acc: Record<string, any>, project: any) => {
        if (project?.id) {
          acc[project.id] = project;
        }
        return acc;
      }, {})
    : {};

  if (payload.windowId) {
    setState("windowId", payload.windowId);
  }
  if (payload.workspace) {
    setState("workspace", payload.workspace as any);
    persistWorkspaceState(payload.workspace as any).catch((error) => {
      console.warn("Failed to persist workspace locally:", error);
    });
  }
  if (payload.bunnyDash) {
    setState("bunnyDash", payload.bunnyDash as any);
  }
  setState("projects", projectsById);
  setState("tokens", Array.isArray(payload.tokens) ? payload.tokens : []);
  if (payload.appSettings) {
    const nextAppSettings = mergeAppSettingsForBoot(
      state.appSettings,
      payload.appSettings as any,
      null,
    );
    setState("appSettings", nextAppSettings);
    persistAppSettings(nextAppSettings).catch((error) => {
      console.warn("Failed to persist app settings locally:", error);
    });
  }
}

async function syncLocalGraph(graph: PersistedLocalDashGraph) {
  await persistLocalDashGraph(graph);
  await electrobun.rpc?.request.syncLocalDashGraph({ graph });
}

export async function createOrRenameLocalLens(params: {
  workspaceId: string;
  name: string;
  description?: string;
  sourceLensId?: string;
  lensId?: string;
}) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const workspace = graph.workspaces.find((item) => item.key === params.workspaceId);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${params.workspaceId}`);
  }

  const cleanName = params.name.trim();
  if (!cleanName) {
    throw new Error("Lens name is required");
  }

  if (params.lensId) {
    const lens = graph.layouts.find((item) => item.key === params.lensId);
    if (!lens) {
      throw new Error(`Unknown lens: ${params.lensId}`);
    }
    lens.name = cleanName;
    lens.description = params.description?.trim() || "";
    lens.windows = lens.windows.map((window) => ({
      ...window,
      title: buildLiveWindowTitle(workspace.name, cleanName, window.title),
    }));
    await syncLocalGraph(graph);
    await refreshDashRendererStateFromWorker();
    return lens.key;
  }

  const existingKeys = graph.layouts.map((item) => item.key);
  const key = uniqueKey(cleanName, existingKeys);
  const useLiveCurrentWorkspaceState =
    params.workspaceId === state.bunnyDash.currentWorkspaceId &&
    (!params.sourceLensId || params.sourceLensId === state.bunnyDash.currentLensId);
  const sourceLensKey =
    params.sourceLensId ||
    (params.workspaceId === state.bunnyDash.currentWorkspaceId
      ? state.bunnyDash.currentLensId
      : workspaceCurrentLensKey(params.workspaceId));
  const sourceLens =
    graph.layouts.find((item) => item.key === sourceLensKey) ||
    graph.layouts.find((item) => item.key === workspaceCurrentLensKey(params.workspaceId));

  if (!sourceLens) {
    throw new Error(`Missing source lens for workspace ${workspace.name}`);
  }

  if (useLiveCurrentWorkspaceState) {
    await syncWorkspaceNow();
  }

  const liveWindowStateJson =
    useLiveCurrentWorkspaceState ? getCurrentWorkspaceWindowStateJson() : null;
  const templateWindows = getTemplateWindowsForWorkspace(
    graph,
    { key: workspace.key, name: workspace.name },
    sourceLens.key,
  );

  graph.layouts.push({
    key,
    name: cleanName,
    description: params.description?.trim() || "",
    workspaceId: params.workspaceId,
    windowStateJson: liveWindowStateJson || sourceLens.windowStateJson,
    sortOrder: graph.layouts.length,
    windows: templateWindows.map((window) => ({
      ...window,
      title: buildLiveWindowTitle(workspace.name, cleanName, window.title),
      workspaceId: params.workspaceId,
    })),
  });

  await syncLocalGraph(graph);
  await applyLocalLensToCurrentWindow(
    graph,
    params.workspaceId,
    key,
    `lens-overview:${key}`,
  );
  await refreshDashRendererStateFromWorker();
  return key;
}

export async function overwriteCurrentLocalLens() {
  const workspaceId = state.bunnyDash.currentWorkspaceId;
  const lensId = state.bunnyDash.currentLensId;

  if (isCloudWorkspaceId(workspaceId) || isCloudLensId(lensId)) {
    throw new Error("Current lens is not a local lens");
  }

  await syncWorkspaceNow();

  const graph = cloneGraph(await getEditableLocalDashGraph());
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  const lens = graph.layouts.find((item) => item.key === lensId);
  const liveWindowStateJson = getCurrentWorkspaceWindowStateJson();

  if (!workspace || !lens || !liveWindowStateJson) {
    throw new Error("Unable to capture current local lens state");
  }

  lens.windowStateJson = liveWindowStateJson;
  lens.windows = getTemplateWindowsForWorkspace(
    graph,
    { key: workspace.key, name: workspace.name },
    lens.key,
  );

  await syncLocalGraph(graph);
  await refreshDashRendererStateFromWorker();
}

export async function addLocalProjectMount(path: string, projectName?: string) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const workspaceId = state.bunnyDash.currentWorkspaceId;
  const cleanPath = path.trim();
  const cleanName = projectName?.trim() || basename(cleanPath) || "project";
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);

  if (!workspace || isCloudWorkspaceId(workspaceId)) {
    throw new Error("Current workspace is not a local workspace");
  }

  const node = await fsGetNode(cleanPath);
  if (!node || node.type !== "dir") {
    throw new Error(`Project path is not a directory: ${cleanPath}`);
  }

  if (
    graph.projectMounts.some(
      (project) =>
        project.workspaceId === workspaceId &&
        (project.path === cleanPath || project.name === cleanName),
    )
  ) {
    throw new Error(`Workspace ${workspace.name} already contains ${cleanName}`);
  }

  const key = uniqueKey(
    `${workspaceId}-${cleanName}`,
    graph.projectMounts.map((item) => item.key),
  );

  graph.projectMounts.push({
    key,
    workspaceId,
    name: cleanName,
    instanceId: "host-machine",
    instanceLabel: state.bunnyDash.instances.find((item) => item.isCurrent)?.name || "This Machine",
    path: cleanPath,
    kind: "code",
    status: "ready",
    sortOrder: graph.projectMounts.length,
  });

  await syncLocalGraph(graph);
  await refreshDashRendererStateFromWorker();
  return key;
}

export async function editLocalProjectMount(projectId: string, nextName: string, nextPath: string) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const project = graph.projectMounts.find((item) => item.key === projectId);
  if (!project) {
    throw new Error(`Unknown project mount: ${projectId}`);
  }

  const cleanPath = nextPath.trim();
  const cleanName = nextName.trim() || basename(cleanPath) || project.name;
  const node = await fsGetNode(cleanPath);
  if (!node || node.type !== "dir") {
    throw new Error(`Project path is not a directory: ${cleanPath}`);
  }

  project.name = cleanName;
  project.path = cleanPath;

  await syncLocalGraph(graph);
  await refreshDashRendererStateFromWorker();
}

export async function removeLocalProjectMount(projectId: string) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  graph.projectMounts = graph.projectMounts.filter((item) => item.key !== projectId);
  await syncLocalGraph(graph);
  await refreshDashRendererStateFromWorker();
}

export async function createLocalWorkspace(name: string, subtitle = "New Bunny Dash workspace.") {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Workspace name is required");
  }

  const key = uniqueKey(cleanName, graph.workspaces.map((item) => item.key));
  const workspace = {
    key,
    name: cleanName,
    subtitle: subtitle.trim() || "New Bunny Dash workspace.",
    sortOrder: graph.workspaces.length,
  };

  graph.workspaces.push(workspace);
  graph.layouts.push(
    buildDefaultCurrentLensForWorkspace(
      { key: workspace.key, name: workspace.name },
      graph.layouts.length,
    ),
  );

  await syncLocalGraph(graph);
  await applyLocalLensToCurrentWindow(
    graph,
    key,
    workspaceCurrentLensKey(key),
    `workspace-overview:${key}`,
  );
  await refreshDashRendererStateFromWorker();
  return key;
}

export async function updateCurrentLocalWorkspaceName(name: string) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const workspaceId = state.bunnyDash.currentWorkspaceId;
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  if (!workspace || isCloudWorkspaceId(workspaceId)) {
    throw new Error("Current workspace is not a local workspace");
  }

  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error("Workspace name is required");
  }

  workspace.name = cleanName;
  for (const lens of graph.layouts) {
    if (lens.workspaceId !== workspaceId) {
      continue;
    }
    lens.windows = lens.windows.map((window) => ({
      ...window,
      title: buildLiveWindowTitle(cleanName, lens.name, window.title),
    }));
    if (lens.key === workspaceCurrentLensKey(workspaceId)) {
      lens.description = `Current working state for ${cleanName}.`;
    }
  }

  await syncLocalGraph(graph);
  await refreshDashRendererStateFromWorker();
}

export async function deleteCurrentLocalWorkspace(deleteProjectFiles = false) {
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const workspaceId = state.bunnyDash.currentWorkspaceId;
  const localWorkspaces = graph.workspaces.filter((item) => !isCloudWorkspaceId(item.key));
  if (localWorkspaces.length <= 1) {
    return;
  }

  const projectsToRemove = graph.projectMounts.filter((item) => item.workspaceId === workspaceId);
  if (deleteProjectFiles) {
    for (const project of projectsToRemove) {
      await fsSafeDeleteFileOrFolder(project.path);
    }
  }

  graph.projectMounts = graph.projectMounts.filter((item) => item.workspaceId !== workspaceId);
  graph.layouts = graph.layouts.filter((item) => item.workspaceId !== workspaceId);
  graph.workspaces = graph.workspaces.filter((item) => item.key !== workspaceId);

  const fallbackWorkspace =
    graph.workspaces.find((item) => !isCloudWorkspaceId(item.key)) || graph.workspaces[0];

  await syncLocalGraph(graph);
  if (fallbackWorkspace) {
    await applyLocalLensToCurrentWindow(
      graph,
      fallbackWorkspace.key,
      workspaceCurrentLensKey(fallbackWorkspace.key),
      `workspace-overview:${fallbackWorkspace.key}`,
    );
  }
  await refreshDashRendererStateFromWorker();
}

export async function openLocalLens(lensId: string) {
  await syncWorkspaceNow();
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const lens = graph.layouts.find((item) => item.key === lensId);
  if (!lens) {
    throw new Error(`Unknown local lens: ${lensId}`);
  }
  const workspaceId =
    typeof lens.workspaceId === "string" && lens.workspaceId
      ? lens.workspaceId
      : state.bunnyDash.currentWorkspaceId;
  await applyLocalLensToCurrentWindow(graph, workspaceId, lensId, `lens-overview:${lensId}`);
  await refreshDashRendererStateFromWorker();
}

export async function openLocalWorkspace(workspaceId: string) {
  await syncWorkspaceNow();
  const graph = cloneGraph(await getEditableLocalDashGraph());
  await applyLocalLensToCurrentWindow(
    graph,
    workspaceId,
    workspaceCurrentLensKey(workspaceId),
    `workspace-overview:${workspaceId}`,
  );
  await refreshDashRendererStateFromWorker();
}

export async function openLocalLensInNewWindow(lensId: string) {
  await syncWorkspaceNow();
  const graph = cloneGraph(await getEditableLocalDashGraph());
  const lens = graph.layouts.find((item) => item.key === lensId);
  if (!lens) {
    throw new Error(`Unknown local lens: ${lensId}`);
  }
  const workspaceId =
    typeof lens.workspaceId === "string" && lens.workspaceId
      ? lens.workspaceId
      : state.bunnyDash.currentWorkspaceId;
  await openLocalWindowInNewHostWindow(
    graph,
    workspaceId,
    lensId,
    `lens-overview:${lensId}`,
  );
}

export async function openLocalWorkspaceInNewWindow(workspaceId: string) {
  await syncWorkspaceNow();
  const graph = cloneGraph(await getEditableLocalDashGraph());
  await openLocalWindowInNewHostWindow(
    graph,
    workspaceId,
    workspaceCurrentLensKey(workspaceId),
    `workspace-overview:${workspaceId}`,
  );
}

export async function createAdditionalLocalWindow(offset?: {
  x?: number;
  y?: number;
}) {
  await syncWorkspaceNow();
  const currentWindow = getWindow();
  if (!currentWindow) {
    return;
  }

  const workspaceId = state.workspace.id;
  const lensId = state.bunnyDash.currentLensId;
  const liveWindowId = makeLiveWindowId(
    lensId,
    String(state.windowId).split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main",
  );
  const nextWindowState = structuredClone(currentWindow);
  nextWindowState.id = liveWindowId;
  nextWindowState.position = {
    ...nextWindowState.position,
    x: Number(nextWindowState.position?.x || 0) + Number(offset?.x || 0),
    y: Number(nextWindowState.position?.y || 0) + Number(offset?.y || 0),
  };

  const nextWorkspace = {
    ...structuredClone(state.workspace),
    windows: [
      ...(state.workspace.windows || []).filter((window) => window.id !== liveWindowId),
      nextWindowState,
    ],
  };
  const currentLensName =
    state.bunnyDash.workspaces
      .flatMap((workspace) => workspace.lenses)
      .find((lens) => lens.id === lensId)?.name || "Current";
  const nextTitle = buildLiveWindowTitle(
    state.workspace.name,
    currentLensName,
  );

  await persistWorkspaceState(nextWorkspace as any);
  await electrobun.rpc?.request.syncWorkspace({
    workspace: nextWorkspace,
  });
  await syncCurrentLocalWindowToWorker({
    workspaceId,
    lensId,
    windowId: liveWindowId,
    activeTreeNodeId: `lens-overview:${lensId}`,
    window: buildRuntimeTemplateFromLiveWindow(
      nextWindowState,
      liveWindowId,
      workspaceId,
      nextTitle,
    ),
  });
  hostCreateWindow({
    windowId: liveWindowId,
    title: nextTitle,
    frame: getHostFrameForWindow(nextWindowState),
  });
  scheduleDashHostCacheForWindow(
    {
      windowId: liveWindowId,
      title: nextTitle,
      frame: getHostFrameForWindow(nextWindowState),
      workspaceId,
      lensId,
      activeTreeNodeId: `lens-overview:${lensId}`,
    },
    workspaceId,
    lensId,
  );
}
