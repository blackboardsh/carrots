import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";
import {
  CloudApi,
  getApiBaseUrl,
  type CloudInstance,
  type CloudWorkspace,
} from "./cloudApi";
import {
  Carrots,
  app,
} from "electrobun/bun";
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
  tokens?: any[];
};

type BunnyCloudMachineInfo = {
  machineId: string;
  hostname: string;
  platform: string;
  instanceName: string;
};

type CachedCarrotSummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: string;
  permissions: string[];
  status: string;
  slateUIs?: Array<{
    id: string;
    name: string;
    path: string;
  }>;
  contributions?: {
    fileActivators?: Array<{
      baseName?: string;
      nodeType?: "file" | "dir" | "any";
      slate: {
        type: string;
        name?: string;
        icon?: string;
        config?: Record<string, unknown>;
      };
    }>;
  };
};

type TreeNode = {
  id: string;
  label: string;
  kind: "folder" | "file";
  children?: TreeNode[];
};

type Tab = {
  id: WindowTabId;
  title: string;
  kind: "editor" | "fleet" | "cloud" | "notes";
  icon: string;
  body: string;
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
type TypeScriptPeerDependencyStatus = {
  installed: boolean;
  version: string;
};
type BiomePeerDependencyStatus = {
  installed: boolean;
  version: string;
};

type Snapshot = {
  shellTitle: string;
  subtitle: string;
  permissions: string[];
  cloudLabel: string;
  cloudStatus: string;
  commandHint: string;
  topActions: Array<{ id: string; label: string }>;
  currentLens: {
    id: string;
    name: string;
    description: string;
  };
  currentWorkspace: {
    id: string;
    name: string;
    subtitle: string;
  };
  currentWindow: {
    id: string;
    title: string;
    currentMainTabId: string;
    currentSideTabId: string;
  };
  lenses: Array<{
    id: string;
    name: string;
    description: string;
    windowCount: number;
    isActive: boolean;
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    subtitle: string;
    projectCount: number;
    isCurrent: boolean;
  }>;
  openWindows: Array<{
    id: string;
    title: string;
    workspaceId: string;
    workspaceName: string;
    isActive: boolean;
  }>;
  currentStateSummary: {
    updatedAt: number;
    label: string;
  };
  tree: TreeNode[];
  mainTabs: Tab[];
  sideTabs: Tab[];
  stats: Array<{ label: string; value: string }>;
  state: DashState;
};

type BunnyDashWorkspaceLensPayload = {
  currentWorkspaceId: string;
  currentLensId: string;
  instances: Array<{
    id: string;
    name: string;
    os: string;
    status: string;
    isCurrent: boolean;
    carrots: Array<{ id: string; name: string; description: string; version: string; mode: string; permissions: string[]; status: string }>;
  }>;
  workspaces: Array<{
    id: string;
    name: string;
    subtitle: string;
    isCurrent: boolean;
    currentLensId: string;
    currentLensIsActive: boolean;
    canExpand: boolean;
    lenses: Array<{
      id: string;
      name: string;
      description: string;
      workspaceId: string;
      isCurrent: boolean;
      isDirty: boolean;
    }>;
  }>;
  cloudWorkspaces: Array<{
    id: string;
    name: string;
    subtitle: string;
    runtimeWorkspaceId: string;
    isCurrent: boolean;
    canExpand: boolean;
    lenses: Array<{
      id: string;
      name: string;
      description: string;
      workspaceId: string;
      runtimeLensId: string;
      isCurrent: boolean;
    }>;
    linkedInstances: Array<{
      id: string;
      name: string;
      os: string;
      status: string;
      isCurrent: boolean;
      mounts: Array<{
        id: string;
        workspaceId: string;
        workspaceName: string;
        instanceId: string;
        path: string;
        name: string;
      }>;
    }>;
  }>;
  knownLocalProjects: Array<{
    id: string;
    name: string;
    path: string;
    instanceId: string;
    instanceLabel: string;
    kind: string;
    status: string;
  }>;
};

let statePath = "";
let permissions = new Set<string>();
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
const FS_CARROT_ID = "bunny.fs";
let typeScriptPeerDependencyStatus: TypeScriptPeerDependencyStatus = {
  installed: false,
  version: "",
};
let biomePeerDependencyStatus: BiomePeerDependencyStatus = {
  installed: false,
  version: "",
};
let gitPeerDependencyStatus: { installed: boolean; version: string } = {
  installed: false,
  version: "",
};
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
  tokens: [],
};
const UNHANDLED_DASH_REQUEST = Symbol("unhandled-bunny-dash-request");

// Cloud API state
let cloudApi: CloudApi | null = null;
let cloudInstances: CloudInstance[] = [];
let cloudWorkspaces: CloudWorkspace[] = [];
let cloudCurrentInstanceId: string | null = null;
let cachedCarrotList: CachedCarrotSummary[] = [];

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
  const [instances, workspaces, currentMachine] = await Promise.all([
    cloudApi.getInstances().catch(() => []),
    cloudApi.listWorkspaces().catch(() => []),
    getCurrentMachineInfo().catch(() => null),
  ]);
  cloudInstances = instances;
  cloudWorkspaces = workspaces;
  cloudCurrentInstanceId = currentMachine?.machineId
    ? instances.find((instance) => instance.machine_id === currentMachine.machineId)?.id || null
    : null;
  syncCloudShadowState();
  log(
    `cloud: ${cloudInstances.length} instance(s), ${cloudWorkspaces.length} workspace(s)`,
  );
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

async function refreshCarrotList() {
  try {
    const list = await Carrots.list();
    cachedCarrotList = (list || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      description: c.description || "",
      version: c.version,
      mode: c.mode,
      permissions: c.permissions || [],
      status: c.status,
      slateUIs: c.slateUIs,
      contributions: c.contributions,
    }));
  } catch {}
}

function getCloudChannel() {
  return runtimeChannel || app.channel || (manifestVersion === "0.0.1" ? "dev" : undefined);
}

async function getCurrentMachineInfo(): Promise<BunnyCloudMachineInfo> {
  const info = await app.getMachineInfo().catch(() => ({
    machineId: "",
    hostname: "",
    platform: "",
  }));
  const hostnameValue = info.hostname || hostname() || "Bunny Ears";
  const platformValue = info.platform || process.platform;
  return {
    machineId: info.machineId || "",
    hostname: hostnameValue,
    platform: platformValue,
    instanceName: platformValue ? `${hostnameValue} (${platformValue})` : hostnameValue,
  };
}

function buildCloudWorkspacePayload(): BunnyDashWorkspaceLensPayload["cloudWorkspaces"] {
  const instancesById = new Map(cloudInstances.map((instance) => [instance.id, instance]));
  const activeRuntimeWindow =
    runtimeWindows.find((window) => window.id === state.currentWindowId) || getCurrentWindowUnsafe();
  const activeWorkspaceId = activeRuntimeWindow?.workspaceId || "";
  const activeLensId = activeRuntimeWindow ? getLensIdForWindow(activeRuntimeWindow) : state.currentLayoutId;

  return cloudWorkspaces
    .slice()
    .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
    .map((workspace) => {
    const runtimeWorkspaceId = cloudShadowWorkspaceKey(workspace.id);
    const mountsByInstance = new Map<string, NonNullable<CloudWorkspace["mounts"]>>();
    for (const mount of workspace.mounts || []) {
      if (!mountsByInstance.has(mount.instance_id)) {
        mountsByInstance.set(mount.instance_id, []);
      }
      mountsByInstance.get(mount.instance_id)!.push(mount);
    }

    const linkedInstances = Array.from(mountsByInstance.entries())
      .map(([instanceId, mounts]) => {
        const instance = instancesById.get(instanceId);
        return {
          id: instanceId,
          name: instance?.name || "Linked Instance",
          os: instance?.os || "",
          status: instance?.status || "unknown",
          isCurrent: instanceId === cloudCurrentInstanceId,
          mounts: mounts
            .slice()
            .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
            .map((mount) => ({
              id: mount.id,
              workspaceId: workspace.id,
              workspaceName: workspace.name,
              instanceId,
              path: mount.path,
              name: mount.name,
            })),
        };
      })
      .sort((left, right) => {
        if (left.isCurrent !== right.isCurrent) {
          return left.isCurrent ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      });

    const lenses = (workspace.lenses || [])
      .slice()
      .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
      .map((lens) => ({
        id: lens.id,
        name: lens.name,
        description: lens.description,
        workspaceId: workspace.id,
        runtimeLensId: cloudShadowLensKey(lens.id),
        isCurrent:
          runtimeWorkspaceId === activeWorkspaceId &&
          cloudShadowLensKey(lens.id) === activeLensId,
      }));

    const subtitleParts = [
      workspace.description || "",
      lenses.length > 0 ? `${lenses.length} lens${lenses.length === 1 ? "" : "es"}` : "",
      linkedInstances.length > 0
        ? `${linkedInstances.length} instance${linkedInstances.length === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean);

      return {
        id: workspace.id,
        name: workspace.name,
        subtitle: subtitleParts.join(" · "),
        runtimeWorkspaceId,
        isCurrent: runtimeWorkspaceId === activeWorkspaceId,
        canExpand: lenses.length > 0 || linkedInstances.length > 0,
        lenses,
        linkedInstances,
      };
    });
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

function ensureHostDashWindow(windowId = state.currentWindowId, title?: string) {
  const runtimeWindow = runtimeWindows.find((candidate) => candidate.id === windowId);
  if (!runtimeWindow) {
    throw new Error(`Unknown runtime window: ${windowId}`);
  }

  const nextTitle = title || runtimeWindow.title;
  if (hostWindowIds.has(windowId)) {
    post({
      type: "action",
      action: "window-set-title",
      payload: { windowId, title: nextTitle },
    });
    return;
  }

  const bunnyWindow = getBunnyWindowForRuntimeWindow(windowId);
  hostWindowIds.add(windowId);
  post({
    type: "action",
    action: "window-create",
    payload: {
      windowId,
      options: {
        hidden: false,
        title: nextTitle,
        url: "views://lens/index.html",
        titleBarStyle: "hiddenInset",
        frame: {
          x: bunnyWindow?.position.x ?? 120,
          y: bunnyWindow?.position.y ?? 120,
          width: bunnyWindow?.position.width ?? 1400,
          height: bunnyWindow?.position.height ?? 920,
        },
      },
    },
  });
}

function focusWindow(windowId?: string, title?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  ensureHostDashWindow(targetWindowId, title);
  hostWindowIds.add(targetWindowId);
  post({
    type: "action",
    action: "focus-window",
    payload: { windowId: targetWindowId, title },
  });
}

function closeWindow(windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  if (!hostWindowIds.has(targetWindowId)) {
    return;
  }
  hostWindowIds.delete(targetWindowId);
  post({
    type: "action",
    action: "close-window",
    payload: { windowId: targetWindowId },
  });
}

function sendRuntimeEventToDashWindow(windowId: string | undefined, name: string, payload?: unknown) {
  const targetWindowId = windowId || state.currentWindowId;
  post({ type: "action", action: "emit-view", payload: { name, payload, raw: true, windowId: targetWindowId } });
}

function broadcastRuntimeEventToDashWindows(name: string, payload?: unknown) {
  post({
    type: "action",
    action: "emit-view",
    payload: { raw: true, name, payload },
  });
}

function getUniqueLensNameForWorkspace(workspaceId: string, baseName = "Lens", excludeLensId?: string) {
  const existingNames = new Set(
    getLensesForWorkspace(workspaceId)
      .filter((lens) => lens.key !== excludeLensId)
      .map((lens) => lens.name.trim().toLowerCase()),
  );

  let index = 1;
  while (existingNames.has(`${baseName} ${index}`.toLowerCase())) {
    index += 1;
  }

  return `${baseName} ${index}`;
}

function getUniqueLensDisplayName(workspaceId: string, rawName: string, excludeLensId?: string) {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return getUniqueLensNameForWorkspace(workspaceId, "Lens", excludeLensId);
  }

  const existingNames = new Set(
    getLensesForWorkspace(workspaceId)
      .filter((lens) => lens.key !== excludeLensId)
      .map((lens) => lens.name.trim().toLowerCase()),
  );

  if (!existingNames.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  let index = 2;
  let candidate = `${trimmed} ${index}`;
  while (existingNames.has(candidate.toLowerCase())) {
    index += 1;
    candidate = `${trimmed} ${index}`;
  }
  return candidate;
}

function ensureDb() {
  if (!dashDb) {
    throw new Error("Bunny Dash DB has not been initialized");
  }
  return dashDb;
}

function initializeRuntimeContext(message?: {
  context?: {
    permissions?: string[];
    statePath?: string;
    authToken?: string | null;
    channel?: string;
  };
  manifest?: { version?: string };
}) {
  const context = message?.context;
  permissions = new Set(
    context?.permissions ||
      ((app.permissions as string[] | undefined) ?? []),
  );
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
      await refreshCarrotList();

      ensureRuntimeState();
      currentState = captureCurrentState();
      post({ type: "ready" });
      emitSnapshot();
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
  cloudInstances = [];
  cloudWorkspaces = [];
  cloudCurrentInstanceId = null;
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

function isIgnoredPath(path: string) {
  const parts = path.split(/[\\/]+/);
  return parts.includes("node_modules") || parts.includes(".git") || path.endsWith("/.DS_Store");
}

function scheduleRefresh() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }

  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    emitSnapshot();
  }, 80);
}

function syncProjectWatchers() {
  void invokeFsCarrot<boolean>("syncProjectWatchers", {
    projects: listProjectMounts().map((project) => ({
      watchId: project.key,
      workspaceId: project.workspaceId,
      path: project.path,
    })),
  }).catch((error) => {
    log(`bunny.fs watcher sync failed: ${error instanceof Error ? error.message : String(error)}`);
  });
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

function getDashHomeDir() {
  return dirname(statePath);
}

function getBunnyProjectsFolder() {
  const workspace = getCurrentWorkspaceUnsafe() || listWorkspaces()[0];
  const root = join(getDashHomeDir(), "projects", workspace?.key || "default");
  mkdirSync(root, { recursive: true });
  return root;
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

function bunnyKnownLocalProjects() {
  const dedupedByPath = new Map<string, ReturnType<typeof bunnyProjectsForWorkspace>[number]>();

  for (const project of listProjectMounts()) {
    if (!project.path || dedupedByPath.has(project.path)) {
      continue;
    }

    dedupedByPath.set(project.path, {
      id: project.key,
      name: project.name,
      path: project.path,
      instanceId: project.instanceId || "host-machine",
      instanceLabel: project.instanceLabel || "This Machine",
      kind: project.kind || "code",
      status: project.status || "ready",
    });
  }

  return Array.from(dedupedByPath.values()).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

function bunnyBuildVars() {
  return {
    channel: "dev",
    version: manifestVersion,
    hash: "bunny-dash",
  };
}

function bunnyPaths() {
  const bunPath = Bun.which("bun") || "";
  const gitPath = Bun.which("git") || "";
  return {
    APP_PATH: getDashHomeDir(),
    BUNNY_HOME_FOLDER: getDashHomeDir(),
    BUNNY_PROJECTS_FOLDER: getBunnyProjectsFolder(),
    BUNNY_DEPS_PATH: "",
    BUNNY_ENV_PATH: "",
    BUN_BINARY_PATH: bunPath,
    BIOME_BINARY_PATH: "",
    TSSERVER_PATH: "",
    GIT_BINARY_PATH: gitPath,
    BUN_PATH: bunPath,
    BUN_DEPS_FOLDER: "",
    TYPESCRIPT_PACKAGE_PATH: "",
    BIOME_PACKAGE_PATH: "",
  };
}

async function getWebBridgeOrigin() {
  const port = await app.getWebBridgePort().catch(() => null);
  if (!port) {
    return "";
  }
  return `http://localhost:${port}`;
}

function bunnyPeerDependencies() {
  return {
    bun: {
      installed: Boolean(Bun.which("bun")),
      version: Bun.version,
    },
    typescript: {
      installed: typeScriptPeerDependencyStatus.installed,
      version: typeScriptPeerDependencyStatus.version,
    },
    biome: {
      installed: biomePeerDependencyStatus.installed,
      version: biomePeerDependencyStatus.version,
    },
    git: {
      installed: gitPeerDependencyStatus.installed,
      version: gitPeerDependencyStatus.version,
    },
  };
}

function emitViewMessage(name: string, payload?: unknown, windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  post({ type: "action", action: "emit-view", payload: { name, payload, raw: true, windowId: targetWindowId } });
}

async function invokeFsCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(FS_CARROT_ID, method, params, options);
}

function handleFsFileWatchEvent(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          absolutePath?: string;
          workspaceId?: string | null;
          exists?: boolean;
          isDelete?: boolean;
          isAdding?: boolean;
          isFile?: boolean;
          isDir?: boolean;
        })
      : {};

  const targetWindows =
    typeof eventPayload.workspaceId === "string" && eventPayload.workspaceId
      ? runtimeWindows.filter((window) => window.workspaceId === eventPayload.workspaceId)
      : runtimeWindows;

  for (const window of targetWindows) {
    emitViewMessage(
      "fileWatchEvent",
      {
        absolutePath: String(eventPayload.absolutePath || ""),
        exists: Boolean(eventPayload.exists),
        isDelete: Boolean(eventPayload.isDelete),
        isAdding: Boolean(eventPayload.isAdding),
        isFile: Boolean(eventPayload.isFile),
        isDir: Boolean(eventPayload.isDir),
      },
      window.id,
    );
  }

  scheduleRefresh();
}

function emitSetProjectsForWindow(windowId: string) {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    return;
  }

  const workspace = getOrCreateBunnyWorkspace(runtimeWindow.workspaceId);
  ensureBunnyWorkspaceWindow(runtimeWindow);
  emitViewMessage(
    "setProjects",
    {
      projects: bunnyProjectsForWorkspace(workspace.id),
      tokens: bunnyDashState.tokens || [],
      workspace,
      appSettings: bunnyDashState.appSettings || defaultBunnyAppSettings,
      bunnyDash: buildWorkspaceLensPayload(windowId),
    },
    windowId,
  );
}

function buildWorkspaceLensPayload(windowId = state.currentWindowId): BunnyDashWorkspaceLensPayload {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId) || getCurrentWindowUnsafe();
  const currentWorkspaceId = runtimeWindow?.workspaceId || getCurrentWorkspace().key;
  const currentLensId = runtimeWindow ? getLensIdForWindow(runtimeWindow) : state.currentLayoutId;

  return {
    currentWorkspaceId,
    currentLensId,
    instances: [
      // Current instance always first
      {
        id: "host-machine",
        name: hostname() || "This Machine",
        os: process.platform === "darwin" ? "macos" : process.platform,
        status: "online" as const,
        isCurrent: true,
        carrots: cachedCarrotList,
      },
      // Other registered instances
      ...cloudInstances.map((inst) => ({
        id: inst.id,
        name: inst.name,
        os: inst.os,
        status: inst.status,
        isCurrent: false,
        carrots: [] as typeof cachedCarrotList,
      })),
    ],
    workspaces: listVisibleLocalWorkspaces().map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      subtitle: workspace.subtitle,
      isCurrent: workspace.key === currentWorkspaceId,
      currentLensId: ensureWorkspaceCurrentLens(workspace.key).key,
      currentLensIsActive:
        workspace.key === currentWorkspaceId &&
        ensureWorkspaceCurrentLens(workspace.key).key === currentLensId,
      canExpand: getLensesForWorkspace(workspace.key).length > 0,
      lenses: getLensesForWorkspace(workspace.key).map((lens) => ({
        id: lens.key,
        name: lens.name,
        description: lens.description,
        workspaceId: workspace.key,
        isCurrent: workspace.key === currentWorkspaceId && lens.key === currentLensId,
        isDirty:
          workspace.key === currentWorkspaceId &&
          lens.key === currentLensId &&
          runtimeWindow != null
            ? isLensDirtyInWindow(lens, runtimeWindow)
            : false,
      })),
    })),
    cloudWorkspaces: buildCloudWorkspacePayload(),
    knownLocalProjects: bunnyKnownLocalProjects(),
  };
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

  if (!isTreeNodeIdValid(state.activeTreeNodeId)) {
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

function buildStats() {
  const workspaces = listWorkspaces();
  const projects = listProjectMounts();
  const lenses = listLenses().filter((lens) => !isWorkspaceCurrentLensKey(lens.key));
  const instanceCount = new Set(projects.map((project) => project.instanceLabel)).size;

  return [
    { label: "Workspaces", value: String(workspaces.length) },
    { label: "Projects", value: String(projects.length) },
    { label: "Lenses", value: String(lenses.length) },
    { label: "Instances", value: String(instanceCount) },
  ];
}

function getSelectedFilePath() {
  if (!state.activeTreeNodeId.startsWith("fsfile:")) {
    return null;
  }
  return state.activeTreeNodeId.replace("fsfile:", "");
}

function getSelectedDirectoryPath() {
  if (!state.activeTreeNodeId.startsWith("fsdir:")) {
    return null;
  }
  return state.activeTreeNodeId.replace("fsdir:", "");
}

function formatFilePreview(path: string) {
  try {
    if (!existsSync(path)) {
      return `Missing file: ${path}`;
    }

    const stat = statSync(path);
    if (!stat.isFile()) {
      return `Not a file: ${path}`;
    }

    const maxBytes = 32 * 1024;
    const contents = readFileSync(path, "utf8");
    const snippet = contents.slice(0, maxBytes);
    const truncated = contents.length > maxBytes ? "\n\n…truncated…" : "";
    return `${path}\n\n${snippet}${truncated}`;
  } catch (error) {
    return `Unable to read file: ${path}\n\n${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function formatDirectoryPreview(path: string) {
  try {
    if (!existsSync(path)) {
      return `Missing directory: ${path}`;
    }

    const entries = readdirSync(path, { withFileTypes: true })
      .filter((entry) => !isIgnoredPath(join(path, entry.name)))
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) return -1;
        if (!left.isDirectory() && right.isDirectory()) return 1;
        return left.name.localeCompare(right.name);
      });

    if (entries.length === 0) {
      return `${path}\n\nDirectory is empty.`;
    }

    return `${path}\n\n${entries
      .slice(0, 120)
      .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
      .join("\n")}`;
  } catch (error) {
    return `Unable to read directory: ${path}\n\n${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function buildProjectFileNodes(rootPath: string): TreeNode[] {
  if (!existsSync(rootPath)) {
    return [
      {
        id: `fsmissing:${rootPath}`,
        label: "Path missing",
        kind: "file",
      },
    ];
  }
  try {
    let entries = readdirSync(rootPath, { withFileTypes: true }).filter(
      (entry) => !isIgnoredPath(join(rootPath, entry.name)),
    );
    entries = entries.sort((left, right) => {
      if (left.isDirectory() && !right.isDirectory()) return -1;
      if (!left.isDirectory() && right.isDirectory()) return 1;
      return left.name.localeCompare(right.name);
    });

    return entries.slice(0, 200).map((entry) => {
      const fullPath = join(rootPath, entry.name);
      if (entry.isDirectory()) {
        const isExpanded = expandedFsDirs.has(fullPath);
        return {
          id: `fsdir:${fullPath}`,
          label: entry.name,
          kind: "folder" as const,
          children: isExpanded ? buildProjectFileNodes(fullPath) : [],
        };
      }

      return {
        id: `fsfile:${fullPath}`,
        label: entry.name,
        kind: "file" as const,
      };
    });
  } catch (error) {
    return [
      {
        id: `fsmissing:${rootPath}`,
        label: `Unreadable: ${basename(rootPath)}`,
        kind: "file",
      },
    ];
  }
}

function buildTree(workspace: WorkspaceDoc): TreeNode[] {
  const workspaceProjects = getProjectMountsForWorkspace(workspace.key);
  const workspaces = listWorkspaces();

  return [
    {
      id: "workspaces-root",
      label: "Workspaces",
      kind: "folder",
      children: workspaces.map((candidate) => ({
        id: `workspace:${candidate.key}`,
        label: candidate.name,
        kind: "folder" as const,
        children: getLensesForWorkspace(candidate.key).map((lens) => ({
          id: `lens-overview:${lens.key}`,
          label: lens.name,
          kind: "file" as const,
        })),
      })),
    },
    {
      id: `projects-root:${workspace.key}`,
      label: "Projects",
      kind: "folder",
      children: workspaceProjects.map((project) => ({
          id: `project:${project.key}`,
          label: project.name,
          kind: "folder" as const,
          children: [
            {
              id: `project-readme:${project.key}`,
              label: "Overview",
              kind: "file" as const,
            },
            ...buildProjectFileNodes(project.path),
          ],
        })),
    },
    {
      id: "current-state-overview",
      label: "Current State",
      kind: "folder",
      children: runtimeWindows.map((window) => ({
        id: `window:${window.id}`,
        label: window.title,
        kind: "file",
      })),
    },
    {
      id: "instances-root",
      label: "Instances",
      kind: "folder",
      children: Array.from(
        new Set(listProjectMounts().map((project) => `${project.instanceId}|${project.instanceLabel}`)),
      ).map((value) => {
        const [instanceId, instanceLabel] = value.split("|");
        return {
          id: `instance:${instanceId}`,
          label: instanceLabel,
          kind: "file" as const,
        };
      }),
    },
  ];
}

function formatProjectsForBody(workspaceId: string) {
  const projects = getProjectMountsForWorkspace(workspaceId);
  if (projects.length === 0) {
    return "No project folders mounted yet. Use Add Project Folder to attach one to this workspace.";
  }

  return projects
    .map(
      (project) =>
        `${project.name}\n  path: ${project.path}\n  instance: ${project.instanceLabel}\n  kind: ${project.kind}\n  status: ${project.status}`,
    )
    .join("\n\n");
}

function formatProjectExplorerBody(workspaceId: string) {
  const selectedFilePath = getSelectedFilePath();
  if (selectedFilePath) {
    return formatFilePreview(selectedFilePath);
  }

  const selectedDirectoryPath = getSelectedDirectoryPath();
  if (selectedDirectoryPath) {
    return formatDirectoryPreview(selectedDirectoryPath);
  }

  const activeProjectKey = state.activeTreeNodeId.startsWith("project:")
    ? state.activeTreeNodeId.replace("project:", "")
    : state.activeTreeNodeId.startsWith("project-readme:")
      ? state.activeTreeNodeId.replace("project-readme:", "")
      : null;
  const activeProject = activeProjectKey ? findProjectMountByKey(activeProjectKey) : null;
  if (activeProject) {
    return `${activeProject.name}\n\npath: ${activeProject.path}\ninstance: ${activeProject.instanceLabel}\nkind: ${activeProject.kind}\nstatus: ${activeProject.status}`;
  }

  return formatProjectsForBody(workspaceId);
}

function buildTab(
  tabId: WindowTabId,
  currentWorkspace: WorkspaceDoc,
  currentLens: LensDoc,
  currentWindow: LensWindow,
): Tab {
  switch (tabId) {
    case "workspace":
      return {
        id: tabId,
        title: "Workspace",
        kind: "editor",
        icon: "▤",
        body: `${currentWorkspace.name}\n\n${currentWorkspace.subtitle}\n\nProjects\n${formatProjectsForBody(currentWorkspace.key)}`,
      };
    case "projects":
      return {
        id: tabId,
        title: "Projects",
        kind: "editor",
        icon: "◫",
        body: formatProjectExplorerBody(currentWorkspace.key),
      };
    case "lens":
      return {
        id: tabId,
        title: "Lens",
        kind: "fleet",
        icon: "▥",
        body: `${currentLens.name}\n\n${currentLens.description}\n\nWindows\n${runtimeWindows
          .map((window) => `- ${window.title} (${getWorkspaceByKey(window.workspaceId).name})`)
          .join("\n")}`,
      };
    case "instances":
      return {
        id: tabId,
        title: "Instances",
        kind: "fleet",
        icon: "⌘",
        body: Array.from(
          new Set(
            listProjectMounts().map(
              (project) => `${project.instanceLabel}\n  path: ${project.path}\n  workspace: ${getWorkspaceByKey(project.workspaceId).name}`,
            ),
          ),
        ).join("\n\n"),
      };
    case "cloud":
      return {
        id: tabId,
        title: "Bunny Cloud",
        kind: "cloud",
        icon: "☁",
        body:
          "Bunny Cloud will evolve from today’s local-first flow. This pane becomes the bridge for account auth, fleet orchestration, remote surfaces, and browser-hosted Bunny Dash.",
      };
    case "browser":
      return {
        id: tabId,
        title: "Web Browser",
        kind: "fleet",
        icon: "◎",
        body:
          "Browser surfaces will run as carrots inside Bunny Ears and attach into Bunny Dash locally or remotely. This is the Bunny Dash replacement path for web slates.",
      };
    case "terminal":
      return {
        id: tabId,
        title: "Terminal",
        kind: "notes",
        icon: "›_",
        body:
          "Terminal sessions will move into a dedicated PTY carrot so Bunny Dash can attach locally or remotely without SSH. This is the future pty path.",
      };
    case "agent":
      return {
        id: tabId,
        title: "AI Chat",
        kind: "notes",
        icon: "✦",
        body:
          "Agent workflows will move into carrots that expose local and remote tool surfaces. This tab is the placeholder for the Bunny Dash agent shell.",
      };
    case "windows":
      return {
        id: tabId,
        title: "Windows",
        kind: "notes",
        icon: "▦",
        body: runtimeWindows
          .map(
            (window) =>
              `${window.title}\n  workspace: ${getWorkspaceByKey(window.workspaceId).name}\n  main: ${window.currentMainTabId}\n  side: ${window.currentSideTabId}`,
          )
          .join("\n\n"),
      };
    case "notes":
      return {
        id: tabId,
        title: "Notes",
        kind: "notes",
        icon: "✎",
        body:
          "Bunny Dash now persists workspaces, project mounts, lenses, and current state in GoldfishDB. The current UI uses that local store as the source of truth rather than the old in-memory seed data.",
      };
    case "current-state":
    default:
      return {
        id: tabId,
        title: "Current State",
        kind: "notes",
        icon: "◌",
        body: `Current window: ${currentWindow.title}\nLens: ${currentLens.name}\nWorkspace: ${currentWorkspace.name}\n\nLast updated: ${new Date(currentState.updatedAt).toLocaleString()}\nLocal store: GoldfishDB`,
      };
  }
}

function formatCurrentStateLabel(updatedAt: number) {
  return `Updated ${new Date(updatedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
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

function snapshot(): Snapshot {
  ensureRuntimeState();

  const workspaces = listWorkspaces();
  const lenses = listLenses();
  const currentLens = getCurrentLens();
  const currentWindow =
    getCurrentWindowUnsafe() || buildRuntimeWindowFromLens(currentLens, state.currentWindowId || "main");
  const currentWorkspace = getCurrentWorkspace();
  const tree = buildTree(currentWorkspace);
  const mainTabs = currentWindow.mainTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLens, currentWindow),
  );
  const sideTabs = currentWindow.sideTabIds.map((tabId) =>
    buildTab(tabId, currentWorkspace, currentLens, currentWindow),
  );

  return {
    shellTitle: "Bunny Dash",
    subtitle: "Local shell for Bunny Ears fleets, lenses, and project work.",
    permissions: [...permissions],
    cloudLabel: "Bunny Cloud",
    cloudStatus: "Bunny Cloud is the working foundation for the future remote service layer.",
    commandHint: process.platform === "darwin" ? "cmd+p" : "ctrl+p",
    topActions: [
      { id: "command-palette", label: "Command Palette" },
      { id: "resume-last-state", label: "Resume Current State" },
      { id: "pop-out-bunny", label: "Pop Out Bunny" },
      { id: "bunny-cloud", label: "Bunny Cloud" },
    ],
    currentLens: {
      id: currentLens.key,
      name: currentLens.name,
      description: currentLens.description,
    },
    currentWorkspace: {
      id: currentWorkspace.key,
      name: currentWorkspace.name,
      subtitle: currentWorkspace.subtitle,
    },
    currentWindow: {
      id: currentWindow.id,
      title: currentWindow.title,
      currentMainTabId: currentWindow.currentMainTabId,
      currentSideTabId: currentWindow.currentSideTabId,
    },
    lenses: lenses.map((lens) => ({
      id: lens.key,
      name: lens.name,
      description: lens.description,
      windowCount: lens.windows.length,
      isActive: lens.key === state.currentLayoutId,
    })),
    workspaces: workspaces.map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      subtitle: workspace.subtitle,
      projectCount: getProjectMountsForWorkspace(workspace.key).length,
      isCurrent: workspace.key === currentWorkspace.key,
    })),
    openWindows: runtimeWindows.map((window) => ({
      id: window.id,
      title: window.title,
      workspaceId: window.workspaceId,
      workspaceName: getWorkspaceByKey(window.workspaceId).name,
      isActive: window.id === state.currentWindowId,
    })),
    currentStateSummary: {
      updatedAt: currentState.updatedAt,
      label: formatCurrentStateLabel(currentState.updatedAt),
    },
    tree,
    mainTabs,
    sideTabs,
    stats: buildStats(),
    state: { ...state },
  };
}

function emitSnapshot() {
  const data = snapshot();
  post({ type: "action", action: "emit-view", payload: { name: "snapshot", payload: data, raw: true } });
}

function isTreeNodeIdValid(nodeId: string) {
  const currentWorkspace = getCurrentWorkspaceUnsafe();
  if (!currentWorkspace) {
    return false;
  }
  const tree = buildTree(currentWorkspace);
  return flattenTree(tree).some((node) => node.id === nodeId);
}

function flattenTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...(node.children ? flattenTree(node.children) : [])]);
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
  emitSnapshot();
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
          tokens: persistedDashState.tokens || [],
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
  syncProjectWatchers();
  await writePersistedDashState();
}

function setCommandQuery(query: string) {
  state.commandQuery = query;
}

function setMainTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (currentWindow.mainTabIds.includes(tabId)) {
    currentWindow.currentMainTabId = tabId;
  }
}

function setSideTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (currentWindow.sideTabIds.includes(tabId)) {
    currentWindow.currentSideTabId = tabId;
  }
}

function ensureMainTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (!currentWindow.mainTabIds.includes(tabId)) {
    currentWindow.mainTabIds.push(tabId);
  }
  currentWindow.currentMainTabId = tabId;
}

function ensureSideTab(tabId: WindowTabId) {
  const currentWindow = getCurrentWindow();
  if (!currentWindow.sideTabIds.includes(tabId)) {
    currentWindow.sideTabIds.push(tabId);
  }
  currentWindow.currentSideTabId = tabId;
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
  emitSnapshot();
  log(`lens restored: ${lens.name}`);
  return snapshot();
}

async function openLensInNewWindow(lensId: string) {
  const lens = getLensByKey(lensId);
  if (!isCloudShadowLensKey(lens.key)) {
    throw new Error("Local lens window opening is handled in the Dash frontend");
  }
  const savedWindowState = parseStoredBunnyWindow(lens);
  log(
    `openLensInNewWindow begin: ${lens.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const liveWindowId = makeLiveWindowId(lens.key, lens.windows[0]?.id || "main");
  const runtimeWindow = buildRuntimeWindowFromLens(lens, liveWindowId);

  runtimeWindows.push(runtimeWindow);
  applyLensWindowStateToRuntimeWindow(lens, liveWindowId, runtimeWindow.workspaceId);

  state.currentWindowId = liveWindowId;
  state.currentLayoutId = lens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `lens-overview:${lens.key}`;
  await saveState();
  emitSnapshot();
  emitSetProjectsForWindow(liveWindowId);
  focusWindow(liveWindowId, runtimeWindow.title);
  log(`lens opened in new window: ${lens.name}`);
  return snapshot();
}

async function openLens(lensId: string) {
  const lens = getLensByKey(lensId);
  if (!isCloudShadowLensKey(lens.key)) {
    throw new Error("Local lens switching is handled in the Dash frontend");
  }
  log(`openLens request: ${lensId}`);
  return restoreLensInCurrentWindow(lensId);
}

async function overwriteCurrentLens() {
  const lens = getCurrentLens();
  const currentWindow = getCurrentWindow();
  await syncRuntimeWindowFrameFromHost(currentWindow.id);
  const currentBunnyWindow = getCurrentBunnyWindow();
  log(
    `overwriteCurrentLens begin: ${lens.key} rootPane=${currentBunnyWindow.rootPane.type} currentPane=${currentBunnyWindow.currentPaneId}`,
  );
  if (isCloudShadowLensKey(lens.key)) {
    if (!cloudApi) {
      throw new Error("Not signed in to Bunny Cloud");
    }
    const cloudWorkspaceId = cloudWorkspaceIdFromShadowKey(getLensWorkspaceId(lens));
    const cloudLensId = cloudLensIdFromShadowKey(lens.key);
    await cloudApi.updateLens(cloudWorkspaceId, cloudLensId, {
      name: lens.name,
      description: lens.description,
      layout_json: serializeCloudLensLayout(currentBunnyWindow, currentWindow),
    });
    await refreshCloudData();
    await saveState();
    emitSetProjectsForWindow(currentWindow.id);
    broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
    emitSnapshot();
    log(`cloud lens overwritten: ${lens.name}`);
    return;
  }
  throw new Error("Local lens overwrite is handled in the Dash frontend");
}

async function createLens(
  workspaceId: string,
  name: string,
  description = "",
  sourceLensId?: string,
) {
  const workspace = getWorkspaceByKey(workspaceId);
  const lenses = listLenses();
  const cleanName = getUniqueLensDisplayName(workspace.key, name);
  const currentWindow = getCurrentWindow();
  const sourceLens = sourceLensId ? getLensByKey(sourceLensId) : null;
  const useCurrentWindowState =
    !sourceLens && currentWindow.workspaceId === workspace.key;

  let sourceBunnyWindow: BunnyWindow;
  let sourceRuntimeWindow: LensWindow;

  if (sourceLens) {
    const isCurrentLens = sourceLens.key === getLensIdForWindow(currentWindow);
    const sourceWindow = isCurrentLens ? currentWindow : null;
    if (isCurrentLens && sourceWindow) {
      await syncRuntimeWindowFrameFromHost(sourceWindow.id);
    }
    sourceBunnyWindow = isCurrentLens
      ? getCurrentBunnyWindow()
      : parseStoredBunnyWindow(sourceLens);
    sourceRuntimeWindow = sourceWindow
      ? sourceWindow
      : buildRuntimeWindowFromLens(
          sourceLens,
          sourceLens.windows[0]?.id || "main",
        );
  } else if (useCurrentWindowState) {
    await syncRuntimeWindowFrameFromHost(currentWindow.id);
    sourceBunnyWindow = getCurrentBunnyWindow();
    sourceRuntimeWindow = currentWindow;
  } else {
    const workspaceCurrentLens = ensureWorkspaceCurrentLens(workspace.key);
    sourceBunnyWindow = parseStoredBunnyWindow(workspaceCurrentLens);
    sourceRuntimeWindow = buildRuntimeWindowFromLens(
      workspaceCurrentLens,
      workspaceCurrentLens.windows[0]?.id || "main",
    );
  }

  if (isCloudShadowWorkspaceKey(workspace.key)) {
    if (!cloudApi) {
      throw new Error("Not signed in to Bunny Cloud");
    }
    const createdCloudLens = await cloudApi.createLens(
      cloudWorkspaceIdFromShadowKey(workspace.key),
      cleanName,
      serializeCloudLensLayout(sourceBunnyWindow, sourceRuntimeWindow),
      description.trim() || (sourceLens ? `Forked from ${sourceLens.name}` : `Saved from ${workspace.name}`),
    );
    await refreshCloudData();
    if (useCurrentWindowState) {
      await openLens(cloudShadowLensKey(createdCloudLens.id));
    } else {
      emitSetProjects();
      broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
      emitSnapshot();
    }
    log(sourceLens ? `cloud lens forked: ${createdCloudLens.name}` : `cloud lens created: ${createdCloudLens.name}`);
    return snapshot();
  }
  throw new Error("Local lens creation is handled in the Dash frontend");
}

async function renameLens(lensId: string, name: string, description = "") {
  const lens = getLensByKey(lensId);
  if (isWorkspaceCurrentLensKey(lens.key)) {
    throw new Error("Cannot rename the workspace current lens");
  }

  const workspace = getWorkspaceByKey(getLensWorkspaceId(lens));
  const cleanName = getUniqueLensDisplayName(workspace.key, name, lens.key);
  if (isCloudShadowLensKey(lens.key)) {
    if (!cloudApi) {
      throw new Error("Not signed in to Bunny Cloud");
    }
    await cloudApi.updateLens(
      cloudWorkspaceIdFromShadowKey(workspace.key),
      cloudLensIdFromShadowKey(lens.key),
      {
        name: cleanName,
        description: description.trim(),
      },
    );
    await refreshCloudData();
    await saveState();
    emitSetProjects();
    broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
    emitSnapshot();
    log(`cloud lens renamed: ${cleanName}`);
    return snapshot();
  }
  throw new Error("Local lens rename is handled in the Dash frontend");
}

async function openWorkspaceInNewWindow(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
  if (!isCloudShadowWorkspaceKey(workspace.key)) {
    throw new Error("Local workspace window opening is handled in the Dash frontend");
  }
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  const savedWindowState = parseStoredBunnyWindow(currentLens);
  log(
    `openWorkspaceInNewWindow begin: ${workspace.key} rootPane=${savedWindowState.rootPane.type} currentPane=${savedWindowState.currentPaneId}`,
  );
  const liveWindowId = makeLiveWindowId(currentLens.key, currentLens.windows[0]?.id || "main");
  const runtimeWindow = buildRuntimeWindowFromLens(currentLens, liveWindowId);

  runtimeWindows.push(runtimeWindow);
  applyLensWindowStateToRuntimeWindow(currentLens, liveWindowId, runtimeWindow.workspaceId);

  state.currentWindowId = liveWindowId;
  state.currentLayoutId = currentLens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `workspace-overview:${workspace.key}`;
  await saveState();
  emitSnapshot();
  emitSetProjectsForWindow(liveWindowId);
  focusWindow(liveWindowId, runtimeWindow.title);
  log(`workspace opened in new window: ${workspace.name}`);
  return snapshot();
}

async function syncRuntimeWindowFrameFromHost(windowId = state.currentWindowId) {
  const frame = await app.getWindowFrame(windowId);
  if (!frame) {
    return null;
  }
  updateBunnyWindowFrame(windowId, frame);
  return frame;
}

async function deleteLens(lensId: string) {
  const lens = getLensByKey(lensId);
  if (!isCloudShadowLensKey(lens.key)) {
    throw new Error("Local lens deletion is handled in the Dash frontend");
  }
  if (isWorkspaceCurrentLensKey(lens.key)) {
    throw new Error("Cannot delete a workspace current lens");
  }

  const workspaceId = getLensWorkspaceId(lens);
  const replacementLens = ensureWorkspaceCurrentLens(workspaceId);
  const affectedWindows = runtimeWindows.filter((window) => getLensIdForWindow(window) === lens.key);

  for (const runtimeWindow of affectedWindows) {
    const restoredWindow = buildRuntimeWindowFromLens(replacementLens, runtimeWindow.id);
    runtimeWindow.title = restoredWindow.title;
    runtimeWindow.lensId = restoredWindow.lensId;
    runtimeWindow.workspaceId = restoredWindow.workspaceId;
    runtimeWindow.mainTabIds = [...restoredWindow.mainTabIds];
    runtimeWindow.sideTabIds = [...restoredWindow.sideTabIds];
    runtimeWindow.currentMainTabId = restoredWindow.currentMainTabId;
    runtimeWindow.currentSideTabId = restoredWindow.currentSideTabId;

    const restoredBunnyWindow = applyLensWindowStateToRuntimeWindow(
      replacementLens,
      runtimeWindow.id,
      restoredWindow.workspaceId,
    );
    syncHostDashWindowPresentation(runtimeWindow.id, restoredWindow.title, {
      x: restoredBunnyWindow.position.x,
      y: restoredBunnyWindow.position.y,
      width: restoredBunnyWindow.position.width,
      height: restoredBunnyWindow.position.height,
    });
  }

  ensureDb().collection("layouts").remove(lens.id);
  if (state.currentLayoutId === lens.key) {
    state.currentLayoutId = replacementLens.key;
  }
  if (state.activeTreeNodeId === `lens-overview:${lens.key}`) {
    state.activeTreeNodeId = `workspace-overview:${workspaceId}`;
  }
  flushDb();
  await saveState();
  emitSetProjects();
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(`lens deleted: ${lens.name}`);
  return snapshot();
}

async function openWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
  if (!isCloudShadowWorkspaceKey(workspace.key)) {
    throw new Error("Local workspace switching is handled in the Dash frontend");
  }
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  log(`openWorkspace request: ${workspace.key}`);
  await restoreLensInCurrentWindow(currentLens.key);
  state.activeTreeNodeId = `workspace-overview:${workspace.key}`;
  await saveState();
  emitSetProjectsForWindow(getCurrentWindow().id);
  emitSnapshot();
  return snapshot();
}

async function openQuickAccess(tabId: "browser" | "terminal" | "agent") {
  ensureMainTab(tabId);
  syncActiveTreeNode();
  await saveState();
  emitSnapshot();
  log(`quick access opened: ${tabId}`);
  return snapshot();
}

async function selectWindow(windowId: string) {
  if (!runtimeWindows.some((window) => window.id === windowId)) {
    return;
  }
  setActiveWindow(windowId);
  syncActiveTreeNode();
  await saveState();
  emitSnapshot();
}

async function selectNode(nodeId: string) {
  state.activeTreeNodeId = nodeId;

  if (nodeId.startsWith("lens-overview:")) {
    const lensId = nodeId.replace("lens-overview:", "");
    if (isCloudShadowLensKey(lensId)) {
      await restoreLensInCurrentWindow(lensId);
    }
    return;
  } else if (nodeId.startsWith("lens:")) {
    const lensId = nodeId.replace("lens:", "");
    if (isCloudShadowLensKey(lensId)) {
      await restoreLensInCurrentWindow(lensId);
    }
    return;
  } else if (nodeId.startsWith("workspace-overview:")) {
    const workspaceId = nodeId.replace("workspace-overview:", "");
    if (
      isCloudShadowWorkspaceKey(workspaceId) &&
      workspaceId !== getCurrentWorkspace().key
    ) {
      await openWorkspace(workspaceId);
      return;
    }
    ensureMainTab("workspace");
  } else if (nodeId === "current-state-overview") {
    ensureSideTab("current-state");
  } else if (nodeId.startsWith("window:")) {
    await selectWindow(nodeId.replace("window:", ""));
    ensureSideTab("windows");
    return;
  } else if (nodeId.startsWith("project:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("project-readme:")) {
    ensureMainTab("workspace");
  } else if (nodeId.startsWith("project-mount:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("fsdir:")) {
    const path = nodeId.replace("fsdir:", "");
    if (expandedFsDirs.has(path)) {
      expandedFsDirs.delete(path);
    } else {
      expandedFsDirs.add(path);
    }
    ensureMainTab("projects");
  } else if (nodeId.startsWith("fsfile:") || nodeId.startsWith("fsmissing:")) {
    ensureMainTab("projects");
  } else if (nodeId.startsWith("instance:")) {
    ensureMainTab("instances");
  } else if (nodeId.startsWith("workspace:")) {
    return;
  } else if (nodeId.startsWith("lens-root:")) {
    return;
  }

  await saveState();
  emitSnapshot();
}

async function syncLocalCurrentWindow(params: any) {
  const workspaceId = String(params?.workspaceId || getCurrentWorkspace().key);
  const lensId = String(params?.lensId || state.currentLayoutId);
  const windowId = String(params?.windowId || state.currentWindowId);
  let runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  const template =
    params?.window && typeof params.window === "object"
      ? params.window
      : {};

  if (!runtimeWindow) {
    runtimeWindow = {
      id: windowId,
      lensId,
      workspaceId,
      title: "",
      mainTabIds: ["workspace"],
      sideTabIds: ["current-state"],
      currentMainTabId: "workspace",
      currentSideTabId: "current-state",
    };
    runtimeWindows.push(runtimeWindow);
  }

  runtimeWindow.workspaceId = workspaceId;
  runtimeWindow.lensId = lensId;
  runtimeWindow.title =
    typeof template.title === "string" && template.title
      ? template.title
      : `${workspaceId} · ${lensId}`;
  runtimeWindow.mainTabIds = Array.isArray(template.mainTabIds)
    ? [...template.mainTabIds]
    : ["workspace"];
  runtimeWindow.sideTabIds = Array.isArray(template.sideTabIds)
    ? [...template.sideTabIds]
    : ["current-state"];
  runtimeWindow.currentMainTabId =
    typeof template.currentMainTabId === "string"
      ? template.currentMainTabId
      : runtimeWindow.mainTabIds[0] || "workspace";
  runtimeWindow.currentSideTabId =
    typeof template.currentSideTabId === "string"
      ? template.currentSideTabId
      : runtimeWindow.sideTabIds[0] || "current-state";

  const syncedBunnyWindow =
    bunnyDashState.workspaces?.[workspaceId]?.windows?.find(
      (window) => window.id === windowId,
    ) || null;
  if (syncedBunnyWindow) {
    removeBunnyWindowFromAllWorkspaces(windowId);
    upsertBunnyWindowForWorkspace(workspaceId, cloneBunnyWindow(syncedBunnyWindow));
    syncHostDashWindowPresentation(windowId, runtimeWindow.title, {
      x: syncedBunnyWindow.position.x,
      y: syncedBunnyWindow.position.y,
      width: syncedBunnyWindow.position.width,
      height: syncedBunnyWindow.position.height,
    });
  }

  state.currentWindowId = windowId;
  state.currentLayoutId = lensId;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId =
    typeof params?.activeTreeNodeId === "string" && params.activeTreeNodeId
      ? params.activeTreeNodeId
      : `lens-overview:${lensId}`;

  await saveState();
  emitSetProjectsForWindow(windowId);
  emitSnapshot();
}

async function handleBunnyDashRequest(method: string, params: any) {
  switch (method) {
    case "getInitialState": {
      const requestedWindowId =
        typeof params?.__hostWindowId === "string" && params.__hostWindowId
          ? params.__hostWindowId
          : undefined;
      const runtimeWindow = requestedWindowId
        ? ensureRuntimeWindowForHostWindow(requestedWindowId)
        : getCurrentWindow();
      ensureBunnyWorkspaceWindow(runtimeWindow || getCurrentWindow());
      const workspace = currentBunnyWorkspace();
      return {
        windowId: getCurrentWindow().id,
        buildVars: bunnyBuildVars(),
        paths: bunnyPaths(),
        webBridgeOrigin: await getWebBridgeOrigin(),
        peerDependencies: bunnyPeerDependencies(),
        workspace,
        bunnyDash: buildWorkspaceLensPayload(getCurrentWindow().id),
        projects: bunnyProjectsForWorkspace(workspace.id),
        tokens: bunnyDashState.tokens || [],
        appSettings: bunnyDashState.appSettings || defaultBunnyAppSettings,
      };
    }
    case "newPreviewNode": {
      const parentPath = getBunnyProjectsFolder();
      const nodeName = getUniqueNewName(parentPath, params?.candidateName || "new-project");
      return {
        type: "dir",
        name: nodeName,
        path: join(parentPath, nodeName),
        previewChildren: [],
        isExpanded: false,
        slate: {
          v: 1,
          name: "",
          url: "",
          icon: "",
          type: "project",
          config: {},
        },
      };
    }
    case "syncWorkspace": {
      const workspaceId = String(params?.workspace?.id || getCurrentWorkspace().key);
      log(`syncWorkspace request: workspace=${workspaceId}`);
      bunnyDashState.workspaces ||= {};
      bunnyDashState.workspaces[workspaceId] = params.workspace;
      await saveState();
      emitSetProjectsForWindow(getCurrentWindow().id);
      return;
    }
    case "syncAppSettings":
      bunnyDashState.appSettings = params.appSettings;
      await writePersistedDashState();
      return;
    case "syncLocalCurrentWindow":
      await syncLocalCurrentWindow(params);
      return;
    case "getTokens":
      return bunnyDashState.tokens || [];
    case "setToken":
      return;
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

    if (message.name === "fs-file-watch-event") {
      handleFsFileWatchEvent(message.payload);
      return;
    }

    if (message.name === "boot") {
      await ensureBootPromise();
      emitSnapshot();
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
      emitSnapshot();
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
      case "getSnapshot":
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "hostWindowClosed":
        await handleHostWindowClosed(String(message.params?.windowId || ""));
        post({ type: "response", requestId: message.requestId, success: true, payload: null });
        break;
      case "toggleSidebar":
        state.sidebarCollapsed = !state.sidebarCollapsed;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "togglePalette":
        state.commandPaletteOpen = !state.commandPaletteOpen;
        if (!state.commandPaletteOpen) {
          state.commandQuery = "";
        }
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "setCommandQuery":
        setCommandQuery(String(message.params?.query || ""));
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "selectNode":
        await selectNode(String(message.params?.nodeId || ""));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "focusMainTab":
        setMainTab(String(message.params?.tabId || getCurrentWindow().currentMainTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "focusSideTab":
        setSideTab(String(message.params?.tabId || getCurrentWindow().currentSideTabId) as WindowTabId);
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "toggleBunnyPopover":
        state.bunnyPopoverOpen = !state.bunnyPopoverOpen;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openCloudPanel":
        ensureMainTab("cloud");
        ensureSideTab("cloud");
        state.activeTreeNodeId = `lens-overview:${state.currentLayoutId}`;
        await saveState();
        emitSnapshot();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openQuickAccess": {
        const tabId = String(message.params?.tabId || "");
        if (tabId !== "browser" && tabId !== "terminal" && tabId !== "agent") {
          throw new Error(`Unknown quick access tab: ${tabId}`);
        }
        const next = await openQuickAccess(tabId);
        post({ type: "response", requestId: message.requestId, success: true, payload: next });
        break;
      }
      case "openLens":
      case "applyLayout":
        await openLens(String(message.params?.lensId || message.params?.layoutId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openLensInNewWindow":
        await openLensInNewWindow(String(message.params?.lensId || state.currentLayoutId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "switchWorkspace":
      case "openWorkspace":
        await openWorkspace(String(message.params?.workspaceId || getCurrentWorkspace().key));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "openWorkspaceInNewWindow":
        await openWorkspaceInNewWindow(String(message.params?.workspaceId || getCurrentWorkspace().key));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "selectLayoutWindow":
      case "selectWindow":
        await selectWindow(String(message.params?.windowId || state.currentWindowId));
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "overwriteCurrentLens":
      case "updateCurrentLayout":
        await overwriteCurrentLens();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "createLens": {
        const created = await createLens(
          String(message.params?.workspaceId || getCurrentWorkspace().key),
          String(message.params?.name || ""),
          String(message.params?.description || ""),
          typeof message.params?.sourceLensId === "string" ? message.params.sourceLensId : undefined,
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "renameLens": {
        const renamed = await renameLens(
          String(message.params?.lensId || state.currentLayoutId),
          String(message.params?.name || ""),
          String(message.params?.description || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: renamed });
        break;
      }
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
