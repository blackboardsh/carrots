import {
  type JSXElement,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import { state, setState, updateSyncedAppSettings } from "../store";
import {
  SettingsPaneSaveClose,
  SettingsPaneFormSection,
  SettingsPaneField,
} from "./forms";
import {
  uploadSettings,
  downloadSettings,
  getSyncStatus,
} from "../services/settingsSyncService";
import { electrobun } from "../init";

export const BunnyCloudSettings = (): JSXElement => {
  const [isSettingPassphrase, setIsSettingPassphrase] = createSignal(false);
  const [newPassphrase, setNewPassphrase] = createSignal("");
  const [confirmPassphrase, setConfirmPassphrase] = createSignal("");
  const [isSyncing, setIsSyncing] = createSignal(false);
  const [syncMessage, setSyncMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);
  const [syncStatus, setSyncStatus] = createSignal<{
    hasSyncedSettings: boolean;
    storage?: {
      used: number;
      limit: number;
      usedFormatted: string;
      limitFormatted: string;
      percentUsed: number;
    };
    lastSync?: { at: number | null };
  } | null>(null);

  const hasPassphrase = () => !!state.appSettings.bunnyCloud?.syncPassphrase;

  const isConnected = () => {
    return state.appSettings.bunnyCloud?.accessToken && state.appSettings.bunnyCloud?.email;
  };

  const formatDate = (timestamp: number | undefined | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp * 1000).toLocaleString();
  };

  onMount(() => {
    if (isConnected()) {
      fetchSyncStatus();
    }
  });

  const fetchSyncStatus = async () => {
    const status = await getSyncStatus();
    if (!status.error) {
      setSyncStatus(status);
    }
  };

  const handleSavePassphrase = () => {
    if (!newPassphrase()) {
      setSyncMessage({ type: 'error', text: 'Please enter a passphrase' });
      return;
    }
    if (newPassphrase().length < 8) {
      setSyncMessage({ type: 'error', text: 'Passphrase must be at least 8 characters' });
      return;
    }
    if (newPassphrase() !== confirmPassphrase()) {
      setSyncMessage({ type: 'error', text: 'Passphrases do not match' });
      return;
    }

    setState("appSettings", "bunnyCloud", {
      ...state.appSettings.bunnyCloud,
      syncPassphrase: newPassphrase(),
    });
    updateSyncedAppSettings();
    setNewPassphrase("");
    setConfirmPassphrase("");
    setIsSettingPassphrase(false);
    setSyncMessage({ type: 'success', text: 'Passphrase saved!' });
  };

  const showSyncMessage = (message: { type: 'success' | 'error'; text: string }, minDuration = 2000) => {
    setSyncMessage(message);
    setTimeout(() => setSyncMessage(null), minDuration);
  };

  const handleBackup = async () => {
    const passphrase = state.appSettings.bunnyCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: 'error', text: 'Please set a passphrase first' });
      return;
    }
    setIsSyncing(true);
    setSyncMessage(null);
    const result = await uploadSettings(passphrase);
    setIsSyncing(false);
    if (result.success) {
      showSyncMessage({ type: 'success', text: 'Settings backed up successfully!' });
      fetchSyncStatus();
    } else {
      showSyncMessage({ type: 'error', text: result.error || 'Backup failed' });
    }
  };

  const handleRestore = async () => {
    const passphrase = state.appSettings.bunnyCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: 'error', text: 'Please set a passphrase first' });
      return;
    }
    setIsSyncing(true);
    setSyncMessage(null);
    const result = await downloadSettings(passphrase);
    setIsSyncing(false);
    if (result.success) {
      showSyncMessage({ type: 'success', text: 'Settings restored successfully!' });
      fetchSyncStatus();
    } else {
      showSyncMessage({ type: 'error', text: result.error || 'Restore failed. Wrong passphrase?' });
    }
  };

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;">
      <form onSubmit={onSubmit} style="height: 100%; display: flex; flex-direction: column;">
        <SettingsPaneSaveClose label="Bunny Cloud" />

        <div style="flex: 1; overflow-y: auto; padding: 0; margin-bottom: 60px;">
          {/* Account Section */}
          <SettingsPaneFormSection label="Account">
            <Show when={isConnected()} fallback={
              <SettingsPaneField label="">
                <div style="background: #2b2b2b; padding: 16px; border-radius: 4px; text-align: center;">
                  <div style="font-size: 12px; color: #999; margin-bottom: 12px;">
                    Not connected to Bunny Cloud
                  </div>
                  <button
                    type="button"
                    onClick={() => electrobun.rpc?.request.openFarm()}
                    style="background: #4ade80; color: #1a1a1a; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;"
                  >
                    Open Farm to Sign In
                  </button>
                </div>
              </SettingsPaneField>
            }>
              <SettingsPaneField label="">
                <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                    <div style={{
                      width: "8px",
                      height: "8px",
                      "border-radius": "50%",
                      background: "#51cf66",
                    }}></div>
                    <span style="font-weight: 500; font-size: 12px;">Connected</span>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-size: 12px; font-weight: 500; color: #d9d9d9;">
                      {state.appSettings.bunnyCloud?.name || state.appSettings.bunnyCloud?.email}
                    </span>
                    <span style="font-size: 10px; color: #999;">
                      {state.appSettings.bunnyCloud?.email}
                    </span>
                    <Show when={!state.appSettings.bunnyCloud?.emailVerified}>
                      <span style="font-size: 10px; color: #ffa500; margin-top: 4px;">
                        Email not verified
                      </span>
                    </Show>
                  </div>
                </div>
              </SettingsPaneField>

              <SettingsPaneField label="">
                <button
                  type="button"
                  onClick={() => electrobun.rpc?.request.openFarm()}
                  style="background: #333; color: #d9d9d9; border: 1px solid #555; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%;"
                >
                  Manage Account in Farm
                </button>
              </SettingsPaneField>
            </Show>
          </SettingsPaneFormSection>

          {/* Settings Backup Section - Only show when connected */}
          <Show when={isConnected()}>
            <SettingsPaneFormSection label="Settings Backup">
              <Show when={!hasPassphrase() && !isSettingPassphrase()}>
                <SettingsPaneField label="">
                  <div style="background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); padding: 16px; border-radius: 4px; text-align: center;">
                    <div style="font-size: 13px; color: #ffc107; font-weight: 500; margin-bottom: 8px;">
                      Set up encryption to enable sync
                    </div>
                    <div style="font-size: 11px; color: #999; margin-bottom: 12px;">
                      Your settings are encrypted locally before upload. We never see your data.
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsSettingPassphrase(true)}
                      style="background: #4ade80; color: #1a1a1a; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;"
                    >
                      Set Encryption Passphrase
                    </button>
                  </div>
                </SettingsPaneField>
              </Show>

              <Show when={isSettingPassphrase()}>
                <SettingsPaneField label="Create Encryption Passphrase">
                  <div style="font-size: 11px; color: #999; margin-bottom: 12px;">
                    This passphrase encrypts your settings. You'll need it to restore on other devices.
                  </div>
                  <input
                    type="password"
                    placeholder="Enter passphrase (min 8 characters)"
                    value={newPassphrase()}
                    onInput={(e) => setNewPassphrase(e.currentTarget.value)}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; margin-bottom: 8px;"
                  />
                  <input
                    type="password"
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase()}
                    onInput={(e) => setConfirmPassphrase(e.currentTarget.value)}
                    style="background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box; margin-bottom: 12px;"
                  />
                  <div style="display: flex; gap: 8px;">
                    <button
                      type="button"
                      onClick={handleSavePassphrase}
                      style="flex: 1; background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500;"
                    >
                      Save Passphrase
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsSettingPassphrase(false);
                        setNewPassphrase("");
                        setConfirmPassphrase("");
                        setSyncMessage(null);
                      }}
                      style="background: #333; color: #d9d9d9; border: 1px solid #555; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px;"
                    >
                      Cancel
                    </button>
                  </div>
                </SettingsPaneField>
              </Show>

              <Show when={hasPassphrase() && !isSettingPassphrase()}>
                <Show when={syncStatus()}>
                  <SettingsPaneField label="Backup Status">
                    <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                      <div style="font-size: 11px; color: #999;">
                        <Show when={syncStatus()?.hasSyncedSettings} fallback={
                          <span>No backup yet</span>
                        }>
                          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                            <span>Last backup:</span>
                            <span style="color: #d9d9d9;">{formatDate(syncStatus()?.lastSync?.at)}</span>
                          </div>
                          <div style="display: flex; justify-content: space-between;">
                            <span>Size:</span>
                            <span style="color: #d9d9d9;">
                              {syncStatus()?.storage?.usedFormatted} / {syncStatus()?.storage?.limitFormatted}
                            </span>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </SettingsPaneField>
                </Show>

                <SettingsPaneField label="">
                  <div style={{
                    height: syncMessage() ? "auto" : "0",
                    "min-height": syncMessage() ? "36px" : "0",
                    "margin-bottom": syncMessage() ? "12px" : "0",
                    overflow: "hidden",
                    transition: "all 0.15s ease",
                  }}>
                    <Show when={syncMessage()}>
                      <div style={{
                        background: syncMessage()?.type === 'success'
                          ? "rgba(74, 222, 128, 0.1)"
                          : "rgba(255, 107, 107, 0.1)",
                        border: syncMessage()?.type === 'success'
                          ? "1px solid rgba(74, 222, 128, 0.3)"
                          : "1px solid rgba(255, 107, 107, 0.3)",
                        color: syncMessage()?.type === 'success' ? "#4ade80" : "#ff6b6b",
                        padding: "8px 12px",
                        "border-radius": "4px",
                        "font-size": "11px",
                        "text-align": "center",
                      }}>
                        {syncMessage()?.text}
                      </div>
                    </Show>
                  </div>
                  <div style="display: flex; gap: 8px;">
                    <button
                      type="button"
                      onClick={handleBackup}
                      disabled={isSyncing()}
                      style={`flex: 1; background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; opacity: ${isSyncing() ? 0.7 : 1};`}
                    >
                      {isSyncing() ? "Working..." : "Backup"}
                    </button>
                    <button
                      type="button"
                      onClick={handleRestore}
                      disabled={isSyncing() || !syncStatus()?.hasSyncedSettings}
                      style={`flex: 1; background: #333; color: #d9d9d9; border: 1px solid #555; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; opacity: ${(isSyncing() || !syncStatus()?.hasSyncedSettings) ? 0.5 : 1};`}
                    >
                      Restore
                    </button>
                  </div>
                </SettingsPaneField>

                <SettingsPaneField label="">
                  <button
                    type="button"
                    onClick={() => setIsSettingPassphrase(true)}
                    style="background: transparent; color: #999; border: none; padding: 4px 0; cursor: pointer; font-size: 11px; text-decoration: underline;"
                  >
                    Change passphrase
                  </button>
                </SettingsPaneField>
              </Show>
            </SettingsPaneFormSection>
          </Show>
        </div>
      </form>
    </div>
  );
};
