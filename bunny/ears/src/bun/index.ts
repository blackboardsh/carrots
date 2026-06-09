import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  ContextMenu as HostContextMenu,
  Screen,
  Tray,
  Utils,
  type RPCSchema,
  Updater,
} from "electrobun/bun";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CarrotContributions,
  CarrotViewRPC,
  CarrotWorkerMessage,
} from "../carrot-runtime/types";
import {
  getInstalledCarrotsRoot,
  getInstalledCarrot,
  installDevCarrotFromSource,
  loadInstalledCarrots,
  prepareArtifactCarrotInstall,
  prepareDevCarrotInstallFromSource,
  pruneLegacyPrototypeCarrots,
  refreshTrackedDevCarrots,
  uninstallInstalledCarrot,
  type InstalledCarrot,
  type PreparedCarrotInstall,
} from "./carrotStore";
import { requestCarrotUninstallConsent } from "./carrotConsent";
import {
  CloudApi,
  getApiBaseUrl,
  type CloudDeviceToken,
  type CloudInstance,
  type CloudUserProfile,
  type CloudWorkspace,
} from "./cloudApi";

const DEBUG_BUNNY_EARS_BOOT = process.env.BUNNY_EARS_BOOT_DEBUG === "1";
const DEBUG_BUNNY_EARS_BRIDGE = process.env.BUNNY_EARS_BRIDGE_DEBUG === "1";
const DEFAULT_DASH_WORKSPACE_ID = "local-workspace";
const CLOUD_WORKSPACE_SHADOW_PREFIX = "__cloud_workspace__:";
const WORKSPACE_CURRENT_LENS_PREFIX = "__workspace-current__:";
const DASH_TRAY_ICON = "views://assets/Dash-tray.png";
const SHOULD_REFRESH_TRACKED_DEV_CARROTS =
  process.env.BUNNY_EARS_REFRESH_TRACKED_DEV_CARROTS === "1";

function bootLog(message: string, details?: unknown) {
  if (!DEBUG_BUNNY_EARS_BOOT) {
    return;
  }
  if (details === undefined) {
    console.log(`[bunny-ears:boot] ${message}`);
    return;
  }
  console.log(`[bunny-ears:boot] ${message}`, details);
}

function summarizeBridgeValue(value: unknown, depth = 0): unknown {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    if (value.length <= 120) {
      return value;
    }
    return `${value.slice(0, 120)}… (${value.length} chars)`;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample:
        depth >= 1
          ? undefined
          : value
              .slice(0, 3)
              .map((entry) => summarizeBridgeValue(entry, depth + 1)),
    };
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const summary: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, 8)) {
      summary[key] =
        depth >= 1 ? typeof entryValue : summarizeBridgeValue(entryValue, depth + 1);
    }
    if (entries.length > 8) {
      summary.__truncatedKeys = entries.length - 8;
    }
    return summary;
  }

  return typeof value;
}

function bridgeLog(message: string, details?: unknown) {
  if (!DEBUG_BUNNY_EARS_BRIDGE) {
    return;
  }
  if (details === undefined) {
    console.log(`[bunny-ears:bridge] ${message}`);
    return;
  }
  console.log(`[bunny-ears:bridge] ${message}`, details);
}

const dashBuiltInShortcuts: Array<{
  accelerator: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}> = [
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

type CarrotStatus = "stopped" | "starting" | "running";

type CarrotRemoteUIInfo = {
  id: string;
  name: string;
  path: string;
};

type CarrotSlateUIInfo = {
  id: string;
  name: string;
  path: string;
};

type CarrotInfo = {
  id: string;
  name: string;
  description: string;
  version: string;
  mode: "window" | "background";
  status: CarrotStatus;
  installStatus: "installed" | "broken";
  devMode: boolean;
  sourceKind: "prototype" | "local" | "artifact";
  sourceLabel: string | null;
  lastBuildError: string | null;
  logTail: string[];
  // Remote UIs declared in the carrot manifest. Used by Farm to render
  // "Open in browser" links pointing through Hop. Empty array for background
  // carrots or carrots that don't expose remote UIs.
  remoteUIs: CarrotRemoteUIInfo[];
  slateUIs: CarrotSlateUIInfo[];
  contributions?: CarrotContributions;
};

type DashHostWindowCache = {
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

type DashLocalWorkspaceSummary = {
  id: string;
  name: string;
  subtitle: string;
  projectsDir: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

type DashHostSummaryCache = {
  version: 1;
  updatedAt: number;
  currentWorkspaceId: string;
  currentLensId: string;
  currentWindow: DashHostWindowCache | null;
  windows: DashHostWindowCache[];
  workspaces: unknown[];
  localWorkspaces: DashLocalWorkspaceSummary[];
  cloudWorkspaces: unknown[];
  knownLocalProjects: unknown[];
  peerDependencies: unknown;
  account: {
    signedIn: boolean;
    email: string;
    name: string;
    userId: string;
    emailVerified: boolean;
    connectedAt?: number;
  };
  currentInstance: unknown;
};

type DashboardState = {
  installRoot: string;
  carrots: CarrotInfo[];
};

type DashboardRPC = {
  bun: RPCSchema<{
    requests: {
      getDashboard: {
        params: {};
        response: DashboardState;
      };
      installCarrotSourceFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      installCarrotArtifactFromDisk: {
        params: {};
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      reinstallCarrot: {
        params: { id: string };
        response: { ok: boolean; id?: string; error?: string; reason?: string };
      };
      uninstallCarrot: {
        params: { id: string };
        response: { ok: boolean; error?: string; reason?: string };
      };
      revealCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      launchCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      stopCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
      openCarrot: {
        params: { id: string };
        response: { ok: boolean };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      dashboardChanged: DashboardState;
    };
  }>;
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
  currentCarrots: Array<{
    id: string;
    name: string;
    description: string;
    version: string;
    mode: string;
    status: string;
    slateUIs?: Array<{ id: string; name: string; path: string }>;
    contributions?: CarrotContributions;
  }>;
};

class CarrotInstance {
  carrot: InstalledCarrot;
  status: CarrotStatus = "stopped";
  logs: string[] = [];
  tray: Tray | null = null;
  applicationMenu: any[] | null = null;
  controllerWindows = new Map<string, BrowserWindow>();
  controllerWindow: BrowserWindow | null = null;
  webClients = new Map<string, { send: (data: string) => void; windowId: string | null }>();
  hopBrowserIds = new Map<string, { windowId: string | null }>();
  bunnyWindow: BrowserWindow | null = null;
  bunnyPollTimeout: ReturnType<typeof setTimeout> | null = null;
  worker: Worker | null = null;
  requestId = 1;
  pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(carrot: InstalledCarrot) {
    this.carrot = carrot;
  }

  get stateDir() {
    return this.carrot.stateDir;
  }

  get statePath() {
    return join(this.stateDir, "state.json");
  }

  get logsPath() {
    return join(this.stateDir, "logs.txt");
  }

  get summary(): CarrotInfo {
    const sourceLabel =
      this.carrot.install.source.kind === "local"
        ? this.carrot.install.source.path
        : this.carrot.install.source.kind === "artifact"
          ? this.carrot.install.source.location
          : this.carrot.install.source.prototypeId;

    const manifestRemoteUIs = this.carrot.manifest.remoteUIs || {};
    const remoteUIs: CarrotRemoteUIInfo[] = Object.entries(manifestRemoteUIs).map(
      ([id, ui]) => ({ id, name: ui.name, path: ui.path }),
    );
    const manifestSlateUIs = this.carrot.manifest.slateUIs || {};
    const slateUIs: CarrotSlateUIInfo[] = Object.entries(manifestSlateUIs).map(
      ([id, ui]) => ({ id, name: ui.name, path: ui.path }),
    );

    return {
      id: this.carrot.manifest.id,
      name: this.carrot.manifest.name,
      description: this.carrot.manifest.description,
      version: this.carrot.manifest.version,
      mode: this.carrot.manifest.mode,
      status: this.status,
      installStatus: this.carrot.install.status,
      devMode: this.carrot.install.devMode === true,
      sourceKind: this.carrot.install.source.kind,
      sourceLabel,
      lastBuildError: this.carrot.install.lastBuildError ?? null,
      logTail: this.logs.slice(-4),
      remoteUIs,
      slateUIs,
      contributions: this.carrot.manifest.contributions,
    };
  }

  activateApplicationMenu() {
    (runtime as any).activateCarrotApplicationMenu(this);
  }

  restoreApplicationMenuIfActive() {
    (runtime as any).restoreApplicationMenuIfOwner(this);
  }

  sendApplicationMenuClicked(payload: unknown) {
    this.sendEvent("application-menu-clicked", payload);
  }

  sendContextMenuClicked(payload: unknown) {
    this.sendEvent("context-menu-clicked", payload);
  }

  private syncPrimaryControllerWindow() {
    this.controllerWindow = this.controllerWindows.values().next().value ?? null;
  }

  private setControllerWindow(windowId: string, win: BrowserWindow) {
    this.controllerWindows.set(windowId, win);
    this.syncPrimaryControllerWindow();
  }

  private removeControllerWindow(windowId: string, win?: BrowserWindow) {
    const existing = this.controllerWindows.get(windowId);
    if (!existing) {
      return;
    }
    if (win && existing !== win) {
      return;
    }
    this.controllerWindows.delete(windowId);
    this.syncPrimaryControllerWindow();
  }

  private getPrimaryControllerWindowId() {
    return this.controllerWindows.keys().next().value ?? "main";
  }

  private async handleControllerWindowClosed(windowId: string, win: BrowserWindow) {
    this.removeControllerWindow(windowId, win);
    this.restoreApplicationMenuIfActive();

    if (!(runtime as any).shutdownInProgress) {
      this.sendEvent("window-closed", { windowId });
    }

    if (this.status === "running" && this.carrot.manifest.mode === "window") {
      if (this.controllerWindows.size === 0) {
        await this.stop();
      }
    }
  }

  async start() {
    if (this.status === "running" || this.status === "starting") {
      if (this.carrot.manifest.mode === "window") {
        this.openWindow().catch(() => {});
      }
      return;
    }

    mkdirSync(this.stateDir, { recursive: true });
    this.status = "starting";
    bootLog("carrot starting", {
      id: this.carrot.manifest.id,
      mode: this.carrot.manifest.mode,
      workerPath: this.carrot.workerPath,
    });
    runtime.notifyDashboardChanged();

    bootLog("creating carrot worker", { id: this.carrot.manifest.id });
    this.worker = new Worker(this.carrot.workerPath, {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<CarrotWorkerMessage>) => {
      void this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.pushLog(`worker error: ${event.message}`);
      bootLog("carrot worker error", {
        id: this.carrot.manifest.id,
        message: event.message,
      });
      void this.stop();
    };

    // Send init context to the worker so it has statePath and app config.
    const channel = await Updater.localInfo.channel().catch(() => "dev");
    this.worker!.postMessage({
      type: "init",
      manifest: this.carrot.manifest,
      context: {
        statePath: this.statePath,
        logsPath: this.logsPath,
        authToken: runtime.authToken || null,
        channel: channel || "dev",
      },
    });

    this.status = "running";
    bootLog("carrot running", { id: this.carrot.manifest.id });
    runtime.notifyDashboardChanged();

  }

  async stop() {
    if (this.status === "stopped") return;

    this.status = "stopped";

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    for (const [, pending] of this.pending) {
      pending.reject(new Error(`${this.carrot.manifest.name} stopped`));
    }
    this.pending.clear();

    if (this.tray) {
      this.tray.remove();
      this.tray = null;
    }

    for (const [windowId, win] of this.controllerWindows) {
      this.removeControllerWindow(windowId, win);
      try {
        win.close();
      } catch {
        // Best effort; window may already be gone.
      }
    }

    this.closeBunnyWindow();
    this.restoreApplicationMenuIfActive();

    this.pushLog("carrot stopped");
    runtime.notifyDashboardChanged();
  }

  async openWindow(
    windowId = this.getPrimaryControllerWindowId(),
    options?: {
      title?: string;
      frame?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
    },
  ) {
    if (this.status !== "running") {
      await this.start();
    }

    const existing = this.controllerWindows.get(windowId);
    if (existing) {
      existing.activate();
      return;
    }

    bootLog("opening carrot window", {
      id: this.carrot.manifest.id,
      windowId,
    });
    this.createControllerWindow(windowId, {
      hidden: false,
      title: options?.title,
      frame: options?.frame,
    });
    this.controllerWindows.get(windowId)?.activate();
  }

  async requestCloseWindow(windowId?: string) {
    const targetWindowId = windowId || this.getPrimaryControllerWindowId();
    const win = this.controllerWindows.get(targetWindowId);
    if (!win) {
      return;
    }
    win.close();
  }

  async closeWindow(windowId = this.getPrimaryControllerWindowId()) {
    const win = this.controllerWindows.get(windowId);
    if (!win) {
      return;
    }
    this.removeControllerWindow(windowId, win);
    try {
      win.close();
    } catch {
      // Window may already be gone.
    }
  }

  async invoke(method: string, params?: unknown, windowId?: string) {
    if (!this.worker) {
      throw new Error(`${this.carrot.manifest.name} is not running`);
    }

    const requestId = this.requestId++;
    const startedAt = Date.now();
    bridgeLog("carrot worker request:start", {
      carrotId: this.carrot.manifest.id,
      requestId,
      method,
      windowId: windowId || "",
      params: summarizeBridgeValue(params),
    });
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    this.worker.postMessage({
      type: "request",
      requestId,
      method,
      params,
      windowId,
    } satisfies CarrotWorkerMessage);

    return promise
      .then((result) => {
        bridgeLog("carrot worker request:ok", {
          carrotId: this.carrot.manifest.id,
          requestId,
          method,
          durationMs: Date.now() - startedAt,
          result: summarizeBridgeValue(result),
        });
        return result;
      })
      .catch((error) => {
        bridgeLog("carrot worker request:error", {
          carrotId: this.carrot.manifest.id,
          requestId,
          method,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }

  sendEvent(name: string, payload?: unknown) {
    this.worker?.postMessage({
      type: "event",
      name,
      payload,
    } satisfies CarrotWorkerMessage);
  }

  pushLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push(`${timestamp} ${message}`);
    if (this.logs.length > 24) {
      this.logs.splice(0, this.logs.length - 24);
    }
    console.log(`[carrot:${this.carrot.manifest.id}] ${message}`);
    runtime.notifyDashboardChanged();
  }

  emitViewMessage(
    name: string,
    payload?: unknown,
    options?: {
      raw?: boolean;
      windowId?: string;
    },
  ) {
    const targets = options?.windowId
      ? [this.controllerWindows.get(options.windowId)].filter(Boolean)
      : Array.from(this.controllerWindows.values());

    if (options?.raw) {
      for (const target of targets) {
        (target?.webview.rpc as any)?.send?.[name]?.(payload);
      }
    } else {
      for (const target of targets) {
        (target?.webview.rpc as any)?.send?.runtimeEvent({ name, payload });
      }
    }

    for (const client of this.webClients.values()) {
      if (options?.windowId && client.windowId !== options.windowId) {
        continue;
      }
      try {
        client.send(JSON.stringify({
          type: "message",
          name,
          payload,
        }));
      } catch {}
    }

    if (runtime.hopWs && this.hopBrowserIds.size > 0) {
      for (const [browserId, browserState] of this.hopBrowserIds.entries()) {
        if (options?.windowId && browserState.windowId !== options.windowId) {
          continue;
        }
        try {
          runtime.hopWs.send(JSON.stringify({
            browserId,
            payload: {
              type: "message",
              id: name,
              payload,
            },
          }));
        } catch (err) {
          console.warn(
            "[hop] Failed to forward view message:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  setWebClientWindowId(clientId: string, windowId?: string | null) {
    const client = this.webClients.get(clientId);
    if (!client) {
      return;
    }
    client.windowId = typeof windowId === "string" && windowId ? windowId : null;
  }

  setHopBrowserWindowId(browserId: string, windowId?: string | null) {
    const current = this.hopBrowserIds.get(browserId);
    this.hopBrowserIds.set(browserId, {
      windowId:
        typeof windowId === "string" && windowId
          ? windowId
          : current?.windowId ?? null,
    });
  }

  private createControllerWindow(
    windowId = "main",
    options?: {
      hidden?: boolean;
      title?: string;
      url?: string | null;
      frame?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
      titleBarStyle?: "hidden" | "hiddenInset" | "default";
      transparent?: boolean;
      passthrough?: boolean;
    },
  ) {
    const existing = this.controllerWindows.get(windowId);
    if (existing) {
      return existing;
    }

    const rpc = BrowserView.defineRPC<CarrotViewRPC>({
      maxRequestTime: 10000,
      handlers: {
        requests: {
          invoke: async ({ method, params }) => this.invoke(method, params, windowId),
          invokeCarrot: async (payload) =>
            (runtime as any).invokeCarrotFrom(
              this.carrot.manifest.id,
              String(payload?.carrotId || ""),
              String(payload?.method || ""),
              payload?.params,
              typeof payload?.windowId === "string" ? payload.windowId : windowId,
            ),
          _: async (method, params) => this.invoke(String(method), params, windowId),
        },
        messages: {
          "*": (messageName, payload) => {
            this.invoke(`send:${String(messageName)}`, payload, windowId).catch((error) => {
              this.pushLog(
                `view message failed: ${String(messageName)} ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          },
        },
      },
    });

    const hidden =
      options?.hidden ??
      (this.carrot.manifest.mode === "background" ||
        this.carrot.manifest.view.hidden === true);
    const frame = {
      width: options?.frame?.width ?? this.carrot.manifest.view.width,
      height: options?.frame?.height ?? this.carrot.manifest.view.height,
      x: options?.frame?.x ?? 120,
      y: options?.frame?.y ?? 120,
    };
    const url =
      typeof options?.url === "string" && options.url.length > 0
        ? options.url
        : this.carrot.viewUrl;

    const win = new BrowserWindow({
      title: options?.title || this.carrot.manifest.view.title,
      url,
      viewsRoot: this.carrot.currentDir,
      rpc,
      titleBarStyle: options?.titleBarStyle ?? this.carrot.manifest.view.titleBarStyle ?? "default",
      transparent: options?.transparent ?? this.carrot.manifest.view.transparent ?? false,
      passthrough: options?.passthrough ?? false,
      hidden,
      frame,
    });

    this.setControllerWindow(windowId, win);
    bootLog("controller window created", {
      id: this.carrot.manifest.id,
      windowId,
      hidden,
      url: this.carrot.viewUrl,
    });

    win.webview.on("dom-ready", () => {
      bootLog("controller dom-ready", { id: this.carrot.manifest.id });
      (win.webview.rpc as any)?.send?.carrotBoot({
        id: this.carrot.manifest.id,
        name: this.carrot.manifest.name,
        mode: this.carrot.manifest.mode,
      });
    });

    win.on("focus", () => {
      this.activateApplicationMenu();
      this.sendEvent("window-focus", { windowId });
    });

    win.on("move", (event: any) => {
      this.sendEvent("window-move", {
        windowId,
        x: event?.data?.x,
        y: event?.data?.y,
      });
    });

    win.on("resize", (event: any) => {
      this.sendEvent("window-resize", {
        windowId,
        x: event?.data?.x,
        y: event?.data?.y,
        width: event?.data?.width,
        height: event?.data?.height,
      });
    });

    win.on("close", () => {
      void this.handleControllerWindowClosed(windowId, win);
    });

    return win;
  }

  private async handleWorkerMessage(message: CarrotWorkerMessage) {
    switch (message.type) {
      case "ready": {
        this.pushLog("worker ready");
        // Tell connected web clients to refresh their frontend-owned state.
        // This handles the case where the carrot was restarted while web
        // clients were still connected and need to re-bootstrap from the
        // current host/window context.
        for (const client of this.webClients.values()) {
          try {
            client.send(JSON.stringify({
              type: "message",
              name: "refreshBunnyDashState",
              payload: {},
            }));
          } catch {}
        }
        break;
      }
      case "response": {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          bridgeLog("carrot worker response:orphan", {
            carrotId: this.carrot.manifest.id,
            requestId: message.requestId,
            success: Boolean(message.success),
          });
          break;
        }
        this.pending.delete(message.requestId);
        bridgeLog("carrot worker response", {
          carrotId: this.carrot.manifest.id,
          requestId: message.requestId,
          success: Boolean(message.success),
          error: message.success ? undefined : message.error || "Unknown worker error",
        });
        if (message.success) {
          pending.resolve(message.payload);
        } else {
          pending.reject(new Error(message.error || "Unknown worker error"));
        }
        break;
      }
      case "action": {
        await this.handleHostAction(message.action, message.payload);
        break;
      }
      case "host-request": {
        const startedAt = Date.now();
        bridgeLog("carrot host request:start", {
          carrotId: this.carrot.manifest.id,
          requestId: message.requestId,
          method: message.method,
          params: summarizeBridgeValue(message.params),
        });
        const response = await this.handleHostRequest(message.method, message.params)
          .then((payload) => {
            bridgeLog("carrot host request:ok", {
              carrotId: this.carrot.manifest.id,
              requestId: message.requestId,
              method: message.method,
              durationMs: Date.now() - startedAt,
              result: summarizeBridgeValue(payload),
            });
            return {
              type: "host-response" as const,
              requestId: message.requestId,
              success: true,
              payload,
            };
          })
          .catch((error: unknown) => {
            bridgeLog("carrot host request:error", {
              carrotId: this.carrot.manifest.id,
              requestId: message.requestId,
              method: message.method,
              durationMs: Date.now() - startedAt,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              type: "host-response" as const,
              requestId: message.requestId,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          });
        this.worker?.postMessage(response);
        break;
      }
      default:
        break;
    }
  }

  private async handleHostRequest(method: string, params: unknown) {
    switch (method) {
      case "open-file-dialog": {
        const options = (params || {}) as {
          startingFolder?: string;
          allowedFileTypes?: string;
          canChooseFiles?: boolean;
          canChooseDirectory?: boolean;
          allowsMultipleSelection?: boolean;
        };
        return Utils.openFileDialog({
          startingFolder: options.startingFolder,
          allowedFileTypes: options.allowedFileTypes,
          canChooseFiles: options.canChooseFiles,
          canChooseDirectory: options.canChooseDirectory,
          allowsMultipleSelection: options.allowsMultipleSelection,
        });
      }
      case "open-path": {
        return Utils.openPath(String((params as { path?: string } | undefined)?.path || ""));
      }
      case "show-item-in-folder": {
        Utils.showItemInFolder(String((params as { path?: string } | undefined)?.path || ""));
        return true;
      }
      case "clipboard-write-text": {
        Utils.clipboardWriteText(String((params as { text?: string } | undefined)?.text || ""));
        return true;
      }
      case "window-get-frame": {
        const requestedWindowId = String((params as { windowId?: string } | undefined)?.windowId || "");
        const targetWindowId = requestedWindowId || this.getPrimaryControllerWindowId();
        const win = this.controllerWindows.get(targetWindowId);
        if (!win) {
          return null;
        }
        return win.getFrame();
      }
      case "invoke-carrot": {
        const invokePayload =
          params && typeof params === "object"
            ? (params as {
                carrotId?: string;
                method?: string;
                params?: unknown;
                windowId?: string;
              })
            : {};
        return (runtime as any).invokeCarrotFrom(
          this.carrot.manifest.id,
          String(invokePayload.carrotId || ""),
          String(invokePayload.method || ""),
          invokePayload.params,
          typeof invokePayload.windowId === "string" ? invokePayload.windowId : undefined,
        );
      }
      case "screen-get-primary-display": {
        return Screen.getPrimaryDisplay();
      }
      case "screen-get-cursor-screen-point": {
        return Screen.getCursorScreenPoint();
      }
      case "update-carrots": {
        void (runtime as any).handleTrayAction("update-carrots");
        return { ok: true };
      }
      case "get-auth-token": {
        return { token: runtime.authToken || null };
      }
      case "set-auth-token": {
        const token = String((params as any)?.token || "");
        if (token) {
          (runtime as any).saveAuthToken(token);
          (runtime as any).registerInstanceWithToken(token).catch(() => {});
          (runtime as any).broadcastDashAuthTokenChanged(token);
        } else {
          (runtime as any).signOutFromCloud();
        }
        return { ok: true };
      }
      case "set-device-token": {
        const token = String((params as any)?.token || "");
        const tokenId = typeof (params as any)?.tokenId === "string" ? (params as any).tokenId : undefined;
        if (!token) {
          throw new Error("Missing device token");
        }
        (runtime as any).saveDeviceToken(token, tokenId);
        try { runtime.hopWs?.close(); } catch {}
        runtime.hopWs = null;
        (runtime as any).connectToHop();
        (runtime as any).refreshAccessTokenFromDevice().catch(() => {});
        return { ok: true };
      }
      case "get-machine-info": {
        const os = require("node:os");
        return {
          machineId: runtime.getMachineId(),
          hostname: os.hostname() || "",
          platform: process.platform === "darwin" ? "macos" : process.platform,
        };
      }
      case "list-carrots": {
        return runtime.summaries();
      }
      case "start-carrot": {
        const id = String((params as any)?.id || "");
        const carrot = runtime.carrots.get(id);
        if (!carrot) throw new Error(`Carrot not found: ${id}`);
        await carrot.start();
        if (carrot.carrot.manifest.mode === "background") {
          carrot.sendEvent("boot");
        }
        return { ok: true };
      }
      case "stop-carrot": {
        const id = String((params as any)?.id || "");
        const carrot = runtime.carrots.get(id);
        if (!carrot) throw new Error(`Carrot not found: ${id}`);
        await carrot.stop();
        return { ok: true };
      }
      default:
        throw new Error(`Unknown host request: ${method}`);
    }
  }

  private async handleHostAction(action: string, payload: unknown) {
    switch (action) {
      case "notify": {
        const notification = payload as { title: string; body?: string };
        Utils.showNotification({ title: notification.title, body: notification.body });
        this.pushLog(`notification: ${notification.title}`);
        break;
      }
      case "set-tray": {
        const trayPayload = payload as { title?: string };
        if (!this.tray) {
          this.tray = new Tray({ title: trayPayload.title || this.carrot.manifest.name });
          this.tray.on("tray-clicked", (event: any) => {
            const actionName = event.data?.action || "click";
            this.sendEvent("tray", { action: actionName, raw: event.data });
          });
        }
        if (trayPayload.title) {
          this.tray.setTitle(trayPayload.title);
        }
        break;
      }
      case "set-tray-menu": {
        if (this.tray) {
          this.tray.setMenu(payload as any);
        }
        break;
      }
      case "window-create": {
        const createPayload =
          payload && typeof payload === "object"
            ? (payload as {
                windowId?: string;
                options?: {
                  hidden?: boolean;
                  title?: string;
                  url?: string | null;
                  frame?: {
                    x?: number;
                    y?: number;
                    width?: number;
                    height?: number;
                  };
                  titleBarStyle?: "hidden" | "hiddenInset" | "default";
                  transparent?: boolean;
                  passthrough?: boolean;
                };
              })
            : {};
        const windowId = createPayload.windowId || this.getPrimaryControllerWindowId();
        this.createControllerWindow(windowId, createPayload.options);
        break;
      }
      case "window-set-title": {
        const titlePayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; title?: string })
            : {};
        const win = this.controllerWindows.get(titlePayload.windowId || this.getPrimaryControllerWindowId());
        if (win && typeof titlePayload.title === "string") {
          win.setTitle(titlePayload.title);
        }
        break;
      }
      case "window-set-frame": {
        const framePayload =
          payload && typeof payload === "object"
            ? (payload as {
                windowId?: string;
                frame?: {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                };
              })
            : {};
        const win = this.controllerWindows.get(framePayload.windowId || this.getPrimaryControllerWindowId());
        const frame = framePayload.frame;
        if (win && frame) {
          const nextFrame = {
            x: frame.x ?? win.frame.x,
            y: frame.y ?? win.frame.y,
            width: frame.width ?? win.frame.width,
            height: frame.height ?? win.frame.height,
          };
          win.setFrame(nextFrame.x, nextFrame.y, nextFrame.width, nextFrame.height);
        }
        break;
      }
      case "window-set-always-on-top": {
        const alwaysOnTopPayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; alwaysOnTop?: boolean })
            : {};
        const win = this.controllerWindows.get(
          alwaysOnTopPayload.windowId || this.getPrimaryControllerWindowId(),
        );
        if (win) {
          win.setAlwaysOnTop(Boolean(alwaysOnTopPayload.alwaysOnTop));
        }
        break;
      }
      case "show-context-menu": {
        const menuPayload =
          payload && typeof payload === "object"
            ? (payload as { menu?: any[] })
            : {};
        if (Array.isArray(menuPayload.menu) && menuPayload.menu.length > 0) {
          (runtime as any).activeContextMenuOwnerId = this.carrot.manifest.id;
          HostContextMenu.showContextMenu(menuPayload.menu);
        }
        break;
      }
      case "set-application-menu": {
        const menuPayload =
          payload && typeof payload === "object"
            ? (payload as { menu?: any[] })
            : {};
        this.applicationMenu = Array.isArray(menuPayload.menu) ? menuPayload.menu : null;
        if ((runtime as any).activeApplicationMenuOwnerId === this.carrot.manifest.id) {
          this.activateApplicationMenu();
        }
        break;
      }
      case "clear-application-menu": {
        this.applicationMenu = null;
        this.restoreApplicationMenuIfActive();
        break;
      }
      case "focus-window": {
        const focusPayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string; title?: string })
            : {};
        await this.openWindow(focusPayload.windowId, { title: focusPayload.title });
        break;
      }
      case "close-window": {
        const closePayload =
          payload && typeof payload === "object"
            ? (payload as { windowId?: string })
            : {};
        await this.closeWindow(closePayload.windowId);
        break;
      }
      case "open-bunny-window": {
        await this.toggleBunnyWindow(payload as { screenX?: number; screenY?: number } | undefined);
        break;
      }
      case "open-manager":
      case "open-farm": {
        void (runtime as any).handleTrayAction("open-farm");
        break;
      }
      case "remove-tray": {
        this.tray?.remove();
        this.tray = null;
        break;
      }
      case "stop-carrot": {
        this.pushLog("stop requested by carrot");
        await this.stop();
        break;
      }
      case "emit-view": {
        const eventPayload = payload as {
          name: string;
          payload?: unknown;
          raw?: boolean;
          windowId?: string;
        };
        this.emitViewMessage(eventPayload.name, eventPayload.payload, {
          raw: Boolean(eventPayload.raw),
          windowId: eventPayload.windowId,
        });
        break;
      }
      case "emit-carrot-view-event": {
        const eventPayload =
          payload && typeof payload === "object"
            ? (payload as {
                carrotId?: string;
                name?: string;
                payload?: unknown;
                raw?: boolean;
                windowId?: string | null;
              })
            : {};
        bridgeLog("carrot action emit-carrot-view-event", {
          sourceCarrotId: this.carrot.manifest.id,
          targetCarrotId: String(eventPayload.carrotId || ""),
          name: String(eventPayload.name || ""),
          windowId:
            typeof eventPayload.windowId === "string" ? eventPayload.windowId : "",
          payload: summarizeBridgeValue(eventPayload.payload),
        });
        (runtime as any).emitCarrotViewEventFrom(
          this.carrot.manifest.id,
          String(eventPayload.carrotId || ""),
          String(eventPayload.name || ""),
          eventPayload.payload,
          {
            raw: Boolean(eventPayload.raw),
            windowId:
              typeof eventPayload.windowId === "string" ? eventPayload.windowId : undefined,
          },
        );
        break;
      }
      case "emit-carrot-event": {
        const eventPayload =
          payload && typeof payload === "object"
            ? (payload as {
                carrotId?: string;
                name?: string;
                payload?: unknown;
              })
            : {};
        (runtime as any).emitCarrotEventFrom(
          this.carrot.manifest.id,
          String(eventPayload.carrotId || ""),
          String(eventPayload.name || ""),
          eventPayload.payload,
        );
        break;
      }
      case "log": {
        const logPayload = payload as { message: string };
        this.pushLog(logPayload.message);
        break;
      }
      default:
        break;
    }
  }

  private closeBunnyWindow() {
    if (this.bunnyPollTimeout) {
      clearTimeout(this.bunnyPollTimeout);
      this.bunnyPollTimeout = null;
    }

    if (this.bunnyWindow) {
      const win = this.bunnyWindow;
      this.bunnyWindow = null;
      try {
        win.close();
      } catch {}
    }
  }

  private async toggleBunnyWindow(payload?: { screenX?: number; screenY?: number }) {
    if (this.bunnyWindow) {
      this.closeBunnyWindow();
      return;
    }

    const size = 80 + Math.floor(Math.random() * 90);
    const halfSize = Math.floor(size / 2);
    const display = Screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const x =
      typeof payload?.screenX === "number"
        ? payload.screenX - halfSize
        : workArea.x + Math.floor(Math.random() * Math.max(1, workArea.width - size));
    const y =
      typeof payload?.screenY === "number"
        ? payload.screenY - halfSize
        : workArea.y + Math.floor(Math.random() * Math.max(1, workArea.height - size));

    const bunnyRpc = BrowserView.defineRPC<any>({
      maxRequestTime: 5000,
      handlers: {
        requests: {},
        messages: {
          bunnyClicked: () => {
            this.closeBunnyWindow();
          },
        },
      },
    });

    const win = new BrowserWindow({
      title: `${this.carrot.manifest.name} Bunny`,
      url: "views://bunny/index.html",
      viewsRoot: this.carrot.currentDir,
      rpc: bunnyRpc,
      titleBarStyle: "hidden",
      transparent: true,
      passthrough: false,
      frame: { width: size, height: size, x, y },
    });

    win.setAlwaysOnTop(true);
    this.bunnyWindow = win;

    const sendCursor = () => {
      if (!this.bunnyWindow) {
        return;
      }
      const cursor = Screen.getCursorScreenPoint();
      const frame = this.bunnyWindow.getFrame();
      (this.bunnyWindow.webview.rpc as any)?.send?.cursorMove({
        screenX: cursor.x,
        screenY: cursor.y,
        winX: frame.x,
        winY: frame.y,
        winW: frame.width,
        winH: frame.height,
      });
    };

    const pollCursor = () => {
      this.bunnyPollTimeout = null;
      if (!this.bunnyWindow) {
        return;
      }
      try {
        sendCursor();
      } catch {}
      this.bunnyPollTimeout = setTimeout(pollCursor, 100);
    };

    win.webview.on("dom-ready", () => {
      try {
        sendCursor();
      } catch {}
      if (!this.bunnyPollTimeout) {
        this.bunnyPollTimeout = setTimeout(pollCursor, 100);
      }
    });

    win.on("close", () => {
      if (this.bunnyWindow === win) {
        this.closeBunnyWindow();
      }
    });
  }
}

class BunnyEarsRuntime {
  tray: Tray | null;
  managerWindow: BrowserWindow | null = null;
  hopWs: WebSocket | null = null;
  channel: string = "dev";
  carrots = new Map<string, CarrotInstance>();
  activeApplicationMenuOwnerId: string | null = null;
  activeContextMenuOwnerId: string | null = null;
  shutdownInProgress = false;
  updateStatus: "idle" | "checking" | "downloading" | "update-ready" | "error" = "idle";

  constructor() {
    for (const carrot of loadInstalledCarrots()) {
      this.carrots.set(carrot.manifest.id, new CarrotInstance(carrot));
    }

    // Bunny Ears owns the system tray.
    this.tray = new Tray({
      title: "Dash",
      image: DASH_TRAY_ICON,
      template: false,
      width: 18,
      height: 18,
    });
    this.tray.setMenu(this.buildTrayMenu());
    this.tray.on("tray-clicked", (event: any) => {
      const action = event.data?.action;
      if (!action) return;
      void this.handleTrayAction(action);
    });

    ApplicationMenu.on("application-menu-clicked", (event: any) => {
      const action = event?.data?.action;
      if (action === "quit") {
        void this.shutdown(0);
        return;
      }

      if (!action) {
        return;
      }

      if (
        !this.activeApplicationMenuOwnerId ||
        this.activeApplicationMenuOwnerId === "dash-ui"
      ) {
        void this.handleDashApplicationMenuAction(action);
        return;
      }

      const carrot = this.carrots.get(this.activeApplicationMenuOwnerId);
      if (!carrot) {
        return;
      }
      carrot.sendApplicationMenuClicked(event?.data ?? event);
    });

    HostContextMenu.on("context-menu-clicked", (event: any) => {
      const ownerId = this.activeContextMenuOwnerId;
      this.activeContextMenuOwnerId = null;
      if (!ownerId) {
        return;
      }

      const carrot = this.carrots.get(ownerId);
      if (!carrot) {
        return;
      }
      carrot.sendContextMenuClicked(event?.data ?? event);
    });

    this.restoreDefaultApplicationMenu();
  }

  authToken: string | null = null;
  // Long-lived device token — used to authenticate to Hop and mint access tokens.
  deviceToken: string | null = null;
  // ID of the device token (from the API) — used for server-side revocation.
  deviceTokenId: string | null = null;
  // Bunny Cloud API record for this machine. Runtime/Hop routing still uses
  // the generated machineId; this record id is only for Cloud API operations.
  instance: CloudInstance | null = null;
  farmWindow: BrowserWindow | null = null;
  dashWindows = new Map<string, BrowserWindow>();
  dashHopBrowserIds = new Map<string, { windowId: string | null }>();

  private getDashWindow(windowId?: string | null) {
    if (windowId && this.dashWindows.has(windowId)) {
      return this.dashWindows.get(windowId) || null;
    }
    return this.dashWindows.values().next().value ?? null;
  }

  private getPrimaryDashWindowId() {
    return this.dashWindows.keys().next().value ?? "main";
  }

  private createDashLocalBridgeRpc(windowId: string) {
    return BrowserView.defineRPC({
      maxRequestTime: 10000,
      handlers: {
        requests: {
          dashLocalBridge: async (payload: unknown) =>
            this.handleLocalDashBridgePayload(windowId, payload),
        },
        messages: {},
      },
    });
  }

  private setDashWindow(windowId: string, win: BrowserWindow) {
    this.dashWindows.set(windowId, win);
    win.on("focus", () => {
      this.activeApplicationMenuOwnerId = "dash-ui";
      this.restoreDefaultApplicationMenu();
    });
    win.on("close", () => {
      this.dashWindows.delete(windowId);
      this.removeDashHostCacheWindow(windowId);
      if (this.activeApplicationMenuOwnerId === "dash-ui" && this.dashWindows.size === 0) {
        this.activeApplicationMenuOwnerId = null;
        this.restoreDefaultApplicationMenu();
      }
    });
  }

  private async openDashWindow(
    windowId = this.getPreferredDashWindowId(),
    options?: {
      title?: string;
      frame?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
    },
  ) {
    const existing = this.dashWindows.get(windowId);
    if (existing) {
      existing.activate();
      return existing;
    }

    const url = await this.getDashUiUrl(windowId);
    if (!url) {
      throw new Error("Dash UI URL is unavailable");
    }

    const win = new BrowserWindow({
      id: `dash-ui:${windowId}`,
      title: options?.title || "Dash",
      url,
      rpc: this.createDashLocalBridgeRpc(windowId),
      titleBarStyle: "hidden",
      transparent: true,
      frame: {
        width: options?.frame?.width ?? 1440,
        height: options?.frame?.height ?? 900,
        x: options?.frame?.x ?? 120,
        y: options?.frame?.y ?? 120,
      },
    });
    this.setDashWindow(windowId, win);
    this.activeApplicationMenuOwnerId = "dash-ui";
    this.restoreDefaultApplicationMenu();
    win.activate();
    return win;
  }

  private async requestCloseDashWindow(windowId?: string) {
    const targetWindowId = windowId || this.getPrimaryDashWindowId();
    const win = this.dashWindows.get(targetWindowId);
    if (!win) {
      return;
    }
    win.close();
  }

  private emitDashViewMessage(
    name: string,
    payload?: unknown,
    options?: {
      raw?: boolean;
      windowId?: string;
    },
  ) {
    const localDashTargets = options?.windowId
      ? [this.dashWindows.get(options.windowId)].filter(Boolean)
      : Array.from(this.dashWindows.values());
    bridgeLog("dash view emit", {
      name,
      windowId: options?.windowId || "",
      raw: Boolean(options?.raw),
      localTargets: localDashTargets.length,
      hopTargets: options?.windowId
        ? Array.from(this.dashHopBrowserIds.values()).filter((browserState) => browserState.windowId === options.windowId).length
        : this.dashHopBrowserIds.size,
      payload: summarizeBridgeValue(payload),
    });

    if (localDashTargets.length > 0) {
      for (const target of localDashTargets) {
        try {
          if (options?.raw) {
            (target?.webview.rpc as any)?.send?.[name]?.(payload);
          } else {
            (target?.webview.rpc as any)?.send?.runtimeEvent({ name, payload });
          }
        } catch (err) {
          console.warn(
            "[dash-bridge] Failed to emit local Dash message:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      return;
    }

    if (this.hopWs && this.dashHopBrowserIds.size > 0) {
      for (const [browserId, browserState] of this.dashHopBrowserIds.entries()) {
        if (options?.windowId && browserState.windowId !== options.windowId) {
          continue;
        }
        try {
          this.hopWs.send(JSON.stringify({
            browserId,
            payload: {
              type: "message",
              id: name,
              payload,
            },
          }));
        } catch (err) {
          console.warn(
            "[hop] Failed to forward Dash UI view message:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  private setDashHopBrowserWindowId(browserId: string, windowId?: string | null) {
    const current = this.dashHopBrowserIds.get(browserId);
    this.dashHopBrowserIds.set(browserId, {
      windowId:
        typeof windowId === "string" && windowId
          ? windowId
          : current?.windowId ?? null,
    });
  }

  async boot() {
    this.channel = await Updater.localInfo.channel().catch(() => "dev");
    bootLog("runtime boot begin", {
      channel: this.channel,
      installRoot: getInstalledCarrotsRoot(),
      carrotIds: Array.from(this.carrots.keys()),
    });

    // Start all background carrots — always, regardless of auth
    for (const carrot of this.carrots.values()) {
      if (carrot.carrot.manifest.mode === "background") {
        bootLog("booting background carrot", {
          id: carrot.carrot.manifest.id,
        });
        await carrot.start();
        carrot.sendEvent("boot");
        bootLog("background carrot boot event sent", {
          id: carrot.carrot.manifest.id,
        });
      }
    }

    // Auth + instance registration — non-blocking, doesn't gate carrots
    this.loadAuthToken();
    this.loadDeviceToken();

    // If we have a device token, refresh the access token immediately
    if (this.deviceToken) {
      this.refreshAccessTokenFromDevice().catch(() => {});
      // Refresh access token every 10 minutes (access tokens live 15 min)
      setInterval(() => {
        this.refreshAccessTokenFromDevice().catch(() => {});
      }, 10 * 60 * 1000);
    }

    if (this.authToken) {
      // Register instance and start heartbeat in the background
      this.registerInstanceWithToken(this.authToken).catch(() => {});
      setInterval(() => {
        if (this.authToken) {
          this.registerInstanceWithToken(this.authToken).catch(() => {});
        }
      }, 60_000);
    } else if (!this.deviceToken) {
      // Local mode should work without an account. Farm remains available as an
      // explicit sign-in path from Dash/tray, but first-run boot should land in
      // the local IDE flow instead of forcing auth.
      console.log("[bunny-ears] no Bunny Cloud session found; continuing in local-only mode");
    }

    // Check for updates on boot and every hour
    this.checkForUpdates();
    setInterval(() => this.checkForUpdates(), 60 * 60 * 1000);

    // Connect to Hop for remote access (uses device token)
    if (this.deviceToken) {
      this.connectToHop();
    }

    // Wake detection: when ears runs inside a VM that gets frozen (common with
    // cloud/local VMs when not active), setInterval timers pause. When the VM
    // resumes, we detect the resulting large clock gap and force a full
    // re-sync: refresh the access token, re-register the instance, and
    // reconnect to Hop (its WebSocket is almost certainly stale).
    this.startWakeDetector();

    // Periodic Hop keepalive: detect silently-dead WebSockets that didn't
    // fire a close event (can happen with network/sleep transitions).
    this.startHopKeepalive();

    const dashSnapshotInfo = this.getDashOpenWindowsSnapshotInfo();
    console.log(
      `[bunny-ears] Dash boot restore check: path=${dashSnapshotInfo.path || "missing"} windows=${dashSnapshotInfo.windowCount}`,
    );
    if (dashSnapshotInfo.windowCount > 0) {
      await this.handleTrayAction("open-dash");
    }

    bootLog("runtime boot complete");
  }

  async shutdown(exitCode = 0) {
    if (this.shutdownInProgress) {
      return;
    }
    this.shutdownInProgress = true;

    try {
      for (const carrot of this.carrots.values()) {
        if (carrot.status !== "running") {
          continue;
        }
        try {
          await carrot.stop();
        } catch (error) {
          console.error(
            `[bunny-ears] Failed to stop ${carrot.carrot.manifest.id} during shutdown:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } finally {
      try {
        this.tray?.remove();
      } catch {
        // Best effort cleanup.
      }
      process.exit(exitCode);
    }
  }

  private getDashOpenWindowsSnapshotInfo() {
    const cachePath = this.getDashHostCachePath();
    const cache = this.loadDashHostCache();
    const cachedWindows = Array.isArray(cache?.windows) ? cache.windows.length : 0;
    return {
      path: existsSync(cachePath) ? cachePath : null,
      windowCount: cachedWindows,
    };
  }

  private lastWakeCheckAt = Date.now();
  private startWakeDetector() {
    // Fire every 30 seconds. If >2 minutes elapsed since the last tick, the
    // process was likely suspended (VM freeze, laptop sleep, etc.) — treat it
    // as a wake event.
    const INTERVAL_MS = 30_000;
    const WAKE_THRESHOLD_MS = 2 * 60_000;
    setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastWakeCheckAt;
      this.lastWakeCheckAt = now;
      if (gap > WAKE_THRESHOLD_MS) {
        console.log(`[bunny-ears] wake detected (gap=${Math.round(gap / 1000)}s) — resyncing`);
        this.handleWake().catch(() => {});
      }
    }, INTERVAL_MS);
  }

  // Called when we detect the process was suspended and has resumed.
  // Re-authenticates with the API and re-establishes all long-lived
  // connections so the user doesn't need to manually intervene.
  private async handleWake() {
    // 1. Refresh the access token from the device token. If the refresh
    //    succeeds, the new token is automatically saved and broadcast to
    //    running carrots via auth-token-changed.
    if (this.deviceToken) {
      await this.refreshAccessTokenFromDevice().catch(() => {});
    }

    // 2. Re-register the instance so it shows online in Farm again.
    if (this.authToken) {
      this.registerInstanceWithToken(this.authToken).catch(() => {});
    }

    // 3. Force-reconnect the Hop WebSocket. The old socket is very likely
    //    stale (TCP timeout during the freeze) but may not have fired close.
    try { this.hopWs?.close(); } catch {}
    this.hopWs = null;
    if (this.deviceToken) {
      this.connectToHop();
    }
  }

  private startHopKeepalive() {
    // Every 60 seconds, send a lightweight ping message through the Hop
    // WebSocket. Hop's DO silently drops unknown messages so this is safe.
    // If `.send()` throws or the socket isn't open, close + let the existing
    // reconnect logic handle it.
    setInterval(() => {
      const ws = this.hopWs;
      if (!ws) return;
      if (ws.readyState !== 1 /* OPEN */) {
        try { ws.close(); } catch {}
        this.hopWs = null;
        return;
      }
      try {
        ws.send(JSON.stringify({ type: "hop:keepalive", ts: Date.now() }));
      } catch {
        try { ws.close(); } catch {}
        this.hopWs = null;
      }
    }, 60_000);
  }

  private async checkForUpdates() {
    if (this.updateStatus === "checking" || this.updateStatus === "downloading") return;

    try {
      this.updateStatus = "checking";
      const updateInfo = await Updater.checkForUpdate();

      if (updateInfo.error) {
        console.log(`[bunny-ears] Update check error: ${updateInfo.error}`);
        this.updateStatus = "error";
        return;
      }

      if (updateInfo.updateAvailable) {
        console.log(`[bunny-ears] Update available: ${updateInfo.version}`);
        this.updateStatus = "downloading";
        this.tray?.setMenu(this.buildTrayMenu());

        await Updater.downloadUpdate();

        if (Updater.updateInfo().updateReady) {
          console.log("[bunny-ears] Update ready to install");
          this.updateStatus = "update-ready";
          this.tray?.setMenu(this.buildTrayMenu());

          // Show system notification
          Utils.showNotification({
            title: "Bunny Ears Update Available",
            body: `Version ${updateInfo.version} is ready. Restart to update.`,
          });
        } else {
          this.updateStatus = "error";
        }
      } else {
        this.updateStatus = "idle";
      }
    } catch (err) {
      console.log(`[bunny-ears] Update check failed: ${err instanceof Error ? err.message : err}`);
      this.updateStatus = "idle";
    }

    this.tray?.setMenu(this.buildTrayMenu());
  }

  private connectToHop() {
    if (isHopDisabled()) {
      console.log("[hop] Disabled by BUNNY_DISABLE_HOP");
      return;
    }

    const hopBaseUrl = this.getHopWsBaseUrl();

    const machineId = this.getMachineId();
    if (!machineId || !this.deviceToken) {
      console.log("[hop] Skipping Hop connection (no machine ID or device token)");
      return;
    }

    const url = `${hopBaseUrl}/connect?instanceId=${encodeURIComponent(machineId)}&deviceToken=${encodeURIComponent(this.deviceToken)}`;
    console.log(`[hop] Connecting to Hop at ${hopBaseUrl}...`);

    try {
      const ws = new WebSocket(url);

      ws.addEventListener("open", () => {
        console.log("[hop] Connected to Hop");
        this.hopWs = ws;
      });

      ws.addEventListener("message", (event) => {
        void this.handleHopMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        console.log(`[hop] Disconnected from Hop: ${event.code} ${event.reason}`);
        this.hopWs = null;
        // Reconnect after 10 seconds
        setTimeout(() => {
          if (this.deviceToken) this.connectToHop();
        }, 10_000);
      });

      ws.addEventListener("error", (event) => {
        console.error("[hop] Connection error");
      });
    } catch (err) {
      console.error("[hop] Failed to connect:", err instanceof Error ? err.message : err);
      // Retry after 10 seconds
      setTimeout(() => {
        if (this.authToken) this.connectToHop();
      }, 10_000);
    }
  }

  private async handleHopMessage(data: string) {
    try {
      const message = JSON.parse(data);

      if (message.type === "hop:browser-connected") {
        console.log(`[hop] Browser connected: ${message.browserId} for ${message.carrotId}`);
        if (message.carrotId === "dash-ui") {
          this.dashHopBrowserIds.set(message.browserId, { windowId: null });
        } else {
          const carrot = this.carrots.get(message.carrotId);
          if (carrot) {
            carrot.hopBrowserIds.set(message.browserId, { windowId: null });
          }
        }
        return;
      }

      if (message.type === "hop:browser-disconnected") {
        console.log(`[hop] Browser disconnected: ${message.browserId}`);
        this.dashHopBrowserIds.delete(message.browserId);
        // Remove from all carrots
        for (const carrot of this.carrots.values()) {
          carrot.hopBrowserIds.delete(message.browserId);
        }
        return;
      }

      if (message.type === "hop:file-request") {
        this.handleHopFileRequest(message);
        return;
      }

      if (message.type === "hop:message") {
        const { browserId, carrotId, payload } = message;
        const isDashUiTarget = carrotId === "dash-ui";

        // Handle RPC messages (fire-and-forget from view → bun)
        if (payload?.type === "message") {
          const messageName = payload.id;
          const messagePayload = payload.payload;
          if (isDashUiTarget) {
            const sourceWindowId = this.getDashWindowIdFromBridgePayload(
              messagePayload,
              undefined,
            );
            this.setDashHopBrowserWindowId(
              browserId,
              sourceWindowId,
            );
            await this.dispatchDashBridgeMessage(
              String(messageName || ""),
              messagePayload,
              sourceWindowId,
            );
          } else {
            const carrot = this.carrots.get(carrotId);
            if (carrot && carrot.status === "running") {
              carrot.setHopBrowserWindowId(
                browserId,
                typeof (messagePayload as { windowId?: unknown } | undefined)?.windowId === "string"
                  ? ((messagePayload as { windowId: string }).windowId)
                  : undefined,
              );
              carrot.worker?.postMessage({
                type: "request",
                requestId: 0,
                method: `send:${messageName}`,
                params: messagePayload,
              });
            }
          }
          return;
        }

        // Handle RPC requests (view → bun, expects response)
        const method = payload?.method;
        const params = payload?.params;
        const requestId = payload?.id;

        if (!method || requestId === undefined) return;

        // Handle runtime-level requests (carrotId = "bunny-ears" or no carrot found)
        if (carrotId === "bunny-ears" || (!isDashUiTarget && !this.carrots.has(carrotId))) {
          this.handleHopRuntimeRequest(browserId, requestId, method, params);
          return;
        }

        if (isDashUiTarget) {
          const sourceWindowId = this.getDashWindowIdFromBridgePayload(
            params,
            undefined,
          );
          this.setDashHopBrowserWindowId(
            browserId,
            sourceWindowId,
          );
          this.dispatchDashBridgeRequest(
            String(method || ""),
            params,
            sourceWindowId,
          )
          .then((result: unknown) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: true, payload: result },
            }));
          })
          .catch((err: Error) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: false, error: err.message },
            }));
          });
          return;
        }

        const carrot = this.carrots.get(carrotId)!;
        carrot.setHopBrowserWindowId(
          browserId,
          typeof (params as { windowId?: unknown } | undefined)?.windowId === "string"
            ? ((params as { windowId?: string }).windowId)
            : undefined,
        );
        if (carrot.status !== "running") {
          this.hopWs?.send(JSON.stringify({
            browserId,
            payload: { type: "response", id: requestId, success: false, error: `Carrot ${carrotId} is not running` },
          }));
          return;
        }

        Promise.resolve()
          .then(() => {
            if (method === "invokeCarrot") {
              return this.deliverCarrotInvokeFrom(
                carrotId,
                String((params as any)?.carrotId || ""),
                String((params as any)?.method || ""),
                (params as any)?.params,
                typeof (params as any)?.windowId === "string"
                  ? (params as any).windowId
                  : undefined,
              );
            }
            return carrot.invoke(method, params);
          })
          .then((result: unknown) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: true, payload: result },
            }));
          })
          .catch((err: Error) => {
            this.hopWs?.send(JSON.stringify({
              browserId,
              payload: { type: "response", id: requestId, success: false, error: err.message },
            }));
          });
        return;
      }
    } catch (err) {
      console.error("[hop] Failed to handle message:", err instanceof Error ? err.message : err);
    }
  }

  private handleHopFileRequest(message: { requestId: number; carrotId: string; path: string }) {
    const { requestId, carrotId, path: filePath } = message;
    const resolved = this.resolveHopCarrotFile(carrotId, filePath);

    if (!resolved.ok) {
      this.hopWs?.send(JSON.stringify({
        type: "hop:file-response",
        requestId,
        status: resolved.status,
        contentType: "text/plain",
        body: btoa(resolved.error),
      }));
      return;
    }

    const base64 = Buffer.from(resolved.body).toString("base64");

    this.hopWs?.send(JSON.stringify({
      type: "hop:file-response",
      requestId,
      contentType: resolved.contentType,
      body: base64,
    }));
  }

  private resolveHopCarrotFile(carrotId: string, filePath: string) {
    const segments = filePath.replace(/^\/+/, "").split("/").filter(Boolean);
    const uiKind = segments[0] || "";
    const uiId = segments[1] || "";
    const restPath = segments.slice(2);

    if (uiKind === "remote-ui" && uiId) {
      return this.resolveCarrotRemoteUIFile(carrotId, uiId, restPath);
    }

    if (uiKind === "slate-ui" && uiId) {
      return this.resolveCarrotSlateUIFile(carrotId, uiId, restPath);
    }

    return this.resolveCarrotFile(carrotId, filePath);
  }

  private getContentTypeForPath(fullPath: string) {
    const ext = require("node:path").extname(fullPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".mjs": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".map": "application/json",
    };

    return mimeTypes[ext] || "application/octet-stream";
  }

  private resolveCarrotFile(carrotId: string, filePath: string) {
    const carrot = getInstalledCarrot(carrotId);
    if (!carrot) {
      return {
        ok: false as const,
        status: 404,
        error: `Carrot not found: ${carrotId}`,
      };
    }

    const fs = require("node:fs");
    const pathMod = require("node:path");
    const normalizedPath = filePath.replace(/^\/+/, "");
    const fullPath = pathMod.resolve(carrot.currentDir, normalizedPath);

    if (!fullPath.startsWith(carrot.currentDir)) {
      return {
        ok: false as const,
        status: 403,
        error: "Path escapes carrot directory",
      };
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return {
        ok: false as const,
        status: 404,
        error: `File not found: ${normalizedPath}`,
      };
    }

    return {
      ok: true as const,
      body: fs.readFileSync(fullPath),
      contentType: this.getContentTypeForPath(fullPath),
    };
  }

  private resolveCarrotRemoteUIFile(carrotId: string, remoteUIId: string, restPath: string[]) {
    const carrot = getInstalledCarrot(carrotId);
    if (!carrot) {
      return {
        ok: false as const,
        status: 404,
        error: `Carrot not found: ${carrotId}`,
      };
    }

    const remoteUI = carrot.manifest.remoteUIs?.[remoteUIId];
    if (!remoteUI) {
      return {
        ok: false as const,
        status: 404,
        error: `Remote UI not found: ${remoteUIId}`,
      };
    }

    const pathMod = require("node:path");
    const basePath = remoteUI.path.replace(/^\/+/, "");
    const relativePath = restPath.length
      ? pathMod.join(pathMod.dirname(basePath), ...restPath)
      : basePath;

    return this.resolveCarrotFile(carrotId, relativePath);
  }

  private resolveCarrotSlateUIFile(carrotId: string, slateUIId: string, restPath: string[]) {
    const carrot = getInstalledCarrot(carrotId);
    if (!carrot) {
      return {
        ok: false as const,
        status: 404,
        error: `Carrot not found: ${carrotId}`,
      };
    }

    const slateUI = carrot.manifest.slateUIs?.[slateUIId];
    if (!slateUI) {
      return {
        ok: false as const,
        status: 404,
        error: `Slate UI not found: ${slateUIId}`,
      };
    }

    const pathMod = require("node:path");
    const basePath = slateUI.path.replace(/^\/+/, "");
    const relativePath = restPath.length
      ? pathMod.join(pathMod.dirname(basePath), ...restPath)
      : basePath;

    return this.resolveCarrotFile(carrotId, relativePath);
  }

  private handleHopRuntimeRequest(browserId: string, requestId: number, method: string, params: unknown) {
    const sendResult = (result: unknown) => {
      this.hopWs?.send(JSON.stringify({
        browserId,
        payload: { type: "response", id: requestId, success: true, payload: result },
      }));
    };
    const sendError = (error: string) => {
      this.hopWs?.send(JSON.stringify({
        browserId,
        payload: { type: "response", id: requestId, success: false, error },
      }));
    };

    try {
      switch (method) {
        case "invokeCarrot": {
          const request = params && typeof params === "object" ? (params as any) : {};
          this.deliverCarrotInvokeFrom(
            String(request.sourceCarrotId || "bunny-ears"),
            String(request.targetCarrotId || request.carrotId || ""),
            String(request.method || ""),
            request.params,
            typeof request.windowId === "string" ? request.windowId : undefined,
          )
            .then(sendResult)
            .catch((e) => sendError(e instanceof Error ? e.message : String(e)));
          break;
        }
        case "emitCarrotEvent": {
          const request = params && typeof params === "object" ? (params as any) : {};
          this.deliverCarrotEventFrom(
            String(request.sourceCarrotId || "bunny-ears"),
            String(request.targetCarrotId || request.carrotId || ""),
            String(request.name || ""),
            request.payload,
          );
          sendResult({ ok: true });
          break;
        }
        case "emitCarrotViewEvent": {
          const request = params && typeof params === "object" ? (params as any) : {};
          this.deliverCarrotViewEventFrom(
            String(request.sourceCarrotId || "bunny-ears"),
            String(request.targetCarrotId || request.carrotId || ""),
            String(request.name || ""),
            request.payload,
            {
              raw: Boolean(request.raw),
              windowId: typeof request.windowId === "string" ? request.windowId : undefined,
            },
          );
          sendResult({ ok: true });
          break;
        }
        case "list-carrots":
          sendResult(this.summaries());
          break;
        case "update-carrots":
          this.handleTrayAction("update-carrots").then(() => sendResult({ ok: true })).catch((e) => sendError(String(e)));
          break;
        default:
          sendError(`Unknown runtime method: ${method}`);
      }
    } catch (err) {
      sendError(err instanceof Error ? err.message : String(err));
    }
  }

  private getAuthTokenPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".auth-token");
  }

  private getChannelStateDir() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel);
  }

  private getDashHostCachePath() {
    const path = require("node:path");
    return path.join(this.getChannelStateDir(), "dash-host-cache.json");
  }

  private loadDashHostCache(): DashHostSummaryCache | null {
    const cachePath = this.getDashHostCachePath();
    if (!existsSync(cachePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as DashHostSummaryCache;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return {
        version: 1,
        updatedAt: Number(parsed.updatedAt || 0),
        currentWorkspaceId: String(parsed.currentWorkspaceId || ""),
        currentLensId: String(parsed.currentLensId || ""),
        currentWindow:
          parsed.currentWindow && typeof parsed.currentWindow === "object"
            ? {
                windowId: String(parsed.currentWindow.windowId || ""),
                title: String(parsed.currentWindow.title || ""),
                frame: {
                  x: Number(parsed.currentWindow.frame?.x || 0),
                  y: Number(parsed.currentWindow.frame?.y || 0),
                  width: Number(parsed.currentWindow.frame?.width || 1500),
                  height: Number(parsed.currentWindow.frame?.height || 900),
                },
                workspaceId: String(parsed.currentWindow.workspaceId || ""),
                lensId: String(parsed.currentWindow.lensId || ""),
                activeTreeNodeId: String(parsed.currentWindow.activeTreeNodeId || ""),
              }
            : null,
        windows: Array.isArray(parsed.windows)
          ? parsed.windows
              .filter((window) => window && typeof window === "object")
              .map((window) => ({
                windowId: String(window.windowId || ""),
                title: String(window.title || ""),
                frame: {
                  x: Number(window.frame?.x || 0),
                  y: Number(window.frame?.y || 0),
                  width: Number(window.frame?.width || 1500),
                  height: Number(window.frame?.height || 900),
                },
                workspaceId: String(window.workspaceId || ""),
                lensId: String(window.lensId || ""),
                activeTreeNodeId: String(window.activeTreeNodeId || ""),
              }))
              .filter((window) => Boolean(window.windowId))
          : [],
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        localWorkspaces: Array.isArray((parsed as any).localWorkspaces)
          ? (parsed as any).localWorkspaces
              .filter((workspace: unknown) => workspace && typeof workspace === "object")
              .map((workspace: any) => ({
                id: String(workspace.id || ""),
                name: String(workspace.name || "Local Workspace"),
                subtitle: String(workspace.subtitle || "Local workspace"),
                projectsDir: String(workspace.projectsDir || ""),
                sortOrder: Number(workspace.sortOrder || 0),
                createdAt: Number(workspace.createdAt || 0),
                updatedAt: Number(workspace.updatedAt || 0),
              }))
              .filter((workspace: DashLocalWorkspaceSummary) => Boolean(workspace.id))
          : [],
        cloudWorkspaces: Array.isArray(parsed.cloudWorkspaces) ? parsed.cloudWorkspaces : [],
        knownLocalProjects: Array.isArray(parsed.knownLocalProjects)
          ? parsed.knownLocalProjects
          : [],
        peerDependencies:
          parsed.peerDependencies && typeof parsed.peerDependencies === "object"
            ? parsed.peerDependencies
            : {},
        account:
          parsed.account && typeof parsed.account === "object"
            ? {
                signedIn: Boolean(parsed.account.signedIn),
                email: String(parsed.account.email || ""),
                name: String(parsed.account.name || ""),
                userId: String(parsed.account.userId || ""),
                emailVerified: Boolean(parsed.account.emailVerified),
                connectedAt:
                  typeof parsed.account.connectedAt === "number"
                    ? parsed.account.connectedAt
                    : undefined,
              }
            : {
                signedIn: false,
                email: "",
                name: "",
                userId: "",
                emailVerified: false,
              },
        currentInstance:
          parsed.currentInstance && typeof parsed.currentInstance === "object"
            ? parsed.currentInstance
            : null,
      };
    } catch (error) {
      console.error(
        "[bunny-ears] Failed to load Dash host cache:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }

  private saveDashHostCache(cache: DashHostSummaryCache) {
    const cachePath = this.getDashHostCachePath();
    mkdirSync(this.getChannelStateDir(), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  private upsertDashHostCache(payload: Partial<DashHostSummaryCache>) {
    const current = this.loadDashHostCache() || {
      version: 1 as const,
      updatedAt: 0,
      currentWorkspaceId: "",
      currentLensId: "",
      currentWindow: null,
      windows: [],
      workspaces: [],
      localWorkspaces: [],
      cloudWorkspaces: [],
      knownLocalProjects: [],
      peerDependencies: {},
      account: {
        signedIn: false,
        email: "",
        name: "",
        userId: "",
        emailVerified: false,
      },
      currentInstance: null,
    };

    if (payload.currentWindow && payload.currentWindow.windowId) {
      current.windows = current.windows.filter(
        (window) => window.windowId !== payload.currentWindow?.windowId,
      );
      current.windows.push(payload.currentWindow);
    }
    if (typeof payload.currentWorkspaceId === "string") {
      current.currentWorkspaceId = payload.currentWorkspaceId;
    }
    if (typeof payload.currentLensId === "string") {
      current.currentLensId = payload.currentLensId;
    }
    if (payload.currentWindow !== undefined) {
      current.currentWindow = payload.currentWindow || null;
    }
    if (Array.isArray(payload.workspaces)) {
      current.workspaces = payload.workspaces;
    }
    if (Array.isArray(payload.localWorkspaces)) {
      current.localWorkspaces = payload.localWorkspaces;
    }
    if (Array.isArray(payload.cloudWorkspaces)) {
      current.cloudWorkspaces = payload.cloudWorkspaces;
    }
    if (Array.isArray(payload.knownLocalProjects)) {
      current.knownLocalProjects = payload.knownLocalProjects;
    }
    if (payload.peerDependencies && typeof payload.peerDependencies === "object") {
      current.peerDependencies = payload.peerDependencies;
    }
    if (payload.account && typeof payload.account === "object") {
      current.account = payload.account;
    }
    if (payload.currentInstance !== undefined) {
      current.currentInstance = payload.currentInstance ?? null;
    }

    current.updatedAt = Date.now();
    this.saveDashHostCache(current);
    return current;
  }

  private removeDashHostCacheWindow(windowId: string) {
    const current = this.loadDashHostCache();
    if (!current) {
      return;
    }
    current.windows = current.windows.filter((window) => window.windowId !== windowId);
    if (current.currentWindow?.windowId === windowId) {
      current.currentWindow = null;
    }
    current.updatedAt = Date.now();
    this.saveDashHostCache(current);
  }

  private getDashLocalWorkspacesPath() {
    return join(this.getChannelStateDir(), "dash-local-workspaces.json");
  }

  private createDashLocalWorkspaceId() {
    return `local_ws_${randomUUID().replace(/-/g, "")}`;
  }

  private isGeneratedDashLocalWorkspaceId(workspaceId?: string) {
    return this.normalizeDashLocalWorkspaceId(workspaceId).startsWith("local_ws_");
  }

  private normalizeDashLocalWorkspaceId(workspaceId?: string) {
    const rawWorkspaceId = String(workspaceId || "").trim();
    const localWorkspaceId = rawWorkspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX)
      ? rawWorkspaceId.slice(CLOUD_WORKSPACE_SHADOW_PREFIX.length)
      : rawWorkspaceId;
    return localWorkspaceId
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  private sanitizeDashLocalWorkspaceName(name: unknown, fallback = "Local Workspace") {
    const cleanName = String(name || "").trim();
    return cleanName || fallback;
  }

  private makeDashLocalWorkspaceSummary(params: {
    id: string;
    name?: unknown;
    subtitle?: unknown;
    sortOrder: number;
    createdAt?: number;
    updatedAt?: number;
    projectsDir?: string;
  }): DashLocalWorkspaceSummary {
    const id = this.normalizeDashLocalWorkspaceId(params.id) || this.createDashLocalWorkspaceId();
    const now = Date.now();
    return {
      id,
      name: this.sanitizeDashLocalWorkspaceName(params.name),
      subtitle: String(params.subtitle || "Local workspace").trim() || "Local workspace",
      projectsDir: this.getDashWorkspaceProjectsDir(id),
      sortOrder: Number.isFinite(params.sortOrder) ? Number(params.sortOrder) : 0,
      createdAt: Number(params.createdAt || 0) || now,
      updatedAt: Number(params.updatedAt || 0) || now,
    };
  }

  private loadDashLocalWorkspaces(): DashLocalWorkspaceSummary[] {
    const registryPath = this.getDashLocalWorkspacesPath();
    if (!existsSync(registryPath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as
        | { workspaces?: unknown[] }
        | unknown[];
      const rawWorkspaces = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.workspaces)
          ? parsed.workspaces
          : [];
      const workspaces: DashLocalWorkspaceSummary[] = [];
      for (const [index, workspace] of rawWorkspaces.entries()) {
        if (!workspace || typeof workspace !== "object") {
          continue;
        }
        const entry = workspace as any;
        const id = this.normalizeDashLocalWorkspaceId(entry.id || entry.key || "");
        if (!id || !this.isGeneratedDashLocalWorkspaceId(id)) {
          continue;
        }
        workspaces.push(
          this.makeDashLocalWorkspaceSummary({
            id,
            name: entry.name,
            subtitle: entry.subtitle,
            projectsDir: String(entry.projectsDir || ""),
            sortOrder: Number(entry.sortOrder ?? index),
            createdAt: Number(entry.createdAt || 0),
            updatedAt: Number(entry.updatedAt || 0),
          }),
        );
      }
      return workspaces.sort((left, right) => left.sortOrder - right.sortOrder);
    } catch (error) {
      console.error(
        "[bunny-ears] Failed to load Dash local workspaces:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  private saveDashLocalWorkspaces(workspaces: DashLocalWorkspaceSummary[]) {
    const registryPath = this.getDashLocalWorkspacesPath();
    const normalized = workspaces
      .map((workspace, index) =>
        this.makeDashLocalWorkspaceSummary({
          ...workspace,
          sortOrder: Number.isFinite(workspace.sortOrder) ? workspace.sortOrder : index,
        }),
      )
      .sort((left, right) => left.sortOrder - right.sortOrder);
    mkdirSync(this.getChannelStateDir(), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          version: 1,
          workspaces: normalized,
        },
        null,
        2,
      ),
    );
  }

  private ensureDashLocalWorkspaces(): DashLocalWorkspaceSummary[] {
    const workspacesById = new Map<string, DashLocalWorkspaceSummary>();
    let changed = false;
    const addWorkspace = (workspace: DashLocalWorkspaceSummary) => {
      if (!workspace.id || workspacesById.has(workspace.id)) {
        return;
      }
      workspacesById.set(workspace.id, workspace);
    };

    for (const workspace of this.loadDashLocalWorkspaces()) {
      addWorkspace(workspace);
    }

    if (workspacesById.size === 0) {
      addWorkspace(
        this.makeDashLocalWorkspaceSummary({
          id: this.createDashLocalWorkspaceId(),
          name: "Local Workspace",
          subtitle: "Local workspace",
          sortOrder: 0,
        }),
      );
      changed = true;
    }

    const workspaces = Array.from(workspacesById.values())
      .map((workspace, index) => {
        const projectsDir =
          String(workspace.projectsDir || "").trim() ||
          this.getDashWorkspaceProjectsDir(workspace.id);
        if (workspace.projectsDir !== projectsDir || workspace.sortOrder !== index) {
          changed = true;
        }
        mkdirSync(projectsDir, { recursive: true });
        return {
          ...workspace,
          projectsDir,
          sortOrder: Number.isFinite(workspace.sortOrder) ? workspace.sortOrder : index,
        };
      })
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((workspace, index) => ({
        ...workspace,
        sortOrder: index,
      }));

    if (changed) {
      this.saveDashLocalWorkspaces(workspaces);
    }
    return workspaces;
  }

  private buildDashLocalWorkspaceTree(
    workspace: DashLocalWorkspaceSummary,
    currentWorkspaceId: string,
  ) {
    const lensId = `${WORKSPACE_CURRENT_LENS_PREFIX}${workspace.id}`;
    const isCurrent = workspace.id === currentWorkspaceId;
    return {
      id: workspace.id,
      name: workspace.name,
      subtitle: workspace.subtitle,
      isCurrent,
      currentLensId: lensId,
      currentLensIsActive: isCurrent,
      canExpand: true,
      lenses: [
        {
          id: lensId,
          name: "Current",
          description: `Current working state for ${workspace.name}.`,
          workspaceId: workspace.id,
          isCurrent,
          isDirty: false,
        },
      ],
    };
  }

  private createDashLocalWorkspace(params?: {
    workspaceId?: string;
    name?: string;
    subtitle?: string;
  }) {
    const workspaces = this.ensureDashLocalWorkspaces();
    const existingIds = new Set(workspaces.map((workspace) => workspace.id));
    let workspaceId = this.isGeneratedDashLocalWorkspaceId(params?.workspaceId)
      ? this.normalizeDashLocalWorkspaceId(params?.workspaceId || "")
      : "";
    if (!workspaceId || existingIds.has(workspaceId)) {
      do {
        workspaceId = this.createDashLocalWorkspaceId();
      } while (existingIds.has(workspaceId));
    }

    const now = Date.now();
    const workspace = this.makeDashLocalWorkspaceSummary({
      id: workspaceId,
      name: this.sanitizeDashLocalWorkspaceName(
        params?.name,
        `Workspace ${workspaces.length + 1}`,
      ),
      subtitle: String(params?.subtitle || "Local workspace").trim() || "Local workspace",
      sortOrder: workspaces.length,
      createdAt: now,
      updatedAt: now,
    });
    mkdirSync(workspace.projectsDir, { recursive: true });

    const nextWorkspaces = [...workspaces, workspace];
    this.saveDashLocalWorkspaces(nextWorkspaces);
    this.upsertDashHostCache({
      currentWorkspaceId: workspace.id,
      currentLensId: `${WORKSPACE_CURRENT_LENS_PREFIX}${workspace.id}`,
      workspaces: nextWorkspaces.map((entry) =>
        this.buildDashLocalWorkspaceTree(entry, workspace.id),
      ),
      localWorkspaces: nextWorkspaces,
      knownLocalProjects: this.listDashKnownLocalProjects(),
    });
    return workspace;
  }

  private getDashHomeDir() {
    const os = require("node:os");
    return join(os.homedir(), ".dash", this.channel);
  }

  private getDashWorkspacesDir() {
    return join(this.getDashHomeDir(), "workspaces");
  }

  private getDashWorkspaceProjectsDir(workspaceId?: string) {
    const resolvedWorkspaceId = this.normalizeDashProjectWorkspaceId(workspaceId);
    return join(this.getDashWorkspacesDir(), resolvedWorkspaceId, "projects");
  }

  private normalizeDashProjectWorkspaceId(workspaceId?: string) {
    const resolvedWorkspaceId = workspaceId || DEFAULT_DASH_WORKSPACE_ID;
    return resolvedWorkspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX)
      ? resolvedWorkspaceId.slice(CLOUD_WORKSPACE_SHADOW_PREFIX.length)
      : resolvedWorkspaceId;
  }

  private listDashProjectWorkspaceRootEntries(workspaceId?: string) {
    const entries = this.ensureDashLocalWorkspaces().map((workspace) => ({
      workspaceId: workspace.id,
      root: workspace.projectsDir,
    }));
    const requestedWorkspaceId = workspaceId
      ? this.normalizeDashProjectWorkspaceId(workspaceId)
      : "";
    if (
      requestedWorkspaceId &&
      !entries.some((entry) => entry.workspaceId === requestedWorkspaceId)
    ) {
      entries.push({
        workspaceId: requestedWorkspaceId,
        root: this.getDashProjectsFolder(workspaceId),
      });
    }
    return entries;
  }

  private getDashProjectsFolder(workspaceId?: string) {
    const resolvedWorkspaceId = this.normalizeDashProjectWorkspaceId(workspaceId);
    const localWorkspace = this.ensureDashLocalWorkspaces().find(
      (workspace) => workspace.id === resolvedWorkspaceId,
    );
    const currentRoot = localWorkspace?.projectsDir || this.getDashWorkspaceProjectsDir(workspaceId);
    mkdirSync(currentRoot, { recursive: true });
    return currentRoot;
  }

  private listDashKnownLocalProjects(workspaceId?: string) {
    const currentInstance = this.buildCurrentDashInstanceSummary(workspaceId);
    const projects = new Map<string, {
      id: string;
      name: string;
      path: string;
      workspaceId: string;
      instanceId: string;
      instanceMachineId: string;
      instanceLabel: string;
      kind: string;
      status: string;
    }>();

    for (const projectRootEntry of this.listDashProjectWorkspaceRootEntries(workspaceId)) {
      const projectWorkspaceId = projectRootEntry.workspaceId;
      const workspaceRoot = projectRootEntry.root;
      if (!existsSync(workspaceRoot)) {
        continue;
      }
      try {
        for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) {
            continue;
          }
          const fullPath = join(workspaceRoot, entry.name);
          let isDirectory = entry.isDirectory();
          if (!isDirectory && entry.isSymbolicLink()) {
            try {
              isDirectory = statSync(fullPath).isDirectory();
            } catch {
              isDirectory = false;
            }
          }
          if (!isDirectory) {
            continue;
          }
          projects.set(fullPath, {
            id: fullPath,
            name: entry.name,
            path: fullPath,
            workspaceId: projectWorkspaceId,
            instanceId: currentInstance.id,
            instanceMachineId: currentInstance.machineId,
            instanceLabel: currentInstance.name,
            kind: "project",
            status: "available",
          });
        }
      } catch {}
    }

    return Array.from(projects.values()).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  private getDashBuildVars() {
    return {
      channel: this.channel,
      version: "0.1.0",
      hash: "dash-ui",
    };
  }

  private getDashPaths(workspaceId?: string) {
    const bunPath = Bun.which("bun") || "";
    const gitPath = Bun.which("git") || "";
    return {
      APP_PATH: this.getDashHomeDir(),
      BUNNY_HOME_FOLDER: this.getDashHomeDir(),
      BUNNY_PROJECTS_FOLDER: this.getDashProjectsFolder(workspaceId),
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

  private getHopWsBaseUrl() {
    if (this.channel === "stable") return "wss://hop.electrobunny.ai";
    if (this.channel === "dev") return "ws://localhost:8788";
    return "wss://staging-hop.electrobunny.ai";
  }

  private getHopHttpBaseUrl() {
    return this.getHopWsBaseUrl()
      .replace(/^ws:\/\//, "http://")
      .replace(/^wss:\/\//, "https://");
  }

  private getDashWebBridgeOrigin() {
    return this.getHopHttpBaseUrl();
  }

  private buildCurrentDashInstanceSummary(workspaceId?: string) {
    const os = require("node:os");
    const machineId = this.getMachineId() || "";
    const stableLocalInstanceId =
      this.instance?.id || (machineId ? `local:${machineId}` : "local:this-instance");
    return {
      id: stableLocalInstanceId,
      machineId,
      projectRoot: workspaceId ? this.getDashProjectsFolder(workspaceId) : "",
      name: os.hostname() || "This Machine",
      os: process.platform === "darwin" ? "macos" : process.platform,
      status: "online",
      isCurrent: true,
      carrots: this.summaries(),
    };
  }

  private async buildDashMachineConnectionStatus() {
    const os = require("node:os");
    const machineId = this.getMachineId() || "";
    const hopReadyState = this.hopWs?.readyState ?? -1;
    const hopStatus =
      isHopDisabled()
        ? "disabled"
        : !machineId || !this.deviceToken
          ? "not-linked"
          : hopReadyState === 1
            ? "connected"
            : "connecting";

    let workspaces: unknown[] = [];
    if (machineId && this.deviceToken) {
      try {
        const response = await fetch(`${this.getDashCloudApiBaseUrl()}/v1/auth/device-workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            machine_id: machineId,
            device_token: this.deviceToken,
          }),
        });
        if (response.ok) {
          const data = await response.json() as { workspaces?: unknown[] };
          workspaces = Array.isArray(data.workspaces) ? data.workspaces : [];
        } else {
          console.log(`[bunny-ears] device-workspaces failed: ${response.status}`);
        }
      } catch (error) {
        console.log(`[bunny-ears] device-workspaces error: ${error}`);
      }
    }

    return {
      ok: true,
      machineId,
      name: os.hostname() || "This Machine",
      hopStatus,
      hopReadyState,
      hasDeviceToken: Boolean(this.deviceToken),
      apiBaseUrl: this.getDashCloudApiBaseUrl(),
      hopBaseUrl: this.getHopWsBaseUrl(),
      workspaces,
    };
  }

  private buildDashHostBootState(sourceWindowId?: string, workspaceIdOverride?: string) {
    const cache = this.loadDashHostCache();
    const localWorkspaces = this.ensureDashLocalWorkspaces();
    const targetWindowId = sourceWindowId || cache?.currentWindow?.windowId || "main";
    const windowTarget =
      cache?.windows.find((window) => window.windowId === targetWindowId) ||
      cache?.currentWindow ||
      null;
    const requestedWorkspaceId =
      workspaceIdOverride ||
      windowTarget?.workspaceId ||
      cache?.currentWorkspaceId ||
      localWorkspaces[0]?.id ||
      DEFAULT_DASH_WORKSPACE_ID;
    const hasWorkspaceOverride = Boolean(String(workspaceIdOverride || "").trim());
    const requestedIsCloudWorkspace = requestedWorkspaceId.startsWith(CLOUD_WORKSPACE_SHADOW_PREFIX);
    const requestedLocalWorkspaceId = this.normalizeDashLocalWorkspaceId(requestedWorkspaceId);
    const matchedLocalWorkspace = localWorkspaces.find(
      (workspace) => workspace.id === requestedLocalWorkspaceId,
    );
    const fallbackLocalWorkspaceId = localWorkspaces[0]?.id || DEFAULT_DASH_WORKSPACE_ID;
    const workspaceId =
      matchedLocalWorkspace?.id ||
      (hasWorkspaceOverride || requestedIsCloudWorkspace
        ? requestedWorkspaceId
        : fallbackLocalWorkspaceId);
    const currentWorkspaceId =
      matchedLocalWorkspace?.id ||
      (hasWorkspaceOverride || requestedIsCloudWorkspace
        ? requestedWorkspaceId
        : fallbackLocalWorkspaceId);
    const currentWorkspaceLensId = `${WORKSPACE_CURRENT_LENS_PREFIX}${currentWorkspaceId}`;
    const cachedCurrentLensId = String(cache?.currentLensId || "");
    const currentLensId =
      matchedLocalWorkspace || !requestedIsCloudWorkspace
        ? cachedCurrentLensId.endsWith(`:${currentWorkspaceId}`)
          ? cachedCurrentLensId
          : currentWorkspaceLensId
        : cachedCurrentLensId;
    const localWorkspaceTrees = localWorkspaces.map((workspace) =>
      this.buildDashLocalWorkspaceTree(workspace, currentWorkspaceId),
    );
    const knownLocalProjects = this.listDashKnownLocalProjects(workspaceId);
    const currentInstanceSummary = this.buildCurrentDashInstanceSummary(workspaceId);
    const dashCache: DashHostSummaryCache = {
      version: 1,
      updatedAt: cache?.updatedAt || 0,
      currentWorkspaceId,
      currentLensId,
      currentWindow: cache?.currentWindow || null,
      windows: cache?.windows || [],
      workspaces: localWorkspaceTrees,
      localWorkspaces,
      cloudWorkspaces: cache?.cloudWorkspaces || [],
      knownLocalProjects,
      peerDependencies: cache?.peerDependencies || {},
      account: cache?.account || {
        signedIn: false,
        email: "",
        name: "",
        userId: "",
        emailVerified: false,
      },
      currentInstance: {
        ...(cache?.currentInstance && typeof cache.currentInstance === "object"
          ? cache.currentInstance
          : {}),
        ...currentInstanceSummary,
      },
    };
    this.saveDashHostCache({
      ...dashCache,
      updatedAt: Date.now(),
    });

    return {
      windowId: targetWindowId,
      buildVars: this.getDashBuildVars(),
      paths: this.getDashPaths(workspaceId),
      peerDependencies: dashCache?.peerDependencies || {
        bun: {
          installed: Boolean(Bun.which("bun")),
          version: Bun.version,
        },
        typescript: {
          installed: false,
          version: "",
        },
        biome: {
          installed: false,
          version: "",
        },
        git: {
          installed: Boolean(Bun.which("git")),
          version: "",
        },
      },
      webBridgeOrigin: this.getDashWebBridgeOrigin(),
      dashCache,
      windowTarget,
      currentInstance: {
        ...(dashCache.currentInstance && typeof dashCache.currentInstance === "object"
          ? dashCache.currentInstance
          : {}),
        ...currentInstanceSummary,
      },
    };
  }

  private getDeviceTokenPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".device-token");
  }

  private getDeviceTokenIdPath() {
    const path = require("node:path");
    const os = require("node:os");
    return path.join(os.homedir(), ".electrobunny", this.channel, ".device-token-id");
  }

  private loadAuthToken() {
    const fs = require("node:fs");
    const tokenPath = this.getAuthTokenPath();

    if (fs.existsSync(tokenPath)) {
      try {
        this.authToken = fs.readFileSync(tokenPath, "utf8").trim();
        bootLog("loaded auth token");
      } catch {}
    }
  }

  private loadDeviceToken() {
    const fs = require("node:fs");
    const tokenPath = this.getDeviceTokenPath();
    if (fs.existsSync(tokenPath)) {
      try {
        this.deviceToken = fs.readFileSync(tokenPath, "utf8").trim();
        console.log("[bunny-ears] loaded device token");
      } catch {}
    }
    const idPath = this.getDeviceTokenIdPath();
    if (fs.existsSync(idPath)) {
      try {
        this.deviceTokenId = fs.readFileSync(idPath, "utf8").trim();
      } catch {}
    }
  }

  private saveDeviceToken(token: string, tokenId?: string | null) {
    const fs = require("node:fs");
    const path = require("node:path");
    const tokenPath = this.getDeviceTokenPath();
    this.deviceToken = token;
    try {
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, token);
      // Restrict permissions: rw owner only
      try { fs.chmodSync(tokenPath, 0o600); } catch {}
    } catch {}
    if (tokenId) {
      this.deviceTokenId = tokenId;
      const idPath = this.getDeviceTokenIdPath();
      try {
        fs.writeFileSync(idPath, tokenId);
        try { fs.chmodSync(idPath, 0o600); } catch {}
      } catch {}
    }
  }

  private clearDeviceToken() {
    const fs = require("node:fs");
    const tokenPath = this.getDeviceTokenPath();
    this.deviceToken = null;
    try { if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath); } catch {}
    const idPath = this.getDeviceTokenIdPath();
    this.deviceTokenId = null;
    try { if (fs.existsSync(idPath)) fs.unlinkSync(idPath); } catch {}
  }

  private clearSavedAuthToken() {
    const fs = require("node:fs");
    const tokenPath = this.getAuthTokenPath();
    this.authToken = null;
    try {
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
      }
    } catch {}
  }

  private signOutFromCloud(options?: {
    revokeDeviceTokenOnServer?: boolean;
    markInstanceOffline?: boolean;
  }) {
    const revokeDeviceTokenOnServer = options?.revokeDeviceTokenOnServer ?? true;
    const markInstanceOffline = options?.markInstanceOffline ?? true;

    const oldAccessToken = this.authToken;
    const oldDeviceTokenId = this.deviceTokenId;
    const oldInstanceId = this.instance?.id || null;

    this.clearSavedAuthToken();
    this.clearDeviceToken();
    this.instance = null;
    this.upsertDashHostCache({
      account: {
        signedIn: false,
        email: "",
        name: "",
        userId: "",
        emailVerified: false,
      },
    });

    try { this.hopWs?.close(); } catch {}
    this.hopWs = null;

    for (const carrot of this.carrots.values()) {
      if (carrot.status === "running") {
        carrot.sendEvent("auth-token-cleared");
      }
    }
    this.refreshDashViews();

    console.log("[bunny-ears] Bunny Cloud session cleared");

    if (oldAccessToken) {
      if (markInstanceOffline && oldInstanceId) {
        this.markInstanceOfflineOnServer(oldInstanceId, oldAccessToken).catch(() => {});
      }
      if (revokeDeviceTokenOnServer && oldDeviceTokenId) {
        this.revokeDeviceTokenOnServer(oldDeviceTokenId, oldAccessToken).catch(() => {});
      }
    }
  }

  // Mark this instance as offline on the API. Best-effort, fire-and-forget.
  // Used on logout so the instance immediately appears offline in Farm.
  private async markInstanceOfflineOnServer(instanceId: string, accessToken: string) {
    const apiBase = this.getDashCloudApiBaseUrl();

    try {
      const resp = await fetch(`${apiBase}/v1/instances/${instanceId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ status: "offline" }),
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] mark offline failed: ${resp.status}`);
      } else {
        console.log(`[bunny-ears] instance ${instanceId} marked offline`);
      }
    } catch (err) {
      console.log(`[bunny-ears] mark offline error: ${err}`);
    }
  }

  // Revoke the device token on the server. Best-effort — the local token is
  // already cleared by the time this returns.
  private async revokeDeviceTokenOnServer(tokenId: string, accessToken: string) {
    const apiBase = this.getDashCloudApiBaseUrl();

    try {
      const resp = await fetch(`${apiBase}/v1/auth/device-tokens/${tokenId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] device token revoke failed: ${resp.status}`);
      } else {
        console.log(`[bunny-ears] device token ${tokenId} revoked server-side`);
      }
    } catch (err) {
      console.log(`[bunny-ears] device token revoke error: ${err}`);
    }
  }

  private saveAuthToken(token: string) {
    const fs = require("node:fs");
    const path = require("node:path");
    const tokenPath = this.getAuthTokenPath();

    this.authToken = token;
    if (tokenPath) {
      try {
        fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
        fs.writeFileSync(tokenPath, token);
      } catch {}
    }
    const cache = this.loadDashHostCache();
    this.upsertDashHostCache({
      account: {
        signedIn: true,
        email: cache?.account.email || "",
        name: cache?.account.name || "",
        userId: cache?.account.userId || "",
        emailVerified: Boolean(cache?.account.emailVerified),
        connectedAt: cache?.account.connectedAt,
      },
    });
    this.refreshDashViews();
  }

  private refreshDashViews() {
    if (this.dashWindows.size === 0) {
      return;
    }
    this.emitDashViewMessage("refreshBunnyDashState", {}, { raw: true });
  }

  private broadcastDashAuthTokenChanged(token: string) {
    for (const carrot of this.carrots.values()) {
      if (carrot.status === "running") {
        carrot.sendEvent("auth-token-changed", { token });
      }
    }
    this.refreshDashViews();
  }

  private async getCurrentMachineInfoForDash(): Promise<BunnyCloudMachineInfo> {
    const machineInfo = await app.getMachineInfo().catch(() => ({
      machineId: "",
      hostname: "",
      platform: "",
    }));
    const os = require("node:os");
    const machineId = machineInfo.machineId || this.getMachineId();
    const hostname = machineInfo.hostname || os.hostname() || "Bunny Ears";
    const platform = machineInfo.platform || process.platform;
    return {
      machineId,
      hostname,
      platform,
      instanceName: platform ? `${hostname} (${platform})` : hostname,
    };
  }

  private buildCurrentDashCarrotSummaries() {
    return Array.from(this.carrots.values()).map((carrot) => ({
      id: carrot.summary.id,
      name: carrot.summary.name,
      description: carrot.summary.description,
      version: carrot.summary.version,
      mode: carrot.summary.mode,
      status: carrot.summary.status,
      slateUIs: carrot.summary.slateUIs,
      contributions: carrot.summary.contributions,
    }));
  }

  private getDashCloudApiBaseUrl() {
    return getApiBaseUrl(this.channel);
  }

  private async ensureDashCloudAccessToken() {
    if (this.authToken) {
      return this.authToken;
    }
    return (await this.refreshAccessTokenFromDevice()) || null;
  }

  private async getDashCloudApi() {
    const accessToken = await this.ensureDashCloudAccessToken();
    if (!accessToken) {
      return null;
    }

    return new CloudApi(this.getDashCloudApiBaseUrl(), {
      getAuth: () => ({
        accessToken: this.authToken || accessToken,
        refreshToken: "",
      }),
      onTokenRefresh: ({ accessToken: nextAccessToken }) => {
        if (!nextAccessToken) {
          return;
        }
        this.saveAuthToken(nextAccessToken);
        this.broadcastDashAuthTokenChanged(nextAccessToken);
      },
    });
  }

  private async createDashDeviceToken(accessToken: string) {
    const machine = await this.getCurrentMachineInfoForDash();
    if (!machine.machineId) {
      return null;
    }

    const api = new CloudApi(this.getDashCloudApiBaseUrl(), {
      getAuth: () => ({
        accessToken,
        refreshToken: "",
      }),
      onTokenRefresh: () => {},
    });

    return api.createDeviceToken(machine.machineId, machine.instanceName);
  }

  private async buildDashBunnyCloudOverview(): Promise<BunnyCloudOverview> {
    const currentMachine = await this.getCurrentMachineInfoForDash();
    const api = await this.getDashCloudApi();

    if (!api) {
      return {
        connected: false,
        currentMachine,
        user: null,
        instances: [],
        workspaces: [],
        devices: [],
        currentInstanceId: null,
        currentDeviceTokenId: null,
        currentCarrots: this.buildCurrentDashCarrotSummaries(),
      };
    }

    const [user, instances, workspaces, devices] = await Promise.all([
      api.getUserProfile().catch(() => null),
      api.getInstances().catch(() => []),
      api.listWorkspaces().catch(() => []),
      api.getDeviceTokens().catch(() => []),
    ]);

    if (user) {
      this.upsertDashHostCache({
        account: {
          signedIn: true,
          email: user.email || "",
          name: user.name || "",
          userId: user.id || "",
          emailVerified: Boolean(user.email_verified),
        },
      });
    }

    const currentInstance = currentMachine.machineId
      ? instances.find((instance) => instance.machine_id === currentMachine.machineId) ||
        this.instance ||
        null
      : this.instance;

    if (currentInstance) {
      this.instance = currentInstance;
    }

    const currentDeviceTokenId = currentMachine.machineId
      ? devices.find((device) => device.machine_id === currentMachine.machineId)?.id ||
        this.deviceTokenId ||
        null
      : this.deviceTokenId;

    return {
      connected: true,
      currentMachine,
      user,
      instances,
      workspaces,
      devices,
      currentInstanceId: currentInstance?.id || null,
      currentDeviceTokenId,
      currentCarrots: this.buildCurrentDashCarrotSummaries(),
    };
  }

  private async completeDashCloudSignIn(accessToken: string) {
    await this.registerInstanceWithToken(accessToken).catch(() => {});

    const deviceToken = await this.createDashDeviceToken(accessToken).catch(() => null);
    if (deviceToken?.token) {
      this.saveDeviceToken(deviceToken.token, deviceToken.id);
      try { this.hopWs?.close(); } catch {}
      this.hopWs = null;
      this.connectToHop();
      this.refreshAccessTokenFromDevice().catch(() => {});
    }

    this.refreshDashViews();
  }

  private async loginDashBunnyCloud(params: {
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

    const response = await fetch(`${this.getDashCloudApiBaseUrl()}${endpoint}`, {
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

    if (!response.ok || !data.accessToken || !data.user) {
      throw new Error(data.error || `API ${response.status}`);
    }

    this.saveAuthToken(data.accessToken);
    this.upsertDashHostCache({
      account: {
        signedIn: true,
        email: data.user.email || "",
        name: data.user.name || "",
        userId: data.user.id || "",
        emailVerified: Boolean(data.user.email_verified),
      },
    });
    this.broadcastDashAuthTokenChanged(data.accessToken);
    void this.completeDashCloudSignIn(data.accessToken);

    return {
      connected: true,
      currentMachine: await this.getCurrentMachineInfoForDash(),
      user: data.user,
      instances: [],
      workspaces: [],
      devices: [],
      currentInstanceId: this.instance?.id || null,
      currentDeviceTokenId: this.deviceTokenId || null,
      currentCarrots: this.buildCurrentDashCarrotSummaries(),
    };
  }

  private async registerDashCurrentInstance(accessTokenOverride?: string) {
    const accessToken =
      accessTokenOverride || (await this.ensureDashCloudAccessToken());
    if (!accessToken) {
      throw new Error("Sign in to Bunny Cloud first");
    }

    const deviceToken = await this.createDashDeviceToken(accessToken).catch(() => null);
    if (deviceToken?.token) {
      this.saveDeviceToken(deviceToken.token, deviceToken.id);
      try { this.hopWs?.close(); } catch {}
      this.hopWs = null;
      this.connectToHop();
      this.refreshAccessTokenFromDevice().catch(() => {});
    }

    await this.registerInstanceWithToken(accessToken).catch(() => {});
    this.broadcastDashAuthTokenChanged(accessToken);
    return this.buildDashBunnyCloudOverview();
  }

  // Get a fresh short-lived access token by exchanging the device token.
  // Used to populate `this.authToken` and notify dash carrots.
  private async refreshAccessTokenFromDevice(): Promise<string | null> {
    if (!this.deviceToken) return null;
    const machineId = this.getMachineId();
    if (!machineId) return null;

    const apiBase = this.getDashCloudApiBaseUrl();

    try {
      const resp = await fetch(`${apiBase}/v1/auth/device-access-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine_id: machineId, device_token: this.deviceToken }),
      });
      if (!resp.ok) {
        console.log(`[bunny-ears] device-access-token failed: ${resp.status}`);
        if (resp.status === 401) {
          // Device token has been revoked or is otherwise invalid.
          // Clear everything and notify carrots so dash logs out.
          this.signOutFromCloud({ revokeDeviceTokenOnServer: false, markInstanceOffline: true });
          console.log("[bunny-ears] device token revoked — signed out");
        }
        return null;
      }
      const data = await resp.json() as { accessToken?: string };
      const token = data.accessToken || null;
      if (token) {
        this.saveAuthToken(token);
        this.broadcastDashAuthTokenChanged(token);
        this.registerInstanceWithToken(token).catch(() => {});
      }
      return token;
    } catch (err) {
      console.log(`[bunny-ears] device-access-token error: ${err}`);
      return null;
    }
  }

  private async getFarmUrl(): Promise<string> {
    try {
      const channel = await Updater.localInfo.channel();
      if (channel === "dev") return "http://localhost:5173";
      if (channel === "canary") return "https://staging-farm.electrobunny.ai";
    } catch {}
    return "https://farm.electrobunny.ai";
  }

  async getDashUiUrl(windowId?: string): Promise<string | null> {
    try {
      const channel = await Updater.localInfo.channel();
      let baseUrl = "https://dash.electrobunny.ai";
      if (channel === "dev") {
        baseUrl = "http://localhost:5174";
      } else if (channel === "canary") {
        baseUrl = "https://staging-dash.electrobunny.ai";
      }
      return await this.buildDashUiUrlWithHopBridge(baseUrl, windowId);
    } catch {
      return await this.buildDashUiUrlWithHopBridge("https://dash.electrobunny.ai", windowId);
    }
  }

  private async buildDashUiUrlWithHopBridge(baseUrl: string, windowId?: string): Promise<string> {
    const url = new URL(baseUrl);
    const accessToken = await this.ensureDashCloudAccessToken();
    const machineId = this.getMachineId() || "";
    url.searchParams.set("env", this.channel);
    if (windowId) {
      url.searchParams.set("dashWindowId", windowId);
    }
    if (machineId) {
      url.searchParams.set("dashBridgeInstanceId", machineId);
      url.searchParams.set("dashBridgeCarrotId", "dash-ui");
    }
    if (accessToken) {
      url.searchParams.set("dashBridgeAccessToken", accessToken);
    } else {
      console.warn(
        "[bunny-ears] Opening Dash without Hop bridge access token; remote Ears communication will be unavailable until Bunny Cloud is connected.",
      );
    }
    if (!machineId) {
      console.warn(
        "[bunny-ears] Opening Dash without machine id; local Ears communication will be unavailable.",
      );
    }
    if (this.deviceToken && !this.hopWs) {
      this.connectToHop();
    }
    return url.toString();
  }

  private async openFarmForLogin(): Promise<void> {
    const url = await this.getFarmUrl();
    return new Promise((resolve) => {
      bootLog("opening Farm for login", { url });

      const rpc = BrowserView.defineRPC({
        maxRequestTime: 300000, // 5 min for login flow
        handlers: {
          requests: {
            // Farm calls this after successful login
            getCarrots: () => {
              return runtime.summaries();
            },
            setAuthToken: ({ accessToken }: { accessToken: string }) => {
              this.saveAuthToken(accessToken);
              console.log(`[bunny-ears] Received auth token from Farm (len=${accessToken?.length || 0})`);
              // Immediately re-register the instance so it shows online in Farm
              // without waiting for the next 60s heartbeat tick.
              this.registerInstanceWithToken(accessToken).catch(() => {});
              this.broadcastDashAuthTokenChanged(accessToken);

              // Keep the Farm window open — user can see their dashboard.
              // Resize to a comfortable dashboard size.
              if (this.farmWindow) {
                this.farmWindow.setFrame(undefined, undefined, 960, 720);
                this.farmWindow.setTitle("Electrobunny Farm");
              }
              resolve();
              return { ok: true };
            },
            // Receives the long-lived device token from Farm after registration.
            setDeviceToken: ({ deviceToken, deviceTokenId }: { deviceToken: string; deviceTokenId?: string }) => {
              this.saveDeviceToken(deviceToken, deviceTokenId);
              console.log(`[bunny-ears] Received device token from Farm (len=${deviceToken?.length || 0}, id=${deviceTokenId || "none"})`);
              // Reconnect to Hop with the new device token
              try { this.hopWs?.close(); } catch {}
              this.hopWs = null;
              this.connectToHop();
              // Mint a fresh access token in the background
              this.refreshAccessTokenFromDevice().catch(() => {});
              return { ok: true };
            },
            // Allows Farm to read the local machine ID for device token registration.
            getMachineId: () => {
              return { machineId: this.getMachineId() || "" };
            },
            clearAuthToken: () => {
              this.signOutFromCloud();
              return { ok: true };
            },
            updateCarrots: () => {
              void this.handleTrayAction("update-carrots");
              return { ok: true };
            },
          },
          messages: {},
        },
      });

      this.farmWindow = new BrowserWindow({
        title: "Electrobunny — Sign In",
        url,
        rpc,
        frame: { width: 900, height: 700 },
      });

      // Send carrot data to the Farm webview when it's ready
      this.farmWindow.webview.on("dom-ready", () => {
        const carrots = runtime.summaries();
        const machineId = this.getMachineId();
        const os = require("node:os");
        const hostname = os.hostname() || "Unknown";
        const platform = process.platform === "darwin" ? "macOS"
          : process.platform === "win32" ? "Windows"
          : process.platform === "linux" ? "Linux"
          : process.platform;
        this.farmWindow?.webview.executeJavascript(`
          window.__bunnyEarsData = {
            machineId: ${JSON.stringify(machineId)},
            hostname: ${JSON.stringify(hostname)},
            platform: ${JSON.stringify(platform)},
            carrots: ${JSON.stringify(carrots)},
          };
          window.dispatchEvent(new CustomEvent('bunnyEarsData'));
        `);
      });

      // If user closes the window without logging in, continue boot anyway
      this.farmWindow.on("close", () => {
        this.farmWindow = null;
        resolve();
      });
    });
  }

  getMachineId(): string {
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const idPath = home ? path.join(home, ".electrobunny", this.channel, "machine-id") : "";

    if (idPath && fs.existsSync(idPath)) {
      return fs.readFileSync(idPath, "utf8").trim();
    }
    const id = crypto.randomUUID();
    if (idPath) {
      try {
        fs.mkdirSync(path.dirname(idPath), { recursive: true });
        fs.writeFileSync(idPath, id);
      } catch {}
    }
    return id;
  }

  async registerInstanceWithToken(accessToken: string): Promise<{ ok: boolean; instanceId?: string; error?: string }> {
    try {
      const os = require("node:os");
      const machineId = this.getMachineId();
      const hostname = os.hostname() || "Unknown";
      const platform = process.platform === "darwin" ? "macos" : process.platform;

      const channel = await Updater.localInfo.channel().catch(() => "dev");
      const apiBase = channel === "dev" ? "http://localhost:8787"
        : channel === "canary" ? "https://staging-api.electrobunny.ai"
        : "https://api.electrobunny.ai";

      const response = await fetch(`${apiBase}/v1/instances`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          machine_id: machineId,
          name: hostname,
          os: platform,
        }),
      });

      if (!response.ok) {
        return { ok: false, error: `API ${response.status}` };
      }

      const data = await response.json() as { instance?: CloudInstance };
      const instance = data.instance || null;
      if (instance) this.instance = instance;
      const instanceId = instance?.id || null;
      console.log(`[bunny-ears] Instance registered: ${data.instance?.name} (${instanceId})`);
      return { ok: true, instanceId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bunny-ears] Instance registration failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  summaries() {
    return Array.from(this.carrots.values()).map((carrot) => carrot.summary);
  }

  dashboardState(): DashboardState {
    return {
      installRoot: getInstalledCarrotsRoot(),
      carrots: this.summaries(),
    };
  }

  notifyDashboardChanged() {
    this.tray?.setMenu(this.buildTrayMenu());
    (this.managerWindow?.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
  }

  private getPreferredDashWindowId() {
    const cachedWindowId = this.loadDashHostCache()?.currentWindow?.windowId;
    if (cachedWindowId) {
      return cachedWindowId;
    }
    return this.dashWindows.keys().next().value ?? "main";
  }

  private async ensureDashWindowForMenuAction() {
    const windowId = this.getPreferredDashWindowId();
    await this.openDashWindow(windowId);
    return {
      windowId,
    };
  }

  private async sendDashViewMessage(name: string, payload?: unknown) {
    const target = await this.ensureDashWindowForMenuAction();
    if (!target) {
      return;
    }
    this.emitDashViewMessage(name, payload, {
      raw: true,
      windowId: target.windowId,
    });
  }

  private openDashAboutWindow(url: string) {
    const id = `dash-about-${Date.now().toString(36)}`;
    const win = new BrowserWindow({
      id,
      title: "About Dash",
      url,
      frame: {
        width: 800,
        height: 800,
        x: 120,
        y: 120,
      },
    });
    win.on("close", () => {
      try {
        win.destroy();
      } catch {}
    });
  }

  private async handleDashApplicationMenuAction(action: string) {
    if (action === "terms-of-service") {
      this.openDashAboutWindow("https://blackboard.sh/terms");
      return;
    }
    if (action === "privacy-statement") {
      this.openDashAboutWindow("https://blackboard.sh/privacy");
      return;
    }
    if (action === "acknowledgements") {
      this.openDashAboutWindow("views://assets/licenses.html");
      return;
    }
    if (action === "open-file") {
      const files = await Utils.openFileDialog({
        startingFolder: process.env.HOME || "",
        allowedFileTypes: "",
        canChooseFiles: true,
        canChooseDirectory: false,
        allowsMultipleSelection: true,
      });
      for (const filePath of files) {
        await this.sendDashViewMessage("openFileInEditor", {
          filePath,
          createIfNotExists: false,
        });
      }
      return;
    }
    if (action === "open-folder") {
      const folders = await Utils.openFileDialog({
        startingFolder: process.env.HOME || "",
        allowedFileTypes: "",
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      });
      for (const folderPath of folders) {
        await this.sendDashViewMessage("openFolderAsProject", { folderPath });
      }
      return;
    }
    if (action === "open-command-palette") {
      await this.sendDashViewMessage("openCommandPalette", {});
      return;
    }
    if (action === "new-browser-tab") {
      await this.sendDashViewMessage("newBrowserTab", {});
      return;
    }
    if (action === "close-tab") {
      await this.sendDashViewMessage("closeCurrentTab", {});
      return;
    }
    if (action === "close-window") {
      await this.sendDashViewMessage("closeCurrentWindow", {});
      return;
    }
    if (action === "bunny-settings") {
      await this.sendDashViewMessage("openSettings", { settingsType: "global-settings" });
      return;
    }
    if (action === "workspace-settings") {
      await this.sendDashViewMessage("openSettings", { settingsType: "workspace-settings" });
      return;
    }
    if (action.startsWith("global-shortcut:")) {
      const accelerator = action.replace("global-shortcut:", "");
      const shortcut = dashBuiltInShortcuts.find(
        (candidate) => candidate.accelerator === accelerator,
      );
      if (!shortcut) {
        return;
      }
      await this.sendDashViewMessage("handleGlobalShortcut", {
        key: shortcut.key,
        ctrl: shortcut.ctrl,
        shift: shortcut.shift,
        alt: shortcut.alt,
        meta: shortcut.meta,
      });
    }
  }

  private defaultApplicationMenu() {
    return [
      {
        label: "Dash",
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
            label: "Dash Settings",
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
    ];
  }

  private installApplicationMenu(menu: any[]) {
    ApplicationMenu.setApplicationMenu(menu);
  }

  private getDashWindowIdFromBridgePayload(
    payload: unknown,
    fallback?: string,
  ) {
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as { windowId?: unknown }).windowId === "string"
    ) {
      return (payload as { windowId: string }).windowId;
    }
    return fallback;
  }

  private getLocalDashWindowIdFromBridgePayload(
    payload: unknown,
    fallback: string,
  ) {
    const requestedWindowId =
      payload &&
      typeof payload === "object" &&
      typeof (payload as { windowId?: unknown }).windowId === "string"
        ? (payload as { windowId: string }).windowId
        : "";
    if (requestedWindowId && this.dashWindows.has(requestedWindowId)) {
      return requestedWindowId;
    }
    return fallback || this.getPrimaryDashWindowId();
  }

  private async dispatchDashBridgeRequest(
    method: string,
    params: unknown,
    sourceWindowId?: string,
  ) {
    const dashHopRequest = await this.handleDashHopRequest(
      method,
      params,
      sourceWindowId,
    );
    if (dashHopRequest.handled) {
      return dashHopRequest.result;
    }
    if (method === "invokeCarrot") {
      return this.deliverCarrotInvokeFrom(
        "dash-ui",
        String((params as any)?.carrotId || ""),
        String((params as any)?.method || ""),
        (params as any)?.params,
        typeof (params as any)?.windowId === "string"
          ? (params as any).windowId
          : sourceWindowId,
      );
    }
    throw new Error(`Unknown Dash UI bridge request: ${method}`);
  }

  private async dispatchDashBridgeMessage(
    name: string,
    payload: unknown,
    sourceWindowId?: string,
  ) {
    const dashHopMessage = await this.handleDashHopSend(
      name,
      payload,
      sourceWindowId,
    );
    if (!dashHopMessage.handled) {
      console.warn(`[dash-bridge] Unhandled Dash UI message: ${name}`);
    }
  }

  private async handleLocalDashBridgePayload(
    windowId: string,
    payload: unknown,
  ) {
    const bridgePayload =
      payload && typeof payload === "object" ? (payload as any) : {};

    if (bridgePayload.type === "request") {
      const requestId = bridgePayload.id;
      try {
        const params = bridgePayload.params;
        const result = await this.dispatchDashBridgeRequest(
          String(bridgePayload.method || ""),
          params,
          this.getLocalDashWindowIdFromBridgePayload(params, windowId),
        );
        return {
          type: "response",
          id: requestId,
          success: true,
          payload: result,
        };
      } catch (error) {
        return {
          type: "response",
          id: requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (bridgePayload.type === "message") {
      const messagePayload = bridgePayload.payload;
      await this.dispatchDashBridgeMessage(
        String(bridgePayload.id || ""),
        messagePayload,
        this.getLocalDashWindowIdFromBridgePayload(messagePayload, windowId),
      );
      return {
        type: "response",
        id: bridgePayload.id,
        success: true,
        payload: { ok: true },
      };
    }

    return {
      type: "response",
      id: bridgePayload.id,
      success: false,
      error: "Unknown Dash bridge payload",
    };
  }

  private async handleDashHopRequest(
    method: string,
    params: unknown,
    sourceWindowId?: string,
  ): Promise<{ handled: boolean; result?: unknown }> {
    const invokeFs = (fsMethod: string) =>
      this.deliverCarrotInvokeFrom("dash-ui", "bunny.fs", fsMethod, params, sourceWindowId);

    switch (method) {
      case "logoutBunnyCloud":
        this.signOutFromCloud();
        return { handled: true, result: { ok: true } };
      case "getBunnyCloudOverview":
        return {
          handled: true,
          result: await this.buildDashBunnyCloudOverview(),
        };
      case "getDashHostBootState": {
        const bootStateParams = params as {
          windowId?: string;
          workspaceId?: string;
        } | null;
        console.log("[bunny-ears] getDashHostBootState request", {
          sourceWindowId: sourceWindowId || "",
          windowId: String(bootStateParams?.windowId || ""),
          workspaceId: String(bootStateParams?.workspaceId || ""),
        });
        return {
          handled: true,
          result: this.buildDashHostBootState(
            String(bootStateParams?.windowId || sourceWindowId || ""),
            String(bootStateParams?.workspaceId || ""),
          ),
        };
      }
      case "getMachineConnectionStatus":
        return {
          handled: true,
          result: await this.buildDashMachineConnectionStatus(),
        };
      case "listLocalWorkspaces":
        return {
          handled: true,
          result: {
            ok: true,
            workspaces: this.ensureDashLocalWorkspaces(),
          },
        };
      case "createLocalWorkspace": {
        const request = (params || {}) as {
          workspaceId?: string;
          name?: string;
          subtitle?: string;
        };
        const workspace = this.createDashLocalWorkspace({
          workspaceId: request.workspaceId,
          name: request.name,
          subtitle: request.subtitle,
        });
        return {
          handled: true,
          result: {
            ok: true,
            workspace,
            bootState: this.buildDashHostBootState(sourceWindowId, workspace.id),
          },
        };
      }
      case "loginBunnyCloud": {
        try {
          const request = (params || {}) as {
            mode?: "login" | "register";
            email?: string;
            password?: string;
            name?: string;
          };
          return {
            handled: true,
            result: {
              ok: true,
              overview: await this.loginDashBunnyCloud({
                mode: request.mode === "register" ? "register" : "login",
                email: String(request.email || "").trim(),
                password: String(request.password || ""),
                name: typeof request.name === "string" ? request.name : undefined,
              }),
            },
          };
        } catch (error) {
          return {
            handled: true,
            result: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      case "registerCurrentBunnyCloudInstance": {
        try {
          const request = (params || {}) as {
            accessToken?: string;
          };
          return {
            handled: true,
            result: {
              ok: true,
              overview: await this.registerDashCurrentInstance(
                typeof request.accessToken === "string" ? request.accessToken : undefined,
              ),
            },
          };
        } catch (error) {
          return {
            handled: true,
            result: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      case "updateCurrentBunnyCloudCarrots": {
        await app.updateCarrots();
        if (this.authToken) {
          this.broadcastDashAuthTokenChanged(this.authToken);
        }
        return {
          handled: true,
          result: {
            ok: true,
            overview: await this.buildDashBunnyCloudOverview(),
          },
        };
      }
      case "createBunnyCloudWorkspace": {
        const api = await this.getDashCloudApi();
        if (!api) {
          throw new Error("Not signed in to Bunny Cloud");
        }
        await api.createWorkspace(
          String((params as { name?: string } | undefined)?.name || "").trim(),
          typeof (params as { description?: unknown } | undefined)?.description === "string"
            ? ((params as { description: string }).description)
            : undefined,
        );
        if (this.authToken) {
          this.broadcastDashAuthTokenChanged(this.authToken);
        }
        return {
          handled: true,
          result: {
            ok: true,
            overview: await this.buildDashBunnyCloudOverview(),
          },
        };
      }
      case "removeBunnyCloudInstance": {
        const api = await this.getDashCloudApi();
        if (!api) {
          throw new Error("Not signed in to Bunny Cloud");
        }
        await api.deleteInstance(
          String((params as { instanceId?: string } | undefined)?.instanceId || ""),
        );
        if (this.authToken) {
          this.broadcastDashAuthTokenChanged(this.authToken);
        }
        return {
          handled: true,
          result: {
            ok: true,
            overview: await this.buildDashBunnyCloudOverview(),
          },
        };
      }
      case "revokeBunnyCloudDevice": {
        const api = await this.getDashCloudApi();
        if (!api) {
          throw new Error("Not signed in to Bunny Cloud");
        }
        await api.deleteDeviceToken(
          String((params as { deviceTokenId?: string } | undefined)?.deviceTokenId || ""),
        );
        if (this.authToken) {
          this.broadcastDashAuthTokenChanged(this.authToken);
        }
        return {
          handled: true,
          result: {
            ok: true,
            overview: await this.buildDashBunnyCloudOverview(),
          },
        };
      }
      case "openFileDialog": {
        const options = (params || {}) as {
          startingFolder?: string;
          allowedFileTypes?: string;
          canChooseFiles?: boolean;
          canChooseDirectory?: boolean;
          allowsMultipleSelection?: boolean;
        };
        return {
          handled: true,
          result: Utils.openFileDialog({
            startingFolder: options.startingFolder,
            allowedFileTypes: options.allowedFileTypes,
            canChooseFiles: options.canChooseFiles,
            canChooseDirectory: options.canChooseDirectory,
            allowsMultipleSelection: options.allowsMultipleSelection,
          }),
        };
      }
      case "showInFinder": {
        await Utils.showItemInFolder(
          String((params as { path?: string } | undefined)?.path || ""),
        );
        return { handled: true, result: undefined };
      }
      case "getNode":
      case "readSlateConfigFile":
      case "readFile":
      case "writeFile":
      case "touchFile":
      case "rename":
      case "exists":
      case "isFolder":
      case "mkdir":
      case "copy":
      case "safeDeleteFileOrFolder":
      case "safeTrashFileOrFolder":
      case "makeFileNameSafe":
      case "getUniqueNewName":
      case "findFirstNestedGitRepo":
        return {
          handled: true,
          result: await invokeFs(method),
        };
      default:
        return { handled: false };
    }
  }

  private async handleDashHopSend(
    name: string,
    payload: unknown,
    sourceWindowId?: string,
  ): Promise<{ handled: boolean }> {
    switch (name) {
      case "openBunnyWindow":
        app.openBunnyWindow({
          screenX: typeof (payload as { screenX?: unknown } | undefined)?.screenX === "number"
            ? ((payload as { screenX: number }).screenX)
            : undefined,
          screenY: typeof (payload as { screenY?: unknown } | undefined)?.screenY === "number"
            ? ((payload as { screenY: number }).screenY)
            : undefined,
        });
        return { handled: true };
      case "closeWindow": {
        const targetWindowId =
          typeof (payload as { windowId?: unknown } | undefined)?.windowId === "string"
            ? ((payload as { windowId: string }).windowId)
            : sourceWindowId;
        await this.requestCloseDashWindow(targetWindowId);
        return { handled: true };
      }
      case "minimizeWindow":
      case "toggleMaximizeWindow": {
        const targetWindowId =
          typeof (payload as { windowId?: unknown } | undefined)?.windowId === "string"
            ? ((payload as { windowId: string }).windowId)
            : sourceWindowId;
        const targetWindow = this.getDashWindow(targetWindowId || undefined);
        if (targetWindow) {
          if (name === "minimizeWindow") {
            targetWindow.minimize();
          } else if (targetWindow.isMaximized()) {
            targetWindow.unmaximize();
          } else {
            targetWindow.maximize();
          }
        }
        return { handled: true };
      }
      case "createHostWindow": {
        const createPayload =
          payload && typeof payload === "object"
            ? (payload as {
                windowId?: string;
                title?: string;
                frame?: {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                };
              })
            : {};
        await this.openDashWindow(
          String(createPayload.windowId || sourceWindowId || "main"),
          {
            title:
              typeof createPayload.title === "string"
                ? createPayload.title
                : undefined,
            frame: createPayload.frame,
          },
        );
        return { handled: true };
      }
      case "syncDashHostCache": {
        const cachePayload =
          payload && typeof payload === "object"
            ? (payload as Partial<DashHostSummaryCache>)
            : {};
        this.upsertDashHostCache(cachePayload);
        return { handled: true };
      }
      case "installUpdateNow":
        Updater.applyUpdate();
        return { handled: true };
      case "track":
      case "addToken":
      case "deleteToken":
      case "syncDevlink":
        return { handled: true };
      default:
        return { handled: false };
    }
  }

  private restoreDefaultApplicationMenu() {
    this.activeApplicationMenuOwnerId = null;
    this.installApplicationMenu(this.defaultApplicationMenu());
  }

  activateCarrotApplicationMenu(carrot: CarrotInstance) {
    if (Array.isArray(carrot.applicationMenu) && carrot.applicationMenu.length > 0) {
      this.activeApplicationMenuOwnerId = carrot.carrot.manifest.id;
      this.installApplicationMenu(carrot.applicationMenu);
      return;
    }

    this.restoreDefaultApplicationMenu();
  }

  restoreApplicationMenuIfOwner(carrot: CarrotInstance) {
    if (this.activeApplicationMenuOwnerId !== carrot.carrot.manifest.id) {
      return;
    }

    const nextOwner = Array.from(this.carrots.values()).find(
      (candidate) =>
        candidate !== carrot &&
        candidate.status === "running" &&
        candidate.controllerWindows.size > 0 &&
        Array.isArray(candidate.applicationMenu) &&
        candidate.applicationMenu.length > 0,
    );

    if (nextOwner) {
      this.activateCarrotApplicationMenu(nextOwner);
      return;
    }

    this.restoreDefaultApplicationMenu();
  }

  private withSourceEnvelope(
    sourceCarrotId: string,
    sourceWindowId: string | undefined,
    payload: unknown,
  ) {
    const source = {
      carrotId: sourceCarrotId,
      windowId: sourceWindowId ?? null,
    };

    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return {
        ...(payload as Record<string, unknown>),
        __source: source,
      };
    }

    return {
      value: payload,
      __source: source,
    };
  }

  private async sendHopRuntimeRequest<T = unknown>(
    targetMachineId: string,
    method: string,
    params?: unknown,
  ): Promise<T> {
    const normalizedMachineId = String(targetMachineId || "").trim();
    if (!normalizedMachineId) {
      throw new Error("Missing target Hop instance id");
    }

    const accessToken = await this.ensureDashCloudAccessToken();
    if (this.channel !== "dev" && !accessToken) {
      throw new Error("Hop access token unavailable");
    }

    const url = `${this.getHopWsBaseUrl()}/ws/${encodeURIComponent(normalizedMachineId)}/bunny-ears${accessToken ? `?token=${encodeURIComponent(accessToken)}` : ""}`;
    const requestId = Date.now() + Math.floor(Math.random() * 1_000_000);

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: Error, value?: T) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        try {
          ws.close();
        } catch {}
        if (error) {
          reject(error);
        } else {
          resolve(value as T);
        }
      };

      timeout = setTimeout(() => {
        finish(new Error(`Timed out waiting for Hop runtime response: ${method}`));
      }, 15_000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({
          type: "request",
          id: requestId,
          method,
          params,
        }));
      });

      ws.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data || "{}"));
          if (message?.type !== "response" || message.id !== requestId) {
            return;
          }
          if (message.success === false || message.error) {
            finish(new Error(String(message.error || "Hop runtime request failed")));
            return;
          }
          finish(undefined, (message.payload ?? message.result) as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws.addEventListener("error", () => {
        finish(new Error(`Hop runtime request failed: ${method}`));
      });

      ws.addEventListener("close", () => {
        if (!settled) {
          finish(new Error(`Hop runtime connection closed: ${method}`));
        }
      });
    });
  }

  private shouldUseLocalCarrotShortCircuit(
    targetCarrotId: string,
    targetMachineId?: string | null,
  ) {
    if (!targetCarrotId || targetCarrotId === "dash-ui" || targetCarrotId === "bunny-ears") {
      return false;
    }
    const normalizedTargetMachineId = String(targetMachineId || "").trim();
    if (!normalizedTargetMachineId) {
      return true;
    }
    const localMachineId = this.getMachineId();
    return (
      normalizedTargetMachineId === localMachineId ||
      normalizedTargetMachineId === `local:${localMachineId}`
    );
  }

  async invokeCarrotFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    method: string,
    params?: unknown,
    sourceWindowId?: string,
    targetMachineId?: string,
  ) {
    if (this.shouldUseLocalCarrotShortCircuit(targetCarrotId, targetMachineId)) {
      bridgeLog("invokeCarrotFrom:local-short-circuit", {
        sourceCarrotId,
        targetCarrotId,
        method,
        sourceWindowId: sourceWindowId || "",
        params: summarizeBridgeValue(params),
      });
      return this.deliverCarrotInvokeFrom(
        sourceCarrotId,
        targetCarrotId,
        method,
        params,
        sourceWindowId,
      );
    }

    const machineId = String(targetMachineId || this.getMachineId() || "").trim();
    return this.sendHopRuntimeRequest(machineId, "invokeCarrot", {
      sourceCarrotId,
      targetCarrotId,
      method,
      params,
      windowId: sourceWindowId,
    });
  }

  async deliverCarrotInvokeFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    method: string,
    params?: unknown,
    sourceWindowId?: string,
  ) {
    if (!targetCarrotId) {
      throw new Error("Missing target carrot id");
    }
    if (!method) {
      throw new Error("Missing target carrot method");
    }
    const startedAt = Date.now();
    bridgeLog("deliverCarrotInvokeFrom:start", {
      sourceCarrotId,
      targetCarrotId,
      method,
      sourceWindowId: sourceWindowId || "",
      params: summarizeBridgeValue(params),
    });

    const target = this.carrots.get(targetCarrotId);
    if (!target) {
      bridgeLog("deliverCarrotInvokeFrom:error", {
        sourceCarrotId,
        targetCarrotId,
        method,
        sourceWindowId: sourceWindowId || "",
        durationMs: Date.now() - startedAt,
        error: `Target carrot not installed: ${targetCarrotId}`,
      });
      throw new Error(`Target carrot not installed: ${targetCarrotId}`);
    }

    const wasStopped = target.status === "stopped";
    if (target.status !== "running") {
      await target.start();
      if (wasStopped && target.carrot.manifest.mode === "background") {
        target.sendEvent("boot");
      }
    }

    try {
      const result = await target.invoke(
        method,
        this.withSourceEnvelope(sourceCarrotId, sourceWindowId, params),
      );
      bridgeLog("deliverCarrotInvokeFrom:ok", {
        sourceCarrotId,
        targetCarrotId,
        method,
        sourceWindowId: sourceWindowId || "",
        durationMs: Date.now() - startedAt,
        result: summarizeBridgeValue(result),
      });
      return result;
    } catch (error) {
      bridgeLog("deliverCarrotInvokeFrom:error", {
        sourceCarrotId,
        targetCarrotId,
        method,
        sourceWindowId: sourceWindowId || "",
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  emitCarrotEventFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    name: string,
    payload?: unknown,
  ) {
    if (!targetCarrotId || !name) {
      return;
    }

    if (this.shouldUseLocalCarrotShortCircuit(targetCarrotId)) {
      this.deliverCarrotEventFrom(sourceCarrotId, targetCarrotId, name, payload);
      return;
    }

    void this.sendHopRuntimeRequest(this.getMachineId() || "", "emitCarrotEvent", {
      sourceCarrotId,
      targetCarrotId,
      name,
      payload,
    }).catch((error) => {
      console.warn(
        "[hop] Failed to emit carrot event:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  deliverCarrotEventFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    name: string,
    payload?: unknown,
  ) {
    if (!targetCarrotId || !name) {
      return;
    }

    const target = this.carrots.get(targetCarrotId);
    if (!target || target.status !== "running") {
      return;
    }

    target.sendEvent(name, this.withSourceEnvelope(sourceCarrotId, undefined, payload));
  }

  emitCarrotViewEventFrom(
    sourceCarrotId: string,
    targetCarrotId: string,
    name: string,
    payload?: unknown,
    options?: {
      raw?: boolean;
      windowId?: string;
    },
  ) {
    if (!targetCarrotId || !name) {
      return;
    }

    bridgeLog("emitCarrotViewEventFrom", {
      sourceCarrotId,
      targetCarrotId,
      name,
      windowId: options?.windowId || "",
      raw: Boolean(options?.raw),
      payload: summarizeBridgeValue(payload),
    });

    if (
      targetCarrotId === "dash-ui" &&
      (options?.windowId
        ? this.dashWindows.has(options.windowId)
        : this.dashWindows.size > 0)
    ) {
      this.deliverCarrotViewEventFrom(
        sourceCarrotId,
        targetCarrotId,
        name,
        payload,
        options,
      );
      return;
    }

    if (this.shouldUseLocalCarrotShortCircuit(targetCarrotId)) {
      this.deliverCarrotViewEventFrom(
        sourceCarrotId,
        targetCarrotId,
        name,
        payload,
        options,
      );
      return;
    }

    void this.sendHopRuntimeRequest(this.getMachineId() || "", "emitCarrotViewEvent", {
      sourceCarrotId,
      targetCarrotId,
      name,
      payload,
      raw: Boolean(options?.raw),
      windowId: options?.windowId,
    }).catch((error) => {
      console.warn(
        "[hop] Failed to emit carrot view event:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  deliverCarrotViewEventFrom(
    _sourceCarrotId: string,
    targetCarrotId: string,
    name: string,
    payload?: unknown,
    options?: {
      raw?: boolean;
      windowId?: string;
    },
  ) {
    if (!targetCarrotId || !name) {
      return;
    }

    if (targetCarrotId === "dash-ui") {
      this.emitDashViewMessage(name, payload, options);
      return;
    }

    const target = this.carrots.get(targetCarrotId);
    if (!target) {
      return;
    }
    target.emitViewMessage(name, payload, options);
  }

  buildTrayMenu() {
    const cloudLabel = this.authToken || this.deviceToken
      ? "Open Bunny Cloud"
      : "Sign In to Bunny Cloud";

    const baseItems = [
      { type: "normal" as const, label: "Open Dash", action: "open-dash" },
      { type: "normal" as const, label: cloudLabel, action: "open-farm" },
    ];

    const updateLabel = this.updateStatus === "update-ready"
      ? "Restart to Update"
      : this.updateStatus === "downloading"
        ? "Downloading Update..."
        : "Check for Updates";

    const emergencyItems = [
      { type: "divider" as const },
      { type: "normal" as const, label: updateLabel, action: "check-for-updates" },
      { type: "normal" as const, label: "Update Carrots", action: "update-carrots" },
      { type: "normal" as const, label: "Reset Local State", action: "emergency-reset" },
      { type: "normal" as const, label: "Quit Dash", action: "quit" },
      { type: "normal" as const, label: "Test 1", action: "test" },
    ];

    return [...baseItems, ...emergencyItems];
  }

  private async handleTrayAction(action: string) {
    if (action === "open-dash") {
      this.restoreDefaultApplicationMenu();
      const dashCache = this.loadDashHostCache();
      const cachedWindows =
        Array.isArray(dashCache?.windows) && dashCache.windows.length > 0
          ? dashCache.windows
          : [];

      if (this.dashWindows.size > 0) {
        const targetWindow =
          cachedWindows.find((window) => this.dashWindows.has(window.windowId)) ||
          cachedWindows[0];
        await this.openDashWindow(targetWindow?.windowId, {
          title: targetWindow?.title,
          frame: targetWindow?.frame,
        });
        return;
      }

      if (cachedWindows.length > 0) {
        for (const window of cachedWindows) {
          await this.openDashWindow(window.windowId, {
            title: window.title,
            frame: window.frame,
          });
        }
        return;
      }

      await this.openDashWindow("main");
      return;
    }
    if (action === "open-farm") {
      if (this.farmWindow) {
        this.farmWindow.focus();
      } else {
        this.openFarmForLogin().catch(() => {});
      }
      return;
    }
    if (action === "install-artifact") {
      await this.installCarrotArtifactFromDisk();
      return;
    }
    if (action === "update-carrots") {
      console.log("[bunny-ears] Updating carrots...");
      const ch = await Updater.localInfo.channel().catch(() => "dev");
      if (ch !== "dev") {
        // Stop all running carrots so files aren't locked during the download
        for (const carrot of this.carrots.values()) {
          if (carrot.status === "running") {
            try { await carrot.stop(); } catch {}
          }
        }
        this.carrots.clear();

        try {
          await installFoundationCarrotsFromR2(ch, true);
          console.log("[bunny-ears] Carrots updated, restarting Bunny Ears...");
        } catch (err) {
          console.error("[bunny-ears] Carrot update failed:", err);
          return;
        }

        // Restart the whole process — restarting workers in-place causes
        // segfaults due to dangling references in still-open windows.
        // The detached shell waits for this process to exit then relaunches.
        try {
          if (process.platform === "darwin") {
            const pathMod = require("node:path");
            // process.execPath is .../Contents/MacOS/bun → app bundle is two dirs up
            const appBundlePath = pathMod.resolve(pathMod.dirname(process.execPath), "..", "..");
            const pid = process.pid;
            Bun.spawn(
              [
                "sh",
                "-c",
                `while kill -0 ${pid} 2>/dev/null; do sleep 0.5; done; sleep 1; open "${appBundlePath}"`,
              ],
              { detached: true, stdio: ["ignore", "ignore", "ignore"] } as any,
            );
          }
        } catch (err) {
          console.error("[bunny-ears] Failed to schedule restart:", err);
        }
        process.exit(0);
      }
      return;
    }
    if (action === "check-for-updates") {
      if (this.updateStatus === "update-ready") {
        Updater.applyUpdate();
      } else {
        this.checkForUpdates();
      }
      return;
    }
    if (action === "quit") {
      await this.shutdown(0);
      return;
    }
    if (action === "emergency-reset") {
      // Stop all carrots and wipe their state
      for (const carrot of this.carrots.values()) {
        if (carrot.status === "running") {
          try { await carrot.stop(); } catch {}
        }
        // Wipe carrot state
        const stateDir = carrot.stateDir;
        try {
          const { rmSync } = await import("node:fs");
          rmSync(stateDir, { recursive: true, force: true });
        } catch {}
      }
      try {
        const { rmSync } = await import("node:fs");
        rmSync(this.getDashHostCachePath(), { force: true });
        rmSync(this.getDashLocalWorkspacesPath(), { force: true });
        rmSync(this.getDashHomeDir(), { recursive: true, force: true });
      } catch (error) {
        console.error("[bunny-ears] Failed to clear Dash local state:", error);
      }
      console.log("[bunny-ears] Emergency reset complete. Restarting...");
      process.exit(0);
      return;
    }
    const [verb, ...rest] = action.split(":");
    const carrotId = rest.join(":");
    const carrot = carrotId ? this.carrots.get(carrotId) : null;
    if (!carrot) return;
    if (verb === "start") {
      await carrot.start();
      if (carrot.carrot.manifest.mode === "background") {
        carrot.sendEvent("boot");
      }
      return;
    }
    if (verb === "stop") {
      await carrot.stop();
      return;
    }
    if (verb === "rebuild") {
      await this.reinstallCarrot(carrotId);
      return;
    }
  }

  private async installPreparedCarrot(
    prepared: PreparedCarrotInstall,
    options: { preserveRunningState?: boolean } = {},
  ) {
    try {
      const installed = await prepared.install();
      await this.upsertInstalledCarrot(installed, {
        openWindow: installed.manifest.mode === "window",
        preserveRunningState: options.preserveRunningState,
      });
      return { ok: true, id: installed.manifest.id };
    } finally {
      prepared.cleanup();
    }
  }

  private async queuePreparedInstall(
    prepared: PreparedCarrotInstall,
    options: { preserveRunningState?: boolean } = {},
  ) {
    return await this.installPreparedCarrot(prepared, options);
  }

  private async installCarrotSourceFromDisk() {
    const selectedPaths = await Utils.openFileDialog({
      startingFolder: Utils.paths.documents,
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });

    const selectedPath = selectedPaths[0];
    if (!selectedPath) {
      return { ok: false, reason: "canceled" };
    }

    try {
      const prepared = await prepareDevCarrotInstallFromSource(selectedPath);
      return await this.queuePreparedInstall(prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot source install failed",
        message,
      });
      return { ok: false, error: message };
    }
  }

  private async installCarrotArtifactFromDisk() {
    const selectedPaths = await Utils.openFileDialog({
      startingFolder: Utils.paths.documents,
      canChooseFiles: true,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    });

    const selectedPath = selectedPaths[0];
    if (!selectedPath) {
      return { ok: false, reason: "canceled" };
    }

    try {
      const prepared = await prepareArtifactCarrotInstall(selectedPath);
      return await this.queuePreparedInstall(prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot artifact install failed",
        message,
      });
      return { ok: false, error: message };
    }
  }

  private async reinstallCarrot(id: string) {
    try {
      const installed = this.carrots.get(id)?.carrot ?? getInstalledCarrot(id);
      if (!installed) {
        return { ok: false, error: "Carrot not found" };
      }

      let prepared: PreparedCarrotInstall;
      if (installed.install.source.kind === "local") {
        prepared = await prepareDevCarrotInstallFromSource(installed.install.source.path);
      } else if (installed.install.source.kind === "artifact") {
        const artifactLocation =
          installed.install.source.updateLocation ??
          installed.install.source.tarballLocation ??
          installed.install.source.location;
        prepared = await prepareArtifactCarrotInstall(artifactLocation);
      } else {
        return { ok: false, error: "Prototype carrots cannot be reinstalled" };
      }

      return await this.queuePreparedInstall(prepared, {
        preserveRunningState: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot reinstall failed",
        message,
      });
      this.refreshInstalledCarrot(id);
      return { ok: false, error: message };
    }
  }

  private async uninstallCarrot(id: string) {
    const carrot = this.carrots.get(id);
    if (!carrot) {
      return { ok: false, reason: "missing" };
    }

    const confirmed = await requestCarrotUninstallConsent(carrot.carrot.manifest.name);
    if (!confirmed) {
      return { ok: false, reason: "canceled" };
    }

    await carrot.stop();
    uninstallInstalledCarrot(id);
    this.carrots.delete(id);
    this.notifyDashboardChanged();
    return { ok: true };
  }

  private async revealCarrot(id: string) {
    const carrot = this.carrots.get(id);
    if (!carrot) {
      return { ok: false };
    }

    const source = carrot.carrot.install.source;
    let targetPath: string | null = null;

    if (source.kind === "local") {
      targetPath = source.path;
    } else if (source.kind === "artifact") {
      if (/^https?:\/\//i.test(source.location)) {
        Utils.openExternal(source.location);
        return { ok: true };
      }
      targetPath = source.location;
    } else {
      targetPath = carrot.carrot.rootDir;
    }

    if (!targetPath) {
      return { ok: false };
    }

    if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
      Utils.openPath(targetPath);
    } else {
      Utils.showItemInFolder(targetPath);
    }

    return { ok: true };
  }

  private refreshInstalledCarrot(id: string) {
    const installed = loadInstalledCarrots().find((carrot) => carrot.manifest.id === id);
    if (!installed) {
      return;
    }

    const existing = this.carrots.get(id);
    if (existing) {
      existing.carrot = installed;
    } else {
      this.carrots.set(id, new CarrotInstance(installed));
    }
    this.notifyDashboardChanged();
  }

  private async upsertInstalledCarrot(
    installed: InstalledCarrot,
    options: { openWindow?: boolean; preserveRunningState?: boolean } = {},
  ) {
    const existing = this.carrots.get(installed.manifest.id);
    const wasRunning = existing?.status === "running";
    const existingLogs = existing?.logs ?? [];

    if (existing) {
      await existing.stop();
    }

    const instance = new CarrotInstance(installed);
    instance.logs = existingLogs;
    this.carrots.set(installed.manifest.id, instance);
    this.notifyDashboardChanged();

    const shouldStart =
      installed.manifest.mode === "background" ||
      options.openWindow === true ||
      (options.preserveRunningState === true && wasRunning);

    if (!shouldStart) {
      return;
    }

    await instance.start();
    if (installed.manifest.mode === "background") {
      instance.sendEvent("boot");
      return;
    }
    if (options.openWindow === true || wasRunning) {
      await instance.openWindow();
    }
  }

  private openManagerWindow() {
    if (this.managerWindow) {
      bootLog("manager window focus existing");
      this.managerWindow.focus();
      return;
    }

    bootLog("creating manager window");

    const rpc = BrowserView.defineRPC<DashboardRPC>({
      maxRequestTime: 300000,
      handlers: {
        requests: {
          getDashboard: async () => this.dashboardState(),
          installCarrotSourceFromDisk: async () => this.installCarrotSourceFromDisk(),
          installCarrotArtifactFromDisk: async () => this.installCarrotArtifactFromDisk(),
          reinstallCarrot: async ({ id }) => this.reinstallCarrot(id),
          uninstallCarrot: async ({ id }) => this.uninstallCarrot(id),
          revealCarrot: async ({ id }) => this.revealCarrot(id),
          launchCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            if (carrot.status === "running") {
              await carrot.stop();
            }
            await carrot.start();
            if (carrot.carrot.manifest.mode === "background") {
              carrot.sendEvent("boot");
            }
            return { ok: true };
          },
          stopCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            await carrot.stop();
            return { ok: true };
          },
          openCarrot: async ({ id }) => {
            const carrot = this.carrots.get(id);
            if (!carrot) return { ok: false };
            await carrot.openWindow();
            return { ok: true };
          },
        },
        messages: {},
      },
    });

    const win = new BrowserWindow({
      title: "Bunny Ears",
      url: "views://mainview/index.html",
      rpc,
      frame: {
        width: 960,
        height: 720,
        x: 80,
        y: 80,
      },
    });

    this.managerWindow = win;
    win.webview.on("dom-ready", () => {
      bootLog("manager dom-ready");
      (win.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
    });
    win.on("focus", () => {
      this.restoreDefaultApplicationMenu();
    });
    win.on("close", () => {
      this.clearPendingConsent();
      if (this.managerWindow === win) {
        this.managerWindow = null;
      }
    });
  }
}

const FOUNDATION_CARROTS = [
  { id: "bunny.git", artifact: "bunny.git-0.1.0.tar.zst" },
  { id: "bunny.pty", artifact: "bunny.pty-0.1.0.tar.zst" },
  { id: "bunny.fs", artifact: "bunny.fs-0.1.0.tar.zst" },
  { id: "bunny.tsserver", artifact: "bunny.tsserver-0.1.0.tar.zst" },
  { id: "bunny.biome", artifact: "bunny.biome-0.1.0.tar.zst" },
  { id: "bunny.llama", artifact: "bunny.llama-0.1.0.tar.zst" },
];

const DEV_FOUNDATION_CARROTS = [
  { id: "bunny.git", directory: "git" },
  { id: "bunny.pty", directory: "pty" },
  { id: "bunny.fs", directory: "fs" },
  { id: "bunny.tsserver", directory: "tsserver" },
  { id: "bunny.biome", directory: "biome" },
  { id: "bunny.llama", directory: "llama" },
] as const;
const FOUNDATION_CARROT_IDS = new Set<string>(DEV_FOUNDATION_CARROTS.map((carrot) => carrot.id));

function isHopDisabled() {
  const value = process.env.BUNNY_DISABLE_HOP || process.env.BUNNY_EARS_DISABLE_HOP;
  return value === "1" || value === "true";
}

function looksLikeCarrotsRepoRoot(path: string) {
  return DEV_FOUNDATION_CARROTS.every((carrot) =>
    existsSync(join(path, carrot.directory, "electrobun.config.ts")),
  );
}

function resolveDevCarrotsBaseDir() {
  const candidates = new Set<string>();

  const addCandidate = (candidate?: string | null) => {
    if (!candidate || candidate.length === 0) {
      return;
    }
    candidates.add(candidate);
  };

  addCandidate(process.env.CARROTS_BASE_DIR);
  addCandidate(process.env.PWD ? resolve(process.env.PWD, "../..") : null);
  addCandidate(process.env.INIT_CWD ? resolve(process.env.INIT_CWD, "../..") : null);
  addCandidate(resolve(process.cwd(), "../.."));
  addCandidate(resolve(import.meta.dir, "..", "..", "..", ".."));
  addCandidate(resolve(import.meta.dir, "..", "..", "..", "..", ".."));

  for (const candidate of candidates) {
    if (looksLikeCarrotsRepoRoot(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function ensureDevFoundationCarrotsInstalled() {
  const carrotsBaseDir = resolveDevCarrotsBaseDir();
  if (!carrotsBaseDir) {
    console.warn(
      "[bunny-ears] Could not find local carrots source root. Set CARROTS_BASE_DIR to enable dev carrot installs.",
    );
    return;
  }

  console.log(`[bunny-ears] Ensuring dev foundation carrots from ${carrotsBaseDir}`);

  for (const carrot of DEV_FOUNDATION_CARROTS) {
    const carrotPath = join(carrotsBaseDir, carrot.directory);
    const installed = getInstalledCarrot(carrot.id);
    const alreadyDevSource =
      installed?.install.devMode === true &&
      installed.install.source.kind === "local" &&
      resolve(installed.install.source.path) === carrotPath;

    console.log(
      `[bunny-ears] ${alreadyDevSource ? "Rebuilding" : "Installing"} ${carrot.id} from ${carrotPath}...`,
    );
    try {
      await installDevCarrotFromSource(carrotPath);
      console.log(`[bunny-ears] ${alreadyDevSource ? "Rebuilt" : "Installed"} ${carrot.id}`);
    } catch (error) {
      console.error(
        `[bunny-ears] Failed to install ${carrot.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

async function installFoundationCarrotsFromR2(channel: string, forceReinstall: boolean) {
  const baseUrl = channel === "stable"
    ? "https://carrots.electrobunny.ai"
    : "https://staging-carrots.electrobunny.ai";

  // Cache-bust against Cloudflare's CDN. Without this, a stale cached artifact
  // can be served indefinitely after a fresh CI build pushes new contents.
  const cacheBuster = Date.now().toString();

  for (const carrot of FOUNDATION_CARROTS) {
    if (!forceReinstall) {
      const existing = getInstalledCarrot(carrot.id);
      if (existing) continue;
    }

    const url = `${baseUrl}/${carrot.artifact}?t=${cacheBuster}`;
    console.log(`[bunny-ears] ${forceReinstall ? "Updating" : "Installing"} ${carrot.id} from ${url}...`);
    try {
      const prepared = await prepareArtifactCarrotInstall(url);
      await prepared.install();
      prepared.cleanup();
      console.log(`[bunny-ears] ${forceReinstall ? "Updated" : "Installed"} ${carrot.id}`);
    } catch (err) {
      console.error(`[bunny-ears] Failed to install ${carrot.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

pruneLegacyPrototypeCarrots();
console.log("[bunny-ears:startup] pruneLegacyPrototypeCarrots complete");
uninstallInstalledCarrot("bunny-dash");
uninstallInstalledCarrot("bunny.search");
console.log("[bunny-ears:startup] legacy carrot uninstall complete");

// In dev mode, rebuild carrots from source. In staging/prod, download pre-built artifacts.
console.log("[bunny-ears:startup] resolving updater channel...");
const channel = await Updater.localInfo.channel().catch(() => "dev");
console.log("[bunny-ears:startup] updater channel resolved", { channel });
if (channel === "dev") {
  if (SHOULD_REFRESH_TRACKED_DEV_CARROTS) {
    console.log("[bunny-ears:startup] refreshing tracked dev carrots...");
    const refreshErrors = await refreshTrackedDevCarrots(FOUNDATION_CARROT_IDS);
    console.log("[bunny-ears:startup] tracked dev carrots refreshed", {
      refreshErrorCount: refreshErrors.length,
    });
    if (refreshErrors.length > 0) {
      console.error("[bunny-ears] dev carrot refresh failures", refreshErrors);
    }
  } else {
    console.log(
      "[bunny-ears:startup] skipping tracked dev carrot refresh; set BUNNY_EARS_REFRESH_TRACKED_DEV_CARROTS=1 to enable",
    );
  }

  console.log("[bunny-ears:startup] ensuring dev foundation carrots...");
  await ensureDevFoundationCarrotsInstalled();
  console.log("[bunny-ears:startup] dev foundation carrots ensured");
} else {
  console.log("[bunny-ears:startup] installing foundation carrots from R2...");
  await installFoundationCarrotsFromR2(channel, false);
  console.log("[bunny-ears:startup] foundation carrots installed from R2");
}

console.log("[bunny-ears:startup] constructing runtime...");
const runtime = new BunnyEarsRuntime();
console.log("[bunny-ears:startup] runtime constructed");
const handleShutdownSignal = (signal: string) => {
  console.log(`[bunny-ears] ${signal} received, shutting down...`);
  void runtime.shutdown(0);
};

process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));
console.log("[bunny-ears:startup] calling runtime.boot()");
await runtime.boot();
console.log("[bunny-ears:startup] runtime.boot() complete");
