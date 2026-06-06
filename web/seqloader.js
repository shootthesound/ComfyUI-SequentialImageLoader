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
        el.innerHTML = `<span style="color:#e7a">No PNGs found.</span> `
            + `<span style="color:#888">Paste a folder path above.</span>`;
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
        getMinHeight: () => 96,
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
            const min = [320, Math.max(330, fit[1])];
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
