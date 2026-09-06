# Pi Setup

This repository is an installable Pi package containing personal Pi resources.

## Resource layout

- put executable Pi extensions in `extensions/`.
- put Pi theme JSON files in `themes/`.
- keep runtime dependencies in `dependencies` and Pi-provided imports in `peerDependencies`.
- store extension-managed Pi state below `PI_CODING_AGENT_DIR` when set; otherwise use `~/.pi/agent`.

Do not commit credentials, generated state, sessions, `node_modules`, or machine-specific absolute paths.
