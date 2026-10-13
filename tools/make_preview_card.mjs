// make_preview_card.mjs
//
// The link-preview card (docs/images/preview.png, 1200 x 630, referenced by the
// Open Graph tags in docs/index.html): the CalCOFI logo, title, summary and
// byline over a map from the atlas itself. One card serves every link:
// preview services run no JavaScript, so they never see the map.
//
// It screenshots the atlas served locally, so serve docs/ first:
//   cd docs && python3 -m http.server 8765
// then, from the repository root (needs Node and Playwright with Chromium:
// npm install playwright && npx playwright install chromium):
//   node tools/make_preview_card.mjs [atlas URL] [view (the ?... part of a link)]
// Defaults: http://localhost:8765/ and spring 2005 surface temperature with
// anchovy larvae. Writes docs/images/preview.png.

import { chromium } from "playwright";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGO = join(ROOT, "docs/images/calcofi_logo.png");
const OUT = join(ROOT, "docs/images/preview.png");
const [url = "http://localhost:8765/", view = "taxon=worms%3A272286&stage=larva&sampling=standard&net=CB&view=season" +
  "&layer=hydro&src=bottle&var=temperature&depth=10&overlay=1&season=sequence&shown=spring&year=2005"] = process.argv.slice(2);
const CENTER = [-120.4, 32.9], ZOOM = 5.75;      // the Southern California Bight, to the right of the text

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

// 1. The map alone: no label, logo or controls.
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await page.goto(`${url}?${view}`, { waitUntil: "networkidle" });
await page.waitForTimeout(4500);
await page.evaluate(([center, zoom]) => {
  map.jumpTo({ center, zoom });
  for (const id of ["map-label", "brand-logo"]) document.getElementById(id).style.display = "none";
  document.querySelectorAll(".maplibregl-control-container").forEach((e) => { e.style.display = "none"; });
}, [CENTER, ZOOM]);
await page.waitForTimeout(2500);
const box = await (await page.$(".map-area")).boundingBox();
const mapPng = await page.screenshot({ clip: box });

// 2. The card: text on a white panel fading into the map.
const b64 = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await card.setContent(`<!doctype html><html><head><style>
  body { margin: 0; width: 1200px; height: 630px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  .map { position: absolute; inset: 0; background: url("${b64(mapPng)}") center / cover; }
  .panel { position: absolute; left: 0; top: 0; bottom: 0; width: 470px; box-sizing: border-box; padding: 56px 48px;
           background: linear-gradient(90deg, rgba(255,255,255,0.97) 80%, rgba(255,255,255,0)); }
  img { width: 170px; height: 170px; border-radius: 6px; }
  h1 { margin: 30px 0 10px; font-size: 52px; line-height: 1.05; color: #1f1e1c; }
  p { margin: 0; font-size: 22px; line-height: 1.35; color: #4a4944; }
  .by { margin-top: 22px; font-size: 18px; color: #6b6a64; }
</style></head><body><div class="map"></div><div class="panel">
  <img src="${b64(readFileSync(LOGO))}">
  <h1>CalCOFI Digital Atlas</h1>
  <p>Fish eggs and larvae, temperature, salinity, oxygen, nutrients and water masses, 1949–2026</p>
  <p class="by">Sam McClatchie · fishingmaps.info</p>
</div></body></html>`);
await card.waitForTimeout(800);
await card.screenshot({ path: OUT });
await browser.close();
console.log(`wrote ${OUT}`);
