# Translations

The source stays in English. Each locale is one catalog, `i18n/<locale>.json`:

```json
{ "<file path>": { "<English source line, trimmed>": "<the same line in that language, trimmed>" } }
```

A source line whose trimmed text equals a key is replaced by the value, keeping its
indentation. Lines without an entry stay in English. A sentence that spans several source
lines maps its first line to the whole translated sentence and each following line to `""`.

## Where the catalog is applied

- **Web UI:** the Vite build applies it to `plugins/web-ui`. `QM_LOCALE` chooses the
  locale (`zh-CN` by default, `en` for none). The tests run with `QM_LOCALE=en`.
- **Everything else** (core, CLI, sign-in, portal, admin) runs from source without a build
  step, so the catalog is applied to an exported copy of the tree, and the images are built
  from that copy:

  ```bash
  mkdir /tmp/qm-localized
  git archive HEAD | tar -x -C /tmp/qm-localized
  npm run i18n:apply -- zh-CN /tmp/qm-localized
  ```

  The command refuses to rewrite a Git checkout. Build and run from the copy; develop and
  test in the checkout.

## Keeping it in step

`npm run i18n:check` lists entries whose English line is no longer in the source. With
`-- zh-CN --strict` it fails when there is any. When a line changes, change its key with it.
