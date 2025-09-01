export const splitDirectory = (path: string): [string, string] => {
  const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return [path.substring(0, lastSep), path.substring(lastSep + 1)];
};

export const commonAncestorPath = (a: string, b: string): string => {
  if (b.startsWith(a)) return a;
  for (let end=a.length; end>=0;) {
    const lastSep = Math.max(a.lastIndexOf('/', end), a.lastIndexOf('\\', end));
    const dir = a.substring(0,lastSep);
    if (b.startsWith(dir)) return dir;
    end = lastSep - 1;
  }
  return '';
};

export const escapeHtml = (unsafe: string): string => unsafe
  .replaceAll('&','&amp;')
  .replaceAll('<','&lt;')
  .replaceAll('>','&gt;')
  .replaceAll('"','&quot;')
  .replaceAll("'",'&#039;');
