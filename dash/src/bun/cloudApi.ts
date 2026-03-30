/**
 * Cloud API client for Bunny Dash.
 * Talks to the Electrobunny API for workspaces, instances, lenses, etc.
 */

export type CloudInstance = {
  id: string;
  user_id: string;
  name: string;
  os: string;
  machine_id: string;
  status: string;
  last_seen_at: number;
};

export type CloudWorkspace = {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  color: string;
  sort_order: number;
  mounts?: CloudProjectMount[];
  lenses?: CloudLens[];
};

export type CloudProjectMount = {
  id: string;
  workspace_id: string;
  instance_id: string;
  path: string;
  name: string;
  sort_order: number;
};

export type CloudLens = {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  layout_json: string;
  sort_order: number;
};

export type CloudApiAuth = {
  accessToken: string;
  refreshToken: string;
};

export class CloudApi {
  private baseUrl: string;
  private getAuth: () => CloudApiAuth;
  private onTokenRefresh: (tokens: { accessToken: string; refreshToken: string }) => void;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(
    baseUrl: string,
    callbacks: {
      getAuth: () => CloudApiAuth;
      onTokenRefresh: (tokens: { accessToken: string; refreshToken: string }) => void;
    },
  ) {
    this.baseUrl = baseUrl;
    this.getAuth = callbacks.getAuth;
    this.onTokenRefresh = callbacks.onTokenRefresh;
  }

  private async authedFetch(method: string, path: string, body?: unknown, isRetry = false): Promise<Response> {
    const auth = this.getAuth();
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 && !isRetry) {
      const refreshed = await this.tryRefresh();
      if (refreshed) return this.authedFetch(method, path, body, true);
    }
    return response;
  }

  private async tryRefresh(): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const auth = this.getAuth();
        if (!auth.refreshToken) return false;
        const resp = await fetch(`${this.baseUrl}/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: auth.refreshToken }),
        });
        if (!resp.ok) return false;
        const data = (await resp.json()) as { accessToken: string; refreshToken: string };
        this.onTokenRefresh(data);
        return true;
      } catch { return false; }
      finally { this.refreshPromise = null; }
    })();
    return this.refreshPromise;
  }

  private async jsonOrThrow<T>(response: Response): Promise<T> {
    if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  // Instances
  async upsertInstance(machineId: string, name: string, os: string): Promise<CloudInstance> {
    const res = await this.authedFetch("PUT", "/v1/instances", { machine_id: machineId, name, os });
    return (await this.jsonOrThrow<{ instance: CloudInstance }>(res)).instance;
  }

  async getInstances(): Promise<CloudInstance[]> {
    const res = await this.authedFetch("GET", "/v1/instances");
    return (await this.jsonOrThrow<{ instances: CloudInstance[] }>(res)).instances;
  }

  // Workspaces
  async listWorkspaces(): Promise<CloudWorkspace[]> {
    const res = await this.authedFetch("GET", "/v1/workspaces");
    return (await this.jsonOrThrow<{ workspaces: CloudWorkspace[] }>(res)).workspaces;
  }

  async createWorkspace(name: string, description?: string, color?: string): Promise<CloudWorkspace> {
    const res = await this.authedFetch("POST", "/v1/workspaces", { name, description, color });
    return (await this.jsonOrThrow<{ workspace: CloudWorkspace }>(res)).workspace;
  }

  async updateWorkspace(id: string, updates: { name?: string; description?: string; color?: string }): Promise<void> {
    await this.authedFetch("PUT", `/v1/workspaces/${id}`, updates);
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.authedFetch("DELETE", `/v1/workspaces/${id}`);
  }

  // Project Mounts
  async createProjectMount(workspaceId: string, instanceId: string, path: string, name: string): Promise<CloudProjectMount> {
    const res = await this.authedFetch("POST", `/v1/workspaces/${workspaceId}/mounts`, { instance_id: instanceId, path, name });
    return (await this.jsonOrThrow<{ mount: CloudProjectMount }>(res)).mount;
  }

  async deleteProjectMount(workspaceId: string, mountId: string): Promise<void> {
    await this.authedFetch("DELETE", `/v1/workspaces/${workspaceId}/mounts/${mountId}`);
  }

  // Lenses
  async createLens(workspaceId: string, name: string, layoutJson?: string, description?: string): Promise<CloudLens> {
    const res = await this.authedFetch("POST", `/v1/workspaces/${workspaceId}/lenses`, { name, description, layout_json: layoutJson });
    return (await this.jsonOrThrow<{ lens: CloudLens }>(res)).lens;
  }

  async updateLens(workspaceId: string, lensId: string, updates: { name?: string; description?: string; layout_json?: string }): Promise<void> {
    await this.authedFetch("PUT", `/v1/workspaces/${workspaceId}/lenses/${lensId}`, updates);
  }

  async deleteLens(workspaceId: string, lensId: string): Promise<void> {
    await this.authedFetch("DELETE", `/v1/workspaces/${workspaceId}/lenses/${lensId}`);
  }
}

export function getApiBaseUrl(channel?: string): string {
  if (channel === "dev") return "http://localhost:8787";
  if (channel === "staging") return "https://staging-api.electrobunny.ai";
  return "https://api.electrobunny.ai";
}
