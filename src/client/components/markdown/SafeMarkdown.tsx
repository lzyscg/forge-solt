/**
 * 安全 Markdown 渲染（文档 §10.5）。
 *
 * 模型输出是**不可信输入**——模型可能在正文里生成 `<img src=x onerror=…>`。
 * 两道防线缺一不可：
 *   1. `MarkdownIt({ html: false })` 不解析原始 HTML；
 *   2. DOMPurify 按允许标签白名单再滤一遍。
 * 外链统一 `rel="noopener noreferrer nofollow"` + `target="_blank"`。
 */

import { useMemo } from 'react';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const md = new MarkdownIt({ html: false, linkify: true });

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
  'hr',
];
const ALLOWED_ATTR = ['href'];

// 外链安全属性。addHook 是全局一次性注册，幂等
let hookInstalled = false;
function installLinkHook(): void {
  if (hookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hookInstalled = true;
}

export function renderSafeMarkdown(content: string): string {
  installLinkHook();
  const html = md.render(content);
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}

export function SafeMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderSafeMarkdown(content), [content]);
  // 内容已经过 MarkdownIt(html:false) + DOMPurify 白名单双重脱险，此处注入是安全的
  return <div className="fc-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
