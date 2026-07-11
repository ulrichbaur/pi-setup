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
