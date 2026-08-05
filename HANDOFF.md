# HANDOFF: asa-mobile

Claude Codeでこのプロジェクトの続きを作業する人向けの引き継ぎメモ。

## プロジェクト概要

Android Weekly / iOS Dev Weekly / TLDR AI のRSSをGeminiで日本語要約し、
Cloudflare Workers上でパブリックなWebページとして公開するツール。個人利用。

- **自宅サーバーは使わない方針**（Cloudflareのみで完結させる）
- コード・設定一式は `asa-mobile/` ディレクトリにまとまっている

## 現在のステータス

**デプロイ済み・稼働中。** `https://asa-mobile.toshiki-cho-dev.workers.dev`

- Cloudflareログイン・KV namespace作成・Gemini APIキー登録・デプロイは完了済み
- `.dev.vars` にもGemini APIキーをローカル用として保存済み(gitignore対象)

## ファイル構成

```
asa-mobile/
├── wrangler.toml       # Worker設定。cron、KV namespaceバインディング
├── package.json        # 依存: fast-xml-parser（RSS/XMLパース用）、devDependencies: wrangler, @playwright/test
├── src/
│   └── index.js         # Worker本体（RSS取得・要約・HTML配信すべてここ）
├── tests/
│   └── visual.spec.js   # Playwrightによる見た目テスト（renderHtml()の出力を検証）
├── playwright.config.js
└── README.md            # セットアップ・テスト手順
```

## アーキテクチャ

1. **Cron Trigger**（`wrangler.toml` の `[triggers] crons`）が2本ある:
   - `0 0 * * *`（毎日9:00 JST）: 本番実行
   - `0 4 * * *`（毎日13:00 JST）: 前回失敗/staleだったソースのみ再試行
2. ソースごとに取得頻度が違う（`src/index.js` の `FEEDS` 配列の `mode` フィールド）:
   - `mode: "single"`（Android Weekly, iOS Dev Weekly）: 週刊フィード。最新1件のみ使用し、
     本番cronでは**月曜のみ**取得する（`isWeeklyRefreshDay()`）。月曜以外はKVの前回値をそのまま維持
   - `mode: "multi"`（TLDR AI）: 日刊フィードなので直近5件を連結し、**毎日**取得・要約する
3. 各ソースのcontentをGemini API（`gemini-3.6-flash`）に投げて日本語要約。429/5xxは指数バックオフで最大3回リトライ
4. 結果をJSON化して **Workers KV** に保存（`latest` キー + `history:YYYY-MM-DD` キーで履歴も保持）
5. 取得・要約に失敗したソースは、KVに残っている前回成功分を `stale: true` 付きで代わりに表示する
   （前回分も無ければ従来通りエラー表示）。13時のリトライcronが失敗/staleソースだけを再試行する
6. `fetch()` ハンドラがKVから `latest` を読んでHTMLとして描画・返却。各カードには最終更新日を表示
7. `/run` に POST すると全ソースを対象にcronを待たずに即時生成できる（テスト用）。
   `x-run-secret` ヘッダーが `env.RUN_SECRET` と一致しないと401（認証なしで公開すると
   誰でもGemini APIキーを消費できてしまうため）

## 見た目のテスト

`npm run test:visual`（Playwright）で `renderHtml()` の出力をブラウザにロードして検証する。
Markdown太字変換、staleカード、リンク欠落時の防御、エラーカードなどをカバー。
サーバー起動やデプロイは不要（`page.setContent()` で完結）。

## 既知の注意点・技術的負債

- **TLDR AIのRSSは非公式ミラー**（`https://bullrich.dev/tldr-rss/ai.rss`）を使用。TLDR公式はメール配信のみでRSSを提供していないため。このミラーが停止・URL変更した場合は動かなくなる。代替手段の検討や死活監視は未実装。
- RSS内のHTMLタグは正規表現で簡易除去しているだけ（`replace(/<[^>]+>/g, " ")`）。凝ったマークアップだと余計な空白やノイズが残る可能性あり。
- KVの履歴（`history:*`）は書き込むだけで、読み出す/一覧表示するUIがまだない。日次cronになったことで書き込み頻度・件数も増えている（無期限保持、削除ロジックなし）。
- HTMLは素朴な自前テンプレート。CSSフレームワークやビルドツールは使っていない。
- Gemini無料枠はレート制限が低く、`/run` の連打（テスト目的でも）ですぐ429に達する。テスト時は連続実行しすぎないこと。

## 次にやること（優先順）

1. 数日運用して、TLDR AIが毎日・Android/iOS Weeklyが週次で正しく更新されるか確認
2. （余裕があれば）カスタムドメイン設定、履歴ページの追加、TLDR AIミラーが死んだ時のフォールバック

## 参照した外部情報

- Gemini 3.6 Flash は2026年7月21日GA。モデルID `gemini-3.6-flash`。Gemini 3.x系は `temperature`/`top_p`/`top_k` が廃止され、`generationConfig.thinkingConfig.thinkingLevel` で制御する方式に変更されている点に注意（コード内コメント参照）。
