# Language coach

Community plugin scaffold for pronunciation coaching: speech-provider settings, a short
clip recorder, and scripted pronunciation assessment behind a provider-neutral judge
interface. Azure assesses both target languages; when a TonePerfect key is saved it
assesses Mandarin (`zh-CN`), adding per-syllable initial, final and tone decisions.

## Settings

- Azure Speech key — stored in this plugin's data directory and never handed to the
  frontend; the settings row only shows whether a key is saved.
- TonePerfect key — stored the same way. When it is set and the target language is
  `zh-CN`, Mandarin assessment uses TonePerfect; otherwise Azure assesses the clip.
- Azure Speech region — editable in the settings row, stored next to the key.
- English and Mandarin reference voices — Azure neural voice names, defaulting to
  `en-US-JennyNeural` and `zh-CN-XiaoxiaoNeural`. A blank voice saves the default.
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
  and reported with its pinyin spelling. With a TonePerfect key, each syllable also
  carries its initial, final and tone rows with the expected and heard sound, score and
  the provider's `review` / `uncertain` / `no_correction` decision; the decision, not
  the raw score, is what consumers act on.

## Reference audio

The clip recorder's *Play reference* button synthesizes the entered text with Azure
neural text-to-speech, forcing the pronunciation from bundled dictionary data:

- en-US uses CMUdict, with Arpabet mapped to IPA inside
  `<phoneme alphabet="ipa">` SSML.
- zh-CN uses pinyin-pro, with numeric tones inside `<phoneme alphabet="sapi">` SSML.

A word missing from the dictionary, a missing Azure key or region, and a TTS failure all
return a readable `unavailable` result; the play button is disabled with that reason and
the recorder still works. Successful audio is cached under the plugin data directory
(`reference-audio/`), keyed by a SHA-256 hash of the voice, text and pronunciation. The
cache keeps the newest 64 phrases and evicts the oldest first.

Dependencies: [pinyin-pro](https://github.com/zh-lx/pinyin-pro) (MIT) and
[cmu-pronouncing-dictionary](https://github.com/wooorm/cmu-pronouncing-dictionary)
(ISC, from CMUdict).
