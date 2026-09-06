# Bash Guard

- Interactive policy: which commands the user confirms before they run.
- Headless policy: which commands a subagent may never run.
- Both policies are columns of one rule table in `lib/bash-policy.ts`.
  The table lives outside the extension because the subagents extension
  consumes its headless column; this note still owns the semantics.
  Each row matches one command shape, carries an interactive severity
  (or none), and says whether a headless worker may run it.
  Add a command once and decide both answers in the same place.

## Interactive policy

- Flag operations that are destructive or hard to recover from.
  Deleting files, elevated privileges, disk and cloud teardown,
  rewriting Git history, and pushing to a remote.
- Do not flag what the edit tools already allow. Redirects, `sed -i`,
  and forced copies change files the same way `write` and `edit` do.
- Do not flag Git operations the index or reflog can undo,
  such as `add`, `commit`, branch switches, `merge`, and `pull`.
  A `checkout`, `switch`, or `restore` that overwrites the working tree
  is not recoverable and is flagged like `reset --hard`.
- Parse the command; never match on raw text.
  Follow `bash -c`, `eval`, and `su -c`; strip `env`, `nice`, `nohup`,
  `time`, `timeout`, `busybox`, and variable prefixes; judge the command
  that `xargs` or `find -exec` runs; and inspect every segment
  of a pipeline or command list.
- An unparseable command is flagged. Unknown is not safe.
- Without a UI the guard fails closed unless the user opted in
  with `--bash-guard-auto-allow`.
- A command the user aborted is blocked for one minute, whitespace
  changes included, and the abort reason is passed back to the model.

## Headless policy

- Block catastrophic operations outright: recursive deletion, disk
  formatting, system power, infrastructure teardown, piping downloads
  to a shell.
- Block operations that belong to the parent session:
  `git commit`, `git pull`, `git push`, and `git stash`.
- Everything else runs without confirmation.
  A subagent has no user to ask.
- The subagents extension reuses this policy in its `safe_bash` tool.
