// Sequential Image Loader — folder PNG sequencer UI.
//
// Each node loads the *next* PNG from a folder on every Queue. A global
// app.queuePrompt hook advances the (hidden) `index` widget after each
// queue, so the run that was just sent uses the current index and the
// next queue picks up the following file. A "Reset to start" button
// rewinds index to 0. A status line shows how far through the folder we
// are, refreshed from the /seqloader/list route.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "SequentialImageLoader";

function findWidget(node, name) {
    if (!node.widgets) return null;
    return node.widgets.find((w) => w.name === name);
}

function setWidget(widget, value) {
    if (!widget) return;
    widget.value = value;
    try { widget.callback?.(value); } catch (e) { /* ignore */ }
    app.graph?.setDirtyCanvas(true, true);
}

// --- Global queue hook: advance index AFTER the prompt is fully built and
//     submitted, so THIS run uses the current image and the next queue gets
//     the following one. We must await orig() first: in current ComfyUI
//     queuePrompt serializes the graph asynchronously (it awaits
//     graphToPrompt), so bumping synchronously here would land before the
//     widget value is read and the very first image would be skipped.
function installQueueHook() {
    if (app._SeqLoaderQueueHookInstalled) return;
    if (typeof app.queuePrompt !== "function") return;
    const orig = app.queuePrompt.bind(app);
    app.queuePrompt = async function (...args) {
        const result = await orig(...args); // current index is now serialized+sent
        try {
            const nodes = (app.graph && app.graph._nodes) || [];
            for (const n of nodes) {
                if (n?.type !== NODE_NAME) continue;
                if (n.mode === 2 || n.mode === 4) continue; // muted / bypassed
                const idxW = findWidget(n, "index");
                if (!idxW) continue;
                const total = (n._seqFiles || []).length;
                let next = (idxW.value | 0) + 1;
                if (total > 0) next = next % total; // wrap back to start at the end
                setWidget(idxW, next & 0x7FFFFFFF);
                updateStatus(n);
            }
        } catch (e) {
            console.warn("[SeqLoader] queue hook error (passing through)", e);
        }
        return result;
    };
    app._SeqLoaderQueueHookInstalled = true;
}

// --- Listing: ask the server which PNGs are in the folder. Cached on the
//     node as n._seqFiles so the status line can show the current name.
async function refreshFileList(node) {
    const dir = (findWidget(node, "directory")?.value || "").trim();
    const sub = !!findWidget(node, "include_subfolders")?.value;
    const filetype = findWidget(node, "filetype")?.value || "png";
    const reverse = !!findWidget(node, "reverse")?.value;
    if (!dir) {
        node._seqFiles = [];
        updateStatus(node);
        return;
    }
    try {
        const res = await api.fetchApi("/seqloader/list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                directory: dir,
                include_subfolders: sub,
                filetype,
                reverse,
            }),
        });
        const data = await res.json();
        node._seqFiles = Array.isArray(data.files) ? data.files : [];
    } catch (e) {
        node._seqFiles = [];
    }
    updateStatus(node);
}

function updateStatus(node) {
    const el = node._seqStatusEl;
    if (!el) return;
    const files = node._seqFiles || [];
    const total = files.length;
    const idx = findWidget(node, "index")?.value | 0;

    if (total === 0) {
        const ft = findWidget(node, "filetype")?.value || "png";
        const label = ft === "all" ? "image" : ft.toUpperCase();
        const dir = (findWidget(node, "directory")?.value || "").trim();
        const hint = dir ? "Check the path / filetype, or Rescan."
                         : "Browse or paste a folder path above.";
        el.innerHTML = `<span style="color:#e7a">No ${label} files found.</span> `
            + `<span style="color:#888">${hint}</span>`;
        return;
    }
    const pos = ((idx % total) + total) % total; // wrap, handle negatives
    const name = files[pos] || "";
    el.innerHTML =
        `<span style="color:#9cf;font-weight:bold">Next: ${pos + 1} / ${total}</span>`
        + `<span style="color:#888"> &middot; </span>`
        + `<span style="color:#ddd" title="${name}">${name}</span>`;
}

function attachUI(node) {
    // Hide the mechanical index widget (driven by hook / buttons).
    const idxW = findWidget(node, "index");
    if (idxW) {
        idxW.hidden = true;
        idxW.computeSize = () => [0, -4];
        idxW.type = "hidden_seq_index";
    }

    const container = document.createElement("div");
    container.style.cssText =
        "display:flex; flex-direction:column; gap:6px; padding:6px 6px 4px; "
        + "box-sizing:border-box; width:100%;";

    // Status line.
    const status = document.createElement("div");
    status.style.cssText =
        "font-size:11px; line-height:1.4; padding:5px 8px; border-radius:4px; "
        + "background:#1a1a1a; border:1px solid #444; "
        + "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    container.appendChild(status);
    node._seqStatusEl = status;

    // Browse button (primary way to set the folder). Full width above the
    // navigation row.
    const browseBtn = makeButton("📁 Browse for folder…", "browse", () => {
        openFolderPicker(node);
    });
    browseBtn.style.flex = "1 1 100%";
    container.appendChild(browseBtn);

    // Button row.
    const row = document.createElement("div");
    row.style.cssText = "display:flex; flex-direction:row; flex-wrap:wrap; gap:5px;";

    row.appendChild(makeButton("⏮ Reset to start", "reset", () => {
        setWidget(idxW, 0);
        updateStatus(node);
    }));
    row.appendChild(makeButton("‹ Prev", "neutral", () => {
        const cur = idxW?.value | 0;
        setWidget(idxW, Math.max(0, cur - 1));
        updateStatus(node);
    }));
    row.appendChild(makeButton("Next ›", "neutral", () => {
        setWidget(idxW, (idxW?.value | 0) + 1);
        updateStatus(node);
    }));
    row.appendChild(makeButton("↻ Rescan", "scan", () => {
        refreshFileList(node);
    }));
    container.appendChild(row);

    node.addDOMWidget("seqloader_ui", "seqloader_panel", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 124,
    });

    // Re-scan whenever the folder path, subfolder toggle, filetype, or
    // direction changes.
    for (const wn of ["directory", "include_subfolders", "filetype", "reverse"]) {
        const w = findWidget(node, wn);
        if (!w) continue;
        const origCb = w.callback;
        w.callback = (v, ...rest) => {
            try { origCb?.call(w, v, ...rest); } catch (e) { /* ignore */ }
            refreshFileList(node);
        };
    }

    // Initial populate (deferred so the widget value restore can land first).
    setTimeout(() => refreshFileList(node), 50);
}

function makeButton(label, kind, onClick) {
    const themes = {
        reset: { fg: "#ffe0d0", bg: "rgba(70,50,50,0.95)", border: "rgba(220,140,100,0.9)" },
        scan: { fg: "#d2f3e2", bg: "rgba(48,66,60,0.95)", border: "rgba(110,200,160,0.9)" },
        browse: { fg: "#dde7ff", bg: "rgba(48,58,78,0.95)", border: "rgba(120,160,230,0.9)" },
        neutral: { fg: "#ccc", bg: "#2a2a2a", border: "#555" },
    };
    const th = themes[kind] || themes.neutral;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    btn.style.cssText =
        `cursor:pointer; padding:4px 9px; font-size:11px; font-weight:bold; `
        + `border:1px solid ${th.border}; border-radius:3px; background:${th.bg}; `
        + `color:${th.fg}; user-select:none; flex:1 1 auto;`;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return btn;
}

// --- Server-side folder picker. Browsers can't hand back a real absolute
//     path, and the images live on the ComfyUI server anyway, so we browse
//     the server's filesystem via /seqloader/browse and write the chosen
//     path into the `directory` widget.
function openFolderPicker(node) {
    const dirW = findWidget(node, "directory");
    const filetype = findWidget(node, "filetype")?.value || "png";

    const backdrop = document.createElement("div");
    backdrop.style.cssText =
        "position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.55); "
        + "display:flex; align-items:center; justify-content:center;";

    const modal = document.createElement("div");
    modal.style.cssText =
        "width:min(560px, 92vw); max-height:80vh; display:flex; "
        + "flex-direction:column; background:#232323; color:#ddd; "
        + "border:1px solid #555; border-radius:8px; "
        + "box-shadow:0 10px 40px rgba(0,0,0,0.6); font-size:13px; "
        + "font-family:sans-serif; overflow:hidden;";
    backdrop.appendChild(modal);

    // Header.
    const header = document.createElement("div");
    header.style.cssText =
        "padding:10px 12px; border-bottom:1px solid #444; font-weight:bold; "
        + "background:#1c1c1c;";
    header.textContent = "📁 Select image folder";
    modal.appendChild(header);

    // Path input + Up button.
    const pathRow = document.createElement("div");
    pathRow.style.cssText = "display:flex; gap:6px; padding:10px 12px 6px;";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.placeholder = "Type or paste a path, then Enter";
    pathInput.style.cssText =
        "flex:1 1 auto; min-width:0; background:#141414; color:#ddd; "
        + "border:1px solid #555; border-radius:4px; padding:5px 8px; font-size:12px;";
    const upBtn = makeButton("⬆ Up", "neutral", () => navigate(state.parent ?? ""));
    upBtn.style.flex = "0 0 auto";
    pathRow.appendChild(pathInput);
    pathRow.appendChild(upBtn);
    modal.appendChild(pathRow);

    // Folder list.
    const listWrap = document.createElement("div");
    listWrap.style.cssText =
        "flex:1 1 auto; overflow-y:auto; margin:4px 12px; padding:4px; "
        + "background:#181818; border:1px solid #3a3a3a; border-radius:4px; "
        + "min-height:160px;";
    modal.appendChild(listWrap);

    // Footer.
    const footer = document.createElement("div");
    footer.style.cssText =
        "display:flex; align-items:center; gap:8px; padding:10px 12px; "
        + "border-top:1px solid #444; background:#1c1c1c;";
    const countEl = document.createElement("span");
    countEl.style.cssText = "flex:1 1 auto; font-size:12px; color:#9cf;";
    const useBtn = makeButton("✓ Use this folder", "scan", () => {
        const chosen = (state.cwd || pathInput.value || "").trim();
        if (!chosen) return;
        setWidget(dirW, chosen);
        refreshFileList(node);
        close();
    });
    useBtn.style.flex = "0 0 auto";
    const cancelBtn = makeButton("Cancel", "neutral", () => close());
    cancelBtn.style.flex = "0 0 auto";
    footer.appendChild(countEl);
    footer.appendChild(cancelBtn);
    footer.appendChild(useBtn);
    modal.appendChild(footer);

    const state = { cwd: "", parent: null };

    function close() {
        document.removeEventListener("keydown", onKey, true);
        backdrop.remove();
    }
    function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", (e) => {
        if (e.target === backdrop) close();
    });

    function renderList(data) {
        listWrap.innerHTML = "";
        const dirs = data.dirs || [];
        if (data.is_roots) {
            const hint = document.createElement("div");
            hint.style.cssText = "padding:6px 8px; color:#888; font-size:11px;";
            hint.textContent = "Drives / roots — click to open:";
            listWrap.appendChild(hint);
        }
        if (dirs.length === 0 && !data.is_roots) {
            const empty = document.createElement("div");
            empty.style.cssText = "padding:8px; color:#888;";
            empty.textContent = "(no subfolders here)";
            listWrap.appendChild(empty);
        }
        for (const d of dirs) {
            const item = document.createElement("div");
            item.style.cssText =
                "padding:5px 9px; border-radius:3px; cursor:pointer; "
                + "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
            item.textContent = "📁 " + d.name;
            item.title = d.path;
            item.addEventListener("mouseenter", () => { item.style.background = "#2e3a52"; });
            item.addEventListener("mouseleave", () => { item.style.background = "transparent"; });
            item.addEventListener("click", () => navigate(d.path));
            listWrap.appendChild(item);
        }
    }

    async function navigate(path) {
        try {
            const res = await api.fetchApi("/seqloader/browse", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: path || "", filetype }),
            });
            const data = await res.json();
            state.cwd = data.cwd || "";
            state.parent = data.parent;
            pathInput.value = state.cwd;
            upBtn.disabled = data.is_roots;
            upBtn.style.opacity = data.is_roots ? "0.5" : "1";
            const label = filetype === "all" ? "image" : filetype.toUpperCase();
            countEl.textContent = state.cwd
                ? `${data.image_count} ${label} file(s) in this folder`
                : "";
            useBtn.style.opacity = state.cwd ? "1" : "0.5";
            renderList(data);
        } catch (e) {
            countEl.textContent = "Could not read that path.";
        }
    }

    pathInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            navigate(pathInput.value.trim());
        }
    });

    document.body.appendChild(backdrop);
    // Start at the currently-set folder (or its parent if it has no subdirs),
    // falling back to the roots list.
    navigate((dirW?.value || "").trim());
}

app.registerExtension({
    name: "SequentialImageLoader.UI",

    async setup() {
        installQueueHook();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            attachUI(this);
            // Grow to fit the directory/subfolder widgets + status + button
            // row. computeSize() floors to the real content height (the
            // hidden index widget claims none); then enforce our own minimum.
            const fit = this.computeSize ? this.computeSize() : [0, 0];
            const min = [320, Math.max(360, fit[1])];
            const w = Math.max(this.size[0], min[0]);
            const h = Math.max(this.size[1], min[1]);
            if (typeof this.setSize === "function") this.setSize([w, h]);
            else { this.size[0] = w; this.size[1] = h; }
        };

        // Re-sync after a saved workflow restores widget values.
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            setTimeout(() => refreshFileList(this), 50);
        };

        // Reflect what was actually loaded after a run.
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origOnExecuted?.apply(this, arguments);
            try {
                const info = message?.seqloader?.[0];
                if (info && this._seqStatusEl) {
                    // Keep file count fresh; status recompute happens via hook.
                    if (typeof info.total === "number" && this._seqFiles
                        && this._seqFiles.length !== info.total) {
                        refreshFileList(this);
                    }
                }
            } catch (e) { /* ignore */ }
        };
    },
});
