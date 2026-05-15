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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CarrotPermissionConsentRequest,
  CarrotContributions,
  CarrotPermissionGrant,
  CarrotPermissionTag,
  CarrotViewRPC,
  CarrotWorkerMessage,
} from "../carrot-runtime/types";
import {
  flattenCarrotPermissions,
  hasHostPermission,
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
import {
  buildCarrotPermissionConsentRequest,
  requestCarrotUninstallConsent,
} from "./carrotConsent";
import { toBunWorkerPermissions } from "./workerPermissions";
import {
  CloudApi,
  getApiBaseUrl,
  type CloudDeviceToken,
  type CloudInstance,
  type CloudUserProfile,
  type CloudWorkspace,
} from "../../../../dash/src/bun/cloudApi";

const DEBUG_BUNNY_EARS_BOOT = process.env.BUNNY_EARS_BOOT_DEBUG === "1";

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
  permissions: CarrotPermissionTag[];
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

type DashHostSummaryCache = {
  version: 1;
  updatedAt: number;
  currentWorkspaceId: string;
  currentLensId: string;
  currentWindow: DashHostWindowCache | null;
  windows: DashHostWindowCache[];
  workspaces: unknown[];
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
  pendingConsent: CarrotPermissionConsentRequest | null;
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
      respondToConsent: {
        params: { requestId: string; approved: boolean };
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
    permissions: string[];
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
      permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
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
    if (this.carrot.manifest.id === "bunny-dash") {
      (runtime as any).removeDashHostCacheWindow(windowId);
    }

    if (!(runtime as any).shutdownInProgress) {
      if (this.carrot.manifest.id === "bunny-dash" && this.status === "running") {
        try {
          await this.invoke("hostWindowClosed", { windowId });
        } catch (error) {
          this.pushLog(
            `hostWindowClosed failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        this.sendEvent("window-closed", { windowId });
      }
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
      permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
    });
    runtime.notifyDashboardChanged();

    if (
      this.carrot.manifest.mode === "window" &&
      !hasHostPermission(this.carrot.install.permissionsGranted, "windows")
    ) {
      throw new Error(`${this.carrot.manifest.name} is missing the host.windows permission`);
    }

    bootLog("creating carrot worker", { id: this.carrot.manifest.id });
    this.worker = new Worker(this.carrot.workerPath, {
      type: "module",
      permissions: toBunWorkerPermissions(this.carrot.install.permissionsGranted),
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

    // Send init context to the worker so it has statePath, permissions, etc.
    const channel = await Updater.localInfo.channel().catch(() => "dev");
    this.worker!.postMessage({
      type: "init",
      manifest: this.carrot.manifest,
      context: {
        statePath: this.statePath,
        logsPath: this.logsPath,
        permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
        grantedPermissions: this.carrot.install.permissionsGranted,
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
    if (!hasHostPermission(this.carrot.install.permissionsGranted, "windows")) {
      return;
    }

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

    return promise;
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
          _: async (method, params) => {
            if (this.carrot.manifest.id === "bunny-dash") {
              const direct = await (runtime as any).handleDirectDashRequest(
                String(method),
                params,
                windowId,
              );
              if (direct?.handled) {
                return direct.result;
              }
            }
            return this.invoke(String(method), params, windowId);
          },
        },
        messages: {
          "*": (messageName, payload) => {
            if (this.carrot.manifest.id === "bunny-dash") {
              void (async () => {
                const direct = await (runtime as any).handleDirectDashSend(
                  String(messageName),
                  payload,
                  windowId,
                );
                if (direct?.handled) {
                  return;
                }
                this.invoke(`send:${String(messageName)}`, payload, windowId).catch((error) => {
                  this.pushLog(
                    `view message failed: ${String(messageName)} ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                });
              })();
              return;
            }

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
        permissions: flattenCarrotPermissions(this.carrot.install.permissionsGranted),
        grantedPermissions: this.carrot.install.permissionsGranted,
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
        if (!pending) break;
        this.pending.delete(message.requestId);
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
        const response = await this.handleHostRequest(message.method, message.params)
          .then((payload) => ({
            type: "host-response" as const,
            requestId: message.requestId,
            success: true,
            payload,
          }))
          .catch((error: unknown) => ({
            type: "host-response" as const,
            requestId: message.requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }));
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
          // Notify all running carrots about the new token
          for (const carrot of runtime.carrots.values()) {
            if (carrot.status === "running") {
              carrot.sendEvent("auth-token-changed", { token });
            }
          }
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
      case "get-web-bridge-port": {
        return { port: runtime.webBridgePort };
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
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "notifications")) {
          this.pushLog("notification denied by permissions");
          return;
        }
        const notification = payload as { title: string; body?: string };
        Utils.showNotification({ title: notification.title, body: notification.body });
        this.pushLog(`notification: ${notification.title}`);
        break;
      }
      case "set-tray": {
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "tray")) {
          this.pushLog("tray denied by permissions");
          return;
        }
        if (this.carrot.manifest.id === "bunny-dash") {
          // Dash uses the runtime tray — don't create a separate one.
          // Tray click events are forwarded from the runtime tray.
          break;
        }
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
        if (!hasHostPermission(this.carrot.install.permissionsGranted, "tray")) {
          return;
        }
        if (this.carrot.manifest.id === "bunny-dash") {
          // Dash no longer owns or extends the system tray.
        } else if (this.tray) {
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
  webBridgePort: number | null = null;
  channel: string = "dev";
  carrots = new Map<string, CarrotInstance>();
  activeApplicationMenuOwnerId: string | null = null;
  activeContextMenuOwnerId: string | null = null;
  shutdownInProgress = false;
  updateStatus: "idle" | "checking" | "downloading" | "update-ready" | "error" = "idle";
  pendingConsent: {
    request: CarrotPermissionConsentRequest;
    prepared: PreparedCarrotInstall;
    grantedPermissions: CarrotPermissionGrant;
    options: { preserveRunningState?: boolean };
  } | null = null;
  nextConsentRequestId = 1;

  constructor() {
    for (const carrot of loadInstalledCarrots()) {
      this.carrots.set(carrot.manifest.id, new CarrotInstance(carrot));
    }

    // Bunny Ears owns the system tray.
    this.tray = new Tray({ title: "Dash" });
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
        this.activeApplicationMenuOwnerId === "bunny-dash"
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
  // ID of this instance in the API (assigned at registration time) — used to
  // mark the instance offline on logout.
  instanceId: string | null = null;
  farmWindow: BrowserWindow | null = null;

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

    this.startWebBridge();

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
    if (cachedWindows > 0) {
      return {
        path: existsSync(cachePath) ? cachePath : null,
        windowCount: cachedWindows,
      };
    }

    const legacyWindows = this.loadLegacyDashWindowSummaries();
    const legacyPath = this.carrots.get("bunny-dash")?.statePath || null;
    return {
      path:
        legacyWindows.length > 0
          ? legacyPath
          : existsSync(cachePath)
            ? cachePath
            : null,
      windowCount: legacyWindows.length,
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

    const hopBaseUrl = this.channel === "stable"
      ? "wss://hop.electrobunny.ai"
      : this.channel === "dev"
        ? "ws://localhost:8788"
        : "wss://staging-hop.electrobunny.ai";

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
        const carrot = this.carrots.get(message.carrotId);
        if (carrot) {
          carrot.hopBrowserIds.set(message.browserId, { windowId: null });
        }
        return;
      }

      if (message.type === "hop:browser-disconnected") {
        console.log(`[hop] Browser disconnected: ${message.browserId}`);
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

        // Handle RPC messages (fire-and-forget from view → bun)
        if (payload?.type === "message") {
          const messageName = payload.id;
          const messagePayload = payload.payload;
          const carrot = this.carrots.get(carrotId);
          if (carrot && carrot.status === "running") {
            carrot.setHopBrowserWindowId(
              browserId,
              typeof (messagePayload as { windowId?: unknown } | undefined)?.windowId === "string"
                ? ((messagePayload as { windowId: string }).windowId)
                : undefined,
            );
            const direct =
              carrotId === "bunny-dash"
                ? await this.handleDirectDashSend(
                    String(messageName || ""),
                    messagePayload,
                    typeof (messagePayload as { windowId?: unknown } | undefined)?.windowId === "string"
                      ? ((messagePayload as { windowId: string }).windowId)
                      : undefined,
                  )
                : { handled: false as const };
            if (!direct.handled) {
              // Forward as an event to the carrot worker
              carrot.worker?.postMessage({
                type: "request",
                requestId: 0, // fire-and-forget, no response expected
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
        if (carrotId === "bunny-ears" || !this.carrots.has(carrotId)) {
          this.handleHopRuntimeRequest(browserId, requestId, method, params);
          return;
        }

        // Route to a specific carrot
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

        const directPromise =
          carrotId === "bunny-dash"
            ? this.handleDirectDashRequest(
                String(method || ""),
                params,
                typeof (params as { windowId?: unknown } | undefined)?.windowId === "string"
                  ? ((params as { windowId?: string }).windowId)
                  : undefined,
              )
            : Promise.resolve({ handled: false as const });

        directPromise
          .then((direct) => {
            if (direct.handled) {
              return direct.result;
            }
            if (method === "invokeCarrot") {
              return this.invokeCarrotFrom(
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
    const resolved = this.resolveCarrotFile(carrotId, filePath);

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

  private loadLegacyDashWindowSummaries(): DashHostWindowCache[] {
    const dashCarrot = this.carrots.get("bunny-dash");
    const statePath = dashCarrot?.statePath;
    if (!statePath || !existsSync(statePath)) {
      return [];
    }

    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
        currentState?: {
          windows?: Array<{
            id?: string;
            title?: string;
            workspaceId?: string;
            lensId?: string;
          }>;
        };
        sessionSnapshot?: {
          windows?: Array<{
            id?: string;
            title?: string;
            workspaceId?: string;
            lensId?: string;
          }>;
        };
        bunnyDash?: {
          workspaces?: Record<
            string,
            {
              windows?: Array<{
                id?: string;
                position?: {
                  x?: number;
                  y?: number;
                  width?: number;
                  height?: number;
                };
              }>;
            }
          >;
        };
      };

      const windows = parsed.sessionSnapshot?.windows || parsed.currentState?.windows || [];
      const positionedWindows = Object.values(parsed.bunnyDash?.workspaces || {}).flatMap(
        (workspace) => workspace.windows || [],
      );

      return windows
        .filter((window) => window && typeof window === "object" && window.id)
        .map((window) => {
          const positioned = positionedWindows.find((candidate) => candidate.id === window.id);
          return {
            windowId: String(window.id || ""),
            title: String(window.title || "Dash"),
            frame: {
              x: Number(positioned?.position?.x || 120),
              y: Number(positioned?.position?.y || 120),
              width: Number(positioned?.position?.width || 1500),
              height: Number(positioned?.position?.height || 900),
            },
            workspaceId: String(window.workspaceId || ""),
            lensId: String(window.lensId || ""),
            activeTreeNodeId: "",
          };
        });
    } catch {
      return [];
    }
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

  private getDashHomeDir() {
    const dashCarrot = this.carrots.get("bunny-dash");
    return dashCarrot?.stateDir || this.getChannelStateDir();
  }

  private getDashProjectsFolder(workspaceId?: string) {
    const path = require("node:path");
    const root = path.join(
      this.getDashHomeDir(),
      "projects",
      workspaceId || "default",
    );
    mkdirSync(root, { recursive: true });
    return root;
  }

  private getDashBuildVars() {
    const dashCarrot = this.carrots.get("bunny-dash");
    return {
      channel: this.channel,
      version: dashCarrot?.carrot.manifest.version || "0.1.0",
      hash: "bunny-dash",
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

  private getDashWebBridgeOrigin() {
    if (!this.webBridgePort) {
      return "";
    }
    return `http://localhost:${this.webBridgePort}`;
  }

  private buildCurrentDashInstanceSummary() {
    const os = require("node:os");
    return {
      id: "host-machine",
      name: os.hostname() || "This Machine",
      os: process.platform === "darwin" ? "macos" : process.platform,
      status: "online",
      isCurrent: true,
      carrots: this.summaries(),
    };
  }

  private buildDashHostBootState(sourceWindowId?: string) {
    const cache = this.loadDashHostCache();
    const targetWindowId = sourceWindowId || cache?.currentWindow?.windowId || "main";
    const windowTarget =
      cache?.windows.find((window) => window.windowId === targetWindowId) ||
      cache?.currentWindow ||
      null;

    return {
      windowId: targetWindowId,
      buildVars: this.getDashBuildVars(),
      paths: this.getDashPaths(windowTarget?.workspaceId || cache?.currentWorkspaceId || undefined),
      peerDependencies: cache?.peerDependencies || {
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
      dashCache: cache,
      windowTarget,
      currentInstance: cache?.currentInstance || this.buildCurrentDashInstanceSummary(),
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
    const oldInstanceId = this.instanceId;

    this.clearSavedAuthToken();
    this.clearDeviceToken();
    this.instanceId = null;
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
    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "http://localhost:8787"
        : "https://api.electrobunny.ai";

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
    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "http://localhost:8787"
        : "https://api.electrobunny.ai";

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
  }

  private broadcastDashAuthTokenChanged(token: string) {
    for (const carrot of this.carrots.values()) {
      if (carrot.status === "running") {
        carrot.sendEvent("auth-token-changed", { token });
      }
    }
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
      permissions: [...carrot.summary.permissions],
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

    const currentInstanceId = currentMachine.machineId
      ? instances.find((instance) => instance.machine_id === currentMachine.machineId)?.id ||
        this.instanceId ||
        null
      : this.instanceId;

    if (currentInstanceId) {
      this.instanceId = currentInstanceId;
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
      currentInstanceId,
      currentDeviceTokenId,
      currentCarrots: this.buildCurrentDashCarrotSummaries(),
    };
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
    await this.registerInstanceWithToken(data.accessToken).catch(() => {});
    this.broadcastDashAuthTokenChanged(data.accessToken);

    const deviceToken = await this.createDashDeviceToken(data.accessToken).catch(() => null);
    if (deviceToken?.token) {
      this.saveDeviceToken(deviceToken.token, deviceToken.id);
      try { this.hopWs?.close(); } catch {}
      this.hopWs = null;
      this.connectToHop();
      this.refreshAccessTokenFromDevice().catch(() => {});
    }

    return this.buildDashBunnyCloudOverview();
  }

  private async registerDashCurrentInstance() {
    const accessToken = await this.ensureDashCloudAccessToken();
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

    const apiBase = this.channel === "dev"
      ? "http://localhost:8787"
      : this.channel === "canary"
        ? "http://localhost:8787"
        : "https://api.electrobunny.ai";

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
        // Notify all running carrots about the refreshed token
        for (const carrot of this.carrots.values()) {
          if (carrot.status === "running") {
            carrot.sendEvent("auth-token-changed", { token });
          }
        }
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
              // Notify all running carrots about the new token
              for (const carrot of this.carrots.values()) {
                if (carrot.status === "running") {
                  carrot.sendEvent("auth-token-changed", { token: accessToken });
                }
              }

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

      const data = await response.json() as any;
      const instanceId = data.instance?.id || null;
      if (instanceId) this.instanceId = instanceId;
      console.log(`[bunny-ears] Instance registered: ${data.instance?.name} (${instanceId})`);
      return { ok: true, instanceId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[bunny-ears] Instance registration failed: ${msg}`);
      return { ok: false, error: msg };
    }
  }


  /**
   * WebSocket bridge for web clients (e.g. Bunny Dash running in a browser).
   *
   * Web clients connect and specify a target carrot (default: bunny-dash).
   * Requests are routed to the carrot worker via CarrotInstance.invoke(),
   * and emit-view messages from the worker are forwarded back over WebSocket.
   */
  private startWebBridge() {
    const self = this;
    let clientId = 0;
    const candidatePorts = Array.from({ length: 20 }, (_, index) => 9333 + index);

    for (const port of candidatePorts) {
      try {
        Bun.serve({
          port,
          fetch(req, server) {
            const url = new URL(req.url);

            if (url.pathname.startsWith("/carrot/")) {
              const segments = url.pathname.split("/").filter(Boolean);
              const carrotId = segments[1] || "";
              const uiKind = segments[2] || "";
              const uiId = segments[3] || "";
              const restPath = segments.slice(4);
              const resolved =
                uiKind === "remote-ui"
                  ? self.resolveCarrotRemoteUIFile(carrotId, uiId, restPath)
                  : uiKind === "slate-ui"
                    ? self.resolveCarrotSlateUIFile(carrotId, uiId, restPath)
                    : self.resolveCarrotRemoteUIFile(carrotId, uiKind, segments.slice(3));
              if (!resolved.ok) {
                return new Response(resolved.error, { status: resolved.status });
              }
              return new Response(resolved.body, {
                status: 200,
                headers: {
                  "Content-Type": resolved.contentType,
                  "Cache-Control": "no-store",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }

            if (server.upgrade(req, { data: { id: `web-${++clientId}` } })) {
              return;
            }
            return new Response("Bunny Ears Web Bridge", { status: 200 });
          },
          websocket: {
            open(ws) {
              const id = (ws.data as any).id as string;
              console.log(`[web-bridge] Client connected: ${id}`);

              const dashCarrot = self.carrots.get("bunny-dash");
              if (dashCarrot) {
                dashCarrot.webClients.set(id, {
                  send: (data: string) => {
                    try { ws.send(data); } catch {}
                  },
                  windowId: null,
                });
              } else {
                console.warn("[web-bridge] bunny-dash carrot not found");
              }
            },
            async message(ws, data) {
              const id = (ws.data as any).id as string;
              try {
                const msg = JSON.parse(String(data));
                const dashCarrot = self.carrots.get("bunny-dash");
                if (!dashCarrot) {
                  if (msg.type === "request") {
                    ws.send(JSON.stringify({
                      type: "response",
                      id: msg.id,
                      error: "bunny-dash carrot not running",
                    }));
                  }
                  return;
                }

                if (msg.type === "request") {
                  try {
                    dashCarrot.setWebClientWindowId(
                      id,
                      typeof msg?.params?.windowId === "string" ? msg.params.windowId : undefined,
                    );
                    const direct = await self.handleDirectDashRequest(
                      String(msg.method || ""),
                      msg.params,
                      typeof msg?.params?.windowId === "string"
                        ? msg.params.windowId
                        : undefined,
                    );
                    const result =
                      direct.handled
                        ? direct.result
                        : msg.method === "invokeCarrot"
                          ? await self.invokeCarrotFrom(
                              "bunny-dash",
                              String(msg?.params?.carrotId || ""),
                              String(msg?.params?.method || ""),
                              msg?.params?.params,
                              typeof msg?.params?.windowId === "string"
                                ? msg.params.windowId
                                : undefined,
                            )
                          : await dashCarrot.invoke(msg.method, msg.params);
                    ws.send(JSON.stringify({
                      type: "response",
                      id: msg.id,
                      result,
                    }));
                  } catch (err) {
                    ws.send(JSON.stringify({
                      type: "response",
                      id: msg.id,
                      error: err instanceof Error ? err.message : String(err),
                    }));
                  }
                }

                if (msg.type === "message") {
                  dashCarrot.setWebClientWindowId(
                    id,
                    typeof msg?.payload?.windowId === "string" ? msg.payload.windowId : undefined,
                  );
                  const direct = await self.handleDirectDashSend(
                    String(msg.name || ""),
                    msg.payload,
                    typeof msg?.payload?.windowId === "string" ? msg.payload.windowId : undefined,
                  );
                  if (!direct.handled) {
                    dashCarrot.invoke(`send:${msg.name}`, msg.payload).catch(() => {});
                  }
                }
              } catch (err) {
                console.error("[web-bridge] Failed to handle message:", err);
              }
            },
            close(ws) {
              const id = (ws.data as any).id as string;
              console.log(`[web-bridge] Client disconnected: ${id}`);
              const dashCarrot = self.carrots.get("bunny-dash");
              dashCarrot?.webClients.delete(id);
            },
          },
        });
        this.webBridgePort = port;
        console.log(`[web-bridge] Listening on ws://localhost:${port}`);
        return;
      } catch (err) {
        console.error(`[web-bridge] Failed to start on port ${port}:`, err);
      }
    }
  }

  summaries() {
    return Array.from(this.carrots.values()).map((carrot) => carrot.summary);
  }

  dashboardState(): DashboardState {
    return {
      installRoot: getInstalledCarrotsRoot(),
      carrots: this.summaries(),
      pendingConsent: this.pendingConsent?.request ?? null,
    };
  }

  notifyDashboardChanged() {
    this.tray?.setMenu(this.buildTrayMenu());
    (this.managerWindow?.webview.rpc as any)?.send?.dashboardChanged(this.dashboardState());
  }

  private getDashCarrot() {
    return this.carrots.get("bunny-dash") || null;
  }

  private getPreferredDashWindowId() {
    const cachedWindowId = this.loadDashHostCache()?.currentWindow?.windowId;
    if (cachedWindowId) {
      return cachedWindowId;
    }

    const dashCarrot = this.getDashCarrot();
    if (!dashCarrot) {
      return "main";
    }

    return dashCarrot.controllerWindows.keys().next().value ?? "main";
  }

  private async ensureDashWindowForMenuAction() {
    const dashCarrot = this.getDashCarrot();
    if (!dashCarrot) {
      return null;
    }

    const windowId = this.getPreferredDashWindowId();
    await dashCarrot.openWindow(windowId);
    return {
      dashCarrot,
      windowId,
    };
  }

  private async sendDashViewMessage(name: string, payload?: unknown) {
    const target = await this.ensureDashWindowForMenuAction();
    if (!target) {
      return;
    }

    target.dashCarrot.emitViewMessage(name, payload, {
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
    if (action === "llama-settings") {
      await this.sendDashViewMessage("openSettings", { settingsType: "llama-settings" });
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
            label: "Llama Settings",
            action: "llama-settings",
          },
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

  private async handleDirectDashRequest(
    method: string,
    params: unknown,
    sourceWindowId?: string,
  ): Promise<{ handled: boolean; result?: unknown }> {
    const invokeFs = (fsMethod: string) =>
      this.invokeCarrotFrom("bunny-dash", "bunny.fs", fsMethod, params, sourceWindowId);

    switch (method) {
      case "logoutBunnyCloud":
        this.signOutFromCloud();
        return { handled: true, result: { ok: true } };
      case "getBunnyCloudOverview":
        return {
          handled: true,
          result: await this.buildDashBunnyCloudOverview(),
        };
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
          return {
            handled: true,
            result: {
              ok: true,
              overview: await this.registerDashCurrentInstance(),
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
      case "getDashHostBootState":
        return {
          handled: true,
          result: this.buildDashHostBootState(sourceWindowId),
        };
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

  private async handleDirectDashSend(
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
        const dashCarrot = this.carrots.get("bunny-dash");
        if (dashCarrot) {
          const targetWindowId =
            typeof (payload as { windowId?: unknown } | undefined)?.windowId === "string"
              ? ((payload as { windowId: string }).windowId)
              : sourceWindowId;
          await dashCarrot.requestCloseWindow(targetWindowId);
        }
        return { handled: true };
      }
      case "createHostWindow": {
        const dashCarrot = this.carrots.get("bunny-dash");
        if (dashCarrot) {
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
          await dashCarrot.openWindow(
            String(createPayload.windowId || sourceWindowId || "main"),
            {
              title:
                typeof createPayload.title === "string"
                  ? createPayload.title
                  : undefined,
              frame: createPayload.frame,
            },
          );
        }
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
      case "fullyDeleteNodeFromDisk":
        await this.invokeCarrotFrom(
          "bunny-dash",
          "bunny.fs",
          "safeDeleteFileOrFolder",
          { path: String((payload as { nodePath?: string } | undefined)?.nodePath || "") },
          sourceWindowId,
        );
        return { handled: true };
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

  async invokeCarrotFrom(
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

    const target = this.carrots.get(targetCarrotId);
    if (!target) {
      throw new Error(`Target carrot not installed: ${targetCarrotId}`);
    }

    const wasStopped = target.status === "stopped";
    if (target.status !== "running") {
      await target.start();
      if (wasStopped && target.carrot.manifest.mode === "background") {
        target.sendEvent("boot");
      }
    }

    return target.invoke(
      method,
      this.withSourceEnvelope(sourceCarrotId, sourceWindowId, params),
    );
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

    const target = this.carrots.get(targetCarrotId);
    if (!target || target.status !== "running") {
      return;
    }

    target.sendEvent(name, this.withSourceEnvelope(sourceCarrotId, undefined, payload));
  }

  emitCarrotViewEventFrom(
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
      const dashCarrot = this.carrots.get("bunny-dash");
      if (!dashCarrot) return;
      if (dashCarrot.status !== "running") {
        await dashCarrot.start();
        dashCarrot.sendEvent("boot");
      }
      this.restoreDefaultApplicationMenu();
      const dashCache = this.loadDashHostCache();
      const cachedWindows =
        Array.isArray(dashCache?.windows) && dashCache.windows.length > 0
          ? dashCache.windows
          : this.loadLegacyDashWindowSummaries();

      if (dashCarrot.controllerWindows.size > 0) {
        const targetWindow =
          cachedWindows.find((window) => dashCarrot.controllerWindows.has(window.windowId)) ||
          cachedWindows[0];
        await dashCarrot.openWindow(targetWindow?.windowId, {
          title: targetWindow?.title,
          frame: targetWindow?.frame,
        });
        return;
      }

      if (cachedWindows.length > 0) {
        for (const window of cachedWindows) {
          await dashCarrot.openWindow(window.windowId, {
            title: window.title,
            frame: window.frame,
          });
        }
        return;
      }

      await dashCarrot.openWindow("main");
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
    grantedPermissions: CarrotPermissionGrant,
    options: { preserveRunningState?: boolean } = {},
  ) {
    try {
      const installed = await prepared.install(grantedPermissions);
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
    if (this.pendingConsent) {
      prepared.cleanup();
      this.openManagerWindow();
      return {
        ok: false,
        error: "Another Carrot install is already waiting for permission approval.",
      };
    }

    const requestId = `consent-${Date.now()}-${this.nextConsentRequestId++}`;
    const consentPlan = buildCarrotPermissionConsentRequest(prepared, requestId);

    if (!consentPlan.request) {
      return await this.installPreparedCarrot(prepared, consentPlan.grantedPermissions, options);
    }

    this.pendingConsent = {
      request: consentPlan.request,
      prepared,
      grantedPermissions: consentPlan.grantedPermissions,
      options,
    };
    this.openManagerWindow();
    this.notifyDashboardChanged();

    return {
      ok: false,
      id: prepared.manifest.id,
      reason: "awaiting-consent",
    };
  }

  private clearPendingConsent() {
    const pending = this.pendingConsent;
    if (!pending) {
      return;
    }

    this.pendingConsent = null;
    pending.prepared.cleanup();
  }

  private async respondToConsent(requestId: string, approved: boolean) {
    const pending = this.pendingConsent;
    if (!pending || pending.request.requestId !== requestId) {
      return { ok: false, error: "Consent request not found." };
    }

    this.pendingConsent = null;
    this.notifyDashboardChanged();

    if (!approved) {
      pending.prepared.cleanup();
      return { ok: false, reason: "canceled" };
    }

    try {
      return await this.installPreparedCarrot(
        pending.prepared,
        pending.grantedPermissions,
        pending.options,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await Utils.showMessageBox({
        type: "error",
        title: "Carrot install failed",
        message,
      });
      this.refreshInstalledCarrot(pending.request.carrotId);
      return { ok: false, error: message };
    }
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
          respondToConsent: async ({ requestId, approved }) =>
            this.respondToConsent(requestId, approved),
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
  { id: "bunny.search", artifact: "bunny.search-0.1.0.tar.zst" },
  { id: "bunny.tsserver", artifact: "bunny.tsserver-0.1.0.tar.zst" },
  { id: "bunny.biome", artifact: "bunny.biome-0.1.0.tar.zst" },
  { id: "bunny.llama", artifact: "bunny.llama-0.1.0.tar.zst" },
  { id: "bunny-dash", artifact: "bunny-dash-0.1.0.tar.zst" },
];

const DEV_FOUNDATION_CARROTS = [
  { id: "bunny.git", directory: "git" },
  { id: "bunny.pty", directory: "pty" },
  { id: "bunny.fs", directory: "fs" },
  { id: "bunny.search", directory: "search" },
  { id: "bunny.tsserver", directory: "tsserver" },
  { id: "bunny.biome", directory: "biome" },
  { id: "bunny.llama", directory: "llama" },
  { id: "bunny-dash", directory: "dash" },
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

// In dev mode, rebuild carrots from source. In staging/prod, download pre-built artifacts.
const channel = await Updater.localInfo.channel().catch(() => "dev");
if (channel === "dev") {
  const refreshErrors = await refreshTrackedDevCarrots(FOUNDATION_CARROT_IDS);
  if (refreshErrors.length > 0) {
    console.error("[bunny-ears] dev carrot refresh failures", refreshErrors);
  }

  await ensureDevFoundationCarrotsInstalled();
} else {
  await installFoundationCarrotsFromR2(channel, false);
}

const runtime = new BunnyEarsRuntime();
const handleShutdownSignal = (signal: string) => {
  console.log(`[bunny-ears] ${signal} received, shutting down...`);
  void runtime.shutdown(0);
};

process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));
await runtime.boot();
