type BridgeDetail = Record<string, unknown>;
type BridgeMessage = { source?: string; type?: string; detail?: BridgeDetail };

(() => {
  const SOURCE = "leetcode-github-sync";
  const sendToBackground = (message: unknown): void => {
    try {
      if (!chrome.runtime?.id) return;
      const result = chrome.runtime.sendMessage(message);
      if (result?.catch) void result.catch(() => undefined);
    } catch (_) {
      // The extension may have been reloaded while this page still has the old script.
    }
  };

  let bridgeUrl = "";
  try {
    bridgeUrl = chrome.runtime.getURL("dist/page-bridge.js");
  } catch (_) {
    return;
  }
  const bridge = document.createElement("script");
  bridge.src = bridgeUrl;
  bridge.onload = () => bridge.remove();
  (document.head || document.documentElement).appendChild(bridge);

  const slugFromUrl = (): string => location.pathname.split("/").filter(Boolean)[1] || "untitled";
  let lastAcceptedAt = 0;
  let lastAcceptedFingerprint = "";

  const languageKey = (value: unknown): string => {
    const language = String(value || "").trim().toLowerCase();
    return language === "python3" ? "python" : language;
  };

  const sendAccepted = (detail: BridgeDetail): void => {
    const fingerprint = `${detail.slug || slugFromUrl()}|${languageKey(detail.language)}|${detail.code || ""}`;
    if (fingerprint === lastAcceptedFingerprint && Date.now() - lastAcceptedAt < 15000) return;
    lastAcceptedFingerprint = fingerprint;
    lastAcceptedAt = Date.now();
    sendToBackground({ type: "LC_ACCEPTED_SUBMISSION", detail: {
      ...detail, slug: detail.slug || slugFromUrl(), source: "live"
    }});
  };

  window.addEventListener("message", (event: MessageEvent<BridgeMessage>) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const { type, detail = {} } = event.data;
    if (type === "LC_ACCEPTED_SUBMISSION") {
      sendAccepted(detail);
      return;
    }
    if (["LC_HISTORY_STARTED", "LC_HISTORY_SUBMISSION", "LC_HISTORY_FINISHED", "LC_HISTORY_FAILED"].includes(type || "")) {
      sendToBackground({ type, detail });
    }
  });

  chrome.runtime.onMessage.addListener((message: { type: string }) => {
    if (message.type === "LC_SYNC_HISTORY") {
      window.postMessage({ source: SOURCE, type: "LC_SYNC_HISTORY", detail: (message as { detail?: unknown }).detail || {} }, "*");
    }
  });

  const observer = new MutationObserver(() => {
    if (Date.now() - lastAcceptedAt < 8000) return;
    const result = document.querySelector("[data-e2e-locator='submission-result'], .text-green, .text-success");
    if (!result || !/\bAccepted\b/i.test(result.textContent || "")) return;
    lastAcceptedAt = Date.now();
    const requestId = `dom-${lastAcceptedAt}`;
    const onState = (event: MessageEvent<BridgeMessage>) => {
      if (event.source !== window || event.data?.source !== SOURCE || event.data.type !== "LC_EDITOR_STATE") return;
      window.removeEventListener("message", onState);
      sendAccepted({
        code: event.data.detail?.code || "", slug: slugFromUrl(), language: event.data.detail?.language || "text",
        questionId: event.data.detail?.questionId || "",
        title: event.data.detail?.title || "",
        description: event.data.detail?.description || "",
        difficulty: event.data.detail?.difficulty || "",
        submissionId: requestId, status: "Accepted", source: "live"
      });
    };
    window.addEventListener("message", onState);
    window.postMessage({ source: SOURCE, type: "LC_GET_EDITOR_STATE" }, "*");
    setTimeout(() => window.removeEventListener("message", onState), 1500);
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
})();
