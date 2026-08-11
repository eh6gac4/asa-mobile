import { test, expect } from "@playwright/test";
import {
  renderHtml,
  renderArchiveHtml,
  buildEdition,
  jstDateKey,
  unwrapTrackingUrl,
  extractLinkCandidates,
  contentFingerprint,
} from "../src/index.js";

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

test.describe("buildEdition", () => {
  const digest = {
    generatedAt: "2026-08-07T00:00:00.000Z",
    items: [
      {
        source: "TLDR AI",
        title: "",
        link: "",
        generatedAt: "2026-08-07T00:00:00.000Z",
        entries: [
          { headline: "新着記事", description: "説明。", url: "https://example.com/new", publishedAt: "2026-08-07T00:00:00.000Z" },
          { headline: "既出記事", description: "説明。", url: "https://example.com/old", publishedAt: "2026-08-01T00:00:00.000Z" },
        ],
      },
      {
        source: "iOS Dev Weekly",
        error: "RSS取得失敗",
      },
    ],
  };

  test("既出URLのentryは除外され、未出のentryだけが残る", () => {
    const seenMap = { "https://example.com/old": "2026-08-01" };
    const edition = buildEdition(digest, seenMap, "2026-08-07");

    const tldr = edition.items.find((item) => item.source === "TLDR AI");
    expect(tldr.entries).toHaveLength(1);
    expect(tldr.entries[0].url).toBe("https://example.com/new");
  });

  test("当日分として記録済みのentryはリトライ再実行でも除外されない(冪等性)", () => {
    // 同日中にリトライcronが再実行されるケースを模す:
    // 1回目のpersistDigestで自分自身が既に seenMap[url] = 当日 を記録している状態。
    const seenMap = { "https://example.com/new": "2026-08-07", "https://example.com/old": "2026-08-01" };
    const edition = buildEdition(digest, seenMap, "2026-08-07");

    const tldr = edition.items.find((item) => item.source === "TLDR AI");
    expect(tldr.entries).toHaveLength(1);
    expect(tldr.entries[0].url).toBe("https://example.com/new");
  });

  test("urlがnullのentryはsource+headlineをキーに既出判定される", () => {
    const digestWithNullUrl = {
      generatedAt: "2026-08-07T00:00:00.000Z",
      items: [
        {
          source: "Android Weekly",
          title: "Android Weekly Issue #700",
          link: "",
          entries: [{ headline: "見出しのみ", description: "説明。", url: null, publishedAt: "2026-08-07T00:00:00.000Z" }],
        },
      ],
    };
    const seenMap = { "Android Weekly::見出しのみ": "2026-08-01" };
    const edition = buildEdition(digestWithNullUrl, seenMap, "2026-08-07");

    expect(edition.items).toHaveLength(0);
  });

  test("新着entryがある日はerror itemも号に含まれる", () => {
    const seenMap = { "https://example.com/old": "2026-08-01" };
    const edition = buildEdition(digest, seenMap, "2026-08-07");

    expect(edition.items.some((item) => item.error)).toBe(true);
  });

  test("新着entryが1件も無い日はerror itemだけの号を作らない", () => {
    const seenMap = { "https://example.com/new": "2026-08-01", "https://example.com/old": "2026-08-01" };
    const edition = buildEdition(digest, seenMap, "2026-08-07");

    expect(edition.items).toHaveLength(0);
  });
});

test.describe("contentFingerprint", () => {
  test("同じbuiltからは同じハッシュが返る", async () => {
    const built = { mode: "multi", multiItems: [{ url: "https://example.com/a", publishedAt: "2026-08-01", title: "A" }] };
    const a = await contentFingerprint(built);
    const b = await contentFingerprint(built);
    expect(a).toBe(b);
  });

  test("mode:multiで記事URLが1件変わるとハッシュが変わる", async () => {
    const base = { mode: "multi", multiItems: [{ url: "https://example.com/a", publishedAt: "2026-08-01", title: "A" }] };
    const changed = { mode: "multi", multiItems: [{ url: "https://example.com/b", publishedAt: "2026-08-01", title: "A" }] };
    expect(await contentFingerprint(base)).not.toBe(await contentFingerprint(changed));
  });

  test("mode:singleで本文が変わるとハッシュが変わる", async () => {
    const base = { mode: "single", latestLink: "https://example.com/issue1", publishedAt: "2026-08-01", combinedText: "本文A" };
    const changed = { mode: "single", latestLink: "https://example.com/issue1", publishedAt: "2026-08-01", combinedText: "本文B" };
    expect(await contentFingerprint(base)).not.toBe(await contentFingerprint(changed));
  });

  test("modeが違えば材料が同じでもハッシュが変わる", async () => {
    const single = { mode: "single", latestLink: "", publishedAt: "", combinedText: "x" };
    const multi = { mode: "multi", multiItems: [] };
    expect(await contentFingerprint(single)).not.toBe(await contentFingerprint(multi));
  });
});

test.describe("jstDateKey", () => {
  test("本番cron発火時刻(20:00 UTC)はJST上の翌日として扱われる", () => {
    expect(jstDateKey("2026-08-07T20:00:38.068Z")).toBe("2026-08-08");
  });

  test("リトライcron発火時刻(0:00 UTC)は本番cronと同じ日付に着地する", () => {
    expect(jstDateKey("2026-08-08T00:00:00.000Z")).toBe("2026-08-08");
  });

  test("JST日付境界の直前はまだ前日", () => {
    expect(jstDateKey("2026-08-07T14:59:59.999Z")).toBe("2026-08-07");
  });

  test("JST日付境界ちょうどで日付が繰り上がる", () => {
    expect(jstDateKey("2026-08-07T15:00:00.000Z")).toBe("2026-08-08");
  });
});

test.describe("unwrapTrackingUrl", () => {
  test("TLDRのトラッキングリンクからpercent-encodeされた元URLを復元する", () => {
    const wrapped =
      "https://tracking.tldrnewsletter.com/CL0/https%3A%2F%2Fexample.com%2Farticle%3Futm_source%3Dtldrai/1/0102030405060708090a0b0c0d0e0f10";
    expect(unwrapTrackingUrl(wrapped)).toBe("https://example.com/article?utm_source=tldrai");
  });

  test("ラップされていない素のURLはそのまま返す", () => {
    expect(unwrapTrackingUrl("https://example.com/article")).toBe("https://example.com/article");
  });

  test("元URLを取り出せない場合はラップされたURLをそのまま返す", () => {
    const noEmbeddedUrl = "https://tracking.tldrnewsletter.com/CL0/not-a-url/1/hash";
    expect(unwrapTrackingUrl(noEmbeddedUrl)).toBe(noEmbeddedUrl);
  });

  test("null/undefinedは空文字として扱う", () => {
    expect(unwrapTrackingUrl(null)).toBe("");
    expect(unwrapTrackingUrl(undefined)).toBe("");
  });
});

test.describe("extractLinkCandidates", () => {
  test("unsubscribe等のメールフッタ由来のノイズリンクは候補から除外される", () => {
    const html = `
      <a href="https://example.com/article">興味深い記事のタイトル</a>
      <a href="https://tldr.tech/unsubscribe">unsubscribe</a>
      <a href="https://tldr.tech/preferences">Manage your subscriptions</a>
      <a href="https://tldr.tech/advertise">Advertise with us</a>
    `;
    const candidates = extractLinkCandidates(html);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe("https://example.com/article");
  });

  test("limit引数で候補数の上限を変えられる", () => {
    const html = Array.from(
      { length: 5 },
      (_, i) => `<a href="https://example.com/${i}">記事${i}</a>`,
    ).join("\n");
    expect(extractLinkCandidates(html, 3)).toHaveLength(3);
    expect(extractLinkCandidates(html, 10)).toHaveLength(5);
  });
});

test.describe("前後ナビ", () => {
  const editionDigest = {
    date: "2026-08-07",
    generatedAt: "2026-08-07T00:00:00.000Z",
    items: [
      {
        source: "TLDR AI",
        title: "",
        link: "",
        generatedAt: "2026-08-07T00:00:00.000Z",
        entries: [{ headline: "本日の記事", description: "説明。", url: "https://example.com/a", publishedAt: "2026-08-07T00:00:00.000Z" }],
      },
    ],
  };

  test("前号/次号どちらもある場合は両方のリンクが表示される", async ({ page }) => {
    const nav = { date: "2026-08-07", prevDate: "2026-08-06", nextDate: "2026-08-08", isLatest: false };
    await page.setContent(renderHtml(editionDigest, nav));

    const navEl = page.locator("nav.nav");
    await expect(navEl.locator('a[href="/2026-08-06"]')).toHaveCount(1);
    await expect(navEl.locator('a[href="/2026-08-08"]')).toHaveCount(1);
    await expect(navEl.locator('a[href="/archive"]')).toHaveCount(1);
  });

  test("最新号(次号なし)ではnextのリンクが無効表示になる", async ({ page }) => {
    const nav = { date: "2026-08-07", prevDate: "2026-08-06", nextDate: null, isLatest: true };
    await page.setContent(renderHtml(editionDigest, nav));

    const navEl = page.locator("nav.nav");
    await expect(navEl.locator('a[href="/2026-08-06"]')).toHaveCount(1);
    await expect(navEl.locator("span.disabled")).toHaveCount(1);
  });

  test("日付の見出しラベルが表示される", async ({ page }) => {
    const nav = { date: "2026-08-07", prevDate: null, nextDate: null, isLatest: true };
    await page.setContent(renderHtml(editionDigest, nav));

    await expect(page.locator("header.top .ts")).toContainText("2026-08-07");
  });
});

test("バックナンバー一覧は年月ごとにグルーピングされ、新しい日付から並ぶ", async ({ page }) => {
  await page.setContent(renderArchiveHtml(["2026-08-07", "2026-08-03", "2026-07-31"]));

  const groups = page.locator(".archive-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("2026年8月");
  await expect(groups.nth(0).locator("a")).toHaveCount(2);
  await expect(groups.nth(1)).toContainText("2026年7月");
  await expect(page.locator('a[href="/2026-08-07"]')).toHaveCount(1);
});

test("バックナンバーが無い場合は案内メッセージが表示される", async ({ page }) => {
  await page.setContent(renderArchiveHtml([]));

  await expect(page.locator("body")).toContainText("まだ号がありません");
});
