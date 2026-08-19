# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /build

# 接收 Supabase 環境變數（Zeabur 在建置時注入）
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# 只複製前端建置所需檔案；根目錄 .dockerignore 也以 allowlist 限制上傳 context。
WORKDIR /build/培訓web
COPY 培訓web/package.json 培訓web/package-lock.json ./
RUN npm ci
COPY 培訓web/index.html 培訓web/vite.config.js 培訓web/postcss.config.js 培訓web/tailwind.config.js ./
COPY 培訓web/src ./src
COPY 培訓web/public ./public
RUN npm run build

# ── Stage 2: Serve ──────────────────────────────────────────
FROM nginx:alpine
COPY --from=builder /build/培訓web/dist /usr/share/nginx/html

# React Router 需要 fallback 到 index.html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  index index.html;\n  add_header X-Content-Type-Options "nosniff" always;\n  add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;\n  add_header Content-Security-Policy "default-src '\''self'\''; base-uri '\''self'\''; object-src '\''none'\''; frame-ancestors '\''none'\''; form-action '\''self'\''; script-src '\''self'\''; style-src '\''self'\'' '\''unsafe-inline'\'' https://fonts.googleapis.com; font-src '\''self'\'' data: https://fonts.gstatic.com; img-src '\''self'\'' data: blob: https:; connect-src '\''self'\'' https://*.supabase.co wss://*.supabase.co https://www.worldcubeassociation.org; frame-src https://www.youtube.com https://www.youtube-nocookie.com; worker-src '\''self'\'' blob:; upgrade-insecure-requests" always;\n  location / {\n    try_files $uri $uri/ /index.html;\n  }\n}\n' \
    > /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
