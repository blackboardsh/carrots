import {
  CloudApi,
  getApiBaseUrl,
  type CloudInstance,
  type CloudLens,
  type CloudProjectMount,
  type CloudWorkspace,
} from "../../bun/cloudApi";
import {
  electrobun,
  getDashHostBootState,
  hostCreateWindow,
  scheduleDashHostCacheSync,
} from "./init";
import {
  loadPersistedAppSettings,
  loadPersistedTokens,
  loadPersistedWorkspaceState,
  mergeAppSettingsForBoot,
  persistAppSettings,
  persistWorkspaceState,
} from "./localStateDb";
import {
  buildRuntimeTemplateFromLiveWindow,
  makeDefaultBunnyWindow,
  workspaceCurrentLensKey,
} from "./localBoot";
import {
  type BunnyDashCloudLinkedInstanceType,
  type BunnyDashCloudWorkspaceTreeType,
  type BunnyDashInstanceType,
  getWindow,
  setState,
  state,
  syncWorkspaceNow,
  type WindowType,
  type WorkspaceType,
} from "./store";
import type { DashHostBootState } from "./dashHostCache";
import type { ProjectType } from "../../shared/types/types";

const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const CLOUD_LENS_SHADOW_PREFIX = "__cloud_lens__:";
const DEFAULT_WORKSPACE_COLOR = "#184d8b";
const LIVE_WINDOW_ID_SEPARATOR = "::";

export type DashCloudOverview = {
  connected: boolean;
  currentMachine: {
    machineId: string;
    hostname: string;
    platform: string;
    instanceName: string;
  };
  user: {
    id?: string;
    email?: string;
    name?: string;
    email_verified?: boolean;
  } | null;
  instances: CloudInstance[];
  workspaces: CloudWorkspace[];
  devices: Array<{
    id: string;
    machine_id: string;
    name: string;
    last_used_at: number | null;
    created_at: number;
  }>;
  currentInstanceId: string | null;
  currentDeviceTokenId: string | null;
  currentCarrots: Array<{
    id: string;
    name: string;
    version: string;
    mode: string;
    status: string;
  }>;
};

let cachedCloudApi: CloudApi | null = null;
let cachedCloudApiChannel = "";

function cloudShadowWorkspaceKey(workspaceId: string) {
  return `${CLOUD_WORKSPACE_SHADOW_PREFIX}${workspaceId}`;
}

function cloudShadowLensKey(lensId: string) {
  return `${CLOUD_LENS_SHADOW_PREFIX}${lensId}`;
}

function cloudWorkspaceIdFromShadowKey(runtimeWorkspaceId: string) {
  return runtimeWorkspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX)
    ? runtimeWorkspaceId.slice(CLOUD_WORKSPACE_SHADOW_PREFIX.length)
    : runtimeWorkspaceId;
}

function cloudLensIdFromShadowKey(runtimeLensId: string) {
  return runtimeLensId.startsWith(CLOUD_LENS_SHADOW_PREFIX)
    ? runtimeLensId.slice(CLOUD_LENS_SHADOW_PREFIX.length)
    : runtimeLensId;
}

export function isCloudRuntimeWorkspaceId(workspaceId: string) {
  return workspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX);
}

export function isCloudRuntimeLensId(lensId: string) {
  return lensId.startsWith(CLOUD_LENS_SHADOW_PREFIX);
}

function hasUsableWindowLayout(window: WindowType | null | undefined) {
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
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeLiveWindowId(lensId: string, baseWindowId = "main") {
  return `${lensId}${LIVE_WINDOW_ID_SEPARATOR}${baseWindowId}${LIVE_WINDOW_ID_SEPARATOR}${Date.now()}`;
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

function setCurrentSelection(workspaceId: string, lensId: string) {
  setState("bunnyDash", "currentWorkspaceId", workspaceId);
  setState("bunnyDash", "currentLensId", lensId);
  setState("bunnyDash", "workspaces", (workspace) => true, (workspace) => ({
    ...workspace,
    isCurrent: workspace.id === workspaceId,
    currentLensIsActive:
      workspace.id === workspaceId &&
      workspace.currentLensId === lensId,
    lenses: workspace.lenses.map((lens) => ({
      ...lens,
      isCurrent: workspace.id === workspaceId && lens.id === lensId,
      isDirty: false,
    })),
  }));
  setState("bunnyDash", "cloudWorkspaces", (workspace) => true, (workspace) => ({
    ...workspace,
    isCurrent: workspace.runtimeWorkspaceId === workspaceId,
    lenses: workspace.lenses.map((lens) => ({
      ...lens,
      isCurrent:
        workspace.runtimeWorkspaceId === workspaceId &&
        lens.runtimeLensId === lensId,
    })),
  }));
}

function buildCloudInstances(
  overview: DashCloudOverview,
  hostBoot: DashHostBootState | null,
): BunnyDashInstanceType[] {
  const currentInstanceId =
    overview.currentInstanceId ||
    hostBoot?.currentInstance?.id ||
    "host-machine";
  const currentInstanceName =
    hostBoot?.currentInstance?.name ||
    overview.currentMachine.instanceName ||
    overview.currentMachine.hostname ||
    "This Machine";
  const currentInstanceOs =
    hostBoot?.currentInstance?.os ||
    overview.currentMachine.platform ||
    "";

  return [
    {
      id: currentInstanceId,
      name: currentInstanceName,
      os: currentInstanceOs,
      status: "online",
      isCurrent: true,
      carrots: overview.currentCarrots.map((carrot) => ({
        id: carrot.id,
        name: carrot.name,
        description: "",
        version: carrot.version,
        mode: carrot.mode,
        permissions: [],
        status: carrot.status,
      })),
    },
    ...overview.instances
      .filter((instance) => instance.id !== currentInstanceId)
      .map((instance) => ({
        id: instance.id,
        name: instance.name,
        os: instance.os,
        status: instance.status,
        isCurrent: false,
        carrots: [],
      })),
  ];
}

function buildCloudWorkspaceTrees(
  overview: DashCloudOverview,
  currentWorkspaceId = state.bunnyDash.currentWorkspaceId,
  currentLensId = state.bunnyDash.currentLensId,
): BunnyDashCloudWorkspaceTreeType[] {
  const instancesById = new Map(overview.instances.map((instance) => [instance.id, instance]));

  return overview.workspaces
    .slice()
    .sort((left, right) => (left.sort_order || 0) - (right.sort_order || 0))
    .map((workspace) => {
      const runtimeWorkspaceId = cloudShadowWorkspaceKey(workspace.id);
      const mountsByInstance = new Map<string, CloudProjectMount[]>();

      for (const mount of workspace.mounts || []) {
        if (!mountsByInstance.has(mount.instance_id)) {
          mountsByInstance.set(mount.instance_id, []);
        }
        mountsByInstance.get(mount.instance_id)!.push(mount);
      }

      const linkedInstances: BunnyDashCloudLinkedInstanceType[] = Array.from(
        mountsByInstance.entries(),
      )
        .map(([instanceId, mounts]) => {
          const instance = instancesById.get(instanceId);
          return {
            id: instanceId,
            name: instance?.name || "Linked Instance",
            os: instance?.os || "",
            status: instance?.status || "unknown",
            isCurrent: instanceId === overview.currentInstanceId,
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
          cloudWorkspaceId: workspace.id,
          name: lens.name,
          description: lens.description,
          workspaceId: workspace.id,
          runtimeLensId: cloudShadowLensKey(lens.id),
          layoutJson: lens.layout_json,
          sortOrder: lens.sort_order || 0,
          isCurrent:
            runtimeWorkspaceId === currentWorkspaceId &&
            cloudShadowLensKey(lens.id) === currentLensId,
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
        color: workspace.color,
        sortOrder: workspace.sort_order || 0,
        runtimeWorkspaceId,
        isCurrent: runtimeWorkspaceId === currentWorkspaceId,
        canExpand: lenses.length > 0 || linkedInstances.length > 0,
        lenses,
        linkedInstances,
      };
    });
}

function buildCloudProjectsForWorkspace(
  runtimeWorkspaceId: string,
  cloudWorkspaces = state.bunnyDash.cloudWorkspaces,
): Record<string, ProjectType> {
  const workspace = cloudWorkspaces.find(
    (item) => item.runtimeWorkspaceId === runtimeWorkspaceId,
  );
  if (!workspace) {
    return {};
  }

  const nextProjects: Record<string, ProjectType> = {};
  for (const linkedInstance of workspace.linkedInstances) {
    for (const mount of linkedInstance.mounts) {
      nextProjects[mount.id] = {
        id: mount.id,
        name: mount.name,
        path: mount.path,
        instanceId: linkedInstance.id,
        instanceLabel: linkedInstance.name,
        kind: "code",
        status: linkedInstance.status,
      };
    }
  }

  return nextProjects;
}

function getCloudWorkspaceByRuntimeId(
  runtimeWorkspaceId: string,
  cloudWorkspaces = state.bunnyDash.cloudWorkspaces,
) {
  return (
    cloudWorkspaces.find((workspace) => workspace.runtimeWorkspaceId === runtimeWorkspaceId) ||
    null
  );
}

function getCloudLensByRuntimeId(
  runtimeLensId: string,
  cloudWorkspaces = state.bunnyDash.cloudWorkspaces,
) {
  for (const workspace of cloudWorkspaces) {
    const lens = workspace.lenses.find((item) => item.runtimeLensId === runtimeLensId);
    if (lens) {
      return { workspace, lens };
    }
  }
  return null;
}

function parseCloudLensWindow(
  layoutJson: string | undefined,
  runtimeWorkspaceId: string,
  workspaceName: string,
  fallbackLensName: string,
  windowId: string,
): WindowType {
  const defaultWindow = makeDefaultBunnyWindow(windowId);

  if (!layoutJson || !layoutJson.trim() || layoutJson.trim() === "{}") {
    return defaultWindow;
  }

  try {
    const parsed = JSON.parse(layoutJson) as {
      bunnyWindow?: WindowType;
    };
    if (parsed?.bunnyWindow && typeof parsed.bunnyWindow === "object") {
      return {
        ...clonePlain(parsed.bunnyWindow),
        id: windowId,
      };
    }
  } catch (error) {
    console.warn(
      `Failed to parse cloud lens layout for ${workspaceName} / ${fallbackLensName}:`,
      error,
    );
  }

  return defaultWindow;
}

function resolveCloudWindowState(params: {
  runtimeWorkspaceId: string;
  workspaceName: string;
  windowId: string;
  activeLens?: {
    name: string;
    layoutJson?: string;
  } | null;
  persistedWorkspace: WorkspaceType | null;
  windowTarget?: DashHostBootState["windowTarget"] | null;
}) {
  const persistedWindow = params.persistedWorkspace?.windows?.find(
    (window) => window.id === params.windowId,
  );

  let nextWindow: WindowType;
  if (params.activeLens?.layoutJson) {
    nextWindow = parseCloudLensWindow(
      params.activeLens.layoutJson,
      params.runtimeWorkspaceId,
      params.workspaceName,
      params.activeLens.name,
      params.windowId,
    );
  } else if (hasUsableWindowLayout(persistedWindow)) {
    nextWindow = clonePlain(persistedWindow!);
  } else {
    nextWindow = makeDefaultBunnyWindow(params.windowId);
  }

  if (params.windowTarget?.frame) {
    nextWindow.position = {
      ...nextWindow.position,
      x: params.windowTarget.frame.x,
      y: params.windowTarget.frame.y,
      width: params.windowTarget.frame.width,
      height: params.windowTarget.frame.height,
    };
  }

  return nextWindow;
}

function buildCloudWorkspaceState(params: {
  runtimeWorkspaceId: string;
  workspaceName: string;
  windowId: string;
  color?: string;
  activeLens?: {
    name: string;
    layoutJson?: string;
  } | null;
  persistedWorkspace: WorkspaceType | null;
  windowTarget?: DashHostBootState["windowTarget"] | null;
}): WorkspaceType {
  const nextWindow = resolveCloudWindowState(params);
  return {
    id: params.runtimeWorkspaceId,
    name: params.workspaceName,
    color: params.color || params.persistedWorkspace?.color || DEFAULT_WORKSPACE_COLOR,
    windows: [
      ...((params.persistedWorkspace?.windows || []).filter(
        (window) => window.id !== params.windowId,
      )),
      nextWindow,
    ],
  };
}

async function getRendererCloudApi() {
  const channel = String(state.buildVars?.channel || "");
  if (!state.appSettings.bunnyCloud?.accessToken) {
    throw new Error("Not signed in to Bunny Cloud");
  }

  if (!cachedCloudApi || cachedCloudApiChannel !== channel) {
    cachedCloudApiChannel = channel;
    cachedCloudApi = new CloudApi(getApiBaseUrl(channel || undefined), {
      getAuth: () => ({
        accessToken: state.appSettings.bunnyCloud?.accessToken || "",
        refreshToken: state.appSettings.bunnyCloud?.refreshToken || "",
      }),
      onTokenRefresh: (tokens) => {
        setState("appSettings", "bunnyCloud", {
          ...state.appSettings.bunnyCloud,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
        persistAppSettings(state.appSettings).catch((error) => {
          console.warn("Failed to persist refreshed Bunny Cloud auth:", error);
        });
      },
    });
  }

  return cachedCloudApi;
}

export async function loadCloudOverviewFromHost() {
  const request = electrobun.rpc?.request.getBunnyCloudOverview;
  if (!request) {
    return null;
  }
  return (await request()) as DashCloudOverview | null;
}

export async function refreshCloudRuntimeState(options?: {
  currentWorkspaceId?: string;
  currentLensId?: string;
}) {
  const [overview, hostBoot] = await Promise.all([
    loadCloudOverviewFromHost(),
    getDashHostBootState().catch(() => null),
  ]);

  if (!overview) {
    return null;
  }

  const nextInstances = buildCloudInstances(overview, hostBoot);
  const nextCloudWorkspaces = buildCloudWorkspaceTrees(
    overview,
    options?.currentWorkspaceId || state.bunnyDash.currentWorkspaceId,
    options?.currentLensId || state.bunnyDash.currentLensId,
  );

  setState("bunnyDash", "instances", nextInstances);
  setState("bunnyDash", "cloudWorkspaces", nextCloudWorkspaces as any);

  if (overview.user || state.appSettings.bunnyCloud.accessToken) {
    setState("appSettings", "bunnyCloud", {
      ...state.appSettings.bunnyCloud,
      userId: overview.user?.id || state.appSettings.bunnyCloud.userId,
      email: overview.user?.email || state.appSettings.bunnyCloud.email,
      name: overview.user?.name || state.appSettings.bunnyCloud.name,
      emailVerified:
        overview.user?.email_verified ??
        state.appSettings.bunnyCloud.emailVerified,
      connectedAt:
        state.appSettings.bunnyCloud.connectedAt || Math.floor(Date.now() / 1000),
    });
    void persistAppSettings(state.appSettings).catch((error) => {
      console.warn("Failed to persist Bunny Cloud app settings:", error);
    });
  }

  return overview;
}

export async function bootCloudStateFromHostCache() {
  const [hostBoot, overview, persistedAppSettings, persistedTokens] = await Promise.all([
    getDashHostBootState().catch(() => null),
    loadCloudOverviewFromHost().catch(() => null),
    loadPersistedAppSettings().catch(() => null),
    loadPersistedTokens().catch(() => []),
  ]);

  if (!hostBoot) {
    return false;
  }

  const cachedCloudWorkspaces =
    overview
      ? buildCloudWorkspaceTrees(
          overview,
          hostBoot.windowTarget?.workspaceId || state.bunnyDash.currentWorkspaceId,
          hostBoot.windowTarget?.lensId || state.bunnyDash.currentLensId,
        )
      : hostBoot.dashCache?.cloudWorkspaces || [];
  const cachedInstances = overview
    ? buildCloudInstances(overview, hostBoot)
    : hostBoot.dashCache?.currentInstance
      ? [hostBoot.dashCache.currentInstance]
      : state.bunnyDash.instances;

  const runtimeWorkspaceId =
    hostBoot.windowTarget?.workspaceId || hostBoot.dashCache?.currentWorkspaceId || "";
  const runtimeLensId =
    hostBoot.windowTarget?.lensId || hostBoot.dashCache?.currentLensId || "";

  if (!isCloudRuntimeWorkspaceId(runtimeWorkspaceId)) {
    return false;
  }

  const workspace = getCloudWorkspaceByRuntimeId(runtimeWorkspaceId, cachedCloudWorkspaces);
  if (!workspace) {
    return false;
  }

  const activeLens =
    (runtimeLensId && !runtimeLensId.startsWith("__workspace-current__:"))
      ? workspace.lenses.find((lens) => lens.runtimeLensId === runtimeLensId) || null
      : null;

  const persistedWorkspace = await loadPersistedWorkspaceState(runtimeWorkspaceId);
  const nextWorkspace = buildCloudWorkspaceState({
    runtimeWorkspaceId,
    workspaceName: workspace.name,
    windowId: hostBoot.windowId,
    color: workspace.color,
    activeLens,
    persistedWorkspace,
    windowTarget: hostBoot.windowTarget,
  });

  setState({
    windowId: hostBoot.windowId || state.windowId,
    buildVars: hostBoot.buildVars ?? state.buildVars,
    paths: hostBoot.paths ?? state.paths,
    peerDependencies: hostBoot.peerDependencies ?? state.peerDependencies,
    webBridgeOrigin: hostBoot.webBridgeOrigin ?? state.webBridgeOrigin,
    workspace: nextWorkspace,
    bunnyDash: {
      ...state.bunnyDash,
      currentWorkspaceId: runtimeWorkspaceId,
      currentLensId: runtimeLensId || workspaceCurrentLensKey(runtimeWorkspaceId),
      instances: cachedInstances,
      cloudWorkspaces: cachedCloudWorkspaces as any,
    },
    projects: buildCloudProjectsForWorkspace(runtimeWorkspaceId, cachedCloudWorkspaces),
    tokens: Array.isArray(persistedTokens) ? persistedTokens : [],
    appSettings: mergeAppSettingsForBoot(
      state.appSettings,
      null,
      persistedAppSettings,
    ),
  });

  setCurrentSelection(
    runtimeWorkspaceId,
    runtimeLensId || workspaceCurrentLensKey(runtimeWorkspaceId),
  );

  try {
    await persistWorkspaceState(nextWorkspace);
    await persistAppSettings(state.appSettings);
  } catch (error) {
    console.warn("Failed to persist cloud boot state:", error);
  }

  return true;
}

async function applyCloudSelectionToCurrentWindow(params: {
  runtimeWorkspaceId: string;
  runtimeLensId: string;
  activeTreeNodeId: string;
}) {
  const workspace = getCloudWorkspaceByRuntimeId(params.runtimeWorkspaceId);
  if (!workspace) {
    throw new Error(`Unknown cloud workspace: ${params.runtimeWorkspaceId}`);
  }

  const lens =
    isCloudRuntimeLensId(params.runtimeLensId)
      ? workspace.lenses.find((item) => item.runtimeLensId === params.runtimeLensId) || null
      : null;

  const persistedWorkspace = await loadPersistedWorkspaceState(params.runtimeWorkspaceId);
  const nextWorkspace = buildCloudWorkspaceState({
    runtimeWorkspaceId: params.runtimeWorkspaceId,
    workspaceName: workspace.name,
    windowId: state.windowId,
    color: workspace.color,
    activeLens: lens
      ? {
          name: lens.name,
          layoutJson: lens.layoutJson,
        }
      : null,
    persistedWorkspace,
  });

  setState("workspace", nextWorkspace as any);
  setState("projects", buildCloudProjectsForWorkspace(params.runtimeWorkspaceId));
  setCurrentSelection(params.runtimeWorkspaceId, params.runtimeLensId);
  setState("ui", "showCommandPalette", false);

  await persistWorkspaceState(nextWorkspace as any);

  const payload = {
    currentWorkspaceId: params.runtimeWorkspaceId,
    currentLensId: params.runtimeLensId,
    currentWindow: {
      windowId: state.windowId,
      title: workspace.name,
      frame: getHostFrameForWindow(
        nextWorkspace.windows.find((window) => window.id === state.windowId) ||
          nextWorkspace.windows[0] ||
          makeDefaultBunnyWindow(state.windowId),
      ),
      workspaceId: params.runtimeWorkspaceId,
      lensId: params.runtimeLensId,
      activeTreeNodeId: params.activeTreeNodeId,
    },
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
  };
  scheduleDashHostCacheSync(payload);
}

export async function openCloudWorkspace(runtimeWorkspaceId: string) {
  await syncWorkspaceNow();
  await applyCloudSelectionToCurrentWindow({
    runtimeWorkspaceId,
    runtimeLensId: workspaceCurrentLensKey(runtimeWorkspaceId),
    activeTreeNodeId: `workspace-overview:${runtimeWorkspaceId}`,
  });
}

export async function openCloudLens(runtimeLensId: string) {
  await syncWorkspaceNow();
  const located = getCloudLensByRuntimeId(runtimeLensId);
  if (!located) {
    throw new Error(`Unknown cloud lens: ${runtimeLensId}`);
  }
  await applyCloudSelectionToCurrentWindow({
    runtimeWorkspaceId: located.workspace.runtimeWorkspaceId,
    runtimeLensId,
    activeTreeNodeId: `lens-overview:${runtimeLensId}`,
  });
}

async function openCloudWindowInNewHostWindow(params: {
  runtimeWorkspaceId: string;
  runtimeLensId: string;
  activeTreeNodeId: string;
}) {
  const workspace = getCloudWorkspaceByRuntimeId(params.runtimeWorkspaceId);
  if (!workspace) {
    throw new Error(`Unknown cloud workspace: ${params.runtimeWorkspaceId}`);
  }

  const lens =
    isCloudRuntimeLensId(params.runtimeLensId)
      ? workspace.lenses.find((item) => item.runtimeLensId === params.runtimeLensId) || null
      : null;

  const persistedWorkspace = await loadPersistedWorkspaceState(params.runtimeWorkspaceId);
  const liveWindowId = makeLiveWindowId(
    params.runtimeLensId,
    String(state.windowId).split(LIVE_WINDOW_ID_SEPARATOR)[1] || "main",
  );
  const nextWorkspace = buildCloudWorkspaceState({
    runtimeWorkspaceId: params.runtimeWorkspaceId,
    workspaceName: workspace.name,
    windowId: liveWindowId,
    color: workspace.color,
    activeLens: lens
      ? {
          name: lens.name,
          layoutJson: lens.layoutJson,
        }
      : null,
    persistedWorkspace,
  });

  await persistWorkspaceState(nextWorkspace);

  const nextWindow =
    nextWorkspace.windows.find((window) => window.id === liveWindowId) ||
    nextWorkspace.windows[0];
  if (!nextWindow) {
    return;
  }

  scheduleDashHostCacheSync({
    currentWorkspaceId: params.runtimeWorkspaceId,
    currentLensId: params.runtimeLensId,
    currentWindow: {
      windowId: liveWindowId,
      title: workspace.name,
      frame: getHostFrameForWindow(nextWindow),
      workspaceId: params.runtimeWorkspaceId,
      lensId: params.runtimeLensId,
      activeTreeNodeId: params.activeTreeNodeId,
    },
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
  hostCreateWindow({
    windowId: liveWindowId,
    title: workspace.name,
    frame: getHostFrameForWindow(nextWindow),
  });
}

export async function openCloudWorkspaceInNewWindow(runtimeWorkspaceId: string) {
  await syncWorkspaceNow();
  await openCloudWindowInNewHostWindow({
    runtimeWorkspaceId,
    runtimeLensId: workspaceCurrentLensKey(runtimeWorkspaceId),
    activeTreeNodeId: `workspace-overview:${runtimeWorkspaceId}`,
  });
}

export async function openCloudLensInNewWindow(runtimeLensId: string) {
  await syncWorkspaceNow();
  const located = getCloudLensByRuntimeId(runtimeLensId);
  if (!located) {
    throw new Error(`Unknown cloud lens: ${runtimeLensId}`);
  }
  await openCloudWindowInNewHostWindow({
    runtimeWorkspaceId: located.workspace.runtimeWorkspaceId,
    runtimeLensId,
    activeTreeNodeId: `lens-overview:${runtimeLensId}`,
  });
}

export async function overwriteCurrentCloudLens() {
  const runtimeLensId = state.bunnyDash.currentLensId;
  const located = getCloudLensByRuntimeId(runtimeLensId);
  if (!located) {
    throw new Error("Current lens is not a saved cloud lens");
  }

  await syncWorkspaceNow();

  const currentWindow = getWindow();
  if (!currentWindow) {
    throw new Error("No active cloud window");
  }

  const api = await getRendererCloudApi();
  await api.updateLens(
    located.workspace.id,
    located.lens.id,
    {
      name: located.lens.name,
      description: located.lens.description || "",
      layout_json: JSON.stringify({
        version: 1,
        bunnyWindow: clonePlain(currentWindow),
        windowTemplate: buildRuntimeTemplateFromLiveWindow(
          currentWindow,
          "main",
          located.workspace.runtimeWorkspaceId,
          `${located.workspace.name} · ${located.lens.name}`,
        ),
      }),
    },
  );
  await refreshCloudRuntimeState({
    currentWorkspaceId: located.workspace.runtimeWorkspaceId,
    currentLensId: runtimeLensId,
  });
}

export async function createOrRenameCloudLens(params: {
  workspaceId: string;
  name: string;
  description?: string;
  sourceLensId?: string;
  lensId?: string;
}) {
  const api = await getRendererCloudApi();
  const runtimeWorkspaceId = params.workspaceId;
  const workspace = getCloudWorkspaceByRuntimeId(runtimeWorkspaceId);
  if (!workspace) {
    throw new Error(`Unknown cloud workspace: ${runtimeWorkspaceId}`);
  }

  const cleanName = params.name.trim();
  if (!cleanName) {
    throw new Error("Lens name is required");
  }

  if (params.lensId) {
    const located = getCloudLensByRuntimeId(params.lensId);
    if (!located) {
      throw new Error(`Unknown cloud lens: ${params.lensId}`);
    }
    await api.updateLens(workspace.id, located.lens.id, {
      name: cleanName,
      description: params.description?.trim() || "",
    });
    await refreshCloudRuntimeState({
      currentWorkspaceId: runtimeWorkspaceId,
      currentLensId: state.bunnyDash.currentLensId,
    });
    return params.lensId;
  }

  let layoutJson: string | undefined;
  if (!params.sourceLensId && state.bunnyDash.currentWorkspaceId === runtimeWorkspaceId) {
    await syncWorkspaceNow();
    const currentWindow = getWindow();
    if (currentWindow) {
      layoutJson = JSON.stringify({
        version: 1,
        bunnyWindow: clonePlain(currentWindow),
        windowTemplate: buildRuntimeTemplateFromLiveWindow(
          currentWindow,
          "main",
          runtimeWorkspaceId,
          `${workspace.name} · ${cleanName}`,
        ),
      });
    }
  } else if (params.sourceLensId) {
    const source = getCloudLensByRuntimeId(params.sourceLensId);
    layoutJson = source?.lens.layoutJson;
  }

  const created = await api.createLens(
    cloudWorkspaceIdFromShadowKey(runtimeWorkspaceId),
    cleanName,
    layoutJson,
    params.description?.trim() || "",
  );

  await refreshCloudRuntimeState({
    currentWorkspaceId: runtimeWorkspaceId,
    currentLensId: cloudShadowLensKey(created.id),
  });
  return cloudShadowLensKey(created.id);
}
