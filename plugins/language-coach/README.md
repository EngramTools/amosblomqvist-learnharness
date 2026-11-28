# Language coach

Community plugin scaffold for pronunciation coaching: Azure Speech settings, a short
clip recorder, and scripted pronunciation assessment behind a provider-neutral judge
interface. Azure is the only assessment provider wired up today; the judge interface
keeps the assessment behind one seam, so a second provider can be added there — the
settings UI still names Azure's key and region, so it would need provider settings of
its own.

## Settings

- Azure Speech key — stored in this plugin's data directory and never handed to the
  frontend; the settings row only shows whether a key is saved.
- Azure Speech region — editable in the settings row, stored next to the key.
- Target language: `en-US` or `zh-CN`.
- Learner first language — saved with the coach profile (`coachProfile()` in
  `src/settings-store.ts`). Teacher prompts that use it are planned but not
  implemented yet.

## Development

This plugin lives in a checkout of the LearnHarness app, under `plugins/language-coach`.
`npm run sdk` reads the host app's plugin API sources from the repository root, so the
root checkout and its installed dependencies (`npm ci` in the repository root) have to be
present.

```sh
npm run sdk   # regenerate .sdk/, the plugin API type declarations
npm ci        # install the pinned dev dependencies (needs .sdk/ from the step above)
npm test
npm run build
```

`npm run sdk` regenerates `.sdk/`, the plugin API type declarations taken from the host
app, so typecheck and the tests run against the current `learnharness-plugin-api`
contract. It only needs re-running when that contract changes. The committed
`package-lock.json` pins the dependency versions that `npm ci` installs.

## Assessment

Recorded clips are 16 kHz mono PCM WAV (encoded by `src/wav-encoder.ts`), at most
30 seconds (`RECORDING_LIMIT_MS` in `src/recorder.ts`). Assessment uses Azure's
short-audio pronunciation endpoint with scripted grading:

- *phoneme-level scoring* (English) — every phoneme Azure scored for the reference text
  is listed separately in the International Phonetic Alphabet, with the alternative
  phonemes Azure heard for it.
- *syllable-level scoring* (Mandarin) — every syllable of a word is scored separately
  and reported with its pinyin spelling.
