import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { type ContentFile, FILE_LIMIT, BUNDLE_LIMIT, FILE_COUNT_LIMIT, contentType, validPath, manifestSource } from '../shared/content';

export interface LocalFile extends ContentFile { blob: Blob }
export interface LocalBundle { entrypoint: string; files: LocalFile[]; sha256: string; filename: string }
async function hashBlob(blob: Blob): Promise<string> {
  const hash = createHash('sha256');
  const reader = blob.stream().getReader();
  try { for (;;) { const {done, value} = await reader.read(); if (done) break; hash.update(value); } } finally { reader.releaseLock(); }
  return hash.digest('hex');
}
export async function prepareBundle(filePath: string, assets: string[], rendered?: { blob: Blob; name: string }): Promise<LocalBundle> {
  const files: LocalFile[] = [];
  let total = 0;
  async function add(path: string, blob: Blob): Promise<void> {
    if (!validPath(path) || files.some(f => f.path === path)) throw new Error(`Invalid or duplicate bundle path: ${path}`);
    total += blob.size;
    if (blob.size > FILE_LIMIT || total > BUNDLE_LIMIT || files.length >= FILE_COUNT_LIMIT) throw new Error('Upload exceeds the 50 MiB file, 250 MiB bundle, or 200 file limit.');
    files.push({path, blob, size: blob.size, sha256: await hashBlob(blob), contentType: contentType(path)});
  }
  async function visit(local: string, path: string): Promise<void> {
    const info = await lstat(local);
    if (info.isSymbolicLink()) throw new Error(`Assets must not contain symlinks: ${local}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(local)).sort()) await visit(join(local, name), `${path}/${name}`);
    } else if (info.isFile()) await add(path, Bun.file(local));
    else throw new Error(`Not a regular file: ${local}`);
  }
  const entrypoint = rendered?.name ?? basename(filePath);
  if (rendered) await add(entrypoint, rendered.blob);
  else {
    const info = await lstat(filePath);
    if (!info.isFile()) throw new Error('Entrypoint must be a regular file.');
    await add(entrypoint, Bun.file(filePath));
  }
  for (const asset of assets) {
    const local = resolve(asset);
    if (!(await lstat(local)).isDirectory()) throw new Error(`--assets requires a directory: ${asset}`);
    await visit(local, basename(local));
  }
  return {entrypoint, files, filename: basename(filePath), sha256: createHash('sha256').update(manifestSource(entrypoint, files)).digest('hex')};
}
export async function sendBundle(endpoint: string, token: string, bundle: LocalBundle, options: object): Promise<Response> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const started = await fetch(`${endpoint}/api/uploads`, { method: 'POST', headers, body: JSON.stringify({ ...options, entrypoint: bundle.entrypoint, filename: bundle.filename, files: bundle.files.map(({blob: _, ...file}) => file) }) });
  if (!started.ok) return started;
  const session = await started.json() as { id: string; sessionId: string; missing: string[] };
  const base = `${endpoint}/api/uploads/${encodeURIComponent(session.id)}/${encodeURIComponent(session.sessionId)}`;
  for (const path of session.missing) {
    const file = bundle.files.find(f => f.path === path)!;
    const uploaded = await fetch(`${base}/file?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.contentType, 'Content-Length': String(file.size) }, body: file.blob });
    if (!uploaded.ok) return uploaded;
  }
  return fetch(`${base}/commit`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}
export async function verifyBundle(baseRawUrl: string, bundle: LocalBundle, version: number): Promise<void> {
  const base = new URL(baseRawUrl);
  base.pathname = base.pathname.replace(/\/v\/.*$/, '') + `/v/${version}/`;
  base.search = '';
  for (const file of bundle.files) {
    const url = new URL(base);
    url.pathname += file.path.split('/').map(encodeURIComponent).join('/');
    const response = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    if (!response.ok || !response.body) throw new Error(`Verification failed for ${file.path}: HTTP ${response.status}`);
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    try { for (;;) { const {done, value} = await reader.read(); if (done) break; hash.update(value); } } finally { reader.releaseLock(); }
    if (hash.digest('hex') !== file.sha256) throw new Error(`Checksum mismatch: ${file.path}`);
  }
}
