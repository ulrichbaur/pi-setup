import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CANCELLED, type DialogAnswer, type RpcRecord } from "./rpc.ts";

export type ParentUI = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "input" | "editor" | "notify"
>;

export function createDialogQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function forwardDialog(
  enqueue: <T>(task: () => Promise<T>) => Promise<T>,
  ui: ParentUI,
  request: RpcRecord,
  label: string,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<DialogAnswer> {
  const receivedAt = now();
  return enqueue(async () => {
    if (signal.aborted) return CANCELLED;
    let timeout: number | undefined;
    if (typeof request.timeout === "number") {
      timeout = request.timeout - (now() - receivedAt);
      if (timeout <= 0) return CANCELLED;
    }
    const title = `${label}: ${text(request.title)}`;
    const options = { signal, timeout };
    switch (request.method) {
      case "select": {
        const choices = Array.isArray(request.options)
          ? request.options.filter(
              (choice): choice is string => typeof choice === "string",
            )
          : [];
        const value = await ui.select(title, choices, options);
        return value === undefined ? CANCELLED : { value };
      }
      case "confirm":
        return {
          confirmed: await ui.confirm(title, text(request.message), options),
        };
      case "input": {
        const value = await ui.input(title, text(request.placeholder), options);
        return value === undefined ? CANCELLED : { value };
      }
      case "editor": {
        const value = await ui.editor(title, text(request.prefill));
        return value === undefined ? CANCELLED : { value };
      }
      default:
        return CANCELLED;
    }
  });
}

export function forwardNotification(
  ui: ParentUI,
  request: RpcRecord,
  label: string,
): void {
  const type =
    request.notifyType === "warning" || request.notifyType === "error"
      ? request.notifyType
      : "info";
  ui.notify(`${label}: ${text(request.message)}`, type);
}
