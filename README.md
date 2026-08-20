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

### 5. `/run` 用のシークレットを登録

`/run` は認証なしで公開するとURLを知る誰でも叩けて、こちらのGemini APIキーを消費されてしまう。
ランダムな値を生成してSecretとして登録する。

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
npx wrangler secret put RUN_SECRET
```

### 6. デプロイ

```bash
npm run deploy
```

### 7. CI自動デプロイ用のCloudflare API Tokenを登録

`main` にpush(=PRマージ)されると `.github/workflows/deploy.yml` が自動で `npm run deploy` を実行する。
[Cloudflareダッシュボード](https://dash.cloudflare.com/profile/api-tokens)で「Edit Cloudflare Workers」
テンプレートからAPI Tokenを発行し、GitHub Secretsに登録する。

```bash
gh secret set CLOUDFLARE_API_TOKEN -R eh6gac4/asa-mobile
```

未登録の場合、mainへのpushのたびにワークフローが失敗する(手動`npm run deploy`には影響しない)。

### 8. 動作確認

cronの発火(毎日5:00 JST。週刊ソースは月曜のみ)を待たずに手動実行できる。
`/run` は3ソースすべてを対象に実行する。`x-run-secret` ヘッダーに手順5で登録した値を渡す。

```bash
curl -X POST https://<デプロイ先のURL>/run -H "x-run-secret: <RUN_SECRETの値>"
```

取得内容が前回と同じソースはGeminiを呼ばずに前回の要約を使い回す(無料枠節約のため)。
強制的に再要約したい場合は `?force=1` を付ける。

```bash
curl -X POST "https://<デプロイ先のURL>/run?force=1" -H "x-run-secret: <RUN_SECRETの値>"
```

以下を確認する:

- 3ソース(Android Weekly / iOS Dev Weekly / TLDR AI)とも要約が生成されるか
- Gemini APIのレスポンス形式が変わっていないか(`data.candidates[0].content.parts[0].text` の構造に依存)

デプロイ先のトップページ (`GET /`) にアクセスすると、最新号がHTMLで表示される。

### 9. 実行ログの確認

各ソースの取得・要約が成功/失敗したかの履歴(直近50件)を確認できる。
`stale`(前回分の使い回し)や`error`になった場合、原因のエラーメッセージも含まれる。
`/run`と同じ`x-run-secret`ヘッダーで保護されている。

```bash
curl https://<デプロイ先のURL>/logs -H "x-run-secret: <RUN_SECRETの値>"
```

## URL構成

朝刊らしく、日付ごとにユニークなURLを持つ「号」として過去に遡れる。

| パス | 内容 |
|---|---|
| `GET /` | 最新号 |
| `GET /YYYY-MM-DD` | その日の号。前号/次号への導線つき |
| `GET /archive` | 発行日一覧(年月ごとにグルーピング) |

1つの号に載るのは「その日の新着分だけ」。Android Weekly / iOS Dev Weeklyは月曜しか更新
されないため、KVの`history:`スナップショットをそのまま出すと同じ記事が何日も並んでしまう。
既出URLを`seen:urls`に記録し、まだ載せていない記事だけを`edition:YYYY-MM-DD`として保存する
仕組みになっている(詳細はHANDOFF.md参照)。新着が1件も無い日は、ソースの取得に失敗していても
号を発行しない(エラーカードだけの朝刊にはならない)。

## ローカル開発

```bash
npm run dev
```

`wrangler dev` はローカルで動作するが、KVやSecretはCloudflare側の設定を参照する
(`wrangler dev --local` を使う場合はローカルKVになるため別途データが必要)。

`.dev.vars` に `GEMINI_API_KEY` と `RUN_SECRET` を書いておくとローカル実行時にそちらが使われる。

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
