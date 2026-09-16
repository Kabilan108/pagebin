import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';

// Official legacy build includes compatibility polyfills for mobile browsers.
const version = '6.3.289';
const sha256 = '51683fac4aff7dd31ed91e9ab735a2098a78d50899d1ec529aed6dc8aa19400d';
const response = await fetch(`https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-legacy-dist.zip`);
if (!response.ok) throw new Error(`PDF.js download failed: ${response.status}`);
const archive = new Uint8Array(await response.arrayBuffer());
if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== sha256) {
  throw new Error('PDF.js archive checksum mismatch');
}
const files = unzipSync(archive);
const viewerPath = 'web/viewer.mjs';
let viewer = new TextDecoder().decode(files[viewerPath]);
function replaceOnce(source: string, replacement: string): void {
  if (viewer.split(source).length !== 2) throw new Error(`PDF.js patch no longer matches: ${source}`);
  viewer = viewer.replace(source, replacement);
}
replaceOnce('value: "compressed.tracemonkey-pldi-09.pdf"', 'value: ""');
replaceOnce('["disablePreferences", {\n  value: false,', '["disablePreferences", {\n  value: true,');
replaceOnce('["enableScripting", {\n  value: true,', '["enableScripting", {\n  value: false,');
replaceOnce('["annotationEditorMode", {\n  value: 0,', '["annotationEditorMode", {\n  value: -1,');
replaceOnce('["externalLinkTarget", {\n  value: 0,', '["externalLinkTarget", {\n  value: 2,');
replaceOnce('...apiParams,', '...apiParams,\n      isEvalSupported: false,');
files[viewerPath] = new TextEncoder().encode(viewer);
const output = 'dist/worker-assets/pdfjs';
// Keep the directory intact: Wrangler may rebuild while another preview is serving it.
for (const [path, bytes] of Object.entries(files)) {
  if (path.endsWith('/') || path.endsWith('.map') || path.endsWith('.pdf')) continue;
  if (path.split('/').some(part => part === '..')) throw new Error('Invalid archive path');
  const target = join(output, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log(`Prepared PDF.js ${version} with PDF scripting disabled.`);
