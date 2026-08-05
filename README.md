# asa-mobile

Android Weekly / iOS Dev Weekly / TLDR AI のRSSをGeminiで日本語要約し、
Cloudflare Workers上でパブリックなWebページとして公開するツール。個人利用。
TLDR AI(日刊)は毎日、Android Weekly / iOS Dev Weekly(週刊)は月曜のみ更新する。

詳しいアーキテクチャや技術的負債は [`HANDOFF.md`](./HANDOFF.md) を参照。

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. Cloudflareにログイン

```bash
npx wrangler login
```

### 3. KV namespaceを作成

```bash
npx wrangler kv namespace create DIGEST_KV
```

出力された `id` を `wrangler.toml` の `REPLACE_ME_WITH_KV_NAMESPACE_ID` に貼り付ける。

### 4. Gemini APIキーを取得・登録

[Google AI Studio](https://aistudio.google.com/) で無料のAPIキーを取得し、Secretとして登録する。

```bash
npx wrangler secret put GEMINI_API_KEY
```

### 5. デプロイ

```bash
npm run deploy
```

### 6. 動作確認

cronの発火(毎日9:00 JST。週刊ソースは月曜のみ)を待たずに手動実行できる。
`/run` は3ソースすべてを対象に実行する。

```bash
curl -X POST https://<デプロイ先のURL>/run
```

以下を確認する:

- 3ソース(Android Weekly / iOS Dev Weekly / TLDR AI)とも要約が生成されるか
- Gemini APIのレスポンス形式が変わっていないか(`data.candidates[0].content.parts[0].text` の構造に依存)

デプロイ先のトップページ (`GET /`) にアクセスすると、最新のダイジェストがHTMLで表示される。

## ローカル開発

```bash
npm run dev
```

`wrangler dev` はローカルで動作するが、KVやSecretはCloudflare側の設定を参照する
(`wrangler dev --local` を使う場合はローカルKVになるため別途データが必要)。

## 見た目のテスト(Playwright)

`renderHtml()` が生成するHTMLをブラウザに読み込ませて構造・見た目を検証する。
Gemini出力に混ざるMarkdown記法(`**text**`など)が正しく`<strong>`に変換されているか、
というような表示崩れを検知する目的。

初回のみブラウザ本体が要る:

```bash
npx playwright install chromium
```

実行:

```bash
npm run test:visual
```

## ライセンス

個人利用ツールのため特に設定なし。
