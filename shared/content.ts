export interface ContentFile {
  path: string;
  contentType: string;
  size: number;
  sha256: string;
}
export interface StoredFile extends ContentFile { objectKey: string }
export interface ContentManifest { entrypoint: string; files: StoredFile[]; sha256: string }
export const FILE_LIMIT = 50 * 1024 * 1024;
export const BUNDLE_LIMIT = 250 * 1024 * 1024;
export const FILE_COUNT_LIMIT = 200;
export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\\x00-\x1f\x7f?#%]/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function contentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = { html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', pdf: 'application/pdf', zip: 'application/zip' };
  return types[ext ?? ''] ?? 'application/octet-stream';
}
export function contentKind(type: string): 'document' | 'image' | 'video' | 'audio' | 'file' {
  if (type.startsWith('text/html')) return 'document';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}
export function manifestSource(entrypoint: string, files: ContentFile[]): string {
  return JSON.stringify({ entrypoint, files: [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({path, contentType, size, sha256}) => ({path, contentType, size, sha256})) });
}
export function filePathUrl(path: string): string { return path.split('/').map(encodeURIComponent).join('/'); }
