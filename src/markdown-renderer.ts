import hljs from "highlight.js";
import { load as loadYaml } from "js-yaml";
import { Marked, Renderer, TextRenderer, type Tokens } from "marked";

import { MARKDOWN_STYLES } from "./markdown-template.ts";

const MAX_CODE_HIGHLIGHT_CHARS = 200_000;
const MAX_LINE_NUMBER_COUNT = 5_000;
const MERMAID_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.6.0/dist/mermaid.min.js";
const MERMAID_INTEGRITY = "sha384-zkWMJO4sgpPUzyuOgDx8HB/K55glbAwajEpk1Go2NWRuPkPA/wIhoEJTuSkmOYrV";

interface FrontmatterResult {
  attributes: Record<string, unknown>;
  body: string;
}

export interface RenderedMarkdownArtifact {
  hasMermaid: boolean;
  html: string;
}

interface HeadingEntry {
  depth: number;
  id: string;
  text: string;
}

class PageBinRenderer extends Renderer {
  readonly headings: HeadingEntry[] = [];
  hasMermaid = false;
  private readonly headingCounts = new Map<string, number>();
  private readonly textRenderer = new TextRenderer();

  override code({ text, lang }: Tokens.Code): string {
    const language = (lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";

    if (language === "mermaid") {
      this.hasMermaid = true;
      return `<figure class="mermaid-wrap"><figcaption class="mermaid-label"><span>mermaid</span><div class="mermaid-controls" aria-label="Mermaid controls"><button class="mermaid-control" type="button" data-mermaid-action="zoom-out" aria-label="Zoom out">-</button><button class="mermaid-control reset" type="button" data-mermaid-action="reset" aria-label="Reset diagram view">100%</button><button class="mermaid-control" type="button" data-mermaid-action="zoom-in" aria-label="Zoom in">+</button></div></figcaption><div class="mermaid-viewport" data-mermaid-viewport><div class="mermaid">${escapeHtml(text)}</div></div></figure>`;
    }

    const label = language || "text";
    const highlighted = language && hljs.getLanguage(language) && text.length <= MAX_CODE_HIGHLIGHT_CHARS
      ? hljs.highlight(text, { language, ignoreIllegals: true }).value
      : escapeHtml(text);

    return `<figure class="code-frame"><figcaption><span class="code-language">${escapeHtml(label)}</span><button class="code-copy" type="button" data-copy-code="true">Copy</button></figcaption><div class="code-scroll"><div class="code-grid"><pre class="line-numbers" aria-hidden="true">${makeLineNumbers(text)}</pre><pre class="code-pre"><code class="hljs language-${escapeAttribute(label)}">${highlighted}</code></pre></div></div></figure>`;
  }

  override heading({ tokens, depth }: Tokens.Heading): string {
    const inline = this.parser.parseInline(tokens);
    const text = this.parser.parseInline(tokens, this.textRenderer).trim();
    const base = slugify(text || "section");
    const count = this.headingCounts.get(base) ?? 0;
    const id = count === 0 ? base : `${base}-${count + 1}`;
    this.headingCounts.set(base, count + 1);
    this.headings.push({ depth, id, text });

    return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeAttributeValue(text)}">#</a>${inline}</h${depth}>\n`;
  }

  override listitem(item: Tokens.ListItem): string {
    const html = super.listitem(item);
    return item.task ? html.replace("<li>", '<li class="task-list-item">') : html;
  }

  override paragraph({ tokens }: Tokens.Paragraph): string {
    const inline = this.parser.parseInline(tokens);
    const lines = inline.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    if (lines.length < 2) {
      return `<p>${inline}</p>\n`;
    }

    const entries: string[] = [];

    for (const line of lines) {
      if (isMetadataLine(line)) {
        entries.push(line);
      } else if (entries.length > 0) {
        entries[entries.length - 1] += ` ${line}`;
      } else {
        return `<p>${inline}</p>\n`;
      }
    }

    if (entries.length < 2) {
      return `<p>${inline}</p>\n`;
    }

    return `<div class="metadata-block">${entries.map((entry) => `<div class="metadata-line">${entry}</div>`).join("")}</div>\n`;
  }

  override table(token: Tokens.Table): string {
    return `<div class="table-frame"><div class="table-scroll">${super.table(token)}</div></div>`;
  }
}

export function renderMarkdownDocument(markdown: string, sourceName: string): string {
  return renderMarkdownArtifact(markdown, sourceName).html;
}

export function renderMarkdownArtifact(markdown: string, sourceName: string): RenderedMarkdownArtifact {
  const parsed = parseFrontmatter(markdown);
  const renderer = new PageBinRenderer();
  const parser = new Marked();
  parser.setOptions({ gfm: true, breaks: false, renderer });
  const content = parser.parse(preprocessFootnotes(parsed.body), { async: false });
  const firstHeading = renderer.headings.find((heading) => heading.depth === 1)?.text ?? "";
  const title = getString(parsed.attributes.title) || firstHeading || sourceName.replace(/\.[^.]+$/, "");
  const description = getString(parsed.attributes.description) || getString(parsed.attributes.summary);
  const hasProperties = Object.keys(parsed.attributes).length > 0;
  const titleHidden = Boolean(firstHeading && sameDisplayTitle(title, firstHeading));
  const toc = renderToc(renderer.headings);
  const csp = renderer.hasMermaid
    ? "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src https: data:; media-src https: data:; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    : "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; media-src https: data:; connect-src 'none'; font-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  const mermaidScript = renderer.hasMermaid
    ? `<script src="${MERMAID_SCRIPT_URL}" integrity="${MERMAID_INTEGRITY}" crossorigin="anonymous" defer></script>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<style>
${MARKDOWN_STYLES}
</style>
</head>
<body class="${hasProperties ? "" : "no-properties"}">
<main class="layout">
<article class="reader">
<header class="document-head">
<h1 class="title"${titleHidden ? " hidden" : ""}>${escapeHtml(title)}</h1>
<p class="subtitle"${description ? "" : " hidden"}>${escapeHtml(description)}</p>
</header>
<div class="markdown-body" id="content">${content}</div>
</article>
<aside class="side" aria-label="Document information">
<div class="side-stack">
<details class="side-panel properties-panel" id="properties-panel"${hasProperties ? " open" : " hidden"}>
<summary><h2 class="side-title">Properties</h2></summary>
<div class="meta-list" id="frontmatter">${renderFrontmatter(parsed.attributes)}</div>
</details>
<section class="side-panel side-section desktop-outline">
<h2 class="side-title">Outline</h2>
<nav class="toc" id="toc">${toc}</nav>
</section>
</div>
</aside>
</main>
<button class="mobile-outline-trigger" id="outline-trigger" type="button" aria-expanded="false" aria-controls="outline-drawer" aria-label="Outline">&#9776;</button>
<div class="drawer-backdrop" id="drawer-backdrop"></div>
<aside class="outline-drawer" id="outline-drawer" aria-label="Document outline" aria-hidden="true">
<div class="drawer-head"><h2 class="side-title">Outline</h2><button class="drawer-close" id="drawer-close" type="button">Close</button></div>
<nav class="toc drawer-toc" id="mobile-toc">${toc}</nav>
</aside>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
${mermaidScript}
<script>
${enhancementScript(renderer.hasMermaid)}
</script>
</body>
</html>`;

  return { hasMermaid: renderer.hasMermaid, html };
}

function parseFrontmatter(markdown: string): FrontmatterResult {
  const normalized = markdown.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m);

  if (!match) {
    return { attributes: {}, body: normalized };
  }

  const body = normalized.slice(match[0].length);

  try {
    const value = loadYaml(match[1] ?? "");
    return {
      attributes: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {},
      body,
    };
  } catch (error) {
    return {
      attributes: { frontmatter_error: error instanceof Error ? error.message : String(error) },
      body,
    };
  }
}

function preprocessFootnotes(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const body: string[] = [];
  const definitions = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/);

    if (!match?.[1]) {
      body.push(line);
      continue;
    }

    const id = match[1];
    const content = [match[2] ?? ""];

    for (index += 1; index < lines.length; index += 1) {
      const continuation = lines[index] ?? "";

      if (continuation.trim() === "") {
        content.push("");
      } else if (/^(?: {2,}|\t)/.test(continuation)) {
        content.push(continuation.replace(/^(?: {2,4}|\t)/, ""));
      } else {
        index -= 1;
        break;
      }
    }

    definitions.set(id, content.join("\n").trim());
  }

  const used: Array<{ content: string; id: string }> = [];
  const rewritten = body.join("\n").replace(/\[\^([^\]]+)\]/g, (reference, id: string) => {
    const content = definitions.get(id);

    if (content === undefined) {
      return reference;
    }

    let index = used.findIndex((entry) => entry.id === id);

    if (index === -1) {
      used.push({ content, id });
      index = used.length - 1;
    }

    const number = index + 1;
    const safeId = slugify(`fn-${id}`);
    return `<sup id="${safeId}-ref"><a href="#${safeId}" aria-label="Footnote ${number}">${number}</a></sup>`;
  });

  if (used.length === 0) {
    return rewritten;
  }

  const inlineParser = new Marked({ gfm: true, breaks: false });
  const items = used.map((entry, index) => {
    const number = index + 1;
    const safeId = slugify(`fn-${entry.id}`);
    const rendered = inlineParser.parseInline(entry.content, { async: false });
    return `<li id="${safeId}">${rendered} <a class="footnote-backref" href="#${safeId}-ref" aria-label="Back to reference ${number}">back</a></li>`;
  }).join("");

  return `${rewritten}\n\n<section class="footnotes" aria-labelledby="footnotes-label"><h2 id="footnotes-label">Footnotes</h2><ol>${items}</ol></section>`;
}

function renderToc(headings: HeadingEntry[]): string {
  const entries = headings.filter((heading) => heading.depth >= 2);

  if (entries.length === 0) {
    return '<div class="empty">No sections found.</div>';
  }

  return entries.map((heading) => `<a href="#${heading.id}" class="depth-${heading.depth}">${escapeHtml(heading.text)}</a>`).join("");
}

function renderFrontmatter(attributes: Record<string, unknown>): string {
  return Object.entries(attributes).map(([key, value]) => renderMetaEntry(key, value)).join("");
}

function renderMetaEntry(key: string, value: unknown): string {
  if (value && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value)) {
    const body = Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) => renderMetaEntry(nestedKey, nestedValue)).join("");
    return `<section class="meta-section"><div class="meta-section-title"><div class="meta-icon object" aria-hidden="true"></div><div>${escapeHtml(key)}</div></div><div class="meta-section-body">${body}</div></section>`;
  }

  const iconClass = Array.isArray(value) ? "meta-icon array" : "meta-icon";
  return `<div class="meta-item"><div class="${iconClass}" aria-hidden="true"></div><div class="meta-key">${escapeHtml(key)}</div>${renderMetaValue(value)}</div>`;
}

function renderMetaValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `<ul class="meta-value meta-array">${value.map((entry) => {
      if (entry && typeof entry === "object") {
        return `<li class="meta-token meta-token-complex">${renderMetaValue(entry)}</li>`;
      }
      return `<li class="meta-token">${escapeHtml(formatMetaPrimitive(entry))}</li>`;
    }).join("")}</ul>`;
  }

  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `<div class="meta-value">${Object.entries(value as Record<string, unknown>).map(([key, entry]) => renderMetaEntry(key, entry)).join("")}</div>`;
  }

  return `<div class="meta-value">${escapeHtml(formatMetaPrimitive(value))}</div>`;
}

function enhancementScript(hasMermaid: boolean): string {
  const mermaid = hasMermaid ? `
function clamp(value,min,max){return Math.min(Math.max(value,min),max)}
function markMermaidError(node){const viewport=node.closest("[data-mermaid-viewport]");if(viewport)viewport.dataset.ready="true";node.className="mermaid-error";node.textContent="Mermaid render failed."}
function setupMermaidViewport(viewport){if(!viewport||viewport.dataset.ready==="true")return;const canvas=viewport.querySelector(".mermaid");const figure=viewport.closest(".mermaid-wrap");if(!canvas||!figure)return;const state={scale:1,x:0,y:0};viewport.dataset.ready="true";const apply=()=>{canvas.style.transform="translate("+state.x+"px, "+state.y+"px) scale("+state.scale+")"};const zoomAt=(nextScale,clientX,clientY)=>{const rect=viewport.getBoundingClientRect();const pointX=clientX-rect.left;const pointY=clientY-rect.top;const previousScale=state.scale;state.scale=clamp(nextScale,.35,4);state.x=pointX-((pointX-state.x)/previousScale)*state.scale;state.y=pointY-((pointY-state.y)/previousScale)*state.scale;apply()};for(const control of figure.querySelectorAll("[data-mermaid-action]")){control.addEventListener("click",()=>{const rect=viewport.getBoundingClientRect();const centerX=rect.left+rect.width/2;const centerY=rect.top+rect.height/2;const action=control.dataset.mermaidAction;if(action==="zoom-in")zoomAt(state.scale*1.18,centerX,centerY);else if(action==="zoom-out")zoomAt(state.scale/1.18,centerX,centerY);else{state.scale=1;state.x=0;state.y=0;apply()}})}viewport.addEventListener("wheel",event=>{event.preventDefault();zoomAt(state.scale*(event.deltaY<0?1.1:1/1.1),event.clientX,event.clientY)},{passive:false});viewport.addEventListener("pointerdown",event=>{if(event.button!==0)return;const start={pointerId:event.pointerId,x:event.clientX,y:event.clientY,originX:state.x,originY:state.y};viewport.classList.add("dragging");viewport.setPointerCapture(event.pointerId);const move=moveEvent=>{if(moveEvent.pointerId!==start.pointerId)return;state.x=start.originX+moveEvent.clientX-start.x;state.y=start.originY+moveEvent.clientY-start.y;apply()};const stop=upEvent=>{if(upEvent.pointerId!==start.pointerId)return;viewport.classList.remove("dragging");viewport.releasePointerCapture(upEvent.pointerId);viewport.removeEventListener("pointermove",move);viewport.removeEventListener("pointerup",stop);viewport.removeEventListener("pointercancel",stop)};viewport.addEventListener("pointermove",move);viewport.addEventListener("pointerup",stop);viewport.addEventListener("pointercancel",stop)});apply()}
function renderMermaid(){const nodes=[...document.querySelectorAll(".mermaid")];if(!globalThis.mermaid){for(const node of nodes)markMermaidError(node);return}mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"base",themeVariables:{background:"#1d1a15",primaryColor:"#252017",primaryTextColor:"#f0e9db",primaryBorderColor:"#4a4335",lineColor:"#8a8172",secondaryColor:"#2a251d",tertiaryColor:"#191713",clusterBkg:"#211d17",clusterBorder:"#3d372d",edgeLabelBackground:"#252017",fontFamily:"ui-sans-serif,system-ui,sans-serif"}});for(const node of nodes){mermaid.run({nodes:[node]}).then(()=>setupMermaidViewport(node.closest("[data-mermaid-viewport]"))).catch(()=>markMermaidError(node))}}
window.addEventListener("DOMContentLoaded",renderMermaid);` : "";

  return `const content=document.querySelector("#content");const propertiesPanel=document.querySelector("#properties-panel");const outlineTrigger=document.querySelector("#outline-trigger");const outlineDrawer=document.querySelector("#outline-drawer");const drawerBackdrop=document.querySelector("#drawer-backdrop");const drawerClose=document.querySelector("#drawer-close");const toast=document.querySelector("#toast");const mobileQuery=window.matchMedia("(max-width: 720px)");
function showToast(message){if(!toast)return;toast.textContent=message;toast.classList.add("show");window.clearTimeout(showToast.timeout);showToast.timeout=window.setTimeout(()=>toast.classList.remove("show"),2200)}
async function copyText(text){if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return}const textArea=document.createElement("textarea");textArea.value=text;textArea.setAttribute("readonly","");textArea.style.position="fixed";textArea.style.opacity="0";document.body.append(textArea);textArea.select();document.execCommand("copy");textArea.remove()}
function syncResponsivePanels(){if(propertiesPanel&&!propertiesPanel.hidden)propertiesPanel.open=!mobileQuery.matches}
function openOutlineDrawer(){outlineDrawer?.classList.add("open");drawerBackdrop?.classList.add("open");outlineDrawer?.setAttribute("aria-hidden","false");outlineTrigger?.setAttribute("aria-expanded","true");drawerClose?.focus()}
function closeOutlineDrawer(){outlineDrawer?.classList.remove("open");drawerBackdrop?.classList.remove("open");outlineDrawer?.setAttribute("aria-hidden","true");outlineTrigger?.setAttribute("aria-expanded","false")}
outlineTrigger?.addEventListener("click",openOutlineDrawer);drawerClose?.addEventListener("click",closeOutlineDrawer);drawerBackdrop?.addEventListener("click",closeOutlineDrawer);mobileQuery.addEventListener("change",syncResponsivePanels);window.addEventListener("keydown",event=>{if(event.key==="Escape")closeOutlineDrawer()});
content?.addEventListener("click",event=>{const target=event.target instanceof Element?event.target:event.target?.parentElement;const button=target?.closest("[data-copy-code]");const code=button?.closest(".code-frame")?.querySelector("code");if(!button||!code)return;copyText(code.textContent||"").then(()=>{button.textContent="Copied";window.setTimeout(()=>button.textContent="Copy",1200)}).catch(error=>showToast(error instanceof Error?error.message:"Copy failed."))});
syncResponsivePanels();${mermaid}`;
}

function makeLineNumbers(text: string): string {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const numbers = ["1"];
  let line = 1;
  let truncated = false;

  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized.charCodeAt(index) !== 10) {
      continue;
    }

    line += 1;

    if (line > MAX_LINE_NUMBER_COUNT) {
      truncated = true;
      break;
    }

    numbers.push(String(line));
  }

  if (truncated) {
    numbers.push("...");
  }

  return numbers.join("\n");
}

function isMetadataLine(line: string): boolean {
  const text = line.replace(/<[^>]*>/g, "").trim();
  return /^[A-Z][A-Za-z0-9 /_.-]{1,48}:\s+/.test(text);
}

function formatMetaPrimitive(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (value === null) {
    return "null";
  }
  return value === undefined ? "" : String(value);
}

function getString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameDisplayTitle(left: string, right: string): boolean {
  return left.trim().replace(/\s+/g, " ").toLowerCase() === right.trim().replace(/\s+/g, " ").toLowerCase();
}

function slugify(value: string): string {
  return value.toLowerCase().trim().replace(/#/g, "").replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "section";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function escapeAttribute(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "-");
}

function escapeAttributeValue(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
