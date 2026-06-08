---
name: publishing-comfyui-nodes
description: How the user publishes ComfyUI custom nodes (Comfy Registry + legacy Manager)
metadata:
  type: project
---

The user (shootthesound) publishes ComfyUI custom nodes to two places:

1. **Comfy Registry** — needs a `pyproject.toml` with `[project]` (name = lowercase-hyphen id, version, license, description) and `[tool.comfy]` (`PublisherId = "shootthesound"`, `DisplayName`). Publish with `comfy node publish --token <COMFY_API_KEY>` (comfy-cli installed, v1.10.3). Registry URL: `https://registry.comfy.org/nodes/<name>`.

2. **Legacy ComfyUI-Manager** — PR adding an entry to `custom-node-list.json` in **Comfy-Org/ComfyUI-Manager** (moved from ltdrdata). New entries go at the TOP of the `custom_nodes` array. The user already has a fork `shootthesound/ComfyUI-Manager` (default branch `main`); GitHub allows only one fork per repo, so reuse it — branch off upstream `main`, push branch to the fork, open PR against `Comfy-Org:main`. Entry shape: `author, title, reference, files[], install_type:"git-clone", description`.

**Why:** The user asked to publish to "both the legacy manager and the comfy registry" — this is a recurring two-target workflow for them.

**How to apply:** Never write the Comfy API key into any file; pass it inline to the publish command only. Advise rotating the key if it was pasted in chat.
