#!/usr/bin/env python3
# v2: 直接從原始頁元素流(source-stream.json)重建 8 課內容（非 6 月刪節版）
import json, re, html as H, sys, os, unicodedata

SCRATCH = os.path.dirname(os.path.abspath(__file__))
PB = 'https://mnovjlicwzwkefkhstte.supabase.co/storage/v1/object/public/content-images/'

S = json.load(open(f'{SCRATCH}/source-stream.json'))
cur = json.load(open(f'{SCRATCH}/contents-current.json'))
path_of = {c['id'][:8]: c['video_url'] for c in cur if c.get('video_url')}

# 原始頁圖片(依 DOM 順序) → Supabase storage path（6 月已上傳）
IMGMAP = {1: path_of['2e1cdb26'],   # 首圖橫幅
          8: path_of['4cea9729'],   # 歡迎照
          14: path_of['0e245851'],  # 願景與使命圖
          16: path_of['c26d7bab'],  # 執行長照
          23: path_of['50042370'], 27: path_of['251d1b47'], 31: path_of['dd2f5fb6'],
          35: path_of['62ea20f7'], 39: path_of['a8201c46'], 43: path_of['9c31d5fa'],
          47: path_of['538a5837'], 51: path_of['a1771c1c'],  # 團隊 8 人
          56: path_of['6e7aabfa']}  # 群組總覽圖

MINIHEAD = {74, 78, 80, 82, 86, 89, 92, 94, 97, 100, 113, 115, 120,
            235, 239, 240, 243, 245, 257, 272}
ULSETS = [(4, 7), (75, 77), (84, 85), (90, 91), (98, 99), (103, 104), (106, 106),
          (108, 110), (116, 119), (130, 133), (188, 190), (198, 200),
          (236, 238), (258, 259), (263, 265), (273, 279)]
OLSETS = [(165, 171)]
def in_ranges(i, ranges):
    return any(a <= i <= b for a, b in ranges)

def render_el(i):
    el = S[i]
    h, t = el['html'], el['text']
    if el['k'] in ('h1', 'h2', 'h3'):
        return f'<h3 style="font-size:1.3em;font-weight:800;margin:18px 0 8px;">{h}</h3>'
    if i in MINIHEAD or (el.get('bold') and len(t) <= 22):
        return f'<p style="font-weight:800;font-size:1.08em;margin:14px 0 4px;">{h}</p>'
    if in_ranges(i, ULSETS) or in_ranges(i, OLSETS):
        return f'<li style="margin:4px 0;line-height:1.7;">{h}</li>'
    if t.startswith('「') or t.startswith('｜'):
        return (f'<p style="border-left:4px solid #93c5fd;background:#f0f7ff;padding:8px 12px;'
                f'border-radius:0 8px 8px 0;margin:8px 0;line-height:1.75;">{h}</p>')
    return f'<p style="margin:8px 0;line-height:1.75;">{h}</p>'

def els(a, b=None):
    b = a if b is None else b
    out, i = [], a
    while i <= b:
        if S[i]['k'] == 'img':
            i += 1; continue
        if in_ranges(i, ULSETS) or in_ranges(i, OLSETS):
            tag = 'ol' if in_ranges(i, OLSETS) else 'ul'
            items = []
            while i <= b and (in_ranges(i, ULSETS) or in_ranges(i, OLSETS)):
                items.append(render_el(i)); i += 1
            style = 'list-style:decimal' if tag == 'ol' else 'list-style:disc'
            out.append(f'<{tag} style="{style};padding-left:1.5em;margin:8px 0;">{"".join(items)}</{tag}>')
            continue
        out.append(render_el(i)); i += 1
    return '\n'.join(out)

def img(idx, maxw=520, alt=''):
    return (f'<p style="text-align:center;margin:16px 0;"><img src="{PB}{IMGMAP[idx]}" alt="{alt}" '
            f'style="width:100%;max-width:{maxw}px;border-radius:16px;display:inline-block;"></p>')

def btn(label, url, color='#2563eb'):
    return (f'<a href="{url}" target="_blank" rel="noopener" '
            f'style="display:inline-block;background:{color};color:#ffffff;font-weight:700;'
            f'padding:10px 20px;border-radius:12px;text-decoration:none;margin:6px 10px 6px 0;">{label}</a>')

def btns(pairs, color='#2563eb'):
    return '<div style="margin-top:10px;">' + ''.join(btn(l, u, color) for l, u in pairs) + '</div>'

def unwrap(u):
    m = re.search(r'[?&]q=(https?[^&]+)', u)
    if m:
        from urllib.parse import unquote
        return unquote(m.group(1))
    return u

def link_of(i, n=0):
    return unwrap(S[i]['links'][n])

def hw(title_html, items, note=''):
    lis = ''.join(f'<li style="margin:4px 0;">{i}</li>' for i in items)
    extra = f'<p style="margin-top:10px;">{note}</p>' if note else ''
    return (f'<div style="background:#fff7ed;border:2px solid #fdba74;border-radius:16px;padding:20px 24px;">'
            f'<p style="font-weight:800;font-size:1.05em;margin-bottom:8px;">{title_html}</p>'
            f'<ol style="list-style:decimal;padding-left:1.4em;">{lis}</ol>{extra}'
            f'<p style="margin-top:12px;color:#9a3412;font-weight:700;">完成後請在本頁最下方的作業區送出。</p></div>')

def member(imgidx, a, b, name):
    return (f'<div style="flex:1 1 200px;max-width:230px;background:#f8fafc;border:1px solid #e2e8f0;'
            f'border-radius:16px;padding:14px;text-align:center;">'
            f'<img src="{PB}{IMGMAP[imgidx]}" alt="{name}" style="width:100%;border-radius:12px;margin-bottom:10px;">'
            + els(a, b) + '</div>')

# ═══ 8 課配方 ═══
LESSONS = [
 {'id': '2130970d-db5e-4213-9c5b-d2d2e37a3e89', 'title': '歡迎來到夢想一號', 'hw': True,
  'blocks': [
   ('image_text', '魔術方塊老師第一站', 1),
   ('article', '第一站，從這裡開始', els(2, 7) + img(8, 460, '夢想一號')),
   ('article', '夢想一號願景與使命', els(9, 13) + img(14, 560, '願景與使命')
      + btns([('願景簡報完整版', link_of(15))])),
   ('article', '📝 本課作業｜自我介紹', hw('自我介紹（文字作業，100–200 字）', [
      '你是誰、目前的身分（學生／上班族／其他）',
      '你和魔術方塊的淵源（會哪些方塊、玩多久了）',
      '為什麼想成為魔術方塊老師'])),
  ]},
 {'id': '28f64e02-b805-4e90-92c1-25d0213987cd', 'title': '執行長的話與行政團隊', 'hw': False,
  'blocks': [
   ('article', '執行長的話', img(16, 300, '李孟一 執行長') + els(17, 21)),
   ('article', '行政團隊 — 你日後的隊友',
      '<p style="margin:8px 0;line-height:1.75;">未來無論教學問題、課程派發、報帳薪資、講義疑問，都會接觸到這些人。先記得他們是誰、負責什麼、棲息地在哪，日後求助才知道找誰。</p>'
      + '<div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:12px;">'
      + member(23, 24, 26, '蔡宜津') + member(27, 28, 30, '王偉安')
      + member(31, 32, 34, '余芳儒') + member(35, 36, 38, '廖思明')
      + member(39, 40, 42, '侯宥圻') + member(43, 44, 46, '蕭彥平')
      + member(47, 48, 50, 'Judy') + member(51, 52, 54, '李孟家') + '</div>'),
  ]},
 {'id': '3e050b7d-7c73-4fc3-8953-2f41faa2d883', 'title': '三大講師群組', 'hw': False,
  'blocks': [
   ('image_text', '三大群組總覽', 56),
   ('article', '每位講師皆會有至少三個群組', els(57, 58)),
   ('article', '夢想一號講師俱樂部（大群）', els(59, 60)
      + btns([('點此加入群組', link_of(61))], '#16a34a')),
   ('article', '夢想一號地區群組', els(62, 63)
      + btns([('北北基桃地區群', link_of(64)), ('新竹地區群', link_of(65)),
              ('中部地區群', link_of(66)), ('南部地區群', link_of(67))], '#16a34a')
      + els(68, 69)),
  ]},
 {'id': 'fa8ed1ab-bd92-454c-b0c9-8d6cfe480964', 'title': '課程 SOP — 課前到課後', 'hw': True,
  'blocks': [
   ('article', '課程 SOP 總覽與課前準備', els(71, 87)),
   ('article', '授課當天', els(88, 95)),
   ('article', '課中', els(96, 111)),
   ('article', '課後與課程報酬', els(112, 125)),
   ('article', '📝 本課作業｜SOP 流程默寫', hw('SOP 流程默寫（文字作業）', [
      '先不要回頭看內容，依序寫出「課前 → 授課當天 → 課中 → 課後」四個階段你會做的事，每階段至少 3 項',
      '寫完後回頭對照本課內容，把遺漏的項目補上，並在補上的項目前標注「補」'])),
  ]},
 {'id': 'f6b432ca-aefc-4d17-a9e0-0a2be914e901', 'title': '教學關鍵與課程框架', 'hw': True,
  'blocks': [
   ('article', '魔術方塊教學通識課', els(126, 134)),
   ('article', '教學關鍵一：目標明確', els(135, 136) + els(137, 142)),
   ('article', '教學關鍵二：指令清楚', els(143, 155)),
   ('article', '教學關鍵三：基礎自信', els(156, 158)),
   ('article', '課程框架 — 好框架與欠佳框架', els(159, 163)),
   ('article', '課程框架八步驟', els(164, 173)),
   ('article', '八步驟逐步詳解', els(174, 195)),
   ('article', '常見問題與提醒', els(196, 206)),
   ('article', '📝 本課作業｜八步驟教案設計', hw('八步驟教案設計（文字作業）', [
      '以「三階小花」（或你最熟悉方塊的第一個環節）為主題',
      '用課程框架八步驟寫出一份 15–20 分鐘的教學流程',
      '每個步驟寫出你「會說的一句話」或「會做的一件事」'])),
  ]},
 {'id': 'f2f7eea5-2410-4c3e-a3da-47854b5946a6', 'title': '溝通方式與班級經營', 'hw': True,
  'blocks': [
   ('article', '溝通方式', els(207, 208)),
   ('article', '鼓勵稱讚', els(209, 210)),
   ('article', '學生沒有轉錯任何東西', els(211, 215)),
   ('article', '三明治技巧：好＋指正＋好', els(216, 225)),
   ('article', '班級經營的本質', els(226, 231)),
   ('article', '班級秩序：把規則包裝起來', els(232, 248)),
   ('article', '程度落差怎麼帶', els(249, 269)),
   ('article', '剩餘時間 — 活動與小遊戲', els(270, 279)),
   ('article', '📝 本課作業｜三明治回饋演練', hw('三明治回饋演練（文字作業）', [
      '情境：學生小宇轉三階小花，第三片花瓣一直放不上去，開始不耐煩',
      '寫出你會對他說的一段話，需包含：鼓勵（好）→ 指正（具體指出問題）→ 鼓勵（好）',
      '另外自選一條班級規則，寫出「包裝過」的說法'])),
  ]},
 {'id': 'f457f5d6-6e73-4a7c-9068-cf6027bb7308', 'title': '突發狀況處理 SOP', 'hw': True,
  'blocks': [
   ('article', '五種常見突發狀況',
      '<p style="margin:8px 0;line-height:1.75;">意外總會發生，第一時間用最簡單的 SOP 應對，避免不必要的爭議。原則：有疑問就回報課程負責人／家長／合作單位老師，不要自己決定。</p>'
      + els(280, 290)),
   ('article', '📝 本課作業｜突發狀況情境題', hw('突發狀況情境題（文字作業）', [
      '從本課的五種突發狀況中任選兩個（例如：學生受傷、學生打架）',
      '各寫出你在現場的處理步驟：第一步做什麼、向誰回報、對家長或合作單位怎麼說'])),
  ]},
 {'id': 'e85d3c6d-faa2-46e5-a9b3-f567de5af046', 'title': '教學影片資源與下一站', 'hw': True,
  'blocks': [
   ('article', '教你怎麼教｜教學影片資源', els(291, 292)
      + '<p style="font-weight:800;font-size:1.08em;margin:14px 0 4px;">基礎方塊</p>'
      + btns([('楓葉魔術方塊', link_of(293)),
              ('金字塔《學怎麼轉》', link_of(294, 0)), ('金字塔《學怎麼教》', link_of(294, 1)),
              ('恐龍魔術方塊', link_of(295)),
              ('2x2x2《學怎麼轉》', link_of(296, 0)), ('2x2x2《學怎麼教》', link_of(296, 1))], '#dc2626')
      + '<p style="font-weight:800;font-size:1.08em;margin:14px 0 4px;">進階／高階方塊</p>'
      + btns([('3x3x3《學怎麼轉》', link_of(297, 0)), ('3x3x3《學怎麼教》', link_of(297, 1)),
              ('2x2x3 魔術方塊', link_of(298)), ('2x3x3 魔術方塊', link_of(299)),
              ('1x3x3 魔術方塊', link_of(300)), ('4x4x4 魔術方塊', link_of(301)),
              ('三階鏡面魔術方塊', link_of(302)), ('三階風火輪魔術方塊', link_of(303)),
              ('二階金字塔魔術方塊', link_of(304)), ('二階鏡面魔術方塊', link_of(305)),
              ('入門速解', link_of(306))], '#dc2626')
      + '<p style="margin:8px 0;line-height:1.75;">入門速解：進入表單選擇「目前還沒有想申請，但有興趣想成為速解講師」，即可看到。</p>'
      + els(307, 308)),
   ('article', '下一站：檢核與通過標準', els(309, 310)),
   ('article', '講師等級制度', els(311, 311)),
   ('article', '正式講師培訓 — 限時免費', els(312, 312) + els(315, 320)),
   ('article', '如何申請', els(313, 314) + els(321, 322)),
   ('article', '📝 本課作業｜第一站學習心得', hw('第一站學習心得（文字作業，150–300 字）', [
      '這一站印象最深的一個觀念是什麼？為什麼？',
      '你最想先教的一顆方塊是哪顆？原因？',
      '對「正式講師培訓」有沒有意願？有什麼疑問？'],
      '提醒：完成本站後，記得到講師個人群組 Tag 懶懶，申請檢核表單（需達 70 分）。')),
  ]},
]

# ═══ 組裝輸出 ═══
rows = []
for L in LESSONS:
    for order, blk in enumerate(L['blocks']):
        if blk[0] == 'image_text':
            rows.append({'lesson_id': L['id'], 'type': 'image_text', 'title': blk[1],
                         'order': order, 'status': 'published', 'position_data': None,
                         'body': json.dumps({'caption': ''}), 'video_url': IMGMAP[blk[2]]})
        else:
            rows.append({'lesson_id': L['id'], 'type': 'article', 'title': blk[1],
                         'order': order, 'status': 'published', 'position_data': None,
                         'body': blk[2], 'video_url': None})

# ═══ 零遺漏驗證（對原始頁 324 元素逐一檢查）═══
def norm(t):
    t = unicodedata.normalize('NFKC', H.unescape(t or ''))
    t = re.sub(r'\s+', '', t)
    return re.sub(r'[，。、：；！？「」『』（）()\[\],.:;!?~‧・…—\-＋+＊*〈〉<>《》%％｜|^]', '', t).lower()

titles = ''.join(L['title'] for L in LESSONS) + ''.join(r['title'] for r in rows)
combined_html = ''.join((r['body'] or '') + (r['video_url'] or '') for r in rows)
combined = norm(re.sub(r'<[^>]+>', ' ', combined_html)) + norm(titles)

DROPS = {0, 22, 55, 70, 323}   # 頁首H1/行政團隊H1(卡片標題有)/講師群組H1/良好課程關鍵H1/頁尾
BTN_ELS = {15, 61, 64, 65, 66, 67, 293, 294, 295, 296, 297, 298, 299, 300, 301, 302, 303, 304, 305, 306}
errors = []
for i, el in enumerate(S):
    if i in DROPS:
        continue
    if el['k'] == 'img':
        if i in IMGMAP and IMGMAP[i] not in combined_html:
            errors.append(f'{i}: 圖片遺失 {IMGMAP[i][-30:]}')
        elif i not in IMGMAP:
            errors.append(f'{i}: 圖片沒有對應的 storage 路徑')
        continue
    if i in BTN_ELS:
        for u in el['links']:
            uu = u
            m = re.search(r'[?&]q=(https?[^&]+)', u)
            if m:
                from urllib.parse import unquote
                uu = unquote(m.group(1))
            if uu not in combined_html:
                errors.append(f'{i}: 按鈕連結遺失 {uu[:60]}')
        continue
    n = norm(el['text'])
    if n and n not in combined:
        errors.append(f"{i}: 內文遺失 [{el['text'][:45]}…]")

json.dump(rows, open(f'{SCRATCH}/new-contents-v2.json', 'w'), ensure_ascii=False, indent=1)
total_chars = sum(len(r['body'] or '') for r in rows)
print(f'組裝完成：{len(rows)} 區塊，HTML 共 {total_chars:,} 字元 → new-contents-v2.json')
for L in LESSONS:
    n = sum(1 for r in rows if r['lesson_id'] == L['id'])
    print(f"  {L['title']}: {n} 區塊, 作業={'要' if L['hw'] else '不要'}")
if errors:
    print(f'\n❌ 零遺漏驗證失敗 {len(errors)} 項：')
    [print('  ' + e) for e in errors]
    sys.exit(1)
print('\n✅ 零遺漏驗證通過：原始頁 324 個元素（扣除頁首尾導覽）全數進入新版')
