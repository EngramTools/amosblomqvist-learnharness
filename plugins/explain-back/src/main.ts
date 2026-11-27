import type { PluginFrontendContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, type ExplainBackAnswer, type ExplainBackPayload } from "./contract.ts";
import { mountAnswerEditor } from "./editor.ts";
import { mountQuestionContent } from "./question-view.ts";
import { mountAnsweredCard } from "./result-view.ts";
import { mountTypesafeSettings } from "./settings-view.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  const cleanups = [
    ctx.registerQuestionRenderer({
      id: QUESTION_TYPE_ID,
      supportedContractVersions: [1],
      mountQuestion(container, props) {
        return mountQuestionContent(container, ctx.ui, props);
      },
      mountAnswerEditor,
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
