import { redactString } from "@campus/contracts";

// iMessage does not render markdown (spec 3.1) → every outbound message is plain text.

export const MAX_REPLY_CHARS = 1_200;

export function toPlainText(input: string, max = MAX_REPLY_CHARS): string {
  let s = input.replace(/\r\n/g, "\n");
  s = s.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1"); // code fences
  s = s.replace(/`([^`]+)`/g, "$1"); // inline code
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)"); // images
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)"); // links
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // headings
  s = s.replace(/(\*\*|__)(.+?)\1/g, "$2"); // bold
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2"); // italics *x*
  s = s.replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2"); // italics _x_
  s = s.replace(/^\s*[-*+]\s+/gm, "- "); // bullets → plain dash
  s = s.replace(/^\s*>\s?/gm, ""); // blockquotes
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  s = redactString(s);
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
