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
      summary:
        "* **Jetpack Composeの5周年記念**: プロトタイプからの歩みを振り返る。\n" +
        "* 通常の箇条書き行はそのまま\n" +
        "* **太字が文中に混ざる**場合もある: 例えばこう。",
    },
    {
      source: "iOS Dev Weekly",
      error: "RSS取得失敗: https://iosdevweekly.com/issues.rss (status 503)",
    },
  ],
};

test("Markdownの太字記法(**text**)がstrongタグとしてレンダリングされ、生の**が残らない", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const items = page.locator(".card").first().locator("li");
  await expect(items).toHaveCount(3);

  // 1行目: 箇条書きマーカー "* " を剥がした上で **text** が <strong> に変換されていること
  const firstItem = items.nth(0);
  await expect(firstItem.locator("strong")).toHaveText("Jetpack Composeの5周年記念");
  await expect(firstItem).not.toContainText("*");

  // 3行目: 文中に太字が混ざるケースも変換されること
  const thirdItem = items.nth(2);
  await expect(thirdItem.locator("strong")).toHaveText("太字が文中に混ざる");
  await expect(thirdItem).not.toContainText("*");

  // ページ全体としてMarkdown記号の生テキストが残っていないこと
  await expect(page.locator("body")).not.toContainText("**");
});

test("通常の箇条書き行は先頭マーカーだけが除去され本文は保持される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const secondItem = page.locator(".card").first().locator("li").nth(1);
  await expect(secondItem).toHaveText("通常の箇条書き行はそのまま");
});

test("取得失敗したソースはエラーカードとして表示される", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const errorCard = page.locator(".card-error");
  await expect(errorCard).toBeVisible();
  await expect(errorCard).toContainText("iOS Dev Weekly");
  await expect(errorCard).toContainText("取得失敗");
});

test("リンクが取得できなかったソースは自己参照アンカー(href=\"\")にならない", async ({ page }) => {
  const digestWithoutLink = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "TLDR AI",
        title: "Some newsletter issue",
        link: "",
        summary: "* 要約テキスト",
      },
    ],
  };
  await page.setContent(renderHtml(digestWithoutLink));

  const heading = page.locator(".card h2").first();
  await expect(heading).toHaveText("TLDR AI");
  await expect(heading.locator("a")).toHaveCount(0);
});

test("staleなソースは前回の内容と注記が表示される", async ({ page }) => {
  const digestWithStale = {
    generatedAt: "2026-08-05T00:00:00.000Z",
    items: [
      {
        source: "Android Weekly",
        title: "Android Weekly Issue #737",
        link: "https://androidweekly.net/issues/issue-737/",
        summary: "* 前回時点の要約",
        generatedAt: "2026-07-29T00:00:00.000Z",
        stale: true,
      },
    ],
  };
  await page.setContent(renderHtml(digestWithStale));

  const card = page.locator(".card").first();
  await expect(card.locator(".card-error")).toHaveCount(0);
  await expect(card).toContainText("前回時点の要約");
  await expect(card.locator(".stale-note")).toContainText("前回");
  await expect(card.locator(".stale-note")).toContainText("の内容を表示中");
});

test("通常のソースには最終更新日が表示される(週次/日次の混在が分かるように)", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));

  const card = page.locator(".card").first();
  await expect(card.locator(".updated-note")).toContainText("更新:");
  await expect(card.locator(".stale-note")).toHaveCount(0);
});

test("ダイジェスト未生成時は案内メッセージが表示される", async ({ page }) => {
  await page.setContent(renderHtml(null));

  await expect(page.locator("body")).toContainText("まだダイジェストが生成されていません");
});

test("見た目のスクリーンショットを撮る", async ({ page }) => {
  await page.setContent(renderHtml(mockDigest));
  await page.screenshot({ path: "tests/__screenshots__/digest.png", fullPage: true });
});
