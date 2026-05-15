import type {
  AppState,
  BunnyDashCloudWorkspaceTreeType,
  BunnyDashInstanceType,
  BunnyDashKnownLocalProjectType,
  BunnyDashWorkspaceTreeType,
} from "./store";

export type DashHostWindowSummary = {
  windowId: string;
  title: string;
  frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workspaceId: string;
  lensId: string;
  activeTreeNodeId: string;
};

export type DashHostAccountSummary = {
  signedIn: boolean;
  email: string;
  name: string;
  userId: string;
  emailVerified: boolean;
  connectedAt?: number;
};

export type DashHostSummaryCache = {
  version: 1;
  updatedAt: number;
  currentWorkspaceId: string;
  currentLensId: string;
  currentWindow: DashHostWindowSummary | null;
  windows: DashHostWindowSummary[];
  workspaces: BunnyDashWorkspaceTreeType[];
  cloudWorkspaces: BunnyDashCloudWorkspaceTreeType[];
  knownLocalProjects: BunnyDashKnownLocalProjectType[];
  peerDependencies: AppState["peerDependencies"];
  account: DashHostAccountSummary;
  currentInstance: BunnyDashInstanceType | null;
};

export type DashHostBootState = {
  windowId: string;
  buildVars: AppState["buildVars"];
  paths: AppState["paths"];
  peerDependencies: AppState["peerDependencies"];
  webBridgeOrigin: string;
  dashCache: DashHostSummaryCache | null;
  windowTarget: DashHostWindowSummary | null;
  currentInstance: BunnyDashInstanceType | null;
};

export type DashHostCacheSyncPayload = Omit<
  DashHostSummaryCache,
  "version" | "updatedAt" | "windows"
>;

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildDashHostCachePayloadFromState(
  state: AppState,
): DashHostCacheSyncPayload | null {
  if (!state.windowId) {
    return null;
  }

  const workspaceId = state.bunnyDash.currentWorkspaceId || state.workspace.id;
  const lensId = state.bunnyDash.currentLensId || "";
  const currentLensName =
    state.bunnyDash.workspaces
      .flatMap((workspace) => workspace.lenses)
      .find((lens) => lens.id === lensId)?.name || "Current";
  const currentWindow =
    (state.workspace.windows || []).find((window) => window.id === state.windowId) || null;

  if (!workspaceId || !lensId || !currentWindow || !state.workspace.windows?.length) {
    return null;
  }

  return {
    currentWorkspaceId: workspaceId,
    currentLensId: lensId,
    currentWindow: currentWindow
      ? {
          windowId: currentWindow.id,
          title:
            (state.workspace.name
              ? `${state.workspace.name} · ${currentLensName}`
              : currentWindow.id),
          frame: {
            x: Number(currentWindow.position?.x || 0),
            y: Number(currentWindow.position?.y || 0),
            width: Number(currentWindow.position?.width || 1500),
            height: Number(currentWindow.position?.height || 900),
          },
          workspaceId,
          lensId,
          activeTreeNodeId: lensId
            ? `lens-overview:${lensId}`
            : workspaceId
              ? `workspace-overview:${workspaceId}`
              : "",
        }
      : null,
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
    currentInstance: clonePlain(state.bunnyDash.instances?.find((instance) => instance.isCurrent) || null),
  };
}
