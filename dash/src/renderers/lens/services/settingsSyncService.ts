/**
 * Settings Sync Service
 * Handles gathering, uploading, and downloading syncable settings
 */

import { state, setState, updateSyncedAppSettings } from '../store';
import { encryptSettings, decryptSettings, type EncryptedPayload } from './settingsSyncEncryption';
import { loadPersistedTokens, persistTokens } from '../localStateDb';

/**
 * Schema for synced settings
 */
export interface SyncedSettings {
  // Schema version for migrations
  schemaVersion: number;
  // When this sync was created
  exportedAt: number;

  // Llama/AI settings
  llama: {
    enabled?: boolean;
    baseUrl?: string;
    model?: string;
    temperature?: number;
    inlineEnabled?: boolean;
  };

  // GitHub auth
  github?: {
    accessToken: string;
    username: string;
    connectedAt: number;
    scopes: string[];
  };

  // Third-party API tokens
  tokens: Array<{
    name: string;
    url?: string;
    endpoint: string;
    token: string;
  }>;

  // Legacy plugin sync is intentionally disabled. Carrots replace plugins.
  plugins: Array<never>;

  // UI preferences (future)
  ui?: {
    defaultSidebarWidth?: number;
    defaultShowSidebar?: boolean;
  };
}

const SCHEMA_VERSION = 1;

/**
 * Get the API base URL based on build channel
 */
function getApiBaseUrl(): string {
  const channel = state.buildVars.channel;
  const host = typeof window !== "undefined" ? window.location.hostname : "";

  if (channel === "dev" || host === "localhost" || host === "127.0.0.1") {
    return "http://127.0.0.1:8788";
  }

  if (
    channel === "canary" ||
    channel === "staging" ||
    host.includes("staging")
  ) {
    return "https://staging-api.electrobunny.ai";
  }

  return "https://api.electrobunny.ai";
}

/**
 * Gather all syncable settings from the app
 */
export async function gatherSyncableSettings(): Promise<SyncedSettings> {
  // Get llama settings
  const llama = {
    enabled: state.appSettings.llama?.enabled,
    baseUrl: state.appSettings.llama?.baseUrl,
    model: state.appSettings.llama?.model,
    temperature: state.appSettings.llama?.temperature,
    inlineEnabled: state.appSettings.llama?.inlineEnabled,
  };

  // Get GitHub settings (if connected)
  const github = state.appSettings.github?.accessToken
    ? {
        accessToken: state.appSettings.github.accessToken,
        username: state.appSettings.github.username || '',
        connectedAt: state.appSettings.github.connectedAt || 0,
        scopes: state.appSettings.github.scopes || [],
      }
    : undefined;

  // Get API tokens from local browser persistence
  let tokens: SyncedSettings['tokens'] = [];
  try {
    const persistedTokens = await loadPersistedTokens();
    if (Array.isArray(persistedTokens)) {
      tokens = persistedTokens.map((t: any) => ({
        name: t.name,
        url: t.url,
        endpoint: t.endpoint,
        token: t.token,
      }));
    }
  } catch (error) {
    console.warn('Failed to get tokens for sync:', error);
  }

  const plugins: SyncedSettings['plugins'] = [];

  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: Date.now(),
    llama,
    github,
    tokens,
    plugins,
  };
}

/**
 * Apply synced settings to the app
 */
export async function applySyncedSettings(settings: SyncedSettings): Promise<void> {
  // Apply llama settings
  if (settings.llama) {
    setState('appSettings', 'llama', {
      ...state.appSettings.llama,
      ...settings.llama,
    });
  }

  // Apply GitHub settings
  if (settings.github) {
    setState('appSettings', 'github', {
      accessToken: settings.github.accessToken,
      username: settings.github.username,
      connectedAt: settings.github.connectedAt,
      scopes: settings.github.scopes,
    });
  }

  if (settings.tokens) {
    setState('tokens', settings.tokens as any);
    await persistTokens(settings.tokens as any);
  }

  // Persist changes
  updateSyncedAppSettings();
}

/**
 * Upload settings to Bunny Cloud
 */
export async function uploadSettings(passphrase: string): Promise<{ success: boolean; error?: string }> {
  const accessToken = state.appSettings.bunnyCloud?.accessToken;
  if (!accessToken) {
    return { success: false, error: 'Not logged in to Bunny Cloud' };
  }

  try {
    // Gather settings
    const settings = await gatherSyncableSettings();

    // Encrypt with passphrase
    const encryptedPayload = await encryptSettings(settings, passphrase);

    // Upload to server
    const response = await fetch(`${getApiBaseUrl()}/api/sync/settings`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ encryptedPayload }),
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error || 'Upload failed' };
    }

    return { success: true };
  } catch (error) {
    console.error('Settings upload error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Upload failed' };
  }
}

/**
 * Download and apply settings from Bunny Cloud
 */
export async function downloadSettings(passphrase: string): Promise<{ success: boolean; error?: string }> {
  const accessToken = state.appSettings.bunnyCloud?.accessToken;
  if (!accessToken) {
    return { success: false, error: 'Not logged in to Bunny Cloud' };
  }

  try {
    // Download from server
    const response = await fetch(`${getApiBaseUrl()}/api/sync/settings`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const result = await response.json();

    if (!response.ok) {
      return { success: false, error: result.error || 'Download failed' };
    }

    if (!result.exists) {
      return { success: false, error: 'No settings found in cloud' };
    }

    // Decrypt with passphrase
    const encryptedPayload = result.data as EncryptedPayload;
    let settings: SyncedSettings;
    try {
      settings = await decryptSettings<SyncedSettings>(encryptedPayload, passphrase);
    } catch (decryptError) {
      return { success: false, error: 'Wrong passphrase' };
    }

    // Apply settings
    await applySyncedSettings(settings);

    return { success: true };
  } catch (error) {
    console.error('Settings download error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Download failed' };
  }
}

/**
 * Get sync status from server
 */
export async function getSyncStatus(): Promise<{
  hasSyncedSettings: boolean;
  storage?: {
    used: number;
    limit: number;
    usedFormatted: string;
    limitFormatted: string;
    percentUsed: number;
  };
  lastSync?: {
    at: number | null;
  };
  error?: string;
}> {
  const accessToken = state.appSettings.bunnyCloud?.accessToken;
  if (!accessToken) {
    return { hasSyncedSettings: false, error: 'Not logged in' };
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/sync/status`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return { hasSyncedSettings: false, error: data.error };
    }

    return data;
  } catch (error) {
    return { hasSyncedSettings: false, error: 'Failed to fetch status' };
  }
}
