import re
import unittest
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent


class ProductIcon(unittest.TestCase):
    def test_one_mark_everywhere_an_icon_is_shown(self):
        # Page top bar, browser tab, VS Code listing and tab, README banner: same square, same glyph.
        page = (ROOT/'static'/'index.html').read_text()
        mark = re.search(r'<svg class="brand-icon"[^>]*>(.*?)</svg>', page).group(1)
        self.assertIn('<rect', mark); self.assertIn('<path', mark)
        tab = unquote(re.search(r'<link rel="icon"[^>]*href="([^"]+)"', page).group(1))
        for name, text in (('browser tab', tab), ('extension', (ROOT/'vscode'/'media'/'icon.svg').read_text()),
                           ('banner', (ROOT/'docs'/'assets'/'banner.svg').read_text())):
            self.assertIn(mark, text, name)
        self.assertEqual((ROOT/'vscode'/'media'/'icon.png').read_bytes()[:8], b'\x89PNG\r\n\x1a\n')


if __name__ == '__main__':
    unittest.main()
