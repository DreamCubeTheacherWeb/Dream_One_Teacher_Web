/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // Bauhaus 設計系統 token（全站唯一色彩來源，見 DESIGN.md）
      colors: {
        bauhaus: {
          red: '#D02020',
          blue: '#1040C0',
          yellow: '#F0C020',
          black: '#121212',
          paper: '#F0F0F0',   // 全站底色
          muted: '#E0E0E0',
          cream: '#FFF9C4',   // 展開內容／提示底
        },
      },
      fontFamily: {
        // Outfit 管英數（幾何無襯線），Noto Sans TC 管中文（有 900 重量）
        sans: ['Outfit', 'Noto Sans TC', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // 硬陰影（無模糊、純位移）＝ Bauhaus 層疊語言；禁用 shadow-sm/md/lg 等柔陰影
        'hard-sm': '3px 3px 0px 0px #121212',
        'hard': '4px 4px 0px 0px #121212',
        'hard-md': '6px 6px 0px 0px #121212',
        'hard-lg': '8px 8px 0px 0px #121212',
        'hard-white': '4px 4px 0px 0px #FFFFFF', // 深底色區塊上用
      },
    },
  },
  plugins: [],
}
