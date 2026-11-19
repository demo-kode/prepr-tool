// Small file-format grammars absent from the bundled catalog.
export const extraLanguages = [
  { id: 'salt', name: 'Salt / YAML + Jinja' },
  { id: 'ignore', name: 'Ignore patterns' },
  { id: 'ldif', name: 'LDAP Data Interchange' }
];
export const ignore = {
  name: 'ignore', scopeName: 'source.ignore', patterns: [
    { name: 'comment.line', match: '^\\s*#.*$' },
    { name: 'keyword.operator', match: '^!|[?*]' },
    { name: 'constant.character.escape', match: '\\\\.' },
    { name: 'punctuation.separator', match: '/' }
  ]
};
export const ldif = {
  name: 'ldif', scopeName: 'source.ldif', patterns: [
    { name: 'comment.line', match: '^#.*$' },
    { name: 'entity.name.tag', match: '^[a-zA-Z][a-zA-Z0-9;-]*(?=:)' },
    { name: 'punctuation.separator', match: '::?|<' }
  ]
};
export function salt(yaml) {
  return { ...yaml, name: 'salt', scopeName: 'source.salt',
    injections: { 'L:source.salt': { patterns: [{ include: 'source.jinja' }] } } };
}
