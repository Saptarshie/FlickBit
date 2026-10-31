/**
 * Injects the guest shim as an inline `<script>` so it runs before any game
 * script: immediately after the opening `<head>` tag (the very first child of
 * head). When the document has no `<head>` tag the shim script is prepended,
 * after any doctype/xml prologue so the prologue stays valid.
 */
export function injectShim(html: string, shimSource: string): string {
  const script = `<script>${shimSource}</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const prologue = /^\s*(?:<!doctype[^>]*>|<\?xml[^>]*>)\s*/i.exec(html);
  const at = prologue ? prologue[0].length : 0;
  return html.slice(0, at) + script + html.slice(at);
}
