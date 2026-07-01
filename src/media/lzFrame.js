import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FRAMES_DIR = join(__dirname, '../../public/tmp-frames');
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export async function pruneOldFrames() {
  try {
    const files = await readdir(FRAMES_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (name) => {
      const path = join(FRAMES_DIR, name);
      try {
        const st = await stat(path);
        if (now - st.mtimeMs > MAX_AGE_MS) await unlink(path);
      } catch (_) {}
    }));
  } catch (_) {}
}

export async function saveDataUriFrame(dataUri, req) {
  const m = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/s.exec(String(dataUri || ''));
  if (!m) throw new Error('data URI de imagem inválida');
  const ext = m[1].includes('png') ? 'png' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('imagem vazia');
  await mkdir(FRAMES_DIR, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  await writeFile(join(FRAMES_DIR, file), buf);
  pruneOldFrames().catch(() => {});
  const host = req.get('x-forwarded-host') || req.get('host') || 'clipseller.com.br';
  const proto = req.get('x-forwarded-proto') || 'https';
  return `${proto}://${host.split(',')[0].trim()}/tmp-frames/${file}`;
}

export async function shrinkLaozhangSeedanceBody(rawBody, bodyText, req) {
  if (!bodyText || !bodyText.includes('data:image')) return rawBody;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return rawBody;
  }
  if (!Array.isArray(parsed.content)) return rawBody;
  let changed = false;
  for (const item of parsed.content) {
    if (!item || item.type !== 'image_url') continue;
    const url = item.image_url && item.image_url.url;
    if (!url || typeof url !== 'string' || !url.startsWith('data:image')) continue;
    item.image_url.url = await saveDataUriFrame(url, req);
    changed = true;
  }
  if (!changed) return rawBody;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}
