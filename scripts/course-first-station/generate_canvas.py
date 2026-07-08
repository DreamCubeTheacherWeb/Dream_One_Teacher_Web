#!/usr/bin/env python3
# 畫布復刻生成器 v2：measured.json（原頁幾何）→ 8 課的畫布 contents rows
# v2 修正：課首深灰標題帶、按鈕底色像素取樣、L2 圖直連原圖、16 虛線佔位框、清單標記
import json, re, html as H, unicodedata, os, sys
from urllib.parse import unquote
from PIL import Image

SCRATCH = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(f'{SCRATCH}/measured.json'))
ELS = M['els']
MASTHEAD_URL = open(f'{SCRATCH}/masthead-url.txt').read().strip()   # 尺寸參數含在簽名裡，原樣使用
PLACEHOLDERS = json.load(open(f'{SCRATCH}/placeholders.json'))
SHOT = Image.open(f'{SCRATCH}/shots/source-full.png').convert('RGB')

X0, X1 = 123.0, 1277.0
S = 960.0 / (X1 - X0)
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
     boundary('h2', '突發狀況處理'), boundary('h1', '教你怎麼教')]
ranges = [(1, B[0]), (B[0], B[1]), (B[1], B[2]), (B[2], B[3]),
          (B[3], B[4]), (B[4], B[5]), (B[5], B[6]), (B[6], len(ELS))]

LMETA = [
 ('2130970d-db5e-4213-9c5b-d2d2e37a3e89', '歡迎來到夢想一號', True),
 ('28f64e02-b805-4e90-92c1-25d0213987cd', '執行長的話與行政團隊', False),
 ('3e050b7d-7c73-4fc3-8953-2f41faa2d883', '三大講師群組', False),
 ('fa8ed1ab-bd92-454c-b0c9-8d6cfe480964', '課程 SOP — 課前到課後', True),
 ('f6b432ca-aefc-4d17-a9e0-0a2be914e901', '教學關鍵與課程框架', True),
 ('f2f7eea5-2410-4c3e-a3da-47854b5946a6', '溝通方式與班級經營', True),
 ('f457f5d6-6e73-4a7c-9068-cf6027bb7308', '突發狀況處理 SOP', True),
 ('e85d3c6d-faa2-46e5-a9b3-f567de5af046', '教學影片資源與下一站', True),
]

# ── 圖片對應 ──
cur = json.load(open(f'{SCRATCH}/contents-current.json'))
path_of = {c['id'][:8]: c['video_url'] for c in cur if c.get('video_url')}
IMG_PATHS = [path_of[k] for k in ['2e1cdb26', '4cea9729', '0e245851', 'c26d7bab',
             '50042370', '251d1b47', 'dd2f5fb6', '62ea20f7',
             'a8201c46', '9c31d5fa', '538a5837', 'a1771c1c', '6e7aabfa']]
imgs_sorted = sorted([i for i, e in enumerate(ELS) if e['kind'] == 'img'],
                     key=lambda i: (ELS[i]['box']['y'], ELS[i]['box']['x']))
assert len(imgs_sorted) == 13
IMG_MAP = dict(zip(imgs_sorted, IMG_PATHS))
HOTLINK_IMGS = {imgs_sorted[-1]}   # 最後一張（LINE 群組總覽圖）：6 月上傳版裁錯，直連原圖

BANDS = [(1425, 1543), (2465, 2584), (3688, 3807), (4663, 4781),
         (6523, 6642), (14998, 15116), (16844, 16962)]
# 每條帶屬於「帶後第一個元素」所在的課（課首標題帶會跟著標題進該課）
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
    """從整頁截圖取按鈕底色（左右內緣中線兩點一致且非白才算）"""
    b = e['box']
    pts = [(int(b['x'] + 8), int(b['y'] + b['h'] / 2)),
           (int(b['x'] + b['w'] - 8), int(b['y'] + b['h'] / 2))]
    cols = [SHOT.getpixel(p) for p in pts if 0 <= p[0] < SHOT.size[0] and 0 <= p[1] < SHOT.size[1]]
    if len(cols) < 2: return None
    (r1, g1, b1), (r2, g2, b2) = cols
    if abs(r1-r2) + abs(g1-g2) + abs(b1-b2) > 40: return None
    if r1 + g1 + b1 > 700: return None   # 近白 → 不是實心按鈕
    return f'rgb({r1},{g1},{b1})'

def runs_html(runs):
    parts, buf, cursty = [], [], None
    def flush():
        if buf and cursty is not None:
            text = H.escape(''.join(buf))
            fs, color, bold, italic, href = cursty
            style = f'font-size:{max(11, round(fs * S))}px;color:{color};'
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
    fs = max(11, round(max((r.get('fs', 16) for r in e['runs'] if r.get('t', '').strip()), default=15) * S))
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

rows_by_lesson, report = {}, []
for li, ((a, b), (lid, ltitle, hw)) in enumerate(zip(ranges, LMETA)):
    els = [(i, ELS[i]) for i in range(a, b)]
    els = [(i, e) for i, e in els if '建議使用電腦檢視' not in e.get('text', '')]
    my_bands = [bd for bd, who in BAND_LESSON.items() if who == li]
    items = []

    if li == 0:
        mast_h = round(340 * VS)
        items.append((0, 0, 0, 960, mast_h, {
            'type': 'article', 'title': '橫幅',
            'body': f'<img src="{MASTHEAD_URL}" alt="橫幅" style="width:100%;height:100%;object-fit:cover;">',
            'pd': {}}))
        items.append((5, 160, round((219 - 64) * VS) - 6,
                      640, round(85 * VS) + 20, {
            'type': 'article', 'title': '標題',
            'body': '<div style="text-align:center;white-space:nowrap;"><span style="font-size:58px;color:#ffffff;font-weight:300;">魔術方塊老師第一站</span></div>',
            'pd': {}}))
        y_src0, y_off = 404.0, mast_h + 8
    else:
        y_min_els = min(e['box']['y'] for _, e in els)
        head_bands = [bd for bd in my_bands if bd[0] < y_min_els]
        y_src0 = min([y_min_els - 20] + [bd[0] - 6 for bd in head_bands])
        y_off = 16

    def Y(y): return round((y - y_src0) * S) + y_off

    for b0, b1 in my_bands:
        items.append((1, 0, Y(b0), 960, round((b1 - b0) * S), {
            'type': 'article', 'title': '分隔帶',
            'body': '', 'pd': {'shapeType': 'rect', 'fillColor': 'rgb(50,50,50)',
                               'borderWidth': 0, 'borderColor': 'rgb(50,50,50)'}}))

    if li == 7:   # 16 個虛線佔位框（原頁本來就是空的示意格）
        for ph in PLACEHOLDERS:
            items.append((8, round((ph['x'] - X0) * S), Y(ph['y']),
                          round(ph['w'] * S), round(ph['h'] * S), {
                'type': 'article', 'title': '佔位框',
                'body': '<div style="position:absolute;inset:4px;border:3px dashed #dadce0;border-radius:12px;"></div>',
                'pd': {}}))

    for i, e in els:
        bx = e['box']
        if e['kind'] == 'img':
            if i in HOTLINK_IMGS:
                # 原始網址綁登入態（ORB 擋）→ 從原頁截圖裁下，以 data URI 內嵌
                import base64, io
                crop = SHOT.crop((int(bx['x']), int(bx['y']),
                                  int(bx['x'] + bx['w']), int(bx['y'] + bx['h'])))
                buf = io.BytesIO(); crop.save(buf, 'JPEG', quality=84)
                b64 = base64.b64encode(buf.getvalue()).decode()
                items.append((10, round((bx['x'] - X0) * S), Y(bx['y']),
                              round(bx['w'] * S), round(bx['h'] * S), {
                    'type': 'article', 'title': '圖片',
                    'body': f'<img src="data:image/jpeg;base64,{b64}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;">',
                    'pd': {}}))
            else:
                items.append((10, round((bx['x'] - X0) * S), Y(bx['y']),
                              round(bx['w'] * S), round(bx['h'] * S), {
                    'type': 'image_text', 'title': '圖片',
                    'body': json.dumps({'caption': ''}), 'video': IMG_MAP[i], 'pd': {}}))
        elif is_button(e):
            st = e.get('btnStyle')
            fill = (st and st['bg']) or sample_bg(e)
            if fill:
                href = unwrap(next(r['href'] for r in e['runs'] if r.get('href')))
                tcolor = next((r.get('color', '#fff') for r in e['runs'] if r.get('t', '').strip()), '#fff')
                rad = re.match(r'([\d.]+)', (st and st.get('radius')) or '8')
                items.append((20, round((bx['x'] - X0) * S), Y(bx['y']),
                              round(bx['w'] * S), max(30, round(bx['h'] * S)), {
                    'type': 'article', 'title': e['text'][:20],
                    'body': e['text'],
                    'pd': {'shapeType': 'button', 'fillColor': fill, 'textColor': tcolor,
                           'borderRadius': float(rad.group(1)) if rad else 8,
                           'borderWidth': 0, 'linkUrl': href}}))
                continue
            # 取不到底色 → 當一般文字框（維持行內連結）
            body = f'<div style="text-align:{e["align"]};line-height:1.45;">{marker_html(e)}{runs_html(e["runs"])}</div>'
            items.append((15, round((bx['x'] - X0) * S) - 12, Y(bx['y']) - 12,
                          round(bx['w'] * S) + 24, round(bx['h'] * S) + 34, {
                'type': 'article', 'title': '文字框', 'body': body, 'pd': {}}))
        else:
            gut = 22 if e.get('marker') else 0
            body = f'<div style="text-align:{e["align"]};line-height:1.45;">{marker_html(e)}{runs_html(e["runs"])}</div>'
            hbuf = max(10, round(bx['h'] * S * 0.10))
            items.append((15, round((bx['x'] - X0 - gut) * S) - 12, Y(bx['y']) - 12,
                          round((bx['w'] + gut) * S) + 24, round(bx['h'] * S) + 24 + hbuf, {
                'type': 'article', 'title': '文字框', 'body': body, 'pd': {}}))

    if hw:
        y_hw = max(it[2] + it[4] for it in items) + 30
        HWTXT = {
         0: ('自我介紹（文字作業，100–200 字）', ['你是誰、目前的身分', '你和魔術方塊的淵源（會哪些方塊、玩多久）', '為什麼想成為魔術方塊老師']),
         3: ('SOP 流程默寫（文字作業）', ['不回看內容，依序寫出課前→授課當天→課中→課後你會做的事（每階段至少 3 項）', '寫完回頭對照本課內容，補上遺漏並標注「補」']),
         4: ('八步驟教案設計（文字作業）', ['以「三階小花」或你最熟的環節為主題', '用課程框架八步驟寫 15–20 分鐘教學流程', '每步驟寫出你會說的一句話或會做的一件事']),
         5: ('三明治回饋演練（文字作業）', ['情境：學生轉三階小花，第三片花瓣一直放不上去，開始不耐煩', '寫出你會說的一段話：好→指正→好', '另自選一條班級規則，寫出「包裝過」的說法']),
         6: ('突發狀況情境題（文字作業）', ['任選兩種突發狀況（如學生受傷、打架）', '各寫出處理步驟：第一步做什麼、向誰回報、對家長／單位怎麼說']),
         7: ('第一站學習心得（文字作業，150–300 字）', ['印象最深的一個觀念與原因', '最想先教的一顆方塊與原因', '對正式講師培訓的意願與疑問（完成後記得到個人群組 Tag 懶懶申請檢核表單）']),
        }[li]
        lis = ''.join(f'<li style="margin:3px 0;">{t}</li>' for t in HWTXT[1])
        hw_h = 120 + 30 * len(HWTXT[1])
        items.append((30, 33, y_hw, 894, hw_h, {
            'type': 'article', 'title': '本課作業',
            'body': (f'<div style="background:#fff7ed;border:2px solid #fdba74;border-radius:14px;padding:14px 18px;">'
                     f'<span style="font-size:16px;font-weight:800;">📝 本課作業｜{HWTXT[0]}</span>'
                     f'<ol style="list-style:decimal;padding-left:1.3em;margin-top:6px;font-size:13px;">{lis}</ol>'
                     f'<span style="font-size:13px;color:#9a3412;font-weight:700;">完成後請在本頁最下方的作業區送出。</span></div>'),
            'pd': {}}))

    items.sort(key=lambda it: (it[0], it[2], it[1]))
    rows = []
    for order, (z, x, y, w, h, p) in enumerate(items):
        pd = {'x': max(0, x), 'y': max(0, y), 'width': min(960, w), 'height': h, 'opacity': 1}
        pd.update(p['pd'])
        rows.append({'lesson_id': lid, 'type': p['type'], 'title': p['title'],
                     'order': order, 'status': 'published', 'position_data': pd,
                     'body': p['body'], 'video_url': p.get('video')})
    rows_by_lesson[lid] = rows
    ymax = max(it[2] + it[4] for it in items)
    report.append(f'{ltitle}: {len(rows)} 區塊, 畫布高 {ymax}px, 元素 {a}-{b}, 標題帶 {len(my_bands)}')

all_rows = [r for rows in rows_by_lesson.values() for r in rows]
json.dump(all_rows, open(f'{SCRATCH}/canvas-contents.json', 'w'), ensure_ascii=False, indent=1)
print(f'共 {len(all_rows)} rows → canvas-contents.json')
print('\n'.join(report))

# ── 零遺漏驗證 ──
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
nbtn = sum(1 for r in all_rows if (r['position_data'] or {}).get('shapeType') == 'button')
print(f'\n✅ 零遺漏驗證通過; 按鈕 {nbtn} 顆; 佔位框 16; 標題帶配置見上')
