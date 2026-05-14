import { invokeGitCarrot } from "../shared/bridge";

export interface GitHubRepository {
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
}

export interface GitHubOrganization {
  id: number;
  login: string;
  description: string | null;
  avatar_url: string;
}

class GitHubService {
  async fetchUserRepositories(options: {
    sort?: "created" | "updated" | "pushed" | "full_name";
    direction?: "asc" | "desc";
    per_page?: number;
    page?: number;
    type?: "all" | "owner" | "member";
  } = {}) {
    return invokeGitCarrot<GitHubRepository[]>("githubFetchUserRepositories", options);
  }

  async fetchOrganizations() {
    return invokeGitCarrot<GitHubOrganization[]>("githubFetchOrganizations");
  }

  async fetchOrganizationRepositories(
    org: string,
    options: {
      sort?: "created" | "updated" | "pushed" | "full_name";
      direction?: "asc" | "desc";
      per_page?: number;
      page?: number;
      type?: "all" | "public" | "private" | "forks" | "sources" | "member";
    } = {},
  ) {
    return invokeGitCarrot<GitHubRepository[]>("githubFetchOrganizationRepositories", {
      org,
      ...options,
    });
  }

  async searchRepositories(
    query: string,
    options: {
      sort?: "stars" | "forks" | "help-wanted-issues" | "updated";
      order?: "asc" | "desc";
      per_page?: number;
      page?: number;
      includeUserFilter?: boolean;
    } = {},
  ) {
    return invokeGitCarrot<{ items: GitHubRepository[]; total_count: number }>(
      "githubSearchRepositories",
      {
        query,
        ...options,
      },
    );
  }

  async fetchRepository(owner: string, repo: string) {
    return invokeGitCarrot<GitHubRepository>("githubFetchRepository", {
      owner,
      repo,
    });
  }

  async fetchRepositoryBranches(owner: string, repo: string) {
    return invokeGitCarrot<
      Array<{
        name: string;
        commit: { sha: string };
        protected: boolean;
      }>
    >("githubFetchRepositoryBranches", { owner, repo });
  }
}

export const githubService = new GitHubService();
