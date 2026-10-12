# 循序漸進學伊斯蘭

> 一步一步，認識伊斯蘭 — https://islam.onepointzeroone.org

放在 **GitHub Pages** 的免費線上課程網站。學生用 Google 或 Email 登入，在課程頁按「加入課程」後觀看**不公開的 YouTube 影片**。首頁是依序排列的**學習路線**（第 1、2、3… 階段），每個階段完成後會引導到下一階段。

## 和 1.01 Academy 的關係

- **共用同一個 Firebase 專案**（`academy-213ba`）：同一套學生帳號，兩個網站都能登入。
- 資料分開放在 `islam_` 開頭的集合：
  - `islam_courses/{課程id}`：課程目錄（公開）
  - `islam_courseVideos/{課程id}`：單元影片網址（只有加入課程的學生與管理者讀得到）
  - `islam_enroll/{Email}/courses/{課程id}`：學生加入的課程
- **安全規則寫在 [1.01academy](https://github.com/101academyforyou/1.01academy) repo 的 `firestore.rules`**（同一個 Firebase 專案只能有一份規則）。要改規則請改那邊再部署。

## 檔案

```
index.html        頁面外框
css/style.css     樣式
js/config.js      ← 網站名稱、首頁文字、Firebase 設定、管理者
js/data.js        ← 預設學習路線（第一次匯入用）
js/app.js         網站功能
js/content.js     ← 常見問題、隱私權政策、服務條款
CNAME             自訂網域 islam.onepointzeroone.org
```

## 第一次設定

1. **Cloudflare DNS**：新增 CNAME，名稱 `islam`、目標 `101academyforyou.github.io`、Proxy 設為 **DNS only**（灰色雲朵）。
2. **GitHub Pages**：repo → Settings → Pages → Source 選 `main` / `(root)`；Custom domain 填 `islam.onepointzeroone.org`，DNS 檢查通過後勾選 **Enforce HTTPS**。
3. **Firebase**：主控台 → Authentication → 設定 → **授權網域** → 新增 `islam.onepointzeroone.org`。
4. **Firestore 規則**：確認已部署 1.01academy repo 最新的 `firestore.rules`（含 `islam_` 集合的規則）。
5. 用管理者帳號登入網站 → 右上角「管理」→ **匯入現有課程到資料庫**，之後就能在網站上編輯課程、貼上影片網址。

## 管理課程

- 「管理」頁的順序 = 學習路線的階段順序，用「↑ 往前」調整。
- 編輯課程時可以改標題、介紹、封面、章節與單元，並貼上每個單元的**不公開** YouTube 網址。
- 勾選「不公開」的課程不會出現在學習路線，只有拿到課程連結的人能進入。
- 取消勾選「上架」的課程只有管理者看得到。

## 從 YouTube 播放清單建立課程

「管理 → ▶ 從播放清單建立」貼上播放清單網址，會自動用播放清單的名稱、說明、封面建立一門**未上架**的課程，每部影片一個單元（標題、長度、說明、影片網址都自動設定），再打開編輯頁讓你檢查後上架。播放清單要是「公開」或「不公開」（私人的讀不到）；清單裡私人或已刪除的影片會自動略過。

需要一組 YouTube Data API 金鑰（免費，每天的額度足夠建立很多門課）：

1. 到 [Google Cloud 主控台](https://console.cloud.google.com/apis/library/youtube.googleapis.com?project=academy-213ba) → **啟用** YouTube Data API v3
2. **API 和服務 → 憑證 → 建立憑證 → API 金鑰**
3. 編輯這把金鑰：「應用程式限制」選**網站**，加入 `https://islam.onepointzeroone.org/*`；「API 限制」只勾 **YouTube Data API v3**
4. 把金鑰貼到 `js/config.js` 的 `youtubeApiKey`（或第一次使用時直接貼在頁面上，只會存在那台電腦的瀏覽器）

## 本機預覽

```bash
python3 -m http.server 8000
```
