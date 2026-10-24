export type Platform = 'instagram' | 'tiktok' | 'youtube';

/** Only profile URLs are accepted; never fetch arbitrary visitor-supplied URLs. */
export function parsePage(input: string, fallback: Platform = 'instagram') {
  const value = input.trim();
  if (!value || value.length > 300) throw new Error('Enter a public page URL or handle.');
  let platform = fallback, handle = value.replace(/^@/, '');
  if (/^(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|tiktok\.com|youtube\.com)\//i.test(value)) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.replace(/^(www|m)\./, '').toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'instagram.com') {
      platform = 'instagram'; handle = parts[0] || '';
      if ((parts.length > 1 && !(parts.length === 2 && ['reels','tagged'].includes(parts[1]))) || ['p','reel','reels','explore','stories','accounts'].includes(handle.toLowerCase())) throw new Error('Use an Instagram profile URL, not a post or Reel.');
    } else if (host === 'tiktok.com') {
      platform = 'tiktok'; handle = (parts[0] || '').replace(/^@/, '');
      if (!parts[0]?.startsWith('@') || parts.length > 1) throw new Error('Use a TikTok profile URL such as tiktok.com/@handle.');
    } else if (host === 'youtube.com') {
      platform = 'youtube';
      if (parts[0]?.startsWith('@') && (parts.length === 1 || (parts.length === 2 && ['videos','shorts','featured'].includes(parts[1])))) handle = parts[0].slice(1);
      else if (parts[0] === 'channel' && /^UC[\w-]{22}$/.test(parts[1] || '') && (parts.length === 2 || (parts.length === 3 && ['videos','shorts','featured'].includes(parts[2])))) handle = parts[1];
      else throw new Error('Use a YouTube @handle or /channel/UC… URL.');
    } else throw new Error('Unsupported profile domain.');
  } else if (/[\/:?#\s]/.test(value)) throw new Error('Enter a public profile URL or a handle without spaces.');
  try { handle = decodeURIComponent(handle).replace(/^@/, ''); } catch { throw new Error('This profile URL contains invalid characters.'); }
  const valid = platform === 'youtube' ? /^[\p{L}\p{N}_.-]{3,100}$/u : /^[\w.]{1,30}$/;
  if (!valid.test(handle)) throw new Error('This handle is not valid for the selected platform.');
  if (!(platform === 'youtube' && /^UC[\w-]{22}$/.test(handle))) handle = handle.toLowerCase();
  const url = platform === 'instagram' ? `https://www.instagram.com/${handle}/` : platform === 'tiktok' ? `https://www.tiktok.com/@${handle}` : /^UC[\w-]{22}$/.test(handle) ? `https://www.youtube.com/channel/${handle}` : `https://www.youtube.com/@${handle}`;
  return {platform,handle,url};
}
