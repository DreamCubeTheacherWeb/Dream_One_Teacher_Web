import net from 'node:net';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 跟作業系統要一個當下沒人用的 port（綁 0 再放掉）
export const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

export async function waitForHttp(url, { timeoutMs = 30000, okStatuses } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (!okStatuses || okStatuses.includes(res.status)) return res.status;
      lastError = new Error(`status ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError?.message}`);
}

// 結果收集器：每個斷言印一行 PASS／FAIL／BLOCKED
export class Results {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.items = [];
  }

  check(name, condition, detail = '') {
    const ok = Boolean(condition);
    this.items.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${this.prefix}${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  }

  blocked(name, detail = '') {
    this.items.push({ name, status: 'BLOCKED', detail });
    console.log(`BLOCKED  ${this.prefix}${name}${detail ? ` — ${detail}` : ''}`);
  }

  // 已知問題：app／SQL 的 bug 或產品缺口，測試用替代路徑繼續；不算 FAIL，但每次都會印出來
  known(name, detail = '') {
    if (this.items.some((item) => item.status === 'KNOWN' && item.name === name)) return;
    this.items.push({ name, status: 'KNOWN', detail });
    console.log(`KNOWN-ISSUE  ${this.prefix}${name}${detail ? ` — ${detail}` : ''}`);
  }

  note(text) {
    console.log(`NOTE  ${this.prefix}${text}`);
  }

  counts() {
    const out = { PASS: 0, FAIL: 0, BLOCKED: 0, KNOWN: 0 };
    for (const item of this.items) out[item.status] += 1;
    return out;
  }
}
