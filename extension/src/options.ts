const fields = ["repository", "githubToken", "branch", "root"] as const;

async function load(): Promise<void> {
  const values = await chrome.storage.local.get(fields);
  for (const field of fields) {
    if (values[field] !== undefined) (document.getElementById(field) as HTMLInputElement).value = values[field];
  }
  await showLastSyncStatus();
}

async function showLastSyncStatus(): Promise<void> {
  const status = document.getElementById("status");
  const values = await chrome.storage.local.get(["lastSyncTitle", "lastSyncMessage", "lastSyncAt"]);
  if (!status || !values.lastSyncMessage) return;
  const when = values.lastSyncAt ? ` (${new Date(values.lastSyncAt).toLocaleString()})` : "";
  status.textContent = `${values.lastSyncTitle || "Sync"}: ${values.lastSyncMessage}${when}`;
}

chrome.storage.onChanged?.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
  if (area === "local" && (changes.lastSyncMessage || changes.lastSyncAt || changes.lastSyncTitle)) {
    void showLastSyncStatus();
  }
});

document.getElementById("save")?.addEventListener("click", async () => {
  const values = Object.fromEntries(fields.map((field) => [field, (document.getElementById(field) as HTMLInputElement).value.trim()]));
  await chrome.storage.local.set(values);
  const status = document.getElementById("status");
  if (status) status.textContent = "Saved.";
});

document.getElementById("syncHistory")?.addEventListener("click", async () => {
  const status = document.getElementById("status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://leetcode.com/problems/")) {
    if (status) status.textContent = "Open a LeetCode problem tab first.";
    return;
  }
  try {
    await chrome.runtime.sendMessage({ type: "LC_SYNC_HISTORY_REQUEST", tabId: tab.id });
    if (status) status.textContent = "History sync started. Keep the LeetCode tab open.";
  } catch (_) {
    if (status) status.textContent = "Reload the LeetCode problem tab, then try again.";
  }
});

void load();
