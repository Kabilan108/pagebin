export const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Artifact not found · PageBin</title>
<style>
:root{color-scheme:light dark;--paper:#f7f4ec;--ink:#241f18;--muted:#6f6759;--line:#d8d0bf;--accent:#8a5426;--sheet:#fffdf6}
@media(prefers-color-scheme:dark){:root{--paper:#191713;--ink:#ece7dc;--muted:#a29a8a;--line:#413a30;--accent:#d39a62;--sheet:#211e19}}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:28px;background:var(--paper);color:var(--ink);font:16px/1.6 ui-serif,Georgia,serif}
main{width:min(100%,680px)}
.folio{display:flex;align-items:center;gap:12px;color:var(--muted);font:600 11px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase}
.folio:after{content:"";height:1px;flex:1;background:var(--line)}
.sheet{position:relative;margin-top:22px;padding:clamp(34px,8vw,72px);border:1px solid var(--line);background:var(--sheet);box-shadow:8px 8px 0 color-mix(in srgb,var(--line) 45%,transparent)}
.sheet:before{content:"";position:absolute;top:-1px;right:-1px;width:44px;height:44px;background:linear-gradient(225deg,var(--paper) 49%,var(--line) 50%,var(--sheet) 52%)}
.code{margin:0;color:var(--accent);font:500 clamp(4.5rem,18vw,8.5rem)/.8 ui-serif,Georgia,serif;letter-spacing:-.08em}
h1{margin:28px 0 10px;font-size:clamp(1.7rem,5vw,2.6rem);font-weight:500;line-height:1.1;letter-spacing:-.025em}
p{max-width:42ch;margin:0;color:var(--muted)}
.hint{margin-top:36px;padding-top:14px;border-top:1px dotted var(--line);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
@media(max-width:480px){body{padding:18px}.sheet{box-shadow:5px 5px 0 color-mix(in srgb,var(--line) 45%,transparent)}}
</style>
</head>
<body>
<main>
<div class="folio">PageBin · missing page</div>
<section class="sheet" aria-labelledby="title">
<p class="code" aria-hidden="true">404</p>
<h1 id="title">Artifact not found</h1>
<p>This link may be incomplete, expired, or the artifact may have been removed.</p>
<p class="hint">Check the address and try again.</p>
</section>
</main>
</body>
</html>`;
