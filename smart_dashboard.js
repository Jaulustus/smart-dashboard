(function () {
  "use strict";

  const PLUGIN_ID = "smart_dashboard";
  const DASHBOARD_QUERY = "smart_dashboard=cinematic";
  const ROUTE_LABEL = "Stash Cinematic";
  const MAX_REGISTER_ATTEMPTS = 80;
  let registerAttempts = 0;

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

  function openRoute() {
    if (typeof window.smartDashboardOpen === "function") {
      window.smartDashboardOpen();
      return;
    }

    window.history.pushState({}, "", `${pluginBasePath()}/?${DASHBOARD_QUERY}`);
  }

  function handleDashboardDeepLink() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("smart_dashboard") === "cinematic") {
      window.smartDashboardOpen();
    }
  }

  async function fetchRecommendations() {
    const cacheBust = `t=${Date.now()}`;
    const candidates = [
      `${assetUrl("recommendations.json")}?${cacheBust}`,
      `/plugin/${PLUGIN_ID}/assets/recommendations.json?${cacheBust}`,
    ];

    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = await response.json();
        return enrichSceneTitles(data);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("recommendations.json konnte nicht geladen werden.");
  }

  function isUntitled(value) {
    return !value || String(value).trim().toLowerCase() === "untitled";
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
          scenes {
            id
            title
            files { path }
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
        variables: { filter: { page: 1, per_page: 1000 } },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message || String(error)).join("; "));
    }

    const scenes = payload.data && payload.data.findScenes ? payload.data.findScenes.scenes || [] : [];
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
      reason: scene.reason || "",
      resolution: scene.resolution || scene.quality || "",
      tags,
      performers,
      studio: scene.studio || "",
      playCount: scene.play_count || 0,
      lastPlayedAt: scene.last_played_at || "",
      stashUrl: scene.stash_url || `${stashBaseUrl.replace(/\/$/, "")}/scenes/${id}`,
    };
  }

  function ratingText(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
      return "Unrated";
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
          h("div", { className: "sd-card-meta" }, meta || `${scene.playCount} plays`),
          h("p", { className: "sd-card-reason" }, scene.reason || "Open in Stash"),
          h(
            "div",
            { className: "sd-card-tags" },
            scene.tags.slice(0, 4).map((tag) => h(Pill, { key: tag }, tag))
          )
        )
      );
    }

    function Row(props) {
      if (!props.scenes.length) {
        return null;
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
          h("span", { className: "sd-row-count" }, `${props.scenes.length} scenes`)
        ),
        h(
          "div",
          { className: "sd-rail" },
          props.scenes.map((scene, index) =>
            h(SceneCard, {
              key: `${props.id}-${scene.id || index}`,
              scene,
              stashBaseUrl: props.stashBaseUrl,
            })
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
          h("div", { className: "sd-kicker" }, "Featured Scene"),
          h("h1", null, scene ? scene.title : ROUTE_LABEL),
          h(
            "p",
            null,
            scene
              ? scene.reason || "A standout recommendation selected from your local Stash library."
              : "Generate recommendations to unlock your cinematic dashboard."
          ),
          h("div", { className: "sd-hero-tags" }, tags.map((tag) => h(Pill, { key: tag }, tag))),
          h(
            "div",
            { className: "sd-hero-actions" },
            scene
              ? h(
                  "a",
                  { className: "sd-button sd-button-primary", href: scene.stashUrl, target: "_blank", rel: "noopener noreferrer" },
                  "Play"
                )
              : null,
            h("button", { className: "sd-button sd-button-secondary", type: "button", onClick: () => window.location.reload() }, "Refresh")
          )
        )
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
            message: "Bitte gib eine gueltige Dauer ein, z.B. 0:30, 1:15 oder 90.",
          });
          return;
        }

        const confirmed = window.confirm(
          `This removes all scenes shorter than ${numericSeconds} seconds (${durationInput}) from Stash only.\n\n` +
            `Die Videodateien im Ordner bleiben erhalten. Die Szenen erscheinen danach nicht mehr in Stash.\n\n` +
            "Continue / Fortfahren?"
        );
        if (!confirmed) {
          return;
        }

        setBusy(true);
        setStatus({ type: "info", message: "Cleanup wird ausgefuehrt..." });
        try {
          const result = await runCleanupTask(numericSeconds);
          const output = result && (result.output || result.result || result);
          setStatus({
            type: "success",
            message:
              typeof output === "string"
                ? output
                : "Cleanup abgeschlossen. Pruefe die Stash-Logs fuer Details.",
          });
        } catch (error) {
          setStatus({
            type: "error",
            message: `Cleanup konnte nicht gestartet werden: ${error.message || error}`,
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
          h("span", { className: "sd-tools-kicker" }, "Library Tools"),
          h("h2", null, "Short-Video Cleanup"),
          h(
            "p",
            null,
            "Remove scenes below a custom duration from Stash. The original video files stay on disk."
          )
        ),
        h(
          "div",
          { className: "sd-cleanup-card" },
          h(
            "label",
            { className: "sd-cleanup-label", htmlFor: "sd-cleanup-seconds" },
            "Delete videos shorter than (minutes:seconds):",
            h("span", null, "Videos kürzer als (Minuten:Sekunden) löschen:")
          ),
          h(
            "div",
            { className: "sd-cleanup-controls" },
            h("input", {
              id: "sd-cleanup-seconds",
              className: isValid ? "sd-cleanup-input" : "sd-cleanup-input sd-cleanup-input-invalid",
              type: "text",
              inputMode: "numeric",
              placeholder: "0:30 oder 90",
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
              busy ? "Starting..." : "Purge / Löschen"
            )
          ),
          h(
            "p",
            { className: "sd-cleanup-warning" },
            "Stash cleanup only: matching scene records are removed with sceneDestroy(delete_file: false). Examples: 0:30, 1:15, 90."
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

    function DashboardPage() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null });

      React.useEffect(() => {
        let active = true;
        fetchRecommendations()
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

      if (state.loading) {
        return h(
          "div",
          { className: "sd-shell sd-centered" },
          h("div", { className: "sd-loader" }),
          h("p", null, "Loading Stash Cinematic...")
        );
      }

      if (state.error) {
        return h(
          "div",
          { className: "sd-shell" },
          h(
            "div",
            { className: "sd-topbar" },
            h("div", { className: "sd-logo" }, h("span", null, "Stash"), " Cinematic"),
            h("div", { className: "sd-updated" }, "Library tools available")
          ),
          h(
            "div",
            { className: "sd-centered sd-error-panel" },
            h("div", { className: "sd-empty-icon" }, "!"),
            h("h1", null, "recommendations.json not found"),
            h("p", null, "Run the 'Update Dashboard Recommendations' task to fill the cinematic rows. Library Tools are still available below."),
            h("pre", null, String(state.error.message || state.error))
          ),
          h(LibraryTools, null)
        );
      }

      const data = state.data || {};
      const stashBaseUrl = data.stash_base_url || window.location.origin;
      const featured = chooseFeatured(data);
      const rows = [
        ["library-spotlight", "Library Spotlight", "A reliable fallback row from your local scene library.", data.library_spotlight || [], "▣"],
        ["forgotten-gems", "Forgotten Gems", "Highly rated scenes waiting for a comeback.", data.forgotten_gems || [], "◆"],
        ["top-rated", "Top Rated", "The highest-rated scenes in your library.", data.top_rated || [], "★"],
        ["recently-watched", "Recently Watched", "Continue the mood from your latest sessions.", data.recently_watched || [], "↺"],
        ["smart-suggestions", "Smart Suggestions", "Generated from ratings, tags, studios, and watch history.", data.smart_suggestions || [], "✦"],
      ];
      const totalScenes = rows.reduce((sum, row) => sum + row[3].length, 0);
      const totalUniqueScenes = new Set(
        rows.flatMap((row) => row[3].map((scene) => String(scene.id || ""))).filter(Boolean)
      ).size;

      return h(
        "div",
        { className: "sd-shell" },
        h(
          "div",
          { className: "sd-topbar" },
          h("div", { className: "sd-logo" }, h("span", null, "Stash"), " Cinematic"),
          h(
            "div",
            { className: "sd-updated" },
            data.generated_at
              ? `Updated ${formatDate(data.generated_at)} • ${totalUniqueScenes} scenes`
              : `${totalUniqueScenes} scenes`
          )
        ),
        h(Hero, { scene: featured, stashBaseUrl }),
        h(
          "section",
          { className: "sd-stats" },
          h(StatCard, { icon: "▣", label: "Library Spotlight", value: (data.library_spotlight || []).length }),
          h(StatCard, { icon: "◆", label: "Forgotten Gems", value: (data.forgotten_gems || []).length }),
          h(StatCard, { icon: "★", label: "Top Rated", value: (data.top_rated || []).length }),
          h(StatCard, { icon: "✦", label: "Smart Suggestions", value: (data.smart_suggestions || []).length })
        ),
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
                })
              )
            )
          : h(
              "div",
              { className: "sd-empty" },
              h("div", { className: "sd-empty-icon" }, "▶"),
              h("h2", null, "No recommendation rows yet"),
              h("p", null, "Run the recommendation task in Stash and reload this page.")
            ),
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
            "aria-label": "Close Stash Cinematic",
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

    window.smartDashboardOpen = showDashboardOverlay;

    mountNavigationButton();
    observeNavigationForButton();
    handleDashboardDeepLink();
  }

  function findNavigationContainer() {
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

    return candidates.find((element) => {
      if (element.closest("#smart-dashboard-overlay-root") || element.closest(".sd-topbar")) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      const hasUsefulSize = rect.width > 120 && rect.height > 20;
      const nearTop = rect.top < 140;
      const isVisible = window.getComputedStyle(element).display !== "none";
      return hasUsefulSize && nearTop && isVisible;
    });
  }

  function mountNavigationButton() {
    if (document.getElementById("smart-dashboard-nav-button")) {
      return true;
    }

    const target = findNavigationContainer();
    if (!target) {
      return false;
    }

    const button = document.createElement("button");
    button.id = "smart-dashboard-nav-button";
    button.type = "button";
    button.className = "sd-nav-button";
    button.textContent = "Cinematic";
    button.addEventListener("click", openRoute);

    if (target.tagName === "UL" || target.tagName === "OL") {
      const item = document.createElement("li");
      item.className = "sd-nav-item";
      item.appendChild(button);
      target.appendChild(item);
    } else {
      target.appendChild(button);
    }

    return true;
  }

  function observeNavigationForButton() {
    if (window.smartDashboardNavObserver) {
      return;
    }

    let attempts = 0;
    window.smartDashboardNavObserver = new MutationObserver(() => {
      attempts += 1;
      if (mountNavigationButton() || attempts > 80) {
        window.smartDashboardNavObserver.disconnect();
        window.smartDashboardNavObserver = null;
      }
    });

    window.smartDashboardNavObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  registerPlugin();
})();
