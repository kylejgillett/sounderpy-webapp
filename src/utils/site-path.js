const base = import.meta.env.BASE_URL.replace(/\/$/, '');

export function sitePath(path) {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function withSiteBase(html) {
  return html.replace(/(["'])\/(?!\/)/g, `$1${base}/`);
}
