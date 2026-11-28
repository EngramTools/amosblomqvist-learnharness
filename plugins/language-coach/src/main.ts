import type { PluginFrontendContext } from "learnharness-plugin-api";
import { mountLanguageCoachSettings } from "./settings-view.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerSettings((container, signal) => mountLanguageCoachSettings(container, ctx, signal));
}