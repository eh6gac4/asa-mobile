# HANDOFF: asa-mobile

Claude Codeでこのプロジェクトの続きを作業する人向けの引き継ぎメモ。

## プロジェクト概要

Android Weekly / iOS Dev Weekly / TLDR AI のRSSを毎週まとめてGeminiで日本語要約し、
Cloudflare Workers上でパブリックなWebページとして公開するツール。個人利用。

- **自宅サーバーは使わない方針**（Cloudflareのみで完結させる）
- コード・設定一式は `asa-mobile/` ディレクトリにまとまっている

## 現在のステータス

**未デプロイ。ローカルにコード一式がある状態。** 以下は未実施:
- `wrangler login`
- KV namespace作成
- `wrangler.toml` への namespace ID 反映
- Gemini APIキー取得・`wrangler secret put`
- 実際のデプロイ・動作確認

つまりコードは書けたが、Cloudflare側のセットアップと実機テストがまだ。

## ファイル構成

```
asa-mobile/
├── wrangler.toml       # Worker設定。cron、KV namespaceバインディング
├── package.json        # 依存: fast-xml-parser（RSS/XMLパース用）
├── src/
│   └── index.js         # Worker本体（RSS取得・要約・HTML配信すべてここ）
└── README.md            # セットアップ手順
```

## アーキテクチャ

1. **Cron Trigger**（`wrangler.toml` の `[triggers] crons`）が毎週月曜9:00 JST(00:00 UTC)に `scheduled()` を起動
2. `scheduled()` → `generateDigest()` が3ソースのRSSを取得
3. ソースごとに扱いが違う（`src/index.js` の `FEEDS` 配列の `mode` フィールド）:
   - `mode: "single"`（Android Weekly, iOS Dev Weekly）: 週刊なので最新1件のみ使用
   - `mode: "multi"`（TLDR AI）: 日刊フィードなので直近5件を連結して1週間分として扱う
4. 各ソースのcontentをGemini API（`gemini-3.6-flash`）に投げて日本語要約
5. 結果をJSON化して **Workers KV** に保存（`latest` キー + `history:YYYY-MM-DD` キーで履歴も保持）
6. `fetch()` ハンドラがKVから `latest` を読んでHTMLとして描画・返却
7. `/run` に POST すると cron を待たずに即時生成できる（テスト用）

## 既知の注意点・技術的負債

- **TLDR AIのRSSは非公式ミラー**（`https://bullrich.dev/tldr-rss/ai.rss`）を使用。TLDR公式はメール配信のみでRSSを提供していないため。このミラーが停止・URL変更した場合は動かなくなる。代替手段の検討や死活監視は未実装。
- RSS内のHTMLタグは正規表現で簡易除去しているだけ（`replace(/<[^>]+>/g, " ")`）。凝ったマークアップだと余計な空白やノイズが残る可能性あり。
- エラーハンドリングは各フィード単位（1つ落ちても他は続行）だが、Gemini APIのレート制限に引っかかった場合のリトライは未実装。
- KVの履歴（`history:*`）は書き込むだけで、読み出す/一覧表示するUIがまだない。
- HTMLは素朴な自前テンプレート。CSSフレームワークやビルドツールは使っていない。

## 次にやること（優先順）

1. Cloudflareアカウントで `wrangler login`
2. `wrangler kv namespace create DIGEST_KV` → IDを `wrangler.toml` に反映
3. Google AI Studioで無料Gemini APIキー取得 → `wrangler secret put GEMINI_API_KEY`
4. `npm install` → `npm run deploy`
5. `curl -X POST https://<deployed-url>/run` で手動実行して動作確認
   - 3ソースとも要約が生成されるか
   - Gemini APIのレスポンス形式が変わっていないか（`data.candidates[0].content.parts[0].text` の構造依存）
6. 問題なければcronが実際に週次発火するか、翌週まで待って確認
7. （余裕があれば）カスタムドメイン設定、履歴ページの追加、TLDR AIミラーが死んだ時のフォールバック

## 参照した外部情報

- Gemini 3.6 Flash は2026年7月21日GA。モデルID `gemini-3.6-flash`。Gemini 3.x系は `temperature`/`top_p`/`top_k` が廃止され、`generationConfig.thinkingConfig.thinkingLevel` で制御する方式に変更されている点に注意（コード内コメント参照）。
