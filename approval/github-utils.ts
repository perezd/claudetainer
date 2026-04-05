import { readFileSync } from "fs";

export interface RepoTarget {
  owner: string;
  repo: string;
}

const REMOTE_URLS_PATH = "/tmp/approval/git-remote-urls.txt";
const MAX_REMOTES = 5;

export function extractGitHubOwner(url: string): string | null {
  const httpsMatch = url.match(/https?:\/\/github\.com\/([^/]+)\/[^/]+/);
  if (httpsMatch) return httpsMatch[1];

  const sshMatch = url.match(/git@github\.com:([^/]+)\/[^/]+/);
  if (sshMatch) return sshMatch[1];

  const sshUrlMatch = url.match(/ssh:\/\/git@github\.com\/([^/]+)\/[^/]+/);
  if (sshUrlMatch) return sshUrlMatch[1];

  return null;
}

export function extractGitHubRepo(url: string): RepoTarget | null {
  const patterns = [
    /https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  return null;
}

export function getRelatedRepos(): RepoTarget[] | null {
  try {
    const content = readFileSync(REMOTE_URLS_PATH, "utf-8").trim();
    if (!content) return null;

    const urls = content.split("\n").filter((line) => line.trim());
    if (urls.length === 0) return null;
    if (urls.length > MAX_REMOTES) return null;

    const repos: RepoTarget[] = [];
    for (const url of urls) {
      const repo = extractGitHubRepo(url.trim());
      if (repo) repos.push(repo);
    }

    return repos.length > 0 ? repos : null;
  } catch {
    return null;
  }
}
