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
   - `0 20 * * *`（前日20:00 UTC=毎日5:00 JST）: 本番実行
   - `0 0 * * *`（毎日9:00 JST）: 前回失敗/staleだったソースのみ再試行
2. ソースごとに取得頻度が違う（`src/index.js` の `FEEDS` 配列の `mode` フィールド）:
   - `mode: "single"`（Android Weekly, iOS Dev Weekly）: 週刊フィード。最新1件のみ使用し、
     本番cronでは**JST基準の月曜のみ**取得する（`isWeeklyRefreshDay()`）。本番cronはUTC上は
     前日20:00に発火するため、判定は必ずJSTに変換してから行う。月曜以外はKVの前回値をそのまま維持
   - `mode: "multi"`（TLDR AI）: 日刊フィードなので直近5件を連結し、**毎日**取得・要約する
3. 各ソースのcontentをGemini API（`gemini-3.6-flash`）に投げ、`responseSchema`で構造化出力
   （見出し＋説明文＋元記事URLの配列 `entries`）を強制して日本語要約。429/5xxは指数バックオフで
   最大3回リトライ。週刊ソース(`mode: "single"`)は号のHTML本文から`extractLinkCandidates`で
   リンク候補一覧を作り、Geminiにどの候補が生成トピックに対応するか(`candidateIndex`)を
   選ばせる方式。日刊ソース(`mode: "multi"`)は1 RSS item = 1記事なのでリンクは
   `extractLink(item)`で確定済みとし、Geminiにはリンク選択をさせない（ハルシネーション防止）
   - 各`entries[]`要素は`{ headline, description, url, publishedAt }`。`publishedAt`は
     RSSの`pubDate`をISO化したもので、`extractPubDate()`が抽出する。`mode: "single"`は
     号単位でしか公開日が取れないため、その号の全entryに同じ値をコピーする
   - `processFeedSource()`は要約前に`contentFingerprint()`で取得内容のSHA-256ハッシュを
     取り、前回KVに保存した`item.fingerprint`と一致すればGeminiを呼ばずに前回の要約を
     そのまま使い回す。休刊日や号が未更新の日に同じ内容を毎日要約し直す無駄を防ぐため
     （Gemini無料枠は1日20リクエストしかない）。`/run?force=1`で強制再要約できる
4. 結果をJSON化して **Workers KV** に保存（`latest` キー + `history:YYYY-MM-DD` キーで履歴も保持）
5. 取得・要約に失敗したソースは、KVに残っている前回成功分を `stale: true` 付きで代わりに表示する
   （前回分も無ければ従来通りエラー表示）。13時のリトライcronが失敗/staleソースだけを再試行する
6. `persistDigest()` がKV保存を一手に引き受ける（`generateDigest`/`retryFailedSources`両方から
   呼ぶ共通処理）。`latest`/`history:YYYY-MM-DD`に加えて、以下も更新する:
   - `edition:YYYY-MM-DD` … その日の**新着分だけ**を抜き出した「号」。`buildEdition()`が
     `seen:urls`（entry単位の既出URL台帳、90日でTTL剪定）と突き合わせ、まだ載せていない
     entryだけを残す。週刊ソースは月曜しか号が更新されないため、この差分抽出をしないと
     火〜日に同じ記事が並び続けてしまう。当日分は既出扱いにしないため、同日中にリトライcronが
     再実行されても紙面が空にならない（冪等性）。新着が無い日はeditionを作らない。
     error itemは単独では号を成立させない（`buildEdition()`が新着entryの有無をチェックする）。
     取得失敗ソースがあるだけでエラーカードのみの朝刊が発行されるのを防ぐため
   - `editions` … 号が存在する日付の降順配列。前号/次号ナビと`/archive`の元データ
   - entryのキーは `entry.url`（無ければ`source::headline`。single modeでGeminiが
     `candidateIndex`を対応付けられなかった場合にurlがnullになりうる）
7. `fetch()` ハンドラのルーティング:
   - `GET /` … `editions[0]`（最新の号）。`editions`が空(導入直後)なら`latest`を従来通り表示
   - `GET /YYYY-MM-DD` … 該当日の号。`editions`に無ければ404
   - `GET /archive` … `editions`を年月ごとにグルーピングした一覧
   - 上記以外・GET以外は404
   - 号ページの中身は「ソースごとのブロック」ではなく、全記事を`entry.publishedAt`
     （無ければ`item.generatedAt`にフォールバック）の**降順でフラットに1本のフィード**として
     並べる（新しい記事が上）。エラーになったソースは公開日を持たないためソート対象外とし、
     通常行の後ろにFEEDS順でまとめて表示する。画面下部の`<footer class="sources">`に
     各ソース（`FEEDS[].siteUrl`）への公式サイトリンクを表示
8. `/run` に POST すると全ソースを対象にcronを待たずに即時生成できる（テスト用）。
   `x-run-secret` ヘッダーが `env.RUN_SECRET` と一致しないと401（認証なしで公開すると
   誰でもGemini APIキーを消費できてしまうため）。`?force=1` を付けると
   `contentFingerprint`が一致していても強制的に再要約する

## 見た目のテスト

`npm run test:visual`（Playwright）で `renderHtml()` の出力をブラウザにロードして検証する。
Markdown太字変換、staleカード、リンク欠落時の防御、エラーカードなどをカバー。
サーバー起動やデプロイは不要（`page.setContent()` で完結）。

## 既知の注意点・技術的負債

- **TLDR AIのRSSは非公式ミラー**（`https://bullrich.dev/tldr-rss/ai.rss`）を使用。TLDR公式はメール配信のみでRSSを提供していないため。このミラーが停止・URL変更した場合は動かなくなる。代替手段の検討や死活監視は未実装。
- RSS内のHTMLタグは正規表現で簡易除去しているだけ（`replace(/<[^>]+>/g, " ")`）。凝ったマークアップだと余計な空白やノイズが残る可能性あり。同様に `extractLinkCandidates` も `<a href="...">` を正規表現で拾うだけなので、凝ったマークアップでは候補漏れ・誤抽出が起こり得る。
- 週刊ソースの記事リンクは Gemini が選んだ `candidateIndex` に依存する。プロンプトで「候補に無いURLを作り出さない」よう指示しているが、対応付けを誤る可能性はゼロではない（誤った記事にリンクする、または本来対応する記事があるのに `null` にする）。
  - 実際に本番でiOS Dev Weeklyの5エントリ全てが`candidateIndex: null`になる事例が発生した。原因は候補リンクに広告・イベント告知・購読リンクなど本文と無関係なものが多く混ざっており、`thinkingLevel: "low"`では対応付けを諦めがちだったこと。対策として`extractLinkCandidates`で汎用的な呼びかけ文言（"here"/"register"等、`GENERIC_LINK_TEXT`参照）のリンクを除外し、single modeのみ`thinkingLevel`を`"medium"`に引き上げ、プロンプトにも候補にノイズが混ざる旨を明記した。ただしGemini無料枠は1日20リクエストしかなく、この修正の実効果は次回クォータリセット後でないと本番検証できていない。
- KVの履歴（`history:*`）は生データのバックアップとして書き込むだけで、読み出すUIは無い
  （表示用途は`edition:*`に分離済み）。無期限保持、削除ロジックなし。
- `seen:urls`の既出判定はentry単位（実質ほぼ`entry.url`単位）で、フィード側でURLが変わって
  再配信された場合は既出扱いにできず重複表示される可能性がある。90日でTTL剪定しているため、
  それより古い記事のURLが偶然再利用された場合も同様。
- HTMLは素朴な自前テンプレート。CSSフレームワークやビルドツールは使っていない。
- Gemini無料枠はレート制限が低く、`/run` の連打（テスト目的でも）ですぐ429に達する。テスト時は連続実行しすぎないこと。

## 次にやること（優先順）

1. 数日運用して、TLDR AIが毎日・Android/iOS Weeklyが週次で正しく更新されるか確認
2. （余裕があれば）カスタムドメイン設定、TLDR AIミラーが死んだ時のフォールバック

## 参照した外部情報

- Gemini 3.6 Flash は2026年7月21日GA。モデルID `gemini-3.6-flash`。Gemini 3.x系は `temperature`/`top_p`/`top_k` が廃止され、`generationConfig.thinkingConfig.thinkingLevel` で制御する方式に変更されている点に注意（コード内コメント参照）。
