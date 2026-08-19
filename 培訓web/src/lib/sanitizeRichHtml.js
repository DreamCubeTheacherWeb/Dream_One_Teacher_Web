import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'br', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike',
  'blockquote', 'pre', 'code', 'ol', 'ul', 'li',
  'a', 'img', 'iframe', 'hr', 'sub', 'sup',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

const ALLOWED_ATTR = [
  'class', 'href', 'target', 'rel', 'src', 'alt', 'title',
  'width', 'height', 'style', 'allow', 'allowfullscreen', 'frameborder',
  'sandbox', 'referrerpolicy',
];

const ALLOWED_STYLE_PROPERTIES = new Set([
  'align-items', 'background-color', 'border', 'border-color', 'border-radius',
  'border-style', 'border-width', 'box-shadow', 'color', 'column-gap', 'display', 'flex', 'flex-direction',
  'flex-wrap', 'float', 'font-family', 'font-size', 'font-style', 'font-weight',
  'gap', 'height', 'justify-content', 'letter-spacing', 'line-height',
  'list-style-type', 'margin', 'margin-bottom', 'margin-left', 'margin-right',
  'margin-top', 'max-height', 'max-width', 'min-height', 'min-width',
  'object-fit', 'overflow', 'overflow-x', 'overflow-y', 'padding',
  'padding-bottom', 'padding-left', 'padding-right', 'padding-top', 'row-gap',
  'text-align', 'text-decoration', 'vertical-align', 'white-space', 'width',
]);

const YOUTUBE_EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

const parseUrl = (value) => {
  try {
    return new URL(value, 'https://dream-one.invalid');
  } catch {
    return null;
  }
};

export const isAllowedRichUrl = (value, kind = 'link') => {
  if (typeof value !== 'string' || !value.trim()) return false;
  const trimmed = value.trim();
  if (kind === 'image' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true;

  const parsed = parseUrl(trimmed);
  if (!parsed) return false;
  if (kind === 'link' && (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:')) return true;
  return parsed.protocol === 'https:' || parsed.protocol === 'http:';
};

export const isAllowedEmbedUrl = (value) => {
  const parsed = parseUrl(value);
  return Boolean(
    parsed
      && parsed.protocol === 'https:'
      && YOUTUBE_EMBED_HOSTS.has(parsed.hostname)
      && parsed.pathname.startsWith('/embed/'),
  );
};

const filterInlineStyle = (element) => {
  const style = element.style;
  if (!style) return;

  for (const property of [...style]) {
    const value = style.getPropertyValue(property).toLowerCase();
    const isAllowedProperty = ALLOWED_STYLE_PROPERTIES.has(property)
      || property.startsWith('border-')
      || property.startsWith('flex-');
    if (
      !isAllowedProperty
      || value.includes('url(')
      || value.includes('expression')
      || value.includes('javascript:')
      || value.includes('@import')
    ) {
      style.removeProperty(property);
    }
  }

  if (!style.length) element.removeAttribute('style');
};

export const sanitizeRichHtml = (value) => {
  if (!value) return '';

  const sanitized = DOMPurify.sanitize(String(value), {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['form', 'input', 'button', 'object', 'embed', 'svg', 'math', 'script', 'style'],
  });

  const template = document.createElement('template');
  template.innerHTML = sanitized;

  template.content.querySelectorAll('*').forEach((element) => {
    filterInlineStyle(element);
  });

  template.content.querySelectorAll('a').forEach((anchor) => {
    if (!isAllowedRichUrl(anchor.getAttribute('href'), 'link')) anchor.removeAttribute('href');
    if (anchor.getAttribute('href')) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    } else {
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
    }
  });

  template.content.querySelectorAll('img').forEach((image) => {
    if (!isAllowedRichUrl(image.getAttribute('src'), 'image')) image.remove();
  });

  template.content.querySelectorAll('iframe').forEach((iframe) => {
    if (!isAllowedEmbedUrl(iframe.getAttribute('src'))) {
      iframe.remove();
      return;
    }
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('allow', 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture');
  });

  return template.innerHTML;
};
