import {
  type JSXElement,
  createEffect,
  createSignal,
  For,
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

type SyncMessage = { type: "success" | "error"; text: string } | null;

type CloudInstance = {
  id: string;
  name: string;
  os: string;
  machine_id: string;
  status: string;
  last_seen_at: number;
};

type CloudWorkspace = {
  id: string;
  name: string;
  mounts?: Array<unknown>;
  lenses?: Array<unknown>;
};

type CloudDevice = {
  id: string;
  machine_id: string;
  name: string;
  last_used_at: number | null;
  created_at: number;
};

type CloudOverview = {
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
  devices: CloudDevice[];
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

const tabButtonStyle = (active: boolean) =>
  `background: ${active ? "#2f4638" : "#2b2b2b"}; color: ${active ? "#7cf29b" : "#bcbcbc"}; border: 1px solid ${active ? "#436950" : "#444"}; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: 600;`;

const actionButtonStyle =
  "background: #333; color: #d9d9d9; border: 1px solid #555; padding: 8px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;";

const primaryButtonStyle =
  "background: #4ade80; color: #1a1a1a; border: none; padding: 10px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600;";

const inputStyle =
  "background: #2b2b2b; border: 1px solid #555; color: #d9d9d9; padding: 8px 12px; border-radius: 4px; font-size: 12px; width: 100%; box-sizing: border-box;";

export const BunnyCloudSettings = (): JSXElement => {
  const [activeTab, setActiveTab] = createSignal<"account" | "instances" | "workspaces">("account");
  const [cloudOverview, setCloudOverview] = createSignal<CloudOverview | null>(null);
  const [isLoadingOverview, setIsLoadingOverview] = createSignal(false);
  const [isSubmittingAuth, setIsSubmittingAuth] = createSignal(false);
  const [authMode, setAuthMode] = createSignal<"login" | "register">("login");
  const [authEmail, setAuthEmail] = createSignal("");
  const [authPassword, setAuthPassword] = createSignal("");
  const [authName, setAuthName] = createSignal("");
  const [workspaceName, setWorkspaceName] = createSignal("");
  const [isCreatingWorkspace, setIsCreatingWorkspace] = createSignal(false);
  const [isSettingPassphrase, setIsSettingPassphrase] = createSignal(false);
  const [newPassphrase, setNewPassphrase] = createSignal("");
  const [confirmPassphrase, setConfirmPassphrase] = createSignal("");
  const [isSyncing, setIsSyncing] = createSignal(false);
  const [syncMessage, setSyncMessage] = createSignal<SyncMessage>(null);
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

  const isConnected = () =>
    !!(
      cloudOverview()?.connected ||
      (state.appSettings.bunnyCloud?.accessToken && state.appSettings.bunnyCloud?.email)
    );

  const currentUser = () => cloudOverview()?.user;
  const currentUserName = () =>
    currentUser()?.name ||
    state.appSettings.bunnyCloud?.name ||
    state.appSettings.bunnyCloud?.email ||
    "";
  const currentUserEmail = () =>
    currentUser()?.email || state.appSettings.bunnyCloud?.email || "";
  const emailVerified = () =>
    currentUser()?.email_verified ?? state.appSettings.bunnyCloud?.emailVerified ?? false;

  const showSyncMessage = (message: Exclude<SyncMessage, null>, minDuration = 2000) => {
    setSyncMessage(message);
    setTimeout(() => setSyncMessage(null), minDuration);
  };

  const formatDate = (timestamp: number | undefined | null) => {
    if (!timestamp) return "Never";
    return new Date(timestamp * 1000).toLocaleString();
  };

  const loadOverview = async () => {
    const request = electrobun.rpc?.request.getBunnyCloudOverview;
    if (!request) {
      return;
    }
    setIsLoadingOverview(true);
    try {
      const overview = await request();
      setCloudOverview(overview || null);
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to load Bunny Cloud status",
      });
    } finally {
      setIsLoadingOverview(false);
    }
  };

  const fetchSyncStatus = async () => {
    const status = await getSyncStatus();
    if (!status.error) {
      setSyncStatus(status);
    }
  };

  onMount(() => {
    void loadOverview();
  });

  createEffect(() => {
    if (isConnected()) {
      void fetchSyncStatus();
    } else {
      setSyncStatus(null);
    }
  });

  const handleSavePassphrase = () => {
    if (!newPassphrase()) {
      setSyncMessage({ type: "error", text: "Please enter a passphrase" });
      return;
    }
    if (newPassphrase().length < 8) {
      setSyncMessage({ type: "error", text: "Passphrase must be at least 8 characters" });
      return;
    }
    if (newPassphrase() !== confirmPassphrase()) {
      setSyncMessage({ type: "error", text: "Passphrases do not match" });
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
    setSyncMessage({ type: "success", text: "Passphrase saved!" });
  };

  const handleBackup = async () => {
    const passphrase = state.appSettings.bunnyCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: "error", text: "Please set a passphrase first" });
      return;
    }
    setIsSyncing(true);
    setSyncMessage(null);
    const result = await uploadSettings(passphrase);
    setIsSyncing(false);
    if (result.success) {
      showSyncMessage({ type: "success", text: "Settings backed up successfully!" });
      void fetchSyncStatus();
    } else {
      showSyncMessage({ type: "error", text: result.error || "Backup failed" });
    }
  };

  const handleRestore = async () => {
    const passphrase = state.appSettings.bunnyCloud?.syncPassphrase;
    if (!passphrase) {
      showSyncMessage({ type: "error", text: "Please set a passphrase first" });
      return;
    }
    setIsSyncing(true);
    setSyncMessage(null);
    const result = await downloadSettings(passphrase);
    setIsSyncing(false);
    if (result.success) {
      showSyncMessage({ type: "success", text: "Settings restored successfully!" });
      void fetchSyncStatus();
    } else {
      showSyncMessage({ type: "error", text: result.error || "Restore failed. Wrong passphrase?" });
    }
  };

  const handleLogout = async () => {
    setIsSyncing(true);
    setSyncMessage(null);

    try {
      const logoutRequest = electrobun.rpc?.request.logoutBunnyCloud;
      if (!logoutRequest) {
        throw new Error("Bunny Cloud logout is unavailable in this view");
      }

      await logoutRequest();
      setState("appSettings", "bunnyCloud", (current) => ({
        ...current,
        accessToken: "",
        refreshToken: "",
        userId: "",
        email: "",
        name: "",
        emailVerified: false,
        connectedAt: undefined,
      }));
      setCloudOverview((current) =>
        current
          ? {
              ...current,
              connected: false,
              user: null,
              instances: [],
              workspaces: [],
              devices: [],
              currentInstanceId: null,
              currentDeviceTokenId: null,
            }
          : null,
      );
      setSyncStatus(null);
      updateSyncedAppSettings();
      showSyncMessage({ type: "success", text: "Logged out of Bunny Cloud" });
      await loadOverview();
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Logout failed",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAuthSubmit = async () => {
    if (!authEmail().trim() || !authPassword()) {
      showSyncMessage({ type: "error", text: "Email and password are required" });
      return;
    }

    setIsSubmittingAuth(true);
    setSyncMessage(null);

    try {
      const response = await electrobun.rpc?.request.loginBunnyCloud({
        mode: authMode(),
        email: authEmail().trim(),
        password: authPassword(),
        name: authName().trim() || undefined,
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Sign in failed");
      }

      setCloudOverview(response.overview || null);
      setAuthPassword("");
      showSyncMessage({
        type: "success",
        text: authMode() === "register" ? "Account created" : "Signed in to Bunny Cloud",
      });
      await loadOverview();
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Authentication failed",
      });
    } finally {
      setIsSubmittingAuth(false);
    }
  };

  const handleRegisterCurrentInstance = async () => {
    try {
      const response = await electrobun.rpc?.request.registerCurrentBunnyCloudInstance();
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to register this instance");
      }
      setCloudOverview(response.overview || null);
      showSyncMessage({ type: "success", text: "This instance is now linked to Bunny Cloud" });
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to register this instance",
      });
    }
  };

  const handleUpdateCurrentCarrots = async () => {
    try {
      const response = await electrobun.rpc?.request.updateCurrentBunnyCloudCarrots();
      setCloudOverview(response?.overview || null);
      showSyncMessage({ type: "success", text: "Updating carrots for this instance" });
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to update carrots",
      });
    }
  };

  const handleCreateWorkspace = async () => {
    if (!workspaceName().trim()) {
      return;
    }
    setIsCreatingWorkspace(true);
    try {
      const response = await electrobun.rpc?.request.createBunnyCloudWorkspace({
        name: workspaceName().trim(),
      });
      setCloudOverview(response?.overview || null);
      setWorkspaceName("");
      showSyncMessage({ type: "success", text: "Workspace created" });
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to create workspace",
      });
    } finally {
      setIsCreatingWorkspace(false);
    }
  };

  const handleRemoveInstance = async (instanceId: string) => {
    if (!window.confirm("Remove this instance from Bunny Cloud?")) {
      return;
    }
    try {
      const response = await electrobun.rpc?.request.removeBunnyCloudInstance({ instanceId });
      setCloudOverview(response?.overview || null);
      showSyncMessage({ type: "success", text: "Instance removed" });
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to remove instance",
      });
    }
  };

  const handleRevokeDevice = async (deviceTokenId: string) => {
    if (!window.confirm("Revoke this device token?")) {
      return;
    }
    try {
      const response = await electrobun.rpc?.request.revokeBunnyCloudDevice({ deviceTokenId });
      setCloudOverview(response?.overview || null);
      showSyncMessage({ type: "success", text: "Device revoked" });
    } catch (error) {
      showSyncMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to revoke device",
      });
    }
  };

  const currentMachine = () => cloudOverview()?.currentMachine;
  const currentInstanceId = () => cloudOverview()?.currentInstanceId;
  const currentDeviceTokenId = () => cloudOverview()?.currentDeviceTokenId;

  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    setState("settingsPane", { type: "", data: {} });
  };

  return (
    <div style="background: #404040; color: #d9d9d9; height: 100vh; overflow: hidden; display: flex; flex-direction: column;">
      <form onSubmit={onSubmit} style="height: 100%; display: flex; flex-direction: column;">
        <SettingsPaneSaveClose label="Bunny Cloud" />

        <div style="flex: 1; overflow-y: auto; padding: 0; margin-bottom: 60px;">
          <SettingsPaneFormSection label="Status">
            <SettingsPaneField label="">
              <div style="background: #2b2b2b; padding: 14px; border-radius: 4px;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                  <div
                    style={{
                      width: "8px",
                      height: "8px",
                      "border-radius": "50%",
                      background: isConnected() ? "#51cf66" : "#999",
                    }}
                  />
                  <span style="font-weight: 600; font-size: 12px;">
                    {isConnected() ? "Connected to Bunny Cloud" : "Local mode is active"}
                  </span>
                </div>
                <div style="font-size: 11px; color: #999; line-height: 1.5;">
                  <Show
                    when={isConnected()}
                    fallback={
                      <>Bunny Dash works on this machine without an account. Sign in here to unlock workspaces, linked instances, and synced settings.</>
                    }
                  >
                    Signed in as {currentUserEmail() || currentUserName()}.
                  </Show>
                </div>
                <Show when={syncMessage()}>
                  {(message) => (
                    <div
                      style={`margin-top: 12px; padding: 10px 12px; border-radius: 4px; font-size: 11px; background: ${
                        message().type === "success" ? "rgba(74, 222, 128, 0.12)" : "rgba(255, 107, 107, 0.12)"
                      }; border: 1px solid ${
                        message().type === "success" ? "rgba(74, 222, 128, 0.28)" : "rgba(255, 107, 107, 0.28)"
                      }; color: ${message().type === "success" ? "#8af5aa" : "#ffb4b4"};`}
                    >
                      {message().text}
                    </div>
                  )}
                </Show>
                <div style="display: flex; gap: 8px; margin-top: 12px;">
                  <button type="button" onClick={() => void loadOverview()} style={actionButtonStyle}>
                    {isLoadingOverview() ? "Refreshing..." : "Refresh"}
                  </button>
                  <Show when={isConnected()}>
                    <button
                      type="button"
                      onClick={() => void handleLogout()}
                      disabled={isSyncing()}
                      style={`background: ${isSyncing() ? "#2a2a2a" : "#4a2323"}; color: ${isSyncing() ? "#777" : "#ffb4b4"}; border: 1px solid ${isSyncing() ? "#3a3a3a" : "#6a3a3a"}; padding: 8px 12px; border-radius: 4px; cursor: ${isSyncing() ? "default" : "pointer"}; font-size: 12px;`}
                    >
                      {isSyncing() ? "Logging Out..." : "Log Out"}
                    </button>
                  </Show>
                </div>
              </div>
            </SettingsPaneField>
          </SettingsPaneFormSection>

          <SettingsPaneFormSection label="Cloud">
            <SettingsPaneField label="">
              <div style="display: flex; gap: 8px;">
                <button type="button" onClick={() => setActiveTab("account")} style={tabButtonStyle(activeTab() === "account")}>
                  Account
                </button>
                <button type="button" onClick={() => setActiveTab("instances")} style={tabButtonStyle(activeTab() === "instances")}>
                  Instances
                </button>
                <button type="button" onClick={() => setActiveTab("workspaces")} style={tabButtonStyle(activeTab() === "workspaces")}>
                  Workspaces
                </button>
              </div>
            </SettingsPaneField>

            <Show when={activeTab() === "account"}>
              <Show
                when={isConnected()}
                fallback={
                  <SettingsPaneField label="">
                    <div style="background: #2b2b2b; padding: 16px; border-radius: 4px;">
                      <div style="font-size: 12px; color: #d9d9d9; font-weight: 600; margin-bottom: 12px;">
                        {authMode() === "register" ? "Create a Bunny Cloud account" : "Sign in to Bunny Cloud"}
                      </div>
                      <Show when={authMode() === "register"}>
                        <input
                          type="text"
                          placeholder="Your name (optional)"
                          value={authName()}
                          onInput={(e) => setAuthName(e.currentTarget.value)}
                          style={`${inputStyle} margin-bottom: 8px;`}
                        />
                      </Show>
                      <input
                        type="email"
                        placeholder="you@example.com"
                        value={authEmail()}
                        onInput={(e) => setAuthEmail(e.currentTarget.value)}
                        style={`${inputStyle} margin-bottom: 8px;`}
                      />
                      <input
                        type="password"
                        placeholder={authMode() === "register" ? "Min 8 characters" : "Enter password"}
                        value={authPassword()}
                        onInput={(e) => setAuthPassword(e.currentTarget.value)}
                        style={inputStyle}
                      />
                      <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <button
                          type="button"
                          onClick={() => void handleAuthSubmit()}
                          disabled={isSubmittingAuth()}
                          style={primaryButtonStyle}
                        >
                          {isSubmittingAuth()
                            ? "Working..."
                            : authMode() === "register"
                              ? "Create Account"
                              : "Sign In"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuthMode(authMode() === "login" ? "register" : "login")}
                          style={actionButtonStyle}
                        >
                          {authMode() === "login" ? "Need an account?" : "Already have an account?"}
                        </button>
                      </div>
                    </div>
                  </SettingsPaneField>
                }
              >
                <SettingsPaneField label="">
                  <div style="background: #2b2b2b; padding: 14px; border-radius: 4px;">
                    <div style="font-size: 12px; font-weight: 600; color: #d9d9d9; margin-bottom: 6px;">
                      {currentUserName() || "Bunny Cloud"}
                    </div>
                    <div style="font-size: 11px; color: #999; margin-bottom: 4px;">
                      {currentUserEmail()}
                    </div>
                    <div style="font-size: 10px; color: #666;">
                      User ID: {currentUser()?.id || state.appSettings.bunnyCloud?.userId || "—"}
                    </div>
                    <Show when={!emailVerified()}>
                      <div style="font-size: 10px; color: #ffa500; margin-top: 8px;">
                        Email not verified
                      </div>
                    </Show>
                  </div>
                </SettingsPaneField>

                <SettingsPaneField label="Signed-in Devices">
                  <Show
                    when={(cloudOverview()?.devices || []).length > 0}
                    fallback={<div style="font-size: 11px; color: #888;">No device tokens registered yet.</div>}
                  >
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                      <For each={cloudOverview()?.devices || []}>
                        {(device) => (
                          <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                            <div style="display: flex; justify-content: space-between; gap: 12px;">
                              <div style="min-width: 0;">
                                <div style="font-size: 12px; font-weight: 600; color: #d9d9d9;">
                                  {device.name}
                                  <Show when={device.id === currentDeviceTokenId()}>
                                    <span style="margin-left: 8px; font-size: 10px; color: #7cf29b;">This instance</span>
                                  </Show>
                                </div>
                                <div style="font-size: 10px; color: #888; margin-top: 4px;">
                                  Added {formatDate(device.created_at)} · Last used {formatDate(device.last_used_at)}
                                </div>
                                <div style="font-size: 10px; color: #666; margin-top: 4px; word-break: break-all;">
                                  {device.machine_id}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={() => void handleRevokeDevice(device.id)}
                                style="background: transparent; color: #ffb4b4; border: 1px solid #6a3a3a; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; height: fit-content;"
                              >
                                Revoke
                              </button>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </SettingsPaneField>
              </Show>
            </Show>

            <Show when={activeTab() === "instances"}>
              <SettingsPaneField label="This Instance">
                <div style="background: #2b2b2b; padding: 14px; border-radius: 4px;">
                  <div style="font-size: 12px; font-weight: 600; color: #d9d9d9;">
                    {currentMachine()?.instanceName || "This instance"}
                  </div>
                  <div style="font-size: 10px; color: #888; margin-top: 4px;">
                    Machine ID: {currentMachine()?.machineId || "Unavailable"}
                  </div>
                  <div style="font-size: 11px; color: #999; margin-top: 8px;">
                    <Show
                      when={currentInstanceId()}
                      fallback="This instance is currently local-only."
                    >
                      Linked to Bunny Cloud as instance {currentInstanceId()}.
                    </Show>
                  </div>
                  <div style="display: flex; gap: 8px; margin-top: 12px;">
                    <button type="button" onClick={() => void handleRegisterCurrentInstance()} style={primaryButtonStyle}>
                      {currentInstanceId() ? "Re-link This Instance" : "Register This Instance"}
                    </button>
                    <button type="button" onClick={() => void handleUpdateCurrentCarrots()} style={actionButtonStyle}>
                      Update Carrots
                    </button>
                  </div>
                  <Show when={(cloudOverview()?.currentCarrots || []).length > 0}>
                    <div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
                      <For each={cloudOverview()?.currentCarrots || []}>
                        {(carrot) => (
                          <div style="display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #bdbdbd; background: #252525; padding: 8px 10px; border-radius: 4px;">
                            <span>{carrot.name}</span>
                            <span style="color: #777;">{carrot.version} · {carrot.status}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </SettingsPaneField>

              <SettingsPaneField label="Linked Instances">
                <Show
                  when={(cloudOverview()?.instances || []).length > 0}
                  fallback={<div style="font-size: 11px; color: #888;">Sign in to view cloud-linked instances.</div>}
                >
                  <div style="display: flex; flex-direction: column; gap: 8px;">
                    <For each={cloudOverview()?.instances || []}>
                      {(instance) => (
                        <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                          <div style="display: flex; justify-content: space-between; gap: 12px;">
                            <div style="min-width: 0;">
                              <div style="font-size: 12px; font-weight: 600; color: #d9d9d9;">
                                {instance.name}
                                <Show when={instance.id === currentInstanceId()}>
                                  <span style="margin-left: 8px; font-size: 10px; color: #7cf29b;">This instance</span>
                                </Show>
                              </div>
                              <div style="font-size: 10px; color: #888; margin-top: 4px;">
                                {instance.os} · Last seen {formatDate(instance.last_seen_at)}
                              </div>
                              <div style="font-size: 10px; color: #666; margin-top: 4px; word-break: break-all;">
                                {instance.machine_id}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleRemoveInstance(instance.id)}
                              style="background: transparent; color: #ffb4b4; border: 1px solid #6a3a3a; padding: 6px 10px; border-radius: 4px; cursor: pointer; font-size: 11px; height: fit-content;"
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </SettingsPaneField>
            </Show>

            <Show when={activeTab() === "workspaces"}>
              <Show
                when={isConnected()}
                fallback={
                  <SettingsPaneField label="">
                    <div style="font-size: 11px; color: #888;">
                      Sign in to Bunny Cloud to create and manage workspaces.
                    </div>
                  </SettingsPaneField>
                }
              >
                <SettingsPaneField label="Create Workspace">
                  <div style="display: flex; gap: 8px;">
                    <input
                      type="text"
                      placeholder="New workspace name"
                      value={workspaceName()}
                      onInput={(e) => setWorkspaceName(e.currentTarget.value)}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreateWorkspace()}
                      disabled={isCreatingWorkspace()}
                      style={primaryButtonStyle}
                    >
                      {isCreatingWorkspace() ? "..." : "Create"}
                    </button>
                  </div>
                </SettingsPaneField>

                <SettingsPaneField label="Workspaces">
                  <Show
                    when={(cloudOverview()?.workspaces || []).length > 0}
                    fallback={<div style="font-size: 11px; color: #888;">No workspaces yet.</div>}
                  >
                    <div style="display: flex; flex-direction: column; gap: 8px;">
                      <For each={cloudOverview()?.workspaces || []}>
                        {(workspace) => (
                          <div style="background: #2b2b2b; padding: 12px; border-radius: 4px;">
                            <div style="font-size: 12px; font-weight: 600; color: #d9d9d9;">{workspace.name}</div>
                            <div style="font-size: 10px; color: #888; margin-top: 4px;">
                              {(workspace.mounts || []).length} mount(s) · {(workspace.lenses || []).length} lens(es)
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </SettingsPaneField>
              </Show>
            </Show>
          </SettingsPaneFormSection>

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
                      style={primaryButtonStyle}
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
                    style={`${inputStyle} margin-bottom: 8px;`}
                  />
                  <input
                    type="password"
                    placeholder="Confirm passphrase"
                    value={confirmPassphrase()}
                    onInput={(e) => setConfirmPassphrase(e.currentTarget.value)}
                    style={`${inputStyle} margin-bottom: 12px;`}
                  />
                  <div style="display: flex; gap: 8px;">
                    <button type="button" onClick={handleSavePassphrase} style={primaryButtonStyle}>
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
                      style={actionButtonStyle}
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
                        <Show when={syncStatus()?.hasSyncedSettings} fallback={<span>No backup yet</span>}>
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
                  <div style="display: flex; gap: 8px;">
                    <button type="button" onClick={() => void handleBackup()} disabled={isSyncing()} style={primaryButtonStyle}>
                      {isSyncing() ? "Working..." : "Back Up Settings"}
                    </button>
                    <button type="button" onClick={() => void handleRestore()} disabled={isSyncing()} style={actionButtonStyle}>
                      Restore
                    </button>
                  </div>
                </SettingsPaneField>
              </Show>
            </SettingsPaneFormSection>
          </Show>
        </div>
      </form>
    </div>
  );
};
