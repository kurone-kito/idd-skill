/**
 * Strip Markdown code regions (fenced blocks and inline code spans) from a body
 * before scanning it for machine-readable markers or dependency references. A
 * genuine marker is raw text GitHub renders as intended (an HTML comment it
 * hides, or a `Blocked by #N` line it links), never inside a code span or
 * fence, so an example an issue merely *quotes* in code (e.g. an issue about
 * the marker or dependency syntax) must not be read as real. HTML comments are
 * deliberately NOT stripped here — only code regions are, since some markers
 * are themselves HTML comments. Masked regions keep their line count and
 * surrounding text so a real marker elsewhere in the body still matches.
 */
export function stripMarkdownCodeRegions(text) {
  // Fenced blocks (``` or ~~~), tracking the fence char + length so a longer
  // opening fence is not closed by a shorter inner fence (CommonMark §4.5).
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    const openMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const marker = openMatch[1];
      const info = openMatch[2];
      const fenceChar = marker[0];
      if (fence === null) {
        // CommonMark §4.5: a backtick-fence opener's info string may not
        // contain a backtick (that would be ambiguous with a close or inline
        // code), so such a line is not a fence opener and stays content.
        if (fenceChar !== '`' || !info.includes('`')) {
          fence = { char: fenceChar, length: marker.length };
          out.push('');
          continue;
        }
      } else if (
        fenceChar === fence.char &&
        marker.length >= fence.length &&
        /^\s*$/.test(info)
      ) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  // Inline code spans (`...`, ``...``): mask the inner content so a quoted
  // marker no longer matches, keeping the backticks and surrounding text.
  return out
    .join('\n')
    .replace(
      /(`+)((?:(?!\1)[\s\S])+?)\1/g,
      (_match, ticks, inner) =>
        `${ticks}${inner.replace(/[^\r\n]/g, ' ')}${ticks}`,
    );
}
