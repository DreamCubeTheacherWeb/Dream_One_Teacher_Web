// 量測 Google Sites 原始頁：每個內容元素的幾何/樣式/文字 runs，供畫布復刻
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const APP_DIR = '/Users/lazylazy/Desktop/夢想一號/Dream_One_Teacher_Web/培訓web';
const OUT_DIR = '/private/tmp/claude-501/-Users-lazylazy-Desktop------Dream-One-Teacher-Web/5fb3fe6d-dd7c-495b-846e-a72967f39504/scratchpad';
const URL = 'https://sites.google.com/dreamcube.tw/index/%E5%9F%B9%E8%A8%93%E6%96%87%E7%AB%A0%E5%BE%8C%E5%8F%B0/%E9%AD%94%E8%A1%93%E6%96%B9%E5%A1%8A%E8%80%81%E5%B8%AB%E7%AC%AC%E4%B8%80%E7%AB%99';

const { chromium } = await import(pathToFileURL(path.join(APP_DIR, 'node_modules', 'playwright-core', 'index.mjs')));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

// 捲到底再回頂，觸發 lazy load
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 600) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
});
await page.waitForTimeout(1500);

const data = await page.evaluate(() => {
  const secEls = [...document.querySelectorAll('section')];
  const docTop = document.documentElement.getBoundingClientRect().top;
  const abs = (r) => ({ x: r.left, y: r.top - docTop, w: r.width, h: r.height });

  // ── 區段背景帶 ──
  const sections = [];
  for (const sec of secEls) {
    const cs = getComputedStyle(sec);
    const r = sec.getBoundingClientRect();
    if (r.height < 10) continue;
    sections.push({ box: abs(r), bg: cs.backgroundColor,
      bgImage: cs.backgroundImage !== 'none' });
  }

  // ── 內容元素（葉層）──
  const cands = secEls.flatMap(s => [...s.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,img')]);
  const isLeaf = (el) => !cands.some(o => o !== el && el.contains(o) && o.tagName !== 'IMG');
  const out = [];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (el.tagName === 'IMG') {
      const raw = el.currentSrc || el.src || '';
      const src = raw.split('=')[0];
      if (!src.includes('googleusercontent')) continue;
      out.push({ kind: 'img', box: abs(r), src, rawSrc: raw });
      continue;
    }
    if (!isLeaf(el)) continue;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    // 文字 runs：逐 text node 抓 bold/href/字級/顏色
    const runs = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const t = node.textContent;
        if (!t) return;
        const p = node.parentElement;
        const pcs = getComputedStyle(p);
        const a = p.closest('a');
        runs.push({ t, bold: parseInt(pcs.fontWeight) >= 600,
          href: a ? a.href : null, fs: Math.round(parseFloat(pcs.fontSize)),
          color: pcs.color, italic: pcs.fontStyle === 'italic' });
        return;
      }
      if (node.nodeType === 1) {
        if (node.tagName === 'BR') { runs.push({ t: '\n', br: true }); return; }
        for (const c of node.childNodes) walk(c);
      }
    };
    for (const c of el.childNodes) walk(c);
    // 按鈕樣式（連結型元素找有背景的祖先）
    let btnStyle = null;
    const a = el.querySelector('a');
    if (a) {
      let n = a, depth = 0;
      while (n && depth < 4) {
        const ncs = getComputedStyle(n);
        if (ncs.backgroundColor && !ncs.backgroundColor.includes('0, 0, 0, 0')) {
          btnStyle = { bg: ncs.backgroundColor, color: getComputedStyle(a).color,
            radius: ncs.borderRadius, border: ncs.border };
          break;
        }
        n = n.parentElement; depth++;
      }
    }
    // 清單標記（原頁用 ul/ol 的 ::marker，innerText 抓不到）
    let marker = null;
    const li = el.closest('li');
    if (li) {
      const firstText = li.querySelector('h1,h2,h3,h4,h5,h6,p') || li;
      if (firstText === el || firstText === li) {
        const list = li.parentElement;
        const lis = [...list.children].filter(c => c.tagName === 'LI');
        const start = parseInt(list.getAttribute('start') || '1', 10) || 1;
        marker = { type: getComputedStyle(li).listStyleType,
                   idx: start + lis.indexOf(li), ordered: list.tagName === 'OL' };
      }
    }
    out.push({ kind: el.tagName.toLowerCase(), box: abs(r), text,
      align: cs.textAlign, marker, runs, btnStyle });
  }
  out.sort((p, q) => (p.box.y - q.box.y) || (p.box.x - q.box.x));
  const xs = out.filter(e => e.kind !== 'img').map(e => e.box.x);
  const rs = out.filter(e => e.kind !== 'img').map(e => e.box.x + e.box.w);
  const mainBox = { left: Math.min(...xs), right: Math.max(...rs) };
  return { sections, els: out, mainBox,
    pageH: document.body.scrollHeight, vw: window.innerWidth };
});

fs.writeFileSync(path.join(OUT_DIR, 'measured.json'), JSON.stringify(data, null, 1));
console.log(`elements: ${data.els.length}, sections: ${data.sections.length}, ` +
  `main: ${JSON.stringify(data.mainBox)}, pageH: ${data.pageH}`);

// 整頁截圖（比對基準）
await page.screenshot({ path: path.join(OUT_DIR, 'shots/source-full.png'), fullPage: true });
console.log('screenshot: shots/source-full.png');
await browser.close();
