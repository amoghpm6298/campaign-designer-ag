// The campaign strategy's markdown, rendered properly.
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../src/designer/v2/Markdown';

const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }));

describe('Markdown', () => {
  it('headings, paragraphs, bold, italic, code', () => {
    const out = html('## Goal and success\n\nMore customers **spending**, judged by *count*.\nUses `cashback_first_spend_100`.\n\n### Lapsed 90+ Days');
    expect(out).toContain('<h3>Goal and success</h3>');
    expect(out).toContain('<p>More customers <strong>spending</strong>, judged by <em>count</em>. Uses <code>cashback_first_spend_100</code>.</p>');
    expect(out).toContain('<h4>Lapsed 90+ Days</h4>');
  });

  it('nested bullets and numbered lists', () => {
    const out = html('- **Who:** lapsed 90+ days\n- **Money:** rung 1\n  - offer: cashback\n  - cheaper: messages only\n\n1. First\n2. Second');
    expect(out).toContain('<ul><li><strong>Who:</strong> lapsed 90+ days</li><li><strong>Money:</strong> rung 1<ul><li>offer: cashback</li><li>cheaper: messages only</li></ul></li></ul>');
    expect(out).toContain('<ol><li>First</li><li>Second</li></ol>');
  });

  it('tables and rules', () => {
    const out = html('| Bucket | Offer |\n|---|---|\n| Lapsed | ₹100 cashback |\n\n---');
    expect(out).toContain('<table><thead><tr><th>Bucket</th><th>Offer</th></tr></thead><tbody><tr><td>Lapsed</td><td>₹100 cashback</td></tr></tbody></table>');
    expect(out).toContain('<hr/>');
  });

  it('underscores inside words stay as written (ids), _real_ italics still work', () => {
    const out = html('Uses points_2x_category and cashback_first_spend_100, exit no_response / not_reachable. An _important_ point.');
    expect(out).toContain('points_2x_category and cashback_first_spend_100, exit no_response / not_reachable');
    expect(out).toContain('<em>important</em>');
  });

  it('never injects markup from the text', () => {
    expect(html('<script>alert(1)</script> **x**')).toContain('&lt;script&gt;');
  });
});
