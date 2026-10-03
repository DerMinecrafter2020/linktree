// =========================================================
// Rechtstexte: Absatze und Zeilenumbrueche lesbar darstellen
// =========================================================

(() => {
  'use strict';

  const content = document.querySelector('.user-content');
  const page = document.body.dataset.legalPage;
  if (!content || !['impressum', 'datenschutz'].includes(page)) return;

  const field = page === 'impressum' ? 'impressum_text' : 'datenschutz_text';

  function endsSentence(text) {
    const value = String(text || '').trim();
    if (/\b(?:Art|Abs|Nr|Ziff)\.$/i.test(value)) return false;
    return /[.!?]["'»”')\]]*$/.test(value);
  }

  function nextParagraph(node) {
    let next = node.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent.trim()) next = next.nextSibling;
    return next;
  }

  // Die vorhandene Datenschutzerklaerung wurde zeilenweise in eigene <p>-Tags zerlegt.
  // Benachbarte Fragmente bis zum Satzende wieder zu einem normalen Absatz verbinden.
  function mergeStaticParagraphFragments(root) {
    let node = root.firstChild;
    while (node) {
      if (node.nodeType !== Node.ELEMENT_NODE || node.tagName !== 'P') {
        node = node.nextSibling;
        continue;
      }

      const first = node;
      const fragments = [first.textContent.trim()];
      let lastText = fragments[0];
      let candidate = nextParagraph(first);
      while (candidate && candidate.nodeType === Node.ELEMENT_NODE && candidate.tagName === 'P' && !endsSentence(lastText)) {
        let between = first.nextSibling;
        while (between && between !== candidate) {
          const next = between.nextSibling;
          between.remove();
          between = next;
        }
        lastText = candidate.textContent.trim();
        fragments.push(lastText);
        candidate.remove();
        candidate = nextParagraph(first);
      }

      if (fragments.length > 1) {
        first.textContent = fragments.reduce((result, fragment) => {
          if (!result) return fragment;
          return /-$/.test(result) ? result + fragment : `${result} ${fragment}`;
        }, '');
      }
      node = first.nextSibling;
    }
  }

  function textFromLegacyHtml(source) {
    return String(source)
      .replace(/<br\b[^>]*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '• ')
      .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote|ul|ol)\s*>/gi, '\n\n')
      .replace(/<[^>]*>/g, '');
  }

  function decodeEntities(text) {
    const decoder = document.createElement('textarea');
    // Winkelklammern escapen, damit Text wie "</textarea>" nicht als Tag geparst wird.
    decoder.innerHTML = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return decoder.value;
  }

  function renderText(source) {
    let text = String(source || '').replace(/\r\n?/g, '\n');
    if (/<\/?[a-z][^>]*>/i.test(text)) text = textFromLegacyHtml(text);
    text = decodeEntities(text).trim();
    if (!text) return [];

    return text.split(/\n[\t ]*\n+/).map((block) => {
      const paragraph = document.createElement('p');
      block.split('\n').forEach((line, index) => {
        if (index) paragraph.appendChild(document.createElement('br'));
        paragraph.appendChild(document.createTextNode(line));
      });
      return paragraph;
    });
  }

  mergeStaticParagraphFragments(content);

  if (!window.api?.getLegalContent) return;
  window.api.getLegalContent().then((legal) => {
    const text = legal?.[field];
    if (typeof text !== 'string' || !text.trim()) return;
    content.replaceChildren(...renderText(text));
  }).catch(() => {
    // Bei einem API-Ausfall bleiben die mitgelieferten Rechtstexte sichtbar.
  });
})();
