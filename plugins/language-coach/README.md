# Language coach

Community plugin for pronunciation coaching: speech-provider settings, a short clip
recorder, and scripted pronunciation assessment behind a provider-neutral judge interface.
Azure assesses both target languages; when a TonePerfect key is saved it assesses Mandarin
(`zh-CN`), adding per-syllable initial, final and tone decisions.

## Install from a release zip (no Node toolchain)

Download `language-coach-<version>.zip` from this repository’s GitHub Releases (fork
releases use tags like `language-coach-v<version>`). The archive contains a ready-made
`language-coach/dist/` tree — you do not build from source on the machine running
LearnHarness.

### macOS

1. Open **Settings → Community plugins** and copy the plugins directory path shown there.
   On macOS this lives under your LearnHarness learning-data folder (the same path the
   desktop app displays in Settings).
2. In Finder, unzip the download. Move or merge the extracted `language-coach` folder so
   the installed layout is:

   ```text
   <plugins-directory>/language-coach/dist/manifest.json
   ```

   If you already have `language-coach/data/` from an earlier install, leave that sibling
   `data/` folder in place and replace only `dist/`.
3. Return to **Settings → Community plugins**, click **Refresh**, then enable **Language
   coach**.
4. Restart LearnHarness if you updated a plugin that was already loaded.

No `npm`, compiler, or LearnHarness source checkout is required on this machine.

## Azure and TonePerfect credentials

Open **Language coach** settings (gear on the plugin’s page or **Settings → Community
plugins**).

- **Azure Speech key** — stored in this plugin’s data directory; the UI row only shows
  whether a key is saved. Create a key in the [Azure Speech resource](https://portal.azure.com)
  for your subscription.
- **Azure Speech region** — the Azure region hosting that resource (for example `westus` or
  `eastus`). Recorded clips are sent to Azure for assessment when the target is `en-US`, or
  when the target is `zh-CN` and no TonePerfect key is saved.
- **TonePerfect key** — optional; stored like the Azure key. When it is set and the target
  language is `zh-CN`, Mandarin assessment uses TonePerfect instead of Azure. A saved key
  can be replaced with a new one but cannot be cleared from the settings row (remove it
  from `data/settings.json` if you need to drop it entirely).
- **Target language** — `en-US` or `zh-CN`.
- **Learner first language** — saved with the coach profile; teacher prompts that use it are
  planned but not implemented yet.

## Data and licence attributions

Assessment and reference text use bundled pronunciation lexicons:

- **CMUdict** — English grapheme-to-phoneme reference data (Carnegie Mellon University;
  see `LICENSE` and upstream CMUdict terms for redistribution).
- **pinyin-pro** — Mandarin pinyin and syllable handling bundled into the built plugin
  (`dist/`); follow the pinyin-pro licence included with that dependency in the source tree.

Plugin recordings and assessment results stay in `<plugins-directory>/language-coach/data/`.
They are not sent except to the speech providers you configure (Azure and/or TonePerfect).

## Settings reference

- Azure Speech key — stored in this plugin's data directory and never handed to the
  frontend; the settings row only shows whether a key is saved.
- TonePerfect key — stored the same way. When it is set and the target language is
  `zh-CN`, Mandarin assessment uses TonePerfect; otherwise Azure assesses the clip.
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

To produce the same zip attached to fork releases from a checkout:

```sh
npm run plugins:setup
node ../../scripts/package-language-coach.mjs --output /tmp
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