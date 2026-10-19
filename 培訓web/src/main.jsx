import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// 部署換版後，舊分頁再去載已被取代的頁面檔（chunk）會失敗。
// 自動重新整理一次拿最新版；用 sessionStorage 記錄，避免新版本也載不到時無限重整。
const RELOAD_FLAG = 'chunk-reload-at'
window.addEventListener('vite:preloadError', (event) => {
  // 斷網時重整只會換成瀏覽器的「無法連線」畫面；交給頁面的錯誤提示框，連線恢復後使用者再重試
  if (!navigator.onLine) return
  let alreadyReloaded = false
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_FLAG) || 0)
    alreadyReloaded = Date.now() - last < 60 * 1000
    if (!alreadyReloaded) window.sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
  } catch {
    // sessionStorage 不可用（隱私模式等）時寧可不重整，也不要冒無限重整的風險
    alreadyReloaded = true
  }
  if (alreadyReloaded) return
  event.preventDefault()
  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
