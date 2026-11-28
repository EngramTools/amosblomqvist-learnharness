import type { PluginFrontendContext, PluginQuestionGradingOutcome, PluginQuestionMountContext } from "learnharness-plugin-api";
import { DELIVERY_CRITERION, GAP_KINDS, readExplainBackResult, type ExplainBackAnswer, type ExplainBackDelivery, type ExplainBackPayload, type ExplainBackResult, type ExplainBackScoring, type GapKind } from "./contract.ts";
import { formatPause, formatRate } from "./delivery.ts";
import { mountQuestionContent } from "./question-view.ts";

type MarkdownUi = Pick<PluginFrontendContext["ui"], "mountMarkdown">;

export const GAP_LABELS: Record<GapKind | typeof DELIVERY_CRITERION, string> = {
  "missing step": "Missing step",
  "undefined term": "Undefined term",
  "wrong order": "Wrong order",
  "conclusion buried": "Conclusion buried",
  [DELIVERY_CRITERION]: "Filler rate high",
};

/** The scored list: the four gaps, then delivery when it scored. */
export function scoredCriteria(scoring: Extract<ExplainBackScoring, { status: "ok" }>): (GapKind | typeof DELIVERY_CRITERION)[] {
  const extra: (GapKind | typeof DELIVERY_CRITERION)[] = scoring.criteria[DELIVERY_CRITERION] === undefined ? [] : [DELIVERY_CRITERION];
  return [...GAP_KINDS, ...extra];
}

function section(document: Document, className: string, heading: string): HTMLElement {
  const element = document.createElement("section");
  element.className = `lh-explain-back__section ${className}`;
  const label = document.createElement("div");
  label.className = "lh-explain-back__label";
  label.textContent = heading;
  element.append(label);
  return element;
}

function paragraph(document: Document, className: string, text: string): HTMLElement {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function mountError(document: Document, container: HTMLElement, message: string): void {
  const error = section(document, "lh-explain-back__error", "Feedback unavailable");
  error.setAttribute("role", "status");
  error.append(paragraph(document, "lh-explain-back__prose", "Your answer was saved. The literal reader could not finish, so there is no reconstruction or gap list."));
  if (message.trim() !== "") error.append(paragraph(document, "lh-explain-back__error-detail", message));
  container.append(error);
}

function formatProbability(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function mountCriterionScores(document: Document, container: HTMLElement, scoring: Extract<ExplainBackScoring, { status: "ok" }>): void {
  const scores = section(document, "lh-explain-back__scores", "Criterion probabilities");
  const list = document.createElement("ul");
  list.className = "lh-explain-back__score-list";
  for (const kind of scoredCriteria(scoring)) {
    const probability = scoring.criteria[kind];
    if (probability === undefined) continue;
    const item = document.createElement("li");
    item.className = "lh-explain-back__score";
    item.dataset.criterion = kind;
    item.dataset.probability = String(probability);
    const label = document.createElement("span");
    label.className = "lh-explain-back__score-label";
    label.textContent = GAP_LABELS[kind];
    const value = document.createElement("span");
    value.className = "lh-explain-back__score-value";
    value.textContent = formatProbability(probability);
    item.append(label, value);
    list.append(item);
  }
  scores.append(list);
  container.append(scores);

  const fix = section(document, "lh-explain-back__fix", "Fix for next time");
  fix.dataset.fixCriterion = scoring.fix.criterion;
  fix.dataset.fixProbability = String(scoring.fix.probability);
  fix.append(paragraph(
    document,
    "lh-explain-back__fix-choice",
    `${GAP_LABELS[scoring.fix.criterion]} · ${formatProbability(scoring.fix.probability)}`,
  ));
  const wording = scoring.fix.wording;
  if (wording !== undefined) fix.append(paragraph(document, "lh-explain-back__prose", wording));
  else {
    const reason = scoring.fix.unavailableReason ?? "the wording model call failed";
    const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    fix.append(paragraph(
      document,
      "lh-explain-back__prose lh-explain-back__fix-wording-unavailable",
      `Fix wording is unavailable: ${sentence}`,
    ));
  }
  container.append(fix);
}

function mountDelivery(document: Document, container: HTMLElement, delivery: ExplainBackDelivery): void {
  if (delivery.status !== "ok") return;
  const section_ = section(document, "lh-explain-back__delivery", "Delivery");
  const lines: string[] = [
    `Fillers: ${formatRate(delivery.fillersPerMin)}`,
    `Words: ${formatRate(delivery.wordsPerMin)}`,
  ];
  if (delivery.pauses.length === 0) lines.push("No long pauses.");
  else for (const pause of delivery.pauses) lines.push(formatPause(pause));
  section_.append(paragraph(document, "lh-explain-back__prose", lines.join("\n")));
  container.append(section_);
}

function mountScoring(document: Document, container: HTMLElement, scoring: ExplainBackScoring): void {
  if (scoring.status === "ok") {
    mountCriterionScores(document, container, scoring);
    return;
  }
  const unavailable = section(document, "lh-explain-back__scoring-unavailable", "Scoring unavailable");
  unavailable.setAttribute("role", "status");
  unavailable.append(paragraph(document, "lh-explain-back__prose", scoring.reason));
  container.append(unavailable);
}

/** The model that graded this result, shown on every outcome: ok cards,
 *  unavailable scoring, and reader errors. Older saved results have none. */
function mountGradedBy(document: Document, container: HTMLElement, model: string | undefined): void {
  if (!model) return;
  const provenance = paragraph(document, "lh-explain-back__graded-by", `Graded by ${model}.`);
  provenance.dataset.gradedBy = model;
  container.append(provenance);
}

function mountResult(document: Document, container: HTMLElement, result: ExplainBackResult): void {
  const reconstruction = section(document, "lh-explain-back__reconstruction", "What a literal reader understood");
  reconstruction.append(result.reconstruction.trim() === ""
    ? paragraph(document, "lh-explain-back__prose lh-explain-back__nothing-reconstructed", "Nothing could be reconstructed from the explanation.")
    : paragraph(document, "lh-explain-back__prose", result.reconstruction));
  container.append(reconstruction);

  const gaps = section(document, "lh-explain-back__gaps", "Gaps");
  if (result.gaps.length === 0) {
    gaps.append(paragraph(document, "lh-explain-back__prose lh-explain-back__no-gaps", "No gaps found."));
  } else {
    const list = document.createElement("ul");
    list.className = "lh-explain-back__gap-list";
    for (const gap of result.gaps) {
      const item = document.createElement("li");
      item.className = "lh-explain-back__gap";
      item.dataset.gapKind = gap.kind;
      const kind = document.createElement("span");
      kind.className = "lh-explain-back__gap-kind";
      kind.textContent = GAP_LABELS[gap.kind];
      const detail = document.createElement("span");
      detail.className = "lh-explain-back__gap-detail";
      detail.textContent = gap.detail;
      item.append(kind, detail);
      list.append(item);
    }
    gaps.append(list);
  }
  container.append(gaps);
  if (result.scoring) mountScoring(document, container, result.scoring);
  if (result.delivery) mountDelivery(document, container, result.delivery);
  mountGradedBy(document, container, result.gradedBy);
}

export function mountGrading(container: HTMLElement, grading: PluginQuestionGradingOutcome, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const document = container.ownerDocument;
  const root = document.createElement("div");
  root.className = "lh-explain-back-grading";
  container.append(root);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    root.remove();
  };
  signal.addEventListener("abort", dispose, { once: true });
  if ("error" in grading) {
    mountError(document, root, grading.error);
  } else {
    const result = readExplainBackResult(grading.result);
    if (result) mountResult(document, root, result);
    else mountError(document, root, "The saved feedback could not be read.");
  }
  return dispose;
}

export function mountAnsweredCard(container: HTMLElement, ui: MarkdownUi, props: PluginQuestionMountContext<ExplainBackPayload> & {
  readonly answer: ExplainBackAnswer;
  readonly grading?: PluginQuestionGradingOutcome;
}): () => void {
  if (props.signal.aborted) return () => {};
  const cleanups: (() => void)[] = [];
  let answerRoot: HTMLElement | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    props.signal.removeEventListener("abort", dispose);
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup(); } catch {}
    }
    answerRoot?.remove();
  };
  props.signal.addEventListener("abort", dispose, { once: true });
  try {
    cleanups.push(mountQuestionContent(container, ui, props));
    const document = container.ownerDocument;
    answerRoot = section(document, "lh-explain-back__answer", "Your explanation");
    answerRoot.append(paragraph(document, "lh-explain-back__prose", props.answer.text));
    container.append(answerRoot);
    if (props.grading) cleanups.push(mountGrading(container, props.grading, props.signal));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
