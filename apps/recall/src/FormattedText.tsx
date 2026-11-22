import { Fragment, type ReactNode } from 'react';

// A deliberately small Markdown subset. React escapes all raw HTML. Images are
// never fetched; links are opt-in HTTPS navigation, with no referrer leakage.
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\(https:\/\/[^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
export function FormattedText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      nodes.push(<pre key={i}><code>{code.join('\n')}</code></pre>);
    } else if (/^\s*[-*] /.test(line)) {
      const items: string[] = [line.replace(/^\s*[-*] /, '')];
      while (i + 1 < lines.length && /^\s*[-*] /.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*[-*] /, ''));
      nodes.push(<ul key={i}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</ul>);
    } else if (/^\s*\d+\. /.test(line)) {
      const items = [line.replace(/^\s*\d+\. /, '')];
      while (i + 1 < lines.length && /^\s*\d+\. /.test(lines[i + 1])) items.push(lines[++i].replace(/^\s*\d+\. /, ''));
      nodes.push(<ol key={i}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</ol>);
    } else if (line.trim()) nodes.push(<p key={i}>{inline(line.replace(/^#{1,6} /, ''))}</p>);
  }
  return <div className="formatted">{nodes}</div>;
}
