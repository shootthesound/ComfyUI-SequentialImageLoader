// Sequential Image Loader — folder image sequencer UI.
//
// Each node loads the *next* image from a folder on every Queue. A global
// app.queuePrompt hook advances the (hidden) `index` widget after each
// queue, so the run that was just sent uses the current index and the
// next queue picks up the following file. A "Reset to start" button
// rewinds index to 0. A status line shows how far through the folder we
// are, refreshed from the /seqloader/list route. "▶ Queue all" chains
// runs automatically (one per image) and stops after the last file.
// Thumbnails show Current (what the last run loaded) and Next (upcoming).

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

// --- Remember the last folder used, so a freshly-added node pre-fills with
//     it (persists across sessions via localStorage; saved workflows still
//     keep their own per-node path).
const LAST_DIR_KEY = "SeqLoader.lastDir";
function saveLastDir(dir) {
    try { if (dir) localStorage.setItem(LAST_DIR_KEY, dir); } catch (e) { /* ignore */ }
}
function loadLastDir() {
    try { return localStorage.getItem(LAST_DIR_KEY) || ""; } catch (e) { return ""; }
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
                if (n._seqHold) continue; // paused: keep re-emitting the held frame
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
    // Sequence number so a slow response can't clobber a newer one (e.g.
    // rapid filetype toggles, or typing a path while a big folder scans).
    const seq = node._seqListReq = (node._seqListReq || 0) + 1;
    const dir = (findWidget(node, "directory")?.value || "").trim();
    const sub = !!findWidget(node, "include_subfolders")?.value;
    const filetype = findWidget(node, "filetype")?.value || "png";
    const reverse = !!findWidget(node, "reverse")?.value;
    if (!dir) {
        node._seqFiles = [];
        node._seqPaths = [];
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
        if (node._seqListReq !== seq) return;   // superseded by a newer scan
        node._seqFiles = Array.isArray(data.files) ? data.files : [];
        node._seqPaths = Array.isArray(data.paths) ? data.paths : [];
    } catch (e) {
        if (node._seqListReq !== seq) return;
        node._seqFiles = [];
        node._seqPaths = [];
    }
    updateStatus(node);
}

// --- Thumbnail previews of the current + next image. Fetched from the
//     server (the files live there) as blobs so base-path / auth are
//     handled by api.fetchApi. A new request for a different frame ABORTS
//     the one in flight, so spamming Prev/Next can never leave a slow load
//     queued ahead of the frame you actually want.
async function setThumb(img, path) {
    if (!img) return;
    if (!path) {
        if (img._abort) { img._abort.abort(); img._abort = null; }
        img._path = "";
        if (img._url) { URL.revokeObjectURL(img._url); img._url = null; }
        img.removeAttribute("src");
        return;
    }
    if (img._path === path) return;        // already showing / fetching this one
    if (img._abort) { img._abort.abort(); img._abort = null; }  // cancel stale load
    img._path = path;
    const controller = (typeof AbortController !== "undefined")
        ? new AbortController() : null;
    img._abort = controller;
    try {
        const res = await api.fetchApi(
            "/seqloader/thumb?path=" + encodeURIComponent(path),
            controller ? { signal: controller.signal } : undefined);
        if (!res.ok) { img.removeAttribute("src"); return; }
        const blob = await res.blob();
        if (img._path !== path) return;   // a newer request superseded this one
        if (img._url) URL.revokeObjectURL(img._url);
        img._url = URL.createObjectURL(blob);
        img.src = img._url;
    } catch (e) {
        // AbortError is expected when a newer frame supersedes this load.
        if (e?.name !== "AbortError") img.removeAttribute("src");
    } finally {
        if (img._abort === controller) img._abort = null;
    }
}

function updatePreviews(node) {
    const paths = node._seqPaths || [];
    const total = paths.length;
    const curImg = node._seqCurrentImg, nxtImg = node._seqNextImg;
    const baseName = (p) => (p || "").split(/[\\/]/).pop();
    // Left cell: the image the last run actually loaded (set from the
    // execution message) — empty until something has been queued.
    const curPath = node._seqCurrentPath || "";
    if (curImg) curImg.title = baseName(curPath);
    // Right cell: the image the next Queue will load.
    let nextPath = "";
    if (total > 0) {
        const idx = findWidget(node, "index")?.value | 0;
        const pos = ((idx % total) + total) % total;
        nextPath = paths[pos];
    }
    if (nxtImg) nxtImg.title = baseName(nextPath);
    // Titles update instantly; defer the thumbnail fetches a touch so rapid
    // Prev/Next clicks coalesce into a single load of the final frame.
    clearTimeout(node._seqThumbTimer);
    node._seqThumbTimer = setTimeout(() => {
        setThumb(curImg, curPath);
        setThumb(nxtImg, nextPath);
    }, 80);
}

// Filenames go into innerHTML — escape them so a file named e.g.
// "<img src=x onerror=…>.png" can't inject markup into the status line.
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function updateStatus(node) {
    updatePreviews(node);
    const el = node._seqStatusEl;
    if (!el) return;
    const files = node._seqFiles || [];
    const total = files.length;
    const idx = findWidget(node, "index")?.value | 0;

    if (total === 0) {
        el.style.background = "#1a1a1a";
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
    // Progress fill behind the text: left edge = first file, right = last.
    const pct = total > 1 ? (pos / (total - 1)) * 100 : 100;
    el.style.background = "linear-gradient(to right, "
        + `rgba(60,110,180,0.55) ${pct}%, #1a1a1a ${pct}%)`;
    const safe = escapeHtml(name);
    el.innerHTML =
        `<span style="color:#9cf;font-weight:bold">Next: ${pos + 1} / ${total}</span>`
        + `<span style="color:#888"> &middot; </span>`
        + `<span style="color:#ddd" title="${safe}">${safe}</span>`;
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
        "display:flex; flex-direction:column; gap:6px; padding:6px; "
        + "box-sizing:border-box; width:100%;";

    // Status line.
    const status = document.createElement("div");
    status.style.cssText =
        "font-size:11px; line-height:1.4; padding:5px 8px; border-radius:4px; "
        + "background:#1a1a1a; border:1px solid #444; "
        + "white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    container.appendChild(status);
    node._seqStatusEl = status;

    // Make the status box a scrubber: click to jump anywhere in the folder,
    // or click-drag left/right to scrub. The box fills to show position.
    status.style.cursor = "ew-resize";
    status.title = "Click to jump • drag left/right to scrub";
    const scrubTo = (clientX) => {
        if (node._seqHold) return;          // disabled while paused
        const total = (node._seqPaths || []).length;
        if (total <= 1) return;
        const idxW = findWidget(node, "index");
        if (!idxW) return;
        const rect = status.getBoundingClientRect();
        let frac = (clientX - rect.left) / Math.max(1, rect.width);
        frac = Math.max(0, Math.min(1, frac));
        const pos = Math.round(frac * (total - 1));
        if ((((idxW.value | 0) % total) + total) % total !== pos) {
            setWidget(idxW, pos);
            updateStatus(node);
        }
    };
    status.addEventListener("pointerdown", (e) => {
        if (node._seqHold) return;
        if ((node._seqPaths || []).length <= 1) return;
        e.preventDefault();
        e.stopPropagation();
        status._scrubbing = true;
        try { status.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        scrubTo(e.clientX);
    });
    status.addEventListener("pointermove", (e) => {
        if (!status._scrubbing) return;
        e.preventDefault();
        e.stopPropagation();
        scrubTo(e.clientX);
    });
    const endScrub = (e) => {
        if (!status._scrubbing) return;
        status._scrubbing = false;
        try { status.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    };
    status.addEventListener("pointerup", endScrub);
    status.addEventListener("pointercancel", endScrub);

    // Browse button (primary way to set the folder). Full width above the
    // navigation row.
    const browseBtn = makeButton("📁 Browse for folder…", "browse", () => {
        openFolderPicker(node);
    });
    // The column container stretches children to full width by default.
    container.appendChild(browseBtn);

    // Navigation row.
    const row = document.createElement("div");
    row.style.cssText = "display:flex; flex-direction:row; flex-wrap:wrap; gap:5px;";

    const resetBtn = makeButton("⏮ Reset to start", "reset", () => {
        setWidget(idxW, 0);
        updateStatus(node);
    });
    const prevBtn = makeButton("‹ Prev", "neutral", () => {
        const cur = idxW?.value | 0;
        setWidget(idxW, Math.max(0, cur - 1));
        updateStatus(node);
    });
    const nextBtn = makeButton("Next ›", "neutral", () => {
        setWidget(idxW, (idxW?.value | 0) + 1);
        updateStatus(node);
    });
    row.appendChild(resetBtn);
    row.appendChild(prevBtn);
    row.appendChild(nextBtn);
    container.appendChild(row);

    // Hold row — pause on the last or next image. Below the nav buttons,
    // above Rescan.
    const holdRow = document.createElement("div");
    holdRow.style.cssText = "display:flex; flex-direction:row; gap:5px;";
    const holdLastBtn = makeButton("⏸ Hold last", "hold", () => {
        if (node._seqHold) resumeHold(node);
        else enterHold(node, "last");
    });
    const holdNextBtn = makeButton("⏸ Hold next", "hold", () => {
        if (node._seqHold) resumeHold(node);
        else enterHold(node, "next");
    });
    holdRow.appendChild(holdLastBtn);
    holdRow.appendChild(holdNextBtn);
    container.appendChild(holdRow);

    // Auto-queue + Rescan row. "Queue all" queues the remaining images one
    // after another — each run triggers the next — and stops by itself after
    // the last file (unlike ComfyUI's auto-queue, which loops forever).
    const rescanRow = document.createElement("div");
    rescanRow.style.cssText = "display:flex; flex-direction:row; gap:5px;";
    const autoBtn = makeButton("▶ Queue all", "auto", () => {
        if (node._seqHold) return;
        if (node._seqAuto) {            // acts as a Stop while running
            node._seqAuto = false;
            updateAutoUI(node);
            return;
        }
        if ((node._seqPaths || []).length === 0) return;
        node._seqAuto = true;
        updateAutoUI(node);
        app.queuePrompt(0, 1);
    });
    autoBtn.title = "Queue every remaining image, one run after another, "
        + "then stop after the last file.";
    const rescanBtn = makeButton("↻ Rescan", "scan", () => {
        refreshFileList(node);
    });
    rescanRow.appendChild(autoBtn);
    rescanRow.appendChild(rescanBtn);
    container.appendChild(rescanRow);

    node._seqBtns = {
        browse: browseBtn, holdLast: holdLastBtn, holdNext: holdNextBtn,
        reset: resetBtn, prev: prevBtn, next: nextBtn, rescan: rescanBtn,
        auto: autoBtn,
    };

    // Image previews at the bottom: Current (what the last run loaded —
    // empty until something has been queued) and Next (what the next Queue
    // will load).
    const preview = document.createElement("div");
    preview.style.cssText = "display:flex; gap:6px; margin-top:2px;";
    const makeCell = (labelText) => {
        const cell = document.createElement("div");
        cell.style.cssText =
            "flex:1 1 0; min-width:0; display:flex; flex-direction:column; gap:3px;";
        const lab = document.createElement("div");
        lab.style.cssText =
            "font-size:10px; color:#9cf; text-align:center; white-space:nowrap; "
            + "overflow:hidden; text-overflow:ellipsis;";
        lab.textContent = labelText;
        const img = document.createElement("img");
        img.style.cssText =
            "width:100%; height:96px; object-fit:contain; background:#111; "
            + "border:1px solid #3a3a3a; border-radius:4px;";
        cell.appendChild(lab);
        cell.appendChild(img);
        return { cell, lab, img };
    };
    const currentCell = makeCell("Current");
    const nextCell = makeCell("Next");
    preview.appendChild(currentCell.cell);
    preview.appendChild(nextCell.cell);
    container.appendChild(preview);
    node._seqCurrentImg = currentCell.img;
    node._seqNextImg = nextCell.img;

    // Attach as a DOM widget so LiteGraph manages its layout. The panel is
    // status + browse + nav row + hold row + rescan row (~28px each) plus a
    // ~115px preview row (two 96px thumbnails with labels). A constant floor
    // of 306 fits the content without clipping or leaving a gap.
    const widget = node.addDOMWidget("seqloader_ui", "seqloader_panel", container, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 306,
    });

    // Make the panel fill the node's full width: define `width` as a getter
    // that always returns the live node width, so LiteGraph's wrapper spans
    // the whole node instead of pinning to a narrow default.
    try {
        Object.defineProperty(widget, "width", {
            configurable: true,
            enumerable: true,
            get() { return node.size ? node.size[0] : undefined; },
            set(_v) { /* ignore — width is derived from the node */ },
        });
    } catch (e) { /* ignore */ }

    // Re-scan whenever the folder path, subfolder toggle, filetype, or
    // direction changes. Remember the folder path for next time.
    for (const wn of ["directory", "include_subfolders", "filetype", "reverse"]) {
        const w = findWidget(node, wn);
        if (!w) continue;
        const origCb = w.callback;
        w.callback = (v, ...rest) => {
            try { origCb?.call(w, v, ...rest); } catch (e) { /* ignore */ }
            if (wn === "directory") saveLastDir((v || "").trim());
            refreshFileList(node);
        };
    }

    updateHoldUI(node);

    // Pre-fill a brand-new (empty) node with the last folder used. A
    // workflow-loaded node has its own saved path restored later by
    // onConfigure, so this only affects fresh nodes.
    const dirW = findWidget(node, "directory");
    if (dirW && !((dirW.value || "").trim())) {
        const last = loadLastDir();
        if (last) setWidget(dirW, last);
    }

    // Initial populate (deferred so the widget value restore can land first).
    setTimeout(() => refreshFileList(node), 50);
}

const THEMES = {
    reset: { fg: "#ffe0d0", bg: "rgba(70,50,50,0.95)", border: "rgba(220,140,100,0.9)" },
    scan: { fg: "#d2f3e2", bg: "rgba(48,66,60,0.95)", border: "rgba(110,200,160,0.9)" },
    browse: { fg: "#dde7ff", bg: "rgba(48,58,78,0.95)", border: "rgba(120,160,230,0.9)" },
    hold: { fg: "#ffe9c2", bg: "rgba(74,62,40,0.95)", border: "rgba(220,180,110,0.9)" },
    resume: { fg: "#d2f3e2", bg: "rgba(40,72,56,0.95)", border: "rgba(110,210,160,0.95)" },
    auto: { fg: "#e6dcff", bg: "rgba(56,48,80,0.95)", border: "rgba(160,130,230,0.9)" },
    neutral: { fg: "#ccc", bg: "#2a2a2a", border: "#555" },
};

function setButtonTheme(btn, kind) {
    const th = THEMES[kind] || THEMES.neutral;
    btn.style.border = `1px solid ${th.border}`;
    btn.style.background = th.bg;
    btn.style.color = th.fg;
}

function setEnabled(btn, on) {
    if (!btn) return;
    btn.disabled = !on;            // native disabled also blocks the click event
    btn.style.opacity = on ? "1" : "0.4";
    btn.style.cursor = on ? "pointer" : "not-allowed";
}

function makeButton(label, kind, onClick) {
    const th = THEMES[kind] || THEMES.neutral;
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
        if (btn.disabled) return;
        onClick();
    });
    return btn;
}

// --- Auto-queue ("Queue all"): after each successful run, queue the next
//     image automatically until the LAST file in the folder has been done,
//     then stop — no endless wrap-around like ComfyUI's built-in auto-queue.
//     The stop decision uses the index/total the run *actually executed with*
//     (reported via the node's ui message), not the frontend widget, so
//     scrubbing mid-run can't confuse it.

function seqNodes() {
    return ((app.graph && app.graph._nodes) || [])
        .filter((n) => n?.type === NODE_NAME);
}

function updateAutoUI(node) {
    const btn = node._seqBtns?.auto;
    if (!btn) return;
    if (node._seqAuto) {
        btn.textContent = "■ Stop queueing";
        setButtonTheme(btn, "reset");
    } else {
        btn.textContent = "▶ Queue all";
        setButtonTheme(btn, "auto");
    }
}

function stopAllAuto() {
    for (const n of seqNodes()) {
        if (n._seqAuto) {
            n._seqAuto = false;
            updateAutoUI(n);
        }
    }
}

function installExecutionHooks() {
    if (app._SeqLoaderExecHooksInstalled) return;
    api.addEventListener("execution_success", () => {
        let queueMore = false;
        for (const n of seqNodes()) {
            if (!n._seqAuto || !n._seqRanFlag) continue;
            n._seqRanFlag = false;   // consumed — set again on the next run
            const pos = n._seqLastExecPos, total = n._seqLastExecTotal;
            if (typeof pos === "number" && typeof total === "number"
                    && pos >= total - 1) {
                n._seqAuto = false;  // last image just finished — we're done
                updateAutoUI(n);
                try {
                    app.extensionManager?.toast?.add?.({
                        severity: "success",
                        summary: "Sequential Image Loader",
                        detail: `Queue all finished — all ${total} images done.`,
                        life: 5000,
                    });
                } catch (e) { /* toast API optional */ }
            } else {
                queueMore = true;
            }
        }
        // One queue per completed run even if several nodes are auto-active.
        if (queueMore) setTimeout(() => app.queuePrompt(0, 1), 0);
    });
    // Errors / user interrupt end the chain rather than ploughing on.
    api.addEventListener("execution_error", stopAllAuto);
    api.addEventListener("execution_interrupted", stopAllAuto);
    app._SeqLoaderExecHooksInstalled = true;
}

// --- Hold (pause) state. "Hold last" freezes on the image you just got;
//     "Hold next" freezes on the upcoming one. While held, the queue hook
//     stops advancing (so every Queue re-emits the held frame) and all the
//     other controls grey out. Resume restores the position and re-enables
//     everything. Pure frontend state — Python loads files[index] regardless.
function enterHold(node, type) {
    const idxW = findWidget(node, "index");
    const total = (node._seqPaths || []).length;
    if (!idxW || total === 0) return;
    const k = idxW.value | 0;
    if (node._seqAuto) {            // holding a frame ends an auto-run
        node._seqAuto = false;
        updateAutoUI(node);
    }
    node._seqResumeIndex = k;       // where the sequence continues after Resume
    node._seqHold = true;
    node._seqHoldType = type;
    if (type === "last") {
        // The frame just rendered is one behind the "next" pointer.
        setWidget(idxW, ((k - 1) % total + total) % total);
    }
    updateHoldUI(node);
    updateStatus(node);
}

function resumeHold(node) {
    const idxW = findWidget(node, "index");
    node._seqHold = false;
    node._seqHoldType = null;
    if (idxW && typeof node._seqResumeIndex === "number") {
        setWidget(idxW, node._seqResumeIndex);
    }
    updateHoldUI(node);
    updateStatus(node);
}

function updateHoldUI(node) {
    const b = node._seqBtns;
    if (!b) return;
    const held = !!node._seqHold;
    const type = node._seqHoldType;

    if (node._seqStatusEl) {
        node._seqStatusEl.style.cursor = held ? "default" : "ew-resize";
    }

    if (!held) {
        b.holdLast.textContent = "⏸ Hold last";
        b.holdNext.textContent = "⏸ Hold next";
        setButtonTheme(b.holdLast, "hold");
        setButtonTheme(b.holdNext, "hold");
        for (const key of ["browse", "reset", "prev", "next", "rescan",
                           "auto", "holdLast", "holdNext"]) {
            setEnabled(b[key], true);
        }
        return;
    }

    // Held: grey everything except the active button, which becomes Resume.
    for (const key of ["browse", "reset", "prev", "next", "rescan", "auto"]) {
        setEnabled(b[key], false);
    }
    const active = type === "last" ? b.holdLast : b.holdNext;
    const other = type === "last" ? b.holdNext : b.holdLast;
    active.textContent = "▶ Resume";
    setButtonTheme(active, "resume");
    setEnabled(active, true);
    setEnabled(other, false);
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
        installExecutionHooks();
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            attachUI(this);
            // Enforce a sensible minimum node size once. Width ~320; height
            // accommodates the standard widgets plus the DOM panel.
            const min = [320, 574];
            if (this.size[0] < min[0]) this.size[0] = min[0];
            if (this.size[1] < min[1]) this.size[1] = min[1];
        };

        // Re-sync the file list after a saved workflow restores widget values.
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            setTimeout(() => refreshFileList(this), 50);
        };

        // Reflect what was actually loaded after a run: feeds the "Current"
        // preview and the auto-queue stop check.
        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origOnExecuted?.apply(this, arguments);
            try {
                const info = message?.seqloader?.[0];
                if (!info) return;
                this._seqLastExecPos =
                    typeof info.index === "number" ? info.index : null;
                this._seqLastExecTotal =
                    typeof info.total === "number" ? info.total : null;
                this._seqRanFlag = true;   // this node ran in the active prompt
                if (info.path) {
                    this._seqCurrentPath = info.path;
                } else if (typeof info.index === "number") {
                    this._seqCurrentPath =
                        (this._seqPaths || [])[info.index] || "";
                }
                // Keep file count fresh if the folder changed server-side.
                if (typeof info.total === "number" && this._seqFiles
                        && this._seqFiles.length !== info.total) {
                    refreshFileList(this);
                }
                updateStatus(this);
            } catch (e) { /* ignore */ }
        };

        // Tidy up thumbnail blobs / in-flight fetches when a node is deleted.
        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            clearTimeout(this._seqThumbTimer);
            for (const img of [this._seqCurrentImg, this._seqNextImg]) {
                if (!img) continue;
                if (img._abort) {
                    try { img._abort.abort(); } catch (e) { /* ignore */ }
                    img._abort = null;
                }
                if (img._url) { URL.revokeObjectURL(img._url); img._url = null; }
            }
            origOnRemoved?.apply(this, arguments);
        };
    },
});
