# Language coach

Community plugin scaffold for pronunciation coaching: Azure Speech settings, a short
clip recorder, and scripted pronunciation assessment behind a provider-neutral judge
interface.

## Settings

- Azure Speech key and region (backend-only; the UI shows only whether a key is saved).
- Target language: `en-US` or `zh-CN`.
- Learner first language (used in later teacher prompts).

## Development

```sh
npm ci
npm run sdk
npm test
npm run build
```

Recorded clips are 16 kHz mono PCM WAV, at most 30 seconds. Assessment uses Azure's
short-audio pronunciation endpoint with scripted IPA phoneme grading for English and
syllable-level results for Mandarin.