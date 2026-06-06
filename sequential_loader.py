"""Sequential Image Loader — load PNGs from a folder, one per queue.

Paste a directory path into the node; it scans for PNG files, sorts them
in natural order, and on each Queue press hands back the *next* image in
the sequence. A "Reset to start" button (frontend) rewinds to the first
file. Index advancing is driven by the JS queue hook; this module just
resolves index → file → tensors and exposes a listing route the UI uses
to show progress.
"""

import os

import numpy as np
import torch
from PIL import Image, ImageOps


# --- Shared listing helpers -----------------------------------------------

# Selectable filetypes -> the extensions each option matches. "jpg" and
# "jpeg" both match .jpg/.jpeg (same format) so either choice behaves as
# users expect. "all" matches every supported image extension.
FILETYPE_EXTS = {
    "png": (".png",),
    "jpg": (".jpg", ".jpeg"),
    "jpeg": (".jpg", ".jpeg"),
    "webp": (".webp",),
    "bmp": (".bmp",),
    "gif": (".gif",),
    "tiff": (".tif", ".tiff"),
}
FILETYPE_CHOICES = ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "all"]
_ALL_EXTS = tuple(sorted({e for exts in FILETYPE_EXTS.values() for e in exts}))


def _exts_for(filetype):
    """Resolve a filetype choice to the tuple of extensions to match."""
    if not filetype or filetype == "all":
        return _ALL_EXTS
    return FILETYPE_EXTS.get(filetype, (".png",))


def _natural_key(name):
    """Sort key so 'img2.png' precedes 'img10.png' (numeric-aware)."""
    import re
    parts = re.split(r"(\d+)", name.lower())
    return [int(p) if p.isdigit() else p for p in parts]


def list_images(directory, include_subfolders=False, filetype="png",
                reverse=False):
    """Return image file paths under `directory`, natural-sorted.

    `filetype` is one of FILETYPE_CHOICES (or "all"). With
    include_subfolders the walk is recursive and entries are sorted by
    their path relative to `directory` so ordering is stable/intuitive.
    `reverse` flips the final order (so the sequence runs last->first).
    Returns [] for a missing/empty/invalid directory (never raises).
    """
    directory = (directory or "").strip().strip('"').strip("'")
    if not directory or not os.path.isdir(directory):
        return []

    exts = _exts_for(filetype)

    def _matches(name):
        return name.lower().endswith(exts)

    found = []
    if include_subfolders:
        for root, _dirs, files in os.walk(directory):
            for f in files:
                if _matches(f):
                    found.append(os.path.join(root, f))
        found.sort(key=lambda p: _natural_key(os.path.relpath(p, directory)))
    else:
        try:
            names = os.listdir(directory)
        except OSError:
            return []
        names = [n for n in names if _matches(n)
                 and os.path.isfile(os.path.join(directory, n))]
        names.sort(key=_natural_key)
        found = [os.path.join(directory, n) for n in names]

    if reverse:
        found.reverse()
    return found


def _load_image_tensors(path):
    """Mirror ComfyUI's LoadImage: -> (IMAGE [1,H,W,3], MASK [1,H,W])."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)

    rgb = img.convert("RGB")
    arr = np.array(rgb).astype(np.float32) / 255.0
    image = torch.from_numpy(arr)[None,]

    if "A" in img.getbands():
        alpha = np.array(img.getchannel("A")).astype(np.float32) / 255.0
        mask = 1.0 - torch.from_numpy(alpha)
    else:
        mask = torch.zeros((rgb.height, rgb.width), dtype=torch.float32)
    mask = mask[None,]
    return image, mask


# --- Node ------------------------------------------------------------------

class SequentialImageLoader:
    """Load PNGs from a folder in order, advancing one image per queue."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "C:\\path\\to\\folder",
                    "tooltip": "Folder to scan for .png files.",
                }),
                "include_subfolders": ("BOOLEAN", {"default": False}),
                # Mechanical: driven by the JS queue hook / Reset button.
                "index": ("INT", {
                    "default": 0, "min": 0, "max": 0x7FFFFFFF, "step": 1,
                }),
                # Declared LAST (newest widgets) so older saved workflows keep
                # their positional widget order; absent -> defaults below.
                "filetype": (FILETYPE_CHOICES, {"default": "png"}),
                "reverse": ("BOOLEAN", {
                    "default": False,
                    "label_on": "reverse (last→first)",
                    "label_off": "forward (first→last)",
                }),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename", "index", "total")
    FUNCTION = "load"
    CATEGORY = "image"

    @classmethod
    def IS_CHANGED(cls, directory, include_subfolders, index, filetype="png",
                   reverse=False):
        # index changes every queue (JS hook), so this always reruns; keep
        # directory in the key too so editing the path forces a fresh scan.
        return f"{directory}|{include_subfolders}|{filetype}|{reverse}|{index}"

    def load(self, directory, include_subfolders, index, filetype="png",
             reverse=False):
        files = list_images(directory, include_subfolders, filetype, reverse)
        total = len(files)
        if total == 0:
            label = "image" if filetype == "all" else filetype.upper()
            raise ValueError(
                f"[Sequential Image Loader] No {label} files found in: "
                f"{directory!r}"
            )

        pos = int(index) % total           # wrap around at the end
        path = files[pos]
        filename = os.path.basename(path)

        image, mask = _load_image_tensors(path)

        return {
            "ui": {"seqloader": [{
                "filename": filename,
                "index": pos,
                "total": total,
            }]},
            "result": (image, mask, filename, pos, total),
        }


# --- Directory browsing (server-side folder picker) -----------------------

def _list_roots():
    """Top-level entries: drive letters on Windows, '/' + home elsewhere."""
    roots = []
    if os.name == "nt":
        import string
        for c in string.ascii_uppercase:
            d = f"{c}:\\"
            if os.path.exists(d):
                roots.append({"name": d, "path": d})
    else:
        roots.append({"name": "/", "path": "/"})
    home = os.path.expanduser("~")
    if os.path.isdir(home):
        roots.append({"name": f"~  ({home})", "path": home})
    return roots


def browse_dir(path, filetype="png"):
    """Resolve a folder for the picker UI.

    Returns the current path, its parent ("" => the roots list), the
    immediate subdirectories, and how many matching images live here.
    An empty/invalid path returns the roots listing.
    """
    path = (path or "").strip().strip('"').strip("'")
    if not path or not os.path.isdir(path):
        return {"cwd": "", "parent": None, "is_roots": True,
                "dirs": _list_roots(), "image_count": 0}

    norm = os.path.normpath(path)
    parent = os.path.dirname(norm)
    if parent == norm:          # at a drive root -> "up" goes to the roots list
        parent = ""

    dirs = []
    try:
        for name in os.listdir(norm):
            full = os.path.join(norm, name)
            try:
                if os.path.isdir(full):
                    dirs.append({"name": name, "path": full})
            except OSError:
                continue
    except OSError:
        pass
    dirs.sort(key=lambda d: _natural_key(d["name"]))

    image_count = len(list_images(norm, False, filetype, False))
    return {"cwd": norm, "parent": parent, "is_roots": False,
            "dirs": dirs, "image_count": image_count}


# --- Server routes (UI progress display + folder picker) ------------------

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/seqloader/list")
    async def _seqloader_list(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        directory = (data or {}).get("directory", "")
        include_subfolders = bool((data or {}).get("include_subfolders", False))
        filetype = (data or {}).get("filetype", "png")
        reverse = bool((data or {}).get("reverse", False))
        files = list_images(directory, include_subfolders, filetype, reverse)
        return web.json_response({
            "count": len(files),
            "files": [os.path.basename(p) for p in files],
        })

    @PromptServer.instance.routes.post("/seqloader/browse")
    async def _seqloader_browse(request):
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        path = (data or {}).get("path", "")
        filetype = (data or {}).get("filetype", "png")
        try:
            return web.json_response(browse_dir(path, filetype))
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
except Exception as _e:  # pragma: no cover - server optional
    print(f"[Sequential Image Loader] routes not registered: {_e}")


NODE_CLASS_MAPPINGS = {"SequentialImageLoader": SequentialImageLoader}
NODE_DISPLAY_NAME_MAPPINGS = {
    "SequentialImageLoader": "Sequential Image Loader (folder)",
}
