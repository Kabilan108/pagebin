export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect x="2" y="2" width="60" height="60" rx="14" fill="#1d2724"/>
<path d="M20 14h17l9 9v27a2 2 0 0 1-2 2H20a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2z" fill="#f4f1ea"/>
<path d="M37 14l9 9h-9z" fill="#d39a62"/>
<rect x="24" y="30" width="16" height="3" rx="1.5" fill="#99602f"/>
<rect x="24" y="37" width="16" height="3" rx="1.5" fill="#99602f"/>
<rect x="24" y="44" width="10" height="3" rx="1.5" fill="#99602f"/>
</svg>`;

const CSS = `
:root{color-scheme:light dark;--bg:#f7f4ec;--text:#241f18;--muted:#877e6f;--faint:#a89f8e;--line:#ddd6c6;--accent:#8a5426;--danger:#a33a32;--panel:#fffdf6;--chip:#efeadd}
@media(prefers-color-scheme:dark){:root{--bg:#191713;--text:#ece7dc;--muted:#a29a8a;--faint:#7a7365;--line:#37322a;--accent:#d39a62;--danger:#ef8c82;--panel:#211e19;--chip:#26221c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 ui-serif,Georgia,serif}
main{max-width:860px;margin:auto;padding:44px 24px 140px}
.sans{font-family:ui-sans-serif,system-ui,sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:flex-end;justify-content:space-between}
h1{font-size:clamp(2.2rem,6vw,3.4rem);margin:0;line-height:1;letter-spacing:-.02em}
.rule{border-top:3px double var(--line);margin:16px 0 12px}
.searchline{display:flex;gap:12px;align-items:center;font-family:ui-sans-serif,system-ui,sans-serif}
#search{flex:1;font:inherit;font-size:14px;border:none;border-bottom:1px solid var(--line);background:transparent;color:var(--text);padding:7px 2px}
#search:focus{outline:none;border-bottom-color:var(--accent)}
#filters{display:flex;flex-direction:column;gap:8px;align-items:flex-start;margin:14px 0 4px;font-family:ui-sans-serif,system-ui,sans-serif}
.chipgroup{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chipgroup .glabel{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);margin-right:2px}
.chip{font-size:12.5px;border:1px solid var(--line);border-radius:999px;background:transparent;color:var(--muted);padding:3px 11px;cursor:pointer}
.chip:hover{border-color:var(--accent);color:var(--text)}
.chip.on{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.dd{position:relative;display:inline-block}
.dd .trigger{font-size:13px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);padding:6px 30px 6px 12px;cursor:pointer;min-width:130px;text-align:left}
.dd .trigger::after{content:'';position:absolute;right:12px;top:50%;width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:translateY(-70%) rotate(45deg)}
.dd .menu{position:absolute;z-index:30;top:calc(100% + 4px);left:0;min-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:4px;display:none}
.dd.open .menu{display:block}
.dd .menu button{display:block;width:100%;text-align:left;font:inherit;font-size:13px;border:none;background:none;color:var(--text);padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.dd .menu button:hover{background:var(--chip)}
.dd .menu button.sel{color:var(--accent);font-weight:600}
.dd select{display:none;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--text);padding:6px 10px}
@media(pointer:coarse){.dd .trigger,.dd .menu{display:none!important}.dd select{display:block}}
#summary{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--muted);margin:8px 0 24px}
h2{font-size:13px;font-family:ui-sans-serif,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:6px;margin:36px 0 4px;font-weight:600;display:flex;justify-content:space-between;align-items:baseline}
h2 .count{letter-spacing:0;text-transform:none;color:var(--faint);font-weight:400}
.item{padding:11px 0;border-bottom:1px dotted var(--line)}
.line1{display:flex;align-items:baseline;gap:12px}
.name{font-size:17px;cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.name:hover{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.spacer{flex:1}
.when{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--muted);white-space:nowrap}
.acts{display:flex;gap:2px;align-self:center;flex-shrink:0}
.acts button{border:none;background:none;color:var(--faint);cursor:pointer;padding:5px;border-radius:6px;display:flex;align-items:center}
.acts button:hover{color:var(--accent);background:var(--chip)}
.acts button.danger:hover{color:var(--danger)}
.acts svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.line2{font-size:12px;color:var(--muted);margin-top:2px;display:flex;gap:5px;flex-wrap:wrap;align-items:center}
.line2 .sep{color:var(--faint)}
.line2 .faint{color:var(--faint);margin-left:3px}
.line2+.line2{margin-top:1px}
.mi{display:inline-flex;align-items:center;gap:4px}
.mi svg{width:12px;height:12px;stroke:var(--faint);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
.mi.branch svg{stroke:#6f9556}
.mi.host svg{stroke:#5f83ab}
.mi.agent svg{stroke:#b07fc9}
.mi.agent.brand-claude svg,.mi.agent.brand-codex svg,.mi.agent.brand-opencode svg,.mi.agent.brand-amp svg{stroke:none;fill:var(--muted)}
.mi.agent.brand-claude svg{fill:#c46a4a}
.mi.agent.brand-amp svg{fill:#c9573f}
.t-plan{color:#a8842c}.t-report{color:#3f8578}.t-review{color:#a35c76}.t-explainer{color:#5f83ab}.t-implementation-log{color:#6f9556}
@media(prefers-color-scheme:dark){.mi.branch svg{stroke:#93b06e}.mi.host svg{stroke:#7da2c4}.mi.agent svg{stroke:#bd93d6}
.mi.agent.brand-claude svg{fill:#d97757}.mi.agent.brand-codex svg{fill:#c9c3b4}.mi.agent.brand-opencode svg{fill:#c9c3b4}.mi.agent.brand-amp svg{fill:#e56a50}
.t-plan{color:#d4b45f}.t-report{color:#63b0a1}.t-review{color:#c98299}.t-explainer{color:#7da2c4}.t-implementation-log{color:#93b06e}}
.line1 .when{align-self:center}
.more{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12.5px;color:var(--accent);background:none;border:none;cursor:pointer;padding:10px 0 2px;text-decoration:underline dotted;text-underline-offset:3px}
.empty{padding:60px 0;text-align:center;color:var(--muted);font-style:italic}
.fab{position:fixed;bottom:22px;right:22px;width:46px;height:46px;border-radius:50%;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.16);font-size:17px;z-index:40}
.fab:hover{border-color:var(--accent)}
#outlinePanel{position:fixed;bottom:78px;right:22px;background:var(--panel);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.2);padding:8px;display:none;z-index:40;max-height:60vh;overflow-y:auto;font-family:ui-sans-serif,system-ui,sans-serif;min-width:200px}
#outlinePanel.open{display:block}
#outlinePanel button{display:flex;justify-content:space-between;gap:16px;width:100%;font:inherit;font-size:13px;border:none;background:none;color:var(--text);text-align:left;padding:7px 10px;border-radius:7px;cursor:pointer}
#outlinePanel button:hover{background:var(--chip)}
#outlinePanel .count{color:var(--faint);font-size:12px}
#deskOutline{display:none}
@media(min-width:1240px){
.fab,#outlinePanel{display:none!important}
#deskOutline{display:block;position:fixed;top:130px;left:calc(50% - 430px - 210px);width:180px;font-family:ui-sans-serif,system-ui,sans-serif}
#deskOutline button{display:flex;justify-content:space-between;gap:10px;width:100%;font:inherit;font-size:12.5px;border:none;border-left:2px solid var(--line);background:none;color:var(--muted);text-align:left;padding:5px 10px;cursor:pointer}
#deskOutline button:hover{color:var(--text);border-left-color:var(--accent)}
#deskOutline .label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#deskOutline .count{color:var(--faint);font-size:11.5px}
}
@media(max-width:640px){main{padding:28px 16px 140px}.name{white-space:normal}.line1 .when,.line1 .acts{align-self:flex-start;margin-top:2px}}
`;

const SCRIPT = `
const settings={groupBy:'repo',cap:5,filterStyle:'chips',metaFont:'sans',fields:{type:true,branch:true,host:true,agent:true,expiry:true}};
const state={artifacts:[],query:'',host:'',expanded:new Set()};
const $=id=>document.getElementById(id);
const el=(tag,cls,txt)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(txt!=null)n.textContent=txt;return n};

const ICONS={
link:'<svg viewBox="0 0 24 24"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
reissue:'<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>',
trash:'<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
branch:'<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.4"/><circle cx="6" cy="19" r="2.4"/><circle cx="18" cy="7" r="2.4"/><path d="M6 7.4v9.2"/><path d="M18 9.4c0 4-4.5 4.6-7 5-2 .3-3.5 1-4 2.2"/></svg>',
host:'<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
agent:'<svg viewBox="0 0 24 24"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z"/><path d="M18.5 14.5l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z"/></svg>'};
const BRAND_ICONS={
claude:'<svg viewBox="0 0 24 24"><path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>',
codex:'<svg viewBox="0 0 24 24"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
opencode:'<svg viewBox="0 0 24 24"><path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>',
amp:'<svg viewBox="0 0 24 24"><path d="M13.2 1.8L4.5 13.5h5.4l-1.8 8.7 8.7-11.7h-5.4z"/></svg>'};
function agentBrand(agent){const v=agent.toLowerCase();if(v.includes('claude'))return'claude';if(v.includes('codex'))return'codex';if(v.includes('opencode'))return'opencode';if(v==='amp'||v.includes('ampcode'))return'amp';return null}
function agentBadge(agent){const brand=agentBrand(agent);const s=el('span','mi agent'+(brand?' brand-'+brand:''));s.innerHTML=brand?BRAND_ICONS[brand]:ICONS.agent;s.append(document.createTextNode(agent));s.title='agent';return s}
function iconBtn(kind,title,handler,cls){const b=el('button',cls);b.type='button';b.title=title;b.innerHTML=ICONS[kind];b.addEventListener('click',e=>{e.stopPropagation();handler()});return b}
function iconed(kind,value,title){const s=el('span','mi '+kind);s.innerHTML=ICONS[kind];s.append(document.createTextNode(value));if(title)s.title=title;return s}

async function load(){const r=await fetch('/api/dashboard/artifacts');if(!r.ok)throw new Error('Unable to load artifacts');state.artifacts=(await r.json()).artifacts;if(state.host&&!hosts().includes(state.host))state.host='';renderFilters();render()}
function repoLabel(repo){try{const u=new URL(repo);const path=u.pathname.replace(/^\\/+|\\.git$|\\/+$/g,'');return path||u.hostname}catch{return repo.replace(/^git@[^:]+:/,'').replace(/\\.git$/,'').replace(/^[\\w.-]+\\.[a-z]{2,}\\//i,'')}}
function groupKey(a){if(settings.groupBy==='repo'&&a.attributes.repo)return repoLabel(a.attributes.repo);if(a.attributes.project)return a.attributes.project;return 'Uncategorized'}
function matches(a){const q=state.query.trim().toLowerCase();const hay=[a.attributes.title,a.filename,a.attributes.project,a.attributes.repo,a.attributes.sourceHost,a.attributes.gitBranch].filter(Boolean).join(' ').toLowerCase();return(!q||hay.includes(q))&&(!state.host||a.attributes.sourceHost===state.host)}
function relTime(iso){const s=(Date.now()-Date.parse(iso))/1000;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';if(s<86400*14)return Math.floor(s/86400)+'d ago';if(s<86400*60)return Math.floor(s/86400/7)+'w ago';return new Date(iso).toLocaleDateString()}
function hosts(){return[...new Set(state.artifacts.map(a=>a.attributes.sourceHost).filter(Boolean))].sort()}
function openArtifact(id){window.open('/api/dashboard/artifacts/'+encodeURIComponent(id)+'/open','_blank')}
async function copyText(value){try{await navigator.clipboard.writeText(value)}catch{prompt('Copy this link:',value)}}
async function copyLink(id){const r=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id)+'/link');const p=await r.json();if(!r.ok)throw new Error(p.error||'Unable to recover link');await copyText(p.url)}
async function reissue(id){if(!confirm('Reissue this link? The previous URL stops working.'))return;const r=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id)+'/reissue',{method:'POST',headers:{'X-PageBin-Dashboard':'1'}});const p=await r.json();if(!r.ok)throw new Error(p.error||'Unable to reissue');await load();await copyText(p.url)}
async function removeArtifact(id){if(!confirm('Delete this artifact permanently?'))return;const r=await fetch('/api/dashboard/artifacts/'+encodeURIComponent(id),{method:'DELETE',headers:{'X-PageBin-Dashboard':'1'}});if(!r.ok)throw new Error('Unable to delete');await load()}

function chipGroup(label,values,key){const g=el('span','chipgroup');g.append(el('span','glabel',label));for(const v of values){const c=el('button','chip'+(state[key]===v?' on':''),v);c.type='button';c.addEventListener('click',()=>{state[key]=state[key]===v?'':v;renderFilters();render()});g.append(c)}return g}
function dropdown(label,values,key){const wrap=el('span','dd');const trigger=el('button','trigger',state[key]||label);trigger.type='button';
const menu=el('div','menu');const choose=v=>{state[key]=v;wrap.classList.remove('open');renderFilters();render()};
for(const[v,text]of[['',label],...values.map(v=>[v,v])]){const b=el('button',state[key]===v?'sel':'',text);b.type='button';b.addEventListener('click',()=>choose(v));menu.append(b)}
trigger.addEventListener('click',e=>{e.stopPropagation();closeMenus(wrap);wrap.classList.toggle('open')});
const native=document.createElement('select');for(const[v,text]of[['',label],...values.map(v=>[v,v])]){const o=document.createElement('option');o.value=v;o.textContent=text;native.append(o)}
native.value=state[key];native.addEventListener('input',()=>choose(native.value));
wrap.append(trigger,menu,native);return wrap}
function closeMenus(except){for(const dd of document.querySelectorAll('.dd.open'))if(dd!==except)dd.classList.remove('open')}
document.addEventListener('click',()=>closeMenus());
function renderFilters(){const box=$('filters');box.replaceChildren();
if(settings.filterStyle==='chips'){box.append(chipGroup('host',hosts(),'host'))}
else{box.append(dropdown('All hosts',hosts(),'host'))}}

function metaRows(a){const f=settings.fields;const row1=[],row2=[];
if(f.type&&a.attributes.artifactType)row1.push(el('span','t-'+a.attributes.artifactType,a.attributes.artifactType));
if(f.branch&&a.attributes.gitBranch){const b=iconed('branch',a.attributes.gitBranch,'branch');if(a.attributes.project)b.append(el('span','faint','('+a.attributes.project+')'));row1.push(b)}
if(f.host&&a.attributes.sourceHost)row2.push(iconed('host',a.attributes.sourceHost,'source host'));
if(f.agent&&a.attributes.agent)row2.push(agentBadge(a.attributes.agent));
if(f.expiry&&a.expiresAt)row2.push(el('span',null,'expires '+new Date(a.expiresAt).toLocaleDateString()));
return[row1,row2]}
function metaLineEl(parts){const line=el('div','line2 '+(settings.metaFont==='mono'?'mono':'sans'));
parts.forEach((p,i)=>{if(i)line.append(el('span','sep','\\u00b7'));line.append(p)});return line}
function row(a){const item=el('div','item');const line1=el('div','line1');
const name=el('span','name',a.attributes.title||a.filename);name.addEventListener('click',()=>openArtifact(a.id));
const acts=el('span','acts');acts.append(iconBtn('link','Copy link',()=>copyLink(a.id).catch(alert)),iconBtn('reissue','Reissue link',()=>reissue(a.id).catch(alert)),iconBtn('trash','Delete',()=>removeArtifact(a.id).catch(alert),'danger'));
line1.append(name,el('span','spacer'),el('span','when',relTime(a.updatedAt)),acts);item.append(line1);
for(const parts of metaRows(a))if(parts.length)item.append(metaLineEl(parts));
return item}

function render(){const root=$('sections');root.replaceChildren();const items=state.artifacts.filter(matches);
$('summary').textContent=items.length+' of '+state.artifacts.length+' artifacts';
document.body.classList.toggle('mono-meta',settings.metaFont==='mono');
const groups=new Map;for(const a of items){const k=groupKey(a);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a)}
const sorted=[...groups].sort(([x],[y])=>x==='Uncategorized'?1:y==='Uncategorized'?-1:x.localeCompare(y));
if(!sorted.length){root.append(el('div','empty','Nothing in the index matches.'));renderOutline([]);return}
sorted.forEach(([name,artifacts],sectionIndex)=>{artifacts.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
const h=el('h2');h.id='sec-'+sectionIndex;h.append(el('span',null,name),el('span','count',String(artifacts.length)));root.append(h);
const cap=settings.cap===0?Infinity:settings.cap;const expanded=state.expanded.has(name);
const visible=expanded?artifacts:artifacts.slice(0,cap);
for(const a of visible)root.append(row(a));
if(!expanded&&artifacts.length>cap){const more=el('button','more','\\u2026 '+(artifacts.length-cap)+' more');more.type='button';more.addEventListener('click',()=>{state.expanded.add(name);render()});root.append(more)}
if(expanded&&artifacts.length>cap){const less=el('button','more','show fewer');less.type='button';less.addEventListener('click',()=>{state.expanded.delete(name);render()});root.append(less)}});
renderOutline(sorted)}

function renderOutline(sorted){for(const target of[$('outlinePanel'),$('deskOutline')]){target.replaceChildren();
sorted.forEach(([name,artifacts],sectionIndex)=>{const b=el('button');b.type='button';b.append(el('span','label',name),el('span','count',String(artifacts.length)));
b.addEventListener('click',()=>{$('outlinePanel').classList.remove('open');const h=document.getElementById('sec-'+sectionIndex);if(h)h.scrollIntoView({behavior:'smooth',block:'start'})});target.append(b)})}}

$('search').addEventListener('input',()=>{state.query=$('search').value;render()});
$('outlineBtn').addEventListener('click',e=>{e.stopPropagation();$('outlinePanel').classList.toggle('open')});
document.addEventListener('click',e=>{if(!$('outlinePanel').contains(e.target))$('outlinePanel').classList.remove('open')});
load().catch(err=>$('summary').textContent=err.message);
`;

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PageBin artifacts</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<main>
<header><h1>PageBin</h1></header>
<div class="rule"></div>
<div class="searchline"><input id="search" type="search" placeholder="Search the index&#8230;"></div>
<div id="filters"></div>
<p id="summary">Loading&#8230;</p>
<div id="sections"></div>
</main>
<button class="fab" id="outlineBtn" type="button" title="Jump to section">&#9776;</button>
<div id="outlinePanel"></div>
<nav id="deskOutline" aria-label="Sections"></nav>
<script>${SCRIPT}</script>
</body>
</html>`;
}
