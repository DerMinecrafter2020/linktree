// =========================================================
// Theme-System — 4 Themes mit Whitelist
// =========================================================
// Wird von admin.js und app.js genutzt.
// Jedes Theme liefert:
//   • CSS-Variablen-Mapping (für :root[data-theme="…"])
//   • Meta-Theme-Color (für Browser-Chrome)
//   • Anzeige-Name + Emoji für die Admin-Auswahl
//
// Sicherheit:
//   • Theme-IDs kommen aus einer festen Whitelist
//   • Werte werden über setAttribute('data-theme', ...) gesetzt
//     → kein XSS-Risiko, da data-Attribute nicht als HTML geparst werden
// =========================================================

window.THEMES = (() => {
  'use strict';

  const LIST = [
    {
      id: 'neon',
      name: 'Neon',
      emoji: '💜',
      meta: '#0a0a14',
      vars: {
        '--bg-0':      '#05050b',
        '--bg-1':      '#0a0a14',
        '--bg-2':      '#11111f',
        '--text':      '#f4f4ff',
        '--text-dim':  '#a5a5c0',
        '--text-faint':'#6c6c85',
        '--neon-pink': '#ff2bd6',
        '--neon-cyan': '#00f0ff',
        '--neon-violet':'#8a5cff',
        '--neon-lime': '#b6ff3c',
        '--border':    'rgba(255,255,255,0.08)',
        '--glass':     'rgba(255,255,255,0.04)',
        '--glass-hover':'rgba(255,255,255,0.07)',
        '--bg-grad-1': '#11122a',
        '--shadow-neon':'0 0 0 1px rgba(255,43,214,0.25), 0 8px 30px rgba(0,240,255,0.08)'
      }
    },
    {
      id: 'light',
      name: 'Light',
      emoji: '☀️',
      meta: '#fafafa',
      vars: {
        '--bg-0':      '#fafafa',
        '--bg-1':      '#ffffff',
        '--bg-2':      '#f1f3f7',
        '--text':      '#0e0e1a',
        '--text-dim':  '#4a4a63',
        '--text-faint':'#8a8aa3',
        '--neon-pink': '#e91e8c',
        '--neon-cyan': '#0891b2',
        '--neon-violet':'#6d28d9',
        '--neon-lime': '#65a30d',
        '--border':    'rgba(0,0,0,0.08)',
        '--glass':     'rgba(0,0,0,0.03)',
        '--glass-hover':'rgba(0,0,0,0.06)',
        '--bg-grad-1': '#e8eaf3',
        '--shadow-neon':'0 0 0 1px rgba(107,40,217,0.15), 0 8px 30px rgba(8,145,178,0.08)'
      }
    },
    {
      id: 'sunset',
      name: 'Sunset',
      emoji: '🌅',
      meta: '#2a0f1a',
      vars: {
        '--bg-0':      '#1a0a14',
        '--bg-1':      '#2a0f1a',
        '--bg-2':      '#3a1424',
        '--text':      '#fff5e6',
        '--text-dim':  '#d6b89a',
        '--text-faint':'#9a7c63',
        '--neon-pink': '#ff7e3c',
        '--neon-cyan': '#ffd56b',
        '--neon-violet':'#d94e8f',
        '--neon-lime': '#fde047',
        '--border':    'rgba(255,213,107,0.15)',
        '--glass':     'rgba(255,213,107,0.05)',
        '--glass-hover':'rgba(255,213,107,0.10)',
        '--bg-grad-1': '#3a1424',
        '--shadow-neon':'0 0 0 1px rgba(255,126,60,0.25), 0 8px 30px rgba(255,213,107,0.10)'
      }
    },
    {
      id: 'mono',
      name: 'Mono',
      emoji: '🖤',
      meta: '#0a0a0a',
      vars: {
        '--bg-0':      '#0a0a0a',
        '--bg-1':      '#141414',
        '--bg-2':      '#1c1c1c',
        '--text':      '#f5f5f5',
        '--text-dim':  '#a0a0a0',
        '--text-faint':'#5a5a5a',
        '--neon-pink': '#ffffff',
        '--neon-cyan': '#e5e5e5',
        '--neon-violet':'#c0c0c0',
        '--neon-lime': '#d4d4d4',
        '--border':    'rgba(255,255,255,0.12)',
        '--glass':     'rgba(255,255,255,0.04)',
        '--glass-hover':'rgba(255,255,255,0.08)',
        '--bg-grad-1': '#1c1c1c',
        '--shadow-neon':'0 0 0 1px rgba(255,255,255,0.15), 0 8px 30px rgba(255,255,255,0.04)'
      }
    }
  ];

  // Whitelist-Set für schnelle Validierung
  const IDS = new Set(LIST.map(t => t.id));

  function get(id) {
    return LIST.find(t => t.id === id) || LIST[0];
  }

  function isValid(id) {
    return typeof id === 'string' && IDS.has(id);
  }

  function apply(id) {
    const t = get(id);
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-theme', t.id);
    // CSS-Variablen live setzen — überschreibt :root
    const s = root.style;
    for (const [k, v] of Object.entries(t.vars)) s.setProperty(k, v);
    // Meta-Theme-Color anpassen (Browser-Chrome auf Mobile)
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', t.meta);
  }

  return { LIST, get, isValid, apply };
})();
