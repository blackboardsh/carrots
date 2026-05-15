import type { ProjectType } from "../../shared/types/types";
import type {
  BunnyDashCloudWorkspaceTreeType,
  BunnyDashInstanceType,
  BunnyDashKnownLocalProjectType,
  WorkspaceType,
} from "./store";
import type { PersistedLocalDashGraph } from "./localStateDb";
import type { DashHostWindowSummary } from "./dashHostCache";

const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const DEFAULT_WORKSPACE_COLOR = "#184d8b";

export function workspaceCurrentLensKey(workspaceId: string) {
  return `${WORKSPACE_CURRENT_LENS_PREFIX}${workspaceId}`;
}

function isCloudWorkspaceId(workspaceId: string) {
  return workspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX);
}

export function makeDefaultBunnyWindow(id = "main") {
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

export function parseWorkspaceWindowState(
  windowStateJson: string | undefined,
  windowId: string,
) {
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

function buildLiveWindowTitle(
  workspaceName: string,
  lensName: string,
  windowTitle?: string,
) {
  return windowTitle?.trim() || `${workspaceName} · ${lensName}`;
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

export function buildRuntimeTemplateFromLiveWindow(
  liveWindow: {
    rootPane?: unknown;
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

export function pickLocalBootTarget(
  graph: PersistedLocalDashGraph | null,
  windowId: string,
  windowTarget?: DashHostWindowSummary | null,
) {
  if (!graph || graph.workspaces.length === 0) {
    return null;
  }

  const preferredWorkspaceId =
    windowTarget?.workspaceId || graph.workspaces[0]?.key || "";
  const preferredLensId =
    windowTarget?.lensId || workspaceCurrentLensKey(preferredWorkspaceId);

  const workspace =
    graph.workspaces.find((item) => item.key === preferredWorkspaceId) || graph.workspaces[0];
  if (!workspace) {
    return null;
  }

  const lens =
    graph.layouts.find((item) => item.key === preferredLensId) ||
    graph.layouts.find((item) => item.key === workspaceCurrentLensKey(workspace.key)) ||
    graph.layouts.find((item) => item.workspaceId === workspace.key) ||
    null;
  if (!lens) {
    return null;
  }

  return {
    workspaceId: workspace.key,
    lensId: lens.key,
    windowId,
    activeTreeNodeId:
      windowTarget?.activeTreeNodeId ||
      `lens-overview:${lens.key}`,
  };
}

export function buildLocalWorkspaceForBoot(
  graph: PersistedLocalDashGraph,
  workspaceId: string,
  lensId: string,
  windowId: string,
  persistedWorkspace: WorkspaceType | null,
  windowTarget?: DashHostWindowSummary | null,
): WorkspaceType | null {
  const hasUsableWindowLayout = (window: WorkspaceType["windows"][number] | null | undefined) => {
    return Boolean(
      window &&
        window.id &&
        window.rootPane &&
        typeof window.rootPane === "object" &&
        "type" in window.rootPane &&
        window.tabs &&
        typeof window.tabs === "object" &&
        Object.keys(window.tabs).length > 0 &&
        window.currentPaneId,
    );
  };

  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  const lens = graph.layouts.find((item) => item.key === lensId);
  if (!workspace || !lens) {
    return null;
  }

  const persistedWindow = persistedWorkspace?.windows?.find(
    (window) => window.id === windowId,
  );
  const baseWindow = hasUsableWindowLayout(persistedWindow)
    ? persistedWindow
    : parseWorkspaceWindowState(lens.windowStateJson, windowId);
  if (windowTarget?.frame) {
    baseWindow.position = {
      ...baseWindow.position,
      x: windowTarget.frame.x,
      y: windowTarget.frame.y,
      width: windowTarget.frame.width,
      height: windowTarget.frame.height,
    };
  }

  return {
    id: workspace.key,
    name: workspace.name,
    color:
      persistedWorkspace?.color ||
      DEFAULT_WORKSPACE_COLOR,
    windows: [
      ...((persistedWorkspace?.windows || []).filter((window) => window.id !== windowId)),
      baseWindow,
    ],
  };
}

export function buildLocalBunnyDashPayload(params: {
  graph: PersistedLocalDashGraph;
  currentWorkspaceId: string;
  currentLensId: string;
  currentInstance: BunnyDashInstanceType | null;
  cloudWorkspaces?: BunnyDashCloudWorkspaceTreeType[];
  knownLocalProjects?: BunnyDashKnownLocalProjectType[];
}) {
  const {
    graph,
    currentWorkspaceId,
    currentLensId,
    currentInstance,
    cloudWorkspaces = [],
  } = params;

  const knownLocalProjects =
    params.knownLocalProjects && params.knownLocalProjects.length > 0
      ? params.knownLocalProjects
      : Array.from(
          new Map(
            graph.projectMounts.map((mount) => [
              mount.path,
              {
                id: mount.key,
                name: mount.name,
                path: mount.path,
                instanceId: mount.instanceId || "host-machine",
                instanceLabel: mount.instanceLabel || "This Machine",
                kind: mount.kind || "project",
                status: mount.status || "available",
              },
            ]),
          ).values(),
        );

  const workspaces = graph.workspaces
    .filter((workspace) => !isCloudWorkspaceId(workspace.key))
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((workspace) => {
      const lenses = graph.layouts
        .filter((lens) => {
          const lensWorkspaceId = lens.workspaceId || "";
          return lensWorkspaceId === workspace.key || lens.key === workspaceCurrentLensKey(workspace.key);
        })
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((lens) => ({
          id: lens.key,
          name: lens.name,
          description: lens.description,
          workspaceId: workspace.key,
          isCurrent:
            workspace.key === currentWorkspaceId &&
            lens.key === currentLensId,
          isDirty: false,
        }));

      return {
        id: workspace.key,
        name: workspace.name,
        subtitle: workspace.subtitle,
        isCurrent: workspace.key === currentWorkspaceId,
        currentLensId: workspaceCurrentLensKey(workspace.key),
        currentLensIsActive:
          workspace.key === currentWorkspaceId &&
          currentLensId === workspaceCurrentLensKey(workspace.key),
        canExpand: lenses.length > 0,
        lenses,
      };
    });

  return {
    currentWorkspaceId,
    currentLensId,
    instances: currentInstance ? [currentInstance] : [],
    workspaces,
    cloudWorkspaces,
    knownLocalProjects,
  };
}

export function buildLocalProjectsForWorkspace(
  graph: PersistedLocalDashGraph,
  workspaceId: string,
): Record<string, ProjectType> {
  return graph.projectMounts
    .filter((mount) => mount.workspaceId === workspaceId)
    .reduce((acc, mount) => {
      acc[mount.key] = {
        id: mount.key,
        name: mount.name,
        path: mount.path,
        instanceId: mount.instanceId,
        instanceLabel: mount.instanceLabel,
        kind: mount.kind,
        status: mount.status,
      };
      return acc;
    }, {} as Record<string, ProjectType>);
}

export function buildBootWindowTitle(
  graph: PersistedLocalDashGraph,
  workspaceId: string,
  lensId: string,
  windowTitle?: string,
) {
  const workspace = graph.workspaces.find((item) => item.key === workspaceId);
  const lens = graph.layouts.find((item) => item.key === lensId);
  return buildLiveWindowTitle(
    workspace?.name || "Workspace",
    lens?.name || "Current",
    windowTitle,
  );
}
