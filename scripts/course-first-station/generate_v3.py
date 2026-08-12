#!/usr/bin/env python3
# 畫布復刻 v3：字級放大（桌機顯示≈原頁實體大小）＋兩段式高度實測＋欄位感知堆疊＋9 課切分
# 用法: python3 generate_v3.py A   → 產 measure.html（給 measure_heights.mjs 量高度）
#       python3 generate_v3.py B   → 讀 heights.json 組裝 canvas-contents-v3.json
import json, re, html as H, unicodedata, os, sys, base64, io
from urllib.parse import unquote
from PIL import Image

SCRATCH = os.path.dirname(os.path.abspath(__file__))
PASS = sys.argv[1] if len(sys.argv) > 1 else 'B'
M = json.load(open(f'{SCRATCH}/measured.json'))
ELS = M['els']
MASTHEAD_URL = open(f'{SCRATCH}/masthead-url.txt').read().strip()
PLACEHOLDERS = json.load(open(f'{SCRATCH}/placeholders.json'))
SHOT = Image.open(f'{SCRATCH}/shots/source-full.png').convert('RGB')

X0, X1 = 123.0, 1277.0
S = 960.0 / (X1 - X0)          # 幾何比例 0.832
FK = 1.15                       # 字級比例：15px 源字 → 17px 畫布 → 桌機顯示 ≈15.2px
VS = 960.0 / 1400.0

def unwrap(u):
    if not u: return u
    m = re.search(r'[?&]q=(https?[^&]+)', u)
    return unquote(m.group(1)) if m else u

def find_idx(kind, key):
    for i, e in enumerate(ELS):
        if e['kind'] == kind and key in e.get('text', ''):
            return i
    raise KeyError(key)

def boundary(kind, key):
    i = find_idx(kind, key)
    while i > 0 and ELS[i-1]['kind'] == 'img' and ELS[i-1]['box']['y'] > ELS[i]['box']['y'] - 120:
        i -= 1
    return i

B = [boundary('h1', '李孟一'), boundary('h1', '講師群組'), boundary('h1', '良好課程關鍵'),
     boundary('h1', '魔術方塊教學通識課'), boundary('h3', '溝通方式'),
     boundary('h2', '突發狀況處理'), boundary('h1', '教你怎麼教'),
     boundary('h1', '下一站')]
ranges = [(1, B[0]), (B[0], B[1]), (B[1], B[2]), (B[2], B[3]), (B[3], B[4]),
          (B[4], B[5]), (B[5], B[6]), (B[6], B[7]), (B[7], len(ELS))]

LMETA = [
 ('2130970d-db5e-4213-9c5b-d2d2e37a3e89', '歡迎來到夢想一號', True),
 ('28f64e02-b805-4e90-92c1-25d0213987cd', '執行長的話與行政團隊', False),
 ('3e050b7d-7c73-4fc3-8953-2f41faa2d883', '三大講師群組', False),
 ('fa8ed1ab-bd92-454c-b0c9-8d6cfe480964', '課程 SOP — 課前到課後', True),
 ('f6b432ca-aefc-4d17-a9e0-0a2be914e901', '教學關鍵與課程框架', True),
 ('f2f7eea5-2410-4c3e-a3da-47854b5946a6', '溝通方式與班級經營', True),
 ('f457f5d6-6e73-4a7c-9068-cf6027bb7308', '突發狀況處理 SOP', True),
 ('5e65c1f2-dcf8-43c6-935f-f3fd9d8fe26e', '教你怎麼教影片', False),
 ('e85d3c6d-faa2-46e5-a9b3-f567de5af046', '下一站：正式講師培訓', True),
]

cur = json.load(open(f'{SCRATCH}/contents-current.json'))
path_of = {c['id'][:8]: c['video_url'] for c in cur if c.get('video_url')}
IMG_PATHS = [path_of[k] for k in ['2e1cdb26', '4cea9729', '0e245851', 'c26d7bab',
             '50042370', '251d1b47', 'dd2f5fb6', '62ea20f7',
             'a8201c46', '9c31d5fa', '538a5837', 'a1771c1c', '6e7aabfa']]
imgs_sorted = sorted([i for i, e in enumerate(ELS) if e['kind'] == 'img'],
                     key=lambda i: (ELS[i]['box']['y'], ELS[i]['box']['x']))
IMG_MAP = dict(zip(imgs_sorted, IMG_PATHS))
HOTLINK_IMGS = {imgs_sorted[-1]}

BANDS = [(1425, 1543), (2465, 2584), (3688, 3807), (4663, 4781),
         (6523, 6642), (14998, 15116), (16844, 16962)]
def lesson_of_element(idx):
    for li, (a, b) in enumerate(ranges):
        if a <= idx < b: return li
    return None
def band_lesson(b0):
    for i, e in enumerate(ELS):
        if e['box']['y'] >= b0 - 25:
            return lesson_of_element(i)
    return None
BAND_LESSON = {b: band_lesson(b[0]) for b in BANDS}

def sample_bg(e):
    b = e['box']
    pts = [(int(b['x'] + 8), int(b['y'] + b['h'] / 2)),
           (int(b['x'] + b['w'] - 8), int(b['y'] + b['h'] / 2))]
    cols = [SHOT.getpixel(p) for p in pts if 0 <= p[0] < SHOT.size[0] and 0 <= p[1] < SHOT.size[1]]
    if len(cols) < 2: return None
    (r1, g1, b1), (r2, g2, b2) = cols
    if abs(r1-r2) + abs(g1-g2) + abs(b1-b2) > 40: return None
    if r1 + g1 + b1 > 700: return None
    return f'rgb({r1},{g1},{b1})'

def runs_html(runs):
    parts, buf, cursty = [], [], None
    def flush():
        if buf and cursty is not None:
            text = H.escape(''.join(buf))
            fs, color, bold, italic, href = cursty
            style = f'font-size:{max(13, round(fs * FK))}px;color:{color};'
            if bold: style += 'font-weight:700;'
            if italic: style += 'font-style:italic;'
            seg = f'<span style="{style}">{text}</span>'
            if href:
                seg = f'<a href="{H.escape(unwrap(href))}" target="_blank" rel="noopener">{seg}</a>'
            parts.append(seg)
        buf.clear()
    for r in runs:
        if r.get('br'):
            flush(); cursty = None; parts.append('<br>'); continue
        sty = (r.get('fs', 16), r.get('color', 'rgb(33,33,33)'),
               r.get('bold', False), r.get('italic', False), r.get('href'))
        if sty != cursty:
            flush(); cursty = sty
        buf.append(r['t'])
    flush()
    return ''.join(parts)

MARKS = {'square': '■', 'disc': '●', 'circle': '○'}
def marker_html(e):
    mk = e.get('marker')
    if not mk: return ''
    fs = max(13, round(max((r.get('fs', 16) for r in e['runs'] if r.get('t', '').strip()), default=15) * FK))
    color = next((r.get('color', 'rgb(33,33,33)') for r in e['runs'] if r.get('t', '').strip()), 'rgb(33,33,33)')
    sym = f"{mk['idx']}." if (mk['ordered'] or mk['type'] == 'decimal') else MARKS.get(mk['type'], '●')
    return f'<span style="font-size:{fs}px;color:{color};">{sym}&nbsp;</span>'

def is_button(e):
    if e['kind'] != 'p' or len(e['text']) > 26: return False
    hrefs = {r['href'] for r in e['runs'] if r.get('href')}
    if len(hrefs) != 1: return False
    linked = sum(len(r['t']) for r in e['runs'] if r.get('href'))
    total = sum(len(r['t']) for r in e['runs'] if r.get('t', '').strip())
    return total > 0 and linked / total > 0.8

HWTXT = {
 0: ('自我介紹（文字作業，100–200 字）', ['你是誰、目前的身分', '你和魔術方塊的淵源（會哪些方塊、玩多久）', '為什麼想成為魔術方塊老師']),
 3: ('SOP 流程默寫（文字作業）', ['不回看內容，依序寫出課前→授課當天→課中→課後你會做的事（每階段至少 3 項）', '寫完回頭對照本課內容，補上遺漏並標注「補」']),
 4: ('八步驟教案設計（文字作業）', ['以「三階小花」或你最熟的環節為主題', '用課程框架八步驟寫 15–20 分鐘教學流程', '每步驟寫出你會說的一句話或會做的一件事']),
 5: ('三明治回饋演練（文字作業）', ['情境：學生轉三階小花，第三片花瓣一直放不上去，開始不耐煩', '寫出你會說的一段話：好→指正→好', '另自選一條班級規則，寫出「包裝過」的說法']),
 6: ('突發狀況情境題（文字作業）', ['任選兩種突發狀況（如學生受傷、打架）', '各寫出處理步驟：第一步做什麼、向誰回報、對家長／單位怎麼說']),
 8: ('第一站學習心得（文字作業，150–300 字）', ['印象最深的一個觀念與原因', '最想先教的一顆方塊與原因', '對正式講師培訓的意願與疑問（完成後記得到個人群組 Tag 懶懶申請檢核表單）']),
}

# ═══ 蒐集所有 item（尚無最終 y）═══
# item: dict(li, kind[text|img|band|btn|ph|hw|mast|title], src(x,y,w,h), x, w, h(None=待量), payload)
items_all = []
for li, ((a, b), (lid, ltitle, hw)) in enumerate(zip(ranges, LMETA)):
    els = [(i, ELS[i]) for i in range(a, b)]
    els = [(i, e) for i, e in els if '建議使用電腦檢視' not in e.get('text', '')]
    my_bands = [bd for bd, who in BAND_LESSON.items() if who == li]

    if li == 0:
        # 橫幅＝原頁截圖裁切（含壓在照片上的標題字，像素級一致），data URI 內嵌秒開、不依賴 Google
        mast_h = round(330 * VS)
        mcrop = SHOT.crop((0, 104, 1400, 434))
        mbuf = io.BytesIO(); mcrop.save(mbuf, 'JPEG', quality=86)
        mb64 = base64.b64encode(mbuf.getvalue()).decode()
        items_all.append(dict(li=0, kind='mast', src=(0, 40, 1400, 340), x=0, w=960, h=mast_h,
            p={'type': 'article', 'title': '橫幅',
               'body': f'<img src="data:image/jpeg;base64,{mb64}" alt="魔術方塊老師第一站" style="width:100%;height:100%;object-fit:cover;">', 'pd': {}}))

    for b0, b1 in my_bands:
        items_all.append(dict(li=li, kind='band', src=(0, b0, 1400, b1 - b0), x=0, w=960,
            h=round((b1 - b0) * S),
            p={'type': 'article', 'title': '分隔帶', 'body': '',
               'pd': {'shapeType': 'rect', 'fillColor': 'rgb(50,50,50)', 'borderWidth': 0,
                      'borderColor': 'rgb(50,50,50)'}}))

    if li == 7:
        for ph in PLACEHOLDERS:
            items_all.append(dict(li=7, kind='ph', src=(ph['x'], ph['y'], ph['w'], ph['h']),
                x=round((ph['x'] - X0) * S), w=round(ph['w'] * S), h=round(ph['h'] * S),
                p={'type': 'article', 'title': '佔位框',
                   'body': '<div style="position:absolute;inset:4px;border:3px dashed #dadce0;border-radius:12px;"></div>', 'pd': {}}))

    for i, e in els:
        bx = e['box']; src = (bx['x'], bx['y'], bx['w'], bx['h'])
        if e['kind'] == 'img':
            if i in HOTLINK_IMGS:
                crop = SHOT.crop((int(bx['x']), int(bx['y']), int(bx['x'] + bx['w']), int(bx['y'] + bx['h'])))
                buf = io.BytesIO(); crop.save(buf, 'JPEG', quality=84)
                b64 = base64.b64encode(buf.getvalue()).decode()
                items_all.append(dict(li=li, kind='img', src=src,
                    x=round((bx['x'] - X0) * S), w=round(bx['w'] * S), h=round(bx['h'] * S),
                    p={'type': 'article', 'title': '圖片',
                       'body': f'<img src="data:image/jpeg;base64,{b64}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;">', 'pd': {}}))
            else:
                items_all.append(dict(li=li, kind='img', src=src,
                    x=round((bx['x'] - X0) * S), w=round(bx['w'] * S), h=round(bx['h'] * S),
                    p={'type': 'image_text', 'title': '圖片',
                       'body': json.dumps({'caption': ''}), 'video': IMG_MAP[i], 'pd': {}}))
            continue
        if is_button(e):
            st = e.get('btnStyle')
            fill = (st and st['bg']) or sample_bg(e)
            if fill:
                href = unwrap(next(r['href'] for r in e['runs'] if r.get('href')))
                tcolor = next((r.get('color', '#fff') for r in e['runs'] if r.get('t', '').strip()), '#fff')
                rad = re.match(r'([\d.]+)', (st and st.get('radius')) or '8')
                items_all.append(dict(li=li, kind='btn', src=src,
                    x=round((bx['x'] - X0) * S), w=round(bx['w'] * S),
                    h=max(36, round(bx['h'] * S)),
                    p={'type': 'article', 'title': e['text'][:20], 'body': e['text'],
                       'pd': {'shapeType': 'button', 'fillColor': fill, 'textColor': tcolor,
                              'borderRadius': float(rad.group(1)) if rad else 8,
                              'borderWidth': 0, 'linkUrl': href}}))
                continue
        gut = 22 if e.get('marker') else 0
        body = f'<div style="text-align:{e["align"]};line-height:1.5;">{marker_html(e)}{runs_html(e["runs"])}</div>'
        items_all.append(dict(li=li, kind='text', src=src,
            x=round((bx['x'] - X0 - gut) * S) - 12, w=round((bx['w'] + gut) * S) + 24, h=None,
            p={'type': 'article', 'title': '文字框', 'body': body, 'pd': {}}))

# ═══ PASS A：產 measure.html ═══
text_items = [it for it in items_all if it['h'] is None]
if PASS == 'A':
    parts = []
    for n, it in enumerate(text_items):
        inner_w = it['w'] - 24
        parts.append(f'<div class="m" data-i="{n}" style="width:{inner_w}px;">{it["p"]["body"]}</div>')
    html = ('<!DOCTYPE html><html><head><meta charset="utf-8">'
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700;800&display=swap">'
            '<style>body{margin:20px;font-family:"Noto Sans TC",sans-serif;}'
            '.m{font-size:16px;line-height:1.6;word-break:break-word;margin-bottom:30px;outline:1px solid #eee;}</style>'
            '</head><body>' + '\n'.join(parts) + '</body></html>')
    open(f'{SCRATCH}/preview/measure.html', 'w').write(html)
    print(f'PASS A: measure.html 產出，{len(text_items)} 個文字框待量')
    sys.exit(0)

# ═══ PASS B：組裝 ═══
heights = json.load(open(f'{SCRATCH}/heights.json'))
assert len(heights) == len(text_items), (len(heights), len(text_items))
for n, it in enumerate(text_items):
    it['h'] = heights[n] + 24 + 8   # 內容高 + padding + buffer

def overlap_x(a, b):
    return min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x']) > 8

all_rows = []
report = []
for li, ((a, b), (lid, ltitle, hw)) in enumerate(zip(ranges, LMETA)):
    L = [it for it in items_all if it['li'] == li]
    # 課首基準
    y_min = min(it['src'][1] for it in L)
    y_off = 16
    # 依原始 y,x 排序後做堆疊；原始同列（top ±10）取 max 對齊
    L.sort(key=lambda it: (it['src'][1], it['src'][0]))
    placed = []
    gi = 0
    while gi < len(L):
        group = [L[gi]]
        while gi + len(group) < len(L) and abs(L[gi + len(group)]['src'][1] - group[0]['src'][1]) <= 10:
            group.append(L[gi + len(group)])
        for it in group:
            sy = it['src'][1]
            best = None
            for pv in placed:
                if pv['src'][1] + pv['src'][3] <= sy + 15 and overlap_x(pv, it):
                    gap = max(0, sy - (pv['src'][1] + pv['src'][3]))
                    cand = pv['y'] + pv['h'] + round(gap * S)
                    if best is None or cand > best: best = cand
            it['y'] = best if best is not None else round((sy - y_min) * S) + y_off
        ymax_g = max(it['y'] for it in group)
        for it in group:
            it['y'] = ymax_g
            placed.append(it)
        gi += len(group)
    # L0 橫幅特例：mast/title 固定 0/其原位；內容從 mast 底開始（已由 pred 圖生效：hero 無 pred → 映射）
    if li == 0:
        mast = next(it for it in L if it['kind'] == 'mast')
        mast['y'] = 0
        # 其他無 pred 元素往下挪到 mast 底之後
        for it in L:
            if it['kind'] == 'mast': continue
            if it['y'] < mast['h'] + 8: it['y'] = it['y'] + mast['h'] + 8
    # 作業框
    if hw:
        y_hw = max(it['y'] + it['h'] for it in L) + 30
        t, lst = HWTXT[li]
        lis = ''.join(f'<li style="margin:4px 0;">{x}</li>' for x in lst)
        hw_h = 140 + 34 * len(lst)
        L.append(dict(li=li, kind='hw', src=(45, 10**7, 894, hw_h), x=33, w=894, h=hw_h, y=y_hw,
            p={'type': 'article', 'title': '本課作業',
               'body': (f'<div style="background:#fff7ed;border:2px solid #fdba74;border-radius:14px;padding:16px 20px;">'
                        f'<span style="font-size:18px;font-weight:800;">📝 本課作業｜{t}</span>'
                        f'<ol style="list-style:decimal;padding-left:1.3em;margin-top:8px;font-size:15px;">{lis}</ol>'
                        f'<span style="font-size:15px;color:#9a3412;font-weight:700;">完成後請在本頁最下方的作業區送出。</span></div>'),
               'pd': {}}))
    # z 排序 → order
    ZK = {'mast': 0, 'band': 1, 'ph': 8, 'img': 10, 'text': 15, 'title': 18, 'btn': 20, 'hw': 30}
    L.sort(key=lambda it: (ZK[it['kind']], it['y'], it['x']))
    for order, it in enumerate(L):
        pd = {'x': max(0, it['x']), 'y': max(0, it['y']), 'width': min(960, it['w']),
              'height': it['h'], 'opacity': 1}
        pd.update(it['p']['pd'])
        all_rows.append({'lesson_id': lid, 'type': it['p']['type'], 'title': it['p']['title'],
                         'order': order, 'status': 'published', 'position_data': pd,
                         'body': it['p']['body'], 'video_url': it['p'].get('video')})
    ymax = max(it['y'] + it['h'] for it in L)
    # 重疊檢查（text vs text）
    texts = [it for it in L if it['kind'] == 'text']
    ncol = 0
    for i1 in range(len(texts)):
        for i2 in range(i1 + 1, len(texts)):
            t1, t2 = texts[i1], texts[i2]
            ox = min(t1['x']+t1['w'], t2['x']+t2['w']) - max(t1['x'], t2['x'])
            oy = min(t1['y']+t1['h'], t2['y']+t2['h']) - max(t1['y'], t2['y'])
            if ox > 30 and oy > 14: ncol += 1
    report.append(f'{ltitle}: {len(L)} 區塊, 高 {ymax}px, 文字互疊 {ncol}')

json.dump(all_rows, open(f'{SCRATCH}/canvas-contents-v3.json', 'w'), ensure_ascii=False, indent=1)
print(f'共 {len(all_rows)} rows → canvas-contents-v3.json')
print('\n'.join(report))

# ═══ 零遺漏驗證 ═══
def norm(t):
    t = unicodedata.normalize('NFKC', H.unescape(t or ''))
    t = re.sub(r'\s+', '', t)
    return re.sub(r'[，。、：；！？「」『』（）()\[\],.:;!?~‧・…—\-＋+＊*〈〉<>《》%％｜|^]', '', t).lower()
comb_html = ''.join((r['body'] or '') + (r['video_url'] or '')
                    + ((r['position_data'] or {}).get('linkUrl') or '') for r in all_rows)
comb = norm(re.sub(r'<[^>]+>', ' ', comb_html))
errs = []
for a, b in ranges:
    for i in range(a, b):
        e = ELS[i]
        if e['kind'] == 'img':
            ref = 'data:image/jpeg;base64,' if i in HOTLINK_IMGS else IMG_MAP[i]
            if ref not in comb_html: errs.append(f'{i}: 圖片遺失')
            continue
        if '建議使用電腦檢視' in e['text']: continue
        for r in e['runs']:
            if r.get('href'):
                u = unwrap(r['href'])
                if u not in comb_html and H.escape(u) not in comb_html:
                    errs.append(f'{i}: 連結遺失 {u[:50]}')
        n = norm(e['text'])
        if n and n not in comb: errs.append(f"{i}: 文字遺失 [{e['text'][:40]}]")
if errs:
    print(f'\n❌ 驗證失敗 {len(errs)}:'); [print(' ', x) for x in errs[:20]]; sys.exit(1)
print('\n✅ 零遺漏驗證通過（9 課切分；文字/連結/圖片全對應）')
