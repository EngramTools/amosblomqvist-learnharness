import type { PluginFrontendContext, PluginQuestionEditorHandle, PluginQuestionEditorProps, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, type ExplainBackAnswer, type ExplainBackPayload } from "./contract.ts";
import { mountAnswerEditor } from "./editor.ts";
import { mountQuestionContent } from "./question-view.ts";
import { mountAnsweredCard } from "./result-view.ts";
import { mountTypesafeSettings, readPublicSettings } from "./settings-view.ts";

/** The saved interview-mode setting, read as each editor mounts. Anything
 *  unreadable means off: the editor then stays text-only, as before. */
async function interviewModeEnabled(ctx: Pick<PluginFrontendContext, "call">): Promise<boolean> {
  try {
    return readPublicSettings(await ctx.call("get-settings")).interviewMode;
  } catch {
    return false;
  }
}

export function activate(ctx: PluginFrontendContext): () => void {
  const cleanups = [
    ctx.registerQuestionRenderer({
      id: QUESTION_TYPE_ID,
      supportedContractVersions: [1],
      mountQuestion(container, props) {
        return mountQuestionContent(container, ctx.ui, props);
      },
      async mountAnswerEditor(container: HTMLElement, props: PluginQuestionEditorProps<ExplainBackPayload>): Promise<PluginQuestionEditorHandle> {
        return mountAnswerEditor(container, props, { interviewMode: await interviewModeEnabled(ctx) });
      },
      mountAnswered(container, props) {
        return mountAnsweredCard(container, ctx.ui, props);
      },
    } satisfies PluginQuestionRenderer<ExplainBackPayload, ExplainBackAnswer>),
    ctx.registerSettings((container, signal) => {
      return mountTypesafeSettings(container, ctx, signal);
    }),
  ];
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
}
