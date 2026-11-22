const { AttachmentBuilder } = require('discord.js');
const { buildFromBlocks, getV2Flags, splitText } = require('./v2-builder.cjs');
const UPLOAD = /^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/;
const TYPES = new Set(['text', 'title', 'image', 'gallery', 'separator', 'field', 'button']);
const MAX_IMAGES_PER_PAGE = 10;
const MAX_IMAGES_PER_ANNOUNCEMENT = 20;
const MAX_PAGES = 2;
const MAX_TEXT_PER_PAGE = 3800;
const MAX_COMPONENTS_PER_PAGE = 30;
const MAX_FILE_BYTES_PER_PAGE = 24 * 1048576;

function normalizeBlocks(input, color = '#8f1d3d') {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw Error('Se necesitan entre 1 y 20 bloques');
  if (typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color)) throw Error('Color inválido');
  let images = 0, total = 0;
  const string = (value, limit) => {
    if (typeof value !== 'string' || value.length > limit) throw Error('Texto inválido o demasiado largo');
    total += value.length; if (total > 40000) throw Error('El anuncio supera 40 000 caracteres'); return value;
  };
  const url = (value, image = false, optional = false) => {
    if (optional && !value) return '';
    string(value, 2048);
    if (image && value.startsWith('/uploads/')) { if (!UPLOAD.test(value)) throw Error('Referencia de imagen local inválida'); return value; }
    let parsed; try { parsed = new URL(value); } catch { throw Error('URL inválida'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('Solo se permiten enlaces HTTP/HTTPS');
    return value;
  };
  const blocks = input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) throw Error('Tipo de bloque no permitido');
    const block = { id: `block_${index}`, type: raw.type };
    if (raw.type === 'text') block.content = string(raw.content, 40000);
    if (raw.type === 'title') { block.content = string(raw.content, 256); block.url = url(raw.url, false, true); }
    if (raw.type === 'field') { block.name = string(raw.name, 256); block.value = string(raw.value, 1024); block.inline = !!raw.inline; }
    if (raw.type === 'button') { block.label = string(raw.label, 80); block.url = url(raw.url); }
    if (raw.type === 'separator') { block.divider = raw.divider !== false; block.spacing = raw.spacing === 'large' ? 'large' : 'small'; }
    if (raw.type === 'image') { block.url = url(raw.url, true); images++; }
    if (raw.type === 'gallery') {
      if (!Array.isArray(raw.images) || !raw.images.length || raw.images.length > MAX_IMAGES_PER_ANNOUNCEMENT) throw Error('Una galería admite entre 1 y 20 imágenes');
      block.images = raw.images.map(value => url(value, true)); images += block.images.length;
    }
    if (images > MAX_IMAGES_PER_ANNOUNCEMENT) throw Error(`Máximo ${MAX_IMAGES_PER_ANNOUNCEMENT} imágenes por anuncio`);
    return block;
  });
  if (!blocks.some(block => block.content?.trim() || block.name?.trim() || block.url || block.images?.length || block.label?.trim())) throw Error('El anuncio está vacío');
  return { blocks, color };
}

async function createPayloads(input, color, storage) {
  const normalized = normalizeBlocks(input, color), expanded = [], filesCache = new Map();
  const MAX_FILES_BYTES = 24 * 1048576;
  const imageFiles = block => (block.type === 'image' ? [block.url] : block.type === 'gallery' ? block.images : []).map(value => UPLOAD.exec(value)?.[1]).filter(Boolean);
  const loadFile = async name => {
    if (!filesCache.has(name)) {
      const record = await storage.getBlob(name);
      if (!record || !Buffer.isBuffer(record.data) || record.data.length > 8 * 1048576) throw Error('Una imagen local ya no está disponible; súbela de nuevo');
      filesCache.set(name, record.data);
    }
    return filesCache.get(name);
  };
  const fileSize = async name => (await loadFile(name)).length;
  for (const block of normalized.blocks) {
    if (block.type === 'text') expanded.push(...splitText(block.content, 3500).map(content => ({ ...block, content })));
    else if (block.type === 'gallery') {
      let group = [], bytes = 0;
      for (const image of block.images) {
        const name = UPLOAD.exec(image)?.[1], size = name ? await fileSize(name) : 0;
        if (group.length && bytes + size > MAX_FILES_BYTES) { expanded.push({ ...block, images: group }); group = []; bytes = 0; }
        group.push(image); bytes += size;
      }
      if (group.length) expanded.push({ ...block, images: group });
    } else expanded.push(block);
  }
  const pages = []; let current = [], size = 0, components = 0, imagesInPage = 0, localFiles = new Set();
  const blockImages = block => block.type === 'image' ? [block.url] : block.type === 'gallery' ? block.images : [];
  const imageCount = block => block.type === 'image' && block.url ? 1 : block.type === 'gallery' ? block.images.length : 0;
  const componentCount = block => block.type === 'gallery' ? Math.ceil(block.images.length / 5) : block.type === 'image' ? 1 : block.type === 'text' ? Math.max(1, Math.ceil(block.content.length / 4000)) : 1;
  const blockLength = block => block.type === 'field' ? block.name.length + block.value.length + 5 : (block.content?.length ?? block.label?.length ?? 0) + 5;
  const flush = () => { if (!current.length) return; pages.push(current); current = []; size = 0; components = 0; imagesInPage = 0; localFiles = new Set(); };
  for (const block of expanded) {
    if (block.type === 'gallery' && block.images.length > MAX_IMAGES_PER_PAGE) {
      flush();
      for (let offset = 0; offset < block.images.length; offset += MAX_IMAGES_PER_PAGE) {
        pages.push([{ ...block, images: block.images.slice(offset, offset + MAX_IMAGES_PER_PAGE) }]);
      }
      continue;
    }
    const length = blockLength(block), blockImageCount = imageCount(block), blockComponents = componentCount(block);
    const imageNames = imageFiles(block), combined = new Set([...localFiles, ...imageNames]);
    let bytes = 0, blockBytes = 0;
    for (const name of combined) bytes += await fileSize(name);
    for (const name of imageNames) blockBytes += await fileSize(name);
    const overflow = current.length > 0 && (size + length > MAX_TEXT_PER_PAGE || components + blockComponents > MAX_COMPONENTS_PER_PAGE
      || imagesInPage + blockImageCount > MAX_IMAGES_PER_PAGE || bytes > MAX_FILE_BYTES_PER_PAGE);
    if (overflow) flush();
    // Reject an individual block that cannot fit on an empty page instead of silently truncating it.
    if (length > MAX_TEXT_PER_PAGE || blockComponents > MAX_COMPONENTS_PER_PAGE || blockImageCount > MAX_IMAGES_PER_PAGE || blockBytes > MAX_FILE_BYTES_PER_PAGE)
      throw Error('Un bloque supera los límites de una página; divide el texto o reduce el tamaño de las imágenes.');
    for (const name of imageNames) localFiles.add(name);
    current.push(block); size += length; components += blockComponents; imagesInPage += blockImageCount;
  }
  flush();
  if (pages.length > MAX_PAGES) throw Error(`El anuncio se dividiría en ${pages.length} páginas y el máximo es ${MAX_PAGES}. Reduce imágenes o texto.`);
  const used = new Set(), payloads = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const blocks = pages[pageIndex];
    const files = new Map();
    const resolveImage = value => {
      if (!value.startsWith('/uploads/')) return value;
      const match = UPLOAD.exec(value); if (!match) throw Error('Imagen local inválida');
      const buffer = filesCache.get(match[1]); if (!buffer) throw Error('Una imagen local ya no está disponible; súbela de nuevo');
      files.set(match[1], buffer); used.add(match[1]); return `attachment://${match[1]}`;
    };
    for (const block of blocks) {
      if (block.type === 'image') resolveImage(block.url);
      if (block.type === 'gallery') for (const value of block.images) resolveImage(value);
    }
    const container = buildFromBlocks(blocks, normalized.color, resolveImage, files);
    const containerJson = container.toJSON();
    if (pages.length > 1) containerJson.components.unshift({ type: 10, content: `**Mensaje ${pageIndex + 1} de ${pages.length}**` });
    payloads.push({ components: [containerJson], flags: getV2Flags(), allowedMentions: { parse: [], repliedUser: false },
      files: [...files].map(([name, buffer]) => new AttachmentBuilder(buffer, { name })), page: { index: pageIndex + 1, total: pages.length } });
  }
  return { payloads, uploads: [...used], blocks: normalized.blocks, color: normalized.color, pages: payloads.length,
    imageCount: normalized.blocks.reduce((sum, block) => sum + imageCount(block), 0) };
}

module.exports = { normalizeBlocks, createPayloads, UPLOAD, MAX_IMAGES_PER_ANNOUNCEMENT, MAX_IMAGES_PER_PAGE, MAX_PAGES };
