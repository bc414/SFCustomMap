/* Muni reach map: shows where Muni can take you (no transfers) from a set of
 * starting stops, with a walking radius shaded around every reachable stop.
 * Data comes from data/muni.json, built by scripts/build_data.py. */
(function () {
  "use strict";

  const CFG = window.MAP_CONFIG;
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Distinct, reasonably dark colors that read on a light basemap.
  const PALETTE = [
    "#e6194b", "#1f77b4", "#2ca02c", "#ff7f0e", "#9467bd", "#17becf", "#d62728",
    "#8c564b", "#e377c2", "#7f7f00", "#000075", "#469990", "#f032e6", "#800000",
    "#4363d8", "#3cb44b", "#9a6324", "#808080",
  ];
  const CANDIDATE_RADIUS_M = 1500; // stops shown as clickable around home

  let data, map, layers, panes, basemaps;
  const state = {};

  // ------------------------------------------------------------ utilities

  function haversine(lat1, lon1, lat2, lon2) {
    const r = 6371000, rad = Math.PI / 180;
    const dp = (lat2 - lat1) * rad, dl = (lon2 - lon1) * rad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }

  function decodePolyline(str) {
    const pts = [];
    let i = 0, lat = 0, lon = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let shift = 0, result = 0, b;
        do {
          b = str.charCodeAt(i++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lon += d;
      }
      pts.push([lat / 1e5, lon / 1e5]);
    }
    return pts;
  }

  function fmtTime(min) {
    const h = Math.floor(min / 60) % 24, m = min % 60;
    const ampm = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return m ? `${h12}:${String(m).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
  }

  function fmtDist(m) {
    return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "style") Object.assign(e.style, v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.6 ? "#111" : "#fff";
  }

  // ------------------------------------------------------------ state <-> URL

  function defaultState() {
    const todayDow = (new Date().getDay() + 6) % 7; // JS Sunday=0 -> Monday=0
    const dayIdx = Math.max(0, data.days.findIndex((d) => d.dow === todayDow));
    return {
      day: dayIdx,
      from: CFG.timeFrom,
      to: CFG.timeTo,
      walk: CFG.walkRadiusM,
      homeR: CFG.homeRadiusM,
      home: [CFG.home.lat, CFG.home.lon],
      add: new Set(),    // stop_ids added by clicking
      remove: new Set(), // stop_ids removed by clicking
      hidden: new Set(), // route_ids hidden in the legend
      color: CFG.colorMode,
      base: CFG.basemap === "satellite" ? "satellite" : "map",
    };
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    const num = (k, d) => (p.has(k) && !isNaN(+p.get(k)) ? +p.get(k) : d);
    const set = (k) => new Set((p.get(k) || "").split(",").filter(Boolean));
    if (p.has("day")) state.day = Math.min(data.days.length - 1, Math.max(0, num("day", state.day)));
    state.from = num("from", state.from);
    state.to = num("to", state.to);
    state.walk = num("walk", state.walk);
    state.homeR = num("hr", state.homeR);
    if (p.has("home")) {
      const [a, b] = p.get("home").split(",").map(Number);
      if (!isNaN(a) && !isNaN(b)) state.home = [a, b];
    }
    if (p.has("add")) state.add = set("add");
    if (p.has("rm")) state.remove = set("rm");
    if (p.has("hide")) state.hidden = set("hide");
    if (p.has("color")) state.color = p.get("color");
    if (p.has("base")) state.base = p.get("base") === "satellite" ? "satellite" : "map";
  }

  function writeHash() {
    const d = defaultState();
    const p = new URLSearchParams();
    if (state.day !== d.day) p.set("day", state.day);
    if (state.from !== d.from) p.set("from", state.from);
    if (state.to !== d.to) p.set("to", state.to);
    if (state.walk !== d.walk) p.set("walk", state.walk);
    if (state.homeR !== d.homeR) p.set("hr", state.homeR);
    if (state.home[0] !== d.home[0] || state.home[1] !== d.home[1])
      p.set("home", state.home.map((x) => x.toFixed(5)).join(","));
    if (state.add.size) p.set("add", [...state.add].join(","));
    if (state.remove.size) p.set("rm", [...state.remove].join(","));
    if (state.hidden.size) p.set("hide", [...state.hidden].join(","));
    if (state.color !== d.color) p.set("color", state.color);
    if (state.base !== d.base) p.set("base", state.base);
    const s = p.toString().replace(/%2C/g, ",");
    history.replaceState(null, "", s ? "#" + s : location.pathname + location.search);
  }

  // ------------------------------------------------------------ data prep

  function prepare(raw) {
    raw.stopById = new Map();
    raw.stops = raw.stops.map(([id, name, lat, lon], i) => {
      const s = { i, id, name, lat, lon, patterns: [] };
      raw.stopById.set(id, s);
      return s;
    });
    raw.shapes = raw.shapes.map((enc) => ({ enc, pts: null }));
    raw.patterns.forEach((p, pi) => {
      p.route = raw.routes[p.r];
      p.firstIndex = new Map();
      p.s.forEach((si, k) => {
        if (!p.firstIndex.has(si)) {
          p.firstIndex.set(si, k);
          raw.stops[si].patterns.push(pi);
        }
      });
    });
    raw.routes.forEach((r) => (r.patterns = []));
    raw.patterns.forEach((p, pi) => p.route.patterns.push(pi));
    return raw;
  }

  function shapePoints(g) {
    const sh = data.shapes[g];
    if (!sh.pts) sh.pts = decodePolyline(sh.enc);
    return sh.pts;
  }

  // ------------------------------------------------------------ core computation

  function startStops() {
    const [hlat, hlon] = state.home;
    const out = [];
    const explicit = CFG.startStops && CFG.startStops.length ? new Set(CFG.startStops) : null;
    for (const s of data.stops) {
      const dist = haversine(hlat, hlon, s.lat, s.lon);
      const auto = explicit ? explicit.has(s.id) : dist <= state.homeR;
      if ((auto && !state.remove.has(s.id)) || state.add.has(s.id)) out.push({ stop: s, dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** Departures from pattern p at stop position k within the chosen window. */
  function departures(p, k) {
    const day = data.days[state.day];
    const prevDay = data.days[(state.day + data.days.length - 1) % data.days.length];
    const off = p.o[k] || 0;
    let n = 0;
    for (const t of p.t[day.type] || []) {
      const at = t + off;
      if (at >= state.from && at < state.to) n++;
    }
    // Trips after midnight belong to the previous service day (times > 24:00).
    for (const t of p.t[prevDay.type] || []) {
      const at = t + off - 1440;
      if (at >= state.from && at < state.to) n++;
    }
    return n;
  }

  function compute() {
    const starts = startStops();
    const hours = Math.max(0.5, (state.to - state.from) / 60);
    // pattern index -> earliest boarding position among starting stops
    const board = new Map();
    // route index -> {deps by direction, headsigns}
    const routeInfo = new Map();
    const servesStart = new Set(); // routes serving a start stop at any time

    for (const { stop } of starts) {
      for (const pi of stop.patterns) {
        const p = data.patterns[pi];
        const k = p.firstIndex.get(stop.i);
        if (k >= p.s.length - 1) continue; // last stop: nowhere to ride to
        servesStart.add(p.r);
        const n = departures(p, k);
        if (!n) continue;
        if (!board.has(pi) || k < board.get(pi)) board.set(pi, k);
        let info = routeInfo.get(p.r);
        if (!info) routeInfo.set(p.r, (info = { dirs: new Map() }));
        const dir = info.dirs.get(p.d) || { n: 0, heads: new Map() };
        // Per stop, the patterns of one direction add up; across stops take the best.
        dir.perStop = dir.perStop || new Map();
        dir.perStop.set(stop.i, (dir.perStop.get(stop.i) || 0) + n);
        dir.n = Math.max(...dir.perStop.values());
        dir.heads.set(p.h, (dir.heads.get(p.h) || 0) + n);
        info.dirs.set(p.d, dir);
      }
    }

    // Reachable stops (by visible routes) and the routes reaching each.
    const reach = new Map(); // stop index -> Set(route index)
    for (const [pi, k] of board) {
      const p = data.patterns[pi];
      if (state.hidden.has(p.route.id)) continue;
      for (let j = k + 1; j < p.s.length; j++) {
        const si = p.s[j];
        if (!reach.has(si)) reach.set(si, new Set());
        reach.get(si).add(p.r);
      }
    }
    for (const info of routeInfo.values()) {
      info.perHour = Math.max(...[...info.dirs.values()].map((d) => d.n)) / hours;
    }
    return { starts, board, routeInfo, servesStart, reach };
  }

  // ------------------------------------------------------------ colors

  function assignColors(servesStart) {
    // Palette colors go to routes serving the starting stops, in route order,
    // so a route keeps its color when the time filter changes.
    const order = [...servesStart].sort((a, b) => a - b);
    const colors = new Map();
    order.forEach((ri, i) => {
      const r = data.routes[ri];
      const c = state.color === "muni" && r.color && r.color.toLowerCase() !== "#ffffff" ? r.color : PALETTE[i % PALETTE.length];
      colors.set(ri, c);
    });
    return colors;
  }

  // ------------------------------------------------------------ map

  function initMap() {
    map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(state.home, 14);
    L.control.zoom({ position: "topright" }).addTo(map);
    L.control.scale({ position: "bottomright", metric: true, imperial: true }).addTo(map);

    // The reach pane is drawn at partial opacity as a whole, so overlapping
    // circles merge into one evenly shaded area instead of stacking up.
    panes = {};
    const mk = (name, z) => {
      const pane = map.createPane(name);
      pane.style.zIndex = z;
      panes[name] = L.canvas({ pane: name, padding: 0.5 });
    };
    mk("reach", 350);
    mk("routes", 420);
    mk("stops", 450);
    map.getPane("reach").style.pointerEvents = "none";
    // Street names over the satellite photos: above the shading and route
    // lines (like Google Maps), below the stop markers.
    map.createPane("labels").style.zIndex = 430;
    map.getPane("labels").style.pointerEvents = "none";

    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const carto = '&copy; <a href="https://carto.com/attributions">CARTO</a>';
    const transit = "Transit data: SFMTA";
    basemaps = {
      map: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        subdomains: "abcd",
        attribution: `${osm} ${carto} · ${transit}`,
      }),
      satellite: L.layerGroup([
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
          maxZoom: 19,
          maxNativeZoom: 19,
          attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
        }),
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {
          maxZoom: 19,
          subdomains: "abcd",
          pane: "labels",
          attribution: `Labels ${osm} ${carto} · ${transit}`,
        }),
      ]),
    };
    basemaps[state.base].addTo(map);
    L.control.layers({ Map: basemaps.map, Satellite: basemaps.satellite }, null, { position: "topright" }).addTo(map);
    map.on("baselayerchange", (e) => {
      state.base = e.layer === basemaps.satellite ? "satellite" : "map";
      update();
    });

    layers = {
      reach: L.layerGroup().addTo(map),
      routes: L.layerGroup().addTo(map),
      stops: L.layerGroup().addTo(map),
      home: L.layerGroup().addTo(map),
    };
  }

  function chips(routeIdxs, colors) {
    return el("span", { class: "chips" },
      ...[...routeIdxs].sort((a, b) => a - b).map((ri) => {
        const r = data.routes[ri];
        const c = colors.get(ri) || "#777";
        return el("span", { class: "chip", style: { background: c, color: textColorFor(c) }, title: r.long }, r.short);
      }));
  }

  function routesAtStop(stop) {
    return new Set(stop.patterns.map((pi) => data.patterns[pi].r));
  }

  function toggleStart(stop, isStart) {
    if (isStart) {
      if (state.add.has(stop.id)) state.add.delete(stop.id);
      else state.remove.add(stop.id);
    } else {
      if (state.remove.has(stop.id)) state.remove.delete(stop.id);
      else state.add.add(stop.id);
    }
    map.closePopup();
    update();
  }

  function stopPopup(stop, { isStart, reachedBy, colors }) {
    const all = routesAtStop(stop);
    const box = el("div", {},
      el("b", {}, stop.name),
      el("div", { class: "hint" }, `Stop ${stop.id}`));
    if (reachedBy && reachedBy.size) {
      box.append(el("div", {}, "Reachable on:"), chips(reachedBy, colors));
    }
    box.append(el("div", { style: { marginTop: "6px" } }, "Routes stopping here:"), chips(all, colors));
    const dist = haversine(state.home[0], state.home[1], stop.lat, stop.lon);
    if (dist <= CANDIDATE_RADIUS_M || isStart) {
      box.append(el("div", {}, el("button", { type: "button", onclick: () => toggleStart(stop, isStart) },
        isStart ? "Remove as starting stop" : `Use as starting stop (${fmtDist(dist)} from home)`)));
    }
    return box;
  }

  function render(result, colors) {
    const { starts, board, reach } = result;
    for (const g of Object.values(layers)) g.clearLayers();

    // Shared reachable area.
    // Satellite photos are dark and busy, so the shading is brighter and stronger there.
    const sat = state.base === "satellite";
    const fill = sat ? CFG.satelliteReachColor : CFG.reachColor;
    map.getPane("reach").style.opacity = sat ? CFG.satelliteReachOpacity : CFG.reachOpacity;
    for (const si of reach.keys()) {
      const s = data.stops[si];
      L.circle([s.lat, s.lon], {
        radius: state.walk, stroke: false, fillColor: fill, fillOpacity: 1,
        renderer: panes.reach, interactive: false,
      }).addTo(layers.reach);
    }

    // Route lines from each boarding point onward, colored by route.
    const drawn = new Set();
    for (const [pi, k] of board) {
      const p = data.patterns[pi];
      if (state.hidden.has(p.route.id)) continue;
      let pts;
      if (p.g != null) {
        pts = shapePoints(p.g).slice(p.gi[k], p.gi[p.gi.length - 1] + 1);
      } else {
        pts = p.s.slice(k).map((si) => [data.stops[si].lat, data.stops[si].lon]);
      }
      const key = `${p.r}|${pts[0]}|${pts[pts.length - 1]}|${pts.length}`;
      if (drawn.has(key) || pts.length < 2) continue;
      drawn.add(key);
      const color = colors.get(p.r);
      L.polyline(pts, { color: "#fff", weight: 7, opacity: 0.85, renderer: panes.routes, interactive: false }).addTo(layers.routes);
      L.polyline(pts, { color, weight: 4, opacity: 0.95, renderer: panes.routes })
        .bindTooltip(`${p.route.short} ${p.route.long} → ${p.h}`, { sticky: true })
        .addTo(layers.routes);
    }

    // Reachable stops.
    const startIdx = new Set(starts.map((x) => x.stop.i));
    for (const [si, rs] of reach) {
      if (startIdx.has(si)) continue;
      const s = data.stops[si];
      const c = rs.size === 1 ? colors.get([...rs][0]) : "#333";
      L.circleMarker([s.lat, s.lon], { radius: 3, color: "#fff", weight: 1, fillColor: c, fillOpacity: 1, renderer: panes.stops })
        .bindPopup(() => stopPopup(s, { isStart: false, reachedBy: rs, colors }))
        .addTo(layers.stops);
    }

    // Other stops near home, so they can be clicked to add.
    const [hlat, hlon] = state.home;
    for (const s of data.stops) {
      if (startIdx.has(s.i) || reach.has(s.i)) continue;
      if (haversine(hlat, hlon, s.lat, s.lon) > CANDIDATE_RADIUS_M) continue;
      L.circleMarker([s.lat, s.lon], { radius: 4, color: "#666", weight: 1.5, fillColor: "#fff", fillOpacity: 1, renderer: panes.stops })
        .bindPopup(() => stopPopup(s, { isStart: false, colors }))
        .addTo(layers.stops);
    }

    // Starting stops.
    for (const { stop } of starts) {
      L.circleMarker([stop.lat, stop.lon], { radius: 7, color: "#111", weight: 3, fillColor: "#fff", fillOpacity: 1, renderer: panes.stops })
        .bindPopup(() => stopPopup(stop, { isStart: true, colors }))
        .addTo(layers.stops);
    }

    // Home and its walking radius.
    L.circle(state.home, { radius: state.homeR, color: sat ? "#fff" : "#111", weight: 1.5, dashArray: "5 5", fill: false, interactive: false }).addTo(layers.home);
    const home = L.marker(state.home, {
      draggable: true,
      title: CFG.home.label + " (drag to move)",
      icon: L.divIcon({ className: "", html: '<div class="home-icon"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1000,
    }).bindTooltip(CFG.home.label).addTo(layers.home);
    home.on("dragend", () => {
      const ll = home.getLatLng();
      state.home = [ll.lat, ll.lng];
      update();
    });
  }

  // ------------------------------------------------------------ panel

  function initPanel() {
    const panel = document.getElementById("panel");
    const toggle = document.getElementById("panel-toggle");
    toggle.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!collapsed));
    });
    if (window.matchMedia("(max-width: 640px)").matches) {
      panel.classList.add("collapsed");
      toggle.setAttribute("aria-expanded", "false");
    }

    const day = document.getElementById("day");
    data.days.forEach((d, i) => {
      const date = new Date(d.date + "T12:00:00");
      const label = `${DOW[d.dow]} ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      day.append(el("option", { value: i }, label));
    });
    const from = document.getElementById("from"), to = document.getElementById("to");
    for (let m = 0; m <= 24 * 60; m += 30) {
      if (m < 24 * 60) from.append(el("option", { value: m }, fmtTime(m)));
      if (m > 0) to.append(el("option", { value: m }, m === 24 * 60 ? "midnight" : fmtTime(m)));
    }

    const bind = (id, key, after) => {
      const input = document.getElementById(id);
      input.value = state[key];
      input.addEventListener("input", () => {
        state[key] = +input.value;
        if (after) after();
        update();
      });
    };
    bind("day", "day");
    bind("from", "from", () => { if (state.to <= state.from) { state.to = Math.min(1440, state.from + 60); to.value = state.to; } });
    bind("to", "to", () => { if (state.to <= state.from) { state.from = Math.max(0, state.to - 60); from.value = state.from; } });
    bind("walk", "walk");
    bind("home-radius", "homeR");

    const colorMode = document.getElementById("color-mode");
    colorMode.value = state.color;
    colorMode.addEventListener("change", () => { state.color = colorMode.value; update(); });

    document.getElementById("reset-stops").addEventListener("click", () => {
      state.add.clear();
      state.remove.clear();
      state.home = [CFG.home.lat, CFG.home.lon];
      update();
    });
    document.getElementById("routes-all").addEventListener("click", () => { state.hidden.clear(); update(); });
    document.getElementById("routes-none").addEventListener("click", () => {
      for (const r of data.routes) state.hidden.add(r.id);
      update();
    });

    const gen = new Date(data.generated);
    document.getElementById("data-info").textContent =
      `Muni schedule data ${data.feedVersion ? "(" + data.feedVersion + ") " : ""}` +
      `built ${gen.toLocaleDateString()}, covering ${data.days[0].date} – ${data.days[data.days.length - 1].date}. ` +
      `Straight-line walking circles; no transfers.`;
    if (data.warning) {
      document.getElementById("panel-body").prepend(el("p", { class: "warning", role: "status" }, data.warning));
    }
  }

  function updatePanel(result, colors) {
    const { starts, routeInfo, servesStart, reach } = result;
    document.getElementById("walk-out").textContent = `${state.walk} m`;
    document.getElementById("home-radius-out").textContent = `${state.homeR} m`;

    const visible = [...routeInfo.keys()].filter((ri) => !state.hidden.has(data.routes[ri].id));
    document.getElementById("summary").textContent =
      `${visible.length} route${visible.length === 1 ? "" : "s"} · ${reach.size} stops reachable · ${starts.length} starting stop${starts.length === 1 ? "" : "s"}`;

    // Starting stops.
    const list = document.getElementById("start-list");
    list.replaceChildren(...starts.map(({ stop, dist }) => {
      const rs = routesAtStop(stop);
      const c = chips(rs, colors);
      [...c.children].forEach((chip, i) => {
        const ri = [...rs].sort((a, b) => a - b)[i];
        if (!routeInfo.has(ri)) chip.classList.add("off");
      });
      return el("li", {},
        el("div", { class: "name" }, stop.name, c),
        el("span", { class: "dist" }, fmtDist(dist)),
        el("button", { class: "link remove", type: "button", title: "Remove", "aria-label": `Remove ${stop.name}`, onclick: () => toggleStart(stop, true) }, "×"));
    }));
    if (!starts.length) list.append(el("li", { class: "hint" }, "No starting stops. Increase “Home to stop” or click stops on the map."));

    // Route legend: routes serving the starting stops; those with no service in the window are dimmed.
    const routes = document.getElementById("route-list");
    const order = [...servesStart].sort((a, b) => a - b);
    routes.replaceChildren(...order.map((ri) => {
      const r = data.routes[ri];
      const info = routeInfo.get(ri);
      const color = colors.get(ri);
      const heads = info
        ? [...info.dirs.values()].map((d) => [...d.heads.entries()].sort((a, b) => b[1] - a[1])[0][0]).filter(Boolean).join(" · ")
        : "No service in this window";
      const freq = info ? perHourLabel(info.perHour) : "";
      const checkbox = el("input", { type: "checkbox", "aria-label": `Show route ${r.short}` });
      checkbox.checked = !state.hidden.has(r.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.hidden.delete(r.id); else state.hidden.add(r.id);
        update();
      });
      return el("li", { class: info ? "" : "inactive" },
        checkbox,
        el("span", { class: "swatch", style: { background: color } }),
        el("span", { class: "label", title: "Zoom to route", onclick: () => zoomToRoute(ri, result) },
          el("b", {}, r.short), r.long, el("span", { class: "heads" }, heads)),
        el("span", { class: "freq" }, freq));
    }));
  }

  function perHourLabel(perHour) {
    if (perHour >= 1) return `~${Math.round(perHour)}/hr`;
    return `~${Math.round(perHour * 10) / 10}/hr`;
  }

  function zoomToRoute(ri, result) {
    const bounds = L.latLngBounds([]);
    for (const [pi, k] of result.board) {
      const p = data.patterns[pi];
      if (p.r !== ri) continue;
      for (let j = k; j < p.s.length; j++) bounds.extend([data.stops[p.s[j]].lat, data.stops[p.s[j]].lon]);
    }
    if (bounds.isValid()) {
      const narrow = window.matchMedia("(max-width: 640px)").matches;
      map.fitBounds(bounds, { paddingTopLeft: narrow ? [20, 20] : [360, 20], paddingBottomRight: [20, 20] });
    }
  }

  // ------------------------------------------------------------ main loop

  let first = true;
  function update() {
    const result = compute();
    const colors = assignColors(result.servesStart);
    render(result, colors);
    updatePanel(result, colors);
    writeHash();
    if (first) {
      first = false;
      const bounds = L.latLngBounds([state.home]);
      for (const si of result.reach.keys()) bounds.extend([data.stops[si].lat, data.stops[si].lon]);
      const narrow = window.matchMedia("(max-width: 640px)").matches;
      map.fitBounds(bounds.pad(0.05), { paddingTopLeft: narrow ? [10, 10] : [360, 10], paddingBottomRight: [10, narrow ? 60 : 10] });
    }
  }

  function showError(msg) {
    document.body.append(el("div", { class: "error", role: "alert" }, msg));
    document.getElementById("summary").textContent = "Data unavailable";
  }

  fetch("data/muni.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((raw) => {
      data = prepare(raw);
      Object.assign(state, defaultState());
      readHash();
      initMap();
      initPanel();
      update();
    })
    .catch((e) => {
      console.error(e);
      showError(`Could not load data/muni.json (${e.message}). Run scripts/build_data.py to generate it.`);
    });
})();
