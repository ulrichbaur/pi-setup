# Pi setup

Personal [Pi](https://pi.dev) extensions, skills, prompt templates, and themes.

Development requires Node.js 22.6 or newer and pnpm 11.9.0.

## Structure

- `extensions/` — TypeScript extensions
- `skills/` — skills, each normally containing a `SKILL.md`
- `prompts/` — Markdown prompt templates
- `themes/` — JSON themes
- `tests/` — tests for extensions and supporting code

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
