import DB, { type SchemaToDocumentTypes } from "goldfishdb/browser";
import type { AppState, WorkspaceType } from "./store";

const {
  collection,
  number,
  schema,
  string,
} = DB.v1.schemaType;

const localDashStateSchema = schema({
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

type LocalDashStateDocumentTypes = SchemaToDocumentTypes<typeof localDashStateSchema>;
type LocalDashStateDb = DB<typeof localDashStateSchema>;

const LOCAL_DASH_DB_NAME = "bunny-dash-local-state";
const APP_SETTINGS_KEY = "primary";

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
    localDashDbPromise = new DB<typeof localDashStateSchema>().initAsync({
      schemaHistory: [{ v: 1, schema: localDashStateSchema, migrationSteps: false }],
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
): WorkspaceType {
  if (!persistedWorkspace) {
    return hostWorkspace;
  }

  return {
    ...hostWorkspace,
    ...persistedWorkspace,
    id: hostWorkspace.id || persistedWorkspace.id,
    name: hostWorkspace.name || persistedWorkspace.name,
  };
}

export { LOCAL_DASH_DB_NAME };
