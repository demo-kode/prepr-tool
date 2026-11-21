#!/usr/bin/env python3
"""Package VS Code extension as .vsix. Stdlib only; no vsce/npm."""
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
FILES = ['package.json', 'extension.js', 'README.md', 'media/icon.png', 'media/icon.svg']


def manifest(pkg):
    e = lambda v: escape(str(v), {'"': '&quot;'})
    return f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{e(pkg['name'])}" Version="{e(pkg['version'])}" Publisher="{e(pkg['publisher'])}"/>
    <DisplayName>{e(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{e(pkg['description'])}</Description>
    <Categories>{e(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{e(pkg['engines']['vscode'])}"/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/{e(pkg['icon'])}" Addressable="true"/>
  </Assets>
</PackageManifest>
'''


CONTENT_TYPES = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
'''


def build(out_dir):
    pkg = json.loads((HERE / 'package.json').read_text())
    # Installed copy knows where review.py lives: extension keeps agent runner up from there.
    pkg['contributes']['configuration']['properties']['prepr.toolPath']['default'] = str(HERE.parent)
    out = Path(out_dir) / f"{pkg['name']}-{pkg['version']}.vsix"
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', CONTENT_TYPES)
        z.writestr('extension.vsixmanifest', manifest(pkg))
        z.writestr('extension/package.json', json.dumps(pkg, indent=2) + '\n')
        for name in FILES[1:]:
            z.write(HERE / name, 'extension/' + name)
    return out, f"{pkg['publisher']}.{pkg['name']}"


if __name__ == '__main__':
    path, ext_id = build(sys.argv[1] if len(sys.argv) > 1 else HERE.parent / '.local' / 'vscode')
    print(json.dumps({'vsix': str(path), 'id': ext_id}))
