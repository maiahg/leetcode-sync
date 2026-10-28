type SyncDetail = {
  code?: string;
  slug?: string;
  title?: string;
  description?: string;
  difficulty?: string;
  questionId?: string;
  language?: string;
  submissionId?: string;
  source?: "history" | "live";
};

type Config = {
  githubToken?: string;
  repository?: string;
  branch: string;
  root: string;
};

type GitHubContent = { sha?: string; content?: string; name?: string };
type SyncIndexEntry = {
  path: string;
  questionId: string;
  slug: string;
  title: string;
  language: string;
  status: string;
  syncedAt: string;
};
type SyncIndex = { version: 1; lastSyncAt?: string; submissions: Record<string, SyncIndexEntry> };
type NewIndexEntry = { submissionId: string; entry: SyncIndexEntry };
type SyncResult = { skipped: boolean; path: string; newEntry?: NewIndexEntry };
class GitHubConflictError extends Error {}

const DEFAULTS: Pick<Config, "branch" | "root"> = { branch: "main", root: "problems" };
const INDEX_PATH = ".sync/index.json";
const EXTENSIONS: Record<string, string> = {
  bash: "sh", c: "c", "c++": "cpp", csharp: "cs", dart: "dart", golang: "go",
  java: "java", javascript: "js", kotlin: "kt", mysql: "sql", mssql: "sql",
  php: "php", python: "py", python3: "py", ruby: "rb", rust: "rs", scala: "scala",
  swift: "swift", typescript: "ts"
};
const LANGUAGE_LABELS: Record<string, string> = {
  "c++": "cpp", csharp: "csharp", golang: "go", javascript: "javascript",
  python3: "python", typescript: "typescript"
};

function safeSegment(value: unknown): string {
  return String(value || "untitled").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "untitled";
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function problemTitle(detail: SyncDetail): string {
  if (detail.title) return detail.title;
  return String(detail.slug || "untitled").replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function problemReadme(detail: SyncDetail): string {
  const problemId = detail.questionId ? `${detail.questionId}. ` : "";
  const description = detail.description?.trim() || "Problem description unavailable.";
  const difficulty = detail.difficulty ? `\n**Difficulty:** ${detail.difficulty}\n` : "";
  return `<!-- leetcode-sync:generated -->\n# ${problemId}${problemTitle(detail)}\n${difficulty}\n[View on LeetCode](https://leetcode.com/problems/${safeSegment(detail.slug)}/)\n\n## Problem Description\n\n${description}\n`;
}

function languageLabel(language: string): string {
  const normalized = language.toLowerCase();
  return LANGUAGE_LABELS[normalized] || normalized.replace(/[^a-z0-9]+/g, "") || "text";
}

function emptyIndex(): SyncIndex {
  return { version: 1, submissions: {} };
}

function submissionKey(detail: SyncDetail): string {
  if (detail.submissionId) return safeSegment(detail.submissionId);
  const input = `${detail.slug || ""}|${detail.language || ""}|${detail.code || ""}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `code-${(hash >>> 0).toString(16)}`;
}

function problemDirectory(detail: SyncDetail, config: Config): string {
  const id = /^\d+$/.test(String(detail.questionId || ""))
    ? String(detail.questionId).padStart(4, "0") : safeSegment(detail.questionId || "unknown");
  const slug = safeSegment(detail.slug);
  const root = String(config.root || "problems").replace(/^\/+|\/+$/g, "");
  const directory = `${id}-${slug}`;
  return root ? `${root}/${directory}` : directory;
}

function nextSolutionNumber(index: SyncIndex, directory: string, remoteNames: string[]): number {
  const paths = Object.values(index.submissions).map((entry) => entry.path).concat(remoteNames);
  const numbers = paths
    .filter((path) => path.startsWith(`${directory}/solution-`))
    .map((path) => Number(path.match(/\/solution-(\d+)-/)?.[1] || 0));
  return Math.max(0, ...numbers) + 1;
}

async function githubRequest<T>(config: Config, path: string, options: RequestInit = {}): Promise<T | null> {
  const response = await fetch(`https://api.github.com/repos/${config.repository}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json", Authorization: `Bearer ${config.githubToken}`,
      "X-GitHub-Api-Version": "2022-11-28", ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 404) return null;
    if (response.status === 409) throw new GitHubConflictError(`GitHub API 409: ${text.slice(0, 300)}`);
    throw new Error(`GitHub API ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

async function getFile(config: Config, path: string): Promise<GitHubContent | null> {
  return githubRequest<GitHubContent>(config, `/contents/${encodePath(path)}?ref=${encodeURIComponent(config.branch)}`);
}

async function putFile(config: Config, path: string, content: string, message: string): Promise<void> {
  const existing = await getFile(config, path);
  const body: { message: string; content: string; branch: string; sha?: string } = {
    message, content: encodeBase64(content), branch: config.branch
  };
  if (existing?.sha) body.sha = existing.sha;
  await githubRequest(config, `/contents/${encodePath(path)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
}

async function ensureProblemReadme(config: Config, detail: SyncDetail): Promise<void> {
  const readmePath = `${problemDirectory(detail, config)}/README.md`;
  const existingReadme = await getFile(config, readmePath);
  const existingReadmeText = existingReadme?.content ? decodeBase64(existingReadme.content) : "";
  const shouldCreateReadme = !existingReadme;
  const shouldUpgradeGeneratedReadme = existingReadmeText.includes("leetcode-sync:generated") ||
    (existingReadmeText.includes("Accepted solutions synced automatically.") && !existingReadmeText.includes("## Problem Description"));
  if (shouldCreateReadme || shouldUpgradeGeneratedReadme) {
    await putFile(config, readmePath, problemReadme(detail), `${shouldCreateReadme ? "Add" : "Update"} problem README: ${detail.slug || "problem"}`);
  }
}

async function loadIndex(config: Config): Promise<SyncIndex> {
  const file = await getFile(config, INDEX_PATH);
  if (!file?.content) return emptyIndex();
  try {
    const parsed = JSON.parse(decodeBase64(file.content)) as Partial<SyncIndex>;
    return {
      version: 1,
      lastSyncAt: parsed.lastSyncAt,
      submissions: parsed.submissions && typeof parsed.submissions === "object" ? parsed.submissions : {}
    };
  } catch (error) {
    throw new Error(`Could not parse ${INDEX_PATH}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadConfig(): Promise<Config> {
  return {
    ...DEFAULTS,
    ...(await chrome.storage.local.get(["githubToken", "repository", "branch", "root"]))
  };
}

async function saveIndexEntries(config: Config, entries: NewIndexEntry[], lastSyncAt?: string): Promise<void> {
  if (!config.githubToken || !config.repository) throw new Error("Configure the GitHub token and repository in the extension settings.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latestIndex = await loadIndex(config);
    for (const item of entries) {
      if (!latestIndex.submissions[item.submissionId]) latestIndex.submissions[item.submissionId] = item.entry;
    }
    if (lastSyncAt) latestIndex.lastSyncAt = lastSyncAt;
    try {
      await putFile(config, INDEX_PATH, `${JSON.stringify(latestIndex, null, 2)}\n`, "Update LeetCode sync index");
      return;
    } catch (error) {
      if (!(error instanceof GitHubConflictError) || attempt === 2) throw error;
    }
  }
}

async function markHistorySynced(startedAt: string, entries: NewIndexEntry[]): Promise<void> {
  await saveIndexEntries(await loadConfig(), entries, startedAt);
}

async function syncSubmission(detail: SyncDetail, writeIndex = true): Promise<SyncResult> {
  if (!detail.code?.trim()) throw new Error("LeetCode returned no editor code.");
  const config = await loadConfig();
  if (!config.githubToken || !config.repository) throw new Error("Configure the GitHub token and repository in the extension settings.");
  const index = await loadIndex(config);
  const submissionId = submissionKey(detail);
  const previous = index.submissions[submissionId];
  if (previous) {
    await ensureProblemReadme(config, detail);
    return { skipped: true, path: previous.path };
  }

  const directory = problemDirectory(detail, config);
  const listing = await githubRequest<Array<{ name?: string }>>(
    config, `/contents/${encodePath(directory)}?ref=${encodeURIComponent(config.branch)}`
  );
  const remoteNames = (listing || []).map((item) => `${directory}/${item.name || ""}`);
  const number = nextSolutionNumber(index, directory, remoteNames).toString().padStart(3, "0");
  const language = String(detail.language || "text").toLowerCase();
  const label = languageLabel(language);
  const extension = EXTENSIONS[language] || "txt";
  const path = `${directory}/solution-${number}-${label}.${extension}`;

  await putFile(config, path, detail.code, `Add accepted LeetCode solution: ${detail.slug || "problem"}`);
  await ensureProblemReadme(config, detail);
  const entry: SyncIndexEntry = {
    path,
    questionId: String(detail.questionId || ""),
    slug: String(detail.slug || ""),
    title: problemTitle(detail),
    language,
    status: "Accepted",
    syncedAt: new Date().toISOString()
  };
  const newEntry = { submissionId, entry };
  if (writeIndex) {
    await saveIndexEntries(config, [newEntry]);
  }
  return { path, skipped: false, newEntry };
}

function notify(title: string, message: string): void {
  console.log(`[${title}] ${message}`);
  void chrome.storage.local.set({
    lastSyncTitle: title,
    lastSyncMessage: message,
    lastSyncAt: new Date().toISOString()
  });
}

let syncQueue: Promise<void> = Promise.resolve();
let historyCount = 0;
let historySaved = 0;
let historyFailed = false;
let historyStartedAt = "";
let historyEntries: NewIndexEntry[] = [];

function enqueue(detail: SyncDetail, isHistory = false): void {
  syncQueue = syncQueue.then(() => syncSubmission(detail, !isHistory)).then((result) => {
    if (!isHistory && !result.skipped) notify("LeetCode synced", `Accepted solution saved to ${result.path}`);
    if (isHistory && !result.skipped) {
      historySaved += 1;
      if (result.newEntry) historyEntries.push(result.newEntry);
    }
  }).catch((error: unknown) => {
    if (isHistory) historyFailed = true;
    notify("LeetCode sync failed", error instanceof Error ? error.message : String(error));
  });
}

async function startHistorySync(tabId: number): Promise<void> {
  try {
    const config = await loadConfig();
    if (!config.githubToken || !config.repository) throw new Error("Configure the GitHub token and repository in the extension settings.");
    const index = await loadIndex(config);
    await chrome.tabs.sendMessage(tabId, {
      type: "LC_SYNC_HISTORY",
      detail: { since: index.lastSyncAt || null, knownSubmissionIds: Object.keys(index.submissions) }
    });
  } catch (error) {
    notify("LeetCode history sync failed", error instanceof Error ? error.message : String(error));
  }
}

chrome.runtime.onMessage.addListener((message: { type: string; tabId?: number; detail?: SyncDetail & { message?: string; startedAt?: string } }) => {
  const detail = message.detail || {};
  if (message.type === "LC_SYNC_HISTORY_REQUEST" && message.tabId) {
    void startHistorySync(message.tabId);
    return;
  }
  if (message.type === "LC_ACCEPTED_SUBMISSION") { enqueue(detail, false); return; }
  if (message.type === "LC_HISTORY_STARTED") {
    historyCount = 0;
    historySaved = 0;
    historyFailed = false;
    historyEntries = [];
    historyStartedAt = detail.startedAt || new Date().toISOString();
    notify("LeetCode history sync", "Reading new accepted submissions from LeetCode…");
    return;
  }
  if (message.type === "LC_HISTORY_SUBMISSION") { historyCount += 1; enqueue(detail, true); return; }
  if (message.type === "LC_HISTORY_FINISHED") {
    void syncQueue.then(async () => {
      if (historyFailed) return;
      try {
        await markHistorySynced(historyStartedAt || new Date().toISOString(), historyEntries);
        notify("LeetCode history sync", `Saved ${historySaved} new accepted submissions.`);
      } catch (error) {
        notify("LeetCode history sync failed", error instanceof Error ? error.message : String(error));
      }
    });
    return;
  }
  if (message.type === "LC_HISTORY_FAILED") notify("LeetCode history sync failed", detail.message || "Unknown error");
});
