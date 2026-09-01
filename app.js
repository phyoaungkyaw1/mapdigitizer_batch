/* =========================================================================
   School Building Analyzer – Client-side web app
   All geocoding, building data, and geodesic maths run in the browser.
   External APIs: Nominatim (geocoding), Overpass (building footprints).
   Spreadsheet I/O via SheetJS (loaded from CDN in index.html).
   ========================================================================= */

// ── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  nominatimUrl: "https://nominatim.openstreetmap.org/search",
  overpassUrl:  "https://overpass-api.de/api/interpreter",
  geocodeDelay: 1100,           // ms between Nominatim calls (usage policy)
  geocodeTimeout: 20000,
  overpassTimeout: 90000,
  defaultBuffer: 50,            // metres added around campus bbox
  addressBuffer: 100,
  earthRadius: 6371008.8,       // mean radius in metres (WGS-84)
  sqmToSqft: 10.7639,
  mToFt: 3.28084,
  minBuildingArea: 10,          // sq m – skip smaller artefacts
};

// ── Geodesic Utilities ─────────────────────────────────────────────────────

const RAD = Math.PI / 180;

/** Area of a ring (array of [lon, lat] in degrees) on a sphere, in sq m. */
function ringArea(coords) {
  const n = coords.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % n];
    total += (lon2 - lon1) * RAD * (2 + Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD));
  }
  return Math.abs(total * CONFIG.earthRadius * CONFIG.earthRadius / 2);
}

/** Haversine distance between two [lon, lat] points, in metres. */
function haversine(lon1, lat1, lon2, lat2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return CONFIG.earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Perimeter of a ring (array of [lon, lat]), in metres. */
function ringPerimeter(coords) {
  let total = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[(i + 1) % coords.length];
    total += haversine(lon1, lat1, lon2, lat2);
  }
  return total;
}

/** Ray-casting point-in-ring test. point = [lon, lat], ring = [[lon,lat],...] */
function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Check if a [lon, lat] point is inside a GeoJSON Polygon or MultiPolygon. */
function pointInGeoJSON(point, geojson) {
  if (!geojson) return false;
  const type = geojson.type;
  if (type === "Polygon") {
    return pointInRing(point, geojson.coordinates[0]);
  }
  if (type === "MultiPolygon") {
    return geojson.coordinates.some(poly => pointInRing(point, poly[0]));
  }
  return false;
}

// ── Address Cleaning ───────────────────────────────────────────────────────

function cleanAddress(raw) {
  if (!raw || typeof raw !== "string") return "";
  let addr = raw.split("(")[0].trim();
  addr = addr.replace(/,\s*$/, "");
  const m = addr.match(/\b(\d+\s+\S+)/);
  if (m && m.index > 0) addr = addr.slice(m.index);
  return addr.trim();
}

// ── Nominatim Geocoding ────────────────────────────────────────────────────

async function geocodeLocation(query, signal) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: "5",
    polygon_geojson: "1",
    addressdetails: "1",
  });

  const resp = await fetchWithTimeout(
    `${CONFIG.nominatimUrl}?${params}`,
    { signal },
    CONFIG.geocodeTimeout,
  );
  const results = await resp.json();

  if (!results || results.length === 0) {
    throw new Error(`No results for "${query}"`);
  }

  const areaResults = results.filter(r => {
    const t = r.geojson?.type;
    return t === "Polygon" || t === "MultiPolygon";
  });

  const result = areaResults.length ? areaResults[0] : results[0];

  const bbox = result.boundingbox;       // [south, north, west, east] as strings
  const lat = parseFloat(result.lat);
  const lon = parseFloat(result.lon);
  const bboxValues = bbox
    ? bbox.map(Number)
    : makeBboxAroundPoint(lat, lon, CONFIG.defaultBuffer);

  return {
    displayName: result.display_name || "",
    bbox: bboxValues,
    geojson: result.geojson || null,
    lat,
    lon,
  };
}

function makeBboxAroundPoint(lat, lon, buffer) {
  const latBuf = buffer / 111320;
  const lonScale = 111320 * Math.max(Math.cos(lat * RAD), 0.01);
  const lonBuf = buffer / lonScale;
  return [lat - latBuf, lat + latBuf, lon - lonBuf, lon + lonBuf];
}

// ── Overpass API ───────────────────────────────────────────────────────────

function buildOverpassQuery(bbox, bufferMetres) {
  let [south, north, west, east] = bbox;
  const latBuf = bufferMetres / 111320;
  const lonBuf = bufferMetres / (111320 * Math.cos(((south + north) / 2) * RAD));
  south -= latBuf;
  north += latBuf;
  west -= lonBuf;
  east += lonBuf;
  const b = `${south},${west},${north},${east}`;
  return `[out:json][timeout:60];(way["building"](${b});relation["building"](${b}););out body;>;out skel qt;`;
}

async function fetchBuildings(locationData, signal) {
  const buffer = CONFIG.defaultBuffer;
  const query = buildOverpassQuery(locationData.bbox, buffer);

  const resp = await fetchWithTimeout(
    CONFIG.overpassUrl,
    {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal,
    },
    CONFIG.overpassTimeout,
  );
  const data = await resp.json();
  return parseOsmElements(data.elements || []);
}

function parseOsmElements(elements) {
  const nodes = {};
  const ways = {};
  const relations = [];

  for (const el of elements) {
    if (el.type === "node")     nodes[el.id] = [el.lon, el.lat];
    else if (el.type === "way") ways[el.id] = el;
    else if (el.type === "relation") relations.push(el);
  }

  const buildings = [];

  for (const id in ways) {
    const way = ways[id];
    const tags = way.tags || {};
    if (!("building" in tags)) continue;

    const coords = (way.nodes || []).map(nid => nodes[nid]).filter(Boolean);
    if (coords.length < 4) continue;

    try {
      if (ringArea(coords) > 0) {
        buildings.push({ ring: coords, tags });
      }
    } catch (_) { /* skip malformed */ }
  }

  for (const rel of relations) {
    const tags = rel.tags || {};
    if (!("building" in tags)) continue;

    const outerRings = [];
    for (const member of (rel.members || [])) {
      if (member.type !== "way" || !ways[member.ref]) continue;
      const w = ways[member.ref];
      const coords = (w.nodes || []).map(nid => nodes[nid]).filter(Boolean);
      if (coords.length >= 4 && member.role === "outer") {
        outerRings.push(coords);
      }
    }
    for (const ring of outerRings) {
      try {
        if (ringArea(ring) > 0) buildings.push({ ring, tags });
      } catch (_) { /* skip */ }
    }
  }

  return buildings;
}

// ── Building Filtering & Processing ────────────────────────────────────────

function filterByBoundary(buildings, geojson) {
  if (!geojson || (geojson.type !== "Polygon" && geojson.type !== "MultiPolygon")) {
    return buildings;
  }
  const filtered = buildings.filter(b => {
    const centroid = ringCentroid(b.ring);
    return pointInGeoJSON(centroid, geojson);
  });
  return filtered.length > 0 ? filtered : buildings;
}

function ringCentroid(ring) {
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  return [sx / ring.length, sy / ring.length];
}

function processBuildings(buildings) {
  const rows = [];
  for (let i = 0; i < buildings.length; i++) {
    const { ring, tags } = buildings[i];
    const areaSqm = ringArea(ring);
    if (areaSqm < CONFIG.minBuildingArea) continue;

    const perimeterM = ringPerimeter(ring);
    const name = tags.name || tags.official_name || tags.alt_name || "";
    const addrParts = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean);

    rows.push({
      name: name || `Building ${rows.length + 1}`,
      address: addrParts.join(" "),
      areaSqft: Math.round(areaSqm * CONFIG.sqmToSqft * 10) / 10,
      perimeterFt: Math.round(perimeterM * CONFIG.mToFt * 10) / 10,
    });
  }
  rows.sort((a, b) => b.areaSqft - a.areaSqft);
  rows.forEach((r, i) => { if (r.name.startsWith("Building ")) r.name = `Building ${i + 1}`; });
  return rows;
}

// ── Spreadsheet I/O ────────────────────────────────────────────────────────

function parseSpreadsheet(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        if (!data.length) { reject(new Error("Spreadsheet is empty")); return; }
        resolve({ headers: Object.keys(data[0]), rows: data });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

function detectColumns(headers) {
  let nameCol = null, addrCol = null;
  for (const h of headers) {
    const low = h.toLowerCase();
    if (!nameCol && /(school|name|site|campus)/.test(low)) nameCol = h;
    if (!addrCol && /(address|addr|location|street)/.test(low)) addrCol = h;
  }
  return { nameCol, addrCol };
}

function exportToXlsx(results, filename) {
  const ws = XLSX.utils.json_to_sheet(results.map(r => ({
    "School Name":       r.schoolName,
    "Address":           r.schoolAddress,
    "Building":          r.buildingName,
    "Building Address":  r.buildingAddress,
    "Linear Ft":         r.perimeterFt,
    "Sq Ft":             r.areaSqft,
    "Status":            r.status,
  })));

  const colWidths = [30, 45, 22, 30, 12, 12, 20];
  ws["!cols"] = colWidths.map(w => ({ wch: w }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Building Analysis");
  XLSX.writeFile(wb, filename);
}

// ── Fetch helper with timeout ──────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}, timeout = 30000) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeout);

  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) { clearTimeout(timerId); throw new DOMException("Aborted", "AbortError"); }
    callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(timerId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp;
  } catch (err) {
    clearTimeout(timerId);
    if (callerSignal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw err;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Single School Analysis ─────────────────────────────────────────────────

async function analyseSchool(schoolName, address, log, signal) {
  const query = address ? `${schoolName}, ${address}` : schoolName;
  log(`  Geocoding: ${query}`);

  let locationData = null;
  const queries = address ? [query, address] : [query];

  for (const q of queries) {
    try {
      locationData = await geocodeLocation(q, signal);
      log(`  Found: ${locationData.displayName.split(",").slice(0, 3).join(",")}`);
      break;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (q !== address) log(`  Retrying with address only...`);
    }
  }

  if (!locationData) {
    log(`  [SKIP] Geocode failed`);
    return [makeErrorRow(schoolName, address, "Geocode failed")];
  }

  await sleep(CONFIG.geocodeDelay);

  let buildings;
  try {
    buildings = await fetchBuildings(locationData, signal);
    log(`  Found ${buildings.length} building footprints`);
  } catch (e) {
    if (e.name === "AbortError") throw e;
    log(`  [SKIP] Overpass failed: ${e.message}`);
    return [makeErrorRow(schoolName, address, `Overpass failed: ${e.message}`)];
  }

  if (buildings.length === 0) {
    log(`  [SKIP] No buildings in OSM`);
    return [makeErrorRow(schoolName, address, "No buildings found in OSM")];
  }

  buildings = filterByBoundary(buildings, locationData.geojson);
  log(`  Filtered to ${buildings.length} campus buildings`);

  const processed = processBuildings(buildings);
  if (processed.length === 0) {
    return [makeErrorRow(schoolName, address, "No valid footprints")];
  }

  log(`  ${processed.length} buildings processed`);
  return processed.map(b => ({
    schoolName,
    schoolAddress: address,
    buildingName: b.name,
    buildingAddress: b.address,
    perimeterFt: b.perimeterFt,
    areaSqft: b.areaSqft,
    status: "OK",
  }));
}

function makeErrorRow(schoolName, address, msg) {
  return {
    schoolName,
    schoolAddress: address,
    buildingName: "",
    buildingAddress: "",
    perimeterFt: "",
    areaSqft: "",
    status: msg,
  };
}

// ── App Controller ─────────────────────────────────────────────────────────

class App {
  constructor() {
    this.fileData = null;    // { headers, rows }
    this.results = [];
    this.running = false;
    this.abortCtrl = null;

    this.$dropZone       = document.getElementById("drop-zone");
    this.$fileInput      = document.getElementById("file-input");
    this.$fileInfo       = document.getElementById("file-info");
    this.$fileName       = document.getElementById("file-name");
    this.$fileRows       = document.getElementById("file-rows");
    this.$clearFile      = document.getElementById("clear-file");
    this.$mappingSection = document.getElementById("mapping-section");
    this.$nameCol        = document.getElementById("name-col");
    this.$addrCol        = document.getElementById("addr-col");
    this.$previewHead    = document.getElementById("preview-head");
    this.$previewBody    = document.getElementById("preview-body");
    this.$controlsSection= document.getElementById("controls-section");
    this.$runBtn         = document.getElementById("run-btn");
    this.$stopBtn        = document.getElementById("stop-btn");
    this.$statusText     = document.getElementById("status-text");
    this.$progressFill   = document.getElementById("progress-fill");
    this.$progressLabel  = document.getElementById("progress-label");
    this.$etaText        = document.getElementById("eta-text");
    this.$resultsSection = document.getElementById("results-section");
    this.$resultsCount   = document.getElementById("results-count");
    this.$resultsBody    = document.getElementById("results-body");
    this.$exportBtn      = document.getElementById("export-btn");
    this.$logSection     = document.getElementById("log-section");
    this.$logToggle      = document.getElementById("log-toggle");
    this.$logArrow       = document.getElementById("log-arrow");
    this.$logOutput      = document.getElementById("log-output");

    this.bindEvents();
  }

  bindEvents() {
    this.$dropZone.addEventListener("click", () => this.$fileInput.click());
    this.$dropZone.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") this.$fileInput.click();
    });
    this.$dropZone.addEventListener("dragover", e => {
      e.preventDefault(); this.$dropZone.classList.add("drag-over");
    });
    this.$dropZone.addEventListener("dragleave", () => {
      this.$dropZone.classList.remove("drag-over");
    });
    this.$dropZone.addEventListener("drop", e => {
      e.preventDefault();
      this.$dropZone.classList.remove("drag-over");
      if (e.dataTransfer.files.length) this.handleFile(e.dataTransfer.files[0]);
    });
    this.$fileInput.addEventListener("change", () => {
      if (this.$fileInput.files.length) this.handleFile(this.$fileInput.files[0]);
    });
    this.$clearFile.addEventListener("click", () => this.clearFile());
    this.$runBtn.addEventListener("click", () => this.runBatch());
    this.$stopBtn.addEventListener("click", () => this.stop());
    this.$exportBtn.addEventListener("click", () => this.export());
    this.$logToggle.addEventListener("click", () => this.toggleLog());
  }

  async handleFile(file) {
    try {
      this.fileData = await parseSpreadsheet(file);
    } catch (err) {
      alert(`Error reading file: ${err.message}`);
      return;
    }

    this.$fileName.textContent = file.name;
    this.$fileRows.textContent = `(${this.fileData.rows.length} rows)`;
    this.$fileInfo.classList.remove("hidden");

    this.populateMapping();
    this.renderPreview();
    this.$mappingSection.classList.remove("hidden");
    this.$controlsSection.classList.remove("hidden");
  }

  clearFile() {
    this.fileData = null;
    this.$fileInput.value = "";
    this.$fileInfo.classList.add("hidden");
    this.$mappingSection.classList.add("hidden");
    this.$controlsSection.classList.add("hidden");
    this.$resultsSection.classList.add("hidden");
    this.$logSection.classList.add("hidden");
  }

  populateMapping() {
    const { headers } = this.fileData;
    const { nameCol, addrCol } = detectColumns(headers);

    const fillSelect = (el, selectedVal) => {
      el.innerHTML = "";
      for (const h of headers) {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        if (h === selectedVal) opt.selected = true;
        el.appendChild(opt);
      }
    };

    fillSelect(this.$nameCol, nameCol || headers[0]);
    fillSelect(this.$addrCol, addrCol || headers[1]);
  }

  renderPreview() {
    const { headers, rows } = this.fileData;
    this.$previewHead.innerHTML = headers.map(h => `<th>${esc(h)}</th>`).join("");
    this.$previewBody.innerHTML = rows.slice(0, 5).map(row =>
      `<tr>${headers.map(h => `<td title="${esc(String(row[h]))}">${esc(String(row[h]).slice(0, 60))}</td>`).join("")}</tr>`
    ).join("");
  }

  log(msg) {
    this.$logOutput.textContent += msg + "\n";
    this.$logOutput.scrollTop = this.$logOutput.scrollHeight;
  }

  toggleLog() {
    this.$logOutput.classList.toggle("hidden");
    this.$logArrow.classList.toggle("open");
  }

  async runBatch() {
    if (this.running || !this.fileData) return;

    this.running = true;
    this.abortCtrl = new AbortController();
    this.results = [];
    this.$resultsBody.innerHTML = "";
    this.$logOutput.textContent = "";
    this.$logSection.classList.remove("hidden");
    this.$logOutput.classList.remove("hidden");
    this.$logArrow.classList.add("open");
    this.$resultsSection.classList.remove("hidden");
    this.$runBtn.disabled = true;
    this.$stopBtn.disabled = false;
    this.$exportBtn.disabled = true;
    this.$progressFill.style.width = "0%";
    this.$etaText.classList.remove("hidden");

    const nameCol = this.$nameCol.value;
    const addrCol = this.$addrCol.value;
    const { rows } = this.fileData;
    const total = rows.length;
    const startTime = Date.now();

    this.log(`Starting analysis of ${total} schools...`);
    this.log(`Columns: name="${nameCol}", address="${addrCol}"\n`);

    for (let i = 0; i < total; i++) {
      if (this.abortCtrl.signal.aborted) {
        this.log("\nStopped by user.");
        break;
      }

      const row = rows[i];
      const schoolName = String(row[nameCol] || "").trim();
      if (!schoolName) {
        this.updateProgress(i + 1, total, startTime);
        continue;
      }

      const rawAddr = String(row[addrCol] || "").trim();
      const address = cleanAddress(rawAddr);

      this.log(`[${i + 1}/${total}] ${schoolName}`);
      this.$statusText.textContent = `Processing: ${schoolName}`;

      let schoolRows;
      try {
        schoolRows = await analyseSchool(
          schoolName, address, msg => this.log(msg), this.abortCtrl.signal,
        );
      } catch (err) {
        if (err.name === "AbortError") {
          this.log("\nStopped by user.");
          break;
        }
        schoolRows = [makeErrorRow(schoolName, address, err.message)];
        this.log(`  [ERROR] ${err.message}`);
      }

      this.results.push(...schoolRows);
      this.appendResultRows(schoolRows);
      this.updateProgress(i + 1, total, startTime);
      this.log("");
    }

    this.running = false;
    this.$runBtn.disabled = false;
    this.$stopBtn.disabled = true;
    this.$exportBtn.disabled = false;
    this.$statusText.textContent = "Done!";
    this.$etaText.classList.add("hidden");
    this.updateResultsCount();
    this.log(`\nComplete. ${this.results.length} building rows total.`);
  }

  stop() {
    if (this.abortCtrl) this.abortCtrl.abort();
    this.$statusText.textContent = "Stopping...";
  }

  updateProgress(current, total, startTime) {
    const pct = total > 0 ? (current / total * 100) : 0;
    this.$progressFill.style.width = `${pct}%`;
    this.$progressLabel.textContent = `${current} / ${total}`;

    const elapsed = (Date.now() - startTime) / 1000;
    if (current > 0 && current < total) {
      const rate = elapsed / current;
      const remaining = Math.round(rate * (total - current));
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      this.$etaText.textContent = `Est. remaining: ${mins}m ${secs}s`;
    }
    this.updateResultsCount();
  }

  updateResultsCount() {
    const ok = this.results.filter(r => r.status === "OK").length;
    this.$resultsCount.textContent = `(${ok} buildings from ${new Set(this.results.map(r => r.schoolName)).size} schools)`;
  }

  appendResultRows(schoolRows) {
    for (const r of schoolRows) {
      const tr = document.createElement("tr");
      tr.className = r.status === "OK" ? "status-ok" : "status-err";
      tr.innerHTML = `
        <td title="${esc(r.schoolName)}">${esc(r.schoolName)}</td>
        <td title="${esc(r.schoolAddress)}">${esc(trunc(r.schoolAddress, 40))}</td>
        <td>${esc(r.buildingName)}</td>
        <td>${esc(r.buildingAddress)}</td>
        <td class="num">${r.perimeterFt !== "" ? Number(r.perimeterFt).toLocaleString() : ""}</td>
        <td class="num">${r.areaSqft !== "" ? Number(r.areaSqft).toLocaleString() : ""}</td>
        <td>${esc(r.status)}</td>`;
      this.$resultsBody.appendChild(tr);
    }
    const wrap = document.getElementById("results-wrap");
    wrap.scrollTop = wrap.scrollHeight;
  }

  export() {
    if (!this.results.length) return;
    const name = this.$fileName.textContent.replace(/\.[^.]+$/, "") + "_building_analysis.xlsx";
    exportToXlsx(this.results, name);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return "";
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function trunc(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => new App());
