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
  reconstruction: string; // may be "" when the learner's words establish nothing
  gaps: { kind: "missing step" | "undefined term" | "wrong order" | "conclusion buried"; detail: string }[];
  scoring?: // omitted on results saved before scoring existed; present on newly graded answers
    | {
        status: "ok";
        criteria: Record<GapKind, number>; // probability the gap is present, 0 to 1
        fix: { criterion: GapKind; probability: number; wording: string };
      }
    | { status: "unavailable"; reason: string };
}
```

If the literal reader call fails or its result is unreadable, grading fails: the host saves
the answer with a grading error, and the answered card shows that error instead of
reconstruction or gaps. The lesson continues normally. That outcome is separate from criterion
scoring: when the literal reader succeeds but Jev, the fix-wording call, or key configuration
fails, the saved result still includes reconstruction and gaps, and the answered card shows
scoring as `unavailable` with a reason (not a second grading error).

## Criterion scoring and the single fix

With a TypeSafe API key configured, each grade uses up to three model calls on the same
grading path: one session-model call for the literal reader, one HTTP request to Jev
(`POST https://api.typesafe.ai/v1/systemone`, model alias `jev-latest`), and—when Jev
succeeds—a second session-model call that writes the fix wording. The Jev request state is
`{step, premises, explanation, reconstruction, gaps}`; it asks one `noul` question for each
gap criterion and one `choice` question for the single most important fix. The answered card
shows every criterion probability and the chosen fix when scoring status is `ok`.

Jev chooses the criterion and its probability. The session model writes its one- or
two-sentence wording; it never invents the score. A Jev reply over HTTP 4xx or 5xx, a stall
past the 15-second request timeout (scoring `unavailable` with a timeout reason), a malformed
reply, or a failed fix-wording call marks scoring `unavailable` with a reason. The literal
reconstruction and gaps remain unchanged, and no scores or fix are shown. With no key, scoring
is also unavailable; the plugin never substitutes model-produced scores.

The key is stored as `<data>/settings.json` with owner-only permissions. The plugin settings UI
includes a TypeSafe API key field whose note states that learner text is sent to TypeSafe for
scoring. The frontend receives only whether a key exists, so the full key is not rendered in
the UI. Configure data handling with TypeSafe directly.

## Build and install

Run `npm ci` in the repository root first: `npm run sdk` builds the plugin API types from the
root checkout and needs its dependencies installed.

```sh
npm run sdk
npm ci
npm run build
npm test
```

The build writes `dist/` with the manifest, browser module, backend module, styles, README
and license. Copy the built package into the plugins directory as `<plugins-directory>/explain-back/dist/`,
refresh the list, and enable it. Building does not install or enable the package.
From this directory, `node ../../scripts/install-plugin-local.mjs "<plugins-directory>"` copies the built `dist/` into that directory (it does not enable the plugin).