/**
 * Markdown rendering with DOMPurify sanitization.
 * Adapted from web-ui-legacy/src/lib/markdown.ts.
 * No syntax highlighting (no highlight.js in redesign bundle).
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target'],
  });
}
