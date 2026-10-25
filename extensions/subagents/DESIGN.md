# Subagents

- A subagent is a child Pi process in RPC mode.
  The parent sends commands on stdin and reads events on stdout.
- Each subagent keeps a saved session.
  The parent model can resume it, and the user can open it with `pi --session <path>`.

## Transport

- Start the child with the same Pi binary as the parent, in `--mode rpc`.
  Skills and discovered extensions stay off;
  the agent's custom tools load with `--extension`.
- Use our own small client, not Pi's `RpcClient`.
  That client always spawns `node`, copies child stderr into the parent terminal,
  and stops waiting after 60 seconds.
- Split stdout on LF only and decode UTF-8 across chunk boundaries.
  JSON strings may contain U+2028 and U+2029.
- Send the task with the `prompt` command.
  A rejected prompt, or one an input handler consumed, fails the run.
- A run ends at `agent_settled`, not `agent_end`.
  Retries and compaction can follow `agent_end`.
- After the run, close stdin.
  Pi then shuts down and finishes writing the session.
- On abort, send the `abort` command, then close stdin.
  Signals are only a fallback when the child does not exit.
- A child that exits before `agent_settled` fails the run and shows its stderr.

## Dialogs

- With a parent UI, a child's `select`, `confirm`, `input`, and `editor` requests
  open in the parent, titled with the session id.
  Notifications appear there too; other UI requests are ignored.
- One dialog is open at a time, across all subagents.
  A dialog whose child exited, whose run was aborted,
  or whose timeout passed while it waited is never shown.
  An open one, except the editor, closes when its child exits
  or its run is aborted.
- Without a parent UI, every dialog gets a cancel response.
- With a parent UI, the parent starts `safe_bash` with `--safe-bash-ask`.
  The user then decides about every command
  that the headless or the interactive policy catches.
  A refusal or a dismissed dialog blocks the command.
  Without the flag, the headless policy decides alone.
- Every agent has `ask_user`.
  Without an answer, the tool tells the agent to continue
  and state its assumption.

## Sessions

- Sessions live in `subagents/sessions` below Pi's agent directory.
  They stay out of `/resume` and out of the skillset history,
  which read Pi's default session directory.
- The extension creates each id as `<agent>-<8 hex characters>`.
  The agent name in the id tells a resume which definition to load.
  Agent names therefore contain only letters, digits, `_`, and `-`.
- The session name is `<agent>: <start of the task>`.
- The parent's tool result stores the session id and file.
  That is the only link between parent and child.
- A resume finds `*_<id>.jsonl`, reads the working directory from its header,
  and starts the child there with `--session <path>`.
  The agent's current definition and model selection apply.
- One session runs in at most one child at a time.
  The extension tracks the ids of running sessions,
  and a request for a running session fails.
- A resume rejects a `cwd` and an agent that does not match the id.
- Each result ends with `Session: <id>`, so the parent model can resume it.
- Sessions older than `sessionRetentionDays` (default 90) are deleted at startup.
  A cleanup failure shows a notice and does not stop the extension.
