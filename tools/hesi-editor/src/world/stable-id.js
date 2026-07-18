export function stableSlug(value) {
  return String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

export function stableIndex(index, width = 4) {
  return String(index).padStart(width, '0');
}

export function compareChunkKeys(left, right) {
  const a = String(left).split(',').map(Number);
  const b = String(right).split(',').map(Number);
  return a[0] - b[0] || a[1] - b[1] || String(left).localeCompare(String(right));
}

export function chunkId(key) {
  return String(key).replace(',', '_').replace(/-/g, 'n');
}

export function deterministicEntityId(kind, context, index = null) {
  const base = `${stableSlug(kind)}:${stableSlug(context)}`;
  return index === null ? base : `${base}:${stableIndex(index)}`;
}
