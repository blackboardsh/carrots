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
  type CloudDeviceToken,
  type CloudInstance,
  type CloudUserProfile,
  type CloudWorkspace,
} from "./cloudApi";
import {
  ApplicationMenu,
  BrowserWindow,
  Carrots,
  ContextMenu,
  defineElectrobunRPC,
  Tray,
  Utils,
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

type BunnyCloudOverview = {
  connected: boolean;
  currentMachine: BunnyCloudMachineInfo;
  user: CloudUserProfile | null;
  instances: CloudInstance[];
  workspaces: CloudWorkspace[];
  devices: CloudDeviceToken[];
  currentInstanceId: string | null;
  currentDeviceTokenId: string | null;
  currentCarrots: CachedCarrotSummary[];
};

type CachedCarrotSummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: string;
  permissions: string[];
  status: string;
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
const browserWindows = new Map<string, BrowserWindow>();
let tray: Tray | null = null;
const terminalWindowOwners = new Map<string, string>();
const expandedFsDirs = new Set<string>();
const framePersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let ptyHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
const LIVE_WINDOW_ID_SEPARATOR = "::";
const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const CLOUD_LENS_SHADOW_PREFIX = "__cloud_lens__:";
const PTY_CARROT_ID = "bunny.pty";
const FS_CARROT_ID = "bunny.fs";
const GIT_CARROT_ID = "bunny.git";
const TSSERVER_CARROT_ID = "bunny.tsserver";
const BIOME_CARROT_ID = "bunny.biome";
const LLAMA_CARROT_ID = "bunny.llama";
const DEFAULT_PTY_HEARTBEAT_INTERVAL_MS = 60 * 1000;
let ptyHeartbeatIntervalMs = DEFAULT_PTY_HEARTBEAT_INTERVAL_MS;
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

const builtInShortcuts: Array<{
  accelerator: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}> = [
  {
    accelerator: "t",
    key: "t",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "p",
    key: "p",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+p",
    key: "p",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+f",
    key: "f",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "w",
    key: "w",
    ctrl: false,
    shift: false,
    alt: false,
    meta: true,
  },
  {
    accelerator: "cmd+shift+w",
    key: "w",
    ctrl: false,
    shift: true,
    alt: false,
    meta: true,
  },
  {
    accelerator: "ctrl+tab",
    key: "Tab",
    ctrl: true,
    shift: false,
    alt: false,
    meta: false,
  },
  {
    accelerator: "ctrl+shift+tab",
    key: "Tab",
    ctrl: true,
    shift: true,
    alt: false,
    meta: false,
  },
];

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
    }));
  } catch {}
}

function getCloudChannel() {
  return runtimeChannel || app.channel || (manifestVersion === "0.0.1" ? "dev" : undefined);
}

function getCloudBaseUrl() {
  return getApiBaseUrl(getCloudChannel());
}

function getCurrentCloudAccessToken() {
  return runtimeAuthToken || app.authToken || bunnyDashState.appSettings?.bunnyCloud?.accessToken || "";
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

async function cloudFetch<T>(
  path: string,
  options: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const accessToken = options.accessToken ?? getCurrentCloudAccessToken();
  if (!accessToken) {
    throw new Error("Not signed in to Bunny Cloud");
  }
  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
    Authorization: `Bearer ${accessToken}`,
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${getCloudBaseUrl()}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(`API ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function persistBunnyCloudUser(user: CloudUserProfile | null, auth?: { accessToken?: string; refreshToken?: string }) {
  if (!bunnyDashState.appSettings) {
    bunnyDashState.appSettings = structuredClone(defaultBunnyAppSettings);
  }
  const bunnyCloud = bunnyDashState.appSettings.bunnyCloud;
  if (auth?.accessToken !== undefined) {
    bunnyCloud.accessToken = auth.accessToken;
  }
  if (auth?.refreshToken !== undefined) {
    bunnyCloud.refreshToken = auth.refreshToken;
  }
  if (user) {
    bunnyCloud.userId = user.id || "";
    bunnyCloud.email = user.email || "";
    bunnyCloud.name = user.name || "";
    bunnyCloud.emailVerified = !!user.email_verified;
    bunnyCloud.connectedAt = Date.now();
  }
}

async function createDeviceTokenForCurrentMachine(accessToken?: string) {
  const machine = await getCurrentMachineInfo();
  if (!machine.machineId) {
    return null;
  }
  return cloudFetch<{ id: string; token: string }>("/v1/auth/device-tokens", {
    method: "POST",
    accessToken,
    body: JSON.stringify({
      machine_id: machine.machineId,
      name: machine.instanceName,
    }),
  });
}

async function getBunnyCloudOverview(): Promise<BunnyCloudOverview> {
  const currentMachine = await getCurrentMachineInfo();
  const accessToken = getCurrentCloudAccessToken();
  if (!accessToken) {
    return {
      connected: false,
      currentMachine,
      user: null,
      instances: [],
      workspaces: [],
      devices: [],
      currentInstanceId: null,
      currentDeviceTokenId: null,
      currentCarrots: cachedCarrotList,
    };
  }

  cloudApi = initCloudApi();
  if (!cloudApi) {
    return {
      connected: false,
      currentMachine,
      user: null,
      instances: [],
      workspaces: [],
      devices: [],
      currentInstanceId: null,
      currentDeviceTokenId: null,
      currentCarrots: cachedCarrotList,
    };
  }

  const [user, instances, workspaces, devices] = await Promise.all([
    cloudApi.getUserProfile().catch(() => null),
    cloudApi.getInstances().catch(() => []),
    cloudApi.listWorkspaces().catch(() => []),
    cloudApi.getDeviceTokens().catch(() => []),
  ]);

  cloudInstances = instances;
  cloudWorkspaces = workspaces;

  if (user) {
    persistBunnyCloudUser(user);
    await writePersistedDashState().catch(() => {});
  }

  const currentInstanceId = currentMachine.machineId
    ? instances.find((instance) => instance.machine_id === currentMachine.machineId)?.id || null
    : null;
  cloudCurrentInstanceId = currentInstanceId;
  syncCloudShadowState();
  const currentDeviceTokenId = currentMachine.machineId
    ? devices.find((device) => device.machine_id === currentMachine.machineId)?.id || null
    : null;

  return {
    connected: true,
    currentMachine,
    user,
    instances,
    workspaces,
    devices,
    currentInstanceId,
    currentDeviceTokenId,
    currentCarrots: cachedCarrotList,
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

async function loginToBunnyCloud(params: {
  mode: "login" | "register";
  email: string;
  password: string;
  name?: string;
}) {
  const endpoint = params.mode === "register" ? "/v1/auth/register" : "/v1/auth/login";
  const body: Record<string, string> = {
    email: params.email,
    password: params.password,
  };
  if (params.mode === "register" && params.name?.trim()) {
    body.name = params.name.trim();
  }

  const response = await fetch(`${getCloudBaseUrl()}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json() as {
    error?: string;
    accessToken?: string;
    refreshToken?: string;
    user?: CloudUserProfile;
  };

  if (!response.ok || !data.accessToken || !data.refreshToken || !data.user) {
    throw new Error(data.error || `API ${response.status}`);
  }

  persistBunnyCloudUser(data.user, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
  });
  await app.setAuthToken(data.accessToken);

  const deviceToken = await createDeviceTokenForCurrentMachine(data.accessToken).catch(() => null);
  if (deviceToken?.token) {
    await app.setDeviceToken(deviceToken.token, deviceToken.id);
  }

  cloudApi = initCloudApi();
  await refreshCloudData();
  await writePersistedDashState().catch(() => {});
  broadcastAppSettings();
  return getBunnyCloudOverview();
}

async function registerCurrentCloudInstance() {
  const accessToken = getCurrentCloudAccessToken();
  if (!accessToken) {
    throw new Error("Sign in to Bunny Cloud first");
  }

  await app.setAuthToken(accessToken);
  const deviceToken = await createDeviceTokenForCurrentMachine(accessToken).catch(() => null);
  if (deviceToken?.token) {
    await app.setDeviceToken(deviceToken.token, deviceToken.id);
  }

  cloudApi = initCloudApi();
  await refreshCloudData();
  return getBunnyCloudOverview();
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseDurationMs(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, parsed);
}

function getOrCreateBrowserWindow(windowId = state.currentWindowId, title?: string) {
  const runtimeWindow = runtimeWindows.find((candidate) => candidate.id === windowId);
  if (!runtimeWindow) {
    throw new Error(`Unknown runtime window: ${windowId}`);
  }

  const existing = browserWindows.get(windowId);
  if (existing) {
    if (title && title !== existing.title) {
      existing.setTitle(title);
    }
    return existing;
  }

  const bunnyWindow = getBunnyWindowForRuntimeWindow(windowId);

  // Wrap each request handler with boot + window context
  const r = <T>(fn: (params: any) => T | Promise<T>) => async (params: any) => {
    await ensureBootPromise();
    setActiveWindow(windowId);
    return fn(params);
  };
  // Wrap each message handler (fire-and-forget)
  const m = (fn: (payload: any) => void | Promise<void>) => (payload: any) => {
    ensureBootPromise().then(() => {
      setActiveWindow(windowId);
      fn(payload);
    }).catch(() => {});
  };

  const rpc = defineElectrobunRPC("bun", {
    maxRequestTime: 10000,
    handlers: {
      requests: {
        openFarm: r(() => { app.openManager(); return { ok: true }; }),
        logoutBunnyCloud: r(async () => {
          await app.setAuthToken("");
          return { ok: true };
        }),
        getBunnyCloudOverview: r(async () => getBunnyCloudOverview()),
        loginBunnyCloud: r(async (params) => {
          try {
            const overview = await loginToBunnyCloud({
              mode: params?.mode === "register" ? "register" : "login",
              email: String(params?.email || "").trim(),
              password: String(params?.password || ""),
              name: typeof params?.name === "string" ? params.name : undefined,
            });
            emitSetProjects();
            return { ok: true, overview };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
        registerCurrentBunnyCloudInstance: r(async () => {
          try {
            const overview = await registerCurrentCloudInstance();
            emitSetProjects();
            return { ok: true, overview };
          } catch (error) {
            return {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
        updateCurrentBunnyCloudCarrots: r(async () => {
          await app.updateCarrots();
          await refreshCarrotList();
          emitSetProjects();
          return { ok: true, overview: await getBunnyCloudOverview() };
        }),
        createBunnyCloudWorkspace: r(async (params) => {
          if (!cloudApi) {
            throw new Error("Not signed in to Bunny Cloud");
          }
          await cloudApi.createWorkspace(String(params?.name || "").trim(), typeof params?.description === "string" ? params.description : undefined);
          await refreshCloudData();
          emitSetProjects();
          return { ok: true, overview: await getBunnyCloudOverview() };
        }),
        removeBunnyCloudInstance: r(async (params) => {
          if (!cloudApi) {
            throw new Error("Not signed in to Bunny Cloud");
          }
          await cloudApi.deleteInstance(String(params?.instanceId || ""));
          await refreshCloudData();
          emitSetProjects();
          return { ok: true, overview: await getBunnyCloudOverview() };
        }),
        revokeBunnyCloudDevice: r(async (params) => {
          if (!cloudApi) {
            throw new Error("Not signed in to Bunny Cloud");
          }
          await cloudApi.deleteDeviceToken(String(params?.deviceTokenId || ""));
          emitSetProjects();
          return { ok: true, overview: await getBunnyCloudOverview() };
        }),
        getInitialState: r(() => {
          const workspace = currentBunnyWorkspace();
          ensureBunnyWorkspaceWindow(getCurrentWindow());
          return {
            windowId: getCurrentWindow().id,
            buildVars: bunnyBuildVars(),
            paths: bunnyPaths(),
            peerDependencies: bunnyPeerDependencies(),
            workspace,
            bunnyDash: buildWorkspaceLensPayload(getCurrentWindow().id),
            projects: bunnyProjectsForWorkspace(workspace.id),
            tokens: bunnyDashState.tokens || [],
            appSettings: bunnyDashState.appSettings || defaultBunnyAppSettings,
          };
        }),
        newPreviewNode: r((params) => {
          const parentPath = getBunnyProjectsFolder();
          const nodeName = getUniqueNewName(parentPath, params?.candidateName || "new-project");
          return { type: "dir", name: nodeName, path: join(parentPath, nodeName), previewChildren: [], isExpanded: false, slate: { v: 1, name: "", url: "", icon: "", type: "project", config: {} } };
        }),
        addProject: r((params) => addProjectMount({ workspaceId: getCurrentWorkspace().key, name: params?.projectName, path: String(params?.path || "") }).then((result) => { emitSetProjects(); return result; })),
        syncWorkspace: r(async (params) => {
          const workspaceId = String(params?.workspace?.id || getCurrentWorkspace().key);
          log(`syncWorkspace request: workspace=${workspaceId}`);
          bunnyDashState.workspaces ||= {};
          bunnyDashState.workspaces[workspaceId] = params.workspace;
          await saveState();
          emitSetProjectsForWindow(getCurrentWindow().id);
        }),
        syncAppSettings: r(async (params) => { bunnyDashState.appSettings = params.appSettings; await writePersistedDashState(); }),
        openFileDialog: r((params) => Utils.openFileDialog({ startingFolder: params?.startingFolder, allowedFileTypes: params?.allowedFileTypes, canChooseFiles: params?.canChooseFiles, canChooseDirectory: params?.canChooseDirectory, allowsMultipleSelection: params?.allowsMultipleSelection })),
        getNode: r((params) => invokeFsCarrot("getNode", { path: String(params?.path || "") })),
        readSlateConfigFile: r((params) => invokeFsCarrot("readSlateConfigFile", { path: String(params?.path || "") })),
        readFile: r((params) => invokeFsCarrot("readFile", { path: String(params?.path || "") })),
        writeFile: r((params) => invokeFsCarrot("writeFile", { path: String(params?.path || ""), value: String(params?.value || "") })),
        touchFile: r((params) => invokeFsCarrot("touchFile", { path: String(params?.path || ""), contents: String(params?.contents || "") })),
        rename: r((params) => invokeFsCarrot("rename", { oldPath: String(params?.oldPath || ""), newPath: String(params?.newPath || "") })),
        exists: r((params) => invokeFsCarrot("exists", { path: String(params?.path || "") })),
        isFolder: r((params) => invokeFsCarrot("isFolder", { path: String(params?.path || "") })),
        mkdir: r((params) => invokeFsCarrot("mkdir", { path: String(params?.path || "") })),
        showInFinder: r(async (params) => { await Utils.showItemInFolder(String(params?.path || "")); }),
        copy: r((params) => invokeFsCarrot("copy", { src: String(params?.src || ""), dest: String(params?.dest || "") })),
        safeDeleteFileOrFolder: r((params) => invokeFsCarrot("safeDeleteFileOrFolder", { path: String(params?.path || "") })),
        safeTrashFileOrFolder: r((params) => invokeFsCarrot("safeTrashFileOrFolder", { path: String(params?.path || "") })),
        execSpawnSync: r((params) => {
          const cmd = String(params?.cmd || "");
          const args = Array.isArray(params?.args) ? params.args.map(String) : [];
          const result = Bun.spawnSync([cmd, ...args], { ...(typeof params?.opts === "object" && params?.opts ? params.opts : {}) });
          if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr || new Uint8Array()) || `${cmd} exited with code ${result.exitCode}`);
          return new TextDecoder().decode(result.stdout || new Uint8Array());
        }),
        createTerminal: r(async (params) => {
          const currentWindowId = getCurrentWindow().id;
          const terminalId = await invokePtyCarrot<string>("createTerminal", { cwd: String(params?.cwd || process.cwd()), shell: typeof params?.shell === "string" ? params.shell : undefined, cols: Number(params?.cols || 80), rows: Number(params?.rows || 24) }, { windowId: currentWindowId });
          log(`PTY carrot created terminal ${terminalId} for window ${currentWindowId}`);
          terminalWindowOwners.set(terminalId, currentWindowId);
          return terminalId;
        }),
        writeToTerminal: r((params) => invokePtyCarrot<boolean>("writeToTerminal", { terminalId: String(params?.terminalId || ""), data: String(params?.data || "") })),
        resizeTerminal: r((params) => invokePtyCarrot<boolean>("resizeTerminal", { terminalId: String(params?.terminalId || ""), cols: Number(params?.cols || 80), rows: Number(params?.rows || 24) })),
        killTerminal: r(async (params) => { const result = await invokePtyCarrot<boolean>("killTerminal", { terminalId: String(params?.terminalId || "") }); terminalWindowOwners.delete(String(params?.terminalId || "")); return result; }),
        getTerminalCwd: r((params) => invokePtyCarrot<string | null>("getTerminalCwd", { terminalId: String(params?.terminalId || "") })),
        getWorkspaceLensSidebar: r(() => buildWorkspaceLensSidebarData()),
        activateLens: r((params) => activateLens(String(params?.lensId || state.currentLayoutId))),
        findFilesInWorkspace: r((params) => invokeFsCarrot<string[]>("findFilesInWorkspace", { query: String(params?.query || ""), targets: buildSearchTargetsForWorkspace() }, { windowId: getCurrentWindow().id })),
        findAllInWorkspace: r((params) => invokeFsCarrot<Array<{ path: string; line: number; column: number; match: string }>>("findAllInWorkspace", { query: String(params?.query || ""), targets: buildSearchTargetsForWorkspace() }, { windowId: getCurrentWindow().id })),
        cancelFileSearch: r(() => invokeFsCarrot<boolean>("cancelFileSearch", {}, { windowId: getCurrentWindow().id })),
        cancelFindAll: r(() => invokeFsCarrot<boolean>("cancelFindAll", {}, { windowId: getCurrentWindow().id })),
        // Git operations — all forwarded to git carrot
        gitShow: r((params) => invokeGitCarrot("gitShow", params, { windowId: getCurrentWindow().id })),
        gitCommit: r((params) => invokeGitCarrot("gitCommit", params, { windowId: getCurrentWindow().id })),
        gitCommitAmend: r((params) => invokeGitCarrot("gitCommitAmend", params, { windowId: getCurrentWindow().id })),
        gitAdd: r((params) => invokeGitCarrot("gitAdd", params, { windowId: getCurrentWindow().id })),
        gitLog: r((params) => invokeGitCarrot("gitLog", params, { windowId: getCurrentWindow().id })),
        gitStatus: r((params) => invokeGitCarrot("gitStatus", params, { windowId: getCurrentWindow().id })),
        gitDiff: r((params) => invokeGitCarrot("gitDiff", params, { windowId: getCurrentWindow().id })),
        gitCheckout: r((params) => invokeGitCarrot("gitCheckout", params, { windowId: getCurrentWindow().id })),
        gitCheckIsRepoRoot: r((params) => invokeGitCarrot("gitCheckIsRepoRoot", params, { windowId: getCurrentWindow().id })),
        gitCheckIsRepoInTree: r((params) => invokeGitCarrot("gitCheckIsRepoInTree", params, { windowId: getCurrentWindow().id })),
        gitRevParse: r((params) => invokeGitCarrot("gitRevParse", params, { windowId: getCurrentWindow().id })),
        gitReset: r((params) => invokeGitCarrot("gitReset", params, { windowId: getCurrentWindow().id })),
        gitRevert: r((params) => invokeGitCarrot("gitRevert", params, { windowId: getCurrentWindow().id })),
        gitApply: r((params) => invokeGitCarrot("gitApply", params, { windowId: getCurrentWindow().id })),
        gitStageHunkFromPatch: r((params) => invokeGitCarrot("gitStageHunkFromPatch", params, { windowId: getCurrentWindow().id })),
        gitStageSpecificLines: r((params) => invokeGitCarrot("gitStageSpecificLines", params, { windowId: getCurrentWindow().id })),
        gitStageMonacoChange: r((params) => invokeGitCarrot("gitStageMonacoChange", params, { windowId: getCurrentWindow().id })),
        gitUnstageMonacoChange: r((params) => invokeGitCarrot("gitUnstageMonacoChange", params, { windowId: getCurrentWindow().id })),
        gitCreatePatchFromLines: r((params) => invokeGitCarrot("gitCreatePatchFromLines", params, { windowId: getCurrentWindow().id })),
        gitStashList: r((params) => invokeGitCarrot("gitStashList", params, { windowId: getCurrentWindow().id })),
        gitStashCreate: r((params) => invokeGitCarrot("gitStashCreate", params, { windowId: getCurrentWindow().id })),
        gitStashApply: r((params) => invokeGitCarrot("gitStashApply", params, { windowId: getCurrentWindow().id })),
        gitStashPop: r((params) => invokeGitCarrot("gitStashPop", params, { windowId: getCurrentWindow().id })),
        gitStashShow: r((params) => invokeGitCarrot("gitStashShow", params, { windowId: getCurrentWindow().id })),
        gitRemote: r((params) => invokeGitCarrot("gitRemote", params, { windowId: getCurrentWindow().id })),
        gitAddRemote: r((params) => invokeGitCarrot("gitAddRemote", params, { windowId: getCurrentWindow().id })),
        gitFetch: r((params) => invokeGitCarrot("gitFetch", params, { windowId: getCurrentWindow().id })),
        gitPull: r((params) => invokeGitCarrot("gitPull", params, { windowId: getCurrentWindow().id })),
        gitPush: r((params) => invokeGitCarrot("gitPush", params, { windowId: getCurrentWindow().id })),
        gitBranch: r((params) => invokeGitCarrot("gitBranch", params, { windowId: getCurrentWindow().id })),
        gitCheckoutBranch: r((params) => invokeGitCarrot("gitCheckoutBranch", params, { windowId: getCurrentWindow().id })),
        gitLogRemoteOnly: r((params) => invokeGitCarrot("gitLogRemoteOnly", params, { windowId: getCurrentWindow().id })),
        gitClone: r((params) => invokeGitCarrot("gitClone", params, { windowId: getCurrentWindow().id })),
        gitValidateUrl: r((params) => invokeGitCarrot("gitValidateUrl", params, { windowId: getCurrentWindow().id })),
        getGitConfig: r((params) => invokeGitCarrot("getGitConfig", params, { windowId: getCurrentWindow().id })),
        setGitConfig: r((params) => invokeGitCarrot("setGitConfig", params, { windowId: getCurrentWindow().id })),
        checkGitHubCredentials: r((params) => invokeGitCarrot("checkGitHubCredentials", params, { windowId: getCurrentWindow().id })),
        storeGitHubCredentials: r((params) => invokeGitCarrot("storeGitHubCredentials", params, { windowId: getCurrentWindow().id })),
        removeGitHubCredentials: r((params) => invokeGitCarrot("removeGitHubCredentials", params, { windowId: getCurrentWindow().id })),
        gitCreateBranch: r((params) => invokeGitCarrot("gitCreateBranch", params, { windowId: getCurrentWindow().id })),
        gitDeleteBranch: r((params) => invokeGitCarrot("gitDeleteBranch", params, { windowId: getCurrentWindow().id })),
        gitTrackRemoteBranch: r((params) => invokeGitCarrot("gitTrackRemoteBranch", params, { windowId: getCurrentWindow().id })),
        initGit: r((params) => invokeGitCarrot("initGit", params, { windowId: getCurrentWindow().id })),
        findFirstNestedGitRepo: r((params) => invokeFsCarrot<string | null>("findFirstNestedGitRepo", { searchPath: String(params?.searchPath || ""), timeoutMs: Number(params?.timeoutMs || 5_000) })),
        getUniqueNewName: r((params) => invokeFsCarrot("getUniqueNewName", { parentPath: String(params?.parentPath || ""), baseName: String(params?.baseName || "untitled") })),
        getUniqueLensName: r((params) => getUniqueLensNameForWorkspace(String(params?.workspaceId || getCurrentWorkspace().key), String(params?.baseName || "Lens"))),
        makeFileNameSafe: r((params) => invokeFsCarrot("makeFileNameSafe", { value: String(params?.value || "") })),
        getFaviconForUrl: r(() => "views://assets/file-icons/bookmark.svg"),
        showContextMenu: r((params) => { ContextMenu.showContextMenu(Array.isArray(params?.menuItems) ? params.menuItems : []); }),
        // Plugin stubs
        pluginGetFileDecoration: r(() => null),
        pluginFindSlateForFolder: r(() => null),
        pluginGetStateValue: r(() => null),
        pluginGetPreloadScripts: r(() => []),
        pluginGetAllSlates: r(() => []),
        pluginGetStatusBarItems: r(() => []),
        pluginGetInstalled: r(() => []),
        pluginSearch: r(() => []),
        pluginGetSettingsValues: r(() => []),
        pluginGetSettingsSchema: r(() => []),
        pluginGetEntitlements: r(() => []),
        pluginGetSettingValidationStatuses: r(() => []),
        pluginGetCompletions: r(() => []),
        pluginGetContextMenuItems: r(() => []),
        pluginGetKeybindings: r(() => []),
        pluginGetPendingSettingsMessages: r(() => []),
        pluginSetSettingValue: r(() => ({ success: true })),
        pluginInstall: r(() => ({ success: true })),
        pluginUninstall: r(() => ({ success: true })),
        pluginSetEnabled: r(() => ({ success: true })),
        pluginSlateEvent: r(() => ({ success: true })),
        pluginMountSlate: r(() => ({ success: true })),
        pluginUnmountSlate: r(() => ({ success: true })),
        pluginSendSettingsMessage: r(() => ({ success: true })),
        pluginExecuteCommand: r(() => {}),
        // Llama — forwarded to llama carrot
        llamaListModels: r((params) => invokeLlamaCarrot("llamaListModels", params, { windowId: getCurrentWindow().id })),
        llamaCompletion: r((params) => invokeLlamaCarrot("llamaCompletion", params, { windowId: getCurrentWindow().id })),
        llamaInstallModel: r((params) => invokeLlamaCarrot("llamaInstallModel", params, { windowId: getCurrentWindow().id })),
        llamaRemoveModel: r((params) => invokeLlamaCarrot("llamaRemoveModel", params, { windowId: getCurrentWindow().id })),
        llamaDownloadStatus: r((params) => invokeLlamaCarrot("llamaDownloadStatus", params, { windowId: getCurrentWindow().id })),
        // Tokens
        getTokens: r(() => bunnyDashState.tokens || []),
        setToken: r(() => {}),
        // Snapshot & UI state
        getSnapshot: r(() => snapshot()),
        toggleSidebar: r(async () => { state.sidebarOpen = !state.sidebarOpen; await saveState(); emitSnapshot(); return snapshot(); }),
        togglePalette: r(async () => { state.commandPaletteOpen = !state.commandPaletteOpen; state.commandQuery = ""; await saveState(); emitSnapshot(); return snapshot(); }),
        setCommandQuery: r(async (params) => { state.commandQuery = String(params?.query || ""); await saveState(); emitSnapshot(); return snapshot(); }),
        selectNode: r(async (params) => { await selectNode(String(params?.nodeId || "")); return snapshot(); }),
        focusMainTab: r(async (params) => { setMainTab(String(params?.tabId || getCurrentWindow().currentMainTabId) as any); await saveState(); emitSnapshot(); return snapshot(); }),
        focusSideTab: r(async (params) => { setSideTab(String(params?.tabId || getCurrentWindow().currentSideTabId) as any); await saveState(); emitSnapshot(); return snapshot(); }),
        toggleBunnyPopover: r(async () => { state.bunnyPopoverOpen = !state.bunnyPopoverOpen; await saveState(); emitSnapshot(); return snapshot(); }),
        openCloudPanel: r(async () => { ensureMainTab("cloud"); ensureSideTab("cloud"); state.activeTreeNodeId = `lens-overview:${state.currentLayoutId}`; await saveState(); emitSnapshot(); return snapshot(); }),
        openQuickAccess: r(async (params) => { const tabId = String(params?.tabId || ""); return openQuickAccess(tabId as any); }),
        // Lens operations
        openLens: r(async (params) => { await openLens(String(params?.lensId || params?.layoutId || state.currentLayoutId)); return snapshot(); }),
        applyLayout: r(async (params) => { await openLens(String(params?.lensId || params?.layoutId || state.currentLayoutId)); return snapshot(); }),
        openLensInNewWindow: r(async (params) => { await openLensInNewWindow(String(params?.lensId || state.currentLayoutId)); return snapshot(); }),
        // Workspace operations
        switchWorkspace: r(async (params) => { await openWorkspace(String(params?.workspaceId || getCurrentWorkspace().key)); return snapshot(); }),
        openWorkspace: r(async (params) => { await openWorkspace(String(params?.workspaceId || getCurrentWorkspace().key)); return snapshot(); }),
        openWorkspaceInNewWindow: r(async (params) => { await openWorkspaceInNewWindow(String(params?.workspaceId || getCurrentWorkspace().key)); return snapshot(); }),
        selectLayoutWindow: r(async (params) => { await selectWindow(String(params?.windowId || state.currentWindowId)); return snapshot(); }),
        selectWindow: r(async (params) => { await selectWindow(String(params?.windowId || state.currentWindowId)); return snapshot(); }),
        restoreCurrentState: r(async () => { await restoreCurrentState(); return snapshot(); }),
        resumeLastState: r(async () => { await restoreCurrentState(); return snapshot(); }),
        overwriteCurrentLens: r(async () => { await overwriteCurrentLens(); return snapshot(); }),
        updateCurrentLayout: r(async () => { await overwriteCurrentLens(); return snapshot(); }),
        addProjectMount: r(async (params) => addProjectMount({ workspaceId: params?.workspaceId, name: params?.name, path: String(params?.path || ""), instanceId: params?.instanceId, instanceLabel: params?.instanceLabel, kind: params?.kind })),
        removeProjectMount: r(async (params) =>
          removeProjectMountFromWorkspace({
            workspaceId: params?.workspaceId,
            projectId: typeof params?.projectId === "string" ? params.projectId : undefined,
            mountId: typeof params?.mountId === "string" ? params.mountId : undefined,
          })
        ),
        saveLens: r(async (params) => saveLens(String(params?.name || ""), String(params?.description || ""))),
        saveLayout: r(async (params) => saveLens(String(params?.name || ""), String(params?.description || ""))),
        createLens: r(async (params) => createLens(String(params?.workspaceId || getCurrentWorkspace().key), String(params?.name || ""), String(params?.description || ""), typeof params?.sourceLensId === "string" ? params.sourceLensId : undefined)),
        renameLens: r(async (params) => renameLens(String(params?.lensId || state.currentLayoutId), String(params?.name || ""), String(params?.description || ""))),
        // TS server status
        getTypeScriptStatus: r(() => invokeTsServerCarrot("getTypeScriptStatus", {}, { windowId: getCurrentWindow().id })),
        getBiomeStatus: r(() => invokeBiomeCarrot("getBiomeStatus", {}, { windowId: getCurrentWindow().id })),
      },
      messages: {
        openBunnyWindow: m((payload) => { app.openBunnyWindow({ screenX: typeof payload?.screenX === "number" ? payload.screenX : undefined, screenY: typeof payload?.screenY === "number" ? payload.screenY : undefined }); }),
        closeWindow: m(() => { closeWindow(getCurrentWindow().id); }),
        createWorkspace: m(async () => { const nextName = `Workspace ${listWorkspaces().length + 1}`; await createWorkspace(nextName, "Workspace inside Bunny Dash."); getOrCreateBunnyWorkspace(getCurrentWorkspace().key); emitSetProjects(); }),
        updateWorkspace: m(async (payload) => {
          const workspace = getCurrentWorkspace();
          const db = ensureDb();
          const nextName = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim() : workspace.name;
          db.collection("workspaces").update(workspace.id, { name: nextName, subtitle: workspace.subtitle });
          const bunnyWorkspace = getOrCreateBunnyWorkspace(workspace.key);
          bunnyWorkspace.name = nextName;
          if (typeof payload?.color === "string" && payload.color) bunnyWorkspace.color = payload.color;
          flushDb(); emitSetProjects(); await writePersistedDashState();
        }),
        removeProjectFromBunnyDashOnly: m(async (payload) => {
          const projectId = String(payload?.projectId || "");
          const project = findProjectMountByKey(projectId);
          if (project) { const db = ensureDb(); db.collection("projectMounts").remove(project.id); flushDb(); syncProjectWatchers(); emitSetProjects(); await writePersistedDashState(); }
        }),
        fullyDeleteProjectFromDiskAndBunnyDash: m(async (payload) => {
          const projectId = String(payload?.projectId || "");
          const project = findProjectMountByKey(projectId);
          if (project) {
            await invokeFsCarrot("safeDeleteFileOrFolder", { path: project.path });
            const db = ensureDb();
            db.collection("projectMounts").remove(project.id);
            flushDb();
            syncProjectWatchers();
            emitSetProjects();
            await writePersistedDashState();
          }
        }),
        fullyDeleteNodeFromDisk: m(async (payload) => {
          await invokeFsCarrot("safeDeleteFileOrFolder", { path: String(payload?.nodePath || "") });
        }),
        editProject: m(async (payload) => {
          const project = findProjectMountByKey(String(payload?.projectId || ""));
          if (!project) return;
          ensureDb().collection("projectMounts").update(project.id, { name: String(payload?.projectName || project.name), path: String(payload?.path || project.path) });
          flushDb(); syncProjectWatchers(); emitSetProjects(); await writePersistedDashState();
        }),
        deleteWorkspace: m(async () => {
          const workspaces = listWorkspaces(); if (workspaces.length <= 1) return;
          const current = getCurrentWorkspace(); const db = ensureDb();
          for (const project of getProjectMountsForWorkspace(current.key)) { db.collection("projectMounts").remove(project.id); }
          db.collection("workspaces").remove(current.id); delete (bunnyDashState.workspaces || {})[current.key]; flushDb();
          await openWorkspace(listWorkspaces()[0]!.key); emitSetProjects(); await writePersistedDashState();
        }),
        deleteWorkspaceCompletely: m(async () => {
          const workspaces = listWorkspaces(); if (workspaces.length <= 1) return;
          const current = getCurrentWorkspace(); const db = ensureDb();
          for (const project of getProjectMountsForWorkspace(current.key)) {
            await invokeFsCarrot("safeDeleteFileOrFolder", { path: project.path });
            db.collection("projectMounts").remove(project.id);
          }
          db.collection("workspaces").remove(current.id); delete (bunnyDashState.workspaces || {})[current.key]; flushDb();
          await openWorkspace(listWorkspaces()[0]!.key); emitSetProjects(); await writePersistedDashState();
        }),
        formatFile: m(async (payload) => { await invokeBiomeCarrot("formatFile", { path: String(payload?.path || "") }, { windowId: getCurrentWindow().id }); }),
        tsServerRequest: m(async (payload) => {
          await invokeTsServerCarrot<boolean>("tsServerRequest", { command: String(payload?.command || ""), args: payload?.args ?? {}, metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {} },
            { windowId: typeof payload?.metadata?.windowId === "string" ? payload.metadata.windowId : getCurrentWindow().id });
        }),
        tsServerEditorClosed: m(async (payload) => { await closeTsServerEditor(payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {}); }),
        createWindow: m(async (payload) => { await createAdditionalWindow(payload ? { x: Number(payload.offset?.x || 0), y: Number(payload.offset?.y || 0) } : undefined); }),
        hideWorkspace: m(async () => { await hideCurrentWorkspaceWindows(); }),
        // No-ops
        track: m(() => {}),
        installUpdateNow: m(() => {}),
        addToken: m(() => {}),
        deleteToken: m(() => {}),
        syncDevlink: m(() => {}),
      },
    },
  });

  const carrotDir = app.currentDir || (globalThis as any).__bunnyCarrotBootstrap?.context?.currentDir || "";

  const win = new BrowserWindow({
    title: title || runtimeWindow.title,
    url: "views://lens/index.html",
    viewsRoot: carrotDir || undefined,
    titleBarStyle: "hiddenInset",
    rpc,
    frame: {
      x: bunnyWindow?.position.x ?? 120,
      y: bunnyWindow?.position.y ?? 120,
      width: bunnyWindow?.position.width ?? 1400,
      height: bunnyWindow?.position.height ?? 920,
    },
  });
  browserWindows.set(windowId, win);

  win.on("move", (event: any) => {
    updateBunnyWindowFrame(windowId, {
      x: typeof event?.data?.x === "number" ? event.data.x : undefined,
      y: typeof event?.data?.y === "number" ? event.data.y : undefined,
    });
    schedulePersistWindowFrame(windowId);
  });

  win.on("resize", (event: any) => {
    updateBunnyWindowFrame(windowId, {
      x: typeof event?.data?.x === "number" ? event.data.x : undefined,
      y: typeof event?.data?.y === "number" ? event.data.y : undefined,
      width: typeof event?.data?.width === "number" ? event.data.width : undefined,
      height: typeof event?.data?.height === "number" ? event.data.height : undefined,
    });
    schedulePersistWindowFrame(windowId);
  });

  return win;
}

function focusWindow(windowId?: string, title?: string) {
  getOrCreateBrowserWindow(windowId, title).focus();
}

function closeWindow(windowId?: string) {
  const targetWindowId = windowId || state.currentWindowId;
  const existing = browserWindows.get(targetWindowId);
  if (!existing) {
    return;
  }
  browserWindows.delete(targetWindowId);
  existing.close();
}

function stopCarrot() {
  app.quit();
}

async function reopenRuntimeWindowsOnBoot() {
  if (runtimeWindows.length === 0) {
    return;
  }

  for (const runtimeWindow of runtimeWindows) {
    getOrCreateBrowserWindow(runtimeWindow.id, runtimeWindow.title);
  }

  if (runtimeWindows.some((window) => window.id === state.currentWindowId)) {
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  }
}

function getMenuStartingFolder() {
  return process.env.HOME || getDashHomeDir();
}

function openAboutWindow(url: string) {
  const id = `about-${Date.now().toString(36)}`;
  const win = new BrowserWindow({
    id,
    title: "About",
    url,
    frame: {
      width: 800,
      height: 800,
      x: 120,
      y: 120,
    },
  });
  browserWindows.set(id, win);
}

function sendToFocusedDashWindow(name: string, payload?: unknown) {
  emitViewMessage(name, payload, state.currentWindowId);
}

function sendToDashWindow(windowId: string | undefined, name: string, payload?: unknown) {
  emitViewMessage(name, payload, windowId || state.currentWindowId);
}

function sendRuntimeEventToDashWindow(windowId: string | undefined, name: string, payload?: unknown) {
  const targetWindowId = windowId || state.currentWindowId;
  const existing = browserWindows.get(targetWindowId);
  if (existing) {
    try {
      (existing.webview?.rpc as any)?.send?.[name]?.(payload);
    } catch (err) {
      // View may not be ready yet
    }
  }
  // Also send via postMessage for Hop remote browsers
  post({ type: "action", action: "emit-view", payload: { name, payload, raw: true, windowId: targetWindowId } });
}

function broadcastRuntimeEventToDashWindows(name: string, payload?: unknown) {
  post({
    type: "action",
    action: "emit-view",
    payload: { raw: false, name, payload },
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

async function handleContextMenuAction(action: string, data: any) {
  const windowId = typeof data?.windowId === "string" ? data.windowId : state.currentWindowId;
  if (windowId) {
    setActiveWindow(windowId);
  }

  switch (action) {
    case "workspace_new_lens":
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "create",
        workspaceId: String(data?.workspaceId || getCurrentWorkspace().key),
        name: getUniqueLensNameForWorkspace(
          String(data?.workspaceId || getCurrentWorkspace().key),
          "Lens",
        ),
        description: "",
      });
      return;
    case "workspace_open_in_new_window":
      await openWorkspaceInNewWindow(String(data?.workspaceId || getCurrentWorkspace().key));
      return;
    case "lens_open_in_new_window":
      await openLensInNewWindow(String(data?.lensId || state.currentLayoutId));
      return;
    case "lens_rename": {
      const lens = getLensByKey(String(data?.lensId || state.currentLayoutId));
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "rename",
        workspaceId: getLensWorkspaceId(lens),
        lensId: lens.key,
        name: lens.name,
        description: lens.description || "",
      });
      return;
    }
    case "lens_fork": {
      const lens = getLensByKey(String(data?.lensId || state.currentLayoutId));
      sendRuntimeEventToDashWindow(windowId, "showLensSettings", {
        mode: "create",
        workspaceId: getLensWorkspaceId(lens),
        sourceLensId: lens.key,
        name: getUniqueLensDisplayName(
          getLensWorkspaceId(lens),
          `${lens.name} Copy`,
        ),
        description: lens.description?.trim() || `Forked from ${lens.name}`,
      });
      return;
    }
    case "lens_delete":
      await deleteLens(String(data?.lensId || state.currentLayoutId));
      return;
    case "focus_tab":
      sendToDashWindow(windowId, "focusTab", { tabId: data?.tabId });
      return;
    case "open_new_tab":
      sendToDashWindow(windowId, "openNewTab", { nodePath: data?.nodePath });
      return;
    case "open_as_text":
      sendToDashWindow(windowId, "openAsText", { nodePath: data?.nodePath });
      return;
    case "show_node_settings":
      sendToDashWindow(windowId, "showNodeSettings", { nodePath: data?.nodePath });
      return;
    case "add_child_node":
      sendToDashWindow(windowId, "addChildNode", { nodePath: data?.nodePath });
      return;
    case "add_child_file":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "file",
      });
      return;
    case "add_child_folder":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "dir",
      });
      return;
    case "add_child_web":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "web",
      });
      return;
    case "add_child_agent":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "agent",
      });
      return;
    case "create_preload_file":
      sendToDashWindow(windowId, "createSpecialFile", {
        nodePath: data?.nodePath,
        fileType: "preload",
      });
      return;
    case "create_context_file":
      sendToDashWindow(windowId, "createSpecialFile", {
        nodePath: data?.nodePath,
        fileType: "context",
      });
      return;
    case "new_terminal":
      sendToDashWindow(windowId, "newTerminal", { nodePath: data?.nodePath });
      return;
    case "clone_repo_to_folder":
      sendToDashWindow(windowId, "addChildNode", {
        nodePath: data?.nodePath,
        nodeType: "repo",
      });
      return;
    case "init_git_in_folder": {
      const nodePath = String(data?.nodePath || "");
      if (!nodePath) {
        return;
      }
      await invokeGitCarrot("initGit", { repoRoot: nodePath }, { windowId });
      return;
    }
    case "copy_path_to_clipboard":
      await Utils.clipboardWriteText(String(data?.nodePath || ""));
      return;
    case "open_node_in_finder":
      await Utils.showItemInFolder(String(data?.nodePath || ""));
      return;
    case "remove_project_from_bunny_dash": {
      const project = findProjectMountByKey(String(data?.projectId || ""));
      if (project) {
        ensureDb().collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writePersistedDashState();
      }
      return;
    }
    case "fully_delete_node_from_disk": {
      const nodePath = String(data?.nodePath || "");
      const projectId = typeof data?.projectId === "string" ? data.projectId : "";
      if (projectId) {
        const project = findProjectMountByKey(projectId);
        if (project) {
          ensureDb().collection("projectMounts").remove(project.id);
          flushDb();
        }
      }
      await invokeFsCarrot("safeDeleteFileOrFolder", { path: nodePath });
      emitSetProjects();
      return;
    }
    case "split_pane_container":
      sendToDashWindow(windowId, "splitPaneContainer", {
        pathToPane: data?.pathToPane,
        direction: data?.direction,
      });
      return;
    case "remove_open_file":
      sendToDashWindow(windowId, "removeOpenFile", { filePath: data?.filePath });
      return;
    case "open_open_file":
      sendToDashWindow(windowId, "openFileInEditor", {
        filePath: data?.filePath,
        createIfNotExists: false,
      });
      return;
    default:
      return;
  }
}

async function handleApplicationMenuAction(action: string) {
  if (action === "terms-of-service") {
    openAboutWindow("https://blackboard.sh/terms");
    return;
  }
  if (action === "privacy-statement") {
    openAboutWindow("https://blackboard.sh/privacy");
    return;
  }
  if (action === "acknowledgements") {
    openAboutWindow("views://assets/licenses.html");
    return;
  }
  if (action === "open-file") {
    const files = await Utils.openFileDialog({
      startingFolder: getMenuStartingFolder(),
      allowedFileTypes: "",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: true,
    });
    for (const filePath of files) {
      sendToFocusedDashWindow("openFileInEditor", {
        filePath,
        createIfNotExists: false,
      });
    }
    return;
  }
  if (action === "open-folder") {
    const folders = await Utils.openFileDialog({
      startingFolder: getMenuStartingFolder(),
      allowedFileTypes: "",
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });
    for (const folderPath of folders) {
      sendToFocusedDashWindow("openFolderAsProject", {
        folderPath,
      });
    }
    return;
  }
  if (action === "open-command-palette") {
    sendToFocusedDashWindow("openCommandPalette", {});
    return;
  }
  if (action === "new-browser-tab") {
    sendToFocusedDashWindow("newBrowserTab", {});
    return;
  }
  if (action === "close-tab") {
    sendToFocusedDashWindow("closeCurrentTab", {});
    return;
  }
  if (action === "close-window") {
    sendToFocusedDashWindow("closeCurrentWindow", {});
    return;
  }
  if (action === "plugin-marketplace") {
    sendToFocusedDashWindow("openSettings", { settingsType: "plugin-marketplace" });
    return;
  }
  if (action === "llama-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "llama-settings" });
    return;
  }
  if (action === "bunny-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "global-settings" });
    return;
  }
  if (action === "workspace-settings") {
    sendToFocusedDashWindow("openSettings", { settingsType: "workspace-settings" });
    return;
  }
  if (action.startsWith("global-shortcut:")) {
    const accelerator = action.replace("global-shortcut:", "");
    const shortcut = builtInShortcuts.find((candidate) => candidate.accelerator === accelerator);
    if (!shortcut) {
      return;
    }
    sendToFocusedDashWindow("handleGlobalShortcut", {
      key: shortcut.key,
      ctrl: shortcut.ctrl,
      shift: shortcut.shift,
      alt: shortcut.alt,
      meta: shortcut.meta,
    });
  }
}

function syncApplicationMenu() {
  ApplicationMenu.setApplicationMenu([
    {
      label: "Bunny Dash",
      submenu: [{ role: "quit", accelerator: "cmd+q" }],
    },
    {
      label: "File",
      submenu: [
        {
          type: "normal",
          label: "Open File...",
          action: "open-file",
          accelerator: "cmd+o",
        },
        {
          type: "normal",
          label: "Open Folder...",
          action: "open-folder",
          accelerator: "cmd+shift+o",
        },
        { type: "separator" },
        {
          type: "normal",
          label: "New Browser Tab",
          action: "new-browser-tab",
          accelerator: "cmd+t",
        },
        {
          type: "normal",
          label: "Close Tab",
          action: "close-tab",
          accelerator: "cmd+w",
        },
        {
          type: "normal",
          label: "Close Window",
          action: "close-window",
          accelerator: "cmd+shift+w",
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          type: "normal",
          label: "Next Tab",
          action: "global-shortcut:ctrl+tab",
          accelerator: "ctrl+tab",
        },
        {
          type: "normal",
          label: "Previous Tab",
          action: "global-shortcut:ctrl+shift+tab",
          accelerator: "ctrl+shift+tab",
        },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          type: "normal",
          label: "Command Palette",
          action: "open-command-palette",
          accelerator: "cmd+p",
        },
        {
          type: "normal",
          label: "Command Palette (Commands)",
          action: "global-shortcut:cmd+shift+p",
          accelerator: "cmd+shift+p",
        },
        {
          type: "normal",
          label: "Find in Files",
          action: "global-shortcut:cmd+shift+f",
          accelerator: "cmd+shift+f",
        },
      ],
    },
    {
      label: "Settings",
      submenu: [
        {
          type: "normal",
          label: "Plugins",
          action: "plugin-marketplace",
        },
        {
          type: "normal",
          label: "Llama Settings",
          action: "llama-settings",
        },
        {
          type: "normal",
          label: "Bunny Dash Settings",
          action: "bunny-settings",
        },
        {
          type: "normal",
          label: "Workspace Settings",
          action: "workspace-settings",
        },
      ],
    },
    {
      role: "help",
      label: "Help",
      submenu: [
        {
          type: "normal",
          label: "Terms of Service",
          action: "terms-of-service",
        },
        {
          type: "normal",
          label: "Privacy Statement",
          action: "privacy-statement",
        },
        {
          type: "normal",
          label: "Acknowledgements",
          action: "acknowledgements",
        },
      ],
    },
  ]);
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
    config?: { ptyHeartbeatIntervalMs?: unknown };
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
  ptyHeartbeatIntervalMs = parseDurationMs(
    context?.config?.ptyHeartbeatIntervalMs ??
      process.env.BUNNY_DASH_PTY_HEARTBEAT_INTERVAL_MS,
    ptyHeartbeatIntervalMs,
    1_000,
  );
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
      ensurePtyHeartbeatLoop();
      await refreshTypeScriptPeerDependencyStatus();
      await refreshBiomePeerDependencyStatus();
      await refreshGitPeerDependencyStatus();
      syncApplicationMenu();
      await reopenRuntimeWindowsOnBoot();
      post({ type: "ready" });
      syncTray();
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
  for (const [_id, win] of browserWindows) {
    try {
      (win.webview?.rpc as any)?.send?.appSettingsChanged?.({ appSettings: settings });
    } catch {}
  }
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

ApplicationMenu.on("application-menu-clicked", (event: any) => {
  const action = String(event?.data?.action || event?.action || "");
  if (!action) {
    return;
  }
  void handleApplicationMenuAction(action);
});

ContextMenu.on("context-menu-clicked", (event: any) => {
  const action = String(event?.data?.action || event?.action || "");
  if (!action) {
    return;
  }

  const data = event?.data?.data ?? {};
  void handleContextMenuAction(action, data);
});

process.on("exit", () => {
  if (ptyHeartbeatTimer) {
    clearInterval(ptyHeartbeatTimer);
    ptyHeartbeatTimer = null;
  }
});

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
  const existing = browserWindows.get(targetWindowId);
  if (existing) {
    try {
      (existing.webview?.rpc as any)?.send?.[name]?.(payload);
    } catch (err) {
      // View may not be ready yet
    }
  }
  // Also send via postMessage for Hop remote browsers
  post({ type: "action", action: "emit-view", payload: { name, payload, raw: true, windowId: targetWindowId } });
}

function handlePtyTerminalOutput(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          terminalId?: string;
          data?: string;
          windowId?: string | null;
        })
      : {};
  const terminalId = String(eventPayload.terminalId || "");
  if (!terminalId) {
    return;
  }

  const targetWindowId =
    typeof eventPayload.windowId === "string" && eventPayload.windowId.length > 0
      ? eventPayload.windowId
      : terminalWindowOwners.get(terminalId);
  if (targetWindowId) {
    terminalWindowOwners.set(terminalId, targetWindowId);
  }

  emitViewMessage(
    "terminalOutput",
    {
      terminalId,
      data: String(eventPayload.data || ""),
    },
    targetWindowId,
  );
}

function handlePtyTerminalExit(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          terminalId?: string;
          exitCode?: number;
          signal?: number;
          windowId?: string | null;
        })
      : {};
  const terminalId = String(eventPayload.terminalId || "");
  if (!terminalId) {
    return;
  }

  const targetWindowId =
    typeof eventPayload.windowId === "string" && eventPayload.windowId.length > 0
      ? eventPayload.windowId
      : terminalWindowOwners.get(terminalId);
  emitViewMessage(
    "terminalExit",
    {
      terminalId,
      exitCode: Number(eventPayload.exitCode || 0),
      signal: Number(eventPayload.signal || 0),
    },
    targetWindowId,
  );
  log(`PTY carrot terminal exited ${terminalId}`);
  terminalWindowOwners.delete(terminalId);
}

async function killTerminalSession(terminalId: string) {
  if (!terminalId) {
    return;
  }

  try {
    await invokePtyCarrot<boolean>("killTerminal", {
      terminalId,
    });
  } catch (error) {
    log(
      `failed to kill PTY terminal ${terminalId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    terminalWindowOwners.delete(terminalId);
  }
}

async function killTerminalsForWindow(windowId: string) {
  const terminalIds = Array.from(terminalWindowOwners.entries())
    .filter(([, ownerWindowId]) => ownerWindowId === windowId)
    .map(([terminalId]) => terminalId);

  if (terminalIds.length === 0) {
    return;
  }

  await Promise.all(terminalIds.map((terminalId) => killTerminalSession(terminalId)));
  log(`killed ${terminalIds.length} PTY terminal(s) for window ${windowId}`);
}

async function invokePtyCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(PTY_CARROT_ID, method, params, options);
}

async function invokeFsCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(FS_CARROT_ID, method, params, options);
}

async function invokeGitCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(GIT_CARROT_ID, method, params, options);
}

async function invokeTsServerCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(TSSERVER_CARROT_ID, method, params, options);
}

async function invokeBiomeCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(BIOME_CARROT_ID, method, params, options);
}

async function invokeLlamaCarrot<T = unknown>(
  method: string,
  params?: unknown,
  options?: { windowId?: string },
) {
  return Carrots.invoke<T>(LLAMA_CARROT_ID, method, params, options);
}

async function refreshTypeScriptPeerDependencyStatus() {
  try {
    const status = await invokeTsServerCarrot<TypeScriptPeerDependencyStatus>("getTypeScriptStatus");
    typeScriptPeerDependencyStatus = {
      installed: Boolean(status?.installed),
      version: String(status?.version || ""),
    };
  } catch {
    typeScriptPeerDependencyStatus = {
      installed: false,
      version: "",
    };
  }
}

async function refreshBiomePeerDependencyStatus() {
  try {
    const status = await invokeBiomeCarrot<BiomePeerDependencyStatus>("getBiomeStatus");
    biomePeerDependencyStatus = {
      installed: Boolean(status?.installed),
      version: String(status?.version || ""),
    };
  } catch {
    biomePeerDependencyStatus = {
      installed: false,
      version: "",
    };
  }
}

async function refreshGitPeerDependencyStatus() {
  try {
    const status = await invokeGitCarrot<{ installed: boolean; version: string }>("getGitStatus");
    gitPeerDependencyStatus = {
      installed: Boolean(status?.installed),
      version: String(status?.version || ""),
    };
  } catch {
    gitPeerDependencyStatus = {
      installed: false,
      version: "",
    };
  }
}

async function closeTsServerEditor(metadata: {
  workspaceId?: string;
  windowId?: string;
  editorId?: string;
}) {
  if (!metadata.workspaceId || !metadata.windowId || !metadata.editorId) {
    return;
  }

  try {
    await invokeTsServerCarrot(
      "closeEditor",
      {
        metadata: {
          workspaceId: metadata.workspaceId,
          windowId: metadata.windowId,
          editorId: metadata.editorId,
        },
      },
      { windowId: metadata.windowId },
    );
  } catch {
    // Ignore editor-level tsserver cleanup failures. Window-level cleanup is the backstop.
  }
}

async function closeTsServerEditorsForWindow(windowId: string, workspaceId?: string) {
  if (!windowId) {
    return;
  }

  try {
    await invokeTsServerCarrot(
      "closeWindowEditors",
      {
        windowId,
        workspaceId,
      },
      { windowId },
    );
  } catch {
    // Ignore window-level cleanup failures here. Reopen paths will re-establish state.
  }
}

function buildSearchTargetsForWorkspace(workspaceId = getCurrentWorkspace().key) {
  return getProjectMountsForWorkspace(workspaceId).map((project) => ({
    projectId: project.key,
    path: project.path,
  }));
}

async function heartbeatPtyTerminals() {
  const terminalIds = Array.from(terminalWindowOwners.keys());
  if (terminalIds.length === 0) {
    return;
  }

  try {
    await invokePtyCarrot<{ refreshedCount: number }>("heartbeatTerminals", {
      terminalIds,
    });
  } catch {
    // Ignore heartbeat failures here. Explicit terminal calls will still surface errors.
  }
}

function ensurePtyHeartbeatLoop() {
  if (ptyHeartbeatTimer) {
    return;
  }

  ptyHeartbeatTimer = setInterval(() => {
    void heartbeatPtyTerminals();
  }, ptyHeartbeatIntervalMs);
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

function handleFsFindAllResults(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          query?: string;
          projectId?: string;
          results?: Array<{ path?: string; line?: number; column?: number; match?: string }>;
          windowId?: string | null;
        })
      : {};

  const targetWindowId =
    typeof eventPayload.windowId === "string" ? eventPayload.windowId : state.currentWindowId;

  sendRuntimeEventToDashWindow(
    targetWindowId,
    "findAllInFolderResult",
    {
      query: String(eventPayload.query || ""),
      projectId: String(eventPayload.projectId || ""),
      results: Array.isArray(eventPayload.results)
        ? eventPayload.results.map((result) => ({
            path: String(result?.path || ""),
            line: Number(result?.line || 0),
            column: Number(result?.column || 0),
            match: String(result?.match || ""),
          }))
        : [],
    },
  );
}

function handleFsFindFilesResults(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          query?: string;
          projectId?: string;
          results?: string[];
          windowId?: string | null;
        })
      : {};

  const targetWindowId =
    typeof eventPayload.windowId === "string" ? eventPayload.windowId : state.currentWindowId;

  sendRuntimeEventToDashWindow(
    targetWindowId,
    "findFilesInWorkspaceResult",
    {
      query: String(eventPayload.query || ""),
      projectId: String(eventPayload.projectId || ""),
      results: Array.isArray(eventPayload.results) ? eventPayload.results.map(String) : [],
    },
  );
}

function handleTsServerMessage(payload: unknown) {
  const eventPayload =
    payload && typeof payload === "object"
      ? (payload as {
          message?: Record<string, unknown>;
          metadata?: {
            workspaceId?: string;
            windowId?: string;
            editorId?: string;
          };
          windowId?: string | null;
        })
      : {};

  const targetWindowId =
    typeof eventPayload.metadata?.windowId === "string"
      ? eventPayload.metadata.windowId
      : typeof eventPayload.windowId === "string"
        ? eventPayload.windowId
        : state.currentWindowId;

  sendRuntimeEventToDashWindow(targetWindowId, "tsServerMessage", {
    message:
      eventPayload.message && typeof eventPayload.message === "object"
        ? eventPayload.message
        : {},
    metadata: {
      workspaceId: String(eventPayload.metadata?.workspaceId || ""),
      windowId: String(targetWindowId || ""),
      editorId: String(eventPayload.metadata?.editorId || ""),
    },
  });
}

app.on("pty-terminal-output", handlePtyTerminalOutput);
app.on("pty-terminal-exit", handlePtyTerminalExit);

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
  for (const [_id, win] of browserWindows) {
    try {
      (win.webview?.rpc as any)?.send?.snapshot?.(data);
    } catch {}
  }
  // Also send via postMessage for Hop remote browsers
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

function buildDefaultRuntimeWindowForWorkspace(workspaceId: string, windowId: string): LensWindow {
  const workspace = getWorkspaceByKey(workspaceId);
  const currentLens = ensureWorkspaceCurrentLens(workspace.key);
  return {
    ...structuredClone(DEFAULT_STARTER_LENS_WINDOW),
    id: windowId,
    lensId: currentLens.key,
    workspaceId: workspace.key,
    title: "Main",
  };
}

function applyLensWindowStateToRuntimeWindow(lens: LensDoc, runtimeWindowId: string, workspaceId: string) {
  removeBunnyWindowFromAllWorkspaces(runtimeWindowId);
  const nextWindow = cloneBunnyWindow(parseStoredBunnyWindow(lens));
  nextWindow.id = runtimeWindowId;
  upsertBunnyWindowForWorkspace(workspaceId, nextWindow);
  return nextWindow;
}

function applyDefaultWorkspaceStateToRuntimeWindow(runtimeWindowId: string, workspaceId: string) {
  removeBunnyWindowFromAllWorkspaces(runtimeWindowId);
  const nextWindow = makeDefaultBunnyWindow(runtimeWindowId);
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
  await closeTsServerEditorsForWindow(currentWindow.id, currentWindow.workspaceId);
  await killTerminalsForWindow(currentWindow.id);
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
  const existingBrowserWindow = browserWindows.get(currentWindow.id);
  if (existingBrowserWindow) {
    existingBrowserWindow.setTitle(restoredWindow.title);
    existingBrowserWindow.setFrame(
      restoredBunnyWindow.position.x,
      restoredBunnyWindow.position.y,
      restoredBunnyWindow.position.width,
      restoredBunnyWindow.position.height,
    );
  }
  state.currentLayoutId = lens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  state.activeTreeNodeId = `lens-overview:${lens.key}`;
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
  emitSnapshot();
  log(`lens restored: ${lens.name}`);
  return snapshot();
}

async function openLensInNewWindow(lensId: string) {
  const lens = getLensByKey(lensId);
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
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(liveWindowId);
  focusWindow(liveWindowId, runtimeWindow.title);
  log(`lens opened in new window: ${lens.name}`);
  return snapshot();
}

async function focusExistingLensWindow(windowId: string) {
  const runtimeWindow = runtimeWindows.find((window) => window.id === windowId);
  if (!runtimeWindow) {
    throw new Error(`Unknown runtime window: ${windowId}`);
  }

  state.currentWindowId = runtimeWindow.id;
  state.currentLayoutId = getLensIdForWindow(runtimeWindow);
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(runtimeWindow.id);
  focusWindow(runtimeWindow.id, runtimeWindow.title);
  log(`lens focused: ${state.currentLayoutId}`);
  return snapshot();
}

async function activateLens(lensId: string) {
  return restoreLensInCurrentWindow(lensId);
}

async function openLens(lensId: string) {
  log(`openLens request: ${lensId}`);
  return activateLens(lensId);
}

async function restoreCurrentState() {
  for (const runtimeWindow of runtimeWindows) {
    await closeTsServerEditorsForWindow(runtimeWindow.id, runtimeWindow.workspaceId);
  }
  const snapshotDoc = getCurrentStateDoc();
  runtimeWindows = cloneWindows(snapshotDoc.windows);
  state.currentLayoutId = snapshotDoc.currentLayoutId;
  state.currentWindowId = snapshotDoc.currentWindowId;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  currentState = {
    updatedAt: snapshotDoc.updatedAt,
    currentLayoutId: snapshotDoc.currentLayoutId,
    currentWindowId: snapshotDoc.currentWindowId,
    windows: cloneWindows(snapshotDoc.windows),
  };
  ensureRuntimeState();
  await saveState();
  syncTray();
  emitSetProjects();
  emitSnapshot();
  if (runtimeWindows.length > 0) {
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  }
  log("current state restored");
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
    syncTray();
    emitSetProjectsForWindow(currentWindow.id);
    broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
    emitSnapshot();
    log(`cloud lens overwritten: ${lens.name}`);
    return;
  }
  const db = ensureDb();
  db.collection("layouts").update(lens.id, {
    workspaceId: currentWindow.workspaceId,
    windowStateJson: serializeBunnyWindow(currentBunnyWindow),
    windows: [toLensTemplateWindow(currentWindow)],
  });
  flushDb();
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
  emitSnapshot();
  log(`lens overwritten: ${lens.name}`);
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

  const key = uniqueKey(cleanName, lenses.map((lens) => lens.key));
  const created = ensureDb().collection("layouts").insert({
    key,
    name: cleanName,
    description: description.trim() || (sourceLens ? `Forked from ${sourceLens.name}` : `Saved from ${workspace.name}`),
    workspaceId: workspace.key,
    windowStateJson: serializeBunnyWindow(sourceBunnyWindow),
    sortOrder: lenses.length,
    windows: [toLensTemplateWindow(sourceRuntimeWindow)],
  });

  if (useCurrentWindowState) {
    state.currentLayoutId = created.key;
    currentWindow.lensId = created.key;
    state.activeTreeNodeId = `lens-overview:${created.key}`;
  }

  flushDb();
  await saveState();
  syncTray();
  if (useCurrentWindowState) {
    emitSetProjectsForWindow(currentWindow.id);
  } else {
    emitSetProjects();
  }
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(sourceLens ? `lens forked: ${created.name}` : `lens created: ${created.name}`);
  return snapshot();
}

async function createWorkspace(name: string, subtitle = "") {
  const db = ensureDb();
  const workspaces = listWorkspaces();
  const key = uniqueKey(name, workspaces.map((workspace) => workspace.key));
  const created = db.collection("workspaces").insert({
    key,
    name: name.trim(),
    subtitle: subtitle.trim() || "New Bunny Dash workspace.",
    sortOrder: workspaces.length,
  });

  const currentLens = ensureWorkspaceCurrentLens(created.key);
  const starterBunnyWindow = parseStoredBunnyWindow(currentLens);
  const starterRuntimeWindow = buildRuntimeWindowFromLens(currentLens, getCurrentWindow().id);

  const currentWindow = getCurrentWindow();
  await closeTsServerEditorsForWindow(currentWindow.id, currentWindow.workspaceId);
  await killTerminalsForWindow(currentWindow.id);
  currentWindow.workspaceId = created.key;
  currentWindow.title = starterRuntimeWindow.title;
  currentWindow.mainTabIds = [...starterRuntimeWindow.mainTabIds];
  currentWindow.sideTabIds = [...starterRuntimeWindow.sideTabIds];
  currentWindow.currentMainTabId = starterRuntimeWindow.currentMainTabId;
  currentWindow.currentSideTabId = starterRuntimeWindow.currentSideTabId;
  state.currentLayoutId = currentLens.key;
  state.activeTreeNodeId = `workspace-overview:${created.key}`;
  removeBunnyWindowFromAllWorkspaces(currentWindow.id);
  upsertBunnyWindowForWorkspace(created.key, {
    ...starterBunnyWindow,
    id: currentWindow.id,
  });
  flushDb();
  await saveState();
  syncTray();
  emitSetProjectsForWindow(currentWindow.id);
  emitSnapshot();
  log(`workspace created: ${created.name}`);
  return snapshot();
}

async function addProjectMount(params: {
  workspaceId?: string;
  name?: string;
  path: string;
  instanceId?: string;
  instanceLabel?: string;
  kind?: string;
}) {
  const workspaceId = params.workspaceId || getCurrentWorkspace().key;
  const workspace = getWorkspaceByKey(workspaceId);
  const projectName = params.name?.trim() || basename(params.path) || "project";
  const resolvedPath = params.path.trim();

  if (!resolvedPath) {
    throw new Error("Project path is required");
  }

  if (!existsSync(resolvedPath)) {
    throw new Error(`Project path does not exist: ${resolvedPath}`);
  }

  if (!statSync(resolvedPath).isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolvedPath}`);
  }

  if (isCloudShadowWorkspaceKey(workspace.key)) {
    if (!cloudApi) {
      throw new Error("Not signed in to Bunny Cloud");
    }

    const cloudWorkspaceId = cloudWorkspaceIdFromShadowKey(workspace.key);
    const cloudWorkspace = cloudWorkspaces.find((candidate) => candidate.id === cloudWorkspaceId);
    const currentCloudInstanceId = cloudCurrentInstanceId;
    if (!currentCloudInstanceId) {
      throw new Error("This instance is not registered to Bunny Cloud");
    }

    const targetInstanceId =
      params.instanceId && params.instanceId !== "host-machine"
        ? params.instanceId
        : currentCloudInstanceId;

    if (
      cloudWorkspace?.mounts?.some(
        (mount) =>
          mount.instance_id === targetInstanceId &&
          (mount.path === resolvedPath || mount.name === projectName),
      )
    ) {
      throw new Error(`Workspace ${workspace.name} already contains ${projectName}`);
    }

    await cloudApi.createProjectMount(
      cloudWorkspaceId,
      targetInstanceId,
      resolvedPath,
      projectName,
    );
    await refreshCloudData();
    emitSetProjects();
    await writePersistedDashState();
    return snapshot();
  }

  const projects = listProjectMounts();
  const existingWorkspaceProjects = getProjectMountsForWorkspace(workspace.key);

  if (
    existingWorkspaceProjects.some(
      (project) => project.path === resolvedPath || project.name === projectName,
    )
  ) {
    throw new Error(`Workspace ${workspace.name} already contains ${projectName}`);
  }

  const key = uniqueKey(`${workspace.key}-${projectName}`, projects.map((project) => project.key));
  const created = ensureDb().collection("projectMounts").insert({
    key,
    workspaceId: workspace.key,
    name: projectName,
    instanceId: params.instanceId || "host-machine",
    instanceLabel: params.instanceLabel || hostname() || "This Machine",
    path: resolvedPath,
    kind: params.kind || "code",
    status: "ready",
    sortOrder: projects.length,
  });

  if (existsSync(created.path)) {
    expandedFsDirs.add(created.path);
  }
  syncProjectWatchers();
  state.activeTreeNodeId = `project:${created.key}`;
  flushDb();
  await saveState();
  syncTray();
  emitSnapshot();
  log(`project added: ${created.name}`);
  return snapshot();
}

async function removeProjectMountFromWorkspace(params: {
  workspaceId?: string;
  projectId?: string;
  mountId?: string;
}) {
  const workspaceId = params.workspaceId || getCurrentWorkspace().key;
  const workspace = getWorkspaceByKey(workspaceId);

  if (isCloudShadowWorkspaceKey(workspace.key)) {
    if (!cloudApi) {
      throw new Error("Not signed in to Bunny Cloud");
    }
    const mountId = String(params.mountId || "");
    if (!mountId) {
      throw new Error("Workspace mount id is required");
    }
    await cloudApi.deleteProjectMount(
      cloudWorkspaceIdFromShadowKey(workspace.key),
      mountId,
    );
    await refreshCloudData();
    emitSetProjects();
    await writePersistedDashState();
    return snapshot();
  }

  const projectId = String(params.projectId || "");
  if (!projectId) {
    throw new Error("Local project id is required");
  }
  ensureDb().collection("projectMounts").remove(projectId);
  flushDb();
  syncProjectWatchers();
  emitSetProjects();
  await writePersistedDashState();
  return snapshot();
}

async function saveLens(name: string, description = "") {
  const workspace = getCurrentWorkspace();
  await syncRuntimeWindowFrameFromHost(getCurrentWindow().id);
  const currentBunnyWindow = getCurrentBunnyWindow();
  log(
    `saveLens begin: workspace=${workspace.key} name=${name || "<auto>"} rootPane=${currentBunnyWindow.rootPane.type} currentPane=${currentBunnyWindow.currentPaneId}`,
  );
  return createLens(
    workspace.key,
    name || getUniqueLensNameForWorkspace(workspace.key, "Lens"),
    description,
  );
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
    syncTray();
    emitSetProjects();
    broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
    emitSnapshot();
    log(`cloud lens renamed: ${cleanName}`);
    return snapshot();
  }
  ensureDb().collection("layouts").update(lens.id, {
    name: cleanName,
    description: description.trim(),
  });

  flushDb();
  await saveState();
  syncTray();
  emitSetProjects();
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(`lens renamed: ${cleanName}`);
  return snapshot();
}

async function openWorkspaceInNewWindow(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
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
  syncTray();
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
  if (isWorkspaceCurrentLensKey(lens.key)) {
    throw new Error("Cannot delete a workspace current lens");
  }

  const workspaceId = getLensWorkspaceId(lens);
  const replacementLens = ensureWorkspaceCurrentLens(workspaceId);
  const affectedWindows = runtimeWindows.filter((window) => getLensIdForWindow(window) === lens.key);

  for (const runtimeWindow of affectedWindows) {
    await closeTsServerEditorsForWindow(runtimeWindow.id, runtimeWindow.workspaceId);
    await killTerminalsForWindow(runtimeWindow.id);
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
    const existingBrowserWindow = browserWindows.get(runtimeWindow.id);
    if (existingBrowserWindow) {
      existingBrowserWindow.setTitle(restoredWindow.title);
      existingBrowserWindow.setFrame(
        restoredBunnyWindow.position.x,
        restoredBunnyWindow.position.y,
        restoredBunnyWindow.position.width,
        restoredBunnyWindow.position.height,
      );
    }
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
  syncTray();
  emitSetProjects();
  broadcastRuntimeEventToDashWindows("refreshBunnyDashState");
  emitSnapshot();
  log(`lens deleted: ${lens.name}`);
  return snapshot();
}

async function openWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByKey(workspaceId);
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
  syncTray();
  emitSnapshot();
  log(`quick access opened: ${tabId}`);
  return snapshot();
}

async function handleTrayAction(action: string) {
  if (action === "open-window") {
    if (runtimeWindows.length === 0) {
      await openWorkspaceInNewWindow(getCurrentWorkspace().key);
      return;
    }
    focusWindow(state.currentWindowId, getCurrentWindow().title);
  } else if (action === "resume-last-state" || action === "restore-current-state") {
    await restoreCurrentState();
  } else if (action === "update-current-layout" || action === "overwrite-current-lens") {
    await overwriteCurrentLens();
  } else if (action.startsWith("layout:")) {
    await openLensInNewWindow(action.replace("layout:", ""));
  } else if (action.startsWith("lens:")) {
    await openLensInNewWindow(action.replace("lens:", ""));
  } else if (action.startsWith("workspace:")) {
    await openWorkspaceInNewWindow(action.replace("workspace:", ""));
  } else if (action === "stop") {
    stopCarrot();
  }
}

async function selectWindow(windowId: string) {
  if (!runtimeWindows.some((window) => window.id === windowId)) {
    return;
  }
  setActiveWindow(windowId);
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
}

async function selectNode(nodeId: string) {
  state.activeTreeNodeId = nodeId;

  if (nodeId.startsWith("lens-overview:")) {
    await activateLens(nodeId.replace("lens-overview:", ""));
    return;
  } else if (nodeId.startsWith("lens:")) {
    await activateLens(nodeId.replace("lens:", ""));
    return;
  } else if (nodeId.startsWith("workspace-overview:")) {
    const workspaceId = nodeId.replace("workspace-overview:", "");
    if (workspaceId !== getCurrentWorkspace().key) {
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

function syncTray() {
  if (!permissions.has("host:tray")) return;
  const currentLens = getCurrentLens();
  const workspaces = listWorkspaces();
  const currentWorkspace = getCurrentWorkspaceUnsafe();

  if (!tray) {
    tray = new Tray({ title: `Dash: ${currentLens.name}` });
    tray.on("click", (payload) => {
      void handleTrayAction(String((payload as { action?: string } | undefined)?.action || ""));
    });
  } else {
    tray.setTitle(`Dash: ${currentLens.name}`);
  }

  tray.setMenu([
    { type: "normal", label: "Open Bunny Dash", action: "open-window" },
    { type: "normal", label: "Restore Current State", action: "restore-current-state" },
    { type: "normal", label: "Overwrite Current Lens", action: "overwrite-current-lens" },
    { type: "divider" },
    {
      type: "normal",
        label: "Open Lens",
        action: "noop-lens",
        submenu: workspaces.map((workspace) => ({
          type: "normal",
          label: workspace.name,
          action: `noop-workspace:${workspace.key}`,
          submenu: getLensesForWorkspace(workspace.key).map((lens) => ({
            type: "normal",
            label:
            lens.key === state.currentLayoutId && workspace.key === currentWorkspace?.key
              ? `• ${lens.name}`
              : lens.name,
          action: `lens:${lens.key}`,
        })),
      })),
    },
    { type: "divider" },
    { type: "normal", label: "Stop Bunny Dash", action: "stop" },
  ]);
}

function buildWorkspaceLensSidebarData() {
  const currentWindow = getCurrentWindow();
  const currentLensId = getLensIdForWindow(currentWindow);

  return {
    currentWindowId: currentWindow.id,
    currentWorkspaceId: currentWindow.workspaceId,
    currentLensId,
    workspaces: listVisibleLocalWorkspaces().map((workspace) => ({
      id: workspace.key,
      name: workspace.name,
      lenses: getLensesForWorkspace(workspace.key).map((lens) => ({
        id: lens.key,
        name: lens.name,
        isCurrent:
          lens.key === currentLensId && workspace.key === currentWindow.workspaceId,
      })),
    })),
  };
}

async function createAdditionalWindow(offset?: { x?: number; y?: number }) {
  const currentWindow = getCurrentWindow();
  const currentLens = getCurrentLens();
  const currentWorkspace = getCurrentWorkspace();
  const currentBunnyWindow = getCurrentBunnyWindow();
  const nextWindowId = makeLiveWindowId(currentLens.key, currentWindow.id.split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main");
  const nextRuntimeWindow = {
    ...structuredClone(currentWindow),
    id: nextWindowId,
  };
  const nextBunnyWindow = cloneBunnyWindow(currentBunnyWindow);
  nextBunnyWindow.id = nextWindowId;
  if (offset) {
    nextBunnyWindow.position = {
      ...nextBunnyWindow.position,
      x: nextBunnyWindow.position.x + Number(offset.x || 0),
      y: nextBunnyWindow.position.y + Number(offset.y || 0),
    };
  }

  runtimeWindows.push(nextRuntimeWindow);
  upsertBunnyWindowForWorkspace(currentWorkspace.key, nextBunnyWindow);
  state.currentWindowId = nextWindowId;
  state.currentLayoutId = currentLens.key;
  state.commandPaletteOpen = false;
  state.commandQuery = "";
  syncActiveTreeNode();
  await saveState();
  syncTray();
  emitSnapshot();
  emitSetProjectsForWindow(nextWindowId);
  focusWindow(nextWindowId, nextRuntimeWindow.title);
  log(`window opened: ${nextWindowId}`);
  return snapshot();
}

async function hideCurrentWorkspaceWindows() {
  const workspaceId = getCurrentWorkspace().key;
  const windowIds = runtimeWindows
    .filter((window) => window.workspaceId === workspaceId)
    .map((window) => window.id);

  for (const windowId of windowIds) {
    closeWindow(windowId);
  }

  log(`workspace hidden: ${workspaceId}`);
}

async function handleBunnyDashRequest(method: string, params: any) {
  switch (method) {
    case "openFarm": {
      app.openManager();
      return { ok: true };
    }
    case "logoutBunnyCloud": {
      await app.setAuthToken("");
      emitSetProjects();
      return { ok: true };
    }
    case "getBunnyCloudOverview": {
      return getBunnyCloudOverview();
    }
    case "loginBunnyCloud": {
      try {
        const overview = await loginToBunnyCloud({
          mode: params?.mode === "register" ? "register" : "login",
          email: String(params?.email || "").trim(),
          password: String(params?.password || ""),
          name: typeof params?.name === "string" ? params.name : undefined,
        });
        emitSetProjects();
        return { ok: true, overview };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "registerCurrentBunnyCloudInstance": {
      try {
        const overview = await registerCurrentCloudInstance();
        emitSetProjects();
        return { ok: true, overview };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    case "updateCurrentBunnyCloudCarrots": {
      await app.updateCarrots();
      await refreshCarrotList();
      emitSetProjects();
      return { ok: true, overview: await getBunnyCloudOverview() };
    }
    case "createBunnyCloudWorkspace": {
      if (!cloudApi) {
        throw new Error("Not signed in to Bunny Cloud");
      }
      await cloudApi.createWorkspace(
        String(params?.name || "").trim(),
        typeof params?.description === "string" ? params.description : undefined,
      );
      await refreshCloudData();
      emitSetProjects();
      return { ok: true, overview: await getBunnyCloudOverview() };
    }
    case "removeBunnyCloudInstance": {
      if (!cloudApi) {
        throw new Error("Not signed in to Bunny Cloud");
      }
      await cloudApi.deleteInstance(String(params?.instanceId || ""));
      await refreshCloudData();
      emitSetProjects();
      return { ok: true, overview: await getBunnyCloudOverview() };
    }
    case "revokeBunnyCloudDevice": {
      if (!cloudApi) {
        throw new Error("Not signed in to Bunny Cloud");
      }
      await cloudApi.deleteDeviceToken(String(params?.deviceTokenId || ""));
      emitSetProjects();
      return { ok: true, overview: await getBunnyCloudOverview() };
    }
    case "getInitialState": {
      const workspace = currentBunnyWorkspace();
      ensureBunnyWorkspaceWindow(getCurrentWindow());
      return {
        windowId: getCurrentWindow().id,
        buildVars: bunnyBuildVars(),
        paths: bunnyPaths(),
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
    case "addProject":
      return addProjectMount({
        workspaceId: getCurrentWorkspace().key,
        name: params?.projectName,
        path: String(params?.path || ""),
      }).then((result) => {
        emitSetProjects();
        return result;
      });
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
    case "openFileDialog":
      return Utils.openFileDialog({
        startingFolder: params?.startingFolder,
        allowedFileTypes: params?.allowedFileTypes,
        canChooseFiles: params?.canChooseFiles,
        canChooseDirectory: params?.canChooseDirectory,
        allowsMultipleSelection: params?.allowsMultipleSelection,
      });
    case "getNode":
      return invokeFsCarrot("getNode", { path: String(params?.path || "") });
    case "readSlateConfigFile":
      return invokeFsCarrot("readSlateConfigFile", { path: String(params?.path || "") });
    case "readFile":
      return invokeFsCarrot("readFile", { path: String(params?.path || "") });
    case "writeFile":
      return invokeFsCarrot("writeFile", {
        path: String(params?.path || ""),
        value: String(params?.value || ""),
      });
    case "touchFile":
      return invokeFsCarrot("touchFile", {
        path: String(params?.path || ""),
        contents: String(params?.contents || ""),
      });
    case "rename":
      return invokeFsCarrot("rename", {
        oldPath: String(params?.oldPath || ""),
        newPath: String(params?.newPath || ""),
      });
    case "exists":
      return invokeFsCarrot("exists", { path: String(params?.path || "") });
    case "isFolder":
      return invokeFsCarrot("isFolder", { path: String(params?.path || "") });
    case "mkdir":
      return invokeFsCarrot("mkdir", { path: String(params?.path || "") });
    case "showInFinder":
      await Utils.showItemInFolder(String(params?.path || ""));
      return;
    case "copy":
      return invokeFsCarrot("copy", {
        src: String(params?.src || ""),
        dest: String(params?.dest || ""),
      });
    case "safeDeleteFileOrFolder":
    case "safeTrashFileOrFolder":
      return invokeFsCarrot(method, { path: String(params?.path || "") });
    case "execSpawnSync": {
      const cmd = String(params?.cmd || "");
      const args = Array.isArray(params?.args) ? params.args.map(String) : [];
      const result = Bun.spawnSync([cmd, ...args], {
        ...(typeof params?.opts === "object" && params?.opts ? params.opts : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(new TextDecoder().decode(result.stderr || new Uint8Array()) || `${cmd} exited with code ${result.exitCode}`);
      }
      return new TextDecoder().decode(result.stdout || new Uint8Array());
    }
    case "createTerminal":
      return (async () => {
        const currentWindowId = getCurrentWindow().id;
        const terminalId = await invokePtyCarrot<string>(
          "createTerminal",
          {
            cwd: String(params?.cwd || process.cwd()),
            shell: typeof params?.shell === "string" ? params.shell : undefined,
            cols: Number(params?.cols || 80),
            rows: Number(params?.rows || 24),
          },
          { windowId: currentWindowId },
        );
        log(`PTY carrot created terminal ${terminalId} for window ${currentWindowId}`);
        terminalWindowOwners.set(terminalId, currentWindowId);
        return terminalId;
      })();
    case "writeToTerminal":
      return invokePtyCarrot<boolean>("writeToTerminal", {
        terminalId: String(params?.terminalId || ""),
        data: String(params?.data || ""),
      });
    case "resizeTerminal":
      return invokePtyCarrot<boolean>("resizeTerminal", {
        terminalId: String(params?.terminalId || ""),
        cols: Number(params?.cols || 80),
        rows: Number(params?.rows || 24),
      });
    case "killTerminal":
      return (async () => {
        const result = await invokePtyCarrot<boolean>("killTerminal", {
          terminalId: String(params?.terminalId || ""),
        });
        terminalWindowOwners.delete(String(params?.terminalId || ""));
        return result;
      })();
    case "getTerminalCwd":
      return invokePtyCarrot<string | null>("getTerminalCwd", {
        terminalId: String(params?.terminalId || ""),
      });
    case "getWorkspaceLensSidebar":
      return buildWorkspaceLensSidebarData();
    case "activateLens":
      return activateLens(String(params?.lensId || state.currentLayoutId));
    case "findFilesInWorkspace":
      return invokeFsCarrot<string[]>(
        "findFilesInWorkspace",
        {
          query: String(params?.query || ""),
          targets: buildSearchTargetsForWorkspace(),
        },
        { windowId: getCurrentWindow().id },
      );
    case "findAllInWorkspace":
      return invokeFsCarrot<
        Array<{ path: string; line: number; column: number; match: string }>
      >(
        "findAllInWorkspace",
        {
          query: String(params?.query || ""),
          targets: buildSearchTargetsForWorkspace(),
        },
        { windowId: getCurrentWindow().id },
      );
    case "cancelFileSearch":
      return invokeFsCarrot<boolean>("cancelFileSearch", {}, {
        windowId: getCurrentWindow().id,
      });
    case "cancelFindAll":
      return invokeFsCarrot<boolean>("cancelFindAll", {}, {
        windowId: getCurrentWindow().id,
      });
    case "gitShow":
    case "gitCommit":
    case "gitCommitAmend":
    case "gitAdd":
    case "gitLog":
    case "gitStatus":
    case "gitDiff":
    case "gitCheckout":
    case "gitCheckIsRepoRoot":
    case "gitCheckIsRepoInTree":
    case "gitRevParse":
    case "gitReset":
    case "gitRevert":
    case "gitApply":
    case "gitStageHunkFromPatch":
    case "gitStageSpecificLines":
    case "gitStageMonacoChange":
    case "gitUnstageMonacoChange":
    case "gitCreatePatchFromLines":
    case "gitStashList":
    case "gitStashCreate":
    case "gitStashApply":
    case "gitStashPop":
    case "gitStashShow":
    case "gitRemote":
    case "gitAddRemote":
    case "gitFetch":
    case "gitPull":
    case "gitPush":
    case "gitBranch":
    case "gitCheckoutBranch":
    case "gitLogRemoteOnly":
    case "gitClone":
    case "gitValidateUrl":
    case "getGitConfig":
    case "setGitConfig":
    case "checkGitHubCredentials":
    case "storeGitHubCredentials":
    case "removeGitHubCredentials":
    case "gitCreateBranch":
    case "gitDeleteBranch":
    case "gitTrackRemoteBranch":
    case "initGit":
      return invokeGitCarrot(method, params, {
        windowId: getCurrentWindow().id,
      });
    case "findFirstNestedGitRepo":
      return invokeFsCarrot<string | null>("findFirstNestedGitRepo", {
        searchPath: String(params?.searchPath || ""),
        timeoutMs: Number(params?.timeoutMs || 5_000),
      });
    case "getUniqueNewName":
      return invokeFsCarrot("getUniqueNewName", {
        parentPath: String(params?.parentPath || ""),
        baseName: String(params?.baseName || "untitled"),
      });
    case "getUniqueLensName":
      return getUniqueLensNameForWorkspace(
        String(params?.workspaceId || getCurrentWorkspace().key),
        String(params?.baseName || "Lens"),
      );
    case "makeFileNameSafe":
      return invokeFsCarrot("makeFileNameSafe", {
        value: String(params?.value || ""),
      });
    case "getFaviconForUrl":
      return "views://assets/file-icons/bookmark.svg";
    case "showContextMenu":
      ContextMenu.showContextMenu(Array.isArray(params?.menuItems) ? params.menuItems : []);
      return;
    case "pluginGetFileDecoration":
    case "pluginFindSlateForFolder":
    case "pluginGetStateValue":
      return null;
    case "pluginGetPreloadScripts":
    case "pluginGetAllSlates":
    case "pluginGetStatusBarItems":
    case "pluginGetInstalled":
    case "pluginSearch":
    case "pluginGetSettingsValues":
    case "pluginGetSettingsSchema":
    case "pluginGetEntitlements":
    case "pluginGetSettingValidationStatuses":
    case "pluginGetCompletions":
    case "pluginGetContextMenuItems":
    case "pluginGetKeybindings":
      return [];
    case "pluginGetPendingSettingsMessages":
      return [];
    case "pluginSetSettingValue":
    case "pluginInstall":
    case "pluginUninstall":
    case "pluginSetEnabled":
    case "pluginSlateEvent":
    case "pluginMountSlate":
    case "pluginUnmountSlate":
    case "pluginSendSettingsMessage":
      return { success: true };
    case "pluginExecuteCommand":
      return;
    case "llamaListModels":
    case "llamaCompletion":
    case "llamaInstallModel":
    case "llamaRemoveModel":
    case "llamaDownloadStatus":
      return invokeLlamaCarrot(method, params, {
        windowId: getCurrentWindow().id,
      });
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
    case "openBunnyWindow":
      app.openBunnyWindow({
        screenX: typeof payload?.screenX === "number" ? payload.screenX : undefined,
        screenY: typeof payload?.screenY === "number" ? payload.screenY : undefined,
      });
      return;
    case "closeWindow":
      closeWindow(getCurrentWindow().id);
      return;
    case "createWorkspace": {
      const nextName = `Workspace ${listWorkspaces().length + 1}`;
      await createWorkspace(nextName, "Workspace inside Bunny Dash.");
      getOrCreateBunnyWorkspace(getCurrentWorkspace().key);
      emitSetProjects();
      return;
    }
    case "updateWorkspace": {
      const workspace = getCurrentWorkspace();
      const db = ensureDb();
      const nextName = typeof payload?.name === "string" && payload.name.trim() ? payload.name.trim() : workspace.name;
      db.collection("workspaces").update(workspace.id, {
        name: nextName,
        subtitle: workspace.subtitle,
      });
      const bunnyWorkspace = getOrCreateBunnyWorkspace(workspace.key);
      bunnyWorkspace.name = nextName;
      if (typeof payload?.color === "string" && payload.color) {
        bunnyWorkspace.color = payload.color;
      }
      flushDb();
      emitSetProjects();
      await writePersistedDashState();
      return;
    }
    case "removeProjectFromBunnyDashOnly": {
      const projectId = String(payload?.projectId || "");
      const db = ensureDb();
      const project = findProjectMountByKey(projectId);
      if (project) {
        db.collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writePersistedDashState();
      }
      return;
    }
    case "fullyDeleteProjectFromDiskAndBunnyDash": {
      const projectId = String(payload?.projectId || "");
      const project = findProjectMountByKey(projectId);
      if (project) {
        await invokeFsCarrot("safeDeleteFileOrFolder", { path: project.path });
        const db = ensureDb();
        db.collection("projectMounts").remove(project.id);
        flushDb();
        syncProjectWatchers();
        emitSetProjects();
        await writePersistedDashState();
      }
      return;
    }
    case "fullyDeleteNodeFromDisk":
      await invokeFsCarrot("safeDeleteFileOrFolder", { path: String(payload?.nodePath || "") });
      return;
    case "editProject": {
      const project = findProjectMountByKey(String(payload?.projectId || ""));
      if (!project) {
        return;
      }
      ensureDb().collection("projectMounts").update(project.id, {
        name: String(payload?.projectName || project.name),
        path: String(payload?.path || project.path),
      });
      flushDb();
      syncProjectWatchers();
      emitSetProjects();
      await writePersistedDashState();
      return;
    }
    case "deleteWorkspace":
    case "deleteWorkspaceCompletely": {
      const workspaces = listWorkspaces();
      if (workspaces.length <= 1) {
        return;
      }
      const current = getCurrentWorkspace();
      const db = ensureDb();
      const projects = getProjectMountsForWorkspace(current.key);
      for (const project of projects) {
        if (name === "deleteWorkspaceCompletely") {
          await invokeFsCarrot("safeDeleteFileOrFolder", { path: project.path });
        }
        db.collection("projectMounts").remove(project.id);
      }
      db.collection("workspaces").remove(current.id);
      delete (bunnyDashState.workspaces || {})[current.key];
      flushDb();
      await openWorkspace(listWorkspaces()[0]!.key);
      emitSetProjects();
      await writePersistedDashState();
      return;
    }
    case "track":
    case "installUpdateNow":
    case "addToken":
    case "deleteToken":
    case "syncDevlink":
      return;
    case "formatFile":
      await invokeBiomeCarrot(
        "formatFile",
        {
          path: String(payload?.path || ""),
        },
        { windowId: getCurrentWindow().id },
      );
      return;
    case "tsServerRequest":
      await invokeTsServerCarrot<boolean>(
        "tsServerRequest",
        {
          command: String(payload?.command || ""),
          args: payload?.args ?? {},
          metadata:
            payload && typeof payload === "object" && payload.metadata && typeof payload.metadata === "object"
              ? payload.metadata
              : {},
        },
        {
          windowId:
            payload && typeof payload === "object" && typeof payload?.metadata?.windowId === "string"
              ? payload.metadata.windowId
              : getCurrentWindow().id,
        },
      );
      return;
    case "tsServerEditorClosed":
      await closeTsServerEditor(
        payload && typeof payload === "object" && payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : {},
      );
      return;
    case "createWindow":
      await createAdditionalWindow(
        payload && typeof payload === "object"
          ? { x: Number(payload.offset?.x || 0), y: Number(payload.offset?.y || 0) }
          : undefined,
      );
      return;
    case "hideWorkspace":
      await hideCurrentWorkspaceWindows();
      return;
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

    if (message.name === "fs-find-all-results" || message.name === "search-find-all-results") {
      handleFsFindAllResults(message.payload);
      return;
    }

    if (message.name === "fs-find-files-results" || message.name === "search-find-files-results") {
      handleFsFindFilesResults(message.payload);
      return;
    }

    if (message.name === "tsserver-message") {
      handleTsServerMessage(message.payload);
      return;
    }

    if (message.name === "boot") {
      await ensureBootPromise();
      syncTray();
      emitSnapshot();
      return;
    }

    if (message.name === "window-focus") {
      setActiveWindow(String(message.payload?.windowId || ""));
      syncTray();
      emitSnapshot();
      return;
    }

    if (message.name === "window-closed") {
      const closedWindowId = String(message.payload?.windowId || "");
      const closedRuntimeWindow = runtimeWindows.find((window) => window.id === closedWindowId);
      browserWindows.delete(closedWindowId);
      await closeTsServerEditorsForWindow(closedWindowId, closedRuntimeWindow?.workspaceId);
      await killTerminalsForWindow(closedWindowId);
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
      syncTray();
      emitSetProjects();
      emitSnapshot();
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
      case "restoreCurrentState":
      case "resumeLastState":
        await restoreCurrentState();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "overwriteCurrentLens":
      case "updateCurrentLayout":
        await overwriteCurrentLens();
        post({ type: "response", requestId: message.requestId, success: true, payload: snapshot() });
        break;
      case "createWorkspace": {
        const created = await createWorkspace(
          String(message.params?.name || ""),
          String(message.params?.subtitle || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "addProjectMount": {
        const created = await addProjectMount({
          workspaceId: message.params?.workspaceId,
          name: message.params?.name,
          path: String(message.params?.path || ""),
          instanceId: message.params?.instanceId,
          instanceLabel: message.params?.instanceLabel,
          kind: message.params?.kind,
        });
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
      case "saveLens":
      case "saveLayout": {
        const created = await saveLens(
          String(message.params?.name || ""),
          String(message.params?.description || ""),
        );
        post({ type: "response", requestId: message.requestId, success: true, payload: created });
        break;
      }
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
        const payload = await handleBunnyDashRequest(String(message.method), message.params);
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
