# CLAUDE.md

RSS フィードを収集し LLM で要約して静的 HTML を配信する Cloudflare Worker。

## アーキテクチャ

アプリ本体は `src/index.js` 1 ファイル（約 1500 行）に集約されている。cron（`scheduled`）で
ダイジェストを生成し KV に保存、`fetch` ハンドラが保存済みエディションを HTML でレンダリングする。

- `wrangler dev` — ローカル起動
- `wrangler deploy` — 本番デプロイ
- `npm run test:visual` — Playwright ビジュアルテスト

## `src/index.js` セクションマップ（行番号は目安・編集で前後する）

**全文読みしない。** 該当セクションだけ `offset`/`limit` で読む。

| 行 | セクション | 主なシンボル |
|---|---|---|
| 1–17 | import | |
| 18–86 | フィード定義 | `FEEDS` |
| 87–257 | フィード取得・パース | `jstDateKey` `stripHtml` `fetchFeedItems` `extractLink` `extractPubDate` `pickBodyHtml` |
| 258–407 | プロンプト・スキーマ構築 | `buildSourceContent` `buildInboxContent` `buildPrompt` `buildResponseSchema` |
| 408–557 | LLM 要約 | `summarizeEntries` `summarizeIntoItem` `stripLabelPrefix` `contentFingerprint` |
| 558–576 | エラー整形 | `errorMessage` `recordSourceResult` |
| 577–740 | 生成パイプライン | `processFeedSource` `generateDigest` `retryFailedSources` |
| 741–896 | 永続化・実行ログ | `appendRunLog` `entryKey` `buildEdition` `persistDigest` |
| 897–1095 | HTML 部品 | `escapeHtml` `renderInlineMarkdown` `renderEntryRow` `renderErrorRow` `renderNav` `renderShell` |
| 1096–1264 | ダイジェスト HTML | `renderHtml` |
| 1265–1323 | アーカイブ HTML | `renderArchiveHtml` |
| 1324–1400 | スケジュール・認証 | `isWeeklyRefreshDay` `respondWithEdition` `isAllowedEmailSender` `requireRunSecret` |
| 1401–末尾 | エントリポイント | `export default { scheduled, email, fetch }`（cron ＋ メール受信 ＋ HTTP ルーティング。`/logs` で実行ログ JSON を返す） |
