# Bash Guard

- Interactive policy: which commands the user confirms before they run.
- Subagent policy: which commands a subagent may never run.
- Both policies read one rule table in `lib/bash-policy.ts`.
  The table lives outside the extension because the subagents extension
  uses it too; this note still owns the semantics.
  Each row matches one command shape and carries an interactive severity,
  or none when only subagents are stopped.
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
- Judge the parsed words, never the raw text.
  Only shape checks read the text: a fork bomb, a heredoc,
  and whether a command is complex.
  Follow `bash -c`, `eval`, and `su -c`; strip `env`, `nice`, `nohup`,
  `time`, `timeout`, `busybox`, `exec`, shell keywords, and variable prefixes;
  reduce a command path to its name; judge the command
  that `xargs` or `find -exec` runs; and inspect every step
  of a pipeline or command list.
- Newlines, backticks, `$(…)`, and subshells end a step too.
  A heredoc body is data and is skipped, unless a shell reads it as a script.
- An unparseable command is flagged. Unknown is not safe.
- Each finding names the risky step and the reason.
  The review dialog and every block message show the same list,
  so the user and the model both see what was flagged and why.
- A complex command, meaning several lines, command substitution,
  or shell control flow, is never shown for review,
  because a person cannot judge it reliably as a whole.
  If one of its steps is risky, the guard blocks it with the findings
  and asks the model to run that step as its own simple command.
  A complex command without a risky step runs as usual.
- Without a UI the guard fails closed unless the user opted in
  with `--bash-guard-auto-allow`.
- A command the user aborted is blocked for one minute, whitespace
  changes included, and the abort reason is passed back to the model.

## Stats

- Each decision about a flagged command is appended to
  `bash-guard/decisions.jsonl` below Pi's agent directory:
  approved, rejected with the user's reason, a repeat blocked,
  or blocked without asking.
  A record keeps the findings, not the whole command.
- A failed write shows a warning and never changes the decision.
- `/bash-guard stats` reports the recorded decisions first.
  Logs from other machines can be passed as arguments and are counted together.
  A log line that cannot be read is counted and named, not fatal,
  because the log is a record, not configuration.
- It then reads every saved session and pairs each bash call
  with its result: it ran, the user rejected it, or the guard blocked it.
  Pi records no decision itself, so the outcome comes from the result text.
- The current policy classifies each command, so the report shows
  how the user treated what the guard flags today.
  "Ran" cannot tell an approval from a session without the guard
  or a command an older policy let through, and the report says so.
- Forked sessions copy their history; each call counts once by id.
- A session that cannot be read is listed with its path,
  and the rest of the report still appears.

## Subagent policy

- A subagent has no user to ask, so its `safe_bash` tool blocks every row.
- Rows without a severity cover operations that belong to the parent session:
  `git commit`, `git pull`, and `git stash`.
  The user may run them freely, but a subagent never does.
- Everything else runs without confirmation.
