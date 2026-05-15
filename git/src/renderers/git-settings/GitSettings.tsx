import { Show, createMemo, createSignal, onMount } from "solid-js";
import { join } from "../shared/pathUtils";
import { GitHubRepoSelector } from "./GitHubRepoSelector";
import { type GitHubRepository } from "./githubService";
import { getQueryParam, invokeFsCarrot, invokeGitCarrot, sendToHost } from "../shared/bridge";

type GitIntegrationState = {
  git: {
    name: string;
    email: string;
    hasKeychainHelper: boolean;
  };
  github: {
    connected: boolean;
    username: string;
    connectedAt?: number;
    scopes: string[];
    user: {
      login: string;
      name: string;
      avatar_url: string;
      public_repos: number;
      private_repos: number;
    } | null;
    hasKeychainHelper: boolean;
    hasStoredCredentials: boolean;
  };
};

const sectionTitleStyle = {
  color: "#e5e7eb",
  "font-size": "14px",
  "font-weight": 700,
  "margin-bottom": "10px",
} as const;

const fieldLabelStyle = {
  color: "#9ca3af",
  "font-size": "11px",
  "font-weight": 600,
  "margin-bottom": "6px",
  "text-transform": "uppercase",
  "letter-spacing": "0.04em",
} as const;

const inputStyle = {
  width: "100%",
  background: "#1f1f1f",
  color: "#f3f4f6",
  border: "1px solid #3f3f46",
  "border-radius": "8px",
  padding: "10px 12px",
  "box-sizing": "border-box",
  "font-size": "13px",
} as const;

const buttonStyle = (variant: "primary" | "secondary" | "danger" = "secondary") => ({
  background:
    variant === "primary" ? "#2563eb" : variant === "danger" ? "#b91c1c" : "#2f2f2f",
  color: variant === "secondary" ? "#e5e7eb" : "#ffffff",
  border: variant === "secondary" ? "1px solid #444" : "none",
  "border-radius": "8px",
  padding: "10px 14px",
  "font-size": "13px",
  "font-weight": 600,
  cursor: "pointer",
}) as const;

export const GitSettings = () => {
  const mode = getQueryParam("mode");
  const parentPath = getQueryParam("parentPath");
  const isCloneMode = () => mode === "clone";

  const [statusMessage, setStatusMessage] = createSignal("");
  const [isBusy, setIsBusy] = createSignal(false);
  const [integrationState, setIntegrationState] = createSignal<GitIntegrationState | null>(null);

  const [gitName, setGitName] = createSignal("");
  const [gitEmail, setGitEmail] = createSignal("");
  const [usernameInput, setUsernameInput] = createSignal("");
  const [patInput, setPatInput] = createSignal("");

  const [targetFolderName, setTargetFolderName] = createSignal("new-repo");
  const [gitUrl, setGitUrl] = createSignal("");
  const [selectedRepo, setSelectedRepo] = createSignal<GitHubRepository | null>(null);
  const [selectedBranch, setSelectedBranch] = createSignal<string | null>(null);
  const [shouldCreateMainBranch, setShouldCreateMainBranch] = createSignal(false);
  const [useGitHubSelector, setUseGitHubSelector] = createSignal(true);

  const connected = () => Boolean(integrationState()?.github.connected);

  const repoPath = createMemo(() => {
    const folderName = targetFolderName().trim();
    if (!parentPath || !folderName) {
      return "";
    }
    return join(parentPath, folderName);
  });

  const loadState = async () => {
    const nextState = await invokeGitCarrot<GitIntegrationState>("getGitIntegrationState");
    setIntegrationState(nextState);
    setGitName(nextState.git.name || "");
    setGitEmail(nextState.git.email || "");
    setUsernameInput(nextState.github.user?.login || nextState.github.username || "");
  };

  onMount(() => {
    void loadState();
  });

  const saveIdentity = async () => {
    setIsBusy(true);
    setStatusMessage("");
    try {
      await invokeGitCarrot("setGitConfig", {
        name: gitName(),
        email: gitEmail(),
      });
      await loadState();
      setStatusMessage("Git identity saved.");
    } catch (error) {
      console.error("Failed to save git identity:", error);
      setStatusMessage("Failed to save git identity.");
    } finally {
      setIsBusy(false);
    }
  };

  const connectGitHub = async () => {
    const username = usernameInput().trim();
    const token = patInput().trim();
    if (!username || !token) {
      setStatusMessage("Enter both a GitHub username and token.");
      return;
    }

    setIsBusy(true);
    setStatusMessage("Connecting to GitHub…");
    try {
      await invokeGitCarrot("connectGitHub", {
        username,
        token,
      });
      setPatInput("");
      await loadState();
      setStatusMessage("GitHub connected.");
    } catch (error) {
      console.error("Failed to connect GitHub:", error);
      setStatusMessage(error instanceof Error ? error.message : "Failed to connect GitHub.");
    } finally {
      setIsBusy(false);
    }
  };

  const disconnectGitHub = async () => {
    setIsBusy(true);
    setStatusMessage("");
    try {
      await invokeGitCarrot("disconnectGitHub");
      await loadState();
      setPatInput("");
      setStatusMessage("GitHub disconnected.");
    } catch (error) {
      console.error("Failed to disconnect GitHub:", error);
      setStatusMessage("Failed to disconnect GitHub.");
    } finally {
      setIsBusy(false);
    }
  };

  const onSelectRepository = (
    repo: GitHubRepository,
    branch?: string,
    isEmptyRepo?: boolean,
  ) => {
    setSelectedRepo(repo);
    setSelectedBranch(branch || null);
    setShouldCreateMainBranch(Boolean(isEmptyRepo));
    setGitUrl(repo.clone_url);
    if (!targetFolderName() || targetFolderName() === "new-repo") {
      setTargetFolderName(repo.name);
    }
  };

  const openClassicTokenPage = () => {
    sendToHost({
      type: "open-url",
      url: "https://github.com/settings/tokens/new?scopes=repo,read:user,read:org&description=Bunny%20Git",
    });
  };

  const cloneRepo = async () => {
    if (!parentPath) {
      setStatusMessage("Missing clone target folder.");
      return;
    }

    const folderName = targetFolderName().trim();
    const url = gitUrl().trim();
    if (!folderName) {
      setStatusMessage("Choose a folder name for the cloned repository.");
      return;
    }
    if (!url) {
      setStatusMessage("Enter a repository URL or choose a GitHub repository.");
      return;
    }

    setIsBusy(true);
    setStatusMessage("Validating repository…");

    try {
      const validation = await invokeGitCarrot<{ valid: boolean; error?: string }>("gitValidateUrl", {
        gitUrl: url,
      });
      if (!validation.valid) {
        setStatusMessage(validation.error || "Repository URL is not accessible.");
        return;
      }

      const targetPath = repoPath();
      const exists = await invokeFsCarrot<boolean>("exists", { path: targetPath });
      if (exists) {
        setStatusMessage("That folder already exists. Choose a different name.");
        return;
      }

      await invokeFsCarrot("mkdir", { path: targetPath });
      setStatusMessage("Cloning repository…");

      await invokeGitCarrot("gitClone", {
        repoPath: targetPath,
        gitUrl: url,
        createMainBranch: shouldCreateMainBranch(),
        branch: selectedBranch() || undefined,
      });

      sendToHost({
        type: "clone-success",
        folderPath: targetPath,
      });
    } catch (error) {
      console.error("Clone failed:", error);
      const targetPath = repoPath();
      if (targetPath) {
        try {
          await invokeFsCarrot("safeDeleteFileOrFolder", { absolutePath: targetPath });
        } catch {}
      }
      setStatusMessage(error instanceof Error ? error.message : "Failed to clone repository.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        background: "#18181b",
        color: "#d4d4d8",
        padding: "18px",
        "box-sizing": "border-box",
      }}
    >
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", "margin-bottom": "18px" }}>
        <div>
          <div style={{ color: "#f4f4f5", "font-size": "18px", "font-weight": 700 }}>
            {isCloneMode() ? "Clone Repository" : "Git & GitHub"}
          </div>
          <Show when={isCloneMode()}>
            <div style={{ color: "#9ca3af", "font-size": "12px", "margin-top": "4px" }}>
              Clone into {parentPath}
            </div>
          </Show>
        </div>
        <button
          type="button"
          onClick={() => sendToHost({ type: "close-settings" })}
          style={buttonStyle("secondary")}
        >
          Close
        </button>
      </div>

      <Show when={statusMessage()}>
        <div
          style={{
            background: "#27272a",
            color: "#d4d4d8",
            padding: "10px 12px",
            "border-radius": "8px",
            "font-size": "12px",
            "margin-bottom": "16px",
          }}
        >
          {statusMessage()}
        </div>
      </Show>

      <div style={{ display: "flex", "flex-direction": "column", gap: "18px" }}>
        <div style={{ background: "#202024", padding: "16px", "border-radius": "12px", border: "1px solid #2f2f35" }}>
          <div style={sectionTitleStyle}>Git Identity</div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <div>
              <div style={fieldLabelStyle}>Author Name</div>
              <input value={gitName()} onInput={(e) => setGitName(e.currentTarget.value)} style={inputStyle} placeholder="Your Name" />
            </div>
            <div>
              <div style={fieldLabelStyle}>Author Email</div>
              <input value={gitEmail()} onInput={(e) => setGitEmail(e.currentTarget.value)} style={inputStyle} placeholder="you@example.com" />
            </div>
            <div style={{ display: "flex", "justify-content": "flex-end" }}>
              <button type="button" disabled={isBusy()} onClick={() => void saveIdentity()} style={buttonStyle("primary")}>
                Save Identity
              </button>
            </div>
          </div>
        </div>

        <div style={{ background: "#202024", padding: "16px", "border-radius": "12px", border: "1px solid #2f2f35" }}>
          <div style={sectionTitleStyle}>GitHub</div>
          <Show
            when={connected() && integrationState()?.github.user}
            fallback={
              <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                <div>
                  <div style={fieldLabelStyle}>Username</div>
                  <input value={usernameInput()} onInput={(e) => setUsernameInput(e.currentTarget.value)} style={inputStyle} placeholder="github-username" />
                </div>
                <div>
                  <div style={fieldLabelStyle}>Personal Access Token</div>
                  <input value={patInput()} onInput={(e) => setPatInput(e.currentTarget.value)} style={inputStyle} placeholder="ghp_..." type="password" />
                </div>
                <div style={{ display: "flex", gap: "8px", "justify-content": "space-between", "align-items": "center" }}>
                  <button type="button" onClick={openClassicTokenPage} style={buttonStyle("secondary")}>
                    Create Classic Token
                  </button>
                  <button type="button" disabled={isBusy()} onClick={() => void connectGitHub()} style={buttonStyle("primary")}>
                    Connect GitHub
                  </button>
                </div>
              </div>
            }
          >
            {(user) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
                <div style={{ display: "flex", gap: "12px", "align-items": "center" }}>
                  <img src={user().avatar_url} alt="GitHub avatar" width="44" height="44" style={{ "border-radius": "999px" }} />
                  <div>
                    <div style={{ color: "#f4f4f5", "font-weight": 700 }}>{user().name || user().login}</div>
                    <div style={{ color: "#a1a1aa", "font-size": "12px" }}>@{user().login}</div>
                    <div style={{ color: "#71717a", "font-size": "11px" }}>
                      {user().public_repos} public repo(s) • {user().private_repos} private repo(s)
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                  <div style={{ color: "#71717a", "font-size": "11px" }}>
                    Connected{integrationState()?.github.connectedAt ? ` on ${new Date(integrationState()!.github.connectedAt!).toLocaleString()}` : ""}
                  </div>
                  <button type="button" disabled={isBusy()} onClick={() => void disconnectGitHub()} style={buttonStyle("danger")}>
                    Disconnect GitHub
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>

        <Show when={isCloneMode()}>
          <div style={{ background: "#202024", padding: "16px", "border-radius": "12px", border: "1px solid #2f2f35" }}>
            <div style={sectionTitleStyle}>Clone</div>

            <div style={{ display: "flex", gap: "8px", "margin-bottom": "12px" }}>
              <button type="button" onClick={() => setUseGitHubSelector(true)} style={buttonStyle(useGitHubSelector() ? "primary" : "secondary")}>
                Browse GitHub
              </button>
              <button type="button" onClick={() => setUseGitHubSelector(false)} style={buttonStyle(!useGitHubSelector() ? "primary" : "secondary")}>
                Manual URL
              </button>
            </div>

            <Show when={useGitHubSelector()}>
              <GitHubRepoSelector
                connected={connected()}
                onSelectRepository={onSelectRepository}
                selectedRepo={selectedRepo()}
                selectedBranch={selectedBranch()}
              />
            </Show>

            <div style={{ display: "flex", "flex-direction": "column", gap: "12px", "margin-top": "14px" }}>
              <div>
                <div style={fieldLabelStyle}>Repository URL</div>
                <input value={gitUrl()} onInput={(e) => setGitUrl(e.currentTarget.value)} style={inputStyle} placeholder="https://github.com/owner/repo.git" />
              </div>
              <div>
                <div style={fieldLabelStyle}>Destination Folder Name</div>
                <input value={targetFolderName()} onInput={(e) => setTargetFolderName(e.currentTarget.value)} style={inputStyle} placeholder="new-repo" />
              </div>
              <Show when={selectedBranch()}>
                <div style={{ color: "#9ca3af", "font-size": "12px" }}>
                  Selected branch: <span style={{ color: "#f4f4f5" }}>{selectedBranch()}</span>
                </div>
              </Show>
              <Show when={shouldCreateMainBranch()}>
                <label style={{ display: "flex", gap: "8px", "align-items": "center", color: "#d4d4d8", "font-size": "12px" }}>
                  <input checked={shouldCreateMainBranch()} onInput={(e) => setShouldCreateMainBranch(e.currentTarget.checked)} type="checkbox" />
                  Create an initial main branch for an empty repository
                </label>
              </Show>
              <div style={{ color: "#71717a", "font-size": "11px" }}>
                Target path: {repoPath() || "Choose a folder name"}
              </div>
              <div style={{ display: "flex", "justify-content": "flex-end" }}>
                <button type="button" disabled={isBusy()} onClick={() => void cloneRepo()} style={buttonStyle("primary")}>
                  Clone Repository
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};
