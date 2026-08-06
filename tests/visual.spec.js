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
        },
        {
          headline: "通常の見出しはそのまま",
          description: "**太字が文中に混ざる**場合もある: 例えばこう。",
          url: null,
        },
      ],
    },
    {
      source: "iOS Dev Weekly",
      error: "RSS取得失敗: https://iosdevweekly.com/issues.rss (status 503)",
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
        entries: [{ headline: "要約テキスト", description: "説明文。", url: null }],
      },
    ],
  };
  await page.setContent(renderHtml(digestWithoutIssueLink));

  const row = page.locator('.row[data-source="tldr"]');
  await expect(row.locator("a.issue")).toHaveCount(0);
});

test("staleなソースは前回の内容と注記が表示される", async ({ page }) => {
  const digestWithStale = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "Android Weekly",
        title: "Android Weekly Issue #737",
        link: "https://androidweekly.net/issues/issue-737/",
        generatedAt: "2026-07-29T00:00:00.000Z",
        stale: true,
        entries: [{ headline: "前回時点の要約項目", description: "前回時点の説明文。", url: null }],
      },
    ],
  };
  await page.setContent(renderHtml(digestWithStale));

  const row = page.locator('.row[data-source="android"]');
  await expect(row.locator(".row.error")).toHaveCount(0);
  await expect(row).toContainText("前回時点の要約項目");
  await expect(row.locator(".stale")).toContainText("前回");
  await expect(row.locator(".stale")).toContainText("を表示中");
});

test("通常のソースには最終更新日が表示される(週次/日次の混在が分かるように)", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const row = page.locator('.row[data-source="android"]').first();
  await expect(row.locator(".row-head")).toContainText("8/3");
  await expect(row.locator(".stale")).toHaveCount(0);
});

test("ダイジェスト未生成時は案内メッセージが表示される", async ({ page }) => {
  await page.setContent(renderHtml(null));

  await expect(page.locator("body")).toContainText("まだダイジェストが生成されていません");
});

test("見た目のスクリーンショットを撮る", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));
  await page.screenshot({ path: "tests/__screenshots__/digest.png", fullPage: true });
});
