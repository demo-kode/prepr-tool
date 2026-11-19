import { createHighlighterCore, createOnigurumaEngine, bundledLanguages, theme, wasm } from './vendor/shiki.js';

import { ignore, ldif, salt } from './extra-grammars.js';

const reviewTheme = { ...theme, tokenColors: theme.tokenColors.map(rule => rule.settings?.foreground?.toLowerCase() === '#6a737d' ? { ...rule, settings: { ...rule.settings, foreground: '#9da7b7' } } : rule) };
const ready = createHighlighterCore({ themes: [reviewTheme], langs: [], engine: createOnigurumaEngine(wasm) });
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const highlighter = await ready;
      const sides = {};
      for (const side of data.sides) {
        if (side.language === 'salt') {
          const yaml = (await bundledLanguages.yaml()).default.find(g => g.name === 'yaml');
          await highlighter.loadLanguage(bundledLanguages.jinja, salt(yaml));
        } else if (side.language === 'ignore' || side.language === 'ldif') {
          await highlighter.loadLanguage(side.language === 'ignore' ? ignore : ldif);
        } else {
          if (!bundledLanguages[side.language]) continue;
          await highlighter.loadLanguage(bundledLanguages[side.language]);
        }
        // Tokenize whole file; preserve state across hidden lines and hunks.
        const tokens = highlighter.codeToTokens(side.text, { lang: side.language, theme: 'github-dark' }).tokens;
        sides[side.side] = Object.fromEntries(side.lines.map(line => [line, tokens[line - 1] || []]));
      }
      self.postMessage({ id: data.id, sides });
    } catch {
      self.postMessage({ id: data.id, error: true });
    }
  });
};
