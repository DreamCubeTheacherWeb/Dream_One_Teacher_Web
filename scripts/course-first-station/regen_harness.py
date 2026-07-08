#!/usr/bin/env python3
# 依 canvas-contents.json 產生與前台 CanvasViewer 同構的預覽頁
import json, html as H, os
SCRATCH = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(f'{SCRATCH}/canvas-contents.json'))
PB = 'https://mnovjlicwzwkefkhstte.supabase.co/storage/v1/object/public/content-images/'
LIDS = ['2130970d-db5e-4213-9c5b-d2d2e37a3e89','28f64e02-b805-4e90-92c1-25d0213987cd',
        '3e050b7d-7c73-4fc3-8953-2f41faa2d883','fa8ed1ab-bd92-454c-b0c9-8d6cfe480964',
        'f6b432ca-aefc-4d17-a9e0-0a2be914e901','f2f7eea5-2410-4c3e-a3da-47854b5946a6',
        'f457f5d6-6e73-4a7c-9068-cf6027bb7308','e85d3c6d-faa2-46e5-a9b3-f567de5af046']
CSS = '''
.canvas-text-view h1{font-size:2em;font-weight:800;margin:.3em 0}
.canvas-text-view h2{font-size:1.5em;font-weight:700;margin:.3em 0}
.canvas-text-view h3{font-size:1.25em;font-weight:700;margin:.2em 0}
.canvas-text-view p{margin:.3em 0}
.canvas-text-view ul,.canvas-text-view ol{padding-left:1.5em!important;margin:.3em 0}
.canvas-text-view img{max-width:100%;border-radius:8px}
.canvas-text-view a{color:#2563eb;text-decoration:underline;text-underline-offset:2px}
'''
for n, lid in enumerate(LIDS):
    items = sorted([r for r in rows if r['lesson_id'] == lid], key=lambda r: r['order'])
    ch = max((r['position_data']['y'] + r['position_data']['height']) for r in items) + 20
    divs = []
    for it in items:
        pd = it['position_data']
        base = (f"position:absolute;left:{pd['x']}px;top:{pd['y']}px;width:{pd['width']}px;"
                f"height:{pd['height']}px;opacity:{pd.get('opacity',1)};")
        st = pd.get('shapeType')
        if st == 'rect':
            divs.append(f'<div style="{base}background:{pd.get("fillColor","#000")};"></div>')
        elif st == 'button':
            a0 = f'<a href="{H.escape(pd.get("linkUrl",""))}" target="_blank" style="display:block;width:100%;height:100%;text-decoration:none;">'
            divs.append(f'<div style="{base}">{a0}<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;'
                        f'background:{pd.get("fillColor","#3b82f6")};border-radius:{pd.get("borderRadius",8)}px;">'
                        f'<span style="color:{pd.get("textColor","#fff")};font-size:16px;font-weight:700;text-align:center;padding:0 8px;">{H.escape(it["body"] or "按鈕")}</span></div></a></div>')
        elif it['type'] == 'image_text':
            divs.append(f'<div style="{base}"><img src="{PB}{it["video_url"]}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;"></div>')
        else:
            divs.append(f'<div class="canvas-text-view" style="{base}overflow:auto;font-size:16px;line-height:1.6;word-break:break-word;padding:12px;">{it["body"]}</div>')
    page = (f'<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{{margin:0;background:#f8fafc}}{CSS}</style></head><body>'
            f'<div style="width:960px;margin:0 auto;"><div style="position:relative;width:960px;height:{ch}px;background:#fff;'
            f'box-shadow:0 4px 12px rgba(0,0,0,.1);">{"".join(divs)}</div></div></body></html>')
    open(f'{SCRATCH}/preview/canvas{n}.html', 'w').write(page)
    print(f'canvas{n}.html {len(items)} items h={ch}')
