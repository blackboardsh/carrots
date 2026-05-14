import {
  For,
  Show,
  createEffect,
  createSignal,
  onMount,
  type JSXElement,
} from "solid-js";
import {
  type GitHubOrganization,
  type GitHubRepository,
  githubService,
} from "./githubService";

export const GitHubRepoSelector = (props: {
  connected: boolean;
  onSelectRepository: (
    repo: GitHubRepository,
    branch?: string,
    isEmptyRepo?: boolean,
  ) => void;
  selectedRepo?: GitHubRepository | null;
  selectedBranch?: string | null;
}): JSXElement => {
  const [repositories, setRepositories] = createSignal<GitHubRepository[]>([]);
  const [organizations, setOrganizations] = createSignal<GitHubOrganization[]>([]);
  const [selectedOrg, setSelectedOrg] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [sortBy, setSortBy] = createSignal<"updated" | "name" | "stars">("updated");
  const [filterType, setFilterType] = createSignal<"all" | "owner" | "member">("all");
  const [showBranches, setShowBranches] = createSignal<GitHubRepository | null>(null);
  const [branches, setBranches] = createSignal<
    Array<{ name: string; commit: { sha: string }; protected: boolean }>
  >([]);

  const isOwnerRepoPattern = (query: string): { owner: string; repo: string } | null => {
    const trimmed = query.trim();
    const urlMatch = trimmed.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    );
    if (urlMatch) {
      return { owner: urlMatch[1], repo: urlMatch[2] };
    }
    const simpleMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (simpleMatch) {
      return { owner: simpleMatch[1], repo: simpleMatch[2] };
    }
    return null;
  };

  const loadOrganizations = async () => {
    if (!props.connected) {
      return;
    }
    try {
      const orgs = await githubService.fetchOrganizations();
      setOrganizations(orgs);
    } catch (err) {
      console.error("Error loading organizations:", err);
    }
  };

  const loadRepositories = async () => {
    if (!props.connected) {
      setError("GitHub not connected");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let repos: GitHubRepository[] = [];
      const ownerRepo = isOwnerRepoPattern(searchQuery());

      if (ownerRepo) {
        try {
          repos = [await githubService.fetchRepository(ownerRepo.owner, ownerRepo.repo)];
        } catch (err) {
          console.log("Direct repo fetch failed, falling back to search:", err);
          repos = [];
        }
      } else if (selectedOrg() === "public") {
        const query = searchQuery().trim() || "stars:>100 created:>2020-01-01";
        const result = await githubService.searchRepositories(query, {
          sort: sortBy() === "name" ? "updated" : (sortBy() as "updated" | "stars"),
          per_page: 50,
          includeUserFilter: false,
        });
        repos = result.items;
      } else if (selectedOrg() && selectedOrg() !== "") {
        repos = await githubService.fetchOrganizationRepositories(selectedOrg()!, {
          sort:
            sortBy() === "stars" || sortBy() === "name"
              ? "updated"
              : (sortBy() as "created" | "updated" | "pushed"),
          per_page: 50,
        });
      } else if (searchQuery().trim()) {
        const result = await githubService.searchRepositories(searchQuery().trim(), {
          includeUserFilter: true,
        });
        repos = result.items;
      } else {
        repos = await githubService.fetchUserRepositories({
          sort:
            sortBy() === "stars" || sortBy() === "name"
              ? "updated"
              : (sortBy() as "created" | "updated" | "pushed"),
          type: filterType(),
          per_page: 50,
        });
      }

      repos.sort((a, b) => {
        switch (sortBy()) {
          case "name":
            return a.name.localeCompare(b.name);
          case "stars":
            return b.stargazers_count - a.stargazers_count;
          default:
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        }
      });

      setRepositories(repos);
    } catch (err) {
      console.error("Error loading repositories:", err);
      setError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setLoading(false);
    }
  };

  const loadBranches = async (repo: GitHubRepository) => {
    try {
      const repoBranches = await githubService.fetchRepositoryBranches(repo.owner.login, repo.name);
      let defaultBranch: string;
      let isEmptyRepo = false;

      if (repoBranches.length === 0) {
        setBranches([{ name: "main", commit: { sha: "" }, protected: false }]);
        defaultBranch = "main";
        isEmptyRepo = true;
      } else {
        setBranches(repoBranches);
        defaultBranch = repo.default_branch || repoBranches[0].name;
      }

      props.onSelectRepository(repo, defaultBranch, isEmptyRepo);
      setShowBranches(repo);
    } catch (err) {
      console.error("Error loading branches:", err);
      setError("Failed to load branches");
    }
  };

  onMount(() => {
    void loadRepositories();
    void loadOrganizations();
  });

  createEffect(() => {
    selectedOrg();
    sortBy();
    filterType();
    void loadRepositories();
  });

  createEffect(() => {
    if (!props.connected) {
      return;
    }
    const query = searchQuery();
    const timeout = setTimeout(() => {
      void loadRepositories();
    }, query.trim() ? 300 : 0);
    return () => clearTimeout(timeout);
  });

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
      <Show when={props.connected} fallback={<div style={{ color: "#9ca3af", "font-size": "12px" }}>GitHub not connected</div>}>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            placeholder="Search repos or owner/repo"
            style={{
              flex: 1,
              background: "#222",
              color: "#e5e7eb",
              border: "1px solid #444",
              "border-radius": "6px",
              padding: "8px 10px",
            }}
          />
          <select
            value={selectedOrg() || ""}
            onChange={(e) => setSelectedOrg(e.currentTarget.value || null)}
            style={{
              background: "#222",
              color: "#e5e7eb",
              border: "1px solid #444",
              "border-radius": "6px",
              padding: "8px 10px",
            }}
          >
            <option value="">My Repos</option>
            <option value="public">Public</option>
            <For each={organizations()}>
              {(org) => <option value={org.login}>{org.login}</option>}
            </For>
          </select>
        </div>

        <div style={{ display: "flex", gap: "8px" }}>
          <select
            value={sortBy()}
            onChange={(e) => setSortBy(e.currentTarget.value as "updated" | "name" | "stars")}
            style={{
              background: "#222",
              color: "#e5e7eb",
              border: "1px solid #444",
              "border-radius": "6px",
              padding: "8px 10px",
            }}
          >
            <option value="updated">Updated</option>
            <option value="name">Name</option>
            <option value="stars">Stars</option>
          </select>
          <Show when={!selectedOrg()}>
            <select
              value={filterType()}
              onChange={(e) => setFilterType(e.currentTarget.value as "all" | "owner" | "member")}
              style={{
                background: "#222",
                color: "#e5e7eb",
                border: "1px solid #444",
                "border-radius": "6px",
                padding: "8px 10px",
              }}
            >
              <option value="all">All</option>
              <option value="owner">Owned</option>
              <option value="member">Member</option>
            </select>
          </Show>
        </div>

        <Show when={error()}>
          <div style={{ color: "#f87171", "font-size": "12px" }}>{error()}</div>
        </Show>
        <Show when={loading()}>
          <div style={{ color: "#9ca3af", "font-size": "12px" }}>Loading repositories…</div>
        </Show>

        <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "max-height": "260px", overflow: "auto" }}>
          <For each={repositories()}>
            {(repo) => (
              <div
                style={{
                  border: "1px solid #3a3a3a",
                  "border-radius": "8px",
                  padding: "10px",
                  background: props.selectedRepo?.id === repo.id ? "#1d4ed8" : "#252525",
                  cursor: "pointer",
                }}
                onClick={() => void loadBranches(repo)}
              >
                <div style={{ display: "flex", "justify-content": "space-between", gap: "8px" }}>
                  <div>
                    <div style={{ color: "#f3f4f6", "font-weight": 600 }}>{repo.full_name}</div>
                    <Show when={repo.description}>
                      <div style={{ color: "#9ca3af", "font-size": "12px", "margin-top": "4px" }}>{repo.description}</div>
                    </Show>
                  </div>
                  <div style={{ color: "#9ca3af", "font-size": "11px", "white-space": "nowrap" }}>
                    ★ {repo.stargazers_count}
                  </div>
                </div>

                <Show when={showBranches()?.id === repo.id}>
                  <div style={{ display: "flex", "flex-wrap": "wrap", gap: "6px", "margin-top": "10px" }}>
                    <For each={branches()}>
                      {(branch) => (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            props.onSelectRepository(repo, branch.name, branches().length === 1 && branch.name === "main" && !branch.commit.sha);
                          }}
                          style={{
                            background: props.selectedBranch === branch.name ? "#f59e0b" : "#333",
                            color: props.selectedBranch === branch.name ? "#111827" : "#e5e7eb",
                            border: "none",
                            "border-radius": "999px",
                            padding: "4px 8px",
                            "font-size": "11px",
                            cursor: "pointer",
                          }}
                        >
                          {branch.name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
