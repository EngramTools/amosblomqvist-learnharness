import type { PluginBackendContext } from "learnharness-plugin-api";
import { definition } from "./contract.ts";
import { gradeExplainBack } from "./grader.ts";

export function activate(ctx: PluginBackendContext): () => void {
  return ctx.registerQuestionType({
    ...definition,
    gradeAnswer: context => gradeExplainBack(ctx, context),
  });
}
