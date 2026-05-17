export type CarrotMode = "window" | "background";

export type CarrotDependencyMap = Record<string, string>;

export type CarrotRemoteUI = {
  name: string;
  path: string;
};

export type CarrotSlateUI = {
  name: string;
  path: string;
};

export type CarrotFileActivator = {
  baseName?: string;
  nodeType?: "file" | "dir" | "any";
  slate: {
    type: string;
    name?: string;
    icon?: string;
    config?: Record<string, unknown>;
  };
};

export type CarrotContributions = {
  fileActivators?: CarrotFileActivator[];
};

export type CarrotManifest = {
  id: string;
  name: string;
  version: string;
  description: string;
  mode: CarrotMode;
  dependencies?: CarrotDependencyMap;
  view: {
    relativePath: string;
    hidden?: boolean;
    title: string;
    width: number;
    height: number;
    titleBarStyle?: "hidden" | "hiddenInset" | "default";
    transparent?: boolean;
  };
  worker: {
    relativePath: string;
  };
  remoteUIs?: Record<string, CarrotRemoteUI>;
  slateUIs?: Record<string, CarrotSlateUI>;
  contributions?: CarrotContributions;
};

export type CarrotInstallSource =
  | {
      kind: "prototype";
      prototypeId: string;
      bundledViewFolder: string;
    }
  | {
      kind: "local";
      path: string;
    }
  | {
      kind: "artifact";
      location: string;
      updateLocation?: string | null;
      tarballLocation?: string | null;
      currentHash?: string | null;
      baseUrl?: string | null;
    };

export type CarrotInstallStatus = "installed" | "broken";

export type CarrotInstallRecord = {
  id: string;
  name: string;
  version: string;
  currentHash: string | null;
  installedAt: number;
  updatedAt: number;
  devMode?: boolean;
  lastBuildAt?: number | null;
  lastBuildError?: string | null;
  status: CarrotInstallStatus;
  source: CarrotInstallSource;
};

export type CarrotRegistry = {
  version: 1;
  carrots: Record<string, CarrotInstallRecord>;
};

export type WorkerRequestMessage = {
  type: "request";
  requestId: number;
  method: string;
  params?: unknown;
  windowId?: string;
};

export type WorkerEventMessage = {
  type: "event";
  name: string;
  payload?: unknown;
};

export type WorkerInitMessage = {
  type: "init";
  manifest: CarrotManifest;
  context: {
    statePath: string;
    logsPath: string;
    config?: Record<string, unknown>;
  };
};

export type HostActionMessage = {
  type: "action";
  action:
    | "notify"
    | "window-create"
    | "window-set-title"
    | "window-set-frame"
    | "window-set-always-on-top"
    | "show-context-menu"
    | "set-application-menu"
    | "clear-application-menu"
    | "set-tray"
    | "set-tray-menu"
    | "remove-tray"
    | "focus-window"
    | "close-window"
    | "open-bunny-window"
    | "open-manager"
    | "stop-carrot"
    | "emit-view"
    | "emit-carrot-view-event"
    | "emit-carrot-event"
    | "log";
  payload?: unknown;
};

export type HostRequestMessage = {
  type: "host-request";
  requestId: number;
  method:
    | "open-file-dialog"
    | "open-path"
    | "show-item-in-folder"
    | "clipboard-write-text"
    | "window-get-frame"
    | "invoke-carrot"
    | "screen-get-primary-display"
    | "screen-get-cursor-screen-point";
  params?: unknown;
};

export type HostResponseMessage = {
  type: "host-response";
  requestId: number;
  success: boolean;
  payload?: unknown;
  error?: string;
};

export type WorkerResponseMessage = {
  type: "response";
  requestId: number;
  success: boolean;
  payload?: unknown;
  error?: string;
};

export type WorkerReadyMessage = {
  type: "ready";
};

export type CarrotWorkerMessage =
  | WorkerRequestMessage
  | WorkerEventMessage
  | WorkerInitMessage
  | HostActionMessage
  | HostRequestMessage
  | HostResponseMessage
  | WorkerResponseMessage
  | WorkerReadyMessage;

export type CarrotViewRPC = {
  bun: {
    requests: {
      invoke: {
        params: { method: string; params?: unknown };
        response: unknown;
      };
      invokeCarrot: {
        params: {
          carrotId: string;
          method: string;
          params?: unknown;
          windowId?: string;
        };
        response: unknown;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      runtimeEvent: { name: string; payload?: unknown };
      carrotBoot: {
        id: string;
        name: string;
        mode: CarrotMode;
      };
    };
  };
};
