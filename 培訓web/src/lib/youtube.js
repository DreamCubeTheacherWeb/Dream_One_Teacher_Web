const YOUTUBE_PAGE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
]);

const YOUTUBE_SHORT_HOSTS = new Set([
  'youtu.be',
  'www.youtu.be',
]);

const isYouTubeId = (value) => /^[A-Za-z0-9_-]+$/.test(value || '');

const buildVideoEmbedUrl = (videoId, sourceUrl) => {
  if (!isYouTubeId(videoId)) return null;

  const params = new URLSearchParams();
  const playlistId = sourceUrl.searchParams.get('list');
  const playlistIndex = sourceUrl.searchParams.get('index');

  if (isYouTubeId(playlistId)) {
    params.set('list', playlistId);
    if (/^\d+$/.test(playlistIndex || '')) params.set('index', playlistIndex);
  }

  const query = params.toString();
  return `https://www.youtube.com/embed/${videoId}${query ? `?${query}` : ''}`;
};

export const toYouTubeEmbedUrl = (url) => {
  if (!url) return '';

  const normalizedUrl = String(url).trim();
  if (!normalizedUrl) return '';

  try {
    const parsedUrl = new URL(normalizedUrl);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (parsedUrl.pathname.startsWith('/embed/')) return normalizedUrl;

    if (YOUTUBE_PAGE_HOSTS.has(hostname)) {
      const playlistId = parsedUrl.searchParams.get('list');

      if (parsedUrl.pathname === '/playlist' && isYouTubeId(playlistId)) {
        return `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(playlistId)}`;
      }

      if (parsedUrl.pathname === '/watch') {
        return buildVideoEmbedUrl(parsedUrl.searchParams.get('v'), parsedUrl) || normalizedUrl;
      }

      if (parsedUrl.pathname.startsWith('/shorts/')) {
        const videoId = parsedUrl.pathname.slice('/shorts/'.length).split('/')[0];
        return buildVideoEmbedUrl(videoId, parsedUrl) || normalizedUrl;
      }
    }

    if (YOUTUBE_SHORT_HOSTS.has(hostname)) {
      const videoId = parsedUrl.pathname.split('/').filter(Boolean)[0];
      return buildVideoEmbedUrl(videoId, parsedUrl) || normalizedUrl;
    }
  } catch {
    // Keep unsupported or incomplete input unchanged so the user can continue editing it.
  }

  return normalizedUrl;
};
