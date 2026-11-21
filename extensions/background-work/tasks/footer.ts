import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { JobRegistry } from "./registry.ts";

const KEY = "background-tasks";

/** The footer status, or undefined when no job runs. */
export function footerText(running: number): string | undefined {
  return running ? `Tasks: ${running} running` : undefined;
}

export function watchTaskFooter(
  ui: Pick<ExtensionUIContext, "setStatus">,
  registry: JobRegistry,
): () => void {
  let previous: string | undefined;
  const refresh = () => {
    const text = footerText(registry.active().length);
    if (text === previous) return;
    previous = text;
    ui.setStatus(KEY, text);
  };
  const unsubscribe = registry.subscribe(refresh);
  refresh();
  return () => {
    unsubscribe();
    if (previous !== undefined) ui.setStatus(KEY, undefined);
  };
}
