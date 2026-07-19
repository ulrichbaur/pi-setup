# Pi setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes.

Development requires Node.js 22.6 or newer and pnpm 11.9.0.

## Structure

- `extensions/` — TypeScript extensions
- `skills/` — skills, each normally containing a `SKILL.md`
- `prompts/` — Markdown prompt templates
- `themes/` — JSON themes
- `tests/` — tests for extensions and supporting code

## Extensions

### Model effort

`extensions/model-effort.ts` remembers the selected thinking level for each exact
provider/model pair. When a model does not support the saved level, it uses the
closest supported lower level.

Preferences are stored in `~/.pi/agent/model-effort.json` (or below
`PI_CODING_AGENT_DIR` when set). The file is created with user-only permissions.
Delete it to reset all saved levels.

### Skill palette

`extensions/skill-palette/` provides `/skill`, a searchable picker that queues a
skill for the next message. Unlike `pi-skill-palette`, it reads Pi's effective
loaded skill collection, so package `skills` filters in `settings.json` are
respected. The injected skill block uses the same format as Pi's native
`/skill:name` expansion.

Remove `npm:pi-skill-palette` from `settings.json` before enabling this
extension; otherwise Pi disambiguates the duplicate `/skill` commands.

### Skill policy

`extensions/skill-policy/` controls which installed skills the model may see
and invoke automatically. Skills remain available through manual `/skill:name`
commands. The default is fail-closed: no skills are exposed automatically, and
a malformed policy also hides all skills.

Run `/skill-policy` inside Pi to open the interactive allowlist editor.

The allowlist is stored in `skill-policy.json` below `PI_CODING_AGENT_DIR`, or
in `~/.pi/agent/skill-policy.json` when that variable is unset, with user-only
permissions. Delete it to restore the default empty allowlist. Run `/reload`
after installing or updating extensions; policy changes apply without a reload.

### Pi statusline

`extensions/pi-statusline/` replaces Pi's TUI footer with the active
provider/model, thinking level, context use, session cost, cache-hit rate, and
available Codex or OpenCode Go quota windows. It runs only in TUI mode.

Quota display is enabled by default. Configure it interactively with
`/statusline`, which opens a menu for toggling the Codex and OpenCode Go
quota sources, editing the OpenCode Go workspace ID, setting the auth cookie,
and previewing the current config. Changes are kept in memory until you
choose **Save & reload**; **Discard & exit** drops them. The menu re-reads the
on-disk config on open, so external edits show up correctly.

The non-secret config lives in `~/.pi/agent/pi-statusline.json` (or below
`PI_CODING_AGENT_DIR` when set):

```json
{
  "opencodeGo": {
    "workspaceId": "your-workspace-id"
  },
  "quotas": {
    "codex": true,
    "opencodeGo": true
  }
}
```

Codex uses Pi's `openai-codex` login. OpenCode Go additionally requires its
`auth` cookie value in `~/.pi/agent/pi-statusline.auth.json` (or below
`PI_CODING_AGENT_DIR`):

```json
{
  "opencodeGo": {
    "authCookie": "cookie-value"
  }
}
```

If you create the auth file manually, protect it with
`chmod 600 ~/.pi/agent/pi-statusline.auth.json`. Disable either quota source
by flipping its `quotas` value to `false` in the menu. Run `/reload` after
manually changing either file.

## Develop locally

Install this checkout as a local Pi package:

```bash
pi install "$(pwd)"
```

After editing resources, run `/reload` inside Pi. A single extension can also be tested without installation:

```bash
pi -e ./extensions/model-effort.ts
```

## Install from Git

Once the repository has a remote, install it with:

```bash
pi install git:github.com/OWNER/REPOSITORY
```

Pi packages execute with the user's full permissions. Review changes before installing or updating them.
