import {
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CloudApi,
  getApiBaseUrl,
  type CloudWorkspace,
} from "./cloudApi";
import { app } from "electrobun/bun";
import {
  createDashDb,
  type DashDb,
  type DashDocumentTypes,
  migrateLegacyExampleData,
  seedDashDb,
  type LensWindow,
  type WindowTabId,
} from "./db";

type BunnyPane =
  | {
      id: string;
      tabIds: string[];
      currentTabId: string | null;
      type: "pane";
    }
  | {
      id: string;
      direction: "row" | "column";
      divider: number;
      panes: BunnyPane[];
      type: "container";
    };

type BunnyWindow = {
  id: string;
  ui: {
    showSidebar: boolean;
    sidebarWidth: number;
  };
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  expansions: string[];
  rootPane: BunnyPane;
  currentPaneId: string;
  tabs: Record<string, any>;
};

type BunnyWorkspace = {
  id: string;
  name: string;
  color: string;
  windows: BunnyWindow[];
};

type BunnyAppSettings = {
  llama: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    temperature: number;
    inlineEnabled: boolean;
  };
  github: {
    accessToken: string;
    username: string;
    connectedAt?: number | undefined;
    scopes: string[];
  };
  bunnyCloud: {
    accessToken: string;
    refreshToken: string;
    userId: string;
    email: string;
    name: string;
    emailVerified: boolean;
    connectedAt?: number | undefined;
  };
};

type PersistedBunnyDashState = {
  workspaces?: Record<string, BunnyWorkspace>;
  appSettings?: BunnyAppSettings;
};

type CurrentState = {
  updatedAt: number;
  currentLayoutId: string;
  currentWindowId: string;
  windows: LensWindow[];
};

type DashState = {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  bunnyPopoverOpen: boolean;
  commandQuery: string;
  currentLayoutId: string;
  currentWindowId: string;
  activeTreeNodeId: string;
};

type WorkspaceDoc = DashDocumentTypes["workspaces"];
type ProjectMountDoc = DashDocumentTypes["projectMounts"];
type LensDoc = DashDocumentTypes["layouts"];
type CurrentStateDoc = DashDocumentTypes["sessionSnapshots"];
type UiSettingsDoc = DashDocumentTypes["uiSettings"];

let statePath = "";
let dashDb: DashDb | null = null;
let manifestVersion = "0.0.1";
let runtimeChannel = "dev";
let runtimeAuthToken: string | null = null;
let runtimeWindows: LensWindow[] = [];
const hostWindowIds = new Set<string>();
const expandedFsDirs = new Set<string>();
const framePersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const LIVE_WINDOW_ID_SEPARATOR = "::";
const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const CLOUD_LENS_SHADOW_PREFIX = "__cloud_lens__:";
const LEGACY_CURRENT_SESSION_MAIN_TABS: WindowTabId[] = [
  "workspace",
  "projects",
  "lens",
  "instances",
  "cloud",
];
const LEGACY_CURRENT_SESSION_SIDE_TABS: WindowTabId[] = [
  "current-state",
  "windows",
  "notes",
  "cloud",
];
const DEFAULT_STARTER_LENS_WINDOW: LensWindow = {
  id: "main",
  lensId: "starter-lens",
  title: "Main",
  workspaceId: "local-workspace",
  mainTabIds: ["workspace"],
  sideTabIds: ["current-state"],
  currentMainTabId: "workspace",
  currentSideTabId: "current-state",
};
let currentState: CurrentState = {
  updatedAt: Date.now(),
  currentLayoutId: "starter-lens",
  currentWindowId: "main",
  windows: [],
};

const defaultBunnyAppSettings: BunnyAppSettings = {
  llama: {
    enabled: true,
    baseUrl: "llama.cpp",
    model: "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
    temperature: 0.1,
    inlineEnabled: true,
  },
  github: {
    accessToken: "",
    username: "",
    connectedAt: undefined,
    scopes: [],
  },
  bunnyCloud: {
    accessToken: "",
    refreshToken: "",
    userId: "",
    email: "",
    name: "",
    emailVerified: false,
    connectedAt: undefined,
  },
};

let bunnyDashState: PersistedBunnyDashState = {
  workspaces: {},
  appSettings: structuredClone(defaultBunnyAppSettings),
};
const UNHANDLED_DASH_REQUEST = Symbol("unhandled-bunny-dash-request");

// Cloud API state
let cloudApi: CloudApi | null = null;
let cloudWorkspaces: CloudWorkspace[] = [];

function initCloudApi(): CloudApi | null {
  // Use auth token from Bunny Ears (passed via init context) or from persisted dash state
  const earsToken = runtimeAuthToken || app.authToken;
  const persistedAuth = bunnyDashState.appSettings?.bunnyCloud;
  const accessToken = earsToken || persistedAuth?.accessToken;
  if (!accessToken) return null;

  const channel = runtimeChannel || app.channel || (manifestVersion === "0.0.1" ? "dev" : undefined);
  return new CloudApi(getApiBaseUrl(channel), {
    getAuth: () => ({
      accessToken: runtimeAuthToken || app.authToken || bunnyDashState.appSettings?.bunnyCloud?.accessToken || "",
      refreshToken: bunnyDashState.appSettings?.bunnyCloud?.refreshToken || "",
    }),
    onTokenRefresh: (tokens) => {
      if (bunnyDashState.appSettings?.bunnyCloud) {
        bunnyDashState.appSettings.bunnyCloud.accessToken = tokens.accessToken;
        bunnyDashState.appSettings.bunnyCloud.refreshToken = tokens.refreshToken;
        writePersistedDashState().catch(() => {});
        broadcastAppSettings();
      }
    },
  });
}

async function refreshCloudData() {
  if (!cloudApi) return;
  const workspaces = await cloudApi.listWorkspaces().catch(() => []);
  cloudWorkspaces = workspaces;
  syncCloudShadowState();
  log(`cloud: ${cloudWorkspaces.length} workspace(s)`);
}

function cloudShadowWorkspaceKey(cloudWorkspaceId: string) {
  return `${CLOUD_WORKSPACE_SHADOW_PREFIX}${cloudWorkspaceId}`;
}

function cloudShadowLensKey(cloudLensId: string) {
  return `${CLOUD_LENS_SHADOW_PREFIX}${cloudLensId}`;
}

function isCloudShadowWorkspaceKey(workspaceId: string) {
  return workspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX);
}

function isCloudShadowLensKey(lensId: string) {
  return lensId.startsWith(CLOUD_LENS_SHADOW_PREFIX);
}

function cloudWorkspaceIdFromShadowKey(workspaceId: string) {
  return workspaceId.replace(CLOUD_WORKSPACE_SHADOW_PREFIX, "");
}

function cloudLensIdFromShadowKey(lensId: string) {
  return lensId.replace(CLOUD_LENS_SHADOW_PREFIX, "");
}

function getCloudChannel() {
  return runtimeChannel || app.channel || (manifestVersion === "0.0.1" ? "dev" : undefined);
}

const ACTIVE_INTERNAL_PREFIX = "__BUNNY_INTERNAL__";
const ACTIVE_TEMPLATE_PREFIX = "__BUNNY_TEMPLATE__";

let state: DashState = {
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  bunnyPopoverOpen: false,
  commandQuery: "",
  currentLayoutId: "starter-lens",
  currentWindowId: "main",
  activeTreeNodeId: "lens-overview:starter-lens",
};

let bootPromise: Promise<void> | null = null;

function cloneWindows(value: LensWindow[]) {
  return structuredClone(value);
}

function sameTabIds(left: WindowTabId[], right: WindowTabId[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameLensWindowTemplate(left: LensWindow, right: LensWindow) {
  return (
    left.workspaceId === right.workspaceId &&
    left.title === right.title &&
    left.currentMainTabId === right.currentMainTabId &&
    left.currentSideTabId === right.currentSideTabId &&
    sameTabIds(left.mainTabIds, right.mainTabIds) &&
    sameTabIds(left.sideTabIds, right.sideTabIds)
  );
}

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "untitled";
}

function workspaceCurrentLensKey(workspaceId: string) {
  return `${WORKSPACE_CURRENT_LENS_PREFIX}${workspaceId}`;
}

function isWorkspaceCurrentLensKey(key: string) {
  return key.startsWith(WORKSPACE_CURRENT_LENS_PREFIX);
}

function log(message: string) {
  post({ type: "action", action: "log", payload: { message } });
}

function post(message: unknown) {
  self.postMessage(message);
}

function broadcastRuntimeEventToDashWindows(name: string, payload?: unknown) {
  post({
    type: "action",
    action: "emit-view",
    payload: { raw: true, name, payload },
  });
}

function ensureDb() {
  if (!dashDb) {
    throw new Error("Bunny Dash DB has not been initialized");
  }
  return dashDb;
}

function initializeRuntimeContext(message?: {
  context?: {
    statePath?: string;
    authToken?: string | null;
    channel?: string;
  };
  manifest?: { version?: string };
}) {
  const context = message?.context;
  statePath = context?.statePath || app.statePath || statePath;
  manifestVersion = message?.manifest?.version || app.manifest?.version || manifestVersion;
  runtimeChannel = context?.channel || app.channel || runtimeChannel || "dev";
  if (context && "authToken" in context) {
    runtimeAuthToken = context.authToken || null;
  } else {
    runtimeAuthToken = app.authToken || runtimeAuthToken;
  }
}

function ensureBootPromise() {
  if (!bootPromise) {
    if (!statePath) {
      return Promise.resolve();
    }
    bootPromise = (async () => {
      await loadState();
      
      // Initialize cloud API if logged in
      cloudApi = initCloudApi();
      if (cloudApi) {
        await refreshCloudData();
      }

      ensureRuntimeState();
      currentState = captureCurrentState();
      post({ type: "ready" });
      log("bunny dash worker initialized");
    })();
  }

  return bootPromise;
}

initializeRuntimeContext();
if (statePath) {
  void ensureBootPromise().catch((err) => {
    console.error("[bunny-dash] boot failed:", err);
  });
}

// Reinitialize cloud API when auth token changes (e.g., Farm login while dash is running)
app.on("auth-token-changed", (payload) => {
  const nextToken = (payload as { token?: unknown } | undefined)?.token;
  if (typeof nextToken === "string" && nextToken) {
    runtimeAuthToken = nextToken;
  }
  syncAuthFromEars().catch(() => {});
});

// Clear cloud state on logout
app.on("auth-token-cleared", () => {
  runtimeAuthToken = null;
  cloudApi = null;
  cloudWorkspaces = [];
  fallbackToVisibleLocalWorkspace();
  syncCloudShadowState();
  if (bunnyDashState.appSettings?.bunnyCloud) {
    bunnyDashState.appSettings.bunnyCloud = structuredClone(defaultBunnyAppSettings.bunnyCloud);
  }
  writePersistedDashState().catch(() => {});
  broadcastAppSettings();
  emitSetProjects();
});

function broadcastAppSettings() {
  const settings = bunnyDashState.appSettings || defaultBunnyAppSettings;
  broadcastRuntimeEventToDashWindows("appSettingsChanged", { appSettings: settings });
}

async function syncAuthFromEars() {
  const token = runtimeAuthToken || app.authToken;
  if (!token) return;

  // Update the persisted bunnyCloud settings so the view shows logged-in state
  if (!bunnyDashState.appSettings) {
    bunnyDashState.appSettings = structuredClone(defaultBunnyAppSettings);
  }
  bunnyDashState.appSettings.bunnyCloud.accessToken = token;

  // Fetch user profile to get email/name
  const channel = runtimeChannel || app.channel || "dev";
  const apiBase = getApiBaseUrl(channel);
  try {
    const resp = await fetch(`${apiBase}/v1/user/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const user = await resp.json() as { user?: { email?: string; name?: string; id?: string; email_verified?: boolean } };
      if (user?.user) {
        bunnyDashState.appSettings.bunnyCloud.email = user.user.email || "";
        bunnyDashState.appSettings.bunnyCloud.name = user.user.name || "";
        bunnyDashState.appSettings.bunnyCloud.userId = user.user.id || "";
        bunnyDashState.appSettings.bunnyCloud.emailVerified = !!user.user.email_verified;
        bunnyDashState.appSettings.bunnyCloud.connectedAt = new Date().toISOString();
      }
    }
  } catch {}

  // Reinitialize cloud API and refresh
  cloudApi = initCloudApi();
  if (cloudApi) {
    await refreshCloudData();
  }
  await writePersistedDashState().catch(() => {});
  broadcastAppSettings();
  emitSetProjects();
}

function flushDb() {
  const db = ensureDb() as any;
  if (typeof db.trySave === "function") {
    db.trySave();
  }
}

function getLensesForWorkspace(workspaceId: string) {
  return listLenses().filter(
    (lens) => getLensWorkspaceId(lens) === workspaceId && !isWorkspaceCurrentLensKey(lens.key),
  );
}

function setActiveWindow(windowId?: string) {
  if (!windowId) {
    return;
  }
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    return;
  }
  state.currentWindowId = windowId;
  const lensId = getLensIdForWindow(runtimeWindow);
  if (lensId && findLensByKey(lensId)) {
    state.currentLayoutId = lensId;
  }
  syncActiveTreeNode();
}

function listWorkspaces() {
  return [...(ensureDb().collection("workspaces").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function listVisibleLocalWorkspaces() {
  return listWorkspaces().filter((workspace) => !isCloudShadowWorkspaceKey(workspace.key));
}

function listProjectMounts() {
  return [...(ensureDb().collection("projectMounts").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function listLenses() {
  return [...(ensureDb().collection("layouts").query().data || [])].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

function findWorkspaceByKey(key: string) {
  return listWorkspaces().find((workspace) => workspace.key === key) || null;
}

function findProjectMountByKey(key: string) {
  return listProjectMounts().find((project) => project.key === key) || null;
}

function findLensByKey(key: string) {
  return listLenses().find((layout) => layout.key === key) || null;
}

function getWorkspaceByKey(key: string) {
  const workspace = findWorkspaceByKey(key);
  if (!workspace) {
    throw new Error(`Unknown workspace: ${key}`);
  }
  return workspace;
}

function getLensByKey(key: string) {
  const layout = findLensByKey(key);
  if (!layout) {
    throw new Error(`Unknown lens: ${key}`);
  }
  return layout;
}

function ensureWorkspaceCurrentLens(workspaceId: string) {
  const existing = findLensByKey(workspaceCurrentLensKey(workspaceId));
  if (existing) {
    return existing;
  }

  const db = ensureDb();
  const workspace = getWorkspaceByKey(workspaceId);
  const hiddenLens = db.collection("layouts").insert({
    key: workspaceCurrentLensKey(workspaceId),
    name: "Current",
    description: `Current working state for ${workspace.name}.`,
    workspaceId,
    windowStateJson: serializeBunnyWindow(makeDefaultBunnyWindow("main")),
    sortOrder: listLenses().length,
    windows: [
      {
        id: "main",
        title: buildLiveWindowTitle(workspace, { name: "Current" } as LensDoc, "Main"),
        workspaceId,
        mainTabIds: ["workspace"],
        sideTabIds: ["current-state"],
        currentMainTabId: "workspace",
        currentSideTabId: "current-state",
      },
    ],
  });
  flushDb();
  return hiddenLens;
}

function getProjectMountsForWorkspace(workspaceId: string) {
  return listProjectMounts().filter((project) => project.workspaceId === workspaceId);
}

function fallbackToVisibleLocalWorkspace() {
  const fallbackWorkspace = listVisibleLocalWorkspaces()[0];
  if (!fallbackWorkspace) {
    return;
  }
  const fallbackLens = ensureWorkspaceCurrentLens(fallbackWorkspace.key);
  for (const runtimeWindow of runtimeWindows) {
    if (!isCloudShadowWorkspaceKey(runtimeWindow.workspaceId)) {
      continue;
    }
    const restored = buildRuntimeWindowFromLens(fallbackLens, runtimeWindow.id);
    runtimeWindow.workspaceId = restored.workspaceId;
    runtimeWindow.lensId = restored.lensId;
    runtimeWindow.title = restored.title;
    runtimeWindow.mainTabIds = [...restored.mainTabIds];
    runtimeWindow.sideTabIds = [...restored.sideTabIds];
    runtimeWindow.currentMainTabId = restored.currentMainTabId;
    runtimeWindow.currentSideTabId = restored.currentSideTabId;
    removeBunnyWindowFromAllWorkspaces(runtimeWindow.id);
    upsertBunnyWindowForWorkspace(restored.workspaceId, makeDefaultBunnyWindow(runtimeWindow.id));
  }
  if (isCloudShadowLensKey(state.currentLayoutId)) {
    state.currentLayoutId = fallbackLens.key;
  }
  const currentRuntimeWindow = runtimeWindows.find((window) => window.id === state.currentWindowId);
  if (currentRuntimeWindow && isCloudShadowWorkspaceKey(currentRuntimeWindow.workspaceId)) {
    state.currentLayoutId = fallbackLens.key;
    currentRuntimeWindow.workspaceId = fallbackWorkspace.key;
    currentRuntimeWindow.lensId = fallbackLens.key;
  }
  state.activeTreeNodeId = `workspace-overview:${fallbackWorkspace.key}`;
}

function syncCloudShadowState() {
  const db = ensureDb();
  const activeWorkspaceShadowKeys = new Set<string>();
  const activeLensShadowKeys = new Set<string>();

  for (const cloudWorkspace of cloudWorkspaces) {
    const shadowWorkspaceKey = cloudShadowWorkspaceKey(cloudWorkspace.id);
    activeWorkspaceShadowKeys.add(shadowWorkspaceKey);
    const subtitle = cloudWorkspace.description?.trim()
      ? cloudWorkspace.description
      : "Cloud workspace";
    const existingWorkspace = findWorkspaceByKey(shadowWorkspaceKey);

    if (existingWorkspace) {
      db.collection("workspaces").update(existingWorkspace.id, {
        name: cloudWorkspace.name,
        subtitle,
        sortOrder: 10000 + (cloudWorkspace.sort_order || 0),
      });
    } else {
      db.collection("workspaces").insert({
        key: shadowWorkspaceKey,
        name: cloudWorkspace.name,
        subtitle,
        sortOrder: 10000 + (cloudWorkspace.sort_order || 0),
      });
    }

    const existingCurrentLens = findLensByKey(workspaceCurrentLensKey(shadowWorkspaceKey));
    const currentLens = existingCurrentLens || ensureWorkspaceCurrentLens(shadowWorkspaceKey);
    if (existingCurrentLens) {
      db.collection("layouts").update(currentLens.id, {
        name: "Current",
        description: `Current working state for ${cloudWorkspace.name}.`,
        workspaceId: shadowWorkspaceKey,
      });
    } else {
      const currentWindowTemplate = buildDefaultCloudWindowTemplate(
        shadowWorkspaceKey,
        cloudWorkspace.name,
      );
      db.collection("layouts").update(currentLens.id, {
        name: "Current",
        description: `Current working state for ${cloudWorkspace.name}.`,
        workspaceId: shadowWorkspaceKey,
        windowStateJson: serializeBunnyWindow(makeDefaultBunnyWindow("main")),
        windows: [currentWindowTemplate],
      });
    }

    for (const cloudLens of cloudWorkspace.lenses || []) {
      const shadowLensKey = cloudShadowLensKey(cloudLens.id);
      activeLensShadowKeys.add(shadowLensKey);
      const parsed = parseCloudLensLayout(
        cloudLens.layout_json,
        shadowWorkspaceKey,
        cloudWorkspace.name,
        cloudLens.name,
      );
      const existingLens = findLensByKey(shadowLensKey);
      const updates = {
        name: cloudLens.name,
        description: cloudLens.description || "",
        workspaceId: shadowWorkspaceKey,
        windowStateJson: serializeBunnyWindow(parsed.bunnyWindow),
        sortOrder: 10000 + (cloudLens.sort_order || 0),
        windows: parsed.windows,
      };

      if (existingLens) {
        db.collection("layouts").update(existingLens.id, updates);
      } else {
        db.collection("layouts").insert({
          key: shadowLensKey,
          ...updates,
        });
      }
    }
  }

  for (const workspace of listWorkspaces()) {
    if (!isCloudShadowWorkspaceKey(workspace.key)) continue;
    if (activeWorkspaceShadowKeys.has(workspace.key)) continue;
    const currentLens = findLensByKey(workspaceCurrentLensKey(workspace.key));
    if (currentLens) {
      db.collection("layouts").remove(currentLens.id);
    }
    db.collection("workspaces").remove(workspace.id);
  }

  for (const lens of listLenses()) {
    if (!isCloudShadowLensKey(lens.key)) continue;
    if (activeLensShadowKeys.has(lens.key)) continue;
    db.collection("layouts").remove(lens.id);
  }

  flushDb();
}

function makeDefaultBunnyWindow(id = "main"): BunnyWindow {
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

function cloneBunnyWindow(value: BunnyWindow) {
  return structuredClone(value);
}

function serializeBunnyWindow(value: BunnyWindow) {
  return JSON.stringify(value);
}

function buildDefaultCloudWindowTemplate(workspaceId: string, workspaceName: string): LensWindow {
  return {
    id: "main",
    title: `${workspaceName} · Main`,
    workspaceId,
    mainTabIds: ["workspace"],
    sideTabIds: ["current-state"],
    currentMainTabId: "workspace",
    currentSideTabId: "current-state",
  };
}

function serializeCloudLensLayout(currentBunnyWindow: BunnyWindow, currentWindow: LensWindow) {
  return JSON.stringify({
    version: 1,
    bunnyWindow: cloneBunnyWindow(currentBunnyWindow),
    windowTemplate: toLensTemplateWindow(currentWindow),
  });
}

function parseCloudLensLayout(
  layoutJson: string | undefined,
  workspaceId: string,
  workspaceName: string,
  fallbackLensName: string,
) {
  const defaultTemplate = buildDefaultCloudWindowTemplate(workspaceId, workspaceName);
  const defaultWindowState = makeDefaultBunnyWindow(defaultTemplate.id);

  if (!layoutJson || !layoutJson.trim() || layoutJson.trim() === "{}") {
    return {
      bunnyWindow: defaultWindowState,
      windows: [defaultTemplate],
    };
  }

  try {
    const parsed = JSON.parse(layoutJson) as {
      bunnyWindow?: BunnyWindow;
      windowTemplate?: Partial<LensWindow>;
    };
    const nextBunnyWindow = parsed?.bunnyWindow
      ? cloneBunnyWindow(parsed.bunnyWindow)
      : defaultWindowState;
    const nextTemplate: LensWindow = {
      ...defaultTemplate,
      ...(parsed?.windowTemplate || {}),
      id: "main",
      workspaceId,
      title:
        typeof parsed?.windowTemplate?.title === "string" &&
        parsed.windowTemplate.title.trim()
          ? parsed.windowTemplate.title
          : `${workspaceName} · ${fallbackLensName}`,
      mainTabIds:
        Array.isArray(parsed?.windowTemplate?.mainTabIds) &&
        parsed.windowTemplate.mainTabIds.length > 0
          ? (parsed.windowTemplate.mainTabIds as WindowTabId[])
          : defaultTemplate.mainTabIds,
      sideTabIds:
        Array.isArray(parsed?.windowTemplate?.sideTabIds) &&
        parsed.windowTemplate.sideTabIds.length > 0
          ? (parsed.windowTemplate.sideTabIds as WindowTabId[])
          : defaultTemplate.sideTabIds,
      currentMainTabId:
        typeof parsed?.windowTemplate?.currentMainTabId === "string"
          ? (parsed.windowTemplate.currentMainTabId as WindowTabId)
          : defaultTemplate.currentMainTabId,
      currentSideTabId:
        typeof parsed?.windowTemplate?.currentSideTabId === "string"
          ? (parsed.windowTemplate.currentSideTabId as WindowTabId)
          : defaultTemplate.currentSideTabId,
    };

    return {
      bunnyWindow: nextBunnyWindow,
      windows: [nextTemplate],
    };
  } catch (error) {
    log(
      `failed to parse cloud lens layout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      bunnyWindow: defaultWindowState,
      windows: [defaultTemplate],
    };
  }
}

function parseStoredBunnyWindow(lens: LensDoc) {
  if (typeof lens.windowStateJson === "string" && lens.windowStateJson.trim()) {
    try {
      return JSON.parse(lens.windowStateJson) as BunnyWindow;
    } catch (error) {
      log(
        `failed to parse stored lens window for ${lens.key}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return makeDefaultBunnyWindow(lens.windows[0]?.id || "main");
}

function getLensWorkspaceId(lens: LensDoc) {
  return lens.workspaceId || lens.windows[0]?.workspaceId || "local-workspace";
}

function makeLiveWindowId(lensId: string, baseWindowId = "main") {
  return `${lensId}${LIVE_WINDOW_ID_SEPARATOR}${baseWindowId}${LIVE_WINDOW_ID_SEPARATOR}${Date.now()}`;
}

function lensIdFromWindowId(windowId: string) {
  const maybeLensId = windowId.split(LIVE_WINDOW_ID_SEPARATOR)[0];
  if (maybeLensId && findLensByKey(maybeLensId)) {
    return maybeLensId;
  }
  return null;
}

function getLensIdForWindow(window: LensWindow) {
  if (window.lensId && findLensByKey(window.lensId)) {
    return window.lensId;
  }
  return lensIdFromWindowId(window.id) || state.currentLayoutId;
}

function resolveWindowLensId(window: LensWindow) {
  if (window.lensId && findLensByKey(window.lensId)) {
    return window.lensId;
  }
  const fromId = lensIdFromWindowId(window.id);
  if (fromId && findLensByKey(fromId)) {
    return fromId;
  }
  if (window.id === state.currentWindowId && findLensByKey(state.currentLayoutId)) {
    return state.currentLayoutId;
  }
  return ensureWorkspaceCurrentLens(window.workspaceId).key;
}

function buildLiveWindowTitle(workspace: WorkspaceDoc, lens: LensDoc, windowTitle?: string) {
  return windowTitle?.trim() || `${workspace.name} · ${lens.name}`;
}

function removeBunnyWindowFromAllWorkspaces(windowId: string) {
  for (const workspace of Object.values(bunnyDashState.workspaces || {})) {
    workspace.windows = (workspace.windows || []).filter((window) => window.id !== windowId);
  }
}

function upsertBunnyWindowForWorkspace(workspaceId: string, window: BunnyWindow) {
  const workspace = getOrCreateBunnyWorkspace(workspaceId);
  const existingIndex = workspace.windows.findIndex((candidate) => candidate.id === window.id);
  if (existingIndex >= 0) {
    workspace.windows[existingIndex] = cloneBunnyWindow(window);
  } else {
    workspace.windows = [...workspace.windows, cloneBunnyWindow(window)];
  }
}

function ensureBunnyWorkspaceWindow(runtimeWindow: LensWindow, lens?: LensDoc) {
  const workspaceId = runtimeWindow.workspaceId;
  const workspace = getOrCreateBunnyWorkspace(workspaceId);
  const existing = workspace.windows.find((candidate) => candidate.id === runtimeWindow.id);
  if (existing) {
    return existing;
  }

  const resolvedLens = lens || findLensByKey(getLensIdForWindow(runtimeWindow)) || getCurrentLens();
  const next = cloneBunnyWindow(parseStoredBunnyWindow(resolvedLens));
  next.id = runtimeWindow.id;
  upsertBunnyWindowForWorkspace(workspaceId, next);
  return next;
}

function getBunnyWindowForRuntimeWindow(windowId: string) {
  for (const workspace of Object.values(bunnyDashState.workspaces || {})) {
    const existing = workspace.windows.find((candidate) => candidate.id === windowId);
    if (existing) {
      return existing;
    }
  }
  const runtimeWindow = runtimeWindows.find((candidate) => candidate.id === windowId);
  if (!runtimeWindow) {
    return null;
  }
  return ensureBunnyWorkspaceWindow(runtimeWindow);
}

function getOrCreateBunnyWorkspace(workspaceId: string) {
  const workspaceDoc = getWorkspaceByKey(workspaceId);
  const workspaces = (bunnyDashState.workspaces ||= {});
  if (!workspaces[workspaceId]) {
    workspaces[workspaceId] = {
      id: workspaceId,
      name: workspaceDoc.name,
      color: "#184d8b",
      windows: [makeDefaultBunnyWindow("main")],
    };
  }

  workspaces[workspaceId]!.name = workspaceDoc.name;
  return workspaces[workspaceId]!;
}

function currentBunnyWorkspace() {
  return getOrCreateBunnyWorkspace(getCurrentWorkspace().key);
}

function bunnyProjectsForWorkspace(workspaceId: string) {
  return getProjectMountsForWorkspace(workspaceId).map((project) => ({
    id: project.key,
    name: project.name,
    path: project.path,
    instanceId: project.instanceId || "host-machine",
    instanceLabel: project.instanceLabel || "This Machine",
    kind: project.kind || "code",
    status: project.status || "ready",
  }));
}

function emitViewMessage(name: string, payload?: unknown, windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  post({ type: "action", action: "emit-view", payload: { name, payload, raw: true, windowId: targetWindowId } });
}

function emitSetProjectsForWindow(windowId: string) {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    return;
  }

  emitViewMessage(
    "setProjects",
    {
      projects: bunnyProjectsForWorkspace(runtimeWindow.workspaceId),
    },
    windowId,
  );
}

function emitSetProjects(workspaceId?: string) {
  const windows = workspaceId
    ? runtimeWindows.filter((window) => window.workspaceId === workspaceId)
    : runtimeWindows;
  for (const window of windows) {
    emitSetProjectsForWindow(window.id);
  }
}

function getCurrentStateDoc() {
  const doc = ensureDb()
    .collection("sessionSnapshots")
    .query({ where: (item) => item.key === "last", limit: 1 }).data?.[0];

  if (!doc) {
    throw new Error("Missing Bunny Dash current state");
  }

  return doc;
}

function getUiSettingsDoc() {
  const doc = ensureDb()
    .collection("uiSettings")
    .query({ where: (item) => item.key === "primary", limit: 1 }).data?.[0];

  if (!doc) {
    throw new Error("Missing Bunny Dash UI settings");
  }

  return doc;
}

function captureCurrentState(): CurrentState {
  return {
    updatedAt: Date.now(),
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    windows: cloneWindows(runtimeWindows),
  };
}

function getCurrentWindowUnsafe() {
  return runtimeWindows.find((window) => window.id === state.currentWindowId) || runtimeWindows[0] || null;
}

function ensureRuntimeWindowForHostWindow(windowId?: string) {
  if (!windowId) {
    return getCurrentWindowUnsafe();
  }

  const existing = runtimeWindows.find((window) => window.id === windowId);
  if (existing) {
    state.currentWindowId = windowId;
    const lensId = getLensIdForWindow(existing);
    if (lensId) {
      state.currentLayoutId = lensId;
    }
    return existing;
  }

  const fallbackWorkspaceId =
    getCurrentWorkspaceUnsafe()?.key ||
    listVisibleLocalWorkspaces()[0]?.key ||
    listWorkspaces()[0]?.key ||
    "";
  const preferredLens =
    findLensByKey(state.currentLayoutId) ||
    (fallbackWorkspaceId ? ensureWorkspaceCurrentLens(fallbackWorkspaceId) : null);

  if (!preferredLens) {
    return getCurrentWindowUnsafe();
  }

  const runtimeWindow = buildRuntimeWindowFromLens(preferredLens, windowId);
  runtimeWindows = [
    ...runtimeWindows.filter((candidate) => candidate.id !== runtimeWindow.id),
    runtimeWindow,
  ];
  state.currentWindowId = runtimeWindow.id;
  state.currentLayoutId = preferredLens.key;
  ensureRuntimeState();
  ensureBunnyWorkspaceWindow(runtimeWindow, preferredLens);
  return runtimeWindow;
}

function getCurrentWorkspaceUnsafe() {
  const currentWindow = getCurrentWindowUnsafe();
  if (!currentWindow) {
    const currentLens = findLensByKey(state.currentLayoutId);
    if (currentLens) {
      return findWorkspaceByKey(getLensWorkspaceId(currentLens)) || listWorkspaces()[0] || null;
    }
    return listWorkspaces()[0] || null;
  }

  return findWorkspaceByKey(currentWindow.workspaceId) || listWorkspaces()[0] || null;
}

function getCurrentWindow() {
  ensureRuntimeState();
  const current = getCurrentWindowUnsafe();
  if (!current) {
    throw new Error(`Unknown runtime window: ${state.currentWindowId}`);
  }
  return current;
}

function getCurrentLens() {
  const currentWindow = getCurrentWindowUnsafe();
  if (currentWindow) {
    const lensId = getLensIdForWindow(currentWindow);
    const lens = findLensByKey(lensId);
    if (lens) {
      return lens;
    }
  }
  return getLensByKey(state.currentLayoutId);
}

function getCurrentWorkspace() {
  ensureRuntimeState();
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWorkspace) {
    throw new Error("No current workspace available");
  }
  return currentWorkspace;
}

function ensureRuntimeState() {
  const layouts = listLenses();
  if (!layouts.some((layout) => layout.key === state.currentLayoutId)) {
    state.currentLayoutId = layouts[0]!.key;
  }

  if (runtimeWindows.length > 0 && !runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    state.currentWindowId = runtimeWindows[0]!.id;
  }

  const workspaceIds = new Set(listWorkspaces().map((workspace) => workspace.key));
  for (const window of runtimeWindows) {
    if (!workspaceIds.has(window.workspaceId)) {
      window.workspaceId = listWorkspaces()[0]!.key;
    }
    window.lensId = resolveWindowLensId(window);
    if (!window.mainTabIds.includes(window.currentMainTabId)) {
      window.currentMainTabId = window.mainTabIds[0]!;
    }
    if (!window.sideTabIds.includes(window.currentSideTabId)) {
      window.currentSideTabId = window.sideTabIds[0]!;
    }
    ensureBunnyWorkspaceWindow(window);
  }

  const activeWindow = getCurrentWindowUnsafe();
  const activeLensId = activeWindow ? getLensIdForWindow(activeWindow) : null;
  if (activeLensId && findLensByKey(activeLensId)) {
    state.currentLayoutId = activeLensId;
  }

  const runtimeWindowIds = new Set(runtimeWindows.map((window) => window.id));
  for (const workspace of Object.values(bunnyDashState.workspaces || {})) {
    workspace.windows = (workspace.windows || []).filter((window) =>
      runtimeWindowIds.has(window.id),
    );
  }

  if (!isKnownActiveTreeNodeId(state.activeTreeNodeId)) {
    syncActiveTreeNode();
  }
}

function isLegacyCurrentSessionWindow(window: LensWindow) {
  return (
    window.id === DEFAULT_STARTER_LENS_WINDOW.id &&
    window.title === DEFAULT_STARTER_LENS_WINDOW.title &&
    window.workspaceId === DEFAULT_STARTER_LENS_WINDOW.workspaceId &&
    sameTabIds(window.mainTabIds, LEGACY_CURRENT_SESSION_MAIN_TABS) &&
    sameTabIds(window.sideTabIds, LEGACY_CURRENT_SESSION_SIDE_TABS)
  );
}

function normalizeCurrentSessionWindows(windows: LensWindow[]) {
  let didNormalize = false;
  const nextWindows = windows.map((window) => {
    if (!isLegacyCurrentSessionWindow(window)) {
      return window;
    }

    didNormalize = true;
    return {
      ...window,
      mainTabIds: [...DEFAULT_STARTER_LENS_WINDOW.mainTabIds],
      sideTabIds: [...DEFAULT_STARTER_LENS_WINDOW.sideTabIds],
      currentMainTabId: DEFAULT_STARTER_LENS_WINDOW.currentMainTabId,
      currentSideTabId: DEFAULT_STARTER_LENS_WINDOW.currentSideTabId,
    };
  });

  return {
    didNormalize,
    windows: nextWindows,
  };
}

function migrateLegacyStarterLens() {
  const db = ensureDb();
  const snapshotDoc = getCurrentStateDoc();
  const uiDoc = getUiSettingsDoc();
  const starterLens = findLensByKey("starter-lens");
  const legacyCurrentSessionLens = findLensByKey("current-session");

  const normalizedSnapshot = normalizeCurrentSessionWindows(snapshotDoc.windows);
  if (normalizedSnapshot.didNormalize) {
    db.collection("sessionSnapshots").update(snapshotDoc.id, {
      windows: cloneWindows(normalizedSnapshot.windows),
    });
  }

  if (legacyCurrentSessionLens && !starterLens) {
    db.collection("layouts").update(legacyCurrentSessionLens.id, {
      key: "starter-lens",
      name: "Starter Lens",
      description: "Default Bunny Dash lens for local work.",
    });
  }

  const canonicalStarterLens = findLensByKey("starter-lens") || legacyCurrentSessionLens;

  if (canonicalStarterLens) {
    const normalizedLayout = normalizeCurrentSessionWindows(canonicalStarterLens.windows);
    if (normalizedLayout.didNormalize) {
      db.collection("layouts").update(canonicalStarterLens.id, {
        windows: cloneWindows(normalizedLayout.windows),
      });
    }
  }

  if (snapshotDoc.currentLayoutId === "current-session") {
    db.collection("sessionSnapshots").update(snapshotDoc.id, {
      currentLayoutId: "starter-lens",
    });
  }

  if (
    uiDoc.currentLayoutId === "current-session" ||
    uiDoc.activeTreeNodeId === "lens-overview:current-session"
  ) {
    db.collection("uiSettings").update(uiDoc.id, {
      currentLayoutId: uiDoc.currentLayoutId === "current-session" ? "starter-lens" : uiDoc.currentLayoutId,
      activeTreeNodeId: "lens-overview:starter-lens",
    });
  }

  if (normalizedSnapshot.didNormalize || legacyCurrentSessionLens || snapshotDoc.currentLayoutId === "current-session") {
    flushDb();
  }
}

function hydrateLensMetadata() {
  const db = ensureDb();
  let didUpdate = false;

  for (const workspace of listWorkspaces()) {
    ensureWorkspaceCurrentLens(workspace.key);
  }

  for (const lens of listLenses()) {
    const workspaceId = getLensWorkspaceId(lens);
    const updates: Partial<LensDoc> = {};

    if (!lens.workspaceId) {
      updates.workspaceId = workspaceId;
    }

    if (!lens.windowStateJson) {
      const fallbackWindow =
        currentBunnyWorkspace().id === workspaceId
          ? getBunnyWindowForRuntimeWindow(state.currentWindowId) || makeDefaultBunnyWindow()
          : makeDefaultBunnyWindow(lens.windows[0]?.id || "main");
      updates.windowStateJson = serializeBunnyWindow(fallbackWindow);
    }

    if (Object.keys(updates).length > 0) {
      db.collection("layouts").update(lens.id, updates);
      didUpdate = true;
    }
  }

  if (didUpdate) {
    flushDb();
  }
}

function isKnownActiveTreeNodeId(nodeId: string) {
  if (!nodeId) {
    return false;
  }
  if (
    nodeId === "workspaces-root" ||
    nodeId === "instances-root" ||
    nodeId === "current-state-overview"
  ) {
    return true;
  }
  if (
    nodeId.startsWith("projects-root:") ||
    nodeId.startsWith("fsdir:") ||
    nodeId.startsWith("fsfile:") ||
    nodeId.startsWith("fsmissing:") ||
    nodeId.startsWith("instance:") ||
    nodeId.startsWith("project-mount:") ||
    nodeId.startsWith("lens-root:")
  ) {
    return true;
  }
  if (nodeId.startsWith("workspace:")) {
    return Boolean(findWorkspaceByKey(nodeId.replace("workspace:", "")));
  }
  if (nodeId.startsWith("workspace-overview:")) {
    return Boolean(
      findWorkspaceByKey(nodeId.replace("workspace-overview:", "")),
    );
  }
  if (nodeId.startsWith("lens-overview:")) {
    return Boolean(findLensByKey(nodeId.replace("lens-overview:", "")));
  }
  if (nodeId.startsWith("lens:")) {
    return Boolean(findLensByKey(nodeId.replace("lens:", "")));
  }
  if (nodeId.startsWith("project:")) {
    return Boolean(findProjectMountByKey(nodeId.replace("project:", "")));
  }
  if (nodeId.startsWith("project-readme:")) {
    return Boolean(
      findProjectMountByKey(nodeId.replace("project-readme:", "")),
    );
  }
  if (nodeId.startsWith("window:")) {
    return runtimeWindows.some(
      (window) => window.id === nodeId.replace("window:", ""),
    );
  }
  return false;
}

function syncActiveTreeNode() {
  const currentWindow = getCurrentWindowUnsafe();
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWindow || !currentWorkspace) {
    return;
  }
  const projects = getProjectMountsForWorkspace(currentWorkspace.key);

  if (projects.length > 0) {
    state.activeTreeNodeId = `project:${projects[0]!.key}`;
  } else if (currentWindow.currentMainTabId === "lens") {
    state.activeTreeNodeId = `lens-overview:${state.currentLayoutId}`;
  } else {
    state.activeTreeNodeId = `lens-overview:${getCurrentLens().key}`;
  }
}

function makeFileNameSafe(input: string) {
  return input
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+$/, "untitled")
    .replace(/^$/, "untitled");
}

function getUniqueNewName(parentPath: string, baseName: string) {
  const safeBase = makeFileNameSafe(baseName);
  let candidate = safeBase;
  let index = 2;
  while (existsSync(join(parentPath, candidate))) {
    candidate = `${safeBase} ${index}`;
    index += 1;
  }
  return candidate;
}

async function writePersistedDashState() {
  const persisted = {
    state: {
      sidebarCollapsed: state.sidebarCollapsed,
      bunnyPopoverOpen: false,
      currentLensId: state.currentLayoutId,
      currentLayoutId: state.currentLayoutId,
      currentWindowId: state.currentWindowId,
      activeTreeNodeId: state.activeTreeNodeId,
    },
    lens: {
      id: state.currentLayoutId,
      name: getCurrentLens().name,
    },
    currentState,
    sessionSnapshot: currentState,
    db: {
      engine: "goldfishdb",
      folder: dirname(statePath) + "/goldfishdb",
    },
    bunnyDash: bunnyDashState,
  };

  await Bun.write(statePath, JSON.stringify(persisted, null, 2));
}

async function saveState() {
  const db = ensureDb();
  const uiDoc = getUiSettingsDoc();
  const snapshotDoc = getCurrentStateDoc();
  const currentWindow = getCurrentWindowUnsafe();

  db.collection("uiSettings").update(uiDoc.id, {
    sidebarCollapsed: state.sidebarCollapsed,
    bunnyPopoverOpen: false,
    currentLayoutId: state.currentLayoutId,
    currentWindowId: state.currentWindowId,
    activeTreeNodeId: state.activeTreeNodeId,
  });

  currentState = captureCurrentState();
  log(
    `saveState windows=${currentState.windows.length} currentWindow=${currentState.currentWindowId} currentLayout=${currentState.currentLayoutId} ids=${currentState.windows.map((window) => window.id).join(",")}`,
  );
  db.collection("sessionSnapshots").update(snapshotDoc.id, {
    updatedAt: currentState.updatedAt,
    currentLayoutId: currentState.currentLayoutId,
    currentWindowId: currentState.currentWindowId,
    windows: cloneWindows(currentState.windows),
  });

  if (currentWindow) {
    await syncRuntimeWindowFrameFromHost(currentWindow.id);
    const currentBunnyWindow = getCurrentBunnyWindow();
    const currentWorkspaceLens = ensureWorkspaceCurrentLens(currentWindow.workspaceId);
    db.collection("layouts").update(currentWorkspaceLens.id, {
      workspaceId: currentWindow.workspaceId,
      windowStateJson: serializeBunnyWindow(currentBunnyWindow),
      windows: [toLensTemplateWindow(currentWindow)],
    });
  }

  flushDb();
  await writePersistedDashState();
}

async function handleHostWindowClosed(closedWindowId: string) {
  const closedRuntimeWindow = runtimeWindows.find((window) => window.id === closedWindowId);
  hostWindowIds.delete(closedWindowId);
  removeBunnyWindowFromAllWorkspaces(closedWindowId);
  runtimeWindows = runtimeWindows.filter((window) => window.id !== closedWindowId);
  const pendingPersist = framePersistTimers.get(closedWindowId);
  if (pendingPersist) {
    clearTimeout(pendingPersist);
    framePersistTimers.delete(closedWindowId);
  }
  if (state.currentWindowId === closedWindowId) {
    state.currentWindowId = runtimeWindows[0]?.id || "";
  }
  if (runtimeWindows.length > 0) {
    const currentWindow = getCurrentWindowUnsafe();
    if (currentWindow) {
      state.currentLayoutId = getLensIdForWindow(currentWindow);
    }
  }
  syncActiveTreeNode();
  await saveState();
  emitSetProjects();
}

async function loadState() {
  const dbFolder = `${dirname(statePath)}/goldfishdb`;
  dashDb = createDashDb(dbFolder);
  seedDashDb(dashDb);
  migrateLegacyExampleData(dashDb);
  migrateLegacyStarterLens();
  flushDb();

  const uiDoc = getUiSettingsDoc();
  const snapshotDoc = getCurrentStateDoc();

  state = {
    sidebarCollapsed: uiDoc.sidebarCollapsed,
    commandPaletteOpen: false,
    bunnyPopoverOpen: false,
    commandQuery: "",
    currentLayoutId: uiDoc.currentLayoutId || snapshotDoc.currentLayoutId,
    currentWindowId: uiDoc.currentWindowId || snapshotDoc.currentWindowId,
    activeTreeNodeId: uiDoc.activeTreeNodeId || `lens-overview:${snapshotDoc.currentLayoutId}`,
  };

  runtimeWindows = cloneWindows(snapshotDoc.windows);
  currentState = {
    updatedAt: snapshotDoc.updatedAt,
    currentLayoutId: snapshotDoc.currentLayoutId,
    currentWindowId: snapshotDoc.currentWindowId,
    windows: cloneWindows(snapshotDoc.windows),
  };

  if (existsSync(statePath)) {
    try {
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
        bunnyDash?: PersistedBunnyDashState;
      };
      const persistedDashState = persisted.bunnyDash;
      if (persistedDashState) {
        bunnyDashState = {
          workspaces: persistedDashState.workspaces || {},
          appSettings: persistedDashState.appSettings || structuredClone(defaultBunnyAppSettings),
        };
      }
    } catch (error) {
      log(
        `failed to load persisted Bunny Dash state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const needsCloudShadowRestore =
    isCloudShadowLensKey(state.currentLayoutId) ||
    runtimeWindows.some((window) => isCloudShadowWorkspaceKey(window.workspaceId));
  if (needsCloudShadowRestore) {
    cloudApi = initCloudApi();
    if (cloudApi) {
      await refreshCloudData();
    } else {
      fallbackToVisibleLocalWorkspace();
    }
  }

  expandedFsDirs.clear();
  for (const project of listProjectMounts()) {
    if (existsSync(project.path)) {
      expandedFsDirs.add(project.path);
    }
  }

  hydrateLensMetadata();
  ensureRuntimeState();
  await writePersistedDashState();
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

function toLensTemplateWindow(window: LensWindow): LensWindow {
  return {
    ...structuredClone(window),
    id: window.id.split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main",
  };
}

function buildRuntimeWindowFromLens(lens: LensDoc, windowId?: string): LensWindow {
  const template = structuredClone(lens.windows[0] || DEFAULT_STARTER_LENS_WINDOW);
  const workspace = getWorkspaceByKey(getLensWorkspaceId(lens));
  return {
    ...template,
    id: windowId || template.id,
    lensId: lens.key,
    workspaceId: workspace.key,
    title: buildLiveWindowTitle(workspace, lens, template.title),
  };
}

function applyLensWindowStateToRuntimeWindow(lens: LensDoc, runtimeWindowId: string, workspaceId: string) {
  removeBunnyWindowFromAllWorkspaces(runtimeWindowId);
  const nextWindow = cloneBunnyWindow(parseStoredBunnyWindow(lens));
  nextWindow.id = runtimeWindowId;
  upsertBunnyWindowForWorkspace(workspaceId, nextWindow);
  return nextWindow;
}

function getCurrentBunnyWindow() {
  return ensureBunnyWorkspaceWindow(getCurrentWindow(), getCurrentLens());
}

function updateBunnyWindowFrame(
  windowId: string,
  frame: Partial<{ x: number; y: number; width: number; height: number }>,
) {
  const bunnyWindow = getBunnyWindowForRuntimeWindow(windowId);
  if (!bunnyWindow) {
    return;
  }

  bunnyWindow.position = {
    ...bunnyWindow.position,
    ...(typeof frame.x === "number" ? { x: frame.x } : {}),
    ...(typeof frame.y === "number" ? { y: frame.y } : {}),
    ...(typeof frame.width === "number" ? { width: frame.width } : {}),
    ...(typeof frame.height === "number" ? { height: frame.height } : {}),
  };
  upsertBunnyWindowForWorkspace(
    runtimeWindows.find((window) => window.id === windowId)?.workspaceId || getCurrentWorkspace().key,
    bunnyWindow,
  );
}

function syncHostDashWindowPresentation(
  windowId: string,
  title: string,
  frame: { x: number; y: number; width: number; height: number },
) {
  post({
    type: "action",
    action: "window-set-title",
    payload: { windowId, title },
  });
  post({
    type: "action",
    action: "window-set-frame",
    payload: { windowId, frame },
  });
}

function schedulePersistWindowFrame(windowId: string) {
  const existing = framePersistTimers.get(windowId);
  if (existing) {
    clearTimeout(existing);
  }

  framePersistTimers.set(
    windowId,
    setTimeout(() => {
      framePersistTimers.delete(windowId);
      if (state.currentWindowId !== windowId) {
        return;
      }
      void saveState();
    }, 120),
  );
}

function isLensDirtyInWindow(lens: LensDoc, window: LensWindow) {
  const currentBunnyWindow = getBunnyWindowForRuntimeWindow(window.id);
  if (!currentBunnyWindow) {
    return false;
  }

  const savedBunnyWindow = parseStoredBunnyWindow(lens);
  const savedTemplate = lens.windows[0] || DEFAULT_STARTER_LENS_WINDOW;
  const currentTemplate = toLensTemplateWindow(window);

  return (
    JSON.stringify(currentBunnyWindow) !== JSON.stringify(savedBunnyWindow) ||
    !sameLensWindowTemplate(currentTemplate, savedTemplate)
  );
}

async function restoreLensInCurrentWindow(lensId: string) {
  const lens = getLensByKey(lensId);
  const savedWindowState = parseStoredBunnyWindow(lens);
  log(
    `restoreLensInCurrentWindow begin: ${lens.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const currentWindow = getCurrentWindow();
  const restoredWindow = buildRuntimeWindowFromLens(lens, currentWindow.id);

  currentWindow.title = restoredWindow.title;
  currentWindow.lensId = restoredWindow.lensId;
  currentWindow.workspaceId = restoredWindow.workspaceId;
  currentWindow.mainTabIds = [...restoredWindow.mainTabIds];
  currentWindow.sideTabIds = [...restoredWindow.sideTabIds];
  currentWindow.currentMainTabId = restoredWindow.currentMainTabId;
  currentWindow.currentSideTabId = restoredWindow.currentSideTabId;

  const restoredBunnyWindow = applyLensWindowStateToRuntimeWindow(
    lens,
    currentWindow.id,
    restoredWindow.workspaceId,
  );
  syncHostDashWindowPresentation(currentWindow.id, restoredWindow.title, {
    x: restoredBunnyWindow.position.x,
    y: restoredBunnyWindow.position.y,
    width: restoredBunnyWindow.position.width,
    height: restoredBunnyWindow.position.height,
  });
  state.currentLayoutId = lens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `lens-overview:${lens.key}`;
  await saveState();
  emitSetProjectsForWindow(currentWindow.id);
  log(`lens restored: ${lens.name}`);
  return null;
}

async function syncRuntimeWindowFrameFromHost(windowId = state.currentWindowId) {
  const frame = await app.getWindowFrame(windowId);
  if (!frame) {
    return null;
  }
  updateBunnyWindowFrame(windowId, frame);
  return frame;
}
async function handleBunnyDashRequest(method: string, params: any) {
  switch (method) {
    default:
      return UNHANDLED_DASH_REQUEST;
  }
}

async function handleBunnyDashSend(name: string, payload: any) {
  switch (name) {
    default:
      return;
  }
}

self.onmessage = async (event) => {
  const message = event.data as any;

  if (message.type === "init") {
    initializeRuntimeContext(message);
    await ensureBootPromise();
    // Sync auth from ears if the init message brought an auth token
    if ((runtimeAuthToken || app.authToken) && !cloudApi) {
      syncAuthFromEars().catch(() => {});
    }
    return;
  }

  if (message.type === "event") {
    await ensureBootPromise();

    if (message.name === "boot") {
      await ensureBootPromise();
      return;
    }

    if (message.name === "window-move" || message.name === "window-resize") {
      const windowId = String(message.payload?.windowId || "");
      if (!windowId) {
        return;
      }
      hostWindowIds.add(windowId);
      updateBunnyWindowFrame(windowId, {
        x: typeof message.payload?.x === "number" ? message.payload.x : undefined,
        y: typeof message.payload?.y === "number" ? message.payload.y : undefined,
        width: typeof message.payload?.width === "number" ? message.payload.width : undefined,
        height: typeof message.payload?.height === "number" ? message.payload.height : undefined,
      });
      schedulePersistWindowFrame(windowId);
      return;
    }

    if (message.name === "window-focus") {
      const windowId = String(message.payload?.windowId || "");
      if (windowId) {
        hostWindowIds.add(windowId);
      }
      setActiveWindow(windowId);
      return;
    }

    if (message.name === "window-closed") {
      await handleHostWindowClosed(String(message.payload?.windowId || ""));
      return;
    }
    return;
  }

  if (message.type !== "request") {
    return;
  }

  try {
    await ensureBootPromise();
    setActiveWindow(typeof message.windowId === "string" ? message.windowId : undefined);

    if (typeof message.method === "string" && message.method.startsWith("send:")) {
      await handleBunnyDashSend(message.method.slice(5), message.params);
      post({ type: "response", requestId: message.requestId, success: true, payload: null });
      return;
    }

    switch (message.method) {
      case "hostWindowClosed":
        await handleHostWindowClosed(String(message.params?.windowId || ""));
        post({ type: "response", requestId: message.requestId, success: true, payload: null });
        break;
      default: {
        const payload = await handleBunnyDashRequest(
          String(message.method),
          typeof message.windowId === "string"
            ? {
                ...(message.params || {}),
                __hostWindowId: message.windowId,
              }
            : message.params,
        );
        if (payload === UNHANDLED_DASH_REQUEST) {
          post({
            type: "response",
            requestId: message.requestId,
            success: false,
            error: `Unknown method: ${message.method}`,
          });
        } else {
          post({ type: "response", requestId: message.requestId, success: true, payload });
        }
        break;
      }
    }
  } catch (error) {
    post({
      type: "response",
      requestId: message.requestId,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
