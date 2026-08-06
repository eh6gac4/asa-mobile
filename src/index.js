import { XMLParser } from "fast-xml-parser";

// 取得するRSSフィード一覧。
// mode: "single" -> 週刊フィード。最新1件のみ使用。cronは月曜のみ取得する(isWeeklyRefreshDay参照)
// mode: "multi"  -> 日刊フィード。直近5件を連結して1週間分として扱う。cronは毎日取得する
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
// リンク候補抽出(extractLinkCandidates)の上限。号あたりのリンク数が異常に多いフィード対策。
const MAX_LINK_CANDIDATES = 40;
const GEMINI_MODEL = "gemini-3.6-flash";

// Gemini APIの一時エラー(高負荷時の503等)向けリトライ設定。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * RSS本文のHTML中から <a href="URL">テキスト</a> をリンク候補として抽出する。
 * Geminiに「どの候補が生成したトピックに対応するか」を選ばせるための材料になる
 * (buildPrompt/summarizeEntries参照)。フルDOMパースは過剰なため正規表現で簡易抽出する
 * （stripHtmlと同種の既知の技術的負債: 凝ったマークアップには弱い）。
 */
function extractLinkCandidates(html) {
  const source = String(html ?? "");
  const candidates = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = linkPattern.exec(source)) && candidates.length < MAX_LINK_CANDIDATES) {
    const url = match[1].trim();
    const text = stripHtml(match[2]);
    if (!url || !text) continue;
    if (/^(#|mailto:|javascript:)/i.test(url)) continue;

    const key = `${url} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, url });
  }

  return candidates;
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

/**
 * itemの本文HTMLを選ぶ。description/content:encodedのどちらが本文を持つかは
 * フィードによってまちまち（例: Android Weeklyはdescriptionが本文、iOS Dev Weeklyは
 * descriptionが号のトピック一覧の短い要約文だけで、実際の本文とリンクはcontent:encoded
 * 側にある）。単純に「descriptionが存在すればdescriptionを使う」(旧実装)だと、
 * iOS Dev Weeklyのように存在はするが薄いdescriptionを誤って選んでしまい、
 * extractLinkCandidatesがリンクを一つも拾えなくなる。文字数が長い方＝本文である
 * 可能性が高いという単純なヒューリスティックで選ぶ。
 */
function pickBodyHtml(item) {
  const description = item?.description;
  const encoded = item?.["content:encoded"];
  if (encoded && String(encoded).length > String(description ?? "").length) {
    return encoded;
  }
  return description ?? encoded;
}

/**
 * 1フィード分のGemini入力を組み立てる。modeによってリンクの出所が異なるため
 * 経路を分ける（processFeedSource/summarizeEntries参照）。
 *
 * - mode: "single"（週刊フィード）: 号のHTML本文中に複数記事へのリンクが列挙されている。
 *   extractLinkCandidatesでリンク候補一覧を作り、Geminiにどの候補が生成トピックに
 *   対応するか選ばせる（buildPrompt参照）。号自体のURL(latestLink)はカード見出し用。
 * - mode: "multi"（日刊フィード）: 1 RSS item = 1記事なので、記事単位のURLは
 *   extractLink(item)で確定済み。Geminiにはリンク選択をさせず、見出し・説明文の
 *   生成だけを依頼する（ハルシネーション防止）。TLDR AIには「号」の概念が無いため
 *   latestLinkは空にする（renderHtmlは空なら号リンクを描画しない）。
 */
function buildSourceContent(feed, items) {
  if (feed.mode === "single") {
    const picked = items.slice(0, 1);
    const rawHtml = pickBodyHtml(picked[0]);
    return {
      mode: "single",
      combinedText: stripHtml(rawHtml),
      candidates: extractLinkCandidates(rawHtml),
      latestLink: extractLink(picked[0]),
    };
  }

  const picked = items.slice(0, MULTI_ITEM_LIMIT);
  return {
    mode: "multi",
    multiItems: picked.map((item) => ({
      title: stripHtml(item.title),
      description: stripHtml(pickBodyHtml(item)),
      url: extractLink(item),
    })),
    latestLink: "",
  };
}

function buildPrompt(feed, built) {
  if (built.mode === "single") {
    const candidateLines = built.candidates
      .map((c, i) => `[${i}] ${c.text} — ${c.url}`)
      .join("\n");
    return (
      `以下は「${feed.name}」というニュースレターの直近号の内容です。` +
      `日本語で3〜5個のトピックに整理し、それぞれ見出し(15〜25字程度)と説明(1〜2文、40〜80字程度)を作成してください。` +
      `前置きや結びの文は不要です。\n` +
      `各トピックについて、対応する記事が下記の候補リンク一覧にあれば、最も合致する番号を` +
      `candidateIndexとして選んでください。無理に対応付けず、該当する記事が無ければ` +
      `candidateIndexをnullにしてください。一覧に無いURLを作り出さないでください。\n\n` +
      `# 候補リンク一覧\n${candidateLines || "(候補なし)"}\n\n` +
      `# 本文\n${built.combinedText}`
    );
  }

  const itemLines = built.multiItems
    .map((item, i) => `[${i}] ${item.title}\n${item.description}`)
    .join("\n\n");
  return (
    `以下は「${feed.name}」というニュースレターの直近の記事一覧です。` +
    `各記事について、日本語で見出し(15〜25字程度)と説明(1〜2文、40〜80字程度)を作成してください。` +
    `記事の順序を変えず、記事数ちょうどの件数を出力してください。前置きや結びの文は不要です。\n\n${itemLines}`
  );
}

function buildResponseSchema(built) {
  const properties = {
    headline: { type: "STRING" },
    description: { type: "STRING" },
  };
  if (built.mode === "single") {
    properties.candidateIndex = { type: "INTEGER", nullable: true };
  }
  return {
    type: "ARRAY",
    items: { type: "OBJECT", properties, required: ["headline", "description"] },
  };
}

/**
 * Gemini APIに構造化要約(見出し+説明文の配列)を依頼する。
 *
 * 注意: Gemini 3.x系では temperature / top_p / top_k が廃止されており、
 * generationConfig.thinkingConfig.thinkingLevel で思考量を制御する方式になっている。
 * 古いパラメータは渡さないこと。
 * responseMimeType: "application/json" + responseSchema で構造化出力を強制する
 * （箇条書きテキストのパース処理が不要になる）。
 *
 * 429/5xx (高負荷時の503等)は一時的なエラーとみなし、指数バックオフでリトライする。
 * Retry-Afterヘッダがあればそちらを優先する（上限あり）。
 */
async function summarizeEntries(env, feed, built) {
  const prompt = buildPrompt(feed, built);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          responseMimeType: "application/json",
          responseSchema: buildResponseSchema(built),
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        throw new Error(`Gemini APIレスポンスの形式が想定外 (${feed.name}): ${JSON.stringify(data)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Gemini APIのJSON出力をパースできなかった (${feed.name}): ${raw}`);
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Gemini APIの出力が空または配列でない (${feed.name}): ${raw}`);
      }
      return parsed;
    }

    const errBody = await res.text().catch(() => "");
    lastErr = new Error(`Gemini API失敗 (${feed.name}): status ${res.status} ${errBody}`);

    const retryable = RETRYABLE_STATUS.has(res.status);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw lastErr;
    }

    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const delayMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    await sleep(delayMs);
  }

  throw lastErr;
}

/**
 * 1フィードを取得・構造化要約する。generateDigest/retryFailedSourcesの両方から使う。
 */
async function processFeedSource(env, feed) {
  const items = await fetchFeedItems(feed.url);
  const built = buildSourceContent(feed, items);
  const rawEntries = await summarizeEntries(env, feed, built);

  const entries = rawEntries
    .map((raw, index) => {
      const headline = String(raw?.headline ?? "").trim();
      const description = String(raw?.description ?? "").trim();

      let url = null;
      if (built.mode === "single") {
        const candidateIndex = raw?.candidateIndex;
        if (Number.isInteger(candidateIndex) && built.candidates[candidateIndex]) {
          url = built.candidates[candidateIndex].url || null;
        }
      } else {
        url = built.multiItems[index]?.url || null;
      }

      return { headline, description, url };
    })
    .filter((entry) => entry.headline && entry.description);

  return {
    source: feed.name,
    title: stripHtml(items[0]?.title),
    link: built.latestLink || "",
    entries,
  };
}

/**
 * 指定フィードを取得・要約してKVに保存する。
 * フィード単位でtry/catchし、1つ失敗しても他は続行する。
 *
 * feedsToProcess を渡さない場合は全フィードが対象(手動実行の /run 用)。
 * 渡した場合、対象外のフィード(例: 月曜以外の日のAndroid/iOS Weekly)は
 * 取得を行わず、KVに残っている前回の結果をそのまま引き継ぐ。
 *
 * リトライ後もなお失敗したソースは、KVに残っている前回成功分を代わりに使い
 * (stale: trueを付与)、表示が「取得失敗」で丸ごと潰れないようにする。
 * 前回分も無ければ従来通りエラーを記録する。
 */
async function generateDigest(env, feedsToProcess = FEEDS) {
  const prevRaw = await env.DIGEST_KV.get("latest");
  const prevDigest = prevRaw ? JSON.parse(prevRaw) : null;
  const prevBySource = new Map();
  if (prevDigest) {
    for (const item of prevDigest.items) {
      prevBySource.set(item.source, item);
    }
  }

  const nowISO = new Date().toISOString();
  const targetNames = new Set(feedsToProcess.map((f) => f.name));
  const results = [];

  for (const feed of FEEDS) {
    if (!targetNames.has(feed.name)) {
      // 今回は対象外(例: 週次ソースを非月曜に実行しない)。前回の結果を維持する。
      const prevItem = prevBySource.get(feed.name);
      if (prevItem) results.push(prevItem);
      continue;
    }

    try {
      const fresh = await processFeedSource(env, feed);
      results.push({ ...fresh, generatedAt: nowISO });
    } catch (err) {
      const prevItem = prevBySource.get(feed.name);
      if (prevItem && !prevItem.error) {
        results.push({ ...prevItem, stale: true });
      } else {
        results.push({
          source: feed.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const digest = { generatedAt: nowISO, items: results };

  const dateKey = digest.generatedAt.slice(0, 10); // YYYY-MM-DD
  await env.DIGEST_KV.put("latest", JSON.stringify(digest));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digest));

  return digest;
}

/**
 * 前回の実行で失敗(error)またはフォールバック(stale)扱いだったソースだけを再要約する。
 * 数時間後のリトライ用cronから呼ばれる。全ソースが成功済みなら何もしない
 * (Gemini/RSSを無駄に叩かない)。
 */
async function retryFailedSources(env) {
  const raw = await env.DIGEST_KV.get("latest");
  if (!raw) return null;

  const digest = JSON.parse(raw);
  const needsRetry = digest.items.some((item) => item.error || item.stale);
  if (!needsRetry) return digest;

  const nowISO = new Date().toISOString();
  const updatedItems = [];

  for (const item of digest.items) {
    if (!item.error && !item.stale) {
      updatedItems.push(item);
      continue;
    }

    const feed = FEEDS.find((f) => f.name === item.source);
    if (!feed) {
      updatedItems.push(item);
      continue;
    }

    try {
      const fresh = await processFeedSource(env, feed);
      updatedItems.push({ ...fresh, generatedAt: nowISO });
    } catch {
      // リトライも失敗。既存のerror/staleエントリをそのまま維持する。
      updatedItems.push(item);
    }
  }

  const digestOut = { generatedAt: nowISO, items: updatedItems };
  const dateKey = digestOut.generatedAt.slice(0, 10);
  await env.DIGEST_KV.put("latest", JSON.stringify(digestOut));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digestOut));

  return digestOut;
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

// ソースごとの色分け(CSS変数 --accent-*)に対応するdata-source値。
// 未知のソース名が来ても描画自体は壊れないよう、フォールバックを用意する。
function sourceSlug(sourceName) {
  switch (sourceName) {
    case "Android Weekly":
      return "android";
    case "iOS Dev Weekly":
      return "ios";
    case "TLDR AI":
      return "tldr";
    default:
      return "other";
  }
}

// item.title (例: "Android Weekly Issue #738") から号数だけを取り出す。
// 見つからない場合はtitleをそのまま返す。
function issueLabel(item) {
  const match = item.title?.match(/#\d+/);
  return match ? match[0] : item.title || "";
}

/**
 * 1ソース分(item)を、記事エントリごとの.row要素に展開する。
 * error/stale/通常の3状態と、entry.urlの有無による見出しのリンク/プレーンテキスト分岐がある。
 */
function renderItemRows(item) {
  const slug = sourceSlug(item.source);

  if (item.error) {
    return `
      <div class="row error" data-source="${slug}">
        <span class="node"></span>
        <div class="row-head">
          <span class="badge">${escapeHtml(item.source)}</span>
          <span>・エラー</span>
        </div>
        <span class="headline">取得失敗</span>
        <p class="desc">${escapeHtml(item.error)}</p>
      </div>`;
  }

  if (!item.entries || item.entries.length === 0) return "";

  const dateLabel = item.generatedAt
    ? new Date(item.generatedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "";
  // stale: 最新取得に失敗し、KVに残っていた前回成功分を代わりに表示している。
  const metaHtml = item.stale
    ? `<span class="stale">・前回(${escapeHtml(dateLabel)})を表示中</span>`
    : dateLabel
      ? `<span>・${escapeHtml(dateLabel)}</span>`
      : "";
  // リンク先が取れなかった場合、href="" は現在のページ自身を指してしまうため
  // <a> ではなくリンク自体を描画しない。
  const issueLinkHtml = item.link
    ? `<a class="issue" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(issueLabel(item))}</a>`
    : "";

  return item.entries
    .map((entry) => {
      const headlineText = renderInlineMarkdown(escapeHtml(entry.headline));
      const headlineHtml = entry.url
        ? `<a class="headline" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${headlineText}</a>`
        : `<span class="headline">${headlineText}</span>`;

      return `
      <div class="row" data-source="${slug}">
        <span class="node"></span>
        <div class="row-head">
          <span class="badge">${escapeHtml(item.source)}</span>
          ${issueLinkHtml}
          ${metaHtml}
        </div>
        ${headlineHtml}
        <p class="desc">${renderInlineMarkdown(escapeHtml(entry.description))}</p>
      </div>`;
    })
    .join("\n");
}

export function renderHtml(digest) {
  const generatedAtLabel = digest
    ? new Date(digest.generatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : null;

  const legendHtml = FEEDS.map(
    (feed) =>
      `<span class="item"><span class="dot ${sourceSlug(feed.name)}"></span>${escapeHtml(feed.name)}</span>`,
  ).join("\n          ");

  const body = digest
    ? `<div class="feed">${digest.items.map((item) => renderItemRows(item)).join("\n")}</div>`
    : `<div class="empty-line">まだダイジェストが生成されていません。<code>POST /run</code> で手動実行するか、次回のcron発火を待ってください。</div>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>朝刊モバイル</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: oklch(99% 0.004 95);
    --bg-dark: oklch(15% 0.008 95);
    --ink: oklch(18% 0.01 95);
    --ink-dark: oklch(94% 0.006 95);
    --soft: oklch(48% 0.012 95);
    --soft-dark: oklch(65% 0.012 95);
    --line: oklch(85% 0.008 95);
    --line-dark: oklch(30% 0.01 95);
    --accent-android: oklch(62% 0.15 155);
    --accent-ios: oklch(62% 0.15 255);
    --accent-tldr: oklch(62% 0.15 330);
    --accent-other: oklch(62% 0.15 40);
    --danger: oklch(58% 0.19 25);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--ink); font-family: "Sora", -apple-system, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: var(--bg-dark); color: var(--ink-dark); } }
  a { color: inherit; text-decoration: none; }

  .page { max-width: 620px; margin: 0 auto; padding: 32px clamp(16px, 5vw, 22px) 90px; }

  header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
  header.top h1 { font-family: "Sora", -apple-system, sans-serif; font-size: clamp(16px, 4.4vw, 18px); font-weight: 700; margin: 0; white-space: nowrap; }
  header.top h1::before { content: "📱 "; }
  header.top .ts { font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--soft); white-space: nowrap; }
  @media (prefers-color-scheme: dark) { header.top .ts { color: var(--soft-dark); } }

  .legend { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 16px 0 28px; padding-bottom: 20px; border-bottom: 1px solid var(--line); font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--soft); }
  @media (prefers-color-scheme: dark) { .legend { border-bottom-color: var(--line-dark); color: var(--soft-dark); } }
  .legend .item { display: flex; align-items: center; gap: 6px; }
  .legend .dot { width: 7px; height: 7px; border-radius: 999px; flex: none; }
  .legend .dot.android { background: var(--accent-android); }
  .legend .dot.ios { background: var(--accent-ios); }
  .legend .dot.tldr { background: var(--accent-tldr); }
  .legend .dot.other { background: var(--accent-other); }

  .feed { position: relative; padding-left: 20px; }
  .feed::before { content: ""; position: absolute; left: 4px; top: 8px; bottom: 8px; width: 1px; background: var(--line); }
  @media (prefers-color-scheme: dark) { .feed::before { background: var(--line-dark); } }

  .row { position: relative; margin-bottom: 30px; }
  .row:last-child { margin-bottom: 0; }
  .row .node { position: absolute; left: -20px; top: 6px; width: 9px; height: 9px; border-radius: 999px; border: 2px solid var(--bg); }
  @media (prefers-color-scheme: dark) { .row .node { border-color: var(--bg-dark); } }
  .row[data-source="android"] .node { background: var(--accent-android); }
  .row[data-source="ios"] .node { background: var(--accent-ios); }
  .row[data-source="tldr"] .node { background: var(--accent-tldr); }
  .row[data-source="other"] .node { background: var(--accent-other); }

  .row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--soft); margin-bottom: 10px; }
  @media (prefers-color-scheme: dark) { .row-head { color: var(--soft-dark); } }
  .row-head .badge { font-weight: 600; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--line); line-height: 1.4; }
  @media (prefers-color-scheme: dark) { .row-head .badge { border-color: var(--line-dark); } }
  .row[data-source="android"] .badge { color: var(--accent-android); }
  .row[data-source="ios"] .badge { color: var(--accent-ios); }
  .row[data-source="tldr"] .badge { color: var(--accent-tldr); }
  .row[data-source="other"] .badge { color: var(--accent-other); }
  .row-head a.issue { color: var(--soft); padding: 3px 2px; }
  @media (prefers-color-scheme: dark) { .row-head a.issue { color: var(--soft-dark); } }
  .row-head a.issue:hover { text-decoration: underline; }
  .row-head .stale { color: oklch(58% 0.16 70); }

  .row .headline { display: inline-block; font-size: clamp(15px, 4vw, 16px); font-weight: 600; margin-bottom: 6px; line-height: 1.5; padding: 1px 0; }
  .row a.headline:hover { text-decoration: underline; text-underline-offset: 3px; }
  .row .desc { font-size: 14px; line-height: 1.75; color: var(--soft); margin: 0; max-width: 56ch; }
  @media (prefers-color-scheme: dark) { .row .desc { color: var(--soft-dark); } }

  .row.error .headline { color: var(--danger); }
  .row.error .desc { color: var(--danger); font-family: "JetBrains Mono", monospace; font-size: 12px; }

  .empty-line { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--soft); border: 1px dashed var(--line); border-radius: 6px; padding: 18px; }
  @media (prefers-color-scheme: dark) { .empty-line { color: var(--soft-dark); border-color: var(--line-dark); } }
  .empty-line code { color: var(--ink); background: var(--line); border-radius: 3px; padding: 1px 5px; }
  @media (prefers-color-scheme: dark) { .empty-line code { color: var(--ink-dark); background: var(--line-dark); } }
</style>
</head>
<body>
<div class="page">
<header class="top">
  <h1>朝刊モバイル</h1>
  ${generatedAtLabel ? `<span class="ts">${escapeHtml(generatedAtLabel)}</span>` : ""}
</header>
<div class="legend">
  ${legendHtml}
</div>
${body}
</div>
</body>
</html>`;
}

// リトライ用cron ("0 4 * * *" = 本番cronの4時間後、毎日)。この文字列はwrangler.tomlの
// [triggers].crons と一致させること。
const RETRY_CRON = "0 4 * * *";

/**
 * mode: "single" の週次ソース(Android Weekly / iOS Dev Weekly)を取得してよい日か。
 * 週1回しか新しい号が出ないため、毎日取得しても同じ号を再要約するだけで
 * Gemini呼び出しの無駄になる。月曜(cronは00:00 UTC=9:00 JST)のみ取得する。
 */
function isWeeklyRefreshDay(scheduledTime) {
  return new Date(scheduledTime).getUTCDay() === 1; // 1 = Monday
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === RETRY_CRON) {
      ctx.waitUntil(retryFailedSources(env));
    } else {
      const feedsToProcess = FEEDS.filter(
        (feed) => feed.mode === "multi" || isWeeklyRefreshDay(event.scheduledTime),
      );
      ctx.waitUntil(generateDigest(env, feedsToProcess));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      // 認証なしで公開すると、URLを知っている誰でもこのエンドポイントを叩いて
      // こちらのGemini APIキーでリクエストを消費できてしまう。共有シークレットで保護する。
      if (request.headers.get("x-run-secret") !== env.RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
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
