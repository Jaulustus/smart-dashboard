(function () {
  "use strict";

  const PLUGIN_ID = "smart_dashboard";
  const UI_VERSION = "0.3.0";
  const AGENT_DEPS_CHECK_MODE = "agent_deps_check";
  const AGENT_SETUP_LOG_MODE = "agent_setup_log";
  const AGENT_MCP_CONFIG_MODE = "agent_mcp_config";
  const MCP_LOG_POLL_MS = 2500;
  const MCP_DEPS_POLL_MS = 8000;
  const PLUGIN_OP_TIMEOUT_MS = 45000;
  const MCP_SETUP_AUTOSTART_KEY = "smart_dashboard_agent_setup_queued";
  const MCP_AUTO_SCAN_KEY = "smart_dashboard_mcp_auto_scan";
  const INDEX_AUTOSTART_KEY = "smart_dashboard_agent_index_queued";
  const DASHBOARD_QUERY = "smart_dashboard=cinematic";
  const MCP_DASHBOARD_QUERY = "smart_dashboard=mcp";
  const SETUP_MODE = "setup";
  const SETUP_AGENT_MODE = "setup_agent";
  const BUILD_AGENT_INDEX_MODE = "build_agent_index";
  const AGENT_QUERY_MODE = "agent_query";
  const AGENT_INDEX_STATS_MODE = "agent_index_stats";
  const MCP_SETUP_KEY = "smart_dashboard_mcp_setup_done";
  const RECOMMENDATIONS_MODE = "smart_dash_calc";
  const DUP_SCAN_MODE = "smart_dup_scan";
  const TASK_ONLY_MODES = new Set([SETUP_MODE, SETUP_AGENT_MODE, BUILD_AGENT_INDEX_MODE]);

  function stripSetupLogTimestamp(line) {
    return String(line || "")
      .replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\s*/, "")
      .trim();
  }

  function getSetupLogTailLines(logText, count) {
    return String(logText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, count || 1))
      .map(stripSetupLogTimestamp);
  }

  function parseScanProgressFromPayload(payload) {
    const env = payload && payload.environment;
    const direct = (payload && payload.scan_progress) || (env && env.scan_progress);
    if (direct && typeof direct === "object") {
      return direct;
    }
    return null;
  }

  function isScanProgressStale(scanProgress) {
    if (!scanProgress || !scanProgress.updated_at) {
      return false;
    }
    const updated = Date.parse(scanProgress.updated_at);
    if (Number.isNaN(updated)) {
      return false;
    }
    const ageMs = Date.now() - updated;
    const sceneCount = Number(scanProgress.scene_count) || 0;
    return ageMs > 20 * 60 * 1000 && sceneCount <= 0;
  }

  function estimateMcpSetupPercent(options) {
    const {
      depsReady,
      setupOk,
      indexReady,
      scanBusy,
      setupBusy,
      stats,
      stashSqlite,
      mcpActivity,
      scanProgress,
    } = options;
    if (indexReady) {
      return 100;
    }
    const progressScenes = Number((scanProgress && scanProgress.scene_count) || stats.scene_count) || 0;
    const progressTotal =
      Number((scanProgress && scanProgress.total_scenes) || stashSqlite.scene_count) || 0;
    if (typeof mcpActivity.progress === "number" && mcpActivity.progress > 0) {
      return Math.round(35 + Math.min(1, mcpActivity.progress) * 60);
    }
    let percent = 0;
    if (depsReady) {
      percent += 20;
    }
    if (setupOk) {
      percent += 20;
    }
    if (scanBusy || mcpActivity.phase === "scan" || progressScenes > 0 || (scanProgress && scanProgress.phase)) {
      percent = Math.max(percent, 45);
      if (progressTotal > 0 && progressScenes > 0) {
        percent = 40 + Math.round(Math.min(1, progressScenes / progressTotal) * 55);
      } else if (progressScenes > 0) {
        percent = Math.max(percent, 55);
      } else {
        percent = Math.max(percent, 48);
      }
    } else if (setupBusy || mcpActivity.phase === "setup") {
      percent = Math.max(percent, depsReady ? 35 : 15);
    } else if (!depsReady) {
      percent = 8;
    } else if (setupOk && !indexReady) {
      percent = 45;
    }
    return Math.min(99, Math.max(5, percent));
  }
  const RECOMMENDATIONS_AUTOSTART_KEY = "smart_dashboard_recommendations_autostarted";
  const RECOMMENDATIONS_MISSING_KEY = "smart_dashboard_recommendations_missing_at";
  const RECOMMENDATIONS_MISSING_TTL_MS = 30000;
  const DUPLICATES_MISSING_KEY = "smart_dashboard_duplicates_missing_at";
  const DUPLICATES_MISSING_TTL_MS = 30000;
  const SETUP_AUTOSTART_KEY = "smart_dashboard_setup_autostarted";
  const MAX_REGISTER_ATTEMPTS = 80;
  let registerAttempts = 0;
  let librarySearchCache = null;

  function t(key, params) {
    if (window.SmartDashboardI18n && typeof window.SmartDashboardI18n.t === "function") {
      return window.SmartDashboardI18n.t(key, params);
    }
    return key;
  }

  function pluginLanguage() {
    if (window.SmartDashboardI18n) {
      return window.SmartDashboardI18n.getStashLanguage() || window.SmartDashboardI18n.getLocale() || "en-GB";
    }
    return "en-GB";
  }

  function pluginBasePath() {
    const scripts = Array.from(document.scripts);
    const script = scripts.find((item) => item.src.includes(`/plugin/${PLUGIN_ID}/`));
    if (!script || !script.src) {
      return "";
    }

    try {
      const url = new URL(script.src);
      return url.pathname.split(`/plugin/${PLUGIN_ID}/`)[0] || "";
    } catch (_error) {
      return "";
    }
  }

  function assetUrl(fileName) {
    return `${pluginBasePath()}/plugin/${PLUGIN_ID}/assets/${fileName}`;
  }

  function assetCandidates(fileName, cacheBust) {
    return Array.from(new Set([
      `${assetUrl(fileName)}?${cacheBust}`,
      `/plugin/${PLUGIN_ID}/assets/${fileName}?${cacheBust}`,
    ]));
  }

  function ensurePluginRegistered() {
    if (window.smartDashboardPluginRegistered) {
      return true;
    }
    try {
      registerPlugin();
      window.smartDashboardPluginRegistered = true;
      return true;
    } catch (error) {
      console.error("[Smart Dashboard] registerPlugin failed:", error);
      return false;
    }
  }

  function openRoute() {
    if (!ensurePluginRegistered()) {
      return;
    }
    if (typeof window.smartDashboardOpen === "function") {
      window.smartDashboardOpen();
      return;
    }

    window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
  }

  function handleDashboardDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("smart_dashboard");
    if (!mode) {
      return;
    }
    if (!ensurePluginRegistered()) {
      return;
    }
    if (mode === "mcp" && typeof window.smartDashboardMcpOpen === "function") {
      window.smartDashboardMcpOpen();
      return;
    }
    if (mode === "cinematic" && typeof window.smartDashboardOpen === "function") {
      window.smartDashboardOpen();
    }
  }

  function normalizePluginResult(raw) {
    if (!raw) {
      return null;
    }
    let value = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_error) {
        return { reply: value };
      }
    }
    if (value && typeof value === "object") {
      if (value.result && typeof value.result === "object") {
        return value.result;
      }
      if (typeof value.output === "string") {
        try {
          const inner = JSON.parse(value.output);
          if (inner && typeof inner === "object") {
            if (inner.result && typeof inner.result === "object") {
              return inner.result;
            }
            if (inner.setup_log !== undefined || inner.setup_status !== undefined) {
              return inner;
            }
          }
        } catch (_innerError) {
          /* output is plain text */
        }
      }
      if (value.setup_log !== undefined || value.setup_status !== undefined) {
        return value;
      }
      if (value.reply || value.scenes || value.index || value.environment) {
        return value;
      }
      if (value.mcp_config_json || value.mcp_server_path || value.graphql_url) {
        return value;
      }
      if (value.output) {
        return { reply: value.output, ...value };
      }
    }
    return value;
  }

  let cachedStashGeneralConfig = null;

  async function fetchStashGeneralConfig(options) {
    const forceRefresh = Boolean(options && options.forceRefresh);
    if (cachedStashGeneralConfig && !forceRefresh) {
      return cachedStashGeneralConfig;
    }
    const query = `
      query SmartDashboardStashGeneralConfig {
        configuration {
          general {
            databasePath
            pluginsPath
            configFilePath
            pythonPath
            apiKey
          }
        }
      }
    `;
    try {
      const response = await fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!response.ok) {
        return null;
      }
      const payload = await response.json();
      const general =
        payload.data && payload.data.configuration && payload.data.configuration.general;
      if (!general || typeof general !== "object") {
        return null;
      }
      cachedStashGeneralConfig = general;
      return general;
    } catch (error) {
      console.warn("[Smart Dashboard] Could not load Stash configuration paths", error);
      return null;
    }
  }

  async function agentPathHints() {
    const general = await fetchStashGeneralConfig();
    if (!general) {
      return {};
    }
    const hints = {};
    if (general.databasePath) {
      hints.stash_database_path = general.databasePath;
    }
    if (general.configFilePath) {
      hints.stash_config_path = general.configFilePath;
    }
    if (general.pluginsPath) {
      hints.stash_plugins_path = general.pluginsPath;
    }
    if (general.pythonPath) {
      hints.python_path = general.pythonPath;
    }
    if (general.configFilePath) {
      const normalized = String(general.configFilePath).replace(/\\/g, "/");
      const slash = normalized.lastIndexOf("/");
      if (slash > 0) {
        hints.stash_config_directory = normalized.slice(0, slash);
      }
    }
    return hints;
  }

  const pluginOperationInflight = new Map();

  async function runPluginModeOperation(mode, extraArgs) {
    const opKey = `${mode}:${JSON.stringify(extraArgs || {})}`;
    if (pluginOperationInflight.has(opKey)) {
      return pluginOperationInflight.get(opKey);
    }

    const runPromise = (async () => {
      const mutation = `
      mutation SmartDashboardRunOperation(
        $pluginId: ID!
        $args: Map
      ) {
        runPluginOperation(
          plugin_id: $pluginId
          args: $args
        )
      }
    `;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PLUGIN_OP_TIMEOUT_MS);
      try {
        const response = await fetch(`${pluginBasePath()}/graphql`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            query: mutation,
            variables: {
              pluginId: PLUGIN_ID,
              args: {
                task: mode,
                mode,
                language: pluginLanguage(),
                ...(extraArgs || {}),
              },
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (payload.errors && payload.errors.length) {
          throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
        }

        return payload.data ? payload.data.runPluginOperation : null;
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    pluginOperationInflight.set(opKey, runPromise);
    try {
      return await runPromise;
    } finally {
      pluginOperationInflight.delete(opKey);
    }
  }

  let agentSetupLogInflight = null;

  /** Reads setup_log.txt only — minimal Stash plugin subprocess. */
  async function fetchAgentSetupLog() {
    if (agentSetupLogInflight) {
      return agentSetupLogInflight;
    }
    agentSetupLogInflight = (async () => {
      try {
        const raw = await runPluginModeOperation(AGENT_SETUP_LOG_MODE, {});
        return normalizePluginResult(raw);
      } finally {
        agentSetupLogInflight = null;
      }
    })();
    return agentSetupLogInflight;
  }

  /** Fast status for background checks (does not probe stash-go.sqlite). */
  async function fetchAgentDepsCheck() {
    const hints = await agentPathHints();
    const raw = await runPluginModeOperation(AGENT_DEPS_CHECK_MODE, hints);
    const normalized = normalizePluginResult(raw);
    if (agentDepsReady(normalized)) {
      localStorage.setItem(MCP_SETUP_KEY, "1");
      sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
    }
    return normalized;
  }

  function isSmartDashboardPluginJob(job) {
    const text = String((job && job.description) || "").toLowerCase();
    return text.includes("smart dashboard");
  }

  function indexAutostartRecentlyQueued(maxMs) {
    const raw = localStorage.getItem(INDEX_AUTOSTART_KEY);
    if (!raw) {
      return false;
    }
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < (maxMs || 5 * 60 * 1000);
  }

  function markIndexAutostartQueued() {
    localStorage.setItem(INDEX_AUTOSTART_KEY, String(Date.now()));
  }

  function clearIndexAutostartQueued() {
    localStorage.removeItem(INDEX_AUTOSTART_KEY);
  }

  async function fetchAgentIndexStats(options) {
    const hints = await agentPathHints();
    const full = Boolean(options && options.full);
    const raw = await runPluginModeOperation(AGENT_INDEX_STATS_MODE, {
      ...hints,
      quick: full ? "false" : "true",
    });
    return normalizePluginResult(raw);
  }

  async function sendAgentChatMessage(message) {
    const raw = await runPluginModeOperation(AGENT_QUERY_MODE, { message });
    return normalizePluginResult(raw);
  }

  function openMcpRoute() {
    if (!ensurePluginRegistered()) {
      return;
    }
    if (typeof window.smartDashboardMcpOpen === "function") {
      window.smartDashboardMcpOpen();
      return;
    }
    window.history.pushState({}, "", `${pluginBasePath()}/?${MCP_DASHBOARD_QUERY}`);
  }

  function guessMcpServerPath(_general) {
    return null;
  }

  let cachedMcpPathsHint = null;

  async function fetchPluginAssetText(fileName) {
    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates(fileName, cacheBust);
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) {
          continue;
        }
        return await response.text();
      } catch (_error) {
        /* try next */
      }
    }
    return null;
  }

  async function fetchSetupLogText() {
    const snapshot = await fetchPluginAssetJson("setup_log_snapshot.json");
    if (snapshot && typeof snapshot.setup_log === "string" && snapshot.setup_log.trim()) {
      return snapshot.setup_log;
    }
    const uiSnapshot = await fetchPluginAssetJson("agent_ui_snapshot.json");
    if (uiSnapshot && typeof uiSnapshot.setup_log === "string" && uiSnapshot.setup_log.trim()) {
      return uiSnapshot.setup_log;
    }
    const rawText = await fetchPluginAssetText("setup_log.txt");
    if (rawText && rawText.trim()) {
      return rawText;
    }
    return null;
  }

  async function fetchPluginAssetJson(fileName) {
    const text = await fetchPluginAssetText(fileName);
    if (!text) {
      return null;
    }
    try {
      const data = JSON.parse(text);
      return data && typeof data === "object" ? data : null;
    } catch (_error) {
      return null;
    }
  }

  async function fetchMcpPathsHintFromAsset() {
    if (cachedMcpPathsHint) {
      return cachedMcpPathsHint;
    }
    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates("mcp_paths.json", cacheBust);
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        if (data && data.mcp_server_path) {
          cachedMcpPathsHint = data;
          return data;
        }
      } catch (_error) {
        /* try next candidate */
      }
    }
    return null;
  }

  function buildMcpConfigSnippetFromParts(parts) {
    const graphqlUrl =
      (parts && parts.graphql_url) ||
      `${window.location.origin.replace(/\/$/, "")}/graphql`;
    const apiKey = (parts && parts.api_key) || "";
    const scriptPath =
      (parts && parts.mcp_server_path) ||
      guessMcpServerPath(parts && parts.general) ||
      "REPLACE_WITH_ABSOLUTE_PATH_TO_PLUGIN_DIR/stash_mcp_server.py";
    const pythonCmd =
      (parts && parts.python_path) ||
      (parts && parts.general && parts.general.pythonPath) ||
      "python";
    return JSON.stringify(
      {
        mcpServers: {
          stash: {
            command: pythonCmd,
            args: [scriptPath],
            env: {
              STASH_GRAPHQL_URL: graphqlUrl,
              STASH_API_KEY: apiKey,
            },
          },
        },
      },
      null,
      2
    );
  }

  let mcpConfigInflight = null;

  async function fetchMcpConfigSnippet() {
    if (mcpConfigInflight) {
      return mcpConfigInflight;
    }
    mcpConfigInflight = (async () => {
      const general = await fetchStashGeneralConfig();
      let serverParts = null;
      try {
        const hints = await agentPathHints();
        const raw = await runPluginModeOperation(AGENT_MCP_CONFIG_MODE, hints);
        serverParts = normalizePluginResult(raw);
      } catch (error) {
        console.warn("[Smart Dashboard] Could not load MCP config from plugin", error);
      }
      if (!serverParts || !serverParts.mcp_config_json) {
        const assetHint = await fetchMcpPathsHintFromAsset();
        if (assetHint) {
          serverParts = {
            ...(serverParts || {}),
            mcp_server_path: assetHint.mcp_server_path,
            python_path: assetHint.python_path,
            graphql_url: assetHint.graphql_url,
          };
        }
      }
      const apiKey =
        (serverParts && serverParts.api_key) ||
        (general && general.apiKey) ||
        "";
      if (serverParts && serverParts.mcp_config_json) {
        const parsed = JSON.parse(serverParts.mcp_config_json);
        if (general && general.apiKey) {
          parsed.mcpServers.stash.env.STASH_API_KEY = general.apiKey;
        } else if (apiKey) {
          parsed.mcpServers.stash.env.STASH_API_KEY = apiKey;
        }
        return JSON.stringify(parsed, null, 2);
      }
      return buildMcpConfigSnippetFromParts({
        general,
        api_key: apiKey,
        graphql_url: (serverParts && serverParts.graphql_url) || null,
        mcp_server_path: serverParts && serverParts.mcp_server_path,
        python_path: serverParts && serverParts.python_path,
      });
    })().finally(() => {
      mcpConfigInflight = null;
    });
    return mcpConfigInflight;
  }

  async function copyMcpConfigSnippet() {
    const text = await fetchMcpConfigSnippet();
    return copyTextToClipboard(text);
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return false;
    }
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        /* fall through to execCommand */
      }
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      return ok;
    } catch (_error) {
      return false;
    }
  }

  function shouldSkipMissingRecommendationsFetch() {
    const missingAt = Number(sessionStorage.getItem(RECOMMENDATIONS_MISSING_KEY) || 0);
    return missingAt > 0 && Date.now() - missingAt < RECOMMENDATIONS_MISSING_TTL_MS;
  }

  function shouldSkipMissingDuplicatesFetch() {
    const missingAt = Number(sessionStorage.getItem(DUPLICATES_MISSING_KEY) || 0);
    return missingAt > 0 && Date.now() - missingAt < DUPLICATES_MISSING_TTL_MS;
  }

  async function fetchRecommendations(options) {
    const forceAssetFetch = Boolean(options && options.forceAssetFetch);
    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates("recommendations.json", cacheBust);

    let lastError = null;
    if (forceAssetFetch || !shouldSkipMissingRecommendationsFetch()) {
      for (const url of candidates) {
        try {
          const response = await fetch(url, { cache: "no-store" });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const data = await response.json();
          sessionStorage.removeItem(RECOMMENDATIONS_MISSING_KEY);
          return enrichSceneTitles(data);
        } catch (error) {
          lastError = error;
        }
      }

      sessionStorage.setItem(RECOMMENDATIONS_MISSING_KEY, String(Date.now()));
    }

    console.warn("[Smart Dashboard] recommendations.json not available, using GraphQL fallback", lastError);
    const fallback = await buildRecommendationsFromGraphQL();
    fallback.recommendations_autostart = { started: false, reason: "manual_refresh_required" };
    return fallback;
  }

  async function fetchDuplicateReport(options) {
    const forceAssetFetch = Boolean(options && options.forceAssetFetch);
    if (!forceAssetFetch && shouldSkipMissingDuplicatesFetch()) {
      throw new Error("duplicates_report.json was not found recently.");
    }

    const cacheBust = `t=${Date.now()}`;
    const candidates = assetCandidates("duplicates_report.json", cacheBust);

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        sessionStorage.removeItem(DUPLICATES_MISSING_KEY);
        return response.json();
      } catch (error) {
        lastError = error;
      }
    }

    sessionStorage.setItem(DUPLICATES_MISSING_KEY, String(Date.now()));
    throw lastError || new Error("duplicates_report.json could not be loaded.");
  }

  async function queuePluginModeTask(mode, description, extraArgs) {
    const mutation = `
      mutation SmartDashboardRunTask(
        $pluginId: ID!
        $description: String!
        $argsMap: Map
      ) {
        runPluginTask(
          plugin_id: $pluginId
          description: $description
          args_map: $argsMap
        )
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: mutation,
        variables: {
          pluginId: PLUGIN_ID,
          description,
          argsMap: {
            task: mode,
            mode,
            language: pluginLanguage(),
            ...(extraArgs || {}),
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    return payload.data && payload.data.runPluginTask;
  }

  async function runPluginModeTask(mode, description, extraArgs) {
    try {
      const jobId = await queuePluginModeTask(mode, description, extraArgs);
      return { queued: true, job_id: jobId };
    } catch (error) {
      if (TASK_ONLY_MODES.has(mode)) {
        console.warn("[Smart Dashboard] Could not queue plugin task (no sync fallback)", error);
        throw error;
      }
      console.warn("[Smart Dashboard] Could not queue plugin mode, running operation directly", error);
      const result = await runPluginModeOperation(mode, extraArgs);
      return { queued: false, result };
    }
  }

  function setupStatusFromPayload(payload) {
    return payload && payload.setup_status ? payload.setup_status : null;
  }

  function setupSucceededFromPayload(payload) {
    if (depsReadyFromPayload(payload)) {
      return true;
    }
    const status = setupStatusFromPayload(payload);
    return Boolean(status && status.state === "success");
  }

  function setupFailedFromPayload(payload) {
    const status = setupStatusFromPayload(payload);
    return Boolean(status && status.state === "failed");
  }

  async function pollDepsUntilReady(maxMs, intervalMs) {
    const deadline = Date.now() + (maxMs || 120000);
    let latest = null;
    while (Date.now() < deadline) {
      latest = await fetchAgentDepsCheck();
      if (depsReadyFromPayload(latest) || setupSucceededFromPayload(latest)) {
        return latest;
      }
      if (setupFailedFromPayload(latest)) {
        return latest;
      }
      await sleepMs(intervalMs || MCP_DEPS_POLL_MS);
    }
    return latest;
  }

  const MCP_JOB_TERMINAL = new Set(["FINISHED", "FAILED", "CANCELLED", "STOPPING"]);

  function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchStashJob(jobId) {
    if (!jobId) {
      return null;
    }
    const query = `
      query SmartDashboardFindJob($input: FindJobInput!) {
        findJob(input: $input) {
          id
          status
          progress
          description
          error
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { input: { id: String(jobId) } },
      }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }
    return payload.data && payload.data.findJob ? payload.data.findJob : null;
  }

  async function fetchStashJobQueue() {
    const query = `
      query SmartDashboardJobQueue {
        jobQueue {
          id
          status
          progress
          description
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!response.ok) {
      return [];
    }
    const payload = await response.json();
    const jobs = payload.data && payload.data.jobQueue;
    return Array.isArray(jobs) ? jobs : [];
  }

  async function pollStashJobUntilDone(jobId, options) {
    const intervalMs = (options && options.intervalMs) || 2000;
    const timeoutMs = (options && options.timeoutMs) || 6 * 60 * 60 * 1000;
    const onUpdate = options && options.onUpdate;
    const onAssetPoll = options && options.onAssetPoll;
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      if (onAssetPoll) {
        const early = await onAssetPoll();
        if (early && early.indexReady) {
          return { ...(last || {}), status: "FINISHED", index_ready_early: true };
        }
      }
      last = await fetchStashJob(jobId);
      if (onUpdate) {
        onUpdate(last);
      }
      const status = String((last && last.status) || "").toUpperCase();
      if (!last || MCP_JOB_TERMINAL.has(status)) {
        return last;
      }
      await sleepMs(intervalMs);
    }
    return last;
  }

  function agentDepsReady(stats) {
    return Boolean(stats && stats.environment && stats.environment.deps && stats.environment.deps.all_ready);
  }

  function agentIndexReady(stats) {
    const index = stats && stats.index;
    return Boolean(index && index.ready && (index.scene_count || 0) > 0);
  }

  function indexReadyFromPayload(payload) {
    const index = payload && payload.index;
    return Boolean(index && index.ready && (index.scene_count || 0) > 0);
  }

  function parseIndexStatsFromSetupLog(logText) {
    const text = String(logText || "");
    const complete = text.match(/Index-Aufbau abgeschlossen:\s*(\d+)\s+Szenen/i);
    const built = text.match(
      /(\d+)\s+scenes,\s*(\d+)\s+tags,\s*(\d+)\s+performers,\s*(\d+)\s+studios/i
    );
    if (!complete && !built) {
      return null;
    }
    return {
      ready: true,
      scene_count: Number((built && built[1]) || (complete && complete[1])) || 0,
      tag_count: built ? Number(built[2]) : 0,
      performer_count: built ? Number(built[3]) : 0,
      studio_count: built ? Number(built[4]) : 0,
      index_source: "stash_sqlite",
    };
  }

  function markMcpInstallCompleteFromState(installState) {
    if (!installState) {
      return;
    }
    // Install/skip is based on vendor/ + agent_library.db only — never on plugin_version / UI_VERSION.
    if (installState.mcp_deps_ready || installState.index_ready) {
      localStorage.setItem(MCP_SETUP_KEY, "1");
      sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
    }
    if (installState.index_ready) {
      clearIndexAutostartQueued();
    }
  }

  function payloadFromInstallState(installState) {
    if (!installState || typeof installState !== "object") {
      return null;
    }
    const payload = { install_state: installState };
    if (installState.index && typeof installState.index === "object") {
      payload.index = installState.index;
    } else if (installState.index_ready && Number(installState.index_scene_count) > 0) {
      payload.index = {
        ready: true,
        scene_count: Number(installState.index_scene_count),
        tag_count: 0,
        performer_count: 0,
        studio_count: 0,
      };
    }
    if (installState.mcp_deps_ready) {
      payload.environment = {
        deps: { all_ready: true, already_installed: true },
      };
      payload.setup_status = { state: "success" };
    }
    return payload.index || payload.environment ? payload : null;
  }

  async function probeInstallStateFromAssets() {
    let installState = await fetchPluginAssetJson("install_state.json");
    if (installState) {
      markMcpInstallCompleteFromState(installState);
      return installState;
    }
    const assetPayload = await fetchAgentStateFromAssets();
    if (indexReadyFromPayload(assetPayload)) {
      installState = {
        mcp_deps_ready: true,
        index_ready: true,
        index_scene_count: Number((assetPayload.index && assetPayload.index.scene_count) || 0),
        index: assetPayload.index,
      };
      markMcpInstallCompleteFromState(installState);
      return installState;
    }
    if (depsReadyFromPayload(assetPayload)) {
      return { mcp_deps_ready: true, index_ready: false };
    }
    return null;
  }

  async function fetchAgentStateFromAssets() {
    const [setupLog, setupStatus, scanProgress, uiSnapshot, installState] = await Promise.all([
      fetchSetupLogText(),
      fetchPluginAssetJson("setup_status.json"),
      fetchPluginAssetJson("scan_progress.json"),
      fetchPluginAssetJson("agent_ui_snapshot.json"),
      fetchPluginAssetJson("install_state.json"),
    ]);
    let payload = uiSnapshot && typeof uiSnapshot === "object" ? { ...uiSnapshot } : {};
    const fromInstall = payloadFromInstallState(installState);
    if (fromInstall) {
      payload = { ...fromInstall, ...payload };
      if (fromInstall.index && !payload.index) {
        payload.index = fromInstall.index;
      }
      if (fromInstall.environment && !payload.environment) {
        payload.environment = fromInstall.environment;
      }
      markMcpInstallCompleteFromState(installState);
    }
    if (setupLog) {
      payload.setup_log = setupLog;
      if (!payload.index) {
        const parsedIndex = parseIndexStatsFromSetupLog(setupLog);
        if (parsedIndex) {
          payload.index = parsedIndex;
        }
      }
    }
    if (setupStatus && typeof setupStatus === "object") {
      payload.setup_status = setupStatus;
      if (setupStatus.state === "success" && setupStatus.deps) {
        payload.environment = {
          ...(payload.environment || {}),
          deps: setupStatus.deps,
        };
      }
    }
    if (scanProgress && typeof scanProgress === "object") {
      payload.scan_progress = scanProgress;
      if (payload.environment && typeof payload.environment === "object") {
        payload.environment = { ...payload.environment, scan_progress: scanProgress };
      }
    }
    if (
      payload.index ||
      payload.environment ||
      payload.setup_status ||
      payload.setup_log ||
      payload.scan_progress
    ) {
      return payload;
    }
    return null;
  }

  function depsReadyFromPayload(payload) {
    return agentDepsReady(payload);
  }

  function dashboardDepsReady(stats) {
    return Boolean(
      stats && stats.environment && stats.environment.dashboard_deps && stats.environment.dashboard_deps.all_ready
    );
  }

  async function triggerSetupOnce() {
    if (localStorage.getItem(SETUP_AUTOSTART_KEY) === "1") {
      return { started: false, reason: "already_started" };
    }

    const installState = await probeInstallStateFromAssets();
    if (installState && installState.dashboard_deps_ready) {
      localStorage.setItem(SETUP_AUTOSTART_KEY, "1");
      return { started: false, reason: "already_installed_disk", installState };
    }

    try {
      const stats = await fetchAgentDepsCheck();
      if (dashboardDepsReady(stats)) {
        localStorage.setItem(SETUP_AUTOSTART_KEY, "1");
        return { started: false, reason: "already_installed", stats };
      }
    } catch (error) {
      console.warn("[Smart Dashboard] Could not check dashboard dependencies", error);
      if (installState && (installState.mcp_deps_ready || installState.index_ready)) {
        localStorage.setItem(SETUP_AUTOSTART_KEY, "1");
        return { started: false, reason: "already_installed_disk_partial", installState };
      }
    }

    localStorage.setItem(SETUP_AUTOSTART_KEY, "1");
    try {
      const result = await runPluginModeTask(SETUP_MODE, "Smart Dashboard automatic setup");
      return { started: true, ...result };
    } catch (error) {
      localStorage.removeItem(SETUP_AUTOSTART_KEY);
      console.warn("[Smart Dashboard] Could not auto-start setup", error);
      return { started: false, error: error.message || String(error) };
    }
  }

  function isMcpAgentSetupJob(job) {
    const text = String((job && job.description) || "").toLowerCase();
    return text.includes("mcp agent") && text.includes("setup");
  }

  function isAgentIndexBuildJob(job) {
    const text = String((job && job.description) || "").toLowerCase();
    return (
      text.includes("agent index") ||
      text.includes("build agent") ||
      text.includes("library index")
    );
  }

  function mcpJobKind(job) {
    const text = String((job && job.description) || "").toLowerCase();
    if (isAgentIndexBuildJob(job)) {
      return "scan";
    }
    if (text.includes("setup")) {
      return "setup";
    }
    return "scan";
  }

  function isActiveStashJob(job) {
    const status = String((job && job.status) || "").toUpperCase();
    return job && !MCP_JOB_TERMINAL.has(status);
  }

  let backgroundAgentSetupInFlight = null;
  let backgroundAgentIndexInFlight = null;
  let backgroundServicesStarted = false;

  function startBackgroundServices() {
    if (backgroundServicesStarted) {
      return;
    }
    backgroundServicesStarted = true;
    (async () => {
      const installState = await probeInstallStateFromAssets();
      if (installState && installState.index_ready) {
        return;
      }
      if (!installState || !installState.dashboard_deps_ready) {
        triggerSetupOnce();
      }
      if (installState && installState.mcp_deps_ready) {
        ensureAgentIndexInBackground().catch((error) => {
          console.warn("[Smart Dashboard] Background agent index build failed to start", error);
        });
        return;
      }
      startBackgroundAgentSetup().finally(() => {
        ensureAgentIndexInBackground().catch((error) => {
          console.warn("[Smart Dashboard] Background agent index build failed to start", error);
        });
      });
    })().catch((error) => {
      console.warn("[Smart Dashboard] Background services start failed", error);
    });
  }

  /** Queue agent_library.db build when MCP deps are ready but the index is missing. */
  async function ensureAgentIndexInBackground() {
    if (backgroundAgentIndexInFlight) {
      return backgroundAgentIndexInFlight;
    }

    backgroundAgentIndexInFlight = (async () => {
      const installState = await probeInstallStateFromAssets();
      if (installState && installState.index_ready) {
        return { ok: true, ready: true, skipped: true };
      }

      let stats = null;
      try {
        stats = await fetchAgentDepsCheck();
      } catch (error) {
        console.warn("[Smart Dashboard] Could not check agent index status", error);
        if (installState && installState.mcp_deps_ready) {
          return { ok: false, reason: "deps_check_failed", installState };
        }
        return { ok: false, error: error.message || String(error) };
      }
      if (!agentDepsReady(stats)) {
        return { ok: false, reason: "deps_missing" };
      }
      if (agentIndexReady(stats)) {
        return { ok: true, ready: true, skipped: true };
      }
      const jobs = await fetchStashJobQueue();
      if (
        jobs.some(
          (job) =>
            isActiveStashJob(job) &&
            (isAgentIndexBuildJob(job) || isMcpAgentSetupJob(job))
        )
      ) {
        return { ok: true, queued: true, running: true, reason: "plugin_task_active" };
      }
      const progress = parseScanProgressFromPayload(stats);
      if (progress && progress.phase && progress.updated_at && !isScanProgressStale(progress)) {
        return { ok: true, reason: "progress_active" };
      }
      if (indexAutostartRecentlyQueued() && !agentIndexReady(stats)) {
        const stillBuilding = jobs.some(
          (job) => isActiveStashJob(job) && isSmartDashboardPluginJob(job)
        );
        if (!stillBuilding) {
          clearIndexAutostartQueued();
        } else {
          return { ok: true, reason: "already_queued_this_session" };
        }
      }
      if (indexAutostartRecentlyQueued() && agentIndexReady(stats)) {
        return { ok: true, ready: true, skipped: true };
      }

      markIndexAutostartQueued();
      const hints = await agentPathHints();
      try {
        const jobId = await queuePluginModeTask(
          BUILD_AGENT_INDEX_MODE,
          "Smart Dashboard agent index rebuild (automatic)",
          hints
        );
        return { ok: true, started: true, job_id: jobId };
      } catch (error) {
        clearIndexAutostartQueued();
        console.warn("[Smart Dashboard] Could not auto-start agent index build", error);
        return { ok: false, error: error.message || String(error) };
      }
    })().finally(() => {
      backgroundAgentIndexInFlight = null;
    });

    return backgroundAgentIndexInFlight;
  }

  /** Queue MCP dependency install as a Stash plugin task (no terminal, no user action). */
  async function ensureAgentDependenciesInBackground() {
    if (backgroundAgentSetupInFlight) {
      return backgroundAgentSetupInFlight;
    }

    backgroundAgentSetupInFlight = (async () => {
      const installState = await probeInstallStateFromAssets();
      if (installState && installState.index_ready) {
        return { ok: true, ready: true, skipped: true, already_installed: true, installState };
      }
      if (installState && installState.mcp_deps_ready) {
        localStorage.setItem(MCP_SETUP_KEY, "1");
        sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
        return ensureAgentIndexInBackground();
      }

      if (localStorage.getItem(MCP_SETUP_KEY) === "1") {
        sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
        ensureAgentIndexInBackground().catch((error) => {
          console.warn("[Smart Dashboard] Agent index auto-start failed", error);
        });
        return { ok: true, ready: true, skipped: true, already_installed: true };
      }

      let stats = null;
      try {
        stats = await fetchAgentDepsCheck();
        if (agentDepsReady(stats)) {
          localStorage.setItem(MCP_SETUP_KEY, "1");
          sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
          ensureAgentIndexInBackground().catch((error) => {
            console.warn("[Smart Dashboard] Agent index auto-start after deps check failed", error);
          });
          return { ok: true, ready: true, skipped: true, already_installed: true, stats };
        }
      } catch (error) {
        console.warn("[Smart Dashboard] Could not read agent deps status", error);
      }

      const jobs = await fetchStashJobQueue();
      if (jobs.some((job) => isActiveStashJob(job) && isSmartDashboardPluginJob(job))) {
        return { ok: true, queued: true, running: true, reason: "plugin_task_active" };
      }

      const runningSetup = jobs.find((job) => isActiveStashJob(job) && isMcpAgentSetupJob(job));
      if (runningSetup) {
        return { ok: true, queued: true, running: true, job_id: runningSetup.id };
      }

      if (
        sessionStorage.getItem(MCP_SETUP_AUTOSTART_KEY) === "1" ||
        indexAutostartRecentlyQueued()
      ) {
        return { ok: true, reason: "already_queued_this_session", stats };
      }

      sessionStorage.setItem(MCP_SETUP_AUTOSTART_KEY, "1");
      markIndexAutostartQueued();
      const hints = await agentPathHints();
      const result = await runPluginModeTask(
        SETUP_AGENT_MODE,
        "Smart Dashboard MCP agent setup and library index (automatic)",
        hints
      );
      return { ok: true, started: true, ...result };
    })().finally(() => {
      backgroundAgentSetupInFlight = null;
    });

    return backgroundAgentSetupInFlight;
  }

  function startBackgroundAgentSetup() {
    ensureAgentDependenciesInBackground().catch((error) => {
      console.warn("[Smart Dashboard] Background MCP agent setup failed to start", error);
      sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
    });
  }

  async function triggerRecommendationsRefreshOnce() {
    if (sessionStorage.getItem(RECOMMENDATIONS_AUTOSTART_KEY) === "1") {
      return { started: false, reason: "already_started" };
    }

    sessionStorage.setItem(RECOMMENDATIONS_AUTOSTART_KEY, "1");
    try {
      const jobId = await queuePluginModeTask(RECOMMENDATIONS_MODE, "Smart Dashboard auto-refresh recommendations");
      return { started: true, queued: true, job_id: jobId };
    } catch (error) {
      // Do not fall back to synchronous auto-generation while another long plugin task may be running.
      console.warn("[Smart Dashboard] Could not auto-start recommendations", error);
      return { started: false, error: error.message || String(error) };
    }
  }

  function isUntitled(value) {
    return !value || String(value).trim().toLowerCase() === "untitled";
  }

  function estimateRecommendationSeconds(totalScenes) {
    const count = Number(totalScenes) || 0;
    return Math.max(5, Math.round(count / 80));
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value < 60) {
      return `${value}s`;
    }

    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  function fileNameFromPath(path) {
    if (!path) {
      return "";
    }

    const fileName = String(path).split(/[\\/]/).filter(Boolean).pop() || "";
    return fileName.replace(/\.[^.]+$/, "") || fileName;
  }

  function collectRecommendationScenes(data) {
    const rowKeys = ["library_spotlight", "forgotten_gems", "top_rated", "recently_watched", "smart_suggestions"];
    return rowKeys.flatMap((key) => (Array.isArray(data[key]) ? data[key] : []));
  }

  async function fetchSceneTitleIndex() {
    const query = `
      query SmartDashboardSceneTitles($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            files { path }
          }
        }
      }
    `;
    const scenes = [];
    const perPage = 1000;
    let page = 1;
    let total = null;

    while (total === null || scenes.length < total) {
      const response = await fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page, per_page: perPage } },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
      }

      const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
      const pageScenes = Array.isArray(container.scenes) ? container.scenes : [];
      scenes.push(...pageScenes);
      total = Number.isFinite(Number(container.count)) ? Number(container.count) : scenes.length;
      if (!pageScenes.length || pageScenes.length < perPage) {
        break;
      }
      page += 1;
    }

    return new Map(
      scenes.map((scene) => {
        const firstFile = Array.isArray(scene.files) && scene.files.length ? scene.files[0] : null;
        return [
          String(scene.id),
          {
            title: scene.title,
            file_path: firstFile && firstFile.path,
            file_name: fileNameFromPath(firstFile && firstFile.path),
          },
        ];
      })
    );
  }

  function sceneFromGraphQL(scene, index) {
    const firstFile = Array.isArray(scene.files) && scene.files.length ? scene.files[0] : null;
    const filePath = firstFile && firstFile.path;
    const title = !isUntitled(scene.title) ? scene.title : fileNameFromPath(filePath) || `Scene ${scene.id}`;
    const width = firstFile && firstFile.width;
    const height = firstFile && firstFile.height;
    return {
      id: String(scene.id),
      title,
      stash_title: scene.title,
      file_path: filePath,
      file_name: fileNameFromPath(filePath),
      cover_path: scene.paths && scene.paths.screenshot,
      thumbnail: scene.paths && scene.paths.screenshot,
      rating: scene.rating100 ? Math.round((scene.rating100 / 20) * 100) / 100 : null,
      resolution: width && height ? `${width}x${height}` : "",
      score: Math.max(0, 1 - index / 1000),
      reason: t("reason.liveFromLibrary"),
      play_count: scene.play_count || 0,
      last_played_at: scene.last_played_at || null,
      tags: Array.isArray(scene.tags) ? scene.tags.map((tag) => tag.name).filter(Boolean) : [],
      performers: Array.isArray(scene.performers) ? scene.performers.map((performer) => performer.name).filter(Boolean) : [],
      studio: scene.studio && scene.studio.name,
      stash_url: `${window.location.origin}/scenes/${scene.id}`,
      stream_url: `${window.location.origin}/scene/${scene.id}/stream`,
    };
  }

  async function buildRecommendationsFromGraphQL() {
    const query = `
      query SmartDashboardLiveScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 100 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
    const scenes = container.scenes || [];
    const totalLibraryScenes = container.count || scenes.length;
    const items = scenes.map(sceneFromGraphQL);
    const topRated = items
      .filter((scene) => scene.rating !== null)
      .sort((left, right) => (right.rating || 0) - (left.rating || 0))
      .slice(0, 50);

    return {
      plugin: "Smart Dashboard & Advanced Duplicate Finder",
      generated_at: new Date().toISOString(),
      graphql_query_variant: "frontend_live_fallback",
      stash_base_url: window.location.origin,
      library_stats: {
        total_scenes: totalLibraryScenes,
        estimated_recommendation_seconds: estimateRecommendationSeconds(totalLibraryScenes),
      },
      preference_profile: { top_tags: [], top_studios: [] },
      library_spotlight: items.slice(0, 50),
      smart_suggestions: items.slice(0, 50),
      top_rated: topRated.length ? topRated : items.slice(0, 50),
      forgotten_gems: [],
      recently_watched: items.filter((scene) => scene.last_played_at).slice(0, 50),
    };
  }

  async function fetchLibraryStats() {
    const query = `
      query SmartDashboardLibraryStats($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
        }
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 1 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
    const totalScenes = Number(container.count || 0);
    return {
      total_scenes: totalScenes,
      estimated_recommendation_seconds: estimateRecommendationSeconds(totalScenes),
    };
  }

  async function fetchRandomLibraryScenes(count) {
    const query = `
      query SmartDashboardRandomScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const firstResponse = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { filter: { page: 1, per_page: 1 } },
      }),
    });

    if (!firstResponse.ok) {
      throw new Error(`HTTP ${firstResponse.status}`);
    }

    const firstPayload = await firstResponse.json();
    if (firstPayload.errors && firstPayload.errors.length) {
      throw new Error(firstPayload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const firstContainer = firstPayload.data && firstPayload.data.findScenes ? firstPayload.data.findScenes : {};
    const totalScenes = Number(firstContainer.count || 0);
    const firstScene = Array.isArray(firstContainer.scenes) ? firstContainer.scenes[0] : null;
    if (totalScenes <= 0) {
      return [];
    }

    const wanted = Math.min(count, totalScenes);
    const indexes = new Set();
    while (indexes.size < wanted) {
      indexes.add(Math.floor(Math.random() * totalScenes));
    }

    const scenes = [];
    if (indexes.delete(0) && firstScene) {
      scenes.push(firstScene);
    }

    const requests = Array.from(indexes).map((index) =>
      fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page: index + 1, per_page: 1 } },
        }),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json();
        })
        .then((payload) => {
          if (payload.errors && payload.errors.length) {
            throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
          }
          const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
          return Array.isArray(container.scenes) ? container.scenes[0] : null;
        })
    );

    const fetchedScenes = await Promise.all(requests);
    return scenes.concat(fetchedScenes.filter(Boolean)).map(sceneFromGraphQL);
  }

  async function fetchSearchLibraryScenes() {
    if (librarySearchCache) {
      return librarySearchCache;
    }

    const query = `
      query SmartDashboardSearchScenes($filter: FindFilterType!) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            rating100
            play_count
            last_played_at
            paths { screenshot }
            files { path width height }
            tags { name }
            performers { name }
            studio { name }
          }
        }
      }
    `;
    const scenes = [];
    const perPage = 500;
    let page = 1;
    let total = null;

    while (total === null || scenes.length < total) {
      const response = await fetch(`${pluginBasePath()}/graphql`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variables: { filter: { page, per_page: perPage } },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (payload.errors && payload.errors.length) {
        throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
      }

      const container = payload.data && payload.data.findScenes ? payload.data.findScenes : {};
      const pageScenes = Array.isArray(container.scenes) ? container.scenes : [];
      scenes.push(...pageScenes);
      total = Number.isFinite(Number(container.count)) ? Number(container.count) : scenes.length;
      if (!pageScenes.length || pageScenes.length < perPage) {
        break;
      }
      page += 1;
    }

    librarySearchCache = scenes.map((scene, index) => sceneFromGraphQL(scene, index));
    return librarySearchCache;
  }

  async function fetchDashboardData(options) {
    const data = await fetchRecommendations(options);
    try {
      const liveStats = await fetchLibraryStats();
      data.library_stats = {
        ...(data.library_stats || {}),
        ...liveStats,
      };
    } catch (error) {
      console.warn("[Smart Dashboard] Could not refresh live library stats", error);
    }
    return data;
  }

  async function enrichSceneTitles(data) {
    const scenes = collectRecommendationScenes(data);
    const needsEnrichment = scenes.some((scene) => isUntitled(scene.title) && !scene.file_name && !scene.file_path);
    if (!needsEnrichment) {
      return data;
    }

    try {
      const titleIndex = await fetchSceneTitleIndex();
      scenes.forEach((scene) => {
        const extra = titleIndex.get(String(scene.id));
        if (!extra) {
          return;
        }

        scene.stash_title = scene.stash_title || extra.title;
        scene.file_path = scene.file_path || extra.file_path;
        scene.file_name = scene.file_name || extra.file_name;
        if (isUntitled(scene.title)) {
          scene.title = !isUntitled(extra.title) ? extra.title : extra.file_name || scene.title;
        }
      });
    } catch (error) {
      console.warn("[Smart Dashboard] Could not enrich scene titles", error);
    }

    return data;
  }

  async function runCleanupTask(maxDurationSeconds) {
    const mutation = `
      mutation SmartDashboardCleanupShort(
        $pluginId: ID!
        $args: Map
      ) {
        runPluginOperation(
          plugin_id: $pluginId
          args: $args
        )
      }
    `;
    const response = await fetch(`${pluginBasePath()}/graphql`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          pluginId: PLUGIN_ID,
          args: {
            task: "cleanup_short",
            mode: "cleanup_short",
            max_duration_seconds: maxDurationSeconds,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    return payload.data ? payload.data.runPluginOperation : null;
  }

  function normalizeScene(scene, stashBaseUrl) {
    const id = scene.id || scene.scene_id || "";
    const tags = Array.isArray(scene.tags) ? scene.tags : [];
    const performers = Array.isArray(scene.performers) ? scene.performers : [];
    const fallbackTitle = fileNameFromPath(scene.file_name || scene.file_path);
    const title = isUntitled(scene.title) ? fallbackTitle || `Scene ${id}` : scene.title;
    return {
      id,
      title,
      cover: scene.cover_path || scene.thumbnail || scene.image || scene.screenshot || "",
      rating: scene.rating ?? null,
      reason: translateDisplayText(scene.reason || ""),
      resolution: scene.resolution || scene.quality || "",
      tags,
      performers,
      studio: scene.studio || "",
      playCount: scene.play_count || 0,
      lastPlayedAt: scene.last_played_at || "",
      stashUrl: scene.stash_url || `${stashBaseUrl.replace(/\/$/, "")}/scenes/${id}`,
      streamUrl: scene.stream_url || `${stashBaseUrl.replace(/\/$/, "")}/scene/${id}/stream`,
    };
  }

  function translateDisplayText(value) {
    if (!value) {
      return "";
    }
    if (window.SmartDashboardI18n && typeof window.SmartDashboardI18n.translateReason === "function") {
      return window.SmartDashboardI18n.translateReason(value);
    }
    return String(value);
  }

  function ratingText(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return t("card.unrated");
    }
    return `${Number(value).toFixed(1)} / 5`;
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }

    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
  }

  function parseDurationInput(value) {
    const text = String(value || "").trim();
    if (!text) {
      return NaN;
    }

    if (!text.includes(":")) {
      return Number(text);
    }

    const parts = text.split(":").map((part) => Number(part));
    if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
      return NaN;
    }

    if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    }

    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function chooseFeatured(data) {
    const candidates = [
      ...(data.top_rated || []),
        ...(data.library_spotlight || []),
      ...(data.forgotten_gems || []),
      ...(data.smart_suggestions || []),
    ].filter(Boolean);

    if (!candidates.length) {
      return null;
    }

    const premiumPool = candidates.slice(0, Math.min(candidates.length, 12));
    return premiumPool[Math.floor(Math.random() * premiumPool.length)];
  }

  function registerPlugin() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.ReactDOM) {
      registerAttempts += 1;
      if (registerAttempts <= MAX_REGISTER_ATTEMPTS) {
        window.setTimeout(registerPlugin, 125);
      }
      return;
    }

    const React = api.React;
    const h = React.createElement;

    function Icon(props) {
      return h("span", { className: `sd-icon ${props.className || ""}`, "aria-hidden": "true" }, props.children);
    }

    function Pill(props) {
      return h("span", { className: "sd-pill" }, props.children);
    }

    function StatCard(props) {
      return h(
        "div",
        { className: "sd-stat-card" },
        h("div", { className: "sd-stat-icon" }, props.icon),
        h("div", { className: "sd-stat-value" }, props.value),
        h("div", { className: "sd-stat-label" }, props.label)
      );
    }

    function SceneCard(props) {
      const scene = normalizeScene(props.scene, props.stashBaseUrl);
      const meta = [ratingText(scene.rating), scene.resolution, scene.studio].filter(Boolean).join(" • ");

      return h(
        "a",
        {
          className: "sd-scene-card",
          href: scene.stashUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: props.onPlay
            ? (event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                  return;
                }

                event.preventDefault();
                props.onPlay(props.scene);
              }
            : undefined,
        },
        h("div", {
          className: "sd-scene-backdrop",
          style: scene.cover ? { backgroundImage: `url("${scene.cover}")` } : {},
        }),
        h("div", { className: "sd-card-gradient" }),
        h(
          "div",
          { className: "sd-card-content" },
          h("h3", { className: "sd-card-title", title: scene.title }, scene.title),
          h("div", { className: "sd-card-meta" }, meta || t("card.plays", { count: scene.playCount })),
          h("p", { className: "sd-card-reason" }, scene.reason || t("card.openInStash")),
          h(
            "div",
            { className: "sd-card-tags" },
            scene.tags.slice(0, 4).map((tag) => h(Pill, { key: tag }, tag))
          )
        )
      );
    }

    function Row(props) {
      const railRef = React.useRef(null);

      if (!props.scenes.length) {
        return null;
      }

      function scrollRail(direction) {
        const rail = railRef.current;
        if (!rail) {
          return;
        }

        const distance = Math.max(rail.clientWidth * 0.82, 320);
        const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
        const current = rail.scrollLeft;
        const target = current + direction * distance;
        const wrapThreshold = 8;

        if (maxScroll <= wrapThreshold) {
          return;
        }

        if (direction > 0 && (current >= maxScroll - wrapThreshold || target >= maxScroll)) {
          rail.scrollTo({
            left: 0,
            behavior: "smooth",
          });
          return;
        }

        if (direction < 0 && (current <= wrapThreshold || target <= 0)) {
          rail.scrollTo({
            left: maxScroll,
            behavior: "smooth",
          });
          return;
        }

        rail.scrollTo({
          left: target,
          behavior: "smooth",
        });
      }

      return h(
        "section",
        { className: "sd-row", id: props.id },
        h(
          "div",
          { className: "sd-row-header" },
          h(
            "div",
            null,
            h("h2", null, h(Icon, null, props.icon), props.title),
            h("p", null, props.subtitle)
          ),
          h("span", { className: "sd-row-count" }, t("row.scenesCount", { count: props.scenes.length }))
        ),
        h(
          "div",
          { className: "sd-rail-wrap" },
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-left",
              type: "button",
              "aria-label": t("row.scrollLeft", { title: props.title }),
              onClick: () => scrollRail(-1),
            },
            "‹"
          ),
          h(
            "div",
            { className: "sd-rail", ref: railRef },
            props.scenes.map((scene, index) =>
              h(SceneCard, {
                key: `${props.id}-${scene.id || index}`,
                scene,
                stashBaseUrl: props.stashBaseUrl,
                onPlay: props.onPlay,
              })
            )
          ),
          h(
            "button",
            {
              className: "sd-rail-arrow sd-rail-arrow-right",
              type: "button",
              "aria-label": t("row.scrollRight", { title: props.title }),
              onClick: () => scrollRail(1),
            },
            "›"
          )
        )
      );
    }

    function uniqueScenesFromRows(rows) {
      const seen = new Set();
      const scenes = [];
      rows.forEach((row) => {
        const rowScenes = Array.isArray(row[3]) ? row[3] : [];
        rowScenes.forEach((scene) => {
          if (!scene) {
            return;
          }

          const key = String(scene.id || scene.stash_url || scene.file_path || scene.title || "");
          if (!key || seen.has(key)) {
            return;
          }

          seen.add(key);
          scenes.push(scene);
        });
      });
      return scenes;
    }

    function topTagNamesFromData(data, scenes) {
      const profileTags =
        data.preference_profile && Array.isArray(data.preference_profile.top_tags)
          ? data.preference_profile.top_tags
          : [];
      const names = profileTags
        .map((tag) => (typeof tag === "string" ? tag : tag && tag.name))
        .filter(Boolean);

      if (names.length) {
        return names.slice(0, 5);
      }

      const counts = new Map();
      scenes.forEach((scene) => {
        (Array.isArray(scene.tags) ? scene.tags : []).forEach((tag) => {
          const name = String(tag || "").trim();
          if (name) {
            counts.set(name, (counts.get(name) || 0) + 1);
          }
        });
      });

      return Array.from(counts.entries())
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map((entry) => entry[0]);
    }

    function buildTopTagScenes(rows, data) {
      const scenes = uniqueScenesFromRows(rows);
      const tagNames = topTagNamesFromData(data, scenes);
      const normalizedTags = tagNames.map((tag) => tag.toLowerCase());

      if (!normalizedTags.length) {
        return { tagNames, scenes: [] };
      }

      const matches = scenes
        .map((scene) => {
          const sceneTags = (Array.isArray(scene.tags) ? scene.tags : []).map((tag) => String(tag).toLowerCase());
          const matchCount = normalizedTags.filter((tag) => sceneTags.includes(tag)).length;
          return { scene, matchCount };
        })
        .filter((item) => item.matchCount > 0)
        .sort((left, right) => right.matchCount - left.matchCount || (right.scene.score || 0) - (left.scene.score || 0))
        .map((item) => item.scene);

      return { tagNames, scenes: matches.slice(0, 50) };
    }

    function pickRandomScenes(scenes, count) {
      const pool = scenes.slice();
      for (let index = pool.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        const current = pool[index];
        pool[index] = pool[swapIndex];
        pool[swapIndex] = current;
      }
      return pool.slice(0, count);
    }

    function RandomPicks(props) {
      const [picks, setPicks] = React.useState(() => pickRandomScenes(props.scenes, 6));
      const [loading, setLoading] = React.useState(false);

      async function refreshPicks() {
        setLoading(true);
        try {
          const livePicks = await fetchRandomLibraryScenes(6);
          setPicks(livePicks.length ? livePicks : pickRandomScenes(props.scenes, 6));
        } catch (error) {
          console.warn("[Smart Dashboard] Could not fetch random library scenes", error);
          setPicks(pickRandomScenes(props.scenes, 6));
        } finally {
          setLoading(false);
        }
      }

      React.useEffect(() => {
        let active = true;
        setLoading(true);
        fetchRandomLibraryScenes(6)
          .then((livePicks) => {
            if (active) {
              setPicks(livePicks.length ? livePicks : pickRandomScenes(props.scenes, 6));
            }
          })
          .catch((error) => {
            console.warn("[Smart Dashboard] Could not fetch random library scenes", error);
            if (active) {
              setPicks(pickRandomScenes(props.scenes, 6));
            }
          })
          .finally(() => {
            if (active) {
              setLoading(false);
            }
          });

        return () => {
          active = false;
        };
      }, [props.scenes]);

      if (!props.scenes.length) {
        return null;
      }

      return h(
        "section",
        { className: "sd-row sd-random-picks", id: "random-picks" },
        h(
          "div",
          { className: "sd-row-header" },
          h(
            "div",
            { className: "sd-random-title-wrap" },
            h(
              "div",
              null,
              h("h2", null, h(Icon, null, "⟳"), t("random.title")),
              h("p", null, t("random.subtitle"))
            ),
            h(
              "button",
              {
                className: "sd-row-action-button",
                type: "button",
                disabled: loading,
                onClick: refreshPicks,
              },
              loading ? t("random.loading") : t("random.refresh")
            )
          )
        ),
        h(
          "div",
          { className: "sd-rail sd-random-rail" },
          picks.map((scene, index) =>
            h(SceneCard, {
              key: `random-${scene.id || scene.stash_url || index}`,
              scene,
              stashBaseUrl: props.stashBaseUrl,
              onPlay: props.onPlay,
            })
          )
        )
      );
    }

    function SearchPanel(props) {
      const [titleQuery, setTitleQuery] = React.useState("");
      const [tagQuery, setTagQuery] = React.useState("");
      const [loading, setLoading] = React.useState(false);
      const [results, setResults] = React.useState([]);
      const [totalMatches, setTotalMatches] = React.useState(0);
      const [message, setMessage] = React.useState(null);

      async function handleSearch(event) {
        event.preventDefault();
        const titleTerm = titleQuery.trim().toLowerCase();
        const tagTerms = tagQuery
          .split(",")
          .map((term) => term.trim().toLowerCase())
          .filter(Boolean);

        if (!titleTerm && !tagTerms.length) {
          setResults([]);
          setTotalMatches(0);
          setMessage({ type: "error", text: t("search.error.empty") });
          return;
        }

        setLoading(true);
        setMessage({ type: "info", text: t("search.info.searching") });
        try {
          const scenes = await fetchSearchLibraryScenes();
          const matches = scenes.filter((scene) => {
            const titleHaystack = [
              scene.title,
              scene.stash_title,
              scene.file_name,
              scene.file_path,
            ]
              .filter(Boolean)
              .join(" ")
              .toLowerCase();
            const tagHaystack = (Array.isArray(scene.tags) ? scene.tags : [])
              .join(" ")
              .toLowerCase();
            const titleMatches = titleTerm ? titleHaystack.includes(titleTerm) : true;
            const tagMatches = tagTerms.length
              ? tagTerms.every((term) => tagHaystack.includes(term))
              : true;
            return titleMatches && tagMatches;
          });

          setResults(matches.slice(0, 50));
          setTotalMatches(matches.length);
          setMessage({
            type: matches.length ? "success" : "info",
            text: matches.length
              ? `${matches.length} match${matches.length === 1 ? "" : "es"} found. Showing up to 50.`
              : t("search.noResults"),
          });
        } catch (error) {
          console.warn("[Smart Dashboard] Library search failed", error);
          setResults([]);
          setTotalMatches(0);
          setMessage({ type: "error", text: t("tasks.failed") });
        } finally {
          setLoading(false);
        }
      }

      return h(
        "section",
        { className: "sd-search-panel", id: "cinematic-search" },
        h(
          "div",
          { className: "sd-search-header" },
          h("span", { className: "sd-tools-kicker" }, t("search.kicker")),
          h("h2", null, t("search.title")),
          h("p", null, t("search.description"))
        ),
        h(
          "form",
          { className: "sd-search-form", onSubmit: handleSearch },
          h(
            "label",
            { className: "sd-search-label" },
            t("search.titleLabel"),
            h("input", {
              className: "sd-search-input",
              type: "search",
              value: titleQuery,
              placeholder: t("search.titlePlaceholder"),
              disabled: loading,
              onChange: (event) => setTitleQuery(event.target.value),
            })
          ),
          h(
            "label",
            { className: "sd-search-label" },
            t("search.tagsLabel"),
            h("input", {
              className: "sd-search-input",
              type: "search",
              value: tagQuery,
              placeholder: t("search.tagsPlaceholder"),
              disabled: loading,
              onChange: (event) => setTagQuery(event.target.value),
            })
          ),
          h(
            "button",
            { className: "sd-search-button", type: "submit", disabled: loading },
            loading ? t("search.searching") : t("search.button")
          )
        ),
        message
          ? h("div", { className: `sd-search-status sd-search-status-${message.type}` }, message.text)
          : null,
        results.length
          ? h(Row, {
              id: "search-results",
              title: t("search.results.title"),
              subtitle:
                totalMatches === 1
                  ? t("search.results.subtitle", { count: totalMatches })
                  : t("search.results.subtitle_plural", { count: totalMatches }),
              scenes: results,
              icon: "⌕",
              stashBaseUrl: props.stashBaseUrl,
              onPlay: props.onPlay,
            })
          : null
      );
    }

    function PlayerOverlay(props) {
      if (!props.scene) {
        return null;
      }

      const scene = normalizeScene(props.scene, props.stashBaseUrl);
      return h(
        "div",
        { className: "sd-player-backdrop", role: "dialog", "aria-modal": "true" },
        h(
          "div",
          { className: "sd-player-panel" },
          h(
            "div",
            { className: "sd-player-header" },
            h(
              "div",
              null,
              h("span", { className: "sd-tools-kicker" }, t("player.nowPlaying")),
              h("h2", null, scene.title)
            ),
            h(
              "button",
              {
                className: "sd-player-close",
                type: "button",
                onClick: props.onClose,
                "aria-label": t("player.close"),
              },
              "×"
            )
          ),
          h("video", {
            className: "sd-player-video",
            src: scene.streamUrl,
            poster: scene.cover || undefined,
            controls: true,
            autoPlay: true,
            playsInline: true,
          }),
          h(
            "div",
            { className: "sd-player-actions" },
            h("span", null, [ratingText(scene.rating), scene.resolution, scene.studio].filter(Boolean).join(" • ")),
            h("a", { href: scene.stashUrl, target: "_blank", rel: "noopener noreferrer" }, t("player.openInStash"))
          )
        )
      );
    }

    function Hero(props) {
      const scene = props.scene ? normalizeScene(props.scene, props.stashBaseUrl) : null;
      const tags = scene ? [ratingText(scene.rating), scene.resolution, scene.studio, ...scene.tags.slice(0, 4)].filter(Boolean) : [];

      return h(
        "section",
        { className: "sd-hero" },
        h("div", {
          className: "sd-hero-image",
          style: scene && scene.cover ? { backgroundImage: `url("${scene.cover}")` } : {},
        }),
        h("div", { className: "sd-hero-overlay" }),
        h(
          "div",
          { className: "sd-hero-content" },
          h("div", { className: "sd-kicker" }, t("hero.featured")),
          h("h1", null, scene ? scene.title : t("app.title")),
          h(
            "p",
            null,
            scene
              ? scene.reason || t("hero.defaultDescription")
              : t("hero.generateHint")
          ),
          h("div", { className: "sd-hero-tags" }, tags.map((tag) => h(Pill, { key: tag }, tag))),
          h(
            "div",
            { className: "sd-hero-actions" },
            scene
              ? h(
                  "button",
                  {
                    className: "sd-button sd-button-primary",
                    type: "button",
                    onClick: () => (props.onPlay ? props.onPlay(props.scene) : window.open(scene.stashUrl, "_blank", "noopener,noreferrer")),
                  },
                  t("hero.play")
                )
              : null,
            h("button", { className: "sd-button sd-button-secondary", type: "button", onClick: () => window.location.reload() }, t("hero.refresh"))
          )
        )
      );
    }

    function PluginTasks(props) {
      const [statuses, setStatuses] = React.useState({});

      React.useEffect(() => {
        let active = true;
        triggerSetupOnce().then((result) => {
          if (!active) {
            return;
          }

          if (result.started) {
            setStatuses((current) => ({
              ...current,
              setup: result.queued
                ? t("tasks.setup.autoStarted", { jobId: result.job_id })
                : t("tasks.setup.autoDone"),
            }));
          } else if (result.error) {
            setStatuses((current) => ({
              ...current,
              setup: t("tasks.setup.autoFailed"),
            }));
          } else {
            setStatuses((current) => ({
              ...current,
              setup: t("tasks.setup.already"),
            }));
          }
        });

        return () => {
          active = false;
        };
      }, []);

      async function startTask(key, mode, description) {
        setStatuses((current) => ({ ...current, [key]: t("tasks.starting") }));
        try {
          const result = await runPluginModeTask(mode, description);
          const message = result.queued
            ? t("tasks.started", { jobId: result.job_id })
            : t("tasks.done");
          setStatuses((current) => ({ ...current, [key]: message }));
        } catch (error) {
          console.warn("[Smart Dashboard] Task start failed", error);
          setStatuses((current) => ({
            ...current,
            [key]: t("tasks.failed"),
          }));
        }
      }

      return h(
        "section",
        { className: "sd-task-panel", id: "plugin-tasks" },
        h(
          "div",
          { className: "sd-task-panel-header" },
          h("span", { className: "sd-tools-kicker" }, t("tasks.kicker")),
          h("h2", null, t("tasks.title")),
          h("p", null, t("tasks.description"))
        ),
        h(
          "div",
          { className: "sd-task-grid" },
          h(TaskButton, {
            title: t("tasks.setup.title"),
            description: t("tasks.setup.description"),
            button: t("tasks.setup.button"),
            status: statuses.setup,
            onClick: () => startTask("setup", SETUP_MODE, "Smart Dashboard manual setup"),
          }),
          h(TaskButton, {
            title: t("tasks.recommendations.title"),
            description: t("tasks.recommendations.description"),
            button: t("tasks.recommendations.button"),
            status: statuses.recommendations || (props.autostarted ? t("tasks.recommendations.autostart") : null),
            onClick: () =>
              startTask("recommendations", RECOMMENDATIONS_MODE, "Smart Dashboard refresh recommendations"),
          }),
          h(TaskButton, {
            title: t("tasks.duplicates.title"),
            description: t("tasks.duplicates.description"),
            button: t("tasks.duplicates.button"),
            status: statuses.duplicates,
            onClick: () => startTask("duplicates", DUP_SCAN_MODE, "Smart Dashboard duplicate scan"),
          })
        )
      );
    }

    function TaskButton(props) {
      return h(
        "div",
        { className: "sd-task-card" },
        h("h3", null, props.title),
        h("p", null, props.description),
        h(
          "button",
          { className: "sd-task-button", type: "button", onClick: props.onClick },
          props.button
        ),
        props.status ? h("div", { className: "sd-task-status" }, props.status) : null
      );
    }

    function DuplicateResults() {
      const [state, setState] = React.useState({ loading: true, error: null, report: null });

      function loadReport() {
        setState((current) => ({ ...current, loading: true, error: null }));
        fetchDuplicateReport({ forceAssetFetch: true })
          .then((report) => setState({ loading: false, error: null, report }))
          .catch((error) => setState({ loading: false, error, report: null }));
      }

      React.useEffect(() => {
        let active = true;
        fetchDuplicateReport()
          .then((report) => {
            if (active) {
              setState({ loading: false, error: null, report });
            }
          })
          .catch((error) => {
            if (active) {
              setState({ loading: false, error, report: null });
            }
          });

        return () => {
          active = false;
        };
      }, []);

      const report = state.report || {};
      const duplicates = Array.isArray(report.duplicates) ? report.duplicates : [];
      const skipped = Array.isArray(report.skipped) ? report.skipped.length : Number(report.skipped || 0);

      return h(
        "section",
        { className: "sd-duplicates", id: "duplicate-results" },
        h(
          "div",
          { className: "sd-duplicates-header" },
          h("span", { className: "sd-tools-kicker" }, t("duplicates.kicker")),
          h("h2", null, t("duplicates.title")),
          h(
            "p",
            null,
            t("duplicates.description")
          ),
          h(
            "button",
            { className: "sd-task-button", type: "button", onClick: loadReport, disabled: state.loading },
            state.loading ? t("random.loading") : t("duplicates.reload")
          )
        ),
        state.loading
          ? h("div", { className: "sd-duplicates-empty" }, t("duplicates.loading"))
          : state.error
            ? h(
                "div",
                { className: "sd-duplicates-empty" },
                h("strong", null, t("duplicates.empty")),
                h("span", null, t("duplicates.emptyHint"))
              )
            : h(
                "div",
                { className: "sd-duplicates-body" },
                h(
                  "div",
                  { className: "sd-duplicates-meta" },
                  h("span", null, t("duplicates.candidates", { count: duplicates.length })),
                  h(
                    "span",
                    null,
                    t("duplicates.hashed", {
                      done: report.hashed_scenes || 0,
                      total: report.total_scenes || 0,
                    })
                  ),
                  h("span", null, t("duplicates.cache", { count: report.cache_hits || 0 })),
                  h("span", null, t("duplicates.skipped", { count: skipped })),
                  report.generated_at
                    ? h("span", null, t("duplicates.updated", { date: formatDate(report.generated_at) }))
                    : null
                ),
                duplicates.length
                  ? h(
                      "div",
                      { className: "sd-duplicates-list" },
                      duplicates.slice(0, 25).map((item, index) =>
                        h(DuplicateCandidate, {
                          key: `${item.scene_a && item.scene_a.id}-${item.scene_b && item.scene_b.id}-${index}`,
                          item,
                        })
                      )
                    )
                  : h("div", { className: "sd-duplicates-empty" }, t("duplicates.none"))
              )
      );
    }

    function DuplicateCandidate(props) {
      const item = props.item || {};
      const sceneA = item.scene_a || {};
      const sceneB = item.scene_b || {};
      const confidence = Math.round(Number(item.confidence || 0) * 100);

      return h(
        "article",
        { className: "sd-duplicate-card" },
        h(
          "div",
          { className: "sd-duplicate-score" },
          h("strong", null, `${confidence}%`),
          h("span", null, t("duplicates.distance", { value: item.average_hamming_distance || "?" }))
        ),
        h(DuplicateScene, { scene: sceneA, label: "A" }),
        h(DuplicateScene, { scene: sceneB, label: "B" }),
        h(
          "div",
          { className: "sd-duplicate-samples" },
          `${item.compared_samples || 0} samples compared`
        )
      );
    }

    function DuplicateScene(props) {
      const scene = props.scene || {};
      const id = scene.id ? String(scene.id) : "";
      const fallbackTitle = fileNameFromPath(scene.path);
      const title = isUntitled(scene.title) ? fallbackTitle || `Scene ${id || "?"}` : scene.title || fallbackTitle || `Scene ${id || "?"}`;

      return h(
        "div",
        { className: "sd-duplicate-scene" },
        h("span", { className: "sd-duplicate-label" }, props.label),
        id
          ? h("a", { href: `${window.location.origin}/scenes/${id}`, target: "_blank", rel: "noopener noreferrer" }, title)
          : h("strong", null, title),
        scene.path ? h("small", null, scene.path) : null
      );
    }

    function LibraryTools() {
      const [durationInput, setDurationInput] = React.useState("0:30");
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const numericSeconds = parseDurationInput(durationInput);
      const isValid = Number.isFinite(numericSeconds) && numericSeconds > 0;

      async function handlePurge() {
        if (!isValid) {
          setStatus({
            type: "error",
            message: t("cleanup.invalid"),
          });
          return;
        }

        const confirmed = window.confirm(
          t("cleanup.confirm", { seconds: numericSeconds, input: durationInput })
        );
        if (!confirmed) {
          return;
        }

        setBusy(true);
        setStatus({ type: "info", message: t("cleanup.running") });
        try {
          await runCleanupTask(numericSeconds);
          setStatus({
            type: "success",
            message: t("cleanup.done"),
          });
        } catch (error) {
          console.warn("[Smart Dashboard] Cleanup start failed", error);
          setStatus({
            type: "error",
            message: t("cleanup.failed"),
          });
        } finally {
          setBusy(false);
        }
      }

      return h(
        "section",
        { className: "sd-tools", id: "library-tools" },
        h(
          "div",
          { className: "sd-tools-copy" },
          h("span", { className: "sd-tools-kicker" }, t("cleanup.kicker")),
          h("h2", null, t("cleanup.title")),
          h("p", null, t("cleanup.description"))
        ),
        h(
          "div",
          { className: "sd-cleanup-card" },
          h(
            "label",
            { className: "sd-cleanup-label", htmlFor: "sd-cleanup-seconds" },
            t("cleanup.label"),
            h("span", null, t("cleanup.hint"))
          ),
          h(
            "div",
            { className: "sd-cleanup-controls" },
            h("input", {
              id: "sd-cleanup-seconds",
              className: isValid ? "sd-cleanup-input" : "sd-cleanup-input sd-cleanup-input-invalid",
              type: "text",
              inputMode: "numeric",
              placeholder: t("cleanup.placeholder"),
              value: durationInput,
              disabled: busy,
              onChange: (event) => setDurationInput(event.target.value),
            }),
            h(
              "button",
              {
                className: "sd-purge-button",
                type: "button",
                disabled: busy || !isValid,
                onClick: handlePurge,
              },
              busy ? t("cleanup.purging") : t("cleanup.purge")
            )
          ),
          h(
            "p",
            { className: "sd-cleanup-warning" },
            t("cleanup.warning")
          ),
          status
            ? h(
                "div",
                { className: `sd-tool-status sd-tool-status-${status.type}` },
                status.message
              )
            : null
        )
      );
    }

    function renderLogo() {
      return h("div", { className: "sd-logo" }, h("span", null, t("app.brand")), " ", t("nav.cinematic"));
    }

    function formatFileSize(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) {
        return `${value} B`;
      }
      if (value < 1024 * 1024) {
        return `${(value / 1024).toFixed(1)} KB`;
      }
      if (value < 1024 * 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      }
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function formatTopbarMeta(data, libraryTotal, estimatedSeconds, autostartExtra) {
      const params = {
        version: UI_VERSION,
        count: libraryTotal,
        duration: formatDuration(estimatedSeconds),
        extra: autostartExtra || "",
      };
      if (data.generated_at) {
        return t("topbar.uiMeta", { ...params, date: formatDate(data.generated_at) });
      }
      return t("topbar.uiMetaNoDate", params);
    }

    function McpAgentPage() {
      const [indexStats, setIndexStats] = React.useState(null);
      const [agentEnvironment, setAgentEnvironment] = React.useState(null);
      const [agentSetupStatus, setAgentSetupStatus] = React.useState(null);
      const [indexScanFailed, setIndexScanFailed] = React.useState(false);
      const [setupLogText, setSetupLogText] = React.useState("");
      const [scanProgress, setScanProgress] = React.useState(null);
      const [indexJobActive, setIndexJobActive] = React.useState(false);
      const [logCopyStatus, setLogCopyStatus] = React.useState("");
      const setupLogPreRef = React.useRef(null);
      const [statusLoading, setStatusLoading] = React.useState(true);
      const [mcpActivity, setMcpActivity] = React.useState({
        phase: "idle",
        label: "",
        progress: null,
        jobId: null,
      });
      const [messages, setMessages] = React.useState([]);
      const [input, setInput] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [scanBusy, setScanBusy] = React.useState(false);
      const [setupBusy, setSetupBusy] = React.useState(false);
      const [resultScenes, setResultScenes] = React.useState([]);
      const [playerScene, setPlayerScene] = React.useState(null);
      const [copyStatus, setCopyStatus] = React.useState("");
      const [, setLocaleTick] = React.useState(0);
      const stashBaseUrl = window.location.origin;
      const [mcpConfigText, setMcpConfigText] = React.useState("");

      React.useEffect(() => {
        if (!window.SmartDashboardI18n) {
          return undefined;
        }
        return window.SmartDashboardI18n.onChange(() => setLocaleTick((value) => value + 1));
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const text = await fetchMcpConfigSnippet();
            if (!cancelled && text) {
              setMcpConfigText(text);
            }
          } catch (error) {
            console.warn("[Smart Dashboard] Could not build MCP config", error);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      React.useEffect(() => {
        const ready = Boolean(indexStats && indexStats.ready && (indexStats.scene_count || 0) > 0);
        if (ready) {
          return undefined;
        }
        let cancelled = false;
        async function watchIndexBuild() {
          try {
            const assetPayload = await syncAgentStateFromAssets();
            if (cancelled) {
              return;
            }
            if (indexReadyFromPayload(assetPayload)) {
              setIndexJobActive(false);
              setScanBusy(false);
              return;
            }
            const jobs = await fetchStashJobQueue();
            if (cancelled) {
              return;
            }
            const active = jobs.some(
              (job) =>
                isActiveStashJob(job) &&
                (isAgentIndexBuildJob(job) || isMcpAgentSetupJob(job))
            );
            setIndexJobActive(active);
            if (active) {
              setScanBusy(true);
              setMcpActivity((current) =>
                current.phase === "scan" || current.phase === "setup"
                  ? current
                  : {
                      ...current,
                      phase: "scan",
                      label: t("mcpAgent.activityScanRunning"),
                      progress: null,
                      jobId: null,
                    }
              );
            }
            try {
              const latest = await fetchAgentDepsCheck();
              if (!cancelled) {
                applyAgentPayload(latest);
                settleMcpUiIfReady(latest);
              }
            } catch (depsError) {
              console.warn("[Smart Dashboard] Deps check during index watch failed", depsError);
            }
          } catch (error) {
            console.warn("[Smart Dashboard] Index watch poll failed", error);
          }
        }
        watchIndexBuild();
        const timer = window.setInterval(watchIndexBuild, 15000);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, [indexStats]);

      function patchMcpActivity(patch) {
        setMcpActivity((current) => ({ ...current, ...patch }));
      }

      function applyAgentPayload(payload) {
        if (payload && payload.index) {
          setIndexStats(payload.index);
        } else if (payload && (payload.scene_count !== undefined || payload.ready !== undefined)) {
          setIndexStats(payload);
        }
        if (payload && payload.environment) {
          setAgentEnvironment(payload.environment);
          if (payload.environment.deps && payload.environment.deps.all_ready) {
            localStorage.setItem(MCP_SETUP_KEY, "1");
          }
        }
        if (payload && payload.install_state) {
          markMcpInstallCompleteFromState(payload.install_state);
        }
        if (payload && payload.setup_status) {
          setAgentSetupStatus(payload.setup_status);
          if (payload.setup_status.state === "success") {
            localStorage.setItem(MCP_SETUP_KEY, "1");
          }
        }
        if (payload && typeof payload.setup_log === "string") {
          setSetupLogText(payload.setup_log);
        }
        const progress = parseScanProgressFromPayload(payload);
        if (progress) {
          setScanProgress(progress);
        }
      }

      function formatSetupLogFromStatus(status) {
        if (!status || typeof status !== "object") {
          return "";
        }
        const lines = [];
        if (status.state) {
          lines.push(`Status: ${status.state}`);
        }
        if (status.updated_at) {
          lines.push(`Aktualisiert: ${status.updated_at}`);
        }
        if (status.message) {
          lines.push(String(status.message));
        }
        if (status.error) {
          lines.push(String(status.error));
        }
        return lines.join("\n");
      }

      function formatSetupLogDisplay(logText, activity) {
        const trimmed = String(logText || "").trim();
        if (trimmed) {
          return logText;
        }
        const fromStatus = formatSetupLogFromStatus(agentSetupStatus);
        if (fromStatus) {
          return fromStatus;
        }
        if (activity && activity.phase && activity.phase !== "idle" && activity.label) {
          return t("mcpAgent.logWaiting", { activity: activity.label });
        }
        return t("mcpAgent.logEmpty");
      }

      async function refreshSetupLogDisplay() {
        try {
          let logText = await fetchSetupLogText();
          const assetPayload = await fetchAgentStateFromAssets();
          if (!logText && assetPayload && typeof assetPayload.setup_log === "string") {
            logText = assetPayload.setup_log;
          }
          if (assetPayload) {
            if (assetPayload.setup_status) {
              setAgentSetupStatus(assetPayload.setup_status);
            }
            if (assetPayload.index || assetPayload.environment) {
              applyAgentPayload(assetPayload);
              settleMcpUiIfReady(assetPayload);
            }
          }
          if (!logText) {
            const logPayload = await fetchAgentSetupLog();
            if (logPayload && typeof logPayload.setup_log === "string" && logPayload.setup_log.trim()) {
              logText = logPayload.setup_log;
            }
            if (logPayload && logPayload.setup_status) {
              setAgentSetupStatus(logPayload.setup_status);
            }
            if (logPayload) {
              applyAgentPayload(logPayload);
              settleMcpUiIfReady(logPayload);
            }
          }
          if (logText && logText.trim()) {
            setSetupLogText(logText);
          }
        } catch (error) {
          console.warn("[Smart Dashboard] Could not refresh setup log", error);
        }
      }

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          if (cancelled) {
            return;
          }
          await refreshSetupLogDisplay();
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      React.useEffect(() => {
        if (setupLogPreRef.current) {
          setupLogPreRef.current.scrollTop = setupLogPreRef.current.scrollHeight;
        }
      }, [setupLogText]);

      async function refreshIndexStats(options) {
        setStatusLoading(true);
        try {
          let payload = await fetchAgentStateFromAssets();
          if (!payload || !indexReadyFromPayload(payload)) {
            try {
              payload = await fetchAgentIndexStats({ full: Boolean(options && options.full) });
            } catch (error) {
              console.warn("[Smart Dashboard] Could not load agent index stats", error);
              if (!payload) {
                return null;
              }
            }
          }
          if (payload) {
            applyAgentPayload(payload);
            settleMcpUiIfReady(payload);
          }
          return payload;
        } finally {
          setStatusLoading(false);
        }
      }

      async function syncAgentStateFromAssets() {
        const payload = await fetchAgentStateFromAssets();
        if (payload) {
          applyAgentPayload(payload);
          settleMcpUiIfReady(payload);
        }
        return payload;
      }

      function settleMcpUiIfReady(payload) {
        if (!indexReadyFromPayload(payload)) {
          return false;
        }
        setSetupBusy(false);
        setScanBusy(false);
        setIndexJobActive(false);
        setIndexScanFailed(false);
        sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
        patchMcpActivity({ phase: "idle", label: "", progress: null, jobId: null });
        return true;
      }

      async function runTrackedMcpTask(mode, description, kind) {
        const labels =
          kind === "setup"
            ? {
                start: t("mcpAgent.activitySetupStart"),
                running: t("mcpAgent.activitySetupRunning"),
                done: t("mcpAgent.activitySetupDone"),
                failed: t("mcpAgent.activitySetupFailed"),
              }
            : {
                start: t("mcpAgent.activityScanStart"),
                running: t("mcpAgent.activityScanRunning"),
                done: t("mcpAgent.activityScanDone"),
                failed: t("mcpAgent.activityScanFailed"),
              };

        const setBusyFlag = kind === "setup" ? setSetupBusy : setScanBusy;
        setBusyFlag(true);
        patchMcpActivity({ phase: kind, label: labels.start, progress: null, jobId: null });

        const pathHints = await agentPathHints();
        let indexPollTimer = null;
        let logPollTimer = null;
        const stopLogPoll = () => {
          if (logPollTimer) {
            clearInterval(logPollTimer);
            logPollTimer = null;
          }
        };
        logPollTimer = setInterval(() => {
          refreshSetupLogDisplay().catch(() => {});
        }, MCP_LOG_POLL_MS);
        try {
          const result = await runPluginModeTask(mode, description, pathHints);
          if (!result.queued) {
            patchMcpActivity({ phase: kind, label: labels.running, progress: 0.35, jobId: null });
            const latest = await refreshIndexStats();
            const normalized = normalizePluginResult(result.result || result);
            let setupOk = true;
            if (kind === "setup") {
              const depsOk =
                (normalized && normalized.skipped) ||
                (normalized && normalized.deps && normalized.deps.all_ready) ||
                depsReadyFromPayload(latest);
              setupOk = depsOk;
              if (depsOk) {
                localStorage.setItem(MCP_SETUP_KEY, "1");
                sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
              }
            }
            const taskOk = kind === "setup" ? setupOk : true;
            if (kind === "scan") {
              setIndexScanFailed(false);
            }
            patchMcpActivity({
              phase: "idle",
              label: taskOk ? labels.done : labels.failed,
              progress: taskOk ? 1 : null,
              jobId: null,
            });
            await refreshSetupLogDisplay();
            return { ok: taskOk, result, latest };
          }

          const jobId = result.job_id;
          patchMcpActivity({
            phase: kind,
            label: t("mcpAgent.activityJob", { jobId }),
            progress: 0,
            jobId,
          });

          if (kind === "scan") {
            indexPollTimer = setInterval(() => {
              refreshIndexStats({ full: false });
            }, 15000);
          }

          const job = await pollStashJobUntilDone(jobId, {
            onUpdate: (liveJob) => {
              const progress = liveJob && typeof liveJob.progress === "number" ? liveJob.progress : null;
              patchMcpActivity({
                phase: kind,
                label: (liveJob && liveJob.description) || labels.running,
                progress,
                jobId,
              });
            },
          });

          let latest = await refreshIndexStats({ full: true });
          const status = String((job && job.status) || "").toUpperCase();
          let taskOk = status === "FINISHED";
          if (kind === "setup" && taskOk) {
            if (!depsReadyFromPayload(latest) && !setupSucceededFromPayload(latest)) {
              latest = (await pollDepsUntilReady(120000, 2500)) || latest;
            }
            const depsOk = depsReadyFromPayload(latest) || setupSucceededFromPayload(latest);
            if (depsOk) {
              localStorage.setItem(MCP_SETUP_KEY, "1");
              sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
            } else {
              taskOk = false;
            }
          }
          if (kind === "scan" && taskOk) {
            taskOk = indexReadyFromPayload(latest);
          }
          if (kind === "scan") {
            setIndexScanFailed(!taskOk);
          }
          patchMcpActivity({
            phase: "idle",
            label: taskOk ? labels.done : labels.failed,
            progress: taskOk ? 1 : null,
            jobId: null,
          });
          await refreshSetupLogDisplay();
          return { ok: taskOk, job, result, latest };
        } catch (error) {
          console.warn(`[Smart Dashboard] MCP ${kind} task failed`, error);
          if (kind === "scan") {
            clearIndexAutostartQueued();
            setIndexScanFailed(true);
          }
          patchMcpActivity({ phase: "idle", label: labels.failed, progress: null, jobId: null });
          throw error;
        } finally {
          stopLogPoll();
          if (indexPollTimer) {
            clearInterval(indexPollTimer);
          }
          setBusyFlag(false);
        }
      }

      async function waitForAgentSetupCompletion(isCancelled, onProgress) {
        const deadline = Date.now() + 60 * 60 * 1000;
        let loop = 0;
        while (Date.now() < deadline) {
          if (isCancelled()) {
            return null;
          }
          const jobs = await fetchStashJobQueue();
          const active = jobs.find((job) => isActiveStashJob(job) && isMcpAgentSetupJob(job));
          if (active && onProgress) {
            onProgress(active);
          }
          let latest = null;
          try {
            const logPayload = await fetchAgentSetupLog();
            if (logPayload) {
              if (typeof logPayload.setup_log === "string") {
                setSetupLogText(logPayload.setup_log);
              }
              if (logPayload.setup_status) {
                setAgentSetupStatus(logPayload.setup_status);
              }
            }
            if (loop % 2 === 0) {
              latest = await fetchAgentDepsCheck();
              applyAgentPayload(latest);
            }
          } catch (error) {
            console.warn("[Smart Dashboard] Setup wait poll failed", error);
          }
          if (depsReadyFromPayload(latest)) {
            localStorage.setItem(MCP_SETUP_KEY, "1");
            sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
            return latest;
          }
          if (!active) {
            if (!depsReadyFromPayload(latest) && !setupSucceededFromPayload(latest)) {
              if (!setupFailedFromPayload(latest)) {
                latest = (await pollDepsUntilReady(120000, MCP_DEPS_POLL_MS)) || latest;
              }
            }
            if (depsReadyFromPayload(latest) || setupSucceededFromPayload(latest)) {
              localStorage.setItem(MCP_SETUP_KEY, "1");
              sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
            } else if (!setupFailedFromPayload(latest)) {
              sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
            }
            return latest;
          }
          loop += 1;
          await sleepMs(MCP_DEPS_POLL_MS);
        }
        return null;
      }

      async function ensureMcpDependencies(force) {
        if (!force) {
          const installState = await probeInstallStateFromAssets();
          if (installState && installState.index_ready) {
            const latest = await syncAgentStateFromAssets();
            settleMcpUiIfReady(latest);
            return { ok: true, skipped: true, latest, already_installed: true };
          }
          if (installState && installState.mcp_deps_ready) {
            localStorage.setItem(MCP_SETUP_KEY, "1");
            const latest = await syncAgentStateFromAssets();
            if (!indexReadyFromPayload(latest)) {
              await ensureAgentIndexInBackground();
            }
            return { ok: true, skipped: true, latest, deps_only: true };
          }
          let latest = null;
          try {
            latest = await fetchAgentDepsCheck();
            applyAgentPayload(latest);
          } catch (error) {
            console.warn("[Smart Dashboard] Could not check agent deps", error);
          }
          if (depsReadyFromPayload(latest) || indexReadyFromPayload(latest)) {
            settleMcpUiIfReady(latest);
            return { ok: true, skipped: true, latest };
          }
          await ensureAgentDependenciesInBackground();
          await resumeTrackedJobsIfAny();
          const waited = await waitForAgentSetupCompletion(
            () => false,
            (job) => {
              patchMcpActivity({
                phase: "setup",
                label: job.description || t("mcpAgent.activitySetupRunning"),
                progress: typeof job.progress === "number" ? job.progress : null,
                jobId: job.id,
              });
            }
          );
          const ready = depsReadyFromPayload(waited) || setupSucceededFromPayload(waited);
          patchMcpActivity({
            phase: "idle",
            label: ready ? t("mcpAgent.activitySetupDone") : t("mcpAgent.activitySetupFailed"),
            progress: ready ? 1 : null,
            jobId: null,
          });
          return { ok: ready, latest: waited };
        }
        sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
        return runTrackedMcpTask(SETUP_AGENT_MODE, "Smart Dashboard MCP agent setup", "setup");
      }

      async function resumeTrackedJobsIfAny() {
        try {
          let latestCheck = await syncAgentStateFromAssets();
          if (indexReadyFromPayload(latestCheck)) {
            return;
          }
          if (!latestCheck) {
            try {
              latestCheck = await fetchAgentDepsCheck();
              applyAgentPayload(latestCheck);
              if (indexReadyFromPayload(latestCheck)) {
                settleMcpUiIfReady(latestCheck);
                return;
              }
            } catch (error) {
              console.warn("[Smart Dashboard] Could not refresh deps before job resume", error);
            }
          }

          const jobs = await fetchStashJobQueue();
          const active = jobs.filter((job) => {
            const status = String(job.status || "").toUpperCase();
            if (MCP_JOB_TERMINAL.has(status)) {
              return false;
            }
            const text = String(job.description || "").toLowerCase();
            return text.includes("smart dashboard") || text.includes("mcp agent") || text.includes("agent index");
          });
          if (!active.length) {
            return;
          }
          const job = active[0];
          let kind = mcpJobKind(job);
          if (kind === "setup" && depsReadyFromPayload(latestCheck)) {
            kind = "scan";
          }
          const labels =
            kind === "setup"
              ? {
                  running: t("mcpAgent.activitySetupRunning"),
                  done: t("mcpAgent.activitySetupDone"),
                  failed: t("mcpAgent.activitySetupFailed"),
                }
              : {
                  running: t("mcpAgent.activityScanRunning"),
                  done: t("mcpAgent.activityScanDone"),
                  failed: t("mcpAgent.activityScanFailed"),
                };
          if (kind === "setup") {
            setSetupBusy(true);
          } else {
            setScanBusy(true);
          }
          patchMcpActivity({
            phase: kind,
            label: job.description || labels.running,
            progress: typeof job.progress === "number" ? job.progress : null,
            jobId: job.id,
          });
          let indexPollTimer = setInterval(() => {
            syncAgentStateFromAssets().catch(() => {});
          }, MCP_LOG_POLL_MS);
          let logPollTimer = setInterval(() => {
            refreshSetupLogDisplay().catch(() => {});
          }, MCP_LOG_POLL_MS);
          const finished = await pollStashJobUntilDone(job.id, {
            onUpdate: (liveJob) => {
              patchMcpActivity({
                phase: kind,
                label: (liveJob && liveJob.description) || labels.running,
                progress: liveJob && typeof liveJob.progress === "number" ? liveJob.progress : null,
                jobId: job.id,
              });
            },
            onAssetPoll: async () => {
              const assetPayload = await syncAgentStateFromAssets();
              if (indexReadyFromPayload(assetPayload)) {
                return { indexReady: true };
              }
              return null;
            },
          });
          if (indexPollTimer) {
            clearInterval(indexPollTimer);
          }
          if (logPollTimer) {
            clearInterval(logPollTimer);
          }
          let latest = (await syncAgentStateFromAssets()) || (await refreshIndexStats({ full: true }));
          await refreshSetupLogDisplay();
          const status = String((finished && finished.status) || "").toUpperCase();
          let taskOk = status === "FINISHED" || Boolean(finished && finished.index_ready_early);
          if (indexReadyFromPayload(latest)) {
            taskOk = true;
            settleMcpUiIfReady(latest);
          }
          if (kind === "setup" && taskOk) {
            if (!depsReadyFromPayload(latest) && !setupSucceededFromPayload(latest)) {
              latest = (await pollDepsUntilReady(120000, 2500)) || latest;
            }
            taskOk = depsReadyFromPayload(latest) || setupSucceededFromPayload(latest);
            if (taskOk) {
              localStorage.setItem(MCP_SETUP_KEY, "1");
              sessionStorage.removeItem(MCP_SETUP_AUTOSTART_KEY);
            }
          }
          if (kind === "scan" && taskOk) {
            taskOk = indexReadyFromPayload(latest);
          }
          if (kind === "scan") {
            setIndexScanFailed(!taskOk);
          }
          patchMcpActivity({
            phase: "idle",
            label: taskOk ? labels.done : labels.failed,
            progress: taskOk ? 1 : null,
            jobId: null,
          });
          if (kind === "setup") {
            setSetupBusy(false);
          } else {
            setScanBusy(false);
          }
          if (taskOk && kind === "setup" && !indexReadyFromPayload(latest)) {
            await maybeStartAutoScan(latest);
          }
        } catch (error) {
          console.warn("[Smart Dashboard] Could not resume MCP jobs", error);
        }
      }

      React.useEffect(() => {
        let cancelled = false;
        async function pollSetupLog() {
          if (cancelled) {
            return;
          }
          await refreshSetupLogDisplay();
        }
        pollSetupLog();
        const timer = window.setInterval(pollSetupLog, MCP_LOG_POLL_MS);
        return () => {
          cancelled = true;
          window.clearInterval(timer);
        };
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        async function bootstrap() {
          setMessages([{ role: "assistant", text: t("mcpAgent.welcome") }]);
          await probeInstallStateFromAssets();
          let latest = await syncAgentStateFromAssets();
          if (!cancelled) {
            setStatusLoading(false);
          }
          if (indexReadyFromPayload(latest)) {
            settleMcpUiIfReady(latest);
            return;
          }
          if (!latest) {
            try {
              latest = await fetchAgentDepsCheck();
              applyAgentPayload(latest);
              settleMcpUiIfReady(latest);
            } catch (error) {
              console.warn("[Smart Dashboard] Initial deps check failed", error);
            }
          }
          if (!cancelled && !indexReadyFromPayload(latest)) {
            if (depsReadyFromPayload(latest)) {
              await refreshIndexStats({ full: true });
            } else {
              await refreshIndexStats({ full: false });
            }
            latest = (await syncAgentStateFromAssets()) || latest;
          }
          if (cancelled) {
            return;
          }
          if (depsReadyFromPayload(latest) && !indexReadyFromPayload(latest)) {
            localStorage.setItem(MCP_SETUP_KEY, "1");
          }
          if (indexReadyFromPayload(latest)) {
            settleMcpUiIfReady(latest);
          } else {
            resumeTrackedJobsIfAny().catch((error) => {
              console.warn("[Smart Dashboard] Could not resume MCP jobs", error);
            });
          }
          if (cancelled) {
            return;
          }
          if (!latest) {
            latest = await fetchAgentDepsCheck();
            applyAgentPayload(latest);
          }
          if (cancelled) {
            return;
          }
          const jobsAfterResume = await fetchStashJobQueue();
          const indexJobRunning = jobsAfterResume.some(
            (job) => isActiveStashJob(job) && (isAgentIndexBuildJob(job) || isMcpAgentSetupJob(job))
          );
          if (!indexJobRunning && !indexReadyFromPayload(latest)) {
            await maybeStartAutoScan(latest);
          }
          let depsReadyFlag = depsReadyFromPayload(latest) || indexReadyFromPayload(latest);
          if (!depsReadyFlag) {
            patchMcpActivity({
              phase: "setup",
              label: t("mcpAgent.activityAutoSetupBackground"),
              progress: null,
              jobId: null,
            });
            try {
              const setupOutcome = await ensureMcpDependencies(false);
              latest = (setupOutcome && setupOutcome.latest) || (await refreshIndexStats());
              depsReadyFlag = depsReadyFromPayload(latest) || setupSucceededFromPayload(latest);
              if (!cancelled) {
                if (depsReadyFlag) {
                  setMessages((current) => [
                    ...current,
                    { role: "assistant", text: t("mcpAgent.autoSetupDone") },
                  ]);
                } else if (setupFailedFromPayload(latest)) {
                  setMessages((current) => [
                    ...current,
                    { role: "assistant", text: t("mcpAgent.autoSetupPartial") },
                  ]);
                } else if (setupOutcome && setupOutcome.ok === false) {
                  setMessages((current) => [
                    ...current,
                    { role: "assistant", text: t("mcpAgent.autoSetupBackgroundPending") },
                  ]);
                } else {
                  setMessages((current) => [
                    ...current,
                    { role: "assistant", text: t("mcpAgent.autoSetupPartial") },
                  ]);
                }
              }
              if (depsReadyFlag && !indexReadyFromPayload(latest)) {
                await maybeStartAutoScan(latest);
              }
            } catch (error) {
              if (!cancelled) {
                setMessages((current) => [
                  ...current,
                  { role: "assistant", text: t("mcpAgent.activitySetupFailed") },
                ]);
              }
            }
          }
        }
        bootstrap();
        return () => {
          cancelled = true;
        };
      }, []);

      async function maybeStartAutoScan(latest) {
        if (!depsReadyFromPayload(latest) || indexReadyFromPayload(latest)) {
          return { started: false, reason: "not_needed" };
        }
        const jobs = await fetchStashJobQueue();
        if (jobs.some((job) => isActiveStashJob(job) && isAgentIndexBuildJob(job))) {
          return { started: false, reason: "already_running" };
        }
        const progress = parseScanProgressFromPayload(latest);
        if (progress && progress.phase && progress.updated_at && !isScanProgressStale(progress)) {
          return { started: false, reason: "progress_active" };
        }
        // Older builds set this key before the scan finished; retry when the index is still missing.
        if (sessionStorage.getItem(MCP_AUTO_SCAN_KEY) && !indexReadyFromPayload(latest)) {
          sessionStorage.removeItem(MCP_AUTO_SCAN_KEY);
        }
        if (sessionStorage.getItem(MCP_AUTO_SCAN_KEY) === "1") {
          return { started: false, reason: "already_done" };
        }
        setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.autoScanStart") }]);
        try {
          const outcome = await runTrackedMcpTask(
            BUILD_AGENT_INDEX_MODE,
            "Smart Dashboard agent index rebuild",
            "scan"
          );
          const refreshed = (outcome && outcome.latest) || (await refreshIndexStats({ full: true }));
          if (indexReadyFromPayload(refreshed)) {
            sessionStorage.setItem(MCP_AUTO_SCAN_KEY, "1");
            markIndexAutostartQueued();
            setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.scanDone") }]);
          } else {
            clearIndexAutostartQueued();
            setIndexScanFailed(true);
            setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.scanFailed") }]);
          }
          return { started: true, ok: Boolean(outcome && outcome.ok) };
        } catch (error) {
          clearIndexAutostartQueued();
          setIndexScanFailed(true);
          setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.scanFailed") }]);
          return { started: true, ok: false, error };
        }
      }

      async function rebuildIndex() {
        try {
          const outcome = await runTrackedMcpTask(
            BUILD_AGENT_INDEX_MODE,
            "Smart Dashboard agent index rebuild",
            "scan"
          );
          setMessages((current) => [
            ...current,
            {
              role: "assistant",
              text: outcome.ok ? t("mcpAgent.scanDone") : t("mcpAgent.scanFailed"),
            },
          ]);
        } catch (error) {
          setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.scanFailed") }]);
        }
      }

      async function handleSend(event) {
        if (event) {
          event.preventDefault();
        }
        const text = input.trim();
        if (!text || busy) {
          return;
        }
        setInput("");
        setBusy(true);
        setMessages((current) => [...current, { role: "user", text }]);
        try {
          const response = await sendAgentChatMessage(text);
          const reply = (response && response.reply) || t("mcpAgent.noReply");
          const scenes = (response && response.scenes) || [];
          setMessages((current) => [...current, { role: "assistant", text: reply }]);
          setResultScenes(scenes.map((scene) => normalizeScene(scene, stashBaseUrl)));
        } catch (error) {
          console.warn("[Smart Dashboard] Agent chat failed", error);
          setMessages((current) => [...current, { role: "assistant", text: t("mcpAgent.chatFailed") }]);
        } finally {
          setBusy(false);
        }
      }

      const stats = indexStats || {};
      const env = agentEnvironment || {};
      const indexReady = Boolean(stats.ready && stats.scene_count > 0);
      const deps = env.deps || {};
      const depsReady =
        Boolean(deps.all_ready) ||
        Boolean(agentSetupStatus && agentSetupStatus.state === "success") ||
        localStorage.getItem(MCP_SETUP_KEY) === "1";
      const dbExists = Boolean(env.db_exists);
      const stashSqlite = env.stash_sqlite || {};
      const stashSqliteReady = Boolean(stashSqlite.readable && stashSqlite.scene_count > 0);
      const indexSource = stats.index_source || env.index_source || "";
      const activityBusy = setupBusy || scanBusy;
      const setupFailed = Boolean(agentSetupStatus && agentSetupStatus.state === "failed");
      const setupRunning =
        setupBusy ||
        Boolean(agentSetupStatus && agentSetupStatus.state === "running") ||
        (mcpActivity.phase === "setup" && activityBusy);
      const setupOk = depsReady && !setupFailed;
      const setupComplete = Boolean(indexReady);
      const setupError = Boolean((setupFailed && !depsReady && !indexReady) || (indexScanFailed && !indexReady));
      const progressScenes =
        Number((scanProgress && scanProgress.scene_count) || stats.scene_count) || 0;
      const progressTotal =
        Number((scanProgress && scanProgress.total_scenes) || stashSqlite.scene_count) || 0;
      const scanProgressStale = isScanProgressStale(scanProgress);
      const setupWorking =
        !indexReady &&
        (activityBusy ||
          setupRunning ||
          indexJobActive ||
          Boolean(mcpActivity.phase === "setup" || mcpActivity.phase === "scan") ||
          Boolean(scanProgress && scanProgress.phase) ||
          (!setupComplete && !statusLoading));
      const showMainSetupBanner = !statusLoading && !indexReady && (setupWorking || setupError);
      const showActivity = setupWorking || setupError || Boolean(mcpActivity.label);
      const bannerPercent = estimateMcpSetupPercent({
        depsReady,
        setupOk,
        indexReady,
        scanBusy: scanBusy || indexJobActive,
        setupBusy,
        stats: { ...stats, scene_count: progressScenes },
        stashSqlite: { ...stashSqlite, scene_count: progressTotal || stashSqlite.scene_count },
        mcpActivity,
        scanProgress,
      });
      const progressPercent =
        typeof mcpActivity.progress === "number"
          ? Math.round(Math.min(1, Math.max(0, mcpActivity.progress)) * 100)
          : showMainSetupBanner
            ? bannerPercent
            : null;
      const bannerCurrentLine =
        (scanProgress && scanProgress.phase) ||
        getSetupLogTailLines(setupLogText, 1)[0] ||
        mcpActivity.label ||
        (setupError
          ? t("mcpAgent.bannerCurrentError")
          : scanBusy
            ? t("mcpAgent.activityScanRunning")
            : setupBusy || setupRunning
              ? t("mcpAgent.activitySetupRunning")
              : t("mcpAgent.bannerStarting"));
      const bannerLiveLines = getSetupLogTailLines(setupLogText, 5);
      const bannerVariant = setupError ? "error" : setupWorking ? "working" : "pending";
      const dbSizeLabel =
        env.db_size_bytes
          ? t("mcpAgent.statusDbSize", { size: formatFileSize(env.db_size_bytes) })
          : null;
      const dbDateLabel =
        stats.generated_at ? t("mcpAgent.statusDbDate", { date: formatDate(stats.generated_at) }) : null;

      function mcpStepState(ok, failed) {
        if (ok) {
          return "ok";
        }
        if (failed) {
          return "failed";
        }
        return "pending";
      }

      function renderStatusRow(label, state, detail) {
        const step = state === "ok" || state === "failed" ? state : "pending";
        const icon = step === "ok" ? "✓" : step === "failed" ? "✕" : "○";
        const ariaLabel =
          step === "ok"
            ? t("mcpAgent.statusIconOk")
            : step === "failed"
              ? t("mcpAgent.statusIconFailed")
              : t("mcpAgent.statusIconPending");
        return h(
          "div",
          {
            className: `sd-mcp-status-row sd-mcp-status-row-${step}`,
            role: "listitem",
          },
          h("span", { className: "sd-mcp-status-icon", "aria-label": ariaLabel, title: ariaLabel }, icon),
          h(
            "div",
            { className: "sd-mcp-status-copy" },
            h("strong", null, label),
            detail ? h("span", null, detail) : null
          )
        );
      }

      const depsFailed = setupFailed && !depsReady;
      const depsState = mcpStepState(depsReady, depsFailed);
      const setupState = mcpStepState(setupOk, setupFailed);
      const stashFailed = Boolean(stashSqlite.path && !stashSqlite.readable && stashSqlite.error);
      const stashState = mcpStepState(stashSqliteReady, stashFailed);
      const indexState = mcpStepState(indexReady && dbExists, indexScanFailed && !indexReady);

      function renderBannerStep(label, state) {
        const step = state === "ok" || state === "failed" ? state : "pending";
        const icon = step === "ok" ? "✓" : step === "failed" ? "✕" : "○";
        return h(
          "div",
          { className: `sd-mcp-setup-step sd-mcp-setup-step-${step}`, key: label },
          h("span", { className: "sd-mcp-setup-step-icon", "aria-hidden": true }, icon),
          h("span", { className: "sd-mcp-setup-step-label" }, label)
        );
      }

      function renderMainSetupBanner() {
        if (!showMainSetupBanner) {
          return null;
        }
        const title = setupError
          ? t("mcpAgent.bannerTitleError")
          : setupComplete
            ? t("mcpAgent.bannerTitleReady")
            : t("mcpAgent.bannerTitleWorking");
        const subtitle = setupError
          ? t("mcpAgent.bannerSubtitleError")
          : scanProgressStale && !indexJobActive && !scanBusy
            ? t("mcpAgent.bannerSubtitleStale")
          : scanBusy || indexJobActive || progressScenes > 0
            ? progressTotal
              ? t("mcpAgent.bannerSubtitleScanWithTotal", {
                  current: progressScenes,
                  total: progressTotal,
                })
              : t("mcpAgent.bannerSubtitleScan", { current: progressScenes })
            : setupBusy || setupRunning
              ? t("mcpAgent.bannerSubtitleSetup")
              : !depsReady
                ? t("mcpAgent.bannerSubtitleDeps")
                : !indexReady
                  ? t("mcpAgent.bannerSubtitleIndexWaiting")
                  : t("mcpAgent.bannerSubtitlePending");

        return h(
          "div",
          {
            className: `sd-mcp-setup-banner sd-mcp-setup-banner-${bannerVariant}`,
            role: "status",
            "aria-live": "polite",
            "aria-busy": setupWorking,
          },
          h(
            "div",
            { className: "sd-mcp-setup-banner-head" },
            setupWorking ? h("span", { className: "sd-mcp-spinner sd-mcp-setup-banner-spinner", "aria-hidden": true }) : null,
            h(
              "div",
              { className: "sd-mcp-setup-banner-titles" },
              h("h2", { className: "sd-mcp-setup-banner-title" }, title),
              h("p", { className: "sd-mcp-setup-banner-subtitle" }, subtitle)
            ),
            h("span", { className: "sd-mcp-setup-banner-percent" }, `${bannerPercent}%`)
          ),
          h(
            "div",
            { className: "sd-mcp-progress-track sd-mcp-setup-banner-progress" },
            h("div", {
              className: `sd-mcp-progress-fill${setupWorking && bannerPercent < 1 ? " sd-mcp-progress-fill-active" : ""}`,
              style: { width: `${bannerPercent}%` },
            })
          ),
          h(
            "div",
            { className: "sd-mcp-setup-steps", role: "list" },
            renderBannerStep(t("mcpAgent.bannerStepDeps"), depsState),
            renderBannerStep(t("mcpAgent.bannerStepMcp"), setupState),
            renderBannerStep(
              t("mcpAgent.bannerStepStashDb"),
              stashSqliteReady ? "ok" : stashFailed ? "failed" : "pending"
            ),
            renderBannerStep(t("mcpAgent.bannerStepIndex"), indexState)
          ),
          h("p", { className: "sd-mcp-setup-banner-current" }, bannerCurrentLine),
          scanBusy && (stats.scene_count || 0) > 0
            ? h(
                "p",
                { className: "sd-mcp-setup-banner-stats" },
                t("mcpAgent.activityScanProgress", { scenes: stats.scene_count || 0 }),
                stashSqlite.scene_count
                  ? ` · ${t("mcpAgent.bannerScanOfTotal", {
                      current: stats.scene_count || 0,
                      total: stashSqlite.scene_count,
                    })}`
                  : null
              )
            : null,
          bannerLiveLines.length
            ? h(
                "div",
                { className: "sd-mcp-setup-live" },
                h("span", { className: "sd-mcp-setup-live-title" }, t("mcpAgent.bannerLiveFeed")),
                h(
                  "ul",
                  null,
                  bannerLiveLines.map((line, index) =>
                    h("li", { key: `live-${index}-${line.slice(0, 24)}` }, line)
                  )
                )
              )
            : null,
          setupError
            ? h(
                "div",
                { className: "sd-mcp-setup-banner-actions" },
                !depsReady
                  ? h(
                      "button",
                      {
                        className: "sd-task-button",
                        type: "button",
                        disabled: setupBusy,
                        onClick: () => ensureMcpDependencies(true),
                      },
                      setupBusy ? t("mcpAgent.setupBusy") : t("mcpAgent.setupRetry")
                    )
                  : null,
                !indexReady
                  ? h(
                      "button",
                      {
                        className: "sd-task-button sd-task-button-secondary",
                        type: "button",
                        disabled: scanBusy,
                        onClick: rebuildIndex,
                      },
                      scanBusy ? t("mcpAgent.scanning") : t("mcpAgent.scanButton")
                    )
                  : null
              )
            : null,
          h("p", { className: "sd-mcp-setup-banner-hint" }, t("mcpAgent.bannerHint"))
        );
      }

      return h(
        "div",
        { className: "sd-shell sd-mcp-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          h("div", { className: "sd-logo sd-logo-mcp" }, h("span", null, t("app.brand")), " ", t("mcpAgent.title")),
          h(
            "div",
            { className: "sd-topbar-actions" },
            h(
              "button",
              { className: "sd-topbar-button", type: "button", onClick: () => window.smartDashboardOpen() },
              t("nav.cinematic")
            )
          )
        ),
        h(PlayerOverlay, { scene: playerScene, stashBaseUrl, onClose: () => setPlayerScene(null) }),
        h(
          "div",
          { className: "sd-mcp-layout" },
          h(
            "aside",
            { className: "sd-mcp-sidebar" },
            h("span", { className: "sd-tools-kicker" }, t("mcpAgent.sidebarKicker")),
            h("h2", null, t("mcpAgent.sidebarTitle")),
            h("p", null, t("mcpAgent.sidebarDescription")),
            h(
              "div",
              { className: "sd-mcp-status-panel" },
              h("h3", { className: "sd-mcp-status-title" }, t("mcpAgent.statusTitle")),
              statusLoading
                ? h("p", { className: "sd-mcp-hint sd-mcp-hint-muted" }, t("mcpAgent.statusLoading"))
                : h(
                    "div",
                    { className: "sd-mcp-status-list", role: "list" },
                    renderStatusRow(
                      t("mcpAgent.statusDeps"),
                      depsState,
                      depsState === "ok"
                        ? t("mcpAgent.statusDepsOk")
                        : depsState === "failed"
                          ? agentSetupStatus && agentSetupStatus.error
                            ? t("mcpAgent.statusDepsFailed", { error: agentSetupStatus.error })
                            : t("mcpAgent.statusSetupFailedShort")
                          : deps.python_executable
                            ? t("mcpAgent.statusDepsMissingPython", { python: deps.python_executable })
                            : t("mcpAgent.statusDepsMissing")
                    ),
                    renderStatusRow(
                      t("mcpAgent.statusSetup"),
                      setupState,
                      setupState === "ok"
                        ? t("mcpAgent.statusSetupOk")
                        : setupState === "failed"
                          ? agentSetupStatus && agentSetupStatus.error
                            ? t("mcpAgent.statusSetupFailedDetail", { error: agentSetupStatus.error })
                            : t("mcpAgent.statusSetupFailedShort")
                          : setupRunning
                            ? t("mcpAgent.activitySetupRunning")
                            : t("mcpAgent.statusSetupPending")
                    ),
                    renderStatusRow(
                      t("mcpAgent.statusStashDb"),
                      stashState,
                      stashState === "ok"
                        ? t("mcpAgent.statusStashDbOk", { count: stashSqlite.scene_count || 0 })
                        : stashState === "failed"
                          ? t("mcpAgent.statusStashDbFailed", {
                              path: stashSqlite.path || "?",
                              error: stashSqlite.error || "",
                            })
                          : stashSqlite.available
                            ? t("mcpAgent.statusStashDbUnreadable", { path: stashSqlite.path || "?" })
                            : stashSqlite.path
                              ? t("mcpAgent.statusStashDbPath", { path: stashSqlite.path })
                              : t("mcpAgent.statusStashDbMissing")
                    ),
                    renderStatusRow(
                      t("mcpAgent.statusDb"),
                      indexState,
                      indexState === "ok"
                        ? [
                            t("mcpAgent.statusDbOk", { count: stats.scene_count || 0 }),
                            indexSource === "stash_sqlite" ? t("mcpAgent.indexSourceSqlite") : null,
                            dbSizeLabel,
                            dbDateLabel,
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : indexState === "failed"
                          ? t("mcpAgent.statusDbFailed")
                          : scanBusy
                            ? t("mcpAgent.activityScanRunning")
                            : t("mcpAgent.statusDbEmpty")
                    )
                  )
            ),
            showActivity
              ? h(
                  "div",
                  { className: "sd-mcp-activity-panel" },
                  h("h3", { className: "sd-mcp-status-title" }, t("mcpAgent.activityTitle")),
                  h(
                    "div",
                    { className: "sd-mcp-activity-row" },
                    activityBusy
                      ? h("span", { className: "sd-mcp-spinner", "aria-hidden": true })
                      : null,
                    h("p", { className: "sd-mcp-activity-label" }, mcpActivity.label || t("mcpAgent.activityWorking")),
                    mcpActivity.jobId
                      ? h(
                          "span",
                          { className: "sd-mcp-activity-job" },
                          t("mcpAgent.activityJob", { jobId: mcpActivity.jobId })
                        )
                      : null
                  ),
                  progressPercent !== null
                    ? h(
                        "div",
                        { className: "sd-mcp-progress-track" },
                        h("div", {
                          className: "sd-mcp-progress-fill",
                          style: { width: `${progressPercent}%` },
                        })
                      )
                    : activityBusy
                      ? h("div", { className: "sd-mcp-progress-track sd-mcp-progress-indeterminate" })
                      : null,
                  scanBusy && (stats.scene_count || 0) > 0
                    ? h(
                        "p",
                        { className: "sd-mcp-hint sd-mcp-hint-muted" },
                        t("mcpAgent.activityScanProgress", { scenes: stats.scene_count || 0 })
                      )
                    : null
                )
              : null,
            h(
              "div",
              { className: "sd-mcp-stats" },
              h("div", null, t("mcpAgent.statScenes", { count: stats.scene_count || 0 })),
              h("div", null, t("mcpAgent.statTags", { count: stats.tag_count || 0 })),
              h("div", null, t("mcpAgent.statPerformers", { count: stats.performer_count || 0 })),
              h("div", null, t("mcpAgent.statStudios", { count: stats.studio_count || 0 }))
            ),
            h(
              "button",
              {
                className: "sd-task-button",
                type: "button",
                disabled: scanBusy || setupBusy,
                onClick: rebuildIndex,
              },
              scanBusy ? t("mcpAgent.scanning") : t("mcpAgent.scanButton")
            ),
            !depsReady
              ? h(
                  "button",
                  {
                    className: "sd-task-button sd-task-button-secondary",
                    type: "button",
                    disabled: setupBusy,
                    onClick: () => ensureMcpDependencies(true),
                  },
                  setupBusy ? t("mcpAgent.setupBusy") : t("mcpAgent.setupRetry")
                )
              : null,
            !indexReady
              ? h("p", { className: "sd-mcp-hint" }, t("mcpAgent.indexMissing"))
              : h("p", { className: "sd-mcp-hint" }, t("mcpAgent.indexReady")),
            h("div", { className: "sd-mcp-connect" },
              h("h3", null, t("mcpAgent.connectTitle")),
              h("p", null, t("mcpAgent.connectStep1")),
              h("p", null, t("mcpAgent.connectStep2")),
              h("p", null, t("mcpAgent.connectStep3")),
              h("p", null, t("mcpAgent.connectStep4")),
              h("p", { className: "sd-mcp-hint-muted" }, t("mcpAgent.connectDoc")),
              h(
                "button",
                {
                  className: "sd-task-button sd-task-button-secondary",
                  type: "button",
                  onClick: async () => {
                    const text = await fetchMcpConfigSnippet();
                    setMcpConfigText(text);
                    const ok = await copyTextToClipboard(text);
                    setCopyStatus(ok ? t("mcpAgent.copyConfigDone") : t("mcpAgent.copyConfigFailed"));
                  },
                },
                t("mcpAgent.copyConfig")
              ),
              copyStatus ? h("p", { className: "sd-mcp-copy-status" }, copyStatus) : null,
              h(
                "pre",
                { className: "sd-mcp-config-pre" },
                mcpConfigText || t("mcpAgent.configLoading")
              )
            ),
            h("p", { className: "sd-mcp-hint sd-mcp-hint-muted" }, t("mcpAgent.externalHint"))
          ),
          h(
            "section",
            { className: "sd-mcp-chat" },
            renderMainSetupBanner(),
            h(
              "div",
              { className: "sd-mcp-messages" },
              messages.map((entry, index) =>
                h(
                  "div",
                  {
                    key: `${entry.role}-${index}`,
                    className: `sd-mcp-message sd-mcp-message-${entry.role}`,
                  },
                  entry.text
                )
              ),
              busy ? h("div", { className: "sd-mcp-message sd-mcp-message-assistant" }, t("mcpAgent.thinking")) : null
            ),
            h(
              "form",
              { className: "sd-mcp-input-row", onSubmit: handleSend },
              h("input", {
                className: "sd-mcp-input",
                type: "text",
                value: input,
                disabled: busy || !indexReady,
                placeholder: indexReady ? t("mcpAgent.inputPlaceholder") : t("mcpAgent.inputDisabled"),
                onChange: (event) => setInput(event.target.value),
              }),
              h(
                "button",
                { className: "sd-mcp-send", type: "submit", disabled: busy || !indexReady || !input.trim() },
                t("mcpAgent.send")
              )
            ),
            resultScenes.length
              ? h(
                  "div",
                  { className: "sd-mcp-results" },
                  h("h3", null, t("mcpAgent.resultsTitle")),
                  h(
                    "div",
                    { className: "sd-rail sd-mcp-rail" },
                    resultScenes.map((scene) =>
                      h(SceneCard, {
                        key: scene.id,
                        scene,
                        stashBaseUrl,
                        onPlay: setPlayerScene,
                      })
                    )
                  )
                )
              : null,
            h(
              "div",
              { className: "sd-mcp-log-panel sd-mcp-log-panel-below-chat" },
              h(
                "div",
                { className: "sd-mcp-log-header" },
                h("h3", { className: "sd-mcp-status-title" }, t("mcpAgent.logTitle")),
                h(
                  "button",
                  {
                    className: "sd-task-button sd-task-button-secondary sd-mcp-log-copy",
                    type: "button",
                    onClick: () => refreshSetupLogDisplay(),
                  },
                  t("mcpAgent.logRefresh")
                ),
                h(
                  "button",
                  {
                    className: "sd-task-button sd-task-button-secondary sd-mcp-log-copy",
                    type: "button",
                    disabled: !setupLogText,
                    onClick: async () => {
                      const ok = await copyTextToClipboard(setupLogText);
                      setLogCopyStatus(ok ? t("mcpAgent.logCopyDone") : t("mcpAgent.logCopyFailed"));
                      window.setTimeout(() => setLogCopyStatus(""), 4000);
                    },
                  },
                  t("mcpAgent.logCopy")
                )
              ),
              logCopyStatus ? h("p", { className: "sd-mcp-copy-status" }, logCopyStatus) : null,
              h(
                "pre",
                {
                  className: "sd-mcp-log-pre",
                  ref: setupLogPreRef,
                  "aria-label": t("mcpAgent.logTitle"),
                },
                formatSetupLogDisplay(setupLogText, mcpActivity) || t("mcpAgent.logEmpty")
              )
            )
          )
        )
      );
    }

    function DashboardPage() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null });
      const [refreshState, setRefreshState] = React.useState({ busy: false, message: null, type: "info" });
      const [playerScene, setPlayerScene] = React.useState(null);
      const [, setLocaleTick] = React.useState(0);

      React.useEffect(() => {
        if (!window.SmartDashboardI18n) {
          return undefined;
        }
        return window.SmartDashboardI18n.onChange(() => setLocaleTick((value) => value + 1));
      }, []);

      React.useEffect(() => {
        let active = true;
        fetchDashboardData()
          .then((data) => {
            if (active) {
              setState({ loading: false, error: null, data });
            }
          })
          .catch((error) => {
            if (active) {
              setState({ loading: false, error, data: null });
            }
          });

        return () => {
          active = false;
        };
      }, []);

      async function reloadDashboardData(options) {
        const data = await fetchDashboardData(options);
        setState({ loading: false, error: null, data });
        return data;
      }

      async function refreshRecommendations() {
        setRefreshState({ busy: true, message: t("refresh.rebuilding"), type: "info" });
        try {
          const result = await runPluginModeTask(RECOMMENDATIONS_MODE, "Smart Dashboard manual recommendations refresh", {
            refresh_reason: "manual_dashboard_refresh",
          });
          if (result.queued) {
            setRefreshState({
              busy: false,
              message: t("refresh.jobStarted", { jobId: result.job_id }),
              type: "info",
            });
          } else {
            sessionStorage.removeItem(RECOMMENDATIONS_MISSING_KEY);
            await reloadDashboardData({ forceAssetFetch: true });
            setRefreshState({
              busy: false,
              message: t("refresh.done"),
              type: "success",
            });
          }
        } catch (error) {
          console.warn("[Smart Dashboard] Recommendations refresh failed", error);
          setRefreshState({
            busy: false,
            message: t("refresh.failed"),
            type: "error",
          });
        }
      }

      if (state.loading) {
        return h(
          "div",
          { className: "sd-shell sd-centered" },
          h("div", { className: "sd-loader" }),
          h("p", null, t("loading.cinematic"))
        );
      }

      if (state.error) {
        return h(
          "div",
          { className: "sd-shell" },
          h(
            "div",
            { className: "sd-topbar" },
            renderLogo(),
            h(
              "div",
              { className: "sd-topbar-actions" },
              h("div", { className: "sd-updated" }, t("topbar.libraryTools")),
              h(
                "button",
                {
                  className: "sd-topbar-button",
                  type: "button",
                  onClick: refreshRecommendations,
                  disabled: refreshState.busy,
                },
                refreshState.busy ? t("topbar.refreshBusy") : t("topbar.refresh")
              )
            )
          ),
          h(
            "div",
            { className: "sd-centered sd-error-panel" },
            h("div", { className: "sd-empty-icon" }, "!"),
            h("h1", null, t("error.recommendationsNotFound")),
            h("p", null, t("error.recommendationsHint")),
            h("pre", null, t("error.reportUnavailable"))
          ),
          h(PluginTasks, { autostarted: false }),
          refreshState.message
            ? h("div", { className: `sd-refresh-status sd-refresh-status-${refreshState.type}` }, refreshState.message)
            : null,
          h(DuplicateResults, null),
          h(LibraryTools, null)
        );
      }

      const data = state.data || {};
      const stashBaseUrl = data.stash_base_url || window.location.origin;
      const featured = chooseFeatured(data);
      const rows = [
        [
          "library-spotlight",
          t("row.library_spotlight.title"),
          t("row.library_spotlight.subtitle"),
          data.library_spotlight || [],
          "▣",
        ],
        [
          "forgotten-gems",
          t("row.forgotten_gems.title"),
          t("row.forgotten_gems.subtitle"),
          data.forgotten_gems || [],
          "◆",
        ],
        ["top-rated", t("row.top_rated.title"), t("row.top_rated.subtitle"), data.top_rated || [], "★"],
        [
          "recently-watched",
          t("row.recently_watched.title"),
          t("row.recently_watched.subtitle"),
          data.recently_watched || [],
          "↺",
        ],
        [
          "smart-suggestions",
          t("row.smart_suggestions.title"),
          t("row.smart_suggestions.subtitle"),
          data.smart_suggestions || [],
          "✦",
        ],
      ];
      const totalScenes = rows.reduce((sum, row) => sum + row[3].length, 0);
      const totalUniqueScenes = new Set(
        rows.flatMap((row) => row[3].map((scene) => String(scene.id || ""))).filter(Boolean)
      ).size;
      const libraryTotal = data.library_stats && data.library_stats.total_scenes
        ? data.library_stats.total_scenes
        : totalUniqueScenes;
      const estimatedSeconds = data.library_stats && data.library_stats.estimated_recommendation_seconds
        ? data.library_stats.estimated_recommendation_seconds
        : estimateRecommendationSeconds(libraryTotal);
      const autostartLabel =
        data.recommendations_autostart && data.recommendations_autostart.started
          ? t("topbar.autostart", { duration: formatDuration(estimatedSeconds) })
          : "";
      const recommendationsAutostarted = Boolean(
        data.recommendations_autostart && data.recommendations_autostart.started
      );
      const randomPool = uniqueScenesFromRows(rows);
      const topTagFeed = buildTopTagScenes(rows, data);

      return h(
        "div",
        { className: "sd-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          renderLogo(),
          h(
            "div",
            { className: "sd-topbar-actions" },
            h("div", { className: "sd-updated" }, formatTopbarMeta(data, libraryTotal, estimatedSeconds, autostartLabel)),
            h(
              "button",
              {
                className: "sd-topbar-button",
                type: "button",
                onClick: refreshRecommendations,
                disabled: refreshState.busy,
              },
              refreshState.busy ? t("topbar.refreshBusy") : t("topbar.refresh")
            )
          )
        ),
        refreshState.message
          ? h("div", { className: `sd-refresh-status sd-refresh-status-${refreshState.type}` }, refreshState.message)
          : null,
        h(PlayerOverlay, { scene: playerScene, stashBaseUrl, onClose: () => setPlayerScene(null) }),
        h(Hero, { scene: featured, stashBaseUrl, onPlay: setPlayerScene }),
        h(
          "section",
          { className: "sd-stats" },
          h(StatCard, { icon: "Σ", label: t("stats.videos"), value: libraryTotal }),
          h(StatCard, { icon: "≈", label: t("stats.estimated"), value: formatDuration(estimatedSeconds) }),
          h(StatCard, { icon: "▣", label: t("stats.spotlight"), value: (data.library_spotlight || []).length }),
          h(StatCard, { icon: "✦", label: t("stats.suggestions"), value: (data.smart_suggestions || []).length })
        ),
        h(SearchPanel, { stashBaseUrl, onPlay: setPlayerScene }),
        topTagFeed.scenes.length
          ? h(
              "div",
              { className: "sd-rows sd-top-tags-row" },
              h(Row, {
                id: "top-tags-feed",
                title: t("topTags.title"),
                subtitle: t("topTags.subtitle", { tags: topTagFeed.tagNames.join(", ") }),
                scenes: topTagFeed.scenes,
                icon: "#",
                stashBaseUrl,
                onPlay: setPlayerScene,
              })
            )
          : null,
        totalScenes
          ? h(
              "div",
              { className: "sd-rows" },
              rows.map((row) =>
                h(Row, {
                  key: row[0],
                  id: row[0],
                  title: row[1],
                  subtitle: row[2],
                  scenes: row[3],
                  icon: row[4],
                  stashBaseUrl,
                  onPlay: setPlayerScene,
                })
              )
            )
          : h(
              "div",
              { className: "sd-empty" },
              h("div", { className: "sd-empty-icon" }, "▶"),
              h("h2", null, t("empty.noRows")),
              h("p", null, t("empty.noRowsHint"))
            ),
        h(RandomPicks, { scenes: randomPool, stashBaseUrl, onPlay: setPlayerScene }),
        h(PluginTasks, { autostarted: recommendationsAutostarted }),
        h(DuplicateResults, null),
        h(LibraryTools, null)
      );
    }

    function closeDashboardOverlay() {
      const host = document.getElementById("smart-dashboard-overlay-root");
      if (!host) {
        return;
      }

      if (host._smartDashboardRoot && host._smartDashboardRoot.unmount) {
        host._smartDashboardRoot.unmount();
      } else if (api.ReactDOM.unmountComponentAtNode) {
        api.ReactDOM.unmountComponentAtNode(host);
      }
      host.remove();

      const params = new URLSearchParams(window.location.search);
      if (params.get("smart_dashboard") === "cinematic") {
        window.history.replaceState({}, "", `${pluginBasePath()}/`);
      }
    }

    function DashboardOverlay() {
      return h(
        "div",
        { className: "sd-overlay" },
        h(
          "button",
          {
            className: "sd-overlay-close",
            type: "button",
            onClick: closeDashboardOverlay,
            "aria-label": t("overlay.close"),
          },
          "×"
        ),
        h(DashboardPage, null)
      );
    }

    function showDashboardOverlay() {
      let host = document.getElementById("smart-dashboard-overlay-root");
      if (!host) {
        host = document.createElement("div");
        host.id = "smart-dashboard-overlay-root";
        document.body.appendChild(host);
      }

      window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
      if (api.ReactDOM.createRoot) {
        if (!host._smartDashboardRoot) {
          host._smartDashboardRoot = api.ReactDOM.createRoot(host);
        }
        host._smartDashboardRoot.render(h(DashboardOverlay, null));
      } else {
        api.ReactDOM.render(h(DashboardOverlay, null), host);
      }
    }

    function closeMcpDashboardOverlay() {
      const host = document.getElementById("smart-dashboard-mcp-overlay-root");
      if (!host) {
        return;
      }
      if (host._smartDashboardMcpRoot && host._smartDashboardMcpRoot.unmount) {
        host._smartDashboardMcpRoot.unmount();
      } else if (api.ReactDOM.unmountComponentAtNode) {
        api.ReactDOM.unmountComponentAtNode(host);
      }
      host.remove();
      const params = new URLSearchParams(window.location.search);
      if (params.get("smart_dashboard") === "mcp") {
        window.history.replaceState({}, "", `${pluginBasePath()}/`);
      }
    }

    function McpDashboardOverlay() {
      return h(
        "div",
        { className: "sd-overlay sd-overlay-mcp" },
        h(
          "button",
          {
            className: "sd-overlay-close",
            type: "button",
            onClick: closeMcpDashboardOverlay,
            "aria-label": t("mcpAgent.close"),
          },
          "×"
        ),
        h(McpAgentPage, null)
      );
    }

    function showMcpDashboardOverlay() {
      let host = document.getElementById("smart-dashboard-mcp-overlay-root");
      if (!host) {
        host = document.createElement("div");
        host.id = "smart-dashboard-mcp-overlay-root";
        document.body.appendChild(host);
      }
      host.style.position = "fixed";
      host.style.inset = "0";
      host.style.zIndex = "3000";
      host.style.overflow = "auto";
      host.style.background = "#141414";

      window.history.pushState({}, "", `${pluginBasePath()}/?${MCP_DASHBOARD_QUERY}`);
      if (api.ReactDOM.createRoot) {
        if (!host._smartDashboardMcpRoot) {
          host._smartDashboardMcpRoot = api.ReactDOM.createRoot(host);
        }
        host._smartDashboardMcpRoot.render(h(McpDashboardOverlay, null));
      } else {
        api.ReactDOM.render(h(McpDashboardOverlay, null), host);
      }
    }

    window.smartDashboardOpen = showDashboardOverlay;
    window.smartDashboardMcpOpen = showMcpDashboardOverlay;
  }

  function isVisibleNavElement(element) {
    if (!element || element.closest("#smart-dashboard-overlay-root") || element.closest(".sd-topbar")) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const hasUsefulSize = rect.width > 40 && rect.height > 16;
    const nearTop = rect.top < 160;
    return hasUsefulSize && nearTop && style.display !== "none" && style.visibility !== "hidden";
  }

  function navigationButtonsMounted() {
    return (
      document.getElementById("smart-dashboard-nav-button") &&
      document.getElementById("smart-dashboard-mcp-nav-button")
    );
  }

  function findNavigationContainer() {
    const preferred = [
      ".top-nav .navbar-buttons",
      ".top-nav .navbar-collapse > nav",
      ".top-nav .navbar-collapse nav",
      ".top-nav nav.nav",
      ".navbar-collapse > nav",
    ];

    for (const selector of preferred) {
      const element = document.querySelector(selector);
      if (isVisibleNavElement(element)) {
        return element;
      }
    }

    const selectors = [
      ".navbar-nav",
      ".navbar",
      "nav",
      "header",
      "[class*='Navbar']",
      "[class*='navbar']",
      "[class*='TopNav']",
      "[class*='top-nav']",
    ];
    const candidates = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));

    return candidates.find((element) => isVisibleNavElement(element));
  }

  function showMcpSetupToast(message, variant) {
    let toast = document.getElementById("smart-dashboard-mcp-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "smart-dashboard-mcp-toast";
      toast.className = "sd-mcp-toast";
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.dataset.variant = variant || "info";
    toast.hidden = false;
    window.clearTimeout(showMcpSetupToast._hideTimer);
    showMcpSetupToast._hideTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 12000);
  }

  async function triggerMcpAgentSetup(triggerButton) {
    if (triggerButton) {
      triggerButton.disabled = true;
      triggerButton.dataset.busy = "1";
    }

    showMcpSetupToast(t("mcp.installing"), "info");

    try {
      const result = await runPluginModeTask(SETUP_AGENT_MODE, "Smart Dashboard MCP agent setup");
      const message = result.queued
        ? t("mcp.started", { jobId: result.job_id })
        : t("mcp.done");
      showMcpSetupToast(message, "success");
    } catch (error) {
      console.warn("[Smart Dashboard] MCP agent setup failed", error);
      showMcpSetupToast(t("mcp.failed"), "error");
    } finally {
      if (triggerButton) {
        triggerButton.disabled = false;
        delete triggerButton.dataset.busy;
      }
    }
  }

  function appendNavigationButton(target, config) {
    if (document.getElementById(config.id)) {
      return;
    }

    const button = document.createElement("button");
    button.id = config.id;
    button.type = "button";
    button.className = config.className;
    button.textContent = config.label;
    button.title = config.label;
    button.addEventListener("click", config.onClick);

    const wrapper = document.createElement("div");
    wrapper.className = "sd-nav-item sd-plugin-nav-item";
    wrapper.appendChild(button);

    if (target.tagName === "UL" || target.tagName === "OL") {
      const item = document.createElement("li");
      item.className = "sd-nav-item";
      item.appendChild(button);
      target.appendChild(item);
    } else {
      target.appendChild(wrapper);
    }
  }

  function mountNavigationButton() {
    if (navigationButtonsMounted()) {
      return true;
    }

    const target = findNavigationContainer();
    if (!target) {
      return false;
    }

    appendNavigationButton(target, {
      id: "smart-dashboard-nav-button",
      className: "sd-nav-button",
      label: t("nav.cinematic"),
      onClick: openRoute,
    });

    appendNavigationButton(target, {
      id: "smart-dashboard-mcp-nav-button",
      className: "sd-nav-button sd-nav-button-mcp",
      label: t("nav.mcp_server"),
      onClick: openMcpRoute,
    });

    return true;
  }

  function observeNavigationForButton() {
    if (window.smartDashboardNavObserver) {
      return;
    }

    let attempts = 0;
    window.smartDashboardNavObserver = new MutationObserver(() => {
      attempts += 1;
      if (mountNavigationButton() || attempts > 200) {
        window.smartDashboardNavObserver.disconnect();
        window.smartDashboardNavObserver = null;
      }
    });

    window.smartDashboardNavObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function syncNavigationLabels() {
    const cinematicLabel = document.getElementById("smart-dashboard-cinematic-label");
    if (cinematicLabel) {
      cinematicLabel.textContent = t("nav.cinematic");
    }
    const mcpLabel = document.getElementById("smart-dashboard-mcp-label");
    if (mcpLabel) {
      mcpLabel.textContent = t("nav.mcp_server");
    }

    const cinematicButton = document.getElementById("smart-dashboard-nav-button");
    if (cinematicButton) {
      cinematicButton.textContent = t("nav.cinematic");
    }
    const mcpButton = document.getElementById("smart-dashboard-mcp-nav-button");
    if (mcpButton) {
      mcpButton.textContent = t("nav.mcp_server");
    }
  }

  function registerNavigationHooks() {
    const api = window.PluginApi;
    if (!api?.Event?.addEventListener || window.smartDashboardNavHooksRegistered) {
      return;
    }

    api.Event.addEventListener("stash:location", () => {
      mountNavigationButton();
      syncNavigationLabels();
    });
    window.smartDashboardNavHooksRegistered = true;
  }

  function bootstrap() {
    try {
      // Nav buttons use DOM injection only (React patches broke MainNavbar on some Stash builds).
      mountNavigationButton();
      observeNavigationForButton();
      registerNavigationHooks();

      const getGraphqlUrl = () => `${pluginBasePath()}/graphql`;
      const start = () => {
        try {
          mountNavigationButton();
          syncNavigationLabels();
          if (window.SmartDashboardI18n) {
            window.SmartDashboardI18n.onChange(syncNavigationLabels);
          }
          handleDashboardDeepLink();
          startBackgroundServices();
        } catch (error) {
          console.error("[Smart Dashboard] start() failed:", error);
        }
      };

      if (window.SmartDashboardI18n) {
        window.SmartDashboardI18n.init({ getGraphqlUrl }).then(start).catch(start);
        return;
      }
      start();
    } catch (error) {
      console.error("[Smart Dashboard] bootstrap failed:", error);
    }
  }

  try {
    bootstrap();
  } catch (error) {
    console.error("[Smart Dashboard] plugin script failed:", error);
  }
})();
