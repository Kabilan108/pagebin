import { REVIEW_LIMITS } from "../shared/review";

// Runs inside every standard document frame, before the artifact's own scripts.
//
// Links to other hosts open in a new tab because the sandbox blocks top-level navigation and
// most sites refuse to be framed.
//
// The review half owns everything that must happen inside the artifact's origin: selection
// capture, anchor resolution, highlight marks, jump emphasis, and reading and writing decision
// form controls. All review state lives in the viewer; this script only answers messages.
//
// Viewer -> frame
//   pb:ping                                       ask for pb:ready again
//   pb:highlights       { items: [{ id, anchor, state }] }
//   pb:draft            { anchor | null }         provisional highlight while composing
//   pb:jump             { id }                    scroll to a highlight and emphasise it
//   pb:jump-decision    { id }
//   pb:decisions-apply  { values: { [id]: { [name]: value } } }  restore answers, then describe
//   pb:clear-selection
// Frame -> viewer
//   pb:ready            { path }
//   pb:selection        { anchor | null, rect, end, start }
//   pb:tab              { anchor, rect, end, start }  Tab pressed with text selected
//   pb:resolved         { results: [{ id, found, start }] }
//   pb:highlight-click  { id }
//   pb:decisions        { decisions: [{ id, question, start, controls, values, notOffered }] }
//   pb:decision-input   { id, name, values }
//
// Anchors are { quote, prefix, suffix }; the viewer stamps the version. Text is compared after
// collapsing whitespace so a quote survives re-rendering. Decisions are [data-pb-decision]
// sections whose control names are the decision id or "<id>:<suffix>"; the authored default
// is the agent's recommendation.
const EXTERNAL_LINK_SCRIPT_BODY = `
  const navigatesFrame = (link) => ["", "_self", "_top", "_parent"].includes((link.getAttribute("target") || "").toLowerCase());
  addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
    if (!link || link.hasAttribute("download") || !navigatesFrame(link)) return;
    const url = new URL(link.getAttribute("href"), document.baseURI);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.host === location.host) return;
    event.preventDefault();
    window.open(url.href, "_blank", "noopener,noreferrer");
  });
`;

const REVIEW_FRAME_SCRIPT_BODY = `
  if (window.parent === window) return;

  const CONTEXT = 32;
  const DEBOUNCE_MS = 140;
  const SKIPPED = "script,style,noscript,textarea,select,option,template,svg,[data-pagebin]";
  const CONTROL_SELECTOR = "input,select,textarea";
  const EDITABLE = "input,textarea,select,[contenteditable]:not([contenteditable=false]),[contenteditable]:not([contenteditable=false]) *";

  const post = (message) => window.parent.postMessage(message, VIEWER_ORIGIN);
  const root = () => document.body;

  // ---- text index ----
  function textIndex() {
    const nodes = [];
    const starts = new Map();
    let raw = "";
    const body = root();
    if (body) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement && node.parentElement.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let node;
      while ((node = walker.nextNode())) {
        nodes.push({ node, start: raw.length });
        starts.set(node, raw.length);
        raw += node.data;
      }
    }
    let norm = "";
    const normToRaw = [];
    const rawToNorm = new Array(raw.length);
    let pendingSpace = false;
    let runStart = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (/\\s/.test(ch)) {
        if (!pendingSpace) runStart = i;
        pendingSpace = norm.length > 0;
        rawToNorm[i] = norm.length;
        continue;
      }
      if (pendingSpace) {
        norm += " ";
        normToRaw.push(runStart);
        pendingSpace = false;
      }
      rawToNorm[i] = norm.length;
      norm += ch;
      normToRaw.push(i);
    }
    return { nodes, starts, raw, norm, normToRaw, rawToNorm };
  }

  function rawOffset(container, offset, idx) {
    const start = idx.starts.get(container);
    if (start !== undefined) return start + Math.min(offset, container.data.length);
    const point = document.createRange();
    point.setStart(container, offset);
    for (const entry of idx.nodes) {
      if (point.comparePoint(entry.node, 0) >= 0) return entry.start;
    }
    return idx.raw.length;
  }

  const normAt = (rawIndex, idx) => (rawIndex < idx.raw.length ? idx.rawToNorm[rawIndex] : idx.norm.length);

  const LETTER = /[\\p{L}\\p{N}_]/u;
  function wordCharAt(text, i) {
    const ch = text[i];
    if (ch === undefined) return false;
    if (LETTER.test(ch)) return true;
    return (ch === "'" || ch === "\\u2019") && LETTER.test(text[i - 1] || "") && LETTER.test(text[i + 1] || "");
  }

  function pickRect(r) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }

  // ---- selection ----
  function currentSelection() {
    const sel = document.getSelection();
    const body = root();
    if (!body || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!body.contains(range.commonAncestorContainer)) return null;
    const idx = textIndex();
    let ns = normAt(rawOffset(range.startContainer, range.startOffset, idx), idx);
    let ne = normAt(rawOffset(range.endContainer, range.endOffset, idx), idx);
    while (ns < ne && idx.norm[ns] === " ") ns++;
    while (ne > ns && idx.norm[ne - 1] === " ") ne--;
    if (ne - ns < 1) return null;
    // Anchors cover whole words, so a drag that clips a word still quotes something readable.
    while (ns > 0 && wordCharAt(idx.norm, ns - 1) && wordCharAt(idx.norm, ns)) ns--;
    while (ne < idx.norm.length && wordCharAt(idx.norm, ne - 1) && wordCharAt(idx.norm, ne)) ne++;
    if (ne - ns > QUOTE_LIMIT) ne = ns + QUOTE_LIMIT;
    const rects = range.getClientRects();
    return {
      anchor: {
        quote: idx.norm.slice(ns, ne),
        prefix: idx.norm.slice(Math.max(0, ns - CONTEXT), ns),
        suffix: idx.norm.slice(ne, ne + CONTEXT),
      },
      rect: pickRect(range.getBoundingClientRect()),
      end: pickRect(rects[rects.length - 1] || range.getBoundingClientRect()),
      start: ns,
    };
  }

  function overlapTail(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  }

  function overlapHead(a, b) {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  }

  function locate(anchor, idx) {
    const q = anchor && typeof anchor.quote === "string" ? anchor.quote : "";
    if (!q) return null;
    let best = -1;
    let bestScore = -1;
    for (let i = idx.norm.indexOf(q); i !== -1; i = idx.norm.indexOf(q, i + 1)) {
      const before = idx.norm.slice(Math.max(0, i - CONTEXT), i);
      const after = idx.norm.slice(i + q.length, i + q.length + CONTEXT);
      const score = overlapTail(before, anchor.prefix || "") + overlapHead(after, anchor.suffix || "");
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return best === -1 ? null : { ns: best, ne: best + q.length };
  }

  // ---- highlights ----
  function wrap(ns, ne, idx, attrs) {
    const rawStart = idx.normToRaw[ns];
    const rawEnd = idx.normToRaw[ne - 1] + 1;
    const pieces = [];
    for (const { node, start } of idx.nodes) {
      const end = start + node.data.length;
      if (end <= rawStart) continue;
      if (start >= rawEnd) break;
      const from = Math.max(rawStart, start) - start;
      const to = Math.min(rawEnd, end) - start;
      if (!node.data.slice(from, to).trim()) continue;
      pieces.push({ node, from, to });
    }
    for (const piece of pieces) {
      let target = piece.node;
      if (piece.to < target.data.length) target.splitText(piece.to);
      if (piece.from > 0) target = target.splitText(piece.from);
      const mark = document.createElement("mark");
      for (const [key, value] of Object.entries(attrs)) mark.setAttribute(key, value);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
    }
  }

  function unwrap(mark) {
    const parentNode = mark.parentNode;
    while (mark.firstChild) parentNode.insertBefore(mark.firstChild, mark);
    mark.remove();
    parentNode.normalize();
  }

  function applyHighlights(items) {
    document.querySelectorAll("mark[data-pb-id]").forEach(unwrap);
    const results = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.id !== "string") continue;
      const idx = textIndex();
      const loc = locate(item.anchor, idx);
      if (!loc) {
        results.push({ id: item.id, found: false, start: null });
        continue;
      }
      wrap(loc.ns, loc.ne, idx, { "data-pb-id": item.id, "data-pb-state": item.state === "addressed" ? "addressed" : "open" });
      results.push({ id: item.id, found: true, start: loc.ns });
    }
    post({ type: "pb:resolved", results });
  }

  function applyDraft(anchor) {
    document.querySelectorAll("mark[data-pb-draft]").forEach(unwrap);
    if (!anchor) return;
    const idx = textIndex();
    const loc = locate(anchor, idx);
    if (!loc) return;
    wrap(loc.ns, loc.ne, idx, { "data-pb-draft": "" });
    const sel = document.getSelection();
    if (sel) sel.removeAllRanges();
  }

  function emphasise(elements) {
    for (const el of elements) {
      el.classList.remove("pb-emph");
      void el.offsetWidth;
      el.classList.add("pb-emph");
      setTimeout(() => el.classList.remove("pb-emph"), 1200);
    }
  }

  const smooth = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  function jump(id) {
    const marks = [...document.querySelectorAll("mark[data-pb-id]")].filter((mark) => mark.dataset.pbId === id);
    if (marks.length === 0) return;
    marks[0].scrollIntoView({ block: "center", behavior: smooth() });
    emphasise(marks);
  }

  function jumpDecision(id) {
    const section = decisionSection(id);
    if (!section) return;
    section.scrollIntoView({ block: "center", behavior: smooth() });
    emphasise([section]);
  }

  // ---- decisions ----
  function decisionSections() {
    const body = root();
    return body ? [...body.querySelectorAll("[data-pb-decision]")] : [];
  }

  function decisionSection(id) {
    return decisionSections().find((section) => section.dataset.pbDecision === id) || null;
  }

  function controlType(el) {
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "TEXTAREA") return "textarea";
    const type = (el.type || "text").toLowerCase();
    if (type === "radio" || type === "checkbox" || type === "range") return type;
    if (["hidden", "submit", "button", "reset", "image", "file", "password"].includes(type)) return null;
    return "text";
  }

  function labelFor(el) {
    const label = el.closest("label") || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
    if (!label) return el.value;
    const clone = label.cloneNode(true);
    clone.querySelectorAll("input,select,textarea,small").forEach((n) => n.remove());
    return clone.textContent.replace(/\\s+/g, " ").trim() || el.value;
  }

  function decisionGroups(section, id) {
    const groups = new Map();
    for (const el of section.querySelectorAll(CONTROL_SELECTOR)) {
      const name = el.name;
      if (!name || (name !== id && !name.startsWith(id + ":"))) continue;
      const type = controlType(el);
      if (!type) continue;
      if (!groups.has(name)) groups.set(name, { name, type, elements: [] });
      groups.get(name).elements.push(el);
    }
    return [...groups.values()];
  }

  // The authored default is what the control shows before any interaction, including implicit
  // HTML defaults (first option, range midpoint, sanitized input values). Resetting a clone of
  // the real control inside a detached form keeps every attribute that shapes those defaults.
  function authoredElements(els) {
    const form = document.createElement("form");
    const clones = els.map((el) => form.appendChild(el.cloneNode(true)));
    form.reset();
    return clones;
  }

  function readValue(group, authored) {
    const els = authored ? authoredElements(group.elements) : group.elements;
    switch (group.type) {
      case "radio": {
        // Several authored checked radios leave the last one checked, as the parser does.
        const on = authored ? els.filter((e) => e.checked).pop() : els.find((e) => e.checked);
        return on ? on.value : null;
      }
      case "checkbox":
        return els.filter((e) => e.checked).map((e) => e.value);
      case "select": {
        const select = els[0];
        const picked = [...select.options].filter((o) => o.selected).map((o) => o.value);
        return select.multiple ? picked : picked.length ? picked[0] : null;
      }
      default:
        return els[0].value;
    }
  }

  function optionsOf(group) {
    if (group.type === "radio" || group.type === "checkbox") return group.elements.map((e) => ({ value: e.value, label: labelFor(e) }));
    if (group.type === "select") return [...group.elements[0].options].map((o) => ({ value: o.value, label: o.textContent.trim() }));
    return null;
  }

  function writeValue(group, value) {
    const els = group.elements;
    const offered = (v) => optionsOf(group).some((o) => o.value === v);
    switch (group.type) {
      case "radio":
        // A saved "none" must clear an option the current version checks by default.
        if (value === null || value === undefined) {
          els.forEach((e) => (e.checked = false));
          return true;
        }
        if (!offered(value)) return false;
        els.forEach((e) => (e.checked = e.value === value));
        return true;
      case "checkbox": {
        const wanted = Array.isArray(value) ? value : [];
        if (!wanted.every(offered)) return false;
        els.forEach((e) => (e.checked = wanted.includes(e.value)));
        return true;
      }
      case "select": {
        const wanted = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
        if (!wanted.every(offered)) return false;
        [...els[0].options].forEach((o) => (o.selected = wanted.includes(o.value)));
        // Deselecting every option of a single select reselects the first; -1 keeps it empty.
        if (wanted.length === 0) els[0].selectedIndex = -1;
        return true;
      }
      default:
        if (typeof value !== "string") return true;
        // Restoring saved answers must not overwrite what the reader is typing right now.
        if (els[0] === document.activeElement) return true;
        els[0].value = value;
        return !(group.type === "range" && els[0].value !== value);
    }
  }

  function questionOf(section, id) {
    const heading = section.querySelector("h1,h2,h3,h4,h5,h6,legend");
    if (!heading) return id;
    const clone = heading.cloneNode(true);
    clone.querySelectorAll("code").forEach((c) => c.remove());
    return clone.textContent.replace(/\\s+/g, " ").trim() || id;
  }

  function describeDecisions(notOffered) {
    const idx = textIndex();
    const decisions = decisionSections().map((section) => {
      const id = section.dataset.pbDecision;
      const groups = decisionGroups(section, id);
      const firstText = idx.nodes.find((entry) => section.contains(entry.node));
      const controls = groups.map((group) => {
        const control = { name: group.name, type: group.type, default: readValue(group, true) };
        const options = optionsOf(group);
        if (options) control.options = options;
        return control;
      });
      const values = {};
      for (const group of groups) values[group.name] = readValue(group, false);
      return {
        id,
        question: questionOf(section, id),
        start: firstText ? normAt(firstText.start, idx) : 0,
        controls,
        values,
        notOffered: notOffered.get(id) || [],
      };
    });
    post({ type: "pb:decisions", decisions });
  }

  function applyDecisionValues(values) {
    const notOffered = new Map();
    for (const [id, byName] of Object.entries(values && typeof values === "object" ? values : {})) {
      const section = decisionSection(id);
      if (!section || !byName || typeof byName !== "object") continue;
      for (const group of decisionGroups(section, id)) {
        if (!(group.name in byName)) continue;
        if (!writeValue(group, byName[group.name])) {
          if (!notOffered.has(id)) notOffered.set(id, []);
          notOffered.get(id).push(group.name);
        }
      }
    }
    describeDecisions(notOffered);
  }

  function reportDecisionInput(event) {
    const el = event.target;
    if (!(el instanceof Element) || !el.matches(CONTROL_SELECTOR)) return;
    const section = el.closest("[data-pb-decision]");
    if (!section) return;
    const id = section.dataset.pbDecision;
    const type = controlType(el);
    if (!type || (event.type === "click" && (type === "text" || type === "textarea"))) return;
    const values = {};
    for (const group of decisionGroups(section, id)) values[group.name] = readValue(group, false);
    post({ type: "pb:decision-input", id, name: el.name, values });
  }

  // ---- events ----
  let selectionTimer = 0;
  function announceSelection() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      post({ type: "pb:selection", ...(currentSelection() || { anchor: null, rect: null, end: null, start: null }) });
    }, DEBOUNCE_MS);
  }

  let scrollFrame = 0;
  function announceOnScroll() {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      const current = currentSelection();
      if (current) post({ type: "pb:selection", ...current });
    });
  }

  // DOM tab order would walk through the artifact's own form controls first and clear the
  // selection on the way, so Tab with text selected hands focus straight to the viewer.
  function handOffTab(event) {
    if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const active = document.activeElement;
    if (active instanceof Element && active.matches(EDITABLE)) return;
    const current = currentSelection();
    if (!current) return;
    event.preventDefault();
    post({ type: "pb:tab", ...current });
  }

  function start() {
    const style = document.createElement("style");
    style.setAttribute("data-pagebin", "review");
    style.textContent = REVIEW_FRAME_CSS;
    (document.head || document.documentElement).appendChild(style);

    document.addEventListener("selectionchange", announceSelection);
    window.addEventListener("scroll", announceOnScroll, { passive: true });
    window.addEventListener("resize", announceOnScroll);
    document.addEventListener("keydown", handOffTab, true);
    document.addEventListener("click", (event) => {
      const mark = event.target instanceof Element ? event.target.closest("mark[data-pb-id]") : null;
      if (!mark) return;
      if (mark.closest("label")) event.preventDefault();
      post({ type: "pb:highlight-click", id: mark.dataset.pbId });
    });
    for (const type of ["input", "change", "click"]) document.addEventListener(type, reportDecisionInput);

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      if (VIEWER_ORIGIN !== "*" && event.origin !== VIEWER_ORIGIN) return;
      const msg = event.data;
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "pb:ping":
          post({ type: "pb:ready", path: location.pathname });
          break;
        case "pb:highlights":
          applyHighlights(msg.items);
          break;
        case "pb:draft":
          applyDraft(msg.anchor || null);
          break;
        case "pb:jump":
          jump(msg.id);
          break;
        case "pb:jump-decision":
          jumpDecision(msg.id);
          break;
        case "pb:decisions-apply":
          applyDecisionValues(msg.values);
          break;
        case "pb:clear-selection": {
          const sel = document.getSelection();
          if (sel) sel.removeAllRanges();
          break;
        }
      }
    });

    post({ type: "pb:ready", path: location.pathname });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
`;

const REVIEW_FRAME_CSS = [
  "mark[data-pb-id],mark[data-pb-draft]{color:inherit;padding:.06em 0;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone;transition:background .2s}",
  "mark[data-pb-id]{--pb-mark:rgba(214,152,70,.3);--pb-mark-deep:rgba(214,152,70,.6);background:var(--pb-mark);border-bottom:1.5px solid rgba(138,84,38,.55);cursor:pointer}",
  "mark[data-pb-id]:hover{background:rgba(214,152,70,.48)}",
  'mark[data-pb-state="addressed"]{--pb-mark:rgba(111,149,86,.14);--pb-mark-deep:rgba(111,149,86,.4);border-bottom:1.5px dotted rgba(111,149,86,.75)}',
  'mark[data-pb-state="addressed"]:hover{background:rgba(111,149,86,.26)}',
  "mark[data-pb-draft]{background:rgba(214,152,70,.18);border-bottom:1.5px dashed rgba(138,84,38,.6)}",
  "mark.pb-emph{animation:pbEmph 1.1s ease-out}",
  "@keyframes pbEmph{0%,30%{background:var(--pb-mark-deep)}100%{background:var(--pb-mark)}}",
  "[data-pb-decision].pb-emph{animation:pbSectionEmph 1.1s ease-out}",
  "@keyframes pbSectionEmph{0%,30%{background-color:rgba(214,152,70,.22)}100%{background-color:transparent}}",
  "@media (prefers-reduced-motion:reduce){mark.pb-emph,[data-pb-decision].pb-emph{animation:none}}",
].join("");

// viewerOrigin is the exact origin of the viewer page, or "*" when the frame is served on the
// viewer's host with an opaque origin; there `frame-ancestors 'self'` already pins the parent.
export function frameScriptTag(viewerOrigin: string, review = true): string {
  if (!review) {
    return `<script data-pagebin="frame">(() => {\n${EXTERNAL_LINK_SCRIPT_BODY}})();</script>`;
  }

  const constants = [
    `const VIEWER_ORIGIN = ${scriptLiteral(viewerOrigin)};`,
    `const QUOTE_LIMIT = ${REVIEW_LIMITS.quote};`,
    `const REVIEW_FRAME_CSS = ${scriptLiteral(REVIEW_FRAME_CSS)};`,
  ].join("\n  ");

  return `<script data-pagebin="frame">(() => {\n  ${constants}\n${EXTERNAL_LINK_SCRIPT_BODY}${REVIEW_FRAME_SCRIPT_BODY}})();</script>`;
}

// Emits a self-contained function's source as a const declaration. Wrangler bundles with
// keepNames, which wraps inner functions in a module-level __name helper the copy cannot see.
export function embeddedFunction(name: string, fn: { toString(): string }): string {
  const source = fn.toString();
  const keepNames = source.includes("__name(") ? "const __name = (target) => target;\n" : "";

  return `${keepNames}const ${name} = ${source};`;
}

function scriptLiteral(value: string): string {
  return escapeScriptText(JSON.stringify(value));
}

// JSON placed inside a <script> element must not be able to close it or break a JS string.
export function escapeScriptText(json: string): string {
  return json
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
