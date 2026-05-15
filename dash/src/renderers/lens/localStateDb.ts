import DB, { type SchemaToDocumentTypes } from "goldfishdb/browser";
import type { AppState, WorkspaceType } from "./store";

const {
  collection,
  number,
  schema,
  string,
} = DB.v1.schemaType;

const localDashStateSchema1 = schema({
  v: 1,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      color: string({ required: true, internal: false }),
      workspaceJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    appSettings: collection({
      key: string({ required: true, internal: false }),
      settingsJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
  },
});

const localDashStateSchema2 = schema({
  v: 2,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      color: string({ required: true, internal: false }),
      workspaceJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    appSettings: collection({
      key: string({ required: true, internal: false }),
      settingsJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    localGraph: collection({
      key: string({ required: true, internal: false }),
      graphJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
  },
});

const localDashStateSchema3 = schema({
  v: 3,
  stores: {
    workspaces: collection({
      key: string({ required: true, internal: false }),
      name: string({ required: true, internal: false }),
      color: string({ required: true, internal: false }),
      workspaceJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    appSettings: collection({
      key: string({ required: true, internal: false }),
      settingsJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    localGraph: collection({
      key: string({ required: true, internal: false }),
      graphJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
    tokens: collection({
      key: string({ required: true, internal: false }),
      tokensJson: string({ required: true, internal: false }),
      updatedAt: number({ required: true, internal: false }),
    }),
  },
});

type LocalDashStateDocumentTypes = SchemaToDocumentTypes<typeof localDashStateSchema3>;
type LocalDashStateDb = DB<typeof localDashStateSchema3>;

const LOCAL_DASH_DB_NAME = "bunny-dash-local-state";
const APP_SETTINGS_KEY = "primary";
const LOCAL_GRAPH_KEY = "primary";
const TOKENS_KEY = "primary";

export type PersistedLocalDashGraph = {
  workspaces: Array<{
    key: string;
    name: string;
    subtitle: string;
    sortOrder: number;
  }>;
  projectMounts: Array<{
    key: string;
    workspaceId: string;
    name: string;
    instanceId: string;
    instanceLabel: string;
    path: string;
    kind: string;
    status: string;
    sortOrder: number;
  }>;
  layouts: Array<{
    key: string;
    name: string;
    description: string;
    workspaceId?: string;
    windowStateJson?: string;
    sortOrder: number;
    windows: Array<{
      id: string;
      title: string;
      workspaceId: string;
      mainTabIds: string[];
      sideTabIds: string[];
      currentMainTabId: string;
      currentSideTabId: string;
    }>;
  }>;
};

let localDashDbPromise: Promise<LocalDashStateDb> | null = null;

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function getLocalDashDb(): Promise<LocalDashStateDb> {
  if (!localDashDbPromise) {
    localDashDbPromise = new DB<typeof localDashStateSchema3>().initAsync({
      schemaHistory: [
        { v: 1, schema: localDashStateSchema1, migrationSteps: false },
        { v: 2, schema: localDashStateSchema2, migrationSteps: false },
        { v: 3, schema: localDashStateSchema3, migrationSteps: false },
      ],
      engine: "indexeddb",
      db_name: LOCAL_DASH_DB_NAME,
    });
  }

  return localDashDbPromise;
}

function getWorkspaceDocByKey(
  db: LocalDashStateDb,
  workspaceId: string,
): LocalDashStateDocumentTypes["workspaces"] | null {
  return (
    db.collection("workspaces").query({
      where: (item) => item.key === workspaceId,
      limit: 1,
    }).data?.[0] || null
  );
}

function getAppSettingsDoc(
  db: LocalDashStateDb,
): LocalDashStateDocumentTypes["appSettings"] | null {
  return (
    db.collection("appSettings").query({
      where: (item) => item.key === APP_SETTINGS_KEY,
      limit: 1,
    }).data?.[0] || null
  );
}

function getLocalGraphDoc(
  db: LocalDashStateDb,
): LocalDashStateDocumentTypes["localGraph"] | null {
  return (
    db.collection("localGraph").query({
      where: (item) => item.key === LOCAL_GRAPH_KEY,
      limit: 1,
    }).data?.[0] || null
  );
}

function getTokensDoc(
  db: LocalDashStateDb,
): LocalDashStateDocumentTypes["tokens"] | null {
  return (
    db.collection("tokens").query({
      where: (item) => item.key === TOKENS_KEY,
      limit: 1,
    }).data?.[0] || null
  );
}

export async function loadPersistedWorkspaceState(
  workspaceId: string,
): Promise<WorkspaceType | null> {
  if (!workspaceId) {
    return null;
  }

  const db = await getLocalDashDb();
  const doc = getWorkspaceDocByKey(db, workspaceId);
  if (!doc?.workspaceJson) {
    return null;
  }

  return safeParseJson<WorkspaceType | null>(doc.workspaceJson, null);
}

export async function persistWorkspaceState(workspace: WorkspaceType | null | undefined) {
  if (!workspace?.id) {
    return;
  }

  const db = await getLocalDashDb();
  const existing = getWorkspaceDocByKey(db, workspace.id);
  const payload = {
    key: workspace.id,
    name: workspace.name || "",
    color: workspace.color || "",
    workspaceJson: JSON.stringify(workspace),
    updatedAt: Date.now(),
  };

  if (existing) {
    db.collection("workspaces").update(existing.id, payload);
  } else {
    db.collection("workspaces").insert(payload);
  }
}

export async function loadPersistedAppSettings(): Promise<AppState["appSettings"] | null> {
  const db = await getLocalDashDb();
  const doc = getAppSettingsDoc(db);
  if (!doc?.settingsJson) {
    return null;
  }

  return safeParseJson<AppState["appSettings"] | null>(doc.settingsJson, null);
}

export async function persistAppSettings(
  appSettings: AppState["appSettings"] | null | undefined,
) {
  if (!appSettings) {
    return;
  }

  const db = await getLocalDashDb();
  const existing = getAppSettingsDoc(db);
  const payload = {
    key: APP_SETTINGS_KEY,
    settingsJson: JSON.stringify(appSettings),
    updatedAt: Date.now(),
  };

  if (existing) {
    db.collection("appSettings").update(existing.id, payload);
  } else {
    db.collection("appSettings").insert(payload);
  }
}

export async function loadPersistedLocalDashGraph(): Promise<PersistedLocalDashGraph | null> {
  const db = await getLocalDashDb();
  const doc = getLocalGraphDoc(db);
  if (!doc?.graphJson) {
    return null;
  }

  return safeParseJson<PersistedLocalDashGraph | null>(doc.graphJson, null);
}

export async function persistLocalDashGraph(
  graph: PersistedLocalDashGraph | null | undefined,
) {
  if (!graph) {
    return;
  }

  const db = await getLocalDashDb();
  const existing = getLocalGraphDoc(db);
  const payload = {
    key: LOCAL_GRAPH_KEY,
    graphJson: JSON.stringify(graph),
    updatedAt: Date.now(),
  };

  if (existing) {
    db.collection("localGraph").update(existing.id, payload);
  } else {
    db.collection("localGraph").insert(payload);
  }
}

export async function loadPersistedTokens(): Promise<any[]> {
  const db = await getLocalDashDb();
  const doc = getTokensDoc(db);
  if (!doc?.tokensJson) {
    return [];
  }

  return safeParseJson<any[]>(doc.tokensJson, []);
}

export async function persistTokens(tokens: any[] | null | undefined) {
  const db = await getLocalDashDb();
  const existing = getTokensDoc(db);
  const payload = {
    key: TOKENS_KEY,
    tokensJson: JSON.stringify(Array.isArray(tokens) ? tokens : []),
    updatedAt: Date.now(),
  };

  if (existing) {
    db.collection("tokens").update(existing.id, payload);
  } else {
    db.collection("tokens").insert(payload);
  }
}

export function mergeAppSettingsForBoot(
  defaults: AppState["appSettings"],
  hostAppSettings: AppState["appSettings"] | undefined | null,
  persistedAppSettings: AppState["appSettings"] | undefined | null,
): AppState["appSettings"] {
  return {
    llama: {
      ...defaults.llama,
      ...(hostAppSettings?.llama || {}),
      ...(persistedAppSettings?.llama || {}),
    },
    github: {
      ...defaults.github,
      ...(hostAppSettings?.github || {}),
      ...(persistedAppSettings?.github || {}),
    },
    bunnyCloud: {
      ...defaults.bunnyCloud,
      ...(persistedAppSettings?.bunnyCloud || {}),
      ...(hostAppSettings?.bunnyCloud || {}),
    },
  };
}

export function mergeWorkspaceForBoot(
  hostWorkspace: WorkspaceType,
  persistedWorkspace: WorkspaceType | null,
  currentWindowId?: string,
): WorkspaceType {
  if (!persistedWorkspace) {
    return hostWorkspace;
  }

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

  const mergedWindows = new Map<string, WorkspaceType["windows"][number]>();

  for (const window of persistedWorkspace.windows || []) {
    if (!window?.id) {
      continue;
    }
    mergedWindows.set(window.id, window);
  }

  for (const window of hostWorkspace.windows || []) {
    if (!window?.id) {
      continue;
    }
    const persistedWindow = mergedWindows.get(window.id);
    const shouldPreferHostWindow =
      window.id === currentWindowId || !hasUsableWindowLayout(persistedWindow);
    if (shouldPreferHostWindow || !persistedWindow) {
      mergedWindows.set(window.id, window);
    }
  }

  return {
    ...hostWorkspace,
    ...persistedWorkspace,
    id: hostWorkspace.id || persistedWorkspace.id,
    name: hostWorkspace.name || persistedWorkspace.name,
    windows:
      mergedWindows.size > 0
        ? Array.from(mergedWindows.values())
        : hostWorkspace.windows,
  };
}

export { LOCAL_DASH_DB_NAME };
