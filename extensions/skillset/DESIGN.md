# Skillset Extension

- Palette (`/skill`): how the user picks a skill.
- Policy (`/skill-policy`): which skills the model may invoke on its own.
- Usage (`/usage`): whether a skill earns its place.

Features register independently. Failing to load one should not automatically result in failing to load all of them.
All three commands are interactive views, not static output.
The commands are TUI only. Without a TUI, only policy stays relevant:
it keeps restricting which skills the model sees.

## Palette (`/skill`)

- Use Pi's native skill invocation (`/skill:name`).
- Use frecency sorting of skills.
- Sorting is best effort; the palette itself must always open.

## Policy (`/skill-policy`)

- Policy hides skills from the model, never from the user.
- Hide skills from the model by default.
- On initial load: Report broken config.

## Usage (`/usage`)

- Use session logs as the data source.
- Count invoked skills using the native way (`/skill:name`).
- Use frecency sorting of skills.
- On initial load: Report broken session files and keep going.
