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
  await page.locator("#map .place", { hasText: "UC San Diego" }).click();
  check("place click sets the chart title", (await page.locator("#line-title").textContent()) === "UC San Diego against the coast");
  check("place reading", (await page.locator("#line-caption").textContent()).includes(`UC San Diego was cloudy on ${EXPECT.ucsd8}`));
  check("picked place is marked", (await page.locator("#map .place.on").count()) === 1);
  await page.locator("#map .place", { hasText: "Julian" }).focus();
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
  await page.locator("#map .place", { hasText: "UC San Diego" }).click();
  await page.locator("#hour").fill("4");
  const ucsdNoon = await page.locator("#line-caption").textContent();
  check("UC San Diego at noon", ucsdNoon.includes("cloudy on 50% of days") && ucsdNoon.includes("UC San Diego usually clears by 1 PM"), ucsdNoon);
  // UC San Diego ends within a point of the coast, so the two end labels have to be pushed apart
  const ends = await page.$$eval("#line .end", (ts) => ts.map((t) => t.getBoundingClientRect()).map((r) => [r.top, r.bottom]));
  check("chart end labels do not overlap", ends[0][1] <= ends[1][0] || ends[1][1] <= ends[0][0], JSON.stringify(ends));
  await page.locator("#hour").fill("0");

  // Interaction 5: the year buttons switch the data
  await page.locator("#map .place", { hasText: "El Cajon" }).click();
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
  await phone.locator("#map .place", { hasText: "Ramona" }).tap();
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
  const overlaps = await phone.$$eval("#map .place text", (ts) => {
    const r = ts.map((t) => [t.textContent, t.getBoundingClientRect()]), out = [];
    for (let a = 0; a < r.length; a++) for (let b = a + 1; b < r.length; b++) {
      const [p, q] = [r[a][1], r[b][1]];
      if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) out.push(`${r[a][0]}/${r[b][0]}`);
    }
    return out;
  });
  check("place labels do not overlap on a phone", overlaps.length === 0, overlaps.join(", "));
  await phone.locator("#map .place", { hasText: "UC San Diego" }).tap();
  const clipped = await phone.$$eval("#line text", (ts) => {
    const svg = document.getElementById("line").getBoundingClientRect();
    return ts.filter((t) => { const r = t.getBoundingClientRect(); return r.right > svg.right || r.left < svg.left; }).map((t) => t.textContent);
  });
  check("chart labels fit on a phone", clipped.length === 0, clipped.join(", "));
  await phone.screenshot({ path: join(SHOTS, "phone.png"), fullPage: true });
  await phone.close();

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
