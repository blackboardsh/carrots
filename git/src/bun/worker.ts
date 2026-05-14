import {
  checkGitHubCredentials,
  getGitConfig,
  getGitStatus,
  gitAdd,
  gitAddRemote,
  gitApply,
  gitBranch,
  gitCheckout,
  gitCheckoutBranch,
  gitCheckIsRepoInTree,
  gitCheckIsRepoRoot,
  gitClone,
  gitCommit,
  gitCommitAmend,
  gitCreateBranch,
  gitCreatePatchFromLines,
  gitDeleteBranch,
  gitDiff,
  gitDiscardAllChanges,
  gitDiscardFileChanges,
  gitFetch,
  gitLog,
  gitLogRemoteOnly,
  gitPull,
  gitPush,
  gitRemote,
  gitReset,
  gitRevert,
  gitRevParse,
  gitShow,
  gitStageHunkFromPatch,
  gitStageMonacoChange,
  gitStageSpecificLines,
  gitStashApply,
  gitStashCreate,
  gitStashDrop,
  gitStashList,
  gitStashPop,
  gitStashShow,
  gitStatus,
  gitTrackRemoteBranch,
  gitUnstageMonacoChange,
  gitValidateUrl,
  initGit,
  removeGitHubCredentials,
  setGitConfig,
  storeGitHubCredentials,
} from "./gitUtils";
import { app } from "electrobun/bun";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

type RequestMessage = {
  type?: string;
  requestId?: number;
  method?: string;
  params?: any;
};

type GitHubStoredAuth = {
  accessToken: string;
  username: string;
  connectedAt: number;
  scopes: string[];
  user: {
    login: string;
    name: string;
    avatar_url: string;
    public_repos: number;
    private_repos: number;
  } | null;
};

type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
};

type GitHubOrganization = {
  id: number;
  login: string;
  description: string | null;
  avatar_url: string;
};

const DEFAULT_STATE_PATH = join(process.cwd(), ".bunny-git-state.json");
const GITHUB_API_BASE = "https://api.github.com";

function getGitWorkerStatePath() {
  return app.statePath || DEFAULT_STATE_PATH;
}

function readGitWorkerState(): { github?: GitHubStoredAuth | null } {
  const statePath = getGitWorkerStatePath();
  if (!existsSync(statePath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeGitWorkerState(nextState: { github?: GitHubStoredAuth | null }) {
  const statePath = getGitWorkerStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(nextState, null, 2));
}

function getStoredGitHubAuth(): GitHubStoredAuth | null {
  return readGitWorkerState().github || null;
}

function setStoredGitHubAuth(auth: GitHubStoredAuth | null) {
  const current = readGitWorkerState();
  writeGitWorkerState({
    ...current,
    github: auth,
  });
}

async function githubFetch<T>(
  path: string,
  options: {
    accessToken?: string;
    searchParams?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<{ data: T; response: Response }> {
  const accessToken = options.accessToken || getStoredGitHubAuth()?.accessToken;
  if (!accessToken) {
    throw new Error("GitHub is not connected");
  }

  const url = new URL(`${GITHUB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(options.searchParams || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Bunny-Git/1.0.0",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub API ${response.status}: ${body || response.statusText}`);
  }

  return {
    data: await response.json() as T,
    response,
  };
}

async function verifyGitHubToken(token: string) {
  const { data, response } = await githubFetch<GitHubStoredAuth["user"]>("/user", {
    accessToken: token,
  });
  const scopes = response.headers.get("X-OAuth-Scopes")?.split(",").map((scope) => scope.trim()).filter(Boolean) || [];
  return {
    user: data,
    scopes,
  };
}

async function getGitIntegrationState() {
  const [gitConfig, credentials] = await Promise.all([
    getGitConfig(),
    checkGitHubCredentials(),
  ]);
  const auth = getStoredGitHubAuth();

  return {
    git: gitConfig,
    github: {
      connected: Boolean(auth?.accessToken),
      username: auth?.username || credentials.username || "",
      connectedAt: auth?.connectedAt,
      scopes: auth?.scopes || [],
      user: auth?.user || null,
      hasKeychainHelper: gitConfig.hasKeychainHelper,
      hasStoredCredentials: credentials.hasCredentials,
    },
  };
}

function postResponse(requestId: number | undefined, success: boolean, payload?: unknown, error?: string) {
  const normalizedPayload =
    payload === undefined
      ? undefined
      : payload === null || typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean"
        ? payload
        : JSON.parse(JSON.stringify(payload));

  self.postMessage({
    type: "response",
    requestId,
    success,
    payload: normalizedPayload,
    error,
  });
}

async function handleRequest(method: string, params: any) {
  switch (method) {
    case "gitShow":
      return gitShow(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCommit":
      return gitCommit(String(params?.repoRoot || ""), String(params?.msg || ""));
    case "gitCommitAmend":
      return gitCommitAmend(String(params?.repoRoot || ""), String(params?.msg || ""));
    case "gitAdd":
      return gitAdd(
        String(params?.repoRoot || ""),
        Array.isArray(params?.files) ? params.files.map(String) : String(params?.files || ""),
      );
    case "gitLog":
      return gitLog(
        String(params?.repoRoot || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
        typeof params?.limit === "number" ? params.limit : undefined,
        typeof params?.skip === "number" ? params.skip : undefined,
      );
    case "gitStatus":
      return gitStatus(String(params?.repoRoot || ""));
    case "gitDiff":
      return gitDiff(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCheckout":
      return gitCheckout(String(params?.repoRoot || ""), String(params?.hash || ""));
    case "gitCheckIsRepoRoot":
      return gitCheckIsRepoRoot(String(params?.repoRoot || ""));
    case "gitCheckIsRepoInTree":
      return gitCheckIsRepoInTree(String(params?.repoRoot || ""));
    case "gitRevParse":
      return gitRevParse(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitReset":
      return gitReset(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitRevert":
      return gitRevert(
        String(params?.repoRoot || ""),
        String(params?.commitHash || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitApply":
      return gitApply(
        String(params?.repoRoot || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
        typeof params?.patch === "string" ? params.patch : undefined,
      );
    case "gitStageHunkFromPatch":
      return gitStageHunkFromPatch(String(params?.repoRoot || ""), String(params?.patch || ""));
    case "gitStageSpecificLines":
      return gitStageSpecificLines(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        Number(params?.startLine || 0),
        Number(params?.endLine || 0),
      );
    case "gitStageMonacoChange":
      return gitStageMonacoChange(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        String(params?.originalContent || ""),
        params?.targetChange,
        String(params?.modifiedContent || ""),
      );
    case "gitUnstageMonacoChange":
      return gitUnstageMonacoChange(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        String(params?.originalContent || ""),
        params?.targetChange,
        String(params?.stagedContent || ""),
      );
    case "gitCreatePatchFromLines":
      return gitCreatePatchFromLines(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        Number(params?.startLine || 0),
        Number(params?.endLine || 0),
      );
    case "gitStashList":
      return gitStashList(String(params?.repoRoot || ""));
    case "gitStashCreate":
      return gitStashCreate(
        String(params?.repoRoot || ""),
        typeof params?.message === "string" ? params.message : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitStashApply":
      return gitStashApply(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitStashPop":
      return gitStashPop(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitStashShow":
      return gitStashShow(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitRemote":
      return gitRemote(String(params?.repoRoot || ""));
    case "gitAddRemote":
      return gitAddRemote(
        String(params?.repoRoot || ""),
        String(params?.remoteName || ""),
        String(params?.remoteUrl || ""),
      );
    case "gitFetch":
      return gitFetch(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitPull":
      return gitPull(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        typeof params?.branch === "string" ? params.branch : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitPush":
      return gitPush(
        String(params?.repoRoot || ""),
        typeof params?.remote === "string" ? params.remote : undefined,
        typeof params?.branch === "string" ? params.branch : undefined,
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitBranch":
      return gitBranch(String(params?.repoRoot || ""), Array.isArray(params?.options) ? params.options.map(String) : []);
    case "gitCheckoutBranch":
      return gitCheckoutBranch(
        String(params?.repoRoot || ""),
        String(params?.branch || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitLogRemoteOnly":
      return gitLogRemoteOnly(
        String(params?.repoRoot || ""),
        String(params?.localBranch || ""),
        String(params?.remoteBranch || ""),
      );
    case "gitClone":
      return gitClone(
        String(params?.repoPath || ""),
        String(params?.gitUrl || ""),
        Boolean(params?.createMainBranch),
        typeof params?.branch === "string" ? params.branch : undefined,
      );
    case "gitValidateUrl":
      return gitValidateUrl(String(params?.gitUrl || ""));
    case "getGitConfig":
      return getGitConfig();
    case "setGitConfig":
      return setGitConfig(String(params?.name || ""), String(params?.email || ""));
    case "checkGitHubCredentials":
      return checkGitHubCredentials();
    case "storeGitHubCredentials":
      return storeGitHubCredentials(String(params?.username || ""), String(params?.token || ""));
    case "removeGitHubCredentials":
      return removeGitHubCredentials();
    case "getGitIntegrationState":
      return getGitIntegrationState();
    case "verifyGitHubToken":
      return verifyGitHubToken(String(params?.token || ""));
    case "connectGitHub": {
      const username = String(params?.username || "");
      const token = String(params?.token || "");
      const { user, scopes } = await verifyGitHubToken(token);

      if (username && token) {
        try {
          await storeGitHubCredentials(username, token);
        } catch (error) {
          console.warn("[bunny.git] Failed to store GitHub credentials in keychain:", error);
        }
      }

      setStoredGitHubAuth({
        accessToken: token,
        username: user?.login || username,
        connectedAt: Date.now(),
        scopes,
        user,
      });

      return getGitIntegrationState();
    }
    case "disconnectGitHub":
      try {
        await removeGitHubCredentials();
      } catch (error) {
        console.warn("[bunny.git] Failed to remove GitHub credentials from keychain:", error);
      }
      setStoredGitHubAuth(null);
      return getGitIntegrationState();
    case "githubFetchUserRepositories": {
      const {
        sort = "updated",
        direction = "desc",
        per_page = 30,
        page = 1,
        type = "all",
      } = params || {};
      const { data } = await githubFetch<GitHubRepository[]>("/user/repos", {
        searchParams: { sort, direction, per_page, page, type },
      });
      return data;
    }
    case "githubFetchOrganizations": {
      const { data } = await githubFetch<GitHubOrganization[]>("/user/orgs");
      return data;
    }
    case "githubFetchOrganizationRepositories": {
      const {
        org = "",
        sort = "updated",
        direction = "desc",
        per_page = 30,
        page = 1,
        type = "all",
      } = params || {};
      const { data } = await githubFetch<GitHubRepository[]>(`/orgs/${encodeURIComponent(String(org))}/repos`, {
        searchParams: { sort, direction, per_page, page, type },
      });
      return data;
    }
    case "githubSearchRepositories": {
      const {
        query = "",
        sort = "updated",
        order = "desc",
        per_page = 30,
        page = 1,
        includeUserFilter = true,
      } = params || {};
      const auth = getStoredGitHubAuth();
      const searchQuery =
        includeUserFilter && auth?.username
          ? `${String(query)} user:${auth.username}`
          : String(query);
      const { data } = await githubFetch<{ items: GitHubRepository[]; total_count: number }>("/search/repositories", {
        searchParams: { q: searchQuery, sort, order, per_page, page },
      });
      return data;
    }
    case "githubFetchRepository": {
      const owner = String(params?.owner || "");
      const repo = String(params?.repo || "");
      const { data } = await githubFetch<GitHubRepository>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      return data;
    }
    case "githubFetchRepositoryBranches": {
      const owner = String(params?.owner || "");
      const repo = String(params?.repo || "");
      const { data } = await githubFetch<Array<{
        name: string;
        commit: { sha: string };
        protected: boolean;
      }>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`, {
        searchParams: { per_page: 100 },
      });
      return data;
    }
    case "gitCreateBranch":
      return gitCreateBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitDeleteBranch":
      return gitDeleteBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        Array.isArray(params?.options) ? params.options.map(String) : [],
      );
    case "gitTrackRemoteBranch":
      return gitTrackRemoteBranch(
        String(params?.repoRoot || ""),
        String(params?.branchName || ""),
        typeof params?.remoteName === "string" ? params.remoteName : undefined,
      );
    case "gitDropStash":
      return gitStashDrop(String(params?.repoRoot || ""), String(params?.stashName || ""));
    case "gitDiscardFileChanges":
      return gitDiscardFileChanges(
        String(params?.repoRoot || ""),
        String(params?.filePath || ""),
        String(params?.changeType || ""),
      );
    case "gitDiscardAllChanges":
      return gitDiscardAllChanges(String(params?.repoRoot || ""));
    case "initGit":
      return initGit(String(params?.repoRoot || ""));
    case "getGitStatus":
      return getGitStatus();
    default:
      return undefined;
  }
}

self.onmessage = async (event) => {
  const message = event.data as RequestMessage | undefined;

  if (!message || message.type !== "request") {
    return;
  }

  try {
    const payload = await handleRequest(String(message.method || ""), message.params);
    postResponse(message.requestId, true, payload);
  } catch (error) {
    postResponse(
      message.requestId,
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
};

self.postMessage({ type: "ready" });
