// Inline SVG icons in the Lucide style (24x24, 1.75 stroke, round caps), drawn here so the
// app loads nothing from a CDN for them. icon('play') returns markup for innerHTML.

const P = {
  play: '<polygon points="7 4.5 19 12 7 19.5"/>',
  pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
  back15: '<path d="M4 12a8 8 0 1 0 2.6-5.9"/><polyline points="4 4.5 4 8.5 8 8.5"/><text x="12" y="15.2" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">15</text>',
  fwd15: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><polyline points="20 4.5 20 8.5 16 8.5"/><text x="12" y="15.2" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">15</text>',
  check: '<polyline points="5 12.5 10 17.5 19 7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><polyline points="12 7.5 12 12 15 14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  alert: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 16.6v.1"/>',
  flag: '<path d="M6 21V4.5M6 5h11l-2 3.5 2 3.5H6"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8"/>',
  layers: '<polygon points="12 3.5 21 8.5 12 13.5 3 8.5"/><polyline points="3 12.5 12 17.5 21 12.5"/><polyline points="3 16.5 12 21.5 21 16.5"/>',
  dot: '<circle cx="12" cy="12" r="2.5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8.5v5M8.5 11h5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8.5 11h5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  download: '<path d="M12 4v11M7.5 11 12 15.5 16.5 11M5 20h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sparkles: '<path d="M12 3.5l1.8 4.7 4.7 1.8-4.7 1.8L12 16.5l-1.8-4.7L5.5 10l4.7-1.8z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><polyline points="3.5 6.5 4.5 7.5 6 5.5"/><polyline points="3.5 12.5 4.5 13.5 6 11.5"/><polyline points="3.5 18.5 4.5 19.5 6 17.5"/>',
  users: '<circle cx="9" cy="9" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5.8a3.5 3.5 0 0 1 0 6.4M18.5 14.3A6.5 6.5 0 0 1 21.5 20"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

export const icon = (name, size = 16) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || P.dot}</svg>`;
