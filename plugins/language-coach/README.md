# Language coach

Community plugin scaffold for pronunciation coaching: Azure Speech settings, a short
clip recorder, and scripted pronunciation assessment behind a provider-neutral judge
interface. Azure is the only assessment provider wired up today; the judge interface
exists so another provider can be added later without touching the UI.

## Settings

- Azure Speech key and region (backend-only; the UI shows only whether a key is saved).
- Target language: `en-US` or `zh-CN`.
- Learner first language — saved with the coach profile. Teacher prompts that use it
  are planned and are not part of this changeset.

## Development

```sh
npm ci
npm run sdk
npm test
npm run build
```

`npm run sdk` regenerates `.sdk/`, the plugin API type declarations taken from the host
app, so typecheck and the tests run against the current `learnharness-plugin-api`
contract. It only needs re-running when that contract changes.

## Assessment

Recorded clips are 16 kHz mono PCM WAV (encoded by `src/wav-encoder.ts`), at most
30 seconds (`RECORDING_LIMIT_MS` in `src/recorder.ts`). Assessment uses Azure's
short-audio pronunciation endpoint with scripted grading:

- *IPA phoneme grading* (English) — every individual speech sound of the reference text
  is scored separately, using the International Phonetic Alphabet symbols Azure uses
  for the sounds it heard.
- *syllable-level results* (Mandarin) — every syllable of a word is scored separately
  and reported with its pinyin spelling.
