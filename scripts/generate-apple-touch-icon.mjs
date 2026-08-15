// apple-touch-icon.png を生成し、src/apple-touch-icon.base64.js に
// Base64文字列として書き出すビルド時スクリプト。
//
// faviconと同じ「タイムラインノードのリング」意匠を使うが、iOS側で角丸マスクが
// 適用されるため背景は円ではなく正方形、かつ透過なしのopaque PNGにする
// (iOSは透過pngの透過部分を黒く塗りつぶすため)。
//
// 実行: node scripts/generate-apple-touch-icon.mjs
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ICON_SIZE = 180; // iPhoneのホーム画面アイコン推奨サイズ(px)

const APPLE_TOUCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" fill="oklch(99% 0.004 95)"/>
<g transform="rotate(-90 50 50)" fill="none" stroke-width="14">
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 155)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="0"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 255)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-50.2655"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 330)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-100.531"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 40)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-150.7964"/>
</g>
<circle cx="50" cy="50" r="12" fill="oklch(18% 0.01 95)"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: ICON_SIZE, height: ICON_SIZE } });
await page.setContent(`<!DOCTYPE html><html><head><style>
html,body{margin:0;padding:0}
svg{display:block;width:${ICON_SIZE}px;height:${ICON_SIZE}px}
</style></head><body>${APPLE_TOUCH_ICON_SVG}</body></html>`);
const pngBuffer = await page.locator("svg").screenshot({ omitBackground: false });
await browser.close();

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "apple-touch-icon.base64.js",
);
const base64 = pngBuffer.toString("base64");
writeFileSync(
  outPath,
  `// scripts/generate-apple-touch-icon.mjs で生成した180x180 PNGのBase64データ。
// アイコン意匠を変更した場合はスクリプトを再実行して再生成すること。
export const APPLE_TOUCH_ICON_PNG_BASE64 = "${base64}";
`,
);
console.log(`Wrote ${outPath} (${pngBuffer.length} bytes PNG, ${base64.length} chars base64)`);
