import { XMLParser } from "fast-xml-parser";

// 取得するRSSフィード一覧。
// mode: "single" -> 週刊フィード。最新1件のみ使用
// mode: "multi"  -> 日刊フィード。直近5件を連結して1週間分として扱う
const FEEDS = [
  {
    name: "Android Weekly",
    url: "https://androidweekly.net/rss.xml",
    mode: "single",
  },
  {
    name: "iOS Dev Weekly",
    url: "https://iosdevweekly.com/issues.rss",
    mode: "single",
  },
  {
    name: "TLDR AI",
    // TLDR公式はメール配信のみでRSSを提供していないため非公式ミラーを使用。
    // ミラーが停止・URL変更した場合はここが動かなくなる（README/HANDOFF参照）。
    url: "https://bullrich.dev/tldr-rss/ai.rss",
    mode: "multi",
  },
];

const MULTI_ITEM_LIMIT = 5;
const GEMINI_MODEL = "gemini-3.6-flash";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // 標準entity(&lt; &gt; &quot; 等)がRSS本文中に大量出現するフィードがあり、
  // デフォルトの上限(1000)だと billion-laughs対策の上限に誤爆する。実測18939件
  // (iOS Dev Weekly)を踏まえ余裕を持った値に引き上げる。
  processEntities: { maxTotalExpansions: 50000 },
});

/**
 * RSS内のHTMLタグを簡易的に除去する。
 * 凝ったマークアップだと余計な空白やノイズが残る可能性がある（既知の技術的負債）。
 */
function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function fetchFeedItems(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "asa-mobile-digest-bot/1.0" },
  });
  if (!res.ok) {
    throw new Error(`RSS取得失敗: ${feedUrl} (status ${res.status})`);
  }
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const items = toArray(parsed?.rss?.channel?.item);
  if (items.length === 0) {
    throw new Error(`RSSにitemが見つからない: ${feedUrl}`);
  }
  return items;
}

/**
 * itemのリンクURLを取り出す。<link> が無いフィード(TLDR AIミラー等)は
 * <guid isPermaLink="true"> にURLを持つため、そちらにフォールバックする。
 */
function extractLink(item) {
  if (typeof item?.link === "string" && item.link) return item.link;
  const linkText = item?.link?.["#text"];
  if (typeof linkText === "string" && linkText) return linkText;
  if (typeof item?.guid === "string" && item.guid) return item.guid;
  const guidText = item?.guid?.["#text"];
  if (typeof guidText === "string" && guidText) return guidText;
  return "";
}

function buildSourceContent(feed, items) {
  const picked = feed.mode === "single" ? items.slice(0, 1) : items.slice(0, MULTI_ITEM_LIMIT);

  const combined = picked
    .map((item) => {
      const title = stripHtml(item.title);
      const description = stripHtml(item.description ?? item["content:encoded"]);
      return `# ${title}\n${description}`;
    })
    .join("\n\n---\n\n");

  return {
    combinedText: combined,
    latestLink: extractLink(picked[0]),
  };
}

/**
 * Gemini APIに要約を依頼する。
 *
 * 注意: Gemini 3.x系では temperature / top_p / top_k が廃止されており、
 * generationConfig.thinkingConfig.thinkingLevel で思考量を制御する方式になっている。
 * 古いパラメータは渡さないこと。
 */
async function summarize(env, sourceName, text) {
  const prompt =
    `以下は「${sourceName}」というニュースレターの直近の内容です。` +
    `日本語で3〜5個の箇条書きに要約してください。前置きや結びの文は不要、箇条書きのみ出力してください。\n\n${text}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: "low" },
      },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini API失敗 (${sourceName}): status ${res.status} ${errBody}`);
  }

  const data = await res.json();
  const summaryText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!summaryText) {
    throw new Error(`Gemini APIレスポンスの形式が想定外 (${sourceName}): ${JSON.stringify(data)}`);
  }
  return summaryText.trim();
}

/**
 * 全フィードを取得・要約してKVに保存する。
 * フィード単位でtry/catchし、1つ失敗しても他は続行する。
 */
async function generateDigest(env) {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeedItems(feed.url);
      const { combinedText, latestLink } = buildSourceContent(feed, items);
      const summary = await summarize(env, feed.name, combinedText);
      results.push({
        source: feed.name,
        title: stripHtml(items[0]?.title),
        link: latestLink,
        summary,
      });
    } catch (err) {
      results.push({
        source: feed.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const digest = {
    generatedAt: new Date().toISOString(),
    items: results,
  };

  const dateKey = digest.generatedAt.slice(0, 10); // YYYY-MM-DD
  await env.DIGEST_KV.put("latest", JSON.stringify(digest));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digest));

  return digest;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Geminiの出力にMarkdownの太字記法(**text**)が混ざることがあるため、
 * エスケープ済みテキストに対してのみ <strong> に変換する。
 */
function renderInlineMarkdown(escapedText) {
  return escapedText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export function renderHtml(digest) {
  const generatedAtLabel = digest
    ? new Date(digest.generatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : null;

  const body = digest
    ? digest.items
        .map((item) => {
          if (item.error) {
            return `
        <section class="card card-error">
          <h2>${escapeHtml(item.source)}</h2>
          <p class="error">取得失敗: ${escapeHtml(item.error)}</p>
        </section>`;
          }
          const summaryHtml = escapeHtml(item.summary)
            .split("\n")
            .filter((line) => line.trim().length > 0)
            // 箇条書きマーカー除去: "-"/"*" は直後にスペースがある場合のみマーカーとみなす。
            // スペース任意にすると "**hoge**" の先頭 "*" だけを誤って剥がしてしまう。
            .map((line) => renderInlineMarkdown(line.replace(/^(?:[-*]\s+|・\s*)/, "")))
            .map((line) => `<li>${line}</li>`)
            .join("");
          // リンク先が取れなかった場合、href="" は現在のページ自身を指してしまうため
          // <a> ではなくプレーンテキストで表示する。
          const sourceHeading = item.link
            ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.source)}</a>`
            : escapeHtml(item.source);
          return `
        <section class="card">
          <h2>${sourceHeading}</h2>
          <p class="original-title">${escapeHtml(item.title)}</p>
          <ul>${summaryHtml}</ul>
        </section>`;
        })
        .join("\n")
    : `<p>まだダイジェストが生成されていません。<code>POST /run</code> で手動実行するか、次回のcron発火を待ってください。</p>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>asa-mobile digest</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .generated-at { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .card h2 a { color: #1a1a1a; text-decoration: none; }
  .original-title { color: #888; font-size: 0.8rem; margin: 0 0 8px; }
  .card ul { margin: 0; padding-left: 1.2em; }
  .card-error { border-left: 4px solid #d33; }
  .error { color: #d33; }
</style>
</head>
<body>
<h1>asa-mobile digest</h1>
${generatedAtLabel ? `<p class="generated-at">最終更新: ${escapeHtml(generatedAtLabel)}</p>` : ""}
${body}
</body>
</html>`;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateDigest(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      const digest = await generateDigest(env);
      return new Response(JSON.stringify(digest, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const raw = await env.DIGEST_KV.get("latest");
    const digest = raw ? JSON.parse(raw) : null;
    return new Response(renderHtml(digest), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
