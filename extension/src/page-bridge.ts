type MonacoModel = { getValue?: () => string };
type MonacoGlobal = { editor?: { getModels?: () => MonacoModel[] } };
type SubmissionRequestInfo = { isSubmit: boolean; isStatus: boolean; variables: Record<string, any> };
type QuestionData = { questionId?: string; title?: string; titleSlug?: string; content?: string; difficulty?: string };
type HistoryOptions = { since?: string | null; knownSubmissionIds?: string[] };

(() => {
  const pageWindow: Window & { __leetcodeGithubSyncInstalled?: boolean; monaco?: MonacoGlobal } = window;
  if (pageWindow.__leetcodeGithubSyncInstalled) return;
  pageWindow.__leetcodeGithubSyncInstalled = true;

  const SOURCE = "leetcode-github-sync";
  let pendingSubmission: Record<string, string> | null = null;
  let historyRunning = false;
  const questionCache = new Map<string, Promise<QuestionData | null>>();

  function emit(type: string, detail: Record<string, unknown>): void {
    window.postMessage({ source: SOURCE, type, detail }, "*");
  }

  function editorCode(): string {
    try {
      const models = pageWindow.monaco?.editor?.getModels?.() || [];
      const model = models.find((candidate) => candidate.getValue?.());
      if (model?.getValue) return model.getValue();
    } catch (_) { /* Monaco is not available on every editor version. */ }
    const textarea = document.querySelector<HTMLTextAreaElement>(
      ".monaco-editor textarea, textarea[aria-label*='code' i], textarea.inputarea"
    );
    if (textarea?.value) return textarea.value;
    return document.querySelector<HTMLElement>(".monaco-editor .view-lines")?.innerText || "";
  }

  function parseRequestBody(body: unknown): Record<string, any> | null {
    if (typeof body !== "string") return null;
    try { return JSON.parse(body) as Record<string, any>; } catch (_) { return null; }
  }

  function requestInfo(body: unknown): SubmissionRequestInfo | null {
    const parsed = parseRequestBody(body);
    if (!parsed) return null;
    const operation = String(parsed.operationName || parsed.query || "");
    const variables = parsed.variables || {};
    const isHistory = /SyncSubmission/i.test(operation);
    const isSubmit = /submitCode/i.test(operation);
    const isStatus = !isHistory && /submissionDetails|submissionCheck|checkSubmission/i.test(operation);
    return isSubmit || isStatus ? { isSubmit, isStatus, variables } : null;
  }

  const HISTORY_LIST_QUERY = `
    query SyncSubmissionList($offset: Int!, $limit: Int!, $lastKey: String) {
      submissionList(offset: $offset, limit: $limit, lastKey: $lastKey) {
        lastKey hasNext
        submissions { id title titleSlug timestamp statusDisplay lang runtime memory }
      }
    }
  `;

  const HISTORY_DETAIL_QUERY = `
    query SyncSubmissionDetails($submissionId: Int!) {
      submissionDetails(submissionId: $submissionId) {
        code lang { name } runtime memory timestamp statusDisplay
        question { questionId title titleSlug content difficulty }
      }
    }
  `;

  const QUESTION_QUERY = `
    query SyncQuestion($titleSlug: String!) {
      question(titleSlug: $titleSlug) { questionId title titleSlug content difficulty }
    }
  `;

  async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
    const response = await fetch("/graphql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json() as { errors?: Array<{ message?: string }>; data?: any };
    if (payload.errors?.length) throw new Error(payload.errors[0].message || "LeetCode GraphQL error");
    return payload.data || {};
  }

  function loadQuestion(slug: string): Promise<QuestionData | null> {
    if (!slug) return Promise.resolve(null);
    const cached = questionCache.get(slug);
    if (cached) return cached;
    const request = graphql(QUESTION_QUERY, { titleSlug: slug })
      .then((data) => data.question as QuestionData || null)
      .catch(() => null);
    questionCache.set(slug, request);
    return request;
  }

  function timestampMs(value: unknown): number | null {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function syncHistory(options: HistoryOptions = {}): Promise<void> {
    if (historyRunning) return;
    historyRunning = true;
    const startedAt = new Date().toISOString();
    const cutoffMs = options.since ? Date.parse(options.since) : NaN;
    const knownSubmissionIds = new Set(options.knownSubmissionIds || []);
    emit("LC_HISTORY_STARTED", { startedAt, since: options.since || null });
    let offset = 0;
    let lastKey: string | null = null;
    let total = 0;
    try {
      while (true) {
        const historyResponse = await graphql(HISTORY_LIST_QUERY, { offset, limit: 20, lastKey });
        const page: any = historyResponse.submissionList || {};
        const rows = page.submissions || [];
        let reachedCutoff = false;
        for (const row of rows) {
          const rowTimestamp = timestampMs(row.timestamp);
          if (Number.isFinite(cutoffMs) && rowTimestamp !== null && rowTimestamp < cutoffMs - 1000) {
            reachedCutoff = true;
            break;
          }
          if (knownSubmissionIds.has(String(row.id))) continue;
          const detail = (await graphql(HISTORY_DETAIL_QUERY, { submissionId: Number(row.id) })).submissionDetails || {};
          if (!detail.code) continue;
          const status = String(detail.statusDisplay || row.statusDisplay || "");
          if (!/^(accepted|10)$/i.test(status)) continue;
          const question = detail.question || {};
          total += 1;
          emit("LC_HISTORY_SUBMISSION", {
            submissionId: String(row.id), questionId: String(question.questionId || ""),
            title: question.title || row.title || "untitled",
            slug: question.titleSlug || row.titleSlug || location.pathname.split("/")[2] || "untitled",
            description: question.content || "",
            difficulty: question.difficulty || "",
            language: detail.lang?.name || detail.lang || row.lang || "text", code: detail.code,
            status: detail.statusDisplay || row.statusDisplay || "Accepted",
            timestamp: String(detail.timestamp || row.timestamp || ""),
            runtime: detail.runtime || row.runtime || "", memory: detail.memory || row.memory || "",
            source: "history"
          });
        }
        if (reachedCutoff || !page.hasNext || !rows.length) break;
        offset += rows.length;
        lastKey = page.lastKey || null;
      }
      emit("LC_HISTORY_FINISHED", { total, startedAt });
    } catch (error) {
      emit("LC_HISTORY_FAILED", { message: error instanceof Error ? error.message : String(error) });
    } finally {
      historyRunning = false;
    }
  }

  function rememberSubmit(info: SubmissionRequestInfo): void {
    const variables = info.variables;
    const slug = String(variables.questionSlug || location.pathname.split("/")[2] || "untitled");
    pendingSubmission = {
      code: String(variables.code || editorCode()), questionId: String(variables.questionId || ""),
      slug,
      language: String(variables.lang || variables.language || "text"), submissionId: String(variables.submissionId || "")
    };
    void loadQuestion(slug);
  }

  async function acceptedDetail(payload: any, info: SubmissionRequestInfo): Promise<void> {
    const data = payload?.data || {};
    const statuses = [
      data.submitCode?.status, data.submitCode?.statusMsg, data.submitCode?.status_msg, data.submitCode?.statusDisplay,
      data.submissionDetails?.status, data.submissionDetails?.statusMsg, data.submissionDetails?.status_msg, data.submissionDetails?.statusDisplay,
      data.submissionCheck?.status, data.submissionCheck?.statusMsg, data.submissionCheck?.status_msg, data.submissionCheck?.statusDisplay
    ].filter(Boolean).map(String);
    if (!statuses.some((status) => /^(accepted|10)$/i.test(status))) return;
    const variables = info.variables;
    const submission = pendingSubmission ? { ...pendingSubmission } : {};
    const slug = String(variables.questionSlug || submission.slug || location.pathname.split("/")[2] || "untitled");
    const question = await loadQuestion(slug);
    emit("LC_ACCEPTED_SUBMISSION", {
      ...submission, code: submission.code || editorCode(),
      questionId: String(variables.questionId || submission.questionId || question?.questionId || ""),
      title: question?.title || "",
      slug,
      description: question?.content || "",
      difficulty: question?.difficulty || "",
      language: String(variables.lang || submission.language || "text"),
      submissionId: String(variables.submissionId || data.submissionDetails?.submissionId || submission.submissionId || ""),
      status: "Accepted"
    });
  }

  async function inspectResponse(response: Response, info: SubmissionRequestInfo): Promise<void> {
    try {
      const payload = await response.clone().json();
      if (info.isSubmit) {
        const submissionId = payload?.data?.submitCode?.submissionId;
        if (submissionId && pendingSubmission) pendingSubmission.submissionId = String(submissionId);
      }
      if (info.isStatus || info.isSubmit) void acceptedDetail(payload, info);
    } catch (_) { /* Ignore non-JSON requests. */ }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const body = typeof args[1]?.body === "string" ? args[1].body : undefined;
    const info = requestInfo(body);
    if (info?.isSubmit) rememberSubmit(info);
    const response = await originalFetch(...args);
    if (info) void inspectResponse(response, info);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open as any;
  const originalSend = XMLHttpRequest.prototype.send as any;
  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]): void {
    originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body: Document | XMLHttpRequestBodyInit | null): void {
    const info = requestInfo(body);
    if (info?.isSubmit) rememberSubmit(info);
    if (info) this.addEventListener("load", () => {
      try {
        const payload = JSON.parse(this.responseText);
        if (info.isSubmit) {
          const submissionId = payload?.data?.submitCode?.submissionId;
          if (submissionId && pendingSubmission) pendingSubmission.submissionId = String(submissionId);
        }
        if (info.isStatus || info.isSubmit) void acceptedDetail(payload, info);
      } catch (_) { /* Ignore non-JSON requests. */ }
    });
    originalSend.call(this, body);
  };

  window.addEventListener("message", (event: MessageEvent<{ source?: string; type?: string; detail?: HistoryOptions }>) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    if (event.data.type === "LC_GET_EDITOR_STATE") {
      const slug = location.pathname.split("/")[2] || "untitled";
      void loadQuestion(slug).then((question) => emit("LC_EDITOR_STATE", {
        code: editorCode(), questionId: question?.questionId || "", title: question?.title || "",
        description: question?.content || "", difficulty: question?.difficulty || ""
      }));
    }
    if (event.data.type === "LC_SYNC_HISTORY") void syncHistory(event.data.detail || {});
  });
})();
