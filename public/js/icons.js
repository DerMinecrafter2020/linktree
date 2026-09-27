// =========================================================
// Link-Icons: Darstellung (Startseite + Admin)
// =========================================================
// Welches Icon ein Link bekommt, entscheidet der Server (lib/icons.js -> icon_resolved).
// Logos kommen aus Dashboard Icons ueber den eigenen Proxy /api/icon/dashboardicon.

window.icons = {
  // Proxy-URL fuer ein Dashboard Icon (z. B. in der Icon-Auswahl des Admins)
  dashboardUrl(name, format = 'png', variant = '') {
    const base = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (!base) return '';
    const suffix = variant ? `-${variant}` : '';
    return `/api/icon/dashboardicon/${base}${suffix}/${format}`;
  },

  // Material-Symbole (Apache 2.0) fuer Links ohne passendes Logo
  GENERIC_PATHS: {
    link: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
    mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
    phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
  },

  createGeneric(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon-generic');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', this.GENERIC_PATHS[name] || this.GENERIC_PATHS.link);
    svg.appendChild(path);
    return svg;
  },

  // Aufgeloestes Icon vom Server (icon_resolved) als Element darstellen.
  // Der Stil (weiss/bunt) kommt per CSS ueber die Klasse icons-white/icons-color am <body>.
  createResolved(resolved, imgClass = 'icon-img') {
    const r = resolved || { type: 'generic', name: 'link' };
    let src = '';
    // Im weissen Stil ggf. die fuer Einfarbigkeit besser geeignete Variante (z. B. plex-light)
    const variant = r.white && document.body.classList.contains('icons-white') ? r.white : r;
    if (r.type === 'dashboard' && /^[a-z0-9-]{1,80}$/.test(variant.name || '')) {
      src = `/api/icon/dashboardicon/${variant.name}/${variant.format === 'svg' ? 'svg' : 'png'}`;
    } else if (r.type === 'image' && /^https?:\/\//i.test(r.url || '')) {
      src = r.url;
    }
    if (!src) return this.createGeneric(r.name);

    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.className = imgClass;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.width = 24;
    img.height = 24;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(this.createGeneric('link')), { once: true });
    return img;
  },

  // Einheitlichen Icon-Stil am <body> setzen ('white' | 'color')
  applyStyle(style) {
    const color = style === 'color';
    document.body.classList.toggle('icons-color', color);
    document.body.classList.toggle('icons-white', !color);
  },
};
