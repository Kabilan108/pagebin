import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareBundle } from '../src/file-upload';

test('includes only explicit directories, preserves names, and rejects symlink escapes and collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pagebin-bundle-'));
  try {
    await mkdir(join(root, 'pictures'));
    await mkdir(join(root, 'other'));
    await mkdir(join(root, 'other', 'pictures'));
    await writeFile(join(root, 'index.html'), '<img src="pictures/a b.png">');
    await writeFile(join(root, 'pictures', 'a b.png'), new Uint8Array([0, 255]));
    await writeFile(join(root, 'private.txt'), 'excluded');
    await writeFile(join(root, 'other', 'pictures', 'a b.png'), 'duplicate');
    const bundle = await prepareBundle(join(root, 'index.html'), [join(root, 'pictures')]);
    expect(bundle.files.map(file => file.path)).toEqual(['index.html', 'pictures/a b.png']);
    const again = await prepareBundle(join(root, 'index.html'), [join(root, 'pictures')]);
    expect(again.sha256).toBe(bundle.sha256);
    await expect(prepareBundle(join(root, 'index.html'), [join(root, 'pictures'), join(root, 'other', 'pictures')])).rejects.toThrow('duplicate');
    await symlink(join(root, 'private.txt'), join(root, 'pictures', 'escape.txt'));
    await expect(prepareBundle(join(root, 'index.html'), [join(root, 'pictures')])).rejects.toThrow('symlinks');
  } finally { await rm(root, {recursive: true, force: true}); }
});
