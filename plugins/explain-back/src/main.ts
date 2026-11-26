import type { PluginFrontendContext, PluginQuestionRenderer } from "learnharness-plugin-api";
import { QUESTION_TYPE_ID, type ExplainBackAnswer, type ExplainBackPayload } from "./contract.ts";
import { mountAnswerEditor } from "./editor.ts";
import { mountQuestionContent } from "./question-view.ts";
import { mountAnsweredCard } from "./result-view.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  return ctx.registerQuestionRenderer({
    id: QUESTION_TYPE_ID,
    supportedContractVersions: [1],
    mountQuestion(container, props) {
      return mountQuestionContent(container, ctx.ui, props);
    },
    mountAnswerEditor,
    mountAnswered(container, props) {
      return mountAnsweredCard(container, ctx.ui, props);
    },
  } satisfies PluginQuestionRenderer<ExplainBackPayload, ExplainBackAnswer>);
}
