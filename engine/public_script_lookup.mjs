const TV_ORIGIN = 'https://www.tradingview.com';

export function extractPublicScriptLinks(html, limit = 3) {
  const links = [];
  const seen = new Set();
  const re = /(?:https:\/\/www\.tradingview\.com)?(\/script\/[A-Za-z0-9]+-[^"'?#<>\s]+\/)/g;
  for (const match of String(html || '').matchAll(re)) {
    const url = TV_ORIGIN + match[1];
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
    if (links.length >= limit) break;
  }
  return links;
}

export function parsePublicScriptMetadata(html) {
  const text = String(html || '').replaceAll('\\"', '"');
  const id = text.match(/"script_id_part"\s*:\s*"([^"]+)"/)?.[1] || null;
  const name = text.match(/"shortDescription"\s*:\s*"([^"]+)"/)?.[1] || null;
  return id ? { id, name } : null;
}
