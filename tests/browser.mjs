// End-to-end check of the page in a real browser: the path a grader walks (load, see the map, use each interaction,
// read the write-up). Run `pnpm test` for the local files, or MAY_GRAY_URL=<url> pnpm test for the published page.
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = process.env.MAY_GRAY_SHOTS || join(ROOT, "tests", "shots");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
// Expected readings, taken from the proposal's facts.json (computed there by a separate script from the same cubes).
// The coast at 8 AM is 86.47%, so it shows as 86%; the proposal text says 87% because it rounded 86.5 a second time.
const EXPECT = { cells: 56 * 101, masked: 21, coast8: "86%", coast2: "40%", elCajon8: "76%", ucsd8: "88%", elCajonClears: "10 AM" };
const MIN_SENTENCES = 4;  // rubric: at least 4 sentences for each write-up question
const GRID = { nlat: 56, nlon: 101 };
const MASKED_CELL = { i: 6, j: 42 };  // 32.62 N, 117.16 W, one of the 21 cells left out
const SUBPATH = "/may-gray/";         // GitHub Pages serves the site under this path, so the local server does too

const failures = [];
const check = (name, ok, detail = "") => { if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`); };

let server, baseURL = process.env.MAY_GRAY_URL;
if (!baseURL) {
  server = createServer(async (req, res) => {
    const full = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!full.startsWith(SUBPATH)) { res.writeHead(404); res.end("not found"); return; }
    const path = normalize(full.slice(SUBPATH.length - 1)).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(ROOT, path.endsWith("/") ? `${path}index.html` : path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] || (path.endsWith("/") ? "text/html" : "application/octet-stream") });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${server.address().port}${SUBPATH}`;
}

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const bad = [];
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  const offOrigin = [];
  page.on("request", (r) => { if (new URL(r.url()).origin !== new URL(baseURL).origin) offOrigin.push(r.url()); });

  await page.goto(baseURL, { waitUntil: "networkidle" });
  await page.waitForSelector("#map .cells rect[fill]", { timeout: 15000 });

  // Loaded state
  check("status hidden after load", await page.locator("#status").isHidden());
  check("cell count", (await page.locator("#map .cells rect").count()) === EXPECT.cells);
  check("masked count", (await page.locator("#map .cells rect.masked").count()) === EXPECT.masked);
  const howto = await page.locator("#howto").textContent();
  check("intro numbers", howto.includes(`8 AM on ${EXPECT.coast8}`) && howto.includes(`2 PM on ${EXPECT.coast2}`), howto);
  check("All years is selected at the start", await page.locator('#year-radios input[value="all"]').isChecked());
  check("hour readout starts at 8 AM", (await page.locator("#hour-out").textContent()) === "8 AM");
  const cap0 = await page.locator("#line-caption").textContent();
  check("default place reading", cap0.includes(`El Cajon was cloudy on ${EXPECT.elCajon8}`) && cap0.includes(`${EXPECT.coast8} at the coast`), cap0);
  check("default clearing hour", cap0.includes(`El Cajon usually clears by ${EXPECT.elCajonClears}`), cap0);
  check("caption gives the 4 PM floor", /At 4 PM, El Cajon was still cloudy on \d+% of days and the coast on \d+%\./.test(cap0), cap0);
  // the label wraps the hour readout before the slider, so without for="hour" the slider would have no name
  check("slider is named", (await page.getByRole("slider", { name: "Hour of day" }).count()) === 1);
  await page.screenshot({ path: join(SHOTS, "desktop-8am.png"), fullPage: true });

  // Interaction 1: the hour slider recolours the map and moves the chart
  const fills = () => page.$$eval("#map .cells rect", (rs) => rs.map((r) => r.getAttribute("fill")).join("|"));
  const before = await fills();
  await page.locator("#hour").fill("6");
  check("slider changes hour readout", (await page.locator("#hour-out").textContent()) === "2 PM");
  check("slider recolours the map", (await fills()) !== before);
  check("map uses many colours", new Set((await fills()).split("|")).size > 50);
  check("caption follows the hour", (await page.locator("#map-caption").textContent()).includes("at 2 PM"));
  check("chart caption follows the hour", (await page.locator("#line-caption").textContent()).startsWith("At 2 PM"));
  await page.screenshot({ path: join(SHOTS, "desktop-2pm.png") });

  // Interaction 2: Play advances the hour and stops at the last one; moving the slider pauses it
  await page.locator("#hour").fill("0");
  await page.locator("#play").click();
  check("play button says Pause while playing", (await page.locator("#play").textContent()) === "Pause");
  await page.waitForFunction(() => document.getElementById("hour").value !== "0", null, { timeout: 4000 });
  await page.locator("#hour").fill("3");
  check("slider input pauses play", (await page.locator("#play").textContent()) === "Play");
  await page.waitForTimeout(1200);
  check("hour holds after pause", (await page.locator("#hour").inputValue()) === "3");
  await page.locator("#hour").fill("7");
  await page.locator("#play").click();
  await page.waitForFunction(() => document.getElementById("play").textContent === "Play", null, { timeout: 4000 });
  check("play stops at the last hour", (await page.locator("#hour-out").textContent()) === "4 PM");
  check("caption is announced again after play", (await page.locator("#line-caption").getAttribute("aria-live")) === "polite");
  await page.locator("#play").click();
  check("play from the end restarts at the first hour", (await page.locator("#hour-out").textContent()) === "8 AM");
  await page.locator("#play").click();

  // Interaction 3: picking a place (mouse and keyboard) redraws the chart
  await page.locator("#hour").fill("0");
  await page.locator('#map .place[data-name="UC San Diego"]').click();
  check("place click sets the chart title", (await page.locator("#line-title").textContent()) === "UC San Diego against the coast");
  check("place reading", (await page.locator("#line-caption").textContent()).includes(`UC San Diego was cloudy on ${EXPECT.ucsd8}`));
  check("picked place is marked", (await page.locator("#map .place.on").count()) === 1);
  await page.locator('#map .place[data-name="Julian"]').focus();
  await page.keyboard.press("Enter");
  check("keyboard picks a place", (await page.locator("#line-title").textContent()) === "Julian against the coast");
  check("Julian is not gray at 8 AM", (await page.locator("#line-caption").textContent()).includes("Julian is cloudy on fewer than half of days even at 8 AM"));

  // Interaction 4: clicking any cell picks it; hovering shows a tooltip
  const box = await page.locator("#map").boundingBox();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35);
  check("tooltip shows on hover", await page.locator("#tip").isVisible());
  check("tooltip names the reading", /Cloudy on \d+% of days at 8 AM\./.test(await page.locator("#tip").textContent()));
  await page.locator("#hour").press("ArrowRight");
  check("tooltip follows the hour", /at 9 AM\./.test(await page.locator("#tip").textContent()), await page.locator("#tip").textContent());
  await page.locator("#hour").press("ArrowLeft");
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.35);
  check("cell click sets a coordinate title", /^\d+\.\d\d N, \d+\.\d\d W against the coast$/.test(await page.locator("#line-title").textContent()));
  check("no place marked after a cell click", (await page.locator("#map .place.on").count()) === 0);
  await page.mouse.move(2, 2);
  check("tooltip hides off the map", await page.locator("#tip").isHidden());
  const titleBeforeDrag = await page.locator("#line-title").textContent();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  check("a drag across the map does not pick", (await page.locator("#line-title").textContent()) === titleBeforeDrag);
  await page.mouse.move(2, 2);
  const cellXY = ({ i, j }) => [box.x + ((j + 0.5) / GRID.nlon) * box.width, box.y + (1 - (i + 0.5) / GRID.nlat) * box.height];
  await page.mouse.click(...cellXY(MASKED_CELL));
  check("masked cell tooltip", (await page.locator("#tip").textContent()).includes("Not counted"));
  check("masked cell caption says so", (await page.locator("#line-caption").textContent()).includes("The picked cell itself is not counted"));
  await page.mouse.move(2, 2);

  // A reading printed as 50% is never also called cleared (UC San Diego at noon is 49.9%)
  await page.locator('#map .place[data-name="UC San Diego"]').click();
  await page.locator("#hour").fill("4");
  const ucsdNoon = await page.locator("#line-caption").textContent();
  check("UC San Diego at noon", ucsdNoon.includes("cloudy on 50% of days") && ucsdNoon.includes("UC San Diego usually clears by 1 PM"), ucsdNoon);
  // UC San Diego ends within a point of the coast, so the two end labels have to be pushed apart
  const ends = await page.$$eval("#line .end", (ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
  check("chart end labels do not overlap", ends[0][1] <= ends[1][0] || ends[1][1] <= ends[0][0], JSON.stringify(ends));
  await page.locator("#hour").fill("0");

  // Interaction 5: the year buttons switch the data
  await page.locator('#map .place[data-name="El Cajon"]').click();
  const all = await page.locator("#line-caption").textContent();
  await page.locator("#year-radios label", { hasText: "2023" }).click();
  const y23 = await page.locator("#line-caption").textContent();
  check("year changes the reading", y23 !== all, y23);
  check("year named in the map caption", (await page.locator("#map-caption").textContent()).includes("May and June 2023 (61 days)"));
  await page.locator("#year-radios label", { hasText: "All years" }).click();
  check("back to all years", (await page.locator("#line-caption").textContent()) === all);

  // Pressing the chart sets the hour
  await page.locator("#play").click();
  const now = await page.locator("#line .now").boundingBox();          // the hour rule sits at the first hour
  const tick = await page.locator("#line text", { hasText: "2 PM" }).boundingBox();
  await page.mouse.click(tick.x + tick.width / 2, now.y + now.height / 2);
  check("chart press sets the exact hour", (await page.locator("#hour-out").textContent()) === "2 PM", await page.locator("#hour-out").textContent());
  check("chart press pauses play", (await page.locator("#play").textContent()) === "Play");

  // Write-up: both questions answered with enough sentences
  for (const id of ["done", "hard"]) {
    const text = await page.locator(`#${id}`).textContent();
    const n = text.split(/(?<=[.!?])\s+(?=[A-Z])/).filter((s) => s.trim()).length;
    check(`write-up #${id} has at least ${MIN_SENTENCES} sentences`, n >= MIN_SENTENCES, `${n}`);
  }
  await page.locator(".jump a").click();
  check("write-up link scrolls to the write-up", await page.locator("#w0").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }));
  const body = await page.locator("body").innerText();
  // Dashes are matched by code point (8211 en, 8212 em), so this file holds no literal dash.
  check("no em or en dashes on the page", ![8211, 8212].some((c) => body.includes(String.fromCharCode(c))));
  check("repo link present", (await page.locator('footer a[href="https://github.com/ArnavGoel03/may-gray"]').count()) === 1);

  // Phone width: nothing wider than the screen, map still drawn
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.on("pageerror", (e) => errors.push(`phone: ${e}`));
  await phone.goto(baseURL, { waitUntil: "networkidle" });
  await phone.waitForSelector("#map .cells rect[fill]", { timeout: 15000 });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no sideways scroll on a phone", overflow <= 0, `${overflow}px`);
  await phone.locator('#map .place[data-name="Ramona"]').tap();
  check("tap picks a place", (await phone.locator("#line-title").textContent()) === "Ramona against the coast");
  check("no tooltip left after a tap", await phone.locator("#tip").isHidden());
  // the 1010-unit map is drawn about 360 px wide here, so the place targets are scaled up to stay finger-sized
  const hit = await phone.locator("#map .place .hit").first().boundingBox();
  check("place targets are at least 28 px on a phone", hit.width >= 27.5, `${hit.width}px`);
  const pb = await phone.locator("#map").boundingBox();
  await phone.touchscreen.tap(pb.x + pb.width * 0.5, pb.y + pb.height * 0.15);
  check("a tapped cell shows its reading", await phone.locator("#tip").isVisible());
  await phone.mouse.wheel(0, 300);
  await phone.waitForFunction(() => document.getElementById("tip").hidden, null, { timeout: 2000 }).catch(() => {});
  check("the reading hides when the page scrolls", await phone.locator("#tip").isHidden());
  const tapCell = async () => {
    await phone.locator("#map").scrollIntoViewIfNeeded();
    const m = await phone.locator("#map").boundingBox();
    await phone.touchscreen.tap(m.x + m.width * 0.5, m.y + m.height * 0.15);
  };
  await tapCell();
  await phone.locator('#map .place[data-name="Escondido"]').tap();
  check("a place tap clears an earlier cell reading", await phone.locator("#tip").isHidden());
  await tapCell();
  await phone.locator("#year-radios label", { hasText: "2024" }).tap();
  check("a tap off the map clears the cell reading", await phone.locator("#tip").isHidden());
  // the dot grows on a phone, so each label must still start clear of its dot
  const touching = await phone.$$eval("#map .place", (gs) => gs.filter((g) => {
    const d = g.querySelector(".dot").getBoundingClientRect();
    const t = document.querySelector(`#map .place-label[data-name="${g.dataset.name}"]`).getBoundingClientRect();
    return t.left < d.right;
  }).map((g) => g.dataset.name));
  check("place labels clear their dots on a phone", touching.length === 0, touching.join(", "));
  const overlaps = await phone.$$eval("#map .place-label", (ts) => {
    const r = ts.map((t) => [t.textContent, t.getBoundingClientRect()]), out = [];
    for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
      const [p, q] = [r[a][1], r[b][1]];
      if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) out.push(`${r[a][0]}/${r[b][0]}`);
    }
    return out;
  });
  check("place labels do not overlap on a phone", overlaps.length === 0, overlaps.join(", "));
  await phone.locator('#map .place[data-name="UC San Diego"]').tap();
  const clipped = await phone.$$eval("#line text", (ts) => {
    const svg = document.getElementById("line").getBoundingClientRect();
    return ts.filter((t) => { const r = t.getBoundingClientRect(); return r.right > svg.right || r.left < svg.left; }).map((t) => t.textContent);
  });
  check("chart labels fit on a phone", clipped.length === 0, clipped.join(", "));
  // a neighbour's long label (UC San Diego) reaches into El Cajon's target; labels sit under every target
  const ec = await phone.locator('#map .place[data-name="El Cajon"] .dot').boundingBox();
  const above = await phone.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".place")?.dataset.name, [ec.x + ec.width / 2, ec.y + ec.height / 2 - 11]);
  check("a tap just above El Cajon picks El Cajon", above === "El Cajon", String(above));
  // a jump or focus scroll stops below the pinned bar, which is taller on a phone
  await phone.locator(".jump a").click();
  await phone.waitForTimeout(400);
  const under = await phone.evaluate(() => document.getElementById("w0").getBoundingClientRect().top - document.getElementById("timebar").getBoundingClientRect().bottom);
  check("the write-up heading is not under the pinned bar", under >= 0, `${under}px`);
  await phone.screenshot({ path: join(SHOTS, "phone.png"), fullPage: true });
  await phone.close();

  // Chromium's tap adjustment snaps to the nearest target; a long label must not be one on a touch screen
  const pixel = await browser.newPage({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
  await pixel.goto(baseURL, { waitUntil: "networkidle" });
  await pixel.waitForSelector("#map .cells rect[fill]", { timeout: 15000 });
  await pixel.locator('#map .place[data-name="El Cajon"]').scrollIntoViewIfNeeded();
  for (const name of ["El Cajon", "Ramona"]) {
    const d = await pixel.locator(`#map .place[data-name="${name}"] .dot`).boundingBox();
    await pixel.touchscreen.tap(d.x + d.width / 2, d.y + d.height / 2 - 11);
    check(`a tap just above ${name} picks it`, (await pixel.locator("#line-title").textContent()) === `${name} against the coast`, await pixel.locator("#line-title").textContent());
  }
  await pixel.close();

  // If the script never runs, no blank space is kept for controls that will never come
  for (const [name, opts, block] of [["JavaScript off", { javaScriptEnabled: false }, null], ["app.js blocked", {}, "**/app.js"]]) {
    const dead = await browser.newPage(opts);
    if (block) await dead.route(block, (r) => r.abort());
    await dead.goto(baseURL, { waitUntil: "load" });
    await dead.waitForTimeout(200);
    const shown = await dead.$$eval(".pending", (els) => els.filter((e) => getComputedStyle(e).display !== "none").length);
    check(`no blank space kept with ${name}`, shown === 0, `${shown}`);
    await dead.close();
  }

  // 320 px (a small phone, or 400% zoom): nothing sideways, years all inside the bar, hour labels apart
  const tiny = await browser.newPage({ viewport: { width: 320, height: 568 } });
  await tiny.goto(baseURL, { waitUntil: "networkidle" });
  await tiny.waitForSelector("#map .cells rect[fill]", { timeout: 15000 });
  check("no sideways scroll at 320 px", await tiny.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const fit = await tiny.evaluate(() => {
    const bar = document.getElementById("timebar").getBoundingClientRect();
    const out = [...document.querySelectorAll("#year-radios label")].filter((l) => l.getBoundingClientRect().right > bar.right).map((l) => l.textContent);
    const boxes = [...document.querySelectorAll("#hour-ticks span")].filter((s) => s.style.visibility !== "hidden").map((s) => {
      const r = document.createRange(); r.selectNodeContents(s); return r.getBoundingClientRect();
    });
    const hits = boxes.filter((r, k) => k > 0 && r.left < boxes[k - 1].right).length;
    return { out, hits, shown: boxes.length };
  });
  check("years fit the bar at 320 px", fit.out.length === 0, fit.out.join(", "));
  check("hour labels do not collide at 320 px", fit.hits === 0 && fit.shown >= 2, JSON.stringify(fit));
  await tiny.screenshot({ path: join(SHOTS, "phone-320.png") });
  await tiny.setViewportSize({ width: 640, height: 360 });  // phone held sideways, or 200% zoom
  await tiny.waitForFunction(() => getComputedStyle(document.getElementById("timebar")).position === "static", null, { timeout: 2000 }).catch(() => {});
  check("a tall bar on a short window scrolls away", await tiny.evaluate(() => getComputedStyle(document.getElementById("timebar")).position === "static"));
  await tiny.setViewportSize({ width: 1280, height: 900 });
  await tiny.waitForFunction(() => getComputedStyle(document.getElementById("timebar")).position === "sticky", null, { timeout: 2000 }).catch(() => {});
  check("the bar pins again on a tall window", await tiny.evaluate(() => getComputedStyle(document.getElementById("timebar")).position === "sticky"));
  // The hour readout stays on one line for every hour at every width: a wrapped "10 AM" doubled the bar's height
  // mid-Play and covered the section heading under the pinned bar (found while filming the demo video).
  for (const width of [1280, 900, 641, 640, 401, 400, 320]) {
    await tiny.setViewportSize({ width, height: 900 });
    const out = await tiny.evaluate(() => {
      const o = document.getElementById("hour-out"), s = document.getElementById("hour"), bad = [];
      const h0 = o.getBoundingClientRect().height;
      for (let v = 0; v <= +s.max; v++) {
        s.value = v; s.dispatchEvent(new Event("input"));
        const r = document.createRange(); r.selectNodeContents(o);
        const lines = r.getClientRects().length, box = o.getBoundingClientRect(), text = r.getBoundingClientRect();
        if (lines !== 1 || box.height !== h0 || text.right > box.right + 0.5) bad.push(`${o.textContent}: ${lines} lines, ${box.height}px tall, text ${text.width.toFixed(0)}px in ${box.width.toFixed(0)}px`);
      }
      return bad;
    });
    check(`hour readout fits on one line at ${width} px`, out.length === 0, out.join("; "));
  }
  // A browser minimum font size of 24 px (Firefox setting, low-vision users) enlarges the readout past its column;
  // it must push the slider over, never sit on top of it. Simulated by forcing the size, as CI runs Chromium only.
  const bigFont = await tiny.addStyleTag({ content: "#hour-out { font-size: 24px !important; }" });
  for (const width of [1280, 640, 401]) {
    await tiny.setViewportSize({ width, height: 900 });
    const hit = await tiny.evaluate(() => {
      const o = document.getElementById("hour-out"), s = document.getElementById("hour"), bad = [];
      for (let v = 0; v <= +s.max; v++) {
        s.value = v; s.dispatchEvent(new Event("input"));
        const r = document.createRange(); r.selectNodeContents(o);
        const text = r.getBoundingClientRect(), slider = s.getBoundingClientRect();
        if (r.getClientRects().length !== 1 || text.right > slider.left) bad.push(`${o.textContent}: text ends ${text.right.toFixed(0)}, slider starts ${slider.left.toFixed(0)}`);
      }
      return bad;
    });
    check(`hour readout at a 24 px minimum font clears the slider at ${width} px`, hit.length === 0, hit.join("; "));
  }
  await bigFont.evaluate((el) => el.remove());
  await tiny.close();

  // The page must not jump when the data arrives (Cumulative Layout Shift under 0.1, the "good" threshold)
  const cls = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await cls.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ type: "layout-shift", buffered: true });
  });
  await cls.goto(baseURL, { waitUntil: "networkidle" });
  await cls.waitForSelector("#map .cells rect[fill]", { timeout: 15000 });
  await cls.waitForTimeout(300);
  const shift = await cls.evaluate(() => window.__cls);
  check("no layout jump on load", shift < 0.1, shift.toFixed(3));
  await cls.close();

  // Failure modes: without the cloud data the page says so and shows no dead controls; without the coastline it still works
  const broken = await browser.newPage();
  await broken.route("**/data/cloud.json", (route) => route.abort());
  await broken.goto(baseURL, { waitUntil: "load" });
  await broken.waitForFunction(() => document.getElementById("status").classList.contains("error"), null, { timeout: 10000 });
  check("data failure hides the controls", (await broken.locator("#timebar, #views").count()) === 2
    && (await broken.locator("#timebar").isHidden()) && (await broken.locator("#views").isHidden()));
  await broken.close();
  const noCoast = await browser.newPage();
  await noCoast.route("**/data/coast.json", (route) => route.abort());
  await noCoast.goto(baseURL, { waitUntil: "load" });
  check("map draws without the coastline", await noCoast.waitForSelector("#map .cells rect[fill]", { timeout: 10000 }).then(() => true, () => false));
  await noCoast.close();

  check("no console errors", errors.length === 0, errors.join(" | "));
  check("no failed requests", bad.length === 0, bad.join(" | "));
  check("nothing loaded from another host", offOrigin.length === 0, offOrigin.join(" | "));
} finally {
  await browser.close();
  server?.close();
}

console.log(JSON.stringify({ url: baseURL, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
