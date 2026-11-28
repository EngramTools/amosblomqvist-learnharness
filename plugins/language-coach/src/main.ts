import type { PluginFrontendContext, PluginQuestionEditorHandle, PluginQuestionRenderer } from "learnharness-plugin-api";
import { mountReadAloudEditor } from "./read-aloud-editor.ts";
import { mountReadAloudResult } from "./read-aloud-result-view.ts";
import { QUESTION_TYPE_ID, type ReadAloudAnswer, type ReadAloudPayload } from "./read-aloud-contract.ts";
import { mountLanguageCoachSettings } from "./settings-view.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  const cleanups = [
    ctx.registerQuestionRenderer({
      id: QUESTION_TYPE_ID,
      supportedContractVersions: [1],
      mountAnswerEditor(container: HTMLElement, props: Parameters<NonNullable<PluginQuestionRenderer["mountAnswerEditor"]>>[1]): PluginQuestionEditorHandle {
        return mountReadAloudEditor(container, props);
      },
      mountAnswered(container, props) {
        const outcome = props.grading;
        if (!outcome) return () => {};
        mountReadAloudResult(container, outcome);
        const remove = () => { container.querySelector(".lh-coach-read-aloud")?.remove(); };
        props.signal.addEventListener("abort", remove, { once: true });
        return () => {
          props.signal.removeEventListener("abort", remove);
          remove();
        };
      },
    } satisfies PluginQuestionRenderer<ReadAloudPayload, ReadAloudAnswer>),
    ctx.registerSettings((container, signal) => {
      return mountLanguageCoachSettings(container, ctx, signal);
    }),
  ];
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
}
