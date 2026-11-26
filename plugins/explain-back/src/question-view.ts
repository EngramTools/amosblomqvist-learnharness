import type { PluginFrontendContext, PluginQuestionMountContext } from "learnharness-plugin-api";
import type { ExplainBackPayload } from "./contract.ts";

type MarkdownUi = Pick<PluginFrontendContext["ui"], "mountMarkdown">;
type QuestionContentProps = Pick<PluginQuestionMountContext<ExplainBackPayload>, "input" | "signal">;

function label(document: Document, text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "lh-explain-back__label";
  element.textContent = text;
  return element;
}

function section(document: Document, className: string, heading?: string): HTMLElement {
  const element = document.createElement("section");
  element.className = `lh-explain-back__section ${className}`;
  if (heading) element.append(label(document, heading));
  return element;
}

/** Prompt, the step being explained, and the facts it rests on. */
export function mountQuestionContent(container: HTMLElement, ui: MarkdownUi, props: QuestionContentProps): () => void {
  const { input, signal } = props;
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-explain-back";
  container.append(root);
  const cleanups: (() => void)[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup(); } catch {}
    }
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  const block = (parent: HTMLElement, className: string, text: string) => {
    const element = document.createElement("div");
    element.className = className;
    parent.append(element);
    const mount = ui.mountMarkdown(element, { text }, { signal });
    cleanups.push(() => mount.dispose());
  };
  try {
    block(root, "lh-explain-back__prompt", input.question);
    const step = section(document, "lh-explain-back__step", "Step");
    block(step, "lh-explain-back__prose", input.payload.step);
    root.append(step);
    if (input.payload.premises.length > 0) {
      const premises = section(document, "lh-explain-back__premises", "Rests on");
      const list = document.createElement("ol");
      list.className = "lh-explain-back__premise-list";
      for (const premise of input.payload.premises) {
        const item = document.createElement("li");
        block(item, "lh-explain-back__prose", premise);
        list.append(item);
      }
      premises.append(list);
      root.append(premises);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
