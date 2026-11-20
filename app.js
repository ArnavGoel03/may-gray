// When Does the May Gray Burn Off? Initial prototype: a cloud share map with an hour slider, linked to a line chart.
// D3 7.9.2 is loaded by index.html from vendor/ as the global `d3`, so the page does not depend on a CDN.
/* global d3 */

// Named places (lat, lon). The coastal ones feed the coastal average; same list and coordinates as the proposal.
const PLACES = {
  "Oceanside": [33.195, -117.379], "Encinitas": [33.037, -117.292], "UC San Diego": [32.880, -117.234],
  "Pacific Beach": [32.797, -117.254], "Downtown": [32.716, -117.161], "Imperial Beach": [32.584, -117.113],
  "Escondido": [33.119, -117.086], "El Cajon": [32.795, -116.962], "Ramona": [33.042, -116.868],
  "Alpine": [32.835, -116.766], "Julian": [33.079, -116.602],
};
const COASTAL = ["Oceanside", "Encinitas", "UC San Diego", "Pacific Beach", "Imperial Beach"];
const MAP_PLACES = ["Oceanside", "UC San Diego", "Downtown", "Escondido", "El Cajon", "Ramona", "Julian"];
const START_PLACE = "El Cajon";               // an inland valley, so the first chart already shows the gap to the coast
const ALL = "all";
const CLEAR_AT = 50;      // a place counts as usually cleared once fewer than half of the days are cloudy at that hour
const PLAY_MS = 900;      // one hour per step while playing: slow enough to read the map, fast enough to feel like motion
const MAP_W = 1010;       // map drawing width in SVG units: 10 units per grid cell
const MID_LAT = 33.05;    // middle of the grid; a degree of longitude is cos(latitude) as wide as a degree of latitude
const HIT_R = 22;         // radius of the invisible press target around a place dot, in map units, at desktop size
const HIT_CSS = 14;       // ...but never under 14 CSS px on screen (a 28 px target for a finger on a phone)
const HIT_MAX = 50;       // ...and never over 50 map units, half the gap between the closest two places (UC San Diego, Downtown)
const DOT_R = 5.5, DOT_CSS = 3.5;  // dot radius in map units, and the smallest it may look on screen, in CSS px
const LABEL_GAP = 4.5;    // map units between a place dot's edge and its label
const DRAG_PX = 6;        // a press that moves further than this before release is a drag, not a pick
const BAR_MAX = 0.3;      // the pinned hour bar may cover at most this share of the window height, else it scrolls away
const BAR_GAP = 8;        // px kept between the pinned bar and whatever a focus or jump scrolls to under it
// A picked place is averaged over the cells within BOX of it (3 x 3). The 0.02 degree grid oversamples the native
// cloud mask pixel (about 4 to 5 km here, so neighbouring cells often repeat one pixel); the box covers about one to
// two real pixels each way, which steadies the reading against a single pixel without averaging across a valley.
const BOX = 1;
// The right margin holds the end labels; 118 fits the longest one ("UC San Diego") in bold at phone text size.
const LINE = { w: 460, h: 330, top: 14, right: 118, bottom: 34, left: 48 };
const LEGEND = { w: 260, h: 40, bar: 10, steps: 60 };

const $ = (id) => document.getElementById(id);
/** A colour token as rgb(): d3 cannot parse the space-separated hsl() the tokens are written in, the browser can. */
function token(name) {
  const probe = document.body.appendChild(document.createElement("i"));
  probe.style.color = `var(${name})`;
  probe.style.forcedColorAdjust = "none";  // in Windows high contrast the probe's colour would be forced to the text colour
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}
const hourLabel = (h) => (h === 12 ? "noon" : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`);
const pct = (v) => `${Math.round(v)}%`;

// tip: the cell under the pointer and where the pointer is, or null when the pointer is off the map
const state = { hour: 0, group: ALL, pick: { name: START_PLACE }, timer: null, tip: null };
let data, color, cellW, cellH, mapH;
window.mayGrayStarted = true;  // read by the load-event check in index.html

init().catch((err) => {
  console.error(err);
  const s = $("status");
  s.textContent = "The cloud data could not be loaded. Reload the page to try again.";
  s.classList.add("error");
  s.hidden = false;
  for (const id of ["timebar", "views"]) $(id).hidden = true;  // no dead controls, and no empty space where they were
});

async function init() {
  // The coastline is decoration: without it the map still reads, so its failure only drops the line.
  const [cloud, coast] = await Promise.all([
    d3.json("data/cloud.json"),
    d3.json("data/coast.json").catch((err) => { console.warn("coastline not loaded", err); return null; }),
  ]);
  data = cloud;
  data.maskedSet = new Set(cloud.masked);
  for (const [name, [lat, lon]] of Object.entries(PLACES)) PLACES[name].cell = cellOf(lat, lon);
  state.pick = { name: START_PLACE, ...at(START_PLACE) };
  color = d3.scaleSequential(d3.interpolateLab(token("--cloud-0"), token("--cloud-100"))).domain([0, 100]);

  buildControls();
  buildMap(coast);
  buildLegend();
  buildLine();
  writeIntro();
  // Shown only once everything is built, so a failure above leaves no half-built controls on screen.
  for (const id of ["timebar", "views"]) $(id).classList.remove("pending");
  // The bar's height depends on width, zoom and font size, so the pin is decided on its measured height.
  // While pinned, focus and jump-link scrolls stop below the bar's real bottom edge, not a fixed guess.
  const pinBar = () => {
    const bar = $("timebar"), root = document.documentElement;
    const pinned = !root.classList.toggle("bar-static", bar.offsetHeight > BAR_MAX * innerHeight);
    root.style.setProperty("--bar-clear", pinned ? `${parseFloat(getComputedStyle(bar).top) + bar.offsetHeight + BAR_GAP}px` : "");
  };
  new ResizeObserver(pinBar).observe($("timebar"));
  addEventListener("resize", pinBar);
  $("status").hidden = true;
  render();
}

// ---- data access -----------------------------------------------------------------------------------------------

function cellOf(lat, lon) {
  return { i: Math.round((lat - data.lat0) / data.step), j: Math.round((lon - data.lon0) / data.step) };
}
function at(name) { return PLACES[name].cell; }
function isMasked(i, j) { return data.maskedSet.has(i * data.nlon + j); }
function latOf(i) { return data.lat0 + i * data.step; }
function lonOf(j) { return data.lon0 + j * data.step; }

/** Share of days cloudy (percent) for one cell, or NaN when the cell has no value. */
function value(group, hour, i, j) {
  const v = data.grids[group][hour][i * data.nlon + j];
  return v === data.noValue ? NaN : (v * 100) / data.scale;
}
/** Mean over the cells within BOX of (i, j) that have a value. */
function boxMean(group, hour, i, j) {
  const vals = [];
  for (let a = Math.max(i - BOX, 0); a <= Math.min(i + BOX, data.nlat - 1); a++) {
    for (let b = Math.max(j - BOX, 0); b <= Math.min(j + BOX, data.nlon - 1); b++) {
      const v = value(group, hour, a, b);
      if (!Number.isNaN(v)) vals.push(v);
    }
  }
  return vals.length ? d3.mean(vals) : NaN;
}
function curve(group, i, j) { return data.hours.map((_, h) => boxMean(group, h, i, j)); }
function coastCurve(group) {
  const curves = COASTAL.map((n) => curve(group, at(n).i, at(n).j));
  return data.hours.map((_, h) => d3.mean(curves, (c) => c[h]));
}
/** When a curve drops under CLEAR_AT and stays there, in words. Judged on the whole percent the page shows, so a
 *  reading of 49.9 that is printed as 50% is not also called cleared. A dip that climbs back to half or more does
 *  not count: clearing is the hour after the last gray one. */
function clearing(c) {
  const first = data.hours[0], last = data.hours[data.hours.length - 1];
  const gray = (v) => Math.round(v) >= CLEAR_AT;
  if (Number.isNaN(c[0])) return `has no reading at ${hourLabel(first)}`;
  if (!gray(c[0])) return `is cloudy on fewer than half of days even at ${hourLabel(first)}`;
  const k = c.findLastIndex(gray);
  return k === c.length - 1 ? `is still gray on most days at ${hourLabel(last)}` : `usually clears by ${hourLabel(data.hours[k + 1])}`;
}
function groupLabel(group) {
  const [a, b] = d3.extent(data.years);
  return group === ALL ? `May and June, ${a} to ${b} (${data.days[ALL]} days)` : `May and June ${group} (${data.days[group]} days)`;
}
function pickLabel() {
  const p = state.pick;
  return p.name ?? `${latOf(p.i).toFixed(2)} N, ${Math.abs(lonOf(p.j)).toFixed(2)} W`;
}

// ---- controls --------------------------------------------------------------------------------------------------

function buildControls() {
  const slider = $("hour");
  slider.max = data.hours.length - 1;
  slider.value = state.hour;
  slider.addEventListener("input", () => { stop(); setHour(+slider.value); });
  const ticks = d3.select("#hour-ticks").selectAll("span").data(data.hours).join("span").text((h) => hourLabel(h));
  // Show every hour if the labels fit, else every 2nd, 4th or 8th (first, middle and last at worst), measured on the
  // real text, so a narrow screen or a large minimum font size never runs them together.
  new ResizeObserver(() => fitTicks(ticks)).observe($("hour-ticks"));

  $("play").addEventListener("click", () => (state.timer ? stop() : play()));

  const opts = [ALL, ...data.years.map(String)];
  const labels = d3.select("#year-radios").selectAll("label").data(opts).join("label");
  labels.append("input").attr("type", "radio").attr("name", "year").attr("value", (d) => d)
    .property("checked", (d) => d === state.group)
    .on("change", (event, d) => { state.group = d; render(); });
  labels.append("span").text((d) => (d === ALL ? "All years" : d));
}

const TICK_GAP = 6;  // px of clear space required between two neighbouring hour labels
function fitTicks(ticks) {
  const nodes = ticks.nodes();
  // each span is zero-width with its text centred over it, so the text's own box is measured
  const textBox = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
  for (const stride of [1, 2, 4, 8]) {
    ticks.style("visibility", (_, k) => (k % stride === 0 || k === nodes.length - 1 ? null : "hidden"));
    const shown = nodes.filter((el) => el.style.visibility !== "hidden").map(textBox);
    if (shown.every((r, k) => k === 0 || r.left >= shown[k - 1].right + TICK_GAP)) return;
  }
  ticks.style("visibility", (_, k) => (k === 0 ? null : "hidden"));  // even two do not fit: the readout above still names the hour
}
function setHour(h) {
  state.hour = h;
  render();
}
function play() {
  // From the last hour, Play starts again at the first.
  if (state.hour >= data.hours.length - 1) setHour(0);
  $("play").textContent = "Pause";
  $("line-caption").setAttribute("aria-live", "off");  // a screen reader should not be read a paragraph every step
  state.timer = setInterval(() => {
    setHour(state.hour + 1);
    if (state.hour >= data.hours.length - 1) stop();
  }, PLAY_MS);
}
function stop() {
  clearInterval(state.timer);
  state.timer = null;
  $("play").textContent = "Play";
  $("line-caption").setAttribute("aria-live", "polite");
}

// ---- map -------------------------------------------------------------------------------------------------------

function buildMap(coast) {
  cellW = MAP_W / data.nlon;
  cellH = cellW / Math.cos((MID_LAT * Math.PI) / 180);
  mapH = cellH * data.nlat;
  const svg = d3.select("#map").attr("viewBox", `0 0 ${MAP_W} ${mapH}`);
  const cells = d3.range(data.nlat * data.nlon);
  // Row 0 is the southernmost latitude, so rows are drawn from the bottom up.
  svg.append("g").attr("class", "cells").selectAll("rect").data(cells).join("rect")
    .attr("x", (k) => x0(k % data.nlon)).attr("y", (k) => y0(Math.floor(k / data.nlon)))
    .attr("width", cellW + 0.5).attr("height", cellH + 0.5)   // half a unit of overlap hides hairline gaps between cells
    .classed("masked", (k) => data.maskedSet.has(k));

  const px = (lon) => ((lon - (data.lon0 - data.step / 2)) / data.step) * cellW;
  const py = (lat) => mapH - ((lat - (data.lat0 - data.step / 2)) / data.step) * cellH;
  const path = d3.line().x((d) => px(d[0])).y((d) => py(d[1]));
  svg.append("clipPath").attr("id", "frame").append("rect").attr("width", MAP_W).attr("height", mapH);
  const lines = svg.append("g").attr("clip-path", "url(#frame)").attr("pointer-events", "none");
  for (const cls of ["coast-halo", "coast"]) {
    lines.append("g").selectAll("path").data(coast?.coordinates ?? []).join("path").attr("class", cls).attr("d", path);
  }

  svg.append("rect").attr("class", "picked-halo");
  svg.append("rect").attr("class", "picked");
  svg.append("rect").attr("class", "hover").attr("width", cellW).attr("height", cellH).attr("visibility", "hidden");

  // Labels sit in their own layer under every dot and press target: on a phone a long label (UC San Diego) reaches
  // into a neighbour's target (El Cajon), and a label drawn on top would steal that press. A label press still picks.
  const placeAt = (n) => `translate(${px(PLACES[n][1])},${py(PLACES[n][0])})`;
  const labels = svg.append("g").selectAll("text").data(MAP_PLACES).join("text")
    .attr("class", "place-label").attr("data-name", (n) => n).attr("aria-hidden", "true")
    .attr("transform", placeAt).attr("dy", "0.35em").attr("x", DOT_R + LABEL_GAP).text((n) => n)
    .on("click", (event, n) => { event.stopPropagation(); pickPlace(n); });
  const places = svg.append("g").selectAll("g").data(MAP_PLACES).join("g")
    .attr("class", "place").attr("data-name", (n) => n).attr("tabindex", 0).attr("role", "button")
    .attr("aria-label", (n) => `Show ${n} in the chart`)
    .attr("transform", placeAt)
    .on("click", (event, n) => { event.stopPropagation(); pickPlace(n); })
    .on("keydown", (event, n) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pickPlace(n); }
    });
  places.append("circle").attr("class", "hit").attr("r", HIT_R);
  places.append("circle").attr("class", "dot").attr("r", DOT_R);
  // On a phone the 1010-unit map is drawn about 360 px wide, so fixed map units would leave a 13 px target and a
  // 2 px dot. Both are resized to a minimum on-screen size whenever the map's width changes.
  new ResizeObserver(() => {
    const scale = $("map").clientWidth / MAP_W;
    if (!scale) return;
    places.select(".hit").attr("r", Math.min(HIT_MAX, Math.max(HIT_R, HIT_CSS / scale)));
    const dot = Math.max(DOT_R, DOT_CSS / scale);
    places.select(".dot").attr("r", dot);
    labels.attr("x", dot + LABEL_GAP);  // the label starts clear of the dot at any size
  }).observe($("map"));

  let press = null;  // where and with what the current press started, to tell a tap from a drag
  svg.on("pointerdown", (event) => { press = { x: event.clientX, y: event.clientY, type: event.pointerType }; })
    .on("pointermove", (event) => { if (event.pointerType !== "touch") trackTip(event); })
    .on("pointerleave", (event) => { if (event.pointerType !== "touch") hideTip(); })
    .on("click", (event) => {
      // A touch drag scrolls the page and never becomes a click, while the browser's touch adjustment can move a
      // real tap's click point several px, so only mouse and pen presses are judged by distance.
      const moved = press && press.type !== "touch" && Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_PX;
      const type = press?.type;
      press = null;  // used once, so a later click with no press of its own is never judged by this one
      if (moved) return;
      const c = cellAt(event);
      if (!c) return;
      state.pick = c;
      render();
      // A touch has no hover, so the tapped cell's reading is shown at the tap until the page scrolls.
      if (type === "touch") trackTip(event);
    });
  // A touch reading has no pointer leaving to end it, so a press anywhere off the map (Play, a year, the page) does.
  document.addEventListener("pointerdown", (event) => { if (state.tip && !event.target.closest("#map")) hideTip(); });
  // The tooltip is fixed to the window, so once the page scrolls it would sit over a different cell.
  addEventListener("scroll", () => { if (state.tip) hideTip(); }, { passive: true });
}
function x0(j) { return j * cellW; }
function y0(i) { return mapH - (i + 1) * cellH; }
function cellAt(event) {
  const [mx, my] = d3.pointer(event, $("map"));
  const j = Math.floor(mx / cellW), i = Math.floor((mapH - my) / cellH);
  return i >= 0 && i < data.nlat && j >= 0 && j < data.nlon ? { i, j } : null;
}
function pickPlace(name) {
  hideTip();  // a reading left from an earlier cell tap would otherwise be redrawn by render()
  state.pick = { name, ...at(name) };
  render();
}

function trackTip(event) {
  const c = cellAt(event);
  if (!c) return hideTip();
  state.tip = { ...c, x: event.clientX, y: event.clientY };
  drawTip();
}
/** Draws the tooltip for state.tip. Also called from render(), so the text follows the hour and the year. */
function drawTip() {
  const t = state.tip;
  if (!t) return;
  d3.select("#map .hover").attr("x", x0(t.j)).attr("y", y0(t.i)).attr("visibility", "visible");
  const v = value(state.group, state.hour, t.i, t.j);
  const where = `${latOf(t.i).toFixed(2)} N, ${Math.abs(lonOf(t.j)).toFixed(2)} W`;
  const what = isMasked(t.i, t.j)
    ? "Not counted: this cell reads far cloudier than its neighbours for several hours of the day."
    : Number.isNaN(v) ? "No reading at this hour."
    : `Cloudy on ${pct(v)} of days at ${hourLabel(data.hours[state.hour])}.`;
  const tip = $("tip");
  tip.replaceChildren(Object.assign(document.createElement("b"), { textContent: where }), what);
  tip.hidden = false;
  // Keep the tooltip inside the window: flip to the other side of the pointer near the right and bottom edges.
  const gap = 14, r = tip.getBoundingClientRect();
  const left = t.x + gap + r.width > innerWidth ? t.x - gap - r.width : t.x + gap;
  const top = t.y + gap + r.height > innerHeight ? t.y - gap - r.height : t.y + gap;
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}
function hideTip() {
  state.tip = null;
  $("tip").hidden = true;
  d3.select("#map .hover").attr("visibility", "hidden");
}

function buildLegend() {
  const { w, h, bar, steps } = LEGEND;
  const svg = d3.select("#legend").attr("viewBox", `0 0 ${w} ${h}`);
  const x = d3.scaleLinear([0, 100], [8, w - 14]);
  svg.append("text").attr("class", "title").attr("x", x(0)).attr("y", 10).text("Share of days cloudy");
  svg.append("g").selectAll("rect").data(d3.range(steps)).join("rect")
    .attr("x", (k) => x((k * 100) / steps)).attr("y", 15).attr("height", bar)
    .attr("width", (x(100) - x(0)) / steps + 0.5).attr("fill", (k) => color(((k + 0.5) * 100) / steps));
  svg.append("g").selectAll("text").data([0, 25, 50, 75, 100]).join("text")
    .attr("x", (d) => x(d)).attr("y", 15 + bar + 12).attr("text-anchor", "middle").text((d) => `${d}%`);
}

// ---- line chart ------------------------------------------------------------------------------------------------

let lx, ly;
function buildLine() {
  const { w, h, top, right, bottom, left } = LINE;
  const svg = d3.select("#line").attr("viewBox", `0 0 ${w} ${h}`);
  lx = d3.scaleLinear([0, data.hours.length - 1], [left, w - right]);
  ly = d3.scaleLinear([0, 100], [h - bottom, top]);

  const grid = svg.append("g").attr("class", "grid");
  for (const t of [0, 25, 75, 100]) {
    grid.append("line").attr("x1", left).attr("x2", w - right).attr("y1", ly(t)).attr("y2", ly(t));
  }
  svg.append("g").selectAll("text").data([0, 25, 50, 75, 100]).join("text")
    .attr("x", left - 6).attr("y", (d) => ly(d)).attr("dy", "0.32em").attr("text-anchor", "end").text((d) => `${d}%`);
  const half = svg.append("g").attr("class", "half");
  half.append("line").attr("x1", left).attr("x2", w - right).attr("y1", ly(CLEAR_AT)).attr("y2", ly(CLEAR_AT));
  half.append("text").attr("x", w - right + 6).attr("y", ly(CLEAR_AT)).attr("dy", "0.32em").text("half of days");
  // Every other hour is labelled, so the labels do not collide when the chart is narrow.
  svg.append("g").selectAll("text").data(data.hours.map((h, k) => ({ h, k })).filter((d) => d.k % 2 === 0)).join("text")
    .attr("x", (d) => lx(d.k)).attr("y", h - bottom + 18).attr("text-anchor", "middle").text((d) => hourLabel(d.h));

  svg.append("line").attr("class", "now").attr("y1", top).attr("y2", h - bottom);
  for (const cls of ["ref", "sel"]) {
    const g = svg.append("g").attr("class", cls);
    g.append("path");
    g.append("circle").attr("r", 4.5);
    g.append("text").attr("class", "end").attr("x", w - right + 6).attr("dy", "0.32em");
  }
  // Pressing anywhere on the chart moves the hour to the nearest one.
  svg.on("click", (event) => {
    const [mx] = d3.pointer(event, $("line"));
    stop();
    setHour(Math.max(0, Math.min(data.hours.length - 1, Math.round(lx.invert(mx)))));
  });
}

// ---- render ----------------------------------------------------------------------------------------------------

function writeIntro() {
  const coast = coastCurve(ALL);
  const first = data.hours[0], k2 = data.hours.indexOf(14);
  const howto = $("howto");
  howto.textContent = `Across ${data.days[ALL]} days of May and June, the coast was cloudy at ${hourLabel(first)} on `
    + `${pct(coast[0])} of days and at ${hourLabel(14)} on ${pct(coast[k2])}. Drag the hour, press Play, or click a place on the map.`;
  howto.hidden = false;
  $("source").textContent = `Source: ${data.source}, ${hourLabel(first)} to ${hourLabel(data.hours[data.hours.length - 1])} `
    + `Pacific Daylight Time, ${groupLabel(ALL)}, on a ${data.step} degree grid. The mask counts any cloud, not only the marine layer. `
    + `Earlier hours are left out because the mask misses much of the low cloud around sunrise, and a few scans are `
    + `missing, so some cells count one or two days fewer. `
    + `Coastline: Natural Earth.`;
}

function render() {
  const { hour, group, pick } = state;
  const h = data.hours[hour];
  $("hour").value = hour;
  $("hour").setAttribute("aria-valuetext", hourLabel(h));
  $("hour-out").textContent = hourLabel(h);

  // map
  const grid = data.grids[group][hour];
  d3.select("#map .cells").selectAll("rect")
    .attr("fill", (k) => (data.maskedSet.has(k) || grid[k] === data.noValue ? null : color((grid[k] * 100) / data.scale)))
    .attr("fill-opacity", (k) => (!data.maskedSet.has(k) && grid[k] === data.noValue ? 0 : null));
  const i0 = Math.max(pick.i - BOX, 0), i1 = Math.min(pick.i + BOX, data.nlat - 1);
  const j0 = Math.max(pick.j - BOX, 0), j1 = Math.min(pick.j + BOX, data.nlon - 1);
  d3.selectAll("#map .picked, #map .picked-halo")
    .attr("x", x0(j0)).attr("y", y0(i1)).attr("width", (j1 - j0 + 1) * cellW).attr("height", (i1 - i0 + 1) * cellH);
  d3.selectAll("#map .place").classed("on", (n) => n === pick.name).attr("aria-pressed", (n) => n === pick.name);
  $("map-caption").textContent = `Share of days each place was cloudy at ${hourLabel(h)}, ${groupLabel(group)}. `
    + `The ocean cells are real readings: the cloud deck sits over the water for most of the day. `
    + `The orange box marks the area drawn in the chart.`
    + (group === ALL ? "" : " A single year is a small sample, so single cells are noisier than in the average.");

  // line chart
  const sel = curve(group, pick.i, pick.j), ref = coastCurve(group);
  const name = pickLabel();
  $("line-title").textContent = `${name} against the coast`;
  const line = d3.line().defined((v) => !Number.isNaN(v)).x((v, k) => lx(k)).y((v) => ly(v));
  d3.select("#line .now").attr("x1", lx(hour)).attr("x2", lx(hour));
  const last = data.hours.length - 1;
  // End labels sit at the end of their line; when the two lines end close together the labels are pushed apart.
  const MIN_GAP = 17;  // one label line (12px text is about 14 units tall) plus breathing room on any font
  let ySel = ly(sel[last]), yRef = ly(ref[last]);
  if (Math.abs(ySel - yRef) < MIN_GAP) {
    const mid = (ySel + yRef) / 2, up = ySel <= yRef ? -1 : 1;
    ySel = mid + (up * MIN_GAP) / 2;
    yRef = mid - (up * MIN_GAP) / 2;
  }
  for (const [cls, c, label, y] of [["ref", ref, "Coast", yRef], ["sel", sel, shortName(name), ySel]]) {
    const g = d3.select(`#line .${cls}`);
    g.select("path").attr("d", line(c));
    g.select("circle").attr("cx", lx(hour)).attr("cy", ly(c[hour])).attr("visibility", Number.isNaN(c[hour]) ? "hidden" : "visible");
    g.select("text").attr("y", Number.isNaN(y) ? ly(0) : y).text(label);
  }
  $("line-caption").textContent = Number.isNaN(sel[hour])
    ? `There is no reading for ${name} at ${hourLabel(h)}.`
    : `At ${hourLabel(h)}, ${name} was cloudy on ${pct(sel[hour])} of days, against ${pct(ref[hour])} at the coast `
      + `(the average of ${COASTAL.length} places from ${COASTAL[0]} to ${COASTAL[COASTAL.length - 1]}). `
      + `${name} ${clearing(sel)}; the coast ${clearing(ref)}.`
      // the afternoon floor is part of the story: the coast stays near 40% from 1 PM on and never fully clears
      + (hour === last || Number.isNaN(sel[last]) ? ""
        : ` At ${hourLabel(data.hours[last])}, ${name} was still cloudy on ${pct(sel[last])} of days and the coast on ${pct(ref[last])}.`)
      + (isMasked(pick.i, pick.j) ? " The picked cell itself is not counted, so this is the average of the cells around it." : "");
  drawTip();
}
/** Chart end labels have little room: a picked cell is labelled by its role, a place by its name. */
function shortName(name) { return state.pick.name ? name : "Picked cell"; }
