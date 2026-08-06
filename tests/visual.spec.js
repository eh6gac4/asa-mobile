import { test, expect } from "@playwright/test";
import { renderHtml } from "../src/index.js";

const mockDigest = {
  generatedAt: "2026-08-05T00:00:00.000Z",
  items: [
    {
      source: "Android Weekly",
      title: "Android Weekly Issue #738",
      link: "https://androidweekly.net/issues/issue-738/",
      generatedAt: "2026-08-03T00:00:00.000Z",
      entries: [
        {
          headline: "**Jetpack Composeの5周年記念**",
          description: "プロトタイプからの歩みを振り返る。",
          url: "https://android-developers.googleblog.com/",
          publishedAt: "2026-08-02T10:36:59.000Z",
        },
        {
          headline: "通常の見出しはそのまま",
          description: "**太字が文中に混ざる**場合もある: 例えばこう。",
          url: null,
          publishedAt: "2026-08-02T10:36:59.000Z",
        },
      ],
    },
    {
      source: "iOS Dev Weekly",
      error: "RSS取得失敗: https://iosdevweekly.com/issues.rss (status 503)",
    },
    {
      source: "TLDR AI",
      title: "",
      link: "",
      generatedAt: "2026-08-05T00:00:00.000Z",
      entries: [
        {
          headline: "TLDRの最新トピック",
          description: "配信日が一番新しい記事。",
          url: "https://example.com/tldr-latest",
          publishedAt: "2026-08-05T00:00:00.000Z",
        },
      ],
    },
  ],
};

test("Markdownの太字記法(**text**)がstrongタグとしてレンダリングされ、生の**が残らない", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const rows = page.locator('.row[data-source="android"]');
  await expect(rows).toHaveCount(2);

  // 見出しに太字が混ざるケース
  const firstHeadline = rows.nth(0).locator(".headline");
  await expect(firstHeadline.locator("strong")).toHaveText("Jetpack Composeの5周年記念");
  await expect(firstHeadline).not.toContainText("*");

  // 説明文に太字が混ざるケース
  const secondDesc = rows.nth(1).locator(".desc");
  await expect(secondDesc.locator("strong")).toHaveText("太字が文中に混ざる");
  await expect(secondDesc).not.toContainText("*");

  // ページ全体としてMarkdown記号の生テキストが残っていないこと
  await expect(page.locator("body")).not.toContainText("**");
});

test("元記事URLがあるエントリの見出しはリンクになる", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const firstRow = page.locator('.row[data-source="android"]').nth(0);
  const link = firstRow.locator("a.headline");
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute("href", "https://android-developers.googleblog.com/");
});

test("元記事URLが無いエントリの見出しはリンクにならずプレーンテキストで表示される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const secondRow = page.locator('.row[data-source="android"]').nth(1);
  await expect(secondRow.locator("a.headline")).toHaveCount(0);
  await expect(secondRow.locator("span.headline")).toContainText("通常の見出しはそのまま");
});

test("取得失敗したソースはエラー行として表示される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const errorRow = page.locator(".row.error");
  await expect(errorRow).toBeVisible();
  await expect(errorRow).toContainText("iOS Dev Weekly");
  await expect(errorRow).toContainText("取得失敗");
});

test("号のリンクが取得できなかったソースは自己参照アンカー(href=\"\")にならない", async ({ page }) => {
  const digestWithoutIssueLink = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "TLDR AI",
        title: "",
        link: "",
        generatedAt: "2026-08-05T00:00:00.000Z",
        entries: [{ headline: "要約テキスト", description: "説明文。", url: null, publishedAt: null }],
      },
    ],
  };
  await page.setContent(renderHtml(digestWithoutIssueLink));

  const row = page.locator('.row[data-source="tldr"]');
  await expect(row.locator("a.issue")).toHaveCount(0);
});

test("staleなソースは前回の内容と、前回取得日の注記が表示される", async ({ page }) => {
  const digestWithStale = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "Android Weekly",
        title: "Android Weekly Issue #737",
        link: "https://androidweekly.net/issues/issue-737/",
        generatedAt: "2026-07-29T00:00:00.000Z",
        stale: true,
        entries: [
          {
            headline: "前回時点の要約項目",
            description: "前回時点の説明文。",
            url: null,
            publishedAt: "2026-07-26T11:35:51.000Z",
          },
        ],
      },
    ],
  };
  await page.setContent(renderHtml(digestWithStale));

  const row = page.locator('.row[data-source="android"]');
  await expect(row.locator(".row.error")).toHaveCount(0);
  await expect(row).toContainText("前回時点の要約項目");
  // 日付欄は公開日(7/26)、staleの注記は取得日(7/29)を「前回取得」として表示する
  await expect(row.locator(".row-head")).toContainText("7/26");
  await expect(row.locator(".stale")).toContainText("前回取得");
  await expect(row.locator(".stale")).toContainText("7/29");
});

test("記事には要約日ではなく元記事/号の公開日が表示される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const row = page.locator('.row[data-source="android"]').first();
  // publishedAt(8/2)を表示し、item.generatedAt(8/3, 要約日)は表示しない
  await expect(row.locator(".row-head")).toContainText("8/2");
  await expect(row.locator(".row-head")).not.toContainText("8/3");
  await expect(row.locator(".stale")).toHaveCount(0);
});

test("publishedAtが無い旧スキーマのentryは要約日(generatedAt)にフォールバックして表示される", async ({ page }) => {
  const legacyDigest = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "Android Weekly",
        title: "Android Weekly Issue #738",
        link: "https://androidweekly.net/issues/issue-738/",
        generatedAt: "2026-08-03T00:00:00.000Z",
        entries: [{ headline: "旧スキーマの項目", description: "publishedAtキーが無い。", url: null }],
      },
    ],
  };
  await page.setContent(renderHtml(legacyDigest));

  const row = page.locator('.row[data-source="android"]').first();
  await expect(row.locator(".row-head")).toContainText("8/3");
});

test("記事は公開日の新しい順にソースをまたいでフラットに並ぶ", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  // mockDigestはitems配列ではAndroid Weekly(8/2)→iOS Dev Weekly(エラー)→TLDR AI(8/5)の順だが、
  // 描画上はTLDR AI(8/5)が最新のため一番上に来て、エラー行は末尾にまとまる。
  const rows = page.locator(".row");
  await expect(rows.nth(0)).toHaveAttribute("data-source", "tldr");
  await expect(rows.nth(1)).toHaveAttribute("data-source", "android");
  await expect(rows.nth(2)).toHaveAttribute("data-source", "android");
  await expect(rows.nth(3)).toHaveClass(/error/);
});

test("画面下部に参照元3サイトへのリンクが表示される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const footer = page.locator("footer.sources");
  const links = footer.locator("a");
  await expect(links).toHaveCount(3);
  await expect(footer).toContainText("Android Weekly");
  await expect(footer).toContainText("iOS Dev Weekly");
  await expect(footer).toContainText("TLDR AI");
  await expect(footer.locator('a:has-text("Android Weekly")')).toHaveAttribute(
    "href",
    "https://androidweekly.net/",
  );
  await expect(footer.locator('a:has-text("iOS Dev Weekly")')).toHaveAttribute(
    "href",
    "https://iosdevweekly.com/",
  );
  await expect(footer.locator('a:has-text("TLDR AI")')).toHaveAttribute("href", "https://tldr.tech/ai");
});

test("ダイジェスト未生成時は案内メッセージが表示される", async ({ page }) => {
  await page.setContent(renderHtml(null));

  await expect(page.locator("body")).toContainText("まだダイジェストが生成されていません");
});

test("見た目のスクリーンショットを撮る", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));
  await page.screenshot({ path: "tests/__screenshots__/digest.png", fullPage: true });
});
