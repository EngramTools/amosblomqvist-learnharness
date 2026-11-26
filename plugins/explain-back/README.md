# Explain-back checks

A LearnHarness plugin for **teacher-posed explain-back checks**. After teaching a reasoning
step, the teacher can ask the learner to explain that step in their own words. On submission
a literal reader rebuilds the step from the learner's words only and reports the gaps it
found: missing step, undefined term, wrong order, or a buried conclusion.

The plugin contributes `explain_back` to the **teacher** agent only. It does not add a
prober variant, practice enrollment, or a separate grading service.

## Question contract

The native tool receives the host's `question`, `type` (`predict`/`check`), `nodeId`, and
this payload:

```ts
{
  step: string;       // the reasoning step just taught, as Markdown
  premises: string[]; // the facts it rests on, in order, as the teacher stated them
}
```

The learner sees the prompt, the step, and its premises, and writes a free-text answer.
Dictation appends to the answer as usual. The saved answer is `{ text: string }`, where `text`
must contain non-whitespace explanation.

`gradeAnswer` resolves the session's conversation model from the session settings over the
host catalog's strong-slot default, then calls `ctx.inference.complete` with literal-reader
instructions. The literal reader may not supply a premise, definition, or connection the
learner did not state. It returns versioned JSON:

```ts
{
  version: 1;
  reconstruction: string;
  gaps: { kind: "missing step" | "undefined term" | "wrong order" | "conclusion buried"; detail: string }[];
}
```

If the model call fails or its result is unreadable, the host still saves the answer with a
grading error; the answered card shows that error above the saved explanation. The lesson
continues normally.

## Build and install

```sh
npm run sdk
npm ci
npm run build
npm test
```

The build writes `dist/` with the manifest, browser module, backend module, styles, README
and license. Copy the built package into the plugins directory as `<plugins-directory>/explain-back/dist/`,
refresh the list, and enable it. Building does not install or enable the package.
