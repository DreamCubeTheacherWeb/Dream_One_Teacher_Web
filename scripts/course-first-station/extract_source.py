#!/usr/bin/env python3
# 把 Google Sites 頁面解析成有序元素流: heading / para / li / img / link
import re, json, html as H
from html.parser import HTMLParser

RAW = open('/private/tmp/claude-501/-Users-lazylazy-Desktop------Dream-One-Teacher-Web/5fb3fe6d-dd7c-495b-846e-a72967f39504/scratchpad/raw-source.html', encoding='utf-8', errors='ignore').read()
RAW = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', RAW, flags=re.S)

BLOCK = {'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div', 'td', 'section'}

class P(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []          # element stream
        self.cur = None        # current block: {'tag':..., 'runs':[(text,bold,href)]}
        self.stack = []        # tag stack
        self.boldd = 0
        self.hrefs = []        # anchor stack
        self.in_main = 0

    def flush(self):
        if self.cur and any(t.strip() for t, b, h in self.cur['runs']):
            self.out.append(self.cur)
        self.cur = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'div' and a.get('role') == 'main':
            self.in_main += 1
        if not self.in_main:
            return
        if tag == 'img':
            self.flush()
            src = a.get('src', '')
            if 'googleusercontent' in src:
                self.out.append({'tag': 'img', 'src': src.split('=')[0]})
            return
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li'):
            self.flush()
            self.cur = {'tag': tag, 'runs': []}
        if tag in ('b', 'strong'):
            self.boldd += 1
        if tag == 'span':
            style = a.get('style', '')
            if 'font-weight:700' in style or 'font-weight: 700' in style or 'font-weight:bold' in style:
                self.boldd += 1
                self.stack.append(('span-bold', tag))
                return
        if tag == 'a':
            self.hrefs.append(a.get('href', ''))
        if tag == 'br' and self.cur:
            self.cur['runs'].append(('\n', False, None))
        self.stack.append((tag, tag))

    def handle_endtag(self, tag):
        if not self.in_main:
            return
        # pop matching
        for i in range(len(self.stack) - 1, -1, -1):
            kind, t = self.stack[i]
            if t == tag:
                if kind == 'span-bold':
                    self.boldd -= 1
                del self.stack[i]
                break
        if tag in ('b', 'strong'):
            self.boldd -= 1
        if tag == 'a' and self.hrefs:
            self.hrefs.pop()
        if tag in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li'):
            self.flush()

    def handle_data(self, data):
        if not self.in_main or not data.strip():
            return
        if self.cur is None:
            self.cur = {'tag': 'p', 'runs': []}
        href = self.hrefs[-1] if self.hrefs else None
        self.cur['runs'].append((data, self.boldd > 0, href))

p = P()
p.feed(RAW)
p.flush()

# 後處理：合併 runs → 每個元素給 html 與 text
def runs_to_html(runs):
    parts = []
    for text, bold, href in runs:
        t = H.escape(text).replace('\n', '<br>')
        if href:
            hu = href
            # 解開 google 轉址
            m = re.search(r'[?&]q=(https?[^&]+)', hu)
            if m:
                from urllib.parse import unquote
                hu = unquote(m.group(1))
            t = f'<a href="{H.escape(hu)}" target="_blank" rel="noopener">{t}</a>'
        if bold:
            t = f'<b>{t}</b>'
        parts.append(t)
    h = ''.join(parts)
    h = re.sub(r'</b><b>', '', h)
    return h

def runs_to_text(runs):
    return re.sub(r'\s+', ' ', ''.join(t for t, b, h in runs)).strip()

stream = []
for el in p.out:
    if el['tag'] == 'img':
        stream.append({'k': 'img', 'src': el['src']})
        continue
    text = runs_to_text(el['runs'])
    if not text:
        continue
    html = runs_to_html(el['runs'])
    allbold = all(b for t, b, h in el['runs'] if t.strip())
    links = [h for t, b, h in el['runs'] if h]
    stream.append({'k': el['tag'], 'text': text, 'html': html,
                   'bold': allbold, 'links': links})

json.dump(stream, open('/private/tmp/claude-501/-Users-lazylazy-Desktop------Dream-One-Teacher-Web/5fb3fe6d-dd7c-495b-846e-a72967f39504/scratchpad/source-stream.json', 'w'), ensure_ascii=False, indent=1)
print(f'{len(stream)} elements')
for i, el in enumerate(stream):
    if el['k'] == 'img':
        print(f"{i:3d} IMG {el['src'][-25:]}")
    else:
        mark = 'B' if el.get('bold') else ' '
        ln = 'L' if el.get('links') else ' '
        print(f"{i:3d} {el['k']:3s}{mark}{ln} {el['text'][:65]}")
