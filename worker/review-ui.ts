import { REVIEW_LIMITS, formatReviewMarkdown } from "../shared/review";
import { embeddedFunction, escapeScriptText } from "./review-frame";

export interface ReviewViewerConfig {
  id: string;
  token: string;
  title: string;
  filename: string;
  // The version on screen: the head on the current viewer, the pin on a pinned one.
  version: number;
  framePath: string;
  // null when the frame shares the viewer's host with an opaque origin.
  frameOrigin: string | null;
}

const COMMENT_ICON = `<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.3A8 8 0 1 1 21 12z"/></svg>`;

const COPY_ICON = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;

export const REVIEW_CSS = `
:root{--pb-amber:#b7791f;--pb-danger:#b4533c;--pb-unanswered:#a34a4c;--pb-shadow:0 12px 32px rgba(40,28,10,.18),0 1px 2px rgba(40,28,10,.08)}
@media(prefers-color-scheme:dark){:root{--pb-amber:#d9a441;--pb-danger:#e07a63;--pb-unanswered:#e0918b;--pb-shadow:0 12px 32px rgba(0,0,0,.5),0 1px 2px rgba(0,0,0,.4)}}
html,body{height:100%;height:100dvh;overflow:hidden;overscroll-behavior:none;background:var(--pb-panel)}
.pb-review :focus-visible,.pagebin-bar :focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px}
.pb-review[hidden],.pb-review [hidden],.pagebin-bar [hidden]{display:none!important}
.pb-stage{display:flex;height:100%;position:relative}
.pb-stage iframe{flex:1;min-width:0}
.pb-comments{border:none;background:none;color:var(--pb-muted);cursor:pointer;padding:4px 7px;border-radius:6px;display:flex;align-items:center;gap:5px;flex-shrink:0;font:inherit;font-size:11.5px}
.pb-comments:hover,.pb-comments[aria-pressed="true"]{color:var(--pb-accent);background:var(--pb-panel)}
.pb-comments svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.pb-comments .n{min-width:1ch;font-variant-numeric:tabular-nums;font-weight:600;color:var(--pb-text)}
.pb-comments[aria-pressed="true"] .n{color:var(--pb-accent)}
.pb-comments .n.bump,.pb-fab .n.bump{animation:pbbump .35s ease-out}
@keyframes pbbump{30%{transform:translateY(-3px) scale(1.15)}}
.pb-affordance{position:fixed;z-index:15;transform:translate(-50%,calc(-100% - 10px));display:inline-flex;align-items:center;gap:6px;padding:6px 11px 6px 9px;border:none;border-radius:999px;background:var(--pb-text);color:var(--pb-panel);font:500 12px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.22);animation:pbrise .16s ease-out}
.pb-affordance::after{content:'';position:absolute;left:50%;bottom:-5px;width:10px;height:10px;background:inherit;transform:translateX(-50%) rotate(45deg);border-radius:2px}
.pb-affordance.below{transform:translate(-50%,14px)}
.pb-affordance.below::after{bottom:auto;top:-5px}
.pb-affordance svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pb-affordance:hover{background:var(--pb-accent)}
.pb-review .pb-affordance:focus-visible{outline-offset:3px}
@keyframes pbrise{from{opacity:0;translate:0 4px}to{opacity:1}}
.pb-composer{position:fixed;z-index:20;width:min(380px,calc(100vw - 24px));background:var(--pb-panel);border:1px solid var(--pb-line);border-radius:10px;box-shadow:var(--pb-shadow);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--pb-text);display:flex;flex-direction:column;animation:pbrise .18s ease-out}
.pb-quote{margin:12px 14px 0;padding:2px 0 2px 10px;border-left:2px solid var(--pb-accent);color:var(--pb-muted);font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.pb-quote::before{content:'\\201C'}.pb-quote::after{content:'\\201D'}
.pb-composer textarea,.pb-card textarea{margin:10px 14px 0;padding:8px 10px;border:1px solid var(--pb-line);border-radius:7px;background:var(--pb-chip);color:var(--pb-text);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;resize:none;min-height:66px;max-height:40vh;field-sizing:content}
.pb-composer textarea:focus,.pb-card textarea:focus{outline:none;border-color:var(--pb-accent);background:var(--pb-panel)}
.pb-composer-foot,.pb-card-editfoot{display:flex;align-items:center;gap:8px;padding:10px 14px 12px}
.pb-hint{flex:1;color:var(--pb-faint);font-size:11px;white-space:nowrap}
.pb-hint kbd{font:inherit;color:var(--pb-muted)}
.pb-btn{font:500 12px/1 ui-sans-serif,system-ui,sans-serif;padding:7px 12px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-panel);color:var(--pb-text);cursor:pointer}
.pb-btn:hover{border-color:var(--pb-accent);color:var(--pb-accent)}
.pb-btn.primary{background:var(--pb-accent);border-color:var(--pb-accent);color:var(--pb-panel)}
.pb-btn.primary:hover{filter:brightness(1.08);color:var(--pb-panel)}
.pb-btn.primary:disabled{opacity:.5;cursor:default;filter:none}
.pb-btn.quiet{border-color:transparent;color:var(--pb-muted)}
.pb-btn.quiet:hover{background:var(--pb-chip);color:var(--pb-text)}
.pb-panel{width:var(--pb-panel-w,340px);flex-shrink:0;display:flex;flex-direction:column;background:var(--pb-panel);border-left:1px solid var(--pb-line);font:13px/1.45 ui-sans-serif,system-ui,sans-serif;color:var(--pb-text);min-height:0;position:relative}
.pb-resize{position:absolute;z-index:3;left:-5px;top:0;bottom:0;width:9px;cursor:col-resize;touch-action:none}
.pb-resize::after{content:'';position:absolute;left:3px;top:0;bottom:0;width:3px;background:transparent;transition:background .15s .1s}
.pb-resize:hover::after,.pb-resize:focus-visible::after,.pb-resizing .pb-resize::after{background:var(--pb-accent)}
.pb-review .pb-resize:focus-visible{outline:none}
.pb-resizing{cursor:col-resize;user-select:none}
.pb-resizing iframe{pointer-events:none}
.pb-panel-head{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 16px;border-bottom:1px solid var(--pb-line);flex-shrink:0}
.pb-panel-head h2{flex:1;min-width:0;margin:0;font-size:11px;font-weight:600;letter-spacing:0;text-transform:uppercase;color:var(--pb-muted);display:flex;flex-wrap:nowrap;white-space:nowrap;align-items:center;gap:2px}
#pb-panel-count{display:contents}
.pb-panel-head h2 .ttl{padding-right:4px}
.pb-panel-head h2 .sep{color:var(--pb-faint);padding:0 1px}
.pb-jump{appearance:none;border:0;background:none;font:inherit;letter-spacing:inherit;text-transform:inherit;color:var(--pb-text);padding:2px 4px;margin:0;border-radius:4px;cursor:pointer}
.pb-jump:hover{color:var(--pb-accent);background:var(--pb-chip)}
.pb-panel-head .pb-copy{padding:4px}
.pb-panel-head .pb-copy svg{width:14px;height:14px}
.pb-list{flex:1;overflow-y:auto;min-height:0;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.pb-empty{margin:auto;padding:24px 20px;text-align:center;color:var(--pb-muted);font-size:12.5px;line-height:1.5;max-width:26ch}
.pb-empty strong{display:block;color:var(--pb-text);font-weight:600;margin-bottom:6px}
.pb-empty kbd{font:inherit;padding:1px 5px;border:1px solid var(--pb-line);border-bottom-width:2px;border-radius:4px;color:var(--pb-text)}
.pb-error{margin:4px 2px 6px;padding:8px 10px;border-radius:6px;font-size:12px;color:var(--pb-danger);background:color-mix(in srgb,var(--pb-danger) 10%,transparent)}
.pb-card{border:1px solid var(--pb-line);border-radius:9px;background:var(--pb-panel);padding:10px 12px 8px;display:flex;flex-direction:column;gap:7px;transition:border-color .2s,box-shadow .2s;position:relative}
.pb-card:hover{border-color:var(--pb-faint)}
.pb-card.flash,.pb-drow.flash{animation:pbCardEmph 1.1s ease-out}
@keyframes pbCardEmph{0%,30%{border-color:var(--pb-accent)}}
.pb-sect{margin:6px 4px 2px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--pb-muted);display:flex;align-items:baseline;gap:6px}
.pb-sect b{font-weight:500;color:var(--pb-faint);text-transform:none;letter-spacing:0}
.pb-sect+.pb-empty{margin:4px 0 10px;padding:12px 10px 16px;max-width:none}
.pb-drow{border:1px solid var(--pb-line);border-radius:9px;background:var(--pb-panel);padding:10px 12px 8px;display:flex;flex-direction:column;gap:6px;transition:border-color .2s}
.pb-drow:hover{border-color:var(--pb-faint)}
.pb-drow .q{appearance:none;width:100%;margin:0;padding:0;border:0;background:none;text-align:left;font:500 13px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--pb-text);cursor:pointer}
.pb-drow .q:hover{color:var(--pb-accent)}
.pb-drow .q:disabled{cursor:default;color:var(--pb-muted)}
.pb-drow .answer{font-size:12.5px;line-height:1.4;color:var(--pb-text);overflow-wrap:anywhere}
.pb-drow .answer .k{color:var(--pb-faint)}
.pb-drow.untouched .answer{color:var(--pb-muted)}
.pb-drow .dnote{font-size:12px;line-height:1.4;color:var(--pb-muted);padding-left:10px;border-left:2px solid var(--pb-line);overflow-wrap:anywhere}
.pb-drow .dnote::before{content:'\\201C'}.pb-drow .dnote::after{content:'\\201D'}
.pb-drow .meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--pb-faint);min-height:22px;flex-wrap:wrap}
.pb-drow .meta .spacer,.pb-card .meta .spacer{flex:1}
.pb-drow .actions{display:flex;gap:2px;align-items:center}
.pb-chip,.pb-tag{--c:var(--pb-muted);display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;line-height:1.35;padding:2px 6px;border-radius:4px;color:var(--c);background:color-mix(in srgb,var(--c) 13%,transparent)}
.pb-chip{white-space:nowrap}
.pb-chip svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pb-chip.kept{--c:var(--pb-green)}
.pb-chip.changed{--c:var(--pb-accent)}
.pb-chip.stale{--c:var(--pb-amber)}
.pb-chip.untouched{--c:var(--pb-unanswered)}
.pb-drow.orphaned{border-style:dashed;border-color:color-mix(in srgb,var(--pb-amber) 55%,var(--pb-line))}
.pb-ib.text{font-size:11px;padding:4px 7px}
.pb-drow .state.saving,.pb-card .state.saving{color:var(--pb-amber);font-size:11px}
button.pb-quote{appearance:none;width:100%;margin:0;padding:2px 0 2px 10px;border:0;border-left:2px solid var(--pb-accent);border-radius:0;background:none;text-align:left;font:inherit;font-size:12px;line-height:1.4;cursor:pointer}
button.pb-quote:hover{color:var(--pb-text)}
button.pb-quote:disabled{cursor:default;color:var(--pb-muted)}
.pb-review button.pb-quote:focus-visible{outline-offset:3px;border-radius:3px}
.pb-card .body{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.45}
.pb-card .meta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--pb-faint);min-height:22px}
.pb-card .state{display:inline-flex;align-items:center;gap:4px}
.pb-card .state.saved{color:var(--pb-green)}
.pb-card .state svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pb-card .actions{display:flex;gap:2px;opacity:.55;transition:opacity .15s}
.pb-card:hover .actions,.pb-card:focus-within .actions{opacity:1}
.pb-ib{border:none;background:none;color:var(--pb-muted);cursor:pointer;padding:4px;border-radius:5px;display:inline-flex;align-items:center;gap:3px;font:inherit;font-size:11px}
.pb-ib svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.pb-ib:hover{color:var(--pb-accent);background:var(--pb-chip)}
.pb-ib.danger:hover{color:var(--pb-danger)}
.pb-ib:disabled{opacity:.35;cursor:default;background:none;color:var(--pb-muted)}
.pb-card.detached{border-style:dashed;border-color:color-mix(in srgb,var(--pb-amber) 55%,var(--pb-line))}
.pb-card.detached .pb-quote{border-left-color:var(--pb-amber);border-left-style:dashed}
.pb-tag{--c:var(--pb-amber);align-self:flex-start}
.pb-tag svg{flex-shrink:0;width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pb-card.addressed{background:color-mix(in srgb,var(--pb-green) 7%,var(--pb-panel))}
.pb-card.addressed .pb-quote{border-left-color:var(--pb-green);border-left-style:dotted}
.pb-card.addressed .body{color:var(--pb-muted)}
.pb-card.addressed .pb-tag{--c:var(--pb-green)}
.pb-card.collapsed{gap:5px;padding-bottom:6px}
.pb-card.collapsed .pb-quote{-webkit-line-clamp:1}
.pb-card .edit{display:flex;flex-direction:column;gap:8px}
.pb-card textarea{margin:0}
.pb-card-editfoot{padding:0}
.pb-panel-foot{border-top:1px solid var(--pb-line);padding:10px 12px;display:flex;align-items:center;gap:8px;flex-shrink:0}
.pb-panel-foot .pb-btn.primary{display:inline-flex;align-items:center;gap:6px}
.pb-panel-foot .pb-btn.primary svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pb-panel-foot .note{flex:1;min-width:0;font-size:11px;color:var(--pb-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pb-panel-foot .pb-btn{white-space:nowrap;flex-shrink:0}
.pb-preview{flex:1;min-height:0;display:flex;flex-direction:column}
.pb-preview pre{flex:1;margin:0;padding:12px 14px;overflow:auto;background:var(--pb-chip);color:var(--pb-text);font:12px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.pb-toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:40;white-space:nowrap;max-width:calc(100vw - 24px);box-sizing:border-box;background:var(--pb-text);color:var(--pb-panel);font:12.5px/1 ui-sans-serif,system-ui,sans-serif;padding:10px 14px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;align-items:center;gap:12px;animation:pbrise .2s ease-out;overflow:hidden;text-overflow:ellipsis}
.pb-toast button{font:inherit;font-weight:600;background:none;border:none;color:var(--pb-accent);cursor:pointer;padding:0;filter:brightness(1.4)}
.pb-fab{display:none;position:fixed;z-index:14;right:calc(16px + env(safe-area-inset-right) + var(--pb-fab-right,0px));bottom:calc(16px + env(safe-area-inset-bottom) + var(--pb-fab-lift,0px));height:46px;min-width:46px;box-sizing:border-box;padding:0 16px 0 14px;align-items:center;justify-content:center;gap:7px;border:none;border-radius:23px;background:var(--pb-accent);color:var(--pb-panel);font:600 13.5px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.24),0 1px 3px rgba(0,0,0,.18);-webkit-tap-highlight-color:transparent;animation:pbrise .18s ease-out}
.pb-fab svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.pb-fab .n{font-variant-numeric:tabular-nums}
.pb-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.pb-fab:not(.selecting) .act,.pb-fab.selecting .n,.pb-fab.selecting .pb-sr{display:none}
.pb-fab.selecting{padding:0 18px 0 15px}
@media (pointer:coarse){.pb-fab.selecting{display:inline-flex}}
@media (max-width:640px){
  #pb-count-btn{display:none}
  .pb-fab{display:inline-flex}
  body:has(.pb-panel:not([hidden])) .pb-fab:not(.selecting){display:none}
  .pb-resize{display:none}
  .pb-panel{position:fixed;left:0;right:0;bottom:0;width:auto;max-height:62vh;border-left:none;border-top:1px solid var(--pb-line);border-radius:14px 14px 0 0;box-shadow:0 -12px 32px rgba(0,0,0,.18);z-index:25;animation:pbsheet .22s ease-out}
  .pb-panel::before{content:'';display:block;width:36px;height:4px;border-radius:2px;background:var(--pb-line);margin:8px auto 0}
  .pb-panel-head{padding-top:6px}
  .pb-list{padding-bottom:12px}
  .pb-composer{left:0;right:0;bottom:0;top:auto!important;width:auto;border-radius:14px 14px 0 0;border-bottom:none;animation:pbsheet .22s ease-out}
  .pb-composer textarea{min-height:88px}
  .pb-hint{display:none}
  .pb-toast{bottom:auto;top:44px}
  @keyframes pbsheet{from{transform:translateY(100%)}to{transform:none}}
}
body:has(.pb-composer:not([hidden])) .pb-fab{display:none!important}
@media (prefers-reduced-motion:reduce){.pb-review,.pb-review *,.pagebin-bar *{animation:none!important}}
`;

export function reviewCountButtonHtml(): string {
  return `<button class="pb-comments" id="pb-count-btn" type="button" aria-pressed="false" aria-controls="pb-panel" title="Comments">${COMMENT_ICON}<span class="n" id="pb-count" aria-live="polite">0</span></button>`;
}

// Wraps the document frame with the review layer: selection action, floating button, panel,
// composer, card templates, and the script that drives them.
export function reviewStageHtml(frameHtml: string, config: ReviewViewerConfig): string {
  const limit = REVIEW_LIMITS.commentBody;
  const modHint = `<span class="pb-hint"><kbd class="pb-mod">Ctrl</kbd>+<kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>`;
  const arrow = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`;

  return `<div class="pb-stage pb-review">
${frameHtml}
<button class="pb-affordance" id="pb-affordance" type="button" hidden><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H8l-4 3v-6.3A8 8 0 1 1 21 12z"/><path d="M9 11h6"/></svg>Comment</button>
<button class="pb-fab" id="pb-fab" type="button" aria-controls="pb-panel" title="Comments">${COMMENT_ICON}<span class="n" id="pb-fab-count" aria-live="polite">0</span><span class="pb-sr">comments</span><span class="act">Comment</span></button>
<aside class="pb-panel" id="pb-panel" hidden aria-label="Review">
<div class="pb-resize" id="pb-resize" role="separator" aria-orientation="vertical" aria-label="Resize review panel" aria-controls="pb-panel" tabindex="0" title="Drag to resize · double-click to reset"></div>
<div class="pb-panel-head"><h2><span class="ttl">Review</span><span id="pb-panel-count"><span class="sep" aria-hidden="true">·</span><button class="pb-jump" id="pb-jump-decisions" type="button" data-sect="decisions" title="Go to decisions"></button><span class="sep" aria-hidden="true">·</span><button class="pb-jump" id="pb-jump-comments" type="button" data-sect="comments" title="Go to comments"></button></span></h2><button class="pb-copy" id="pb-preview-back" type="button" title="Back to list" aria-label="Back to list" hidden><svg viewBox="0 0 24 24"><path d="M19 12H5M11 6l-6 6 6 6"/></svg></button><button class="pb-copy" id="pb-panel-close" type="button" title="Close review" aria-label="Close review"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
<div class="pb-list" id="pb-list" role="list"></div>
<div class="pb-preview" id="pb-preview" hidden><pre id="pb-preview-text" tabindex="0"></pre></div>
<div class="pb-panel-foot"><span class="note" id="pb-foot-note"></span><button class="pb-btn quiet" id="pb-preview-btn" type="button">Preview</button><button class="pb-btn primary" id="pb-copy-response" type="button">${COPY_ICON}Copy response</button></div>
</aside>
</div>
<div class="pb-composer pb-review" id="pb-composer" hidden role="dialog" aria-label="New comment">
<div class="pb-quote" id="pb-composer-quote"></div>
<textarea id="pb-composer-text" rows="3" maxlength="${limit}" placeholder="What should the agent change?" aria-label="Comment"></textarea>
<div class="pb-composer-foot">${modHint}<button class="pb-btn quiet" id="pb-composer-cancel" type="button">Cancel</button><button class="pb-btn primary" id="pb-composer-save" type="button" disabled>Comment</button></div>
</div>
<template id="pb-tpl-decision"><article class="pb-drow" role="listitem" tabindex="-1"><button class="q" type="button" title="Jump to this decision"></button><div class="answer"></div><div class="dnote" hidden></div><div class="meta"><span class="pb-chip"></span><span class="state saving"></span><span class="spacer"></span><span class="actions"><button class="pb-ib text" data-act="keep" type="button" title="Confirm the recommended answer">Keep recommendation</button><button class="pb-ib" data-act="jump-decision" type="button" title="Jump to this decision">${arrow}</button></span></div></article></template>
<template id="pb-tpl-card"><article class="pb-card" role="listitem" tabindex="-1"><div class="pb-tag" hidden></div><button class="pb-quote" type="button" title="Jump to this text"></button><div class="body"></div><div class="edit" hidden><textarea rows="3" maxlength="${limit}" aria-label="Edit comment"></textarea><div class="pb-card-editfoot">${modHint}<button class="pb-btn quiet" data-act="edit-cancel" type="button">Cancel</button><button class="pb-btn primary" data-act="edit-save" type="button">Save</button></div></div><div class="meta"><span class="when"></span><span class="state"></span><span class="spacer"></span><span class="actions"><button class="pb-ib text" data-act="expand" type="button" hidden>Show</button><button class="pb-ib text" data-act="reopen" type="button" title="Reopen this comment for the agent" hidden>Reopen</button><button class="pb-ib" data-act="jump" type="button" title="Jump to anchor">${arrow}</button><button class="pb-ib" data-act="edit" type="button" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12 8l4 4"/></svg></button><button class="pb-ib danger" data-act="delete" type="button" title="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></span></div></article></template>
<script type="application/json" id="pb-review-config">${reviewConfigJson(config)}</script>
<script>${reviewViewerScript()}</script>`;
}

function reviewConfigJson(config: ReviewViewerConfig): string {
  return escapeScriptText(JSON.stringify({ ...config, limits: REVIEW_LIMITS }));
}

export function embeddedFormatterSource(): string {
  return embeddedFunction("formatReviewMarkdown", formatReviewMarkdown);
}

export interface SerialSaver {
  request: () => void;
  busy: () => boolean;
}

// Keeps one save in flight per decision. Requests made meanwhile collapse into a single
// follow-up save, and send reads the latest answer when it runs, so an older answer can never
// land after a newer one. Embedded in the viewer script.
export function createSerialSaver(send: () => Promise<void>, onIdle: () => void): SerialSaver {
  let running = false;
  let queued = false;

  const run = async (): Promise<void> => {
    running = true;

    do {
      queued = false;

      try {
        await send();
      } catch {
        // send reports its own failures; the next queued save still runs.
      }
    } while (queued);

    running = false;
    onIdle();
  };

  return {
    request: () => {
      if (running) queued = true;
      else void run();
    },
    busy: () => running || queued,
  };
}

export function reviewViewerScript(): string {
  // Each embedded function may carry its own __name shim; keep only the first declaration.
  const helpers = [
    embeddedFormatterSource(),
    embeddedFunction("createSerialSaver", createSerialSaver),
  ]
    .join("\n")
    .split("\n")
    .filter(
      (line, index, lines) => !line.startsWith("const __name =") || lines.indexOf(line) === index,
    )
    .join("\n");

  return `(() => {
${helpers}
${VIEWER_SCRIPT}
})();`;
}

const VIEWER_SCRIPT = `
  const config = JSON.parse(document.getElementById("pb-review-config").textContent);
  const LIMITS = config.limits;
  const API = "/api/artifacts/" + encodeURIComponent(config.id) + "/review/" + encodeURIComponent(config.token);
  const DRAFT_KEY = "pagebin:review-draft:" + config.id;
  const FIRST_SAVE_KEY = "pagebin:review-first-save:" + config.id;
  const PANEL_KEY = "pagebin:review-panel-width";
  const FRAME_TARGET = config.frameOrigin || "*";
  const UNDO_MS = 6000;
  const DECISION_SAVE_DELAY_MS = 400;
  const PANEL_MIN = 340;
  // Orders this page's decision writes on the server, including keepalive writes at pagehide.
  const WRITE_PAGE = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b & 63]).join("");
  let writeCount = 0;

  const $ = (id) => document.getElementById(id);
  const frame = $("pagebin-frame");
  const affordance = $("pb-affordance");
  const fab = $("pb-fab");
  const panel = $("pb-panel");
  const list = $("pb-list");
  const composer = $("pb-composer");
  const composerText = $("pb-composer-text");
  const composerSave = $("pb-composer-save");
  const preview = $("pb-preview");
  const resizer = $("pb-resize");
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const mobile = () => matchMedia("(max-width:640px)").matches;
  const selectViaFab = () => mobile() || matchMedia("(pointer:coarse)").matches;
  const setModKeys = (scope) => scope.querySelectorAll(".pb-mod").forEach((k) => (k.textContent = isMac ? "\\u2318" : "Ctrl"));
  setModKeys(document);

  const state = {
    comments: [],
    decisions: new Map(),
    decisionDesc: [],
    described: false,
    panelOpen: false,
    view: "list",
    selection: null,
    draft: null,
    editingId: null,
    editDraft: null,
    expanded: new Set(),
    frameReady: false,
    frameIsEntry: true,
    loaded: false,
    loadError: "",
    draftRestored: false,
  };
  const pendingDeletes = new Map();

  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>';
  const ICON_DASH = '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>';
  const ICON_WARN = '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.8 2.5 17.5a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/></svg>';
  const ICON_DETACHED = '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/><path d="M4 4l16 16"/></svg>';

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const isString = (value) => typeof value === "string";
  const errorText = (error) => (error instanceof Error ? error.message : "network error");
  const relTime = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(s)) return "";
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(iso).toISOString().slice(0, 10);
  };
  const excerpt = (text, n) => (text.length > n ? text.slice(0, n - 1).trimEnd() + "\\u2026" : text);
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const storage = (kind) => {
    try {
      return kind === "local" ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  };
  const stored = (kind, key) => {
    try {
      return storage(kind)?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const store = (kind, key, value) => {
    try {
      if (value === null) storage(kind)?.removeItem(key);
      else storage(kind)?.setItem(key, value);
    } catch {}
  };

  // ---- API ----
  async function api(method, path, body, keepalive) {
    const init = { method, cache: "no-store", credentials: "same-origin", headers: {} };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    if (keepalive) init.keepalive = true;
    const response = await fetch(API + path, init);
    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok) throw new Error(payload && isString(payload.error) ? payload.error : "Request failed (" + response.status + ")");
    return payload;
  }

  const validAnchor = (a) => !!a && isString(a.quote) && isString(a.prefix) && isString(a.suffix) && Number.isInteger(a.version);
  const validComment = (c) => !!c && isString(c.id) && validAnchor(c.anchor) && isString(c.body) && (c.status === "open" || c.status === "addressed");
  const validDecision = (d) => !!d && isString(d.id) && Array.isArray(d.controls) && !!d.values && typeof d.values === "object";
  const localComment = (c) => ({ ...c, found: null, start: null, saving: false, local: false });

  async function load() {
    try {
      const payload = await api("GET", "");
      const review = payload && payload.review ? payload.review : {};
      state.comments = (Array.isArray(review.comments) ? review.comments : []).filter(validComment).map(localComment);
      state.decisions.clear();
      for (const d of Array.isArray(review.decisions) ? review.decisions : []) {
        if (validDecision(d)) state.decisions.set(d.id, { ...d, notOffered: [], saving: false, saveTimer: 0, saver: null });
      }
      state.loaded = true;
      state.loadError = "";
    } catch (error) {
      state.loadError = error instanceof Error ? error.message : "could not load the review";
    }
    render();
    if (state.frameReady) syncFrame();
  }

  // ---- frame messaging ----
  function send(message) {
    if (state.frameReady && frame.contentWindow) frame.contentWindow.postMessage(message, FRAME_TARGET);
  }

  function pushHighlights() {
    send({ type: "pb:highlights", items: state.comments.map((c) => ({ id: c.id, anchor: c.anchor, state: c.status })) });
  }

  function savedDecisionValues() {
    const values = {};
    for (const rec of state.decisions.values()) values[rec.id] = rec.values;
    return values;
  }

  function syncFrame() {
    if (!state.frameIsEntry) return;
    pushHighlights();
    if (state.loaded) send({ type: "pb:decisions-apply", values: savedDecisionValues() });
    restoreDraft();
  }

  const samePath = (a, b) => {
    try {
      return decodeURIComponent(a) === decodeURIComponent(b);
    } catch {
      return a === b;
    }
  };

  function parseSelection(msg) {
    const a = msg.anchor;
    if (!a || !isString(a.quote) || !a.quote.trim() || !msg.rect) return null;
    return {
      anchor: {
        quote: a.quote.slice(0, LIMITS.quote),
        prefix: isString(a.prefix) ? a.prefix.slice(-LIMITS.anchorContext) : "",
        suffix: isString(a.suffix) ? a.suffix.slice(0, LIMITS.anchorContext) : "",
        version: config.version,
      },
      rect: msg.rect,
      end: msg.end || msg.rect,
      start: Number.isFinite(msg.start) ? msg.start : null,
    };
  }

  // ---- selection action ----
  function setFabSelecting(on) {
    fab.classList.toggle("selecting", on);
    fab.title = on ? "Comment on selection" : "Comments";
    const sheetOpen = !panel.hidden && mobile();
    const sideOpen = !panel.hidden && !mobile();
    fab.style.setProperty("--pb-fab-lift", on && sheetOpen ? panel.offsetHeight + "px" : "0px");
    fab.style.setProperty("--pb-fab-right", on && sideOpen ? panel.offsetWidth + "px" : "0px");
  }

  function hideAffordance() {
    affordance.hidden = true;
    setFabSelecting(false);
  }

  // Touch layouts: the OS selection menu sits above the selection, so the action moves to the FAB.
  function placeAffordance(sel) {
    if (selectViaFab()) {
      affordance.hidden = true;
      setFabSelecting(true);
      return;
    }
    setFabSelecting(false);
    const box = frame.getBoundingClientRect();
    const r = sel.end || sel.rect;
    const x = Math.min(Math.max(box.left + r.left + r.width / 2, 60), box.right - 60);
    const topEdge = box.top + sel.rect.top;
    const below = topEdge < 34 + 48;
    affordance.classList.toggle("below", below);
    affordance.style.left = x + "px";
    affordance.style.top = (below ? box.top + sel.rect.bottom : topEdge) + "px";
    affordance.hidden = false;
  }

  // ---- drafts ----
  function readDraft() {
    try {
      const draft = JSON.parse(stored("local", DRAFT_KEY) || "null");
      return draft && validAnchor(draft.anchor) && isString(draft.body) ? draft : null;
    } catch {
      return null;
    }
  }

  function writeDraft() {
    if (!state.draft) return;
    const body = composerText.value;
    store("local", DRAFT_KEY, body.trim() ? JSON.stringify({ anchor: state.draft.anchor, body, start: state.draft.start }) : null);
  }

  function restoreDraft() {
    if (state.draftRestored || !composer.hidden) return;
    state.draftRestored = true;
    const draft = readDraft();
    if (draft) openComposer({ anchor: draft.anchor, rect: null, end: null, start: Number.isFinite(draft.start) ? draft.start : null }, draft.body);
  }

  // ---- composer ----
  function openComposer(sel, body) {
    state.draft = sel;
    state.selection = null;
    hideAffordance();
    send({ type: "pb:draft", anchor: sel.anchor });
    $("pb-composer-quote").textContent = excerpt(sel.anchor.quote, 220);
    composerText.value = body || "";
    composerSave.disabled = composerText.value.trim() === "";
    composer.hidden = false;
    positionComposer(sel);
    composerText.focus();
  }

  function positionComposer(sel) {
    if (mobile()) {
      composer.style.left = composer.style.top = "";
      return;
    }
    const box = frame.getBoundingClientRect();
    const w = composer.offsetWidth;
    const h = composer.offsetHeight;
    let left = Math.max(12, box.right - w - 16);
    let top = Math.max(44, box.bottom - h - 16);
    if (sel.rect) {
      left = Math.min(Math.max(box.left + sel.rect.left, 12), window.innerWidth - w - 12);
      top = box.top + sel.rect.bottom + 10;
      if (top + h > window.innerHeight - 12) top = Math.max(44, box.top + sel.rect.top - h - 10);
    }
    composer.style.left = left + "px";
    composer.style.top = top + "px";
  }

  function closeComposer(discard) {
    if (composer.hidden) return;
    composer.hidden = true;
    state.draft = null;
    if (discard) store("local", DRAFT_KEY, null);
    send({ type: "pb:draft", anchor: null });
  }

  async function saveFromComposer() {
    const body = composerText.value.trim();
    const draft = state.draft;
    if (!body || !draft) return;
    const now = new Date().toISOString();
    const comment = { id: "local-" + Math.random().toString(36).slice(2), anchor: draft.anchor, body, status: "open", createdAt: now, updatedAt: now, found: true, start: draft.start, saving: true, local: true };
    const firstSave = !stored("session", FIRST_SAVE_KEY);
    state.comments.push(comment);
    closeComposer(false);
    send({ type: "pb:clear-selection" });
    pushHighlights();
    render({ bump: true });
    if (firstSave) {
      store("session", FIRST_SAVE_KEY, "1");
      if (!state.panelOpen && !mobile()) setPanel(true);
    }
    try {
      const payload = await api("POST", "/comments", { anchor: draft.anchor, body });
      if (!payload || !validComment(payload.comment)) throw new Error("unexpected response");
      Object.assign(comment, payload.comment, { saving: false, local: false });
      store("local", DRAFT_KEY, null);
      pushHighlights();
      render();
      toast("Comment saved");
    } catch (error) {
      state.comments = state.comments.filter((c) => c !== comment);
      pushHighlights();
      render({ bump: true });
      openComposer(draft, body);
      toast("Comment not saved: " + errorText(error));
    }
  }

  // ---- panel ----
  function setPanel(open) {
    state.panelOpen = open;
    panel.hidden = !open;
    $("pb-count-btn").setAttribute("aria-pressed", String(open));
    if (open) {
      closeComposer(false);
      hideAffordance();
      render();
    } else if (fab.classList.contains("selecting")) setFabSelecting(true);
  }

  function orderedComments() {
    return [...state.comments].sort((a, b) => {
      const af = a.found !== false;
      const bf = b.found !== false;
      if (af !== bf) return af ? -1 : 1;
      if (af && a.start !== null && b.start !== null && a.start !== b.start) return a.start - b.start;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  }

  const inResponse = (c) => c.status === "open" && c.found !== false;

  // ---- decisions ----
  // A view merges the frame's description of a decision in this version with the saved record.
  const normValue = (v) => (Array.isArray(v) ? [...v].sort() : v === undefined ? null : v);
  const sameValue = (a, b) => JSON.stringify(normValue(a)) === JSON.stringify(normValue(b));
  const isNote = (c) => c.name.endsWith(":note");

  function statusOf(v) {
    const changed = v.controls.filter((c) => !isNote(c)).some((c) => !sameValue(v.values[c.name], c.default));
    return changed ? "changed" : v.interacted ? "kept" : "untouched";
  }

  function noteOf(v) {
    return v.controls
      .filter(isNote)
      .map((c) => {
        const value = v.values[c.name];
        return (Array.isArray(value) ? value.join(" ") : value || "").trim();
      })
      .filter(Boolean)
      .join(" / ");
  }

  function labelText(control, value) {
    const pick = (val) => {
      const option = (control.options || []).find((o) => o.value === val);
      return option ? option.label : String(val);
    };
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return "none selected";
    return Array.isArray(value) ? value.map(pick).join(", ") : pick(value);
  }

  function answerParts(v, fn) {
    const answerable = v.controls.filter((c) => !isNote(c));
    if (answerable.length === 1) return fn(answerable[0], v.values[answerable[0].name]);
    return answerable.map((c) => (c.name.slice(v.id.length + 1) || c.name) + "=" + fn(c, v.values[c.name])).join(", ");
  }

  function decisionViews() {
    const present = state.decisionDesc.map((d) => {
      const rec = state.decisions.get(d.id);
      const values = {};
      for (const c of d.controls) values[c.name] = rec && c.name in rec.values ? rec.values[c.name] : (d.values[c.name] ?? null);
      return {
        id: d.id,
        question: d.question,
        controls: d.controls,
        values,
        interacted: !!(rec && rec.interacted),
        answeredVersion: rec ? rec.answeredVersion : config.version,
        updatedAt: rec ? rec.updatedAt : "",
        notOfferedNames: rec ? rec.notOffered : [],
        orphaned: false,
        saving: !!(rec && rec.saving),
        start: Number.isFinite(d.start) ? d.start : 0,
      };
    });
    present.sort((a, b) => a.start - b.start);
    const orphans = state.described
      ? [...state.decisions.values()]
          .filter((r) => !state.decisionDesc.some((d) => d.id === r.id))
          .map((r) => ({ ...r, notOfferedNames: [], orphaned: true, saving: !!r.saving }))
      : [];
    return [...present, ...orphans];
  }

  function recordFrom(view, notOffered) {
    const rec = state.decisions.get(view.id) || { id: view.id, saving: false, saveTimer: 0, saver: null, notOffered: [], updatedAt: "" };
    Object.assign(rec, {
      question: view.question,
      controls: view.controls,
      values: { ...view.values },
      interacted: true,
      answeredVersion: config.version,
      notOffered,
    });
    state.decisions.set(rec.id, rec);
    return rec;
  }

  function decisionPayload(rec) {
    const values = {};
    for (const c of rec.controls) values[c.name] = rec.values[c.name] ?? null;
    return { id: rec.id, question: rec.question, controls: rec.controls, values, interacted: true, answeredVersion: rec.answeredVersion, clientSeq: { page: WRITE_PAGE, n: ++writeCount } };
  }

  function saverFor(rec) {
    if (!rec.saver) {
      rec.saver = createSerialSaver(
        () => putDecision(rec, false),
        () => {
          rec.saving = !!rec.saveTimer;
          render();
        },
      );
    }
    return rec.saver;
  }

  function scheduleDecisionSave(rec, delay) {
    clearTimeout(rec.saveTimer);
    rec.dirty = true;
    rec.saving = true;
    rec.saveTimer = setTimeout(() => {
      rec.saveTimer = 0;
      saverFor(rec).request();
    }, delay);
    render();
  }

  // The payload is built when the request starts, so a queued save always carries the latest answer.
  async function putDecision(rec, keepalive) {
    rec.dirty = false;
    try {
      const payload = await api("PUT", "/decisions/" + encodeURIComponent(rec.id), decisionPayload(rec), keepalive);
      if (payload && payload.decision && isString(payload.decision.updatedAt)) rec.updatedAt = payload.decision.updatedAt;
    } catch (error) {
      if (!keepalive) toast("Decision not saved: " + errorText(error));
    }
  }

  function keepRecommendation(id) {
    const view = decisionViews().find((v) => v.id === id);
    if (!view || view.orphaned) return;
    const rec = recordFrom(view, []);
    clearTimeout(rec.saveTimer);
    rec.saveTimer = 0;
    rec.dirty = true;
    rec.saving = true;
    saverFor(rec).request();
    render();
  }

  // ---- copy response ----
  function responseMarkdown() {
    const decisions = decisionViews().map((v) => ({
      id: v.id,
      question: v.question,
      controls: v.controls,
      values: v.values,
      interacted: v.interacted,
      answeredVersion: v.answeredVersion,
      updatedAt: v.updatedAt || "",
      orphaned: v.orphaned,
      notOffered: v.notOfferedNames.length > 0,
    }));
    const comments = orderedComments().map((c) => ({
      id: c.id,
      anchor: c.anchor,
      body: c.body,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      found: state.frameIsEntry ? c.found : null,
    }));
    return formatReviewMarkdown({
      artifact: { id: config.id, title: config.title, filename: config.filename, version: config.version },
      decisions,
      comments,
      listsUnanswered: true,
    });
  }

  // ---- rendering ----
  function render(options) {
    const bump = !!(options && options.bump);
    const count = state.comments.length;
    for (const n of [$("pb-count"), $("pb-fab-count")]) {
      if (n.textContent === String(count)) continue;
      n.textContent = String(count);
      if (bump) {
        n.classList.remove("bump");
        void n.offsetWidth;
        n.classList.add("bump");
      }
    }
    const views = decisionViews();
    const answered = views.filter((v) => statusOf(v) !== "untouched").length;
    const open = state.comments.filter(inResponse).length;
    const headCounts = [
      [$("pb-jump-decisions"), views.length ? answered + "/" + views.length + " decided" : ""],
      [$("pb-jump-comments"), count ? plural(count, "comment") : ""],
    ];
    for (const [btn, label] of headCounts) {
      btn.textContent = label;
      btn.hidden = btn.previousElementSibling.hidden = !label;
    }

    const sendable = open > 0 || answered > 0;
    $("pb-copy-response").disabled = !sendable;
    $("pb-preview-btn").disabled = !sendable;

    if (state.view === "preview") {
      list.hidden = true;
      preview.hidden = false;
      $("pb-preview-text").textContent = responseMarkdown();
    } else {
      list.hidden = false;
      preview.hidden = true;
    }
    $("pb-preview-back").hidden = state.view !== "preview";

    if (!state.panelOpen) return;
    const scrollTop = list.scrollTop;
    // Async renders rebuild the list; carry an open editor's text, caret, and focus across.
    const liveEditor = list.querySelector(".pb-card .edit:not([hidden]) textarea");
    if (liveEditor && state.editDraft) {
      state.editDraft.value = liveEditor.value;
      state.editDraft.start = liveEditor.selectionStart;
      state.editDraft.end = liveEditor.selectionEnd;
      if (document.activeElement === liveEditor) state.editDraft.focus = true;
    }
    list.replaceChildren();
    if (state.loadError) {
      const error = document.createElement("div");
      error.className = "pb-error";
      error.textContent = "Review unavailable: " + state.loadError;
      list.append(error);
    }
    if (views.length) {
      list.append(sectionHeading("Decisions", answered + " of " + views.length + " answered"));
      for (const v of views) list.append(decisionRow(v));
    }
    list.append(sectionHeading("Comments", count ? String(count) : ""));
    if (count === 0) {
      const empty = document.createElement("div");
      empty.className = "pb-empty";
      empty.innerHTML = "<strong>No comments yet</strong>Select text in the document, then press <kbd>Comment</kbd>. Keyboard: select, then <kbd>Tab</kbd>.";
      list.append(empty);
    } else {
      for (const c of orderedComments()) list.append(card(c));
    }
    list.scrollTop = scrollTop;
  }

  function sectionHeading(title, detail) {
    const h = document.createElement("h3");
    h.className = "pb-sect";
    h.dataset.sect = title.toLowerCase();
    h.append(title);
    if (detail) {
      const b = document.createElement("b");
      b.textContent = detail;
      h.append(b);
    }
    return h;
  }

  function decisionRow(v) {
    const el = $("pb-tpl-decision").content.firstElementChild.cloneNode(true);
    const status = statusOf(v);
    el.dataset.id = v.id;
    el.classList.add(status);
    el.classList.toggle("orphaned", v.orphaned);
    const q = el.querySelector(".q");
    q.textContent = v.question;
    q.disabled = v.orphaned;
    q.title = v.orphaned ? "This decision is not in this version" : "Jump to this decision";
    const answerText = answerParts(v, (c, val) => labelText(c, val));
    const wasText = answerParts(v, (c, val) => {
      if (Array.isArray(val) || Array.isArray(c.default)) {
        const now = Array.isArray(val) ? val : [];
        const was = Array.isArray(c.default) ? c.default : [];
        const added = now.filter((x) => !was.includes(x)).map((x) => "+ " + labelText(c, x));
        const removed = was.filter((x) => !now.includes(x)).map((x) => "\\u2212 " + labelText(c, x));
        return [...added, ...removed].join(", ") || "unchanged";
      }
      return "was " + labelText(c, c.default);
    });
    el.querySelector(".answer").innerHTML =
      status === "untouched"
        ? '<span class="k">Default \\u00b7</span> ' + escapeHtml(answerText)
        : status === "changed"
          ? escapeHtml(answerText) + ' <span class="k">\\u00b7 ' + escapeHtml(wasText) + "</span>"
          : escapeHtml(answerText);
    const note = noteOf(v);
    const noteEl = el.querySelector(".dnote");
    noteEl.hidden = !note;
    noteEl.textContent = note;
    const chip = el.querySelector(".pb-chip");
    if (v.orphaned) {
      chip.classList.add("stale");
      chip.innerHTML = ICON_WARN + " Answered on v" + escapeHtml(v.answeredVersion) + " \\u00b7 not in v" + config.version;
    } else if (v.notOfferedNames.length) {
      chip.classList.add("stale");
      chip.innerHTML = ICON_WARN + " Option removed in v" + config.version + " \\u00b7 answer kept";
    } else if (status === "changed") {
      chip.classList.add("changed");
      chip.textContent = "Changed";
    } else if (status === "kept") {
      chip.classList.add("kept");
      chip.innerHTML = ICON_CHECK + " Kept recommendation";
    } else {
      chip.classList.add("untouched");
      chip.innerHTML = ICON_DASH + " Not answered";
    }
    el.querySelector(".state").textContent = v.saving ? "Saving\\u2026" : "";
    el.querySelector('[data-act="keep"]').hidden = status !== "untouched" || v.orphaned;
    el.querySelector('[data-act="jump-decision"]').disabled = v.orphaned;
    return el;
  }

  function card(c) {
    const el = $("pb-tpl-card").content.firstElementChild.cloneNode(true);
    setModKeys(el);
    const addressed = c.status === "addressed";
    const collapsed = addressed && !state.expanded.has(c.id);
    const detached = c.found === false && state.frameIsEntry;
    el.dataset.id = c.id;
    el.classList.toggle("detached", detached);
    el.classList.toggle("addressed", addressed);
    el.classList.toggle("collapsed", collapsed);
    const tag = el.querySelector(".pb-tag");
    if (addressed) {
      tag.hidden = false;
      tag.innerHTML = ICON_CHECK + " Addressed by agent";
    } else if (detached) {
      tag.hidden = false;
      tag.innerHTML = ICON_DETACHED + " Text not found in v" + config.version + " \\u00b7 made on v" + escapeHtml(c.anchor.version);
    }
    const quote = el.querySelector(".pb-quote");
    quote.textContent = excerpt(c.anchor.quote, 140);
    quote.disabled = c.found === false;
    quote.title = c.found === false ? "Anchor not found in this version" : "Jump to this text";
    const bodyEl = el.querySelector(".body");
    bodyEl.textContent = c.body;
    bodyEl.hidden = collapsed;
    el.querySelector(".when").textContent = "v" + c.anchor.version + " \\u00b7 " + relTime(c.updatedAt) + (c.updatedAt !== c.createdAt && !addressed ? " (edited)" : "");
    const stateEl = el.querySelector(".state");
    stateEl.className = "state " + (c.saving ? "saving" : "saved");
    stateEl.innerHTML = c.saving ? "Saving\\u2026" : addressed ? "" : ICON_CHECK + " Saved";
    const expand = el.querySelector('[data-act="expand"]');
    expand.hidden = !addressed;
    expand.textContent = collapsed ? "Show" : "Hide";
    const reopenButton = el.querySelector('[data-act="reopen"]');
    reopenButton.hidden = !addressed;
    reopenButton.disabled = c.saving;
    el.querySelector('[data-act="jump"]').disabled = c.found === false;
    el.querySelector('[data-act="edit"]').hidden = addressed;
    el.querySelector('[data-act="edit"]').disabled = c.saving;
    el.querySelector('[data-act="delete"]').disabled = c.saving;
    if (state.editingId === c.id) {
      bodyEl.hidden = true;
      const edit = el.querySelector(".edit");
      edit.hidden = false;
      const ta = edit.querySelector("textarea");
      const draft = state.editDraft && state.editDraft.id === c.id ? state.editDraft : null;
      ta.value = draft ? draft.value : c.body;
      if (draft && draft.focus) {
        draft.focus = false;
        queueMicrotask(() => {
          ta.focus();
          ta.setSelectionRange(draft.start, draft.end);
        });
      }
    }
    return el;
  }

  function jumpTo(id) {
    send({ type: "pb:jump", id });
    if (mobile()) setPanel(false);
  }

  function focusCard(id) {
    const el = [...list.querySelectorAll("[data-id]")].find((node) => node.dataset.id === id);
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    el.focus({ preventScroll: true });
  }

  // ---- comment mutations ----
  async function commitEdit(cardEl, c) {
    const body = cardEl.querySelector("textarea").value.trim();
    state.editingId = null;
    if (!body || body === c.body) {
      render();
      focusCard(c.id);
      return;
    }
    const previous = c.body;
    c.body = body;
    c.saving = true;
    render();
    focusCard(c.id);
    try {
      const payload = await api("PATCH", "/comments/" + encodeURIComponent(c.id), { body });
      if (payload && validComment(payload.comment)) Object.assign(c, payload.comment);
    } catch (error) {
      c.body = previous;
      toast("Edit not saved: " + errorText(error));
    }
    c.saving = false;
    render();
  }

  async function reopen(c) {
    c.saving = true;
    render();
    try {
      const payload = await api("PATCH", "/comments/" + encodeURIComponent(c.id), { status: "open" });
      if (payload && validComment(payload.comment)) Object.assign(c, payload.comment);
      else c.status = "open";
      state.expanded.delete(c.id);
      pushHighlights();
    } catch (error) {
      toast("Not reopened: " + errorText(error));
    }
    c.saving = false;
    render();
    focusCard(c.id);
  }

  // Deletion waits out the undo window so Undo never has to recreate a comment.
  function deleteComment(id) {
    const index = state.comments.findIndex((c) => c.id === id);
    if (index === -1) return;
    const [removed] = state.comments.splice(index, 1);
    pushHighlights();
    render({ bump: true });
    const pending = { comment: removed, index, timer: 0 };
    pending.timer = setTimeout(() => commitDelete(pending, false), UNDO_MS);
    pendingDeletes.set(removed.id, pending);
    toast("Comment deleted", {
      action: "Undo",
      duration: UNDO_MS,
      onAction: () => {
        clearTimeout(pending.timer);
        pendingDeletes.delete(removed.id);
        state.comments.splice(Math.min(pending.index, state.comments.length), 0, removed);
        pushHighlights();
        render({ bump: true });
      },
    });
  }

  async function commitDelete(pending, keepalive) {
    pendingDeletes.delete(pending.comment.id);
    try {
      await api("DELETE", "/comments/" + encodeURIComponent(pending.comment.id), undefined, keepalive);
    } catch (error) {
      if (keepalive) return;
      state.comments.splice(Math.min(pending.index, state.comments.length), 0, pending.comment);
      pushHighlights();
      render({ bump: true });
      toast("Delete failed: " + errorText(error));
    }
  }

  // ---- toast ----
  let toastTimer = 0;
  function toast(text, options) {
    document.querySelector(".pb-toast")?.remove();
    const el = document.createElement("div");
    el.className = "pb-toast pb-review";
    el.setAttribute("role", "status");
    el.append(text);
    if (options && options.action) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = options.action;
      b.addEventListener("click", () => {
        options.onAction();
        el.remove();
      });
      el.append(b);
    }
    document.body.append(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), (options && options.duration) || 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      area.remove();
      return ok;
    }
  }

  // ---- messages from the frame ----
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    if (event.origin !== (config.frameOrigin || "null")) return;
    const msg = event.data;
    if (!msg || !isString(msg.type)) return;
    switch (msg.type) {
      case "pb:ready":
        state.frameReady = true;
        state.frameIsEntry = isString(msg.path) && samePath(msg.path, config.framePath);
        state.described = false;
        state.decisionDesc = [];
        if (!state.frameIsEntry) {
          hideAffordance();
          closeComposer(false);
          for (const c of state.comments) c.found = null;
        }
        syncFrame();
        render();
        break;
      case "pb:decisions":
        if (!state.frameIsEntry || !Array.isArray(msg.decisions)) break;
        state.decisionDesc = msg.decisions.filter((d) => d && isString(d.id) && isString(d.question) && Array.isArray(d.controls) && d.values && typeof d.values === "object");
        state.described = true;
        for (const d of state.decisionDesc) {
          const rec = state.decisions.get(d.id);
          if (rec) rec.notOffered = Array.isArray(d.notOffered) ? d.notOffered : [];
        }
        render();
        break;
      case "pb:decision-input": {
        if (!state.frameIsEntry || !msg.values || typeof msg.values !== "object") break;
        const view = decisionViews().find((v) => v.id === msg.id && !v.orphaned);
        if (!view) break;
        const rec = state.decisions.get(msg.id);
        const values = { ...view.values };
        for (const c of view.controls) if (c.name in msg.values) values[c.name] = msg.values[c.name];
        const kept = rec ? rec.notOffered : [];
        for (const name of kept) if (name !== msg.name && name in rec.values) values[name] = rec.values[name];
        // A text field's change event repeats its last input on blur. Re-rendering then would
        // replace the panel button the reader is clicking between mousedown and mouseup.
        if (rec && rec.interacted && view.controls.every((c) => sameValue(rec.values[c.name], values[c.name]))) break;
        const updated = recordFrom({ ...view, values }, kept.filter((name) => name !== msg.name));
        scheduleDecisionSave(updated, DECISION_SAVE_DELAY_MS);
        break;
      }
      case "pb:selection": {
        if (!state.frameIsEntry) break;
        const sel = parseSelection(msg);
        if (!composer.hidden) {
          if (sel && state.draft && sel.anchor.quote === state.draft.anchor.quote) {
            state.draft = { ...state.draft, rect: sel.rect, end: sel.end };
            positionComposer(state.draft);
          }
          break;
        }
        state.selection = sel;
        if (sel) placeAffordance(sel);
        else hideAffordance();
        break;
      }
      case "pb:tab": {
        if (!state.frameIsEntry || !composer.hidden) break;
        const sel = parseSelection(msg);
        if (!sel) break;
        state.selection = sel;
        placeAffordance(sel);
        (selectViaFab() ? fab : affordance).focus({ preventScroll: true });
        break;
      }
      case "pb:resolved":
        if (!state.frameIsEntry || !Array.isArray(msg.results)) break;
        for (const r of msg.results) {
          const c = state.comments.find((x) => r && x.id === r.id);
          if (!c) continue;
          c.found = r.found === true;
          c.start = Number.isFinite(r.start) ? r.start : null;
        }
        render();
        break;
      case "pb:highlight-click":
        if (!isString(msg.id)) break;
        setPanel(true);
        focusCard(msg.id);
        break;
    }
  });

  frame.addEventListener("load", () => {
    state.frameReady = false;
    frame.contentWindow?.postMessage({ type: "pb:ping" }, FRAME_TARGET);
  });

  // ---- wiring ----
  affordance.addEventListener("click", () => state.selection && openComposer(state.selection, ""));
  composerText.addEventListener("input", () => {
    composerSave.disabled = composerText.value.trim() === "";
    writeDraft();
  });
  composerText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveFromComposer();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeComposer(true);
    }
  });
  composerSave.addEventListener("click", saveFromComposer);
  $("pb-composer-cancel").addEventListener("click", () => closeComposer(true));

  const panelToggle = () => (mobile() ? fab : $("pb-count-btn"));
  $("pb-count-btn").addEventListener("click", () => setPanel(!state.panelOpen));
  fab.addEventListener("click", () => {
    if (fab.classList.contains("selecting") && state.selection) openComposer(state.selection, "");
    else setPanel(true);
  });
  $("pb-panel-close").addEventListener("click", () => {
    setPanel(false);
    panelToggle().focus();
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.editingId === null && e.target.tagName !== "TEXTAREA") {
      setPanel(false);
      panelToggle().focus();
    }
  });
  $("pb-panel-count").addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-sect]") : null;
    if (!target) return;
    if (state.view === "preview") $("pb-preview-back").click();
    const heading = list.querySelector('.pb-sect[data-sect="' + target.dataset.sect + '"]');
    if (!heading) return;
    const top = heading === list.firstElementChild ? 0 : list.scrollTop + heading.getBoundingClientRect().top - list.getBoundingClientRect().top - 6;
    list.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion:reduce)").matches ? "auto" : "smooth" });
  });

  list.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const row = target.closest(".pb-drow");
    const act = target.closest("[data-act]")?.dataset.act;
    if (row) {
      if (target.closest(".q") || act === "jump-decision") {
        send({ type: "pb:jump-decision", id: row.dataset.id });
        if (mobile()) setPanel(false);
      } else if (act === "keep") {
        keepRecommendation(row.dataset.id);
        focusCard(row.dataset.id);
      }
      return;
    }
    const cardEl = target.closest(".pb-card");
    if (!cardEl) return;
    const c = state.comments.find((x) => x.id === cardEl.dataset.id);
    if (!c) return;
    if (target.closest(".pb-quote")) return jumpTo(c.id);
    if (act === "jump") jumpTo(c.id);
    if (act === "edit") {
      state.editingId = c.id;
      state.editDraft = { id: c.id, value: c.body, start: c.body.length, end: c.body.length, focus: true };
      render();
    }
    if (act === "edit-cancel") {
      state.editingId = null;
      render();
      focusCard(c.id);
    }
    if (act === "edit-save") commitEdit(cardEl, c);
    if (act === "delete") deleteComment(c.id);
    if (act === "reopen") reopen(c);
    if (act === "expand") {
      if (state.expanded.has(c.id)) state.expanded.delete(c.id);
      else state.expanded.add(c.id);
      render();
      focusCard(c.id);
    }
  });
  list.addEventListener("keydown", (e) => {
    if (e.target.tagName !== "TEXTAREA") return;
    const cardEl = e.target.closest(".pb-card");
    const c = cardEl && state.comments.find((x) => x.id === cardEl.dataset.id);
    if (!c) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commitEdit(cardEl, c);
    } else if (e.key === "Escape") {
      e.preventDefault();
      state.editingId = null;
      render();
      focusCard(c.id);
    }
  });

  $("pb-copy-response").addEventListener("click", async () => {
    const ok = await copyText(responseMarkdown());
    const n = state.comments.filter(inResponse).length;
    const d = decisionViews().filter((v) => statusOf(v) !== "untouched").length;
    const parts = [d ? plural(d, "decision") : "", n ? plural(n, "comment") : ""].filter(Boolean).join(" and ");
    toast(ok ? "Copied " + parts + " as Markdown" : "Clipboard blocked \\u2014 copy from the preview");
    if (!ok) {
      state.view = "preview";
      $("pb-preview-btn").textContent = "Comments";
      render();
    }
  });
  $("pb-preview-btn").addEventListener("click", () => {
    state.view = state.view === "preview" ? "list" : "preview";
    $("pb-preview-btn").textContent = state.view === "preview" ? "Comments" : "Preview";
    render();
    if (state.view === "preview") $("pb-preview-text").focus();
  });
  $("pb-preview-back").addEventListener("click", (e) => {
    const hadFocus = document.activeElement === e.currentTarget;
    state.view = "list";
    $("pb-preview-btn").textContent = "Preview";
    render();
    if (hadFocus) $("pb-preview-btn").focus();
  });

  window.addEventListener("resize", () => {
    if (state.draft) positionComposer(state.draft);
    if ((!affordance.hidden || fab.classList.contains("selecting")) && state.selection) placeAffordance(state.selection);
  });

  window.addEventListener("pagehide", () => {
    for (const pending of [...pendingDeletes.values()]) {
      clearTimeout(pending.timer);
      commitDelete(pending, true);
    }
    // dirty covers both a pending debounce and a change queued behind an in-flight save. The
    // keepalive write carries the highest sequence, so an older request landing later is ignored.
    for (const rec of state.decisions.values()) {
      if (!rec.dirty) continue;
      clearTimeout(rec.saveTimer);
      rec.saveTimer = 0;
      putDecision(rec, true);
    }
  });

  // ---- mobile keyboard docking ----
  // iOS Safari ignores interactive-widget and shrinks only the visual viewport, leaving
  // bottom-fixed sheets behind the keyboard. Pin the focused sheet to the visual viewport.
  const vv = window.visualViewport;
  let docked = null;
  const dockObserver = new MutationObserver(() => updateDock());
  function updateDock() {
    if (!docked) return;
    const field = document.activeElement;
    if (docked.hidden || !mobile() || !docked.contains(field) || !field.matches("textarea, input")) return undock();
    docked.style.bottom = Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + "px";
    if (docked === panel) docked.style.maxHeight = Math.min(window.innerHeight * 0.62, vv.height - 24) + "px";
    if (document.scrollingElement.scrollTop) document.scrollingElement.scrollTop = 0;
  }
  function undock() {
    if (!docked) return;
    docked.style.removeProperty("bottom");
    docked.style.removeProperty("max-height");
    docked = null;
    dockObserver.disconnect();
    vv.removeEventListener("resize", updateDock);
    vv.removeEventListener("scroll", updateDock);
  }
  document.addEventListener("focusin", (e) => {
    if (!vv || !mobile() || !(e.target instanceof Element) || !e.target.matches("textarea, input")) return;
    const sheet = e.target.closest("#pb-composer, #pb-panel");
    if (!sheet) return;
    if (docked !== sheet) {
      undock();
      docked = sheet;
      dockObserver.observe(sheet, { attributes: true, attributeFilter: ["hidden"] });
      vv.addEventListener("resize", updateDock);
      vv.addEventListener("scroll", updateDock);
    }
    updateDock();
  });
  document.addEventListener("focusout", () => setTimeout(updateDock));

  // ---- desktop panel resize ----
  let panelWidthPref = Number(stored("session", PANEL_KEY)) || null;
  const panelMax = () => Math.max(PANEL_MIN, Math.min(640, Math.round(window.innerWidth * 0.5)));
  function applyPanelWidth() {
    const width = Math.round(Math.min(Math.max(panelWidthPref ?? PANEL_MIN, PANEL_MIN), panelMax()));
    if (panelWidthPref === null) panel.style.removeProperty("--pb-panel-w");
    else panel.style.setProperty("--pb-panel-w", width + "px");
    resizer.setAttribute("aria-valuemin", String(PANEL_MIN));
    resizer.setAttribute("aria-valuemax", String(panelMax()));
    resizer.setAttribute("aria-valuenow", String(width));
  }
  function setPanelWidth(width) {
    panelWidthPref = width === null ? null : Math.round(Math.min(Math.max(width, PANEL_MIN), panelMax()));
    store("session", PANEL_KEY, panelWidthPref === null ? null : String(panelWidthPref));
    applyPanelWidth();
  }
  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = Number(resizer.getAttribute("aria-valuenow"));
    const move = (ev) => setPanelWidth(startWidth + startX - ev.clientX);
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("pb-resizing");
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener(
      "lostpointercapture",
      () => {
        resizer.removeEventListener("pointermove", move);
        document.body.classList.remove("pb-resizing");
      },
      { once: true },
    );
  });
  resizer.addEventListener("dblclick", () => setPanelWidth(null));
  resizer.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 64 : 16;
    const current = Number(resizer.getAttribute("aria-valuenow"));
    if (e.key === "ArrowLeft") setPanelWidth(current + step);
    else if (e.key === "ArrowRight") setPanelWidth(current - step);
    else if (e.key === "Home") setPanelWidth(null);
    else if (e.key === "End") setPanelWidth(panelMax());
    else return;
    e.preventDefault();
  });
  window.addEventListener("resize", applyPanelWidth);
  applyPanelWidth();

  render();
  load();
  frame.contentWindow?.postMessage({ type: "pb:ping" }, FRAME_TARGET);
`;
