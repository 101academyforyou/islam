/* 循序漸進學伊斯蘭 — GitHub Pages + Firebase 登入版（所有課程免費）
 *
 * 流程：瀏覽學習地圖（公開）→ 登入 → 在課程頁按「加入課程」→ 觀看不公開的 YouTube 影片
 *
 * 和 1.01 Academy 共用同一個 Firebase 專案（同一套學生帳號），資料放在 islam_ 開頭的集合：
 *   islam_courses/{課程id}、islam_courseVideos/{課程id}、islam_enroll/{Email}/courses/{課程id}
 * 安全規則在 1.01academy repo 的 firestore.rules。
 */
// 這個網站的 Firestore 集合名稱
const COL = { courses: 'islam_courses', videos: 'islam_courseVideos', enroll: 'islam_enroll', prefs: 'islam_prefs', students: 'islam_students', notes: 'islam_notes', posts: 'islam_posts', counts: 'islam_counts', counted: 'islam_counted', stats: 'islam_stats', articles: 'islam_articles', blog: 'islam_blog', media: 'islam_media', events: 'islam_events' };
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const CONFIG = window.SITE_CONFIG || {};
const configured = !!(CONFIG.firebaseConfig && CONFIG.firebaseConfig.apiKey);

let fb = null;           // Firebase 函式
let auth = null, db = null, fbApp = null;
let user = null;         // 目前登入的 Firebase 使用者
let joined = [];         // 已加入的課程 id（從課程頁按「加入課程」）
let joinedAt = {};       // 課程 id → 加入時間（毫秒）
let myFolders = [];      // 學生自己建的資料夾 [{ id, name, courses: [課程id…] }]（islam_prefs/{Email}.folders）
let myOrder = [];        // 學生自己在「我的學習區」拖曳排好的順序（islam_prefs/{Email}.order）
let accessReady = Promise.resolve();
const videoCache = {};   // 課程 id → { 單元 id: YouTube ID }
let courses = COURSES;   // 課程目錄：優先讀 Firestore 的 courses 集合，讀不到時用 data.js
let coursesFromDb = false;
let learners = 0;       // 全站加入學習的累計人數（islam_stats/learners.n，每人只算一次）
let joinCount = {};      // 課程 id → 加入學習的累計人數（islam_counts/{課程id}.n，移出學習區不會減少）

/* ---------------- 小工具 ---------------- */
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const clock = (s) => !s ? '' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
const lessonTime = (l) => l.kind === 'article' ? (l.duration ? Math.round(l.duration / 60) + ' 分鐘閱讀' : '文章') : clock(l.duration);
const lessonsOf = (c) => c.chapters.flatMap((ch) => ch.lessons);
const totalMinutes = (c) => Math.round(lessonsOf(c).reduce((s, l) => s + l.duration, 0) / 60);
const minutesText = (c) => (totalMinutes(c) ? ` · ${totalMinutes(c)} 分鐘` : '');
const findCourse = (id) => courses.find((c) => c.id === id);
const visibleCourses = () => courses.filter((c) => c.published !== false || isAdmin());
// 首頁列出的課程：不公開（只能用連結進入）的課程只有管理者看得到
const listedCourses = () => visibleCourses().filter((c) => !c.unlisted || isAdmin());
const courseLink = (id) => location.origin + location.pathname + '#/course/' + id;
const go = (path) => { location.hash = '#' + path; };

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function thumb(c) {
  if (c.cover) return `<div class="thumb"><img src="${esc(c.cover)}" alt="${esc(c.title)}"></div>`;
  return `<div class="thumb" style="background:linear-gradient(135deg,${esc(c.thumb[0])},${esc(c.thumb[1])})"><span>${esc(c.thumb[2])}</span></div>`;
}

// 時間格式：2026/10/31 23:59
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (ms) => { const d = new Date(ms); return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// 接受 YouTube 影片 ID 或各種網址格式，回傳 11 碼 ID
function youtubeId(v) {
  v = String(v || '').trim();
  if (/^[\w-]{11}$/.test(v)) return v;
  const m = /(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(v);
  return m ? m[1] : null;
}

// 已跳脫的文字中，把網址變成可點擊的連結
const linkify = (html) => html.replace(/https?:\/\/[^\s<]+/g, (u) => `<a class="link" href="${u}" target="_blank" rel="noopener">${u}</a>`);

// 上傳到 Firebase Storage 的影片（或其他 https 影片檔網址）
const isFileVideo = (v) => /^https:\/\//.test(String(v || '').trim()) && !youtubeId(v);

function youtubeEmbed(v) {
  if (isFileVideo(v)) {
    return `<div class="video"><video src="${esc(v)}" controls playsinline preload="metadata" controlsList="nodownload" disablePictureInPicture oncontextmenu="return false"></video></div>`;
  }
  const id = youtubeId(v);
  return id
    ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1" title="課程影片" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
    : '<div class="video empty"><p>此單元影片尚未設定</p></div>';
}

// 文章單元：簡易格式（# 標題、**粗體**、*斜體*、- 清單、1. 編號、> 引用、--- 分隔線、[文字](網址)、![說明](圖片網址)、網址自動連結）
// 先跳脫所有 HTML，再轉換格式，所以內容不會被插入程式碼；每段 dir="auto"，阿拉伯文會自動由右到左
function renderArticle(text) {
  const inline = (t) => {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    t = t.replace(/!\[([^\]]*)\]\(media:([\w-]+)\)/g, (_, alt, id) => hold(`<img class="media-img" data-media="${id}" alt="${alt}"/>`))
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (_, alt, u) => hold(`<img src="${u}" alt="${alt}" loading="lazy"/>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, u) => hold(`<a class="link" href="${u}" target="_blank" rel="noopener">${label}</a>`))
      .replace(/https?:\/\/[^\s<]+/g, (u) => hold(`<a class="link" href="${u}" target="_blank" rel="noopener">${u}</a>`))
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  };
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) out.push(`<p dir="auto">${para.map(inline).join('<br>')}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag} dir="auto">${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
  esc(text || '').replace(/\r/g, '').split('\n').forEach((raw) => {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); return; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); const h = m[1].length + 2; out.push(`<h${h} dir="auto">${inline(m[2])}</h${h}>`); return; }
    if (/^-{3,}$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr/>'); return; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote dir="auto">${inline(m[1])}</blockquote>`); return; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      flushPara();
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[1]);
      return;
    }
    flushList();
    para.push(line);
  });
  flushPara(); flushList();
  return out.join('');
}

// 上傳的圖片／GIF（islam_media）：畫面出現 <img data-media> 時自動載入
const mediaCache = {};
const loadMedia = (id) => mediaCache[id] || (mediaCache[id] = fb.getDoc(fb.doc(db, COL.media, id))
  .then((snap) => (snap.exists() ? snap.data().data : ''))
  .catch((e) => { console.error(e); delete mediaCache[id]; return ''; }));
function hydrateMedia(root) {
  if (!fb || !root.querySelectorAll) return;
  const imgs = [...root.querySelectorAll('img[data-media]:not([src])')];
  if (root.matches && root.matches('img[data-media]:not([src])')) imgs.push(root);
  imgs.forEach((img) => {
    loadMedia(img.dataset.media).then((src) => { if (src) img.src = src; else img.classList.add('media-missing'); });
  });
}
new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) hydrateMedia(n); })))
  .observe(document.documentElement, { childList: true, subtree: true });

// 上傳圖片：一般圖片縮到寬 1280 以內、壓縮成 JPEG；GIF 保留動畫（原檔要小於約 700KB）
const MAX_GIF = 700 * 1024;
async function uploadMedia(file) {
  let data, type;
  if (file.type === 'image/gif') {
    if (file.size > MAX_GIF) throw new Error(`GIF 檔案太大（${Math.round(file.size / 1024)}KB），上限約 700KB，請先壓縮（例如用 ezgif.com）或改用圖片網址`);
    data = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(file); });
    type = 'image/gif';
  } else {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / img.width);
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); // 透明背景改成白色
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let q = 0.85;
    data = canvas.toDataURL('image/jpeg', q);
    while (data.length > 900000 && q > 0.35) { q -= 0.1; data = canvas.toDataURL('image/jpeg', q); }
    if (data.length > 900000) throw new Error('圖片太大，請換一張較小的圖片');
    type = 'image/jpeg';
  }
  const id = newId('m');
  await fb.setDoc(fb.doc(db, COL.media, id), { data, type, createdAt: Date.now() });
  mediaCache[id] = Promise.resolve(data);
  return id;
}
// 「插入圖片／GIF」按鈕：上傳後把 ![](media:id) 插到游標位置
function mediaButton(target) {
  return `<span class="media-tools"><button type="button" class="btn btn-ghost btn-sm" data-upload="${target}">🖼 插入圖片／GIF</button>` +
    `<input type="file" accept="image/*" multiple hidden data-upload-file="${target}"/><span class="muted small" data-upload-state="${target}"></span></span>`;
}
function bindMediaButtons(root, onInserted) {
  root.querySelectorAll('[data-upload]').forEach((btn) => {
    const key = btn.dataset.upload;
    const input = root.querySelector(`[data-upload-file="${key}"]`);
    const state = root.querySelector(`[data-upload-state="${key}"]`);
    btn.onclick = () => input.click();
    input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      const ta = root.querySelector(`textarea[name="${key}"]`) || root.querySelector(`textarea[data-key="${key}"]`);
      if (!files.length || !ta) return;
      btn.disabled = true;
      try {
        for (const [i, file] of files.entries()) {
          state.textContent = `上傳中…${files.length > 1 ? `（${i + 1}/${files.length}）` : ''}`;
          const id = await uploadMedia(file);
          const pos = ta.selectionStart ?? ta.value.length;
          const before = ta.value.slice(0, pos), after = ta.value.slice(pos);
          const ins = (before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '') + `![](media:${id})` + (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n');
          ta.value = before + ins + after;
          ta.selectionStart = ta.selectionEnd = (before + ins).length;
        }
        state.textContent = '✓ 已插入';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        if (onInserted) onInserted(ta);
      } catch (e) {
        console.error(e);
        state.textContent = '';
        toast(e.message && !e.code ? e.message : '上傳失敗：' + (e.code || e.message));
      } finally { btn.disabled = false; }
    };
  });
}

const isVerified = () => !!(user && user.emailVerified);
const isAdmin = () => isVerified() && (CONFIG.admins || []).some((e) => e.toLowerCase() === user.email.toLowerCase());
const hasJoined = (id) => joined.includes(id);
// 所有課程免費：登入（並驗證 Email）後在課程頁按「加入課程」就能看，每門課分開加入
const owns = (courseId) => isVerified() && (isAdmin() || hasJoined(courseId));
// 學習地圖：首頁列出的課程依序是第 1、2、3… 階段
const stepOf = (c) => listedCourses().filter((x) => !x.unlisted).indexOf(c) + 1;
const nextCourse = (c) => { const l = listedCourses().filter((x) => !x.unlisted); const i = l.indexOf(c); return i > -1 ? l[i + 1] : null; };

/* ---------------- 學習進度（存在瀏覽器） ---------------- */
function doneList(courseId) {
  try { return (JSON.parse(localStorage.getItem('isl_done_' + user.uid)) || {})[courseId] || []; } catch (e) { return []; }
}
function setDone(courseId, lessonId, done) {
  try {
    const key = 'isl_done_' + user.uid;
    const all = JSON.parse(localStorage.getItem(key)) || {};
    const list = new Set(all[courseId] || []);
    done ? list.add(lessonId) : list.delete(lessonId);
    all[courseId] = [...list];
    localStorage.setItem(key, JSON.stringify(all));
  } catch (e) { /* 無痕模式等 */ }
}
const progress = (c) => Math.round(doneList(c.id).filter((id) => lessonsOf(c).some((l) => l.id === id)).length / lessonsOf(c).length * 100);

/* ---------------- Firebase ---------------- */
async function initFirebase() {
  const [app, a, f] = await Promise.all([
    import(FIREBASE + 'firebase-app.js'),
    import(FIREBASE + 'firebase-auth.js'),
    import(FIREBASE + 'firebase-firestore.js')
  ]);
  fb = { ...a, ...f };
  const firebaseApp = fbApp = app.initializeApp(CONFIG.firebaseConfig);
  auth = a.getAuth(firebaseApp);
  auth.languageCode = 'zh-TW'; // 驗證信、重設密碼信使用繁體中文
  db = f.getFirestore(firebaseApp);
  const coursesReady = loadCourses();
  return new Promise((resolve) => {
    a.onAuthStateChanged(auth, async (u) => {
      user = u;
      accessReady = Promise.all([coursesReady, loadAccess()]);
      resolve();
      render();
    });
  });
}

async function loadAccess() {
  joined = [];
  joinedAt = {};
  myOrder = [];
  myFolders = [];
  if (!isVerified()) return;
  const email = user.email.toLowerCase();
  await Promise.all([
    fb.getDocs(fb.collection(db, COL.enroll, email, 'courses')).then((snap) => {
      // 預設依加入時間排列
      snap.docs.forEach((d) => { joinedAt[d.id] = d.data().joinedAt || 0; });
      joined = Object.keys(joinedAt).sort((a, b) => joinedAt[a] - joinedAt[b]);
    }).catch((e) => console.error(e)),
    fb.getDoc(fb.doc(db, COL.prefs, email)).then((snap) => {
      myOrder = snap.exists() ? (snap.data().order || []) : [];
      myFolders = snap.exists() ? (snap.data().folders || []) : [];
    }).catch((e) => console.error(e))
  ]);
  syncStudent(); // 補齊／更新管理者的學生名單（不必等它完成）

}

// 學生名單（給管理者看）：islam_students/{Email} = { email, name, courses: { 課程id: 加入時間 }, updatedAt }
// 學生加入或移出課程時更新；舊的學生下次登入時自動補上
let studentSynced = '';
async function syncStudent(force = false) {
  if (!isVerified()) return;
  const email = user.email.toLowerCase();
  const key = JSON.stringify([email, joined.slice().sort()]);
  if (!force && key === studentSynced) return;
  try {
    if (!force) {
      const snap = await fb.getDoc(fb.doc(db, COL.students, email));
      const have = snap.exists() ? Object.keys(snap.data().courses || {}).sort() : null;
      const upToDate = have ? JSON.stringify([email, have]) === key : !joined.length; // 沒加入任何課程就不必建立
      if (upToDate) { studentSynced = key; return; }
    }
    const courses = {};
    joined.forEach((id) => { courses[id] = joinedAt[id] || Date.now(); });
    await fb.setDoc(fb.doc(db, COL.students, email), { email, name: user.displayName || '', courses, updatedAt: Date.now() });
    studentSynced = key;
  } catch (e) {
    console.error(e);
  }
}

// 加入課程（每門課分開加入）；stay = 留在原頁（例如從首頁快速加入）
async function joinCourse(c, btn, stay = false) {
  btn.disabled = true;
  try {
    const at = Date.now();
    const ref = fb.doc(db, COL.enroll, user.email.toLowerCase(), 'courses', c.id);
    // 第一次加入這門課時，學習人數 +1（同一個批次寫入，規則才能確認是真的加入；每人每門課只算一次）
    const mark = fb.doc(db, COL.counted, user.email.toLowerCase(), 'courses', c.id);
    const person = fb.doc(db, COL.counted, user.email.toLowerCase()); // 第一次加入任何課程：全站人數 +1
    let counted = false;
    try {
      const [m, pm] = await Promise.all([fb.getDoc(mark), fb.getDoc(person)]);
      if (!m.exists()) {
        const b = fb.writeBatch(db);
        b.set(ref, { joinedAt: at });
        b.set(mark, { at });
        b.set(fb.doc(db, COL.counts, c.id), { n: fb.increment(1) }, { merge: true });
        if (!pm.exists()) {
          b.set(person, { at });
          b.set(fb.doc(db, COL.stats, 'learners'), { n: fb.increment(1) }, { merge: true });
        }
        await b.commit();
        joinCount[c.id] = (joinCount[c.id] || 0) + 1;
        if (!pm.exists()) learners++;
        counted = true;
      }
    } catch (e) { console.warn('人數未更新', e); }
    if (!counted) await fb.setDoc(ref, { joinedAt: at });
    if (!joined.includes(c.id)) joined.push(c.id);
    joinedAt[c.id] = at;
    syncStudent(true);
    toast('已加入我的學習區');
    if (stay) render(); else go('/learn/' + c.id);
  } catch (err) {
    btn.disabled = false;
    toast('加入失敗：' + (err.code || err.message) + '（請確認已部署最新的 Firestore 規則）');
  }
}

// 從我的學習區移除（進度紀錄保留在瀏覽器）
async function leaveCourse(c) {
  // 學習人數是累計的，移出不會減少
  await fb.deleteDoc(fb.doc(db, COL.enroll, user.email.toLowerCase(), 'courses', c.id));
  joined = joined.filter((id) => id !== c.id);
  delete joinedAt[c.id];
  syncStudent(true);
}

// 我的學習區的課程：依學生自己排的順序，沒排過的放後面（依加入時間）
function myCourses() {
  const list = visibleCourses().filter((c) => hasJoined(c.id));
  const rank = (c) => { const i = myOrder.indexOf(c.id); return i === -1 ? 1e6 + joined.indexOf(c.id) : i; };
  return list.sort((a, b) => rank(a) - rank(b));
}
// 儲存學習區的排列：未分類的順序 + 資料夾（各自的課程順序）
async function saveArea(order, folders) {
  myOrder = order;
  myFolders = folders;
  await fb.setDoc(fb.doc(db, COL.prefs, user.email.toLowerCase()), { order, folders, updatedAt: Date.now() });
}

// 從 Firestore 讀取課程目錄；資料庫還沒有課程時，沿用 data.js
async function loadCourses() {
  const counts = loadCounts();
  try {
    const snap = await fb.getDocs(fb.collection(db, COL.courses));
    if (!snap.empty) {
      courses = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
        .sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
      coursesFromDb = true;
    }
  } catch (e) {
    console.error(e);
  }
  await counts;
}

// 每門課加入學習的人數（任何人都看得到）
async function loadCounts() {
  try {
    const [snap, st] = await Promise.all([fb.getDocs(fb.collection(db, COL.counts)), fb.getDoc(fb.doc(db, COL.stats, 'learners'))]);
    joinCount = {};
    snap.docs.forEach((d) => { joinCount[d.id] = Math.max(0, Number(d.data().n) || 0); });
    learners = st.exists() ? Math.max(0, Number(st.data().n) || 0) : 0;
  } catch (e) { console.error(e); }
}
// Lucide 線條圖示（https://lucide.dev，ISC 授權），顏色跟著文字
const lucide = (paths) => `<svg class="icon" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICON = {
  usersRound: lucide('<path d="M18 21a8 8 0 0 0-16 0"/><circle cx="10" cy="8" r="5"/><path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3"/>'),
  fileText: lucide('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>'),
  bookOpen: lucide('<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>')
};
const countText = (c) => joinCount[c.id] > 0 ? `<span class="learners">${ICON.usersRound} ${joinCount[c.id].toLocaleString()} 人加入學習</span>` : '';

// 外部文章連結：https 的網頁嵌入顯示（有些網站不允許嵌入，所以一定附上「開啟原文」按鈕）
function articleLink(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  const embed = /^https:\/\//i.test(url);
  return '<div class="article-link">' +
    (embed ? `<iframe src="${esc(url)}" title="文章" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"></iframe>` : '') +
    `<div class="article-link-bar"><span class="muted small">${ICON.fileText} 文章來源：${esc(host)}${embed ? '（如果上方沒有顯示內容，代表該網站不允許嵌入，請按右邊的按鈕閱讀）' : ''}</span>` +
    `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">在新分頁開啟原文 ↗</a></div></div>`;
}
const articleHtml = (a) => !a ? '' : (a.url ? articleLink(a.url) : '') + (a.text ? `<div class="article">${renderArticle(a.text)}</div>` : '');

// 文章單元的內容 { text, url }（讀不到或沒有時回傳 null）
const articleCache = {};
async function loadArticle(courseId, lessonId) {
  const key = courseId + '/' + lessonId;
  if (key in articleCache) return articleCache[key];
  try {
    const snap = await fb.getDoc(fb.doc(db, COL.articles, courseId, 'lessons', lessonId));
    articleCache[key] = snap.exists() ? { text: snap.data().text || '', url: snap.data().url || '' } : null;
  } catch (e) { console.error(e); return null; }
  return articleCache[key];
}

async function loadVideos(courseId) {
  if (videoCache[courseId]) return videoCache[courseId];
  const snap = await fb.getDoc(fb.doc(db, COL.videos, courseId));
  videoCache[courseId] = snap.exists() ? snap.data() : {};
  return videoCache[courseId];
}

function authError(e) {
  const map = {
    'auth/invalid-credential': 'Email 或密碼錯誤',
    'auth/wrong-password': 'Email 或密碼錯誤',
    'auth/user-not-found': 'Email 或密碼錯誤',
    'auth/invalid-email': 'Email 格式不正確',
    'auth/email-already-in-use': '此 Email 已註冊，請直接登入',
    'auth/weak-password': '密碼至少需要 6 個字元',
    'auth/too-many-requests': '嘗試次數過多，請稍後再試',
    'auth/popup-closed-by-user': '登入視窗已關閉',
    'auth/popup-blocked': '瀏覽器擋住了登入視窗，請允許彈出視窗',
    'auth/unauthorized-domain': '此網域尚未加入 Firebase 授權網域（見 README）',
    'auth/network-request-failed': '網路連線失敗，請稍後再試'
  };
  return map[e && e.code] || '發生錯誤：' + (e && (e.code || e.message));
}

/* ---------------- 頁首 ---------------- */
function renderHeader() {
  const name = user ? (user.displayName || user.email) : '';
  document.getElementById('header').innerHTML =
    '<div class="container nav">' +
    // 標誌：往上的階梯（循序漸進）
    `<a href="#/" class="logo"><span class="logo-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M4 19h5v-5h5V9h5V5"/></svg></span>${esc(CONFIG.siteName || '循序漸進學伊斯蘭')}</a>` +
    '<nav>' +
    '<a href="#/">學習地圖</a><a href="#/articles">文章</a><a href="#/calendar">行事曆</a>' +
    (user
      ? `<a href="#/my">我的學習區</a>${isAdmin() ? '<a href="#/admin">管理</a>' : ''}<a class="muted small user-name" href="#/account" title="帳號設定（${esc(user.email)}）">${esc(name)}</a><button class="link" id="logout">登出</button>`
      : '<a href="#/login" class="btn btn-sm">登入</a>') +
    '<button class="icon-btn" id="theme" aria-label="切換深淺色"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>' +
    '</nav></div>';
  const lo = document.getElementById('logout');
  if (lo) lo.onclick = async () => { await fb.signOut(auth); toast('已登出'); go('/'); };
  document.getElementById('theme').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('isl_theme', JSON.stringify(next)); } catch (e) {}
  };
}

/* ---------------- 頁面 ---------------- */
const pages = {};

// 課程狀態（學習地圖、我的學習區共用）
function statusOf(c) {
  if (!isVerified() || !owns(c.id)) return '';
  const p = progress(c);
  return p === 100 ? '<span class="owned">✓ 已完成</span>' : `<span class="owned">✓ 已加入 · 進度 ${p}%</span>`;
}

// 首頁：學習地圖（公開）＋搜尋與分類
const categoriesOf = (list) => [...new Set(list.map((c) => c.category).filter(Boolean))];
pages.home = (app) => {
  const path = listedCourses().filter((c) => !c.unlisted);
  const hidden = listedCourses().filter((c) => c.unlisted); // 管理者才看得到
  const cats = categoriesOf(path);
  let cat = '', q = '';
  const joinBtn = (c) => {
    // 卡片本身是連結，裡面不能再放 <a>（瀏覽器會把卡片拆開），所以用按鈕
    if (!user) return '<button type="button" class="btn btn-ghost btn-sm" data-stop>＋ 加入學習區</button>';
    if (!isVerified() || hasJoined(c.id)) return '';
    return `<button type="button" class="btn btn-ghost btn-sm" data-join="${esc(c.id)}">＋ 加入學習區</button>`;
  };
  const row = (c, n) =>
    `<a class="card step" href="#/course/${c.id}">` +
    `<span class="step-no">${n ? n : '–'}</span>${thumb(c)}<div class="step-body">` +
    `<span class="tag">${[n ? `第 ${n} 階段` : '', c.category, c.level, c.unlisted ? '不公開' : '', c.published === false ? '未上架' : ''].filter(Boolean).map(esc).join(' · ')}</span>` +
    `<h3>${esc(c.title)}</h3>` + (c.subtitle ? `<p class="muted small">${esc(c.subtitle)}</p>` : '') +
    `<p class="muted small">${lessonsOf(c).length} 個單元${minutesText(c)}${joinCount[c.id] > 0 ? ' · ' + countText(c) : ''}</p>` +
    `<div class="step-foot">${statusOf(c) || '<span class="price free">免費</span>'}${joinBtn(c)}</div></div></a>`;
  app.innerHTML =
    '<section class="hero"><div class="container">' +
    `<h1>${esc(CONFIG.tagline || '一步一步，認識伊斯蘭')}</h1>` +
    `<p class="lead muted">${esc(CONFIG.intro || '從最基礎開始，依照學習地圖循序漸進。所有課程免費，登入後加入課程即可觀看。')}</p>` +
    `<p class="site-stats"><span>${ICON.bookOpen} 目前共有 <strong>${path.filter((c) => c.published !== false).length}</strong> 門課程</span>` +
    `<a class="stat-link" href="#/articles" id="stat-articles" hidden>${ICON.fileText} 共 <strong></strong> 篇文章</a>` +
    (learners > 0 ? `<span>${ICON.usersRound} 共 <strong>${learners.toLocaleString()}</strong> 人加入學習</span>` : '') + '</p>' +
    '<input class="input search" id="q" type="search" placeholder="搜尋課程或文章…" aria-label="搜尋課程或文章" autocomplete="off" />' +
    '</div></section>' +
    '<section class="container"><h2>學習地圖</h2>' +
    (cats.length ? '<div class="chips" id="chips"><button class="chip" data-cat="">全部</button>' +
      cats.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('') + '</div>' : '') +
    '<div class="path" id="list"></div>' +
    '<div id="search-articles" hidden></div>' +
    (hidden.length ? '<h3 class="muted">不公開的課程（只有管理者看得到這個列表）</h3><div class="path">' + hidden.map((c) => row(c, 0)).join('') + '</div>' : '') +
    '</section>' +
    '<section class="container" id="home-events" hidden></section>' +
    '<section class="container" id="home-blog" hidden></section>' +
    '<section class="container home-faq"><h2>常見問題</h2>' + faqList(SITE_PAGES.faq.slice(0, 5)) +
    '<p><a class="link" href="#/faq">查看全部常見問題 →</a></p></section>';

  const listEl = app.querySelector('#list');
  let posts = []; // 已發布的文章（搜尋時一起找）
  function draw() {
    app.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
    const words = q.split(/\s+/).filter(Boolean);
    const shown = path.map((c, i) => [c, i + 1]).filter(([c]) =>
      (!cat || c.category === cat) &&
      words.every((w) => [c.title, c.subtitle, c.category, c.level, c.description, ...lessonsOf(c).map((l) => l.title)].join(' ').toLowerCase().includes(w)));
    // 有輸入關鍵字時，也找文章
    const found = words.length ? posts.filter((a) => words.every((w) => [a.title, a.summary, a.category, a.text].join(' ').toLowerCase().includes(w))) : [];
    listEl.innerHTML = !path.length ? '<p class="muted">課程準備中，敬請期待。</p>'
      : shown.length ? shown.map(([c, n]) => row(c, n)).join('')
      : `<p class="muted">找不到符合的課程${found.length ? `，下方有 ${found.length} 篇相關文章` : ''}。</p>`;
    const box = app.querySelector('#search-articles');
    box.hidden = !found.length;
    box.innerHTML = found.length ? `<h3>相關文章（${found.length}）</h3><div class="blog-grid">${found.map(blogCard).join('')}</div>` : '';
  }
  const chips = app.querySelector('#chips');
  if (chips) chips.onclick = (e) => { if (e.target.dataset.cat != null) { cat = e.target.dataset.cat; draw(); } };
  app.querySelector('#q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  // 卡片上的「加入學習區」：不要觸發卡片連結
  app.onclick = (e) => {
    const b = e.target.closest('[data-join]');
    if (b) { e.preventDefault(); const c = findCourse(b.dataset.join); if (c) joinCourse(c, b, true); return; }
    if (e.target.closest('[data-stop]')) { e.preventDefault(); go('/login?next=/'); }
  };
  draw();
  // 近期活動（今天以後的前 3 個）
  loadEvents().then((list) => {
    const box = app.querySelector('#home-events');
    const next = upcomingEvents(list).slice(0, 3);
    if (!box || !next.length) return;
    box.innerHTML = '<div class="row-between"><h2>近期活動</h2><a class="link" href="#/calendar">查看行事曆 →</a></div>' +
      '<div class="event-list">' + next.map(eventRow).join('') + '</div>';
    box.hidden = false;
  });
  // 最新文章（有發布的文章才顯示）
  loadBlog().then((list) => {
    // 首頁統計：已發布的文章數
    posts = list.filter((a) => a.published);
    if (q) draw();
    const n = posts.length;
    const stat = app.querySelector('#stat-articles');
    if (stat && n) { stat.querySelector('strong').textContent = n.toLocaleString(); stat.hidden = false; }
    const box = app.querySelector('#home-blog');
    const latest = list.filter((a) => a.published).slice(0, 3);
    if (!box || !latest.length) return;
    box.innerHTML = '<div class="row-between"><h2>最新文章</h2><a class="link" href="#/articles">查看全部文章 →</a></div>' +
      '<div class="blog-grid">' + latest.map(blogCard).join('') + '</div>';
    box.hidden = false;
  });
};

/* ---------------- 文章（獨立於課程） ----------------
 * islam_blog/{文章id} = { title, summary, category, cover, url, text, published, createdAt, updatedAt }
 * 已發布的文章任何人都看得到；草稿只有管理者看得到 */
let blogCache = null, blogFor = null;
async function loadBlog(force = false) {
  const who = isAdmin() ? 'admin' : 'public';
  if (!force && blogCache && blogFor === who) return blogCache;
  try {
    const col = fb.collection(db, COL.blog);
    const snap = await fb.getDocs(isAdmin() ? col : fb.query(col, fb.where('published', '==', true)));
    blogCache = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
      .filter((a) => a.published || isAdmin())
      .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    blogFor = who;
  } catch (e) {
    console.error(e);
    blogCache = blogCache || [];
  }
  return blogCache;
}
const findPost = (id) => (blogCache || []).find((a) => a.id === id);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const blogCard = (a) =>
  `<a class="card blog-card" href="#/article/${a.id}">` +
  (a.cover ? `<div class="thumb"><img src="${esc(a.cover)}" alt="${esc(a.title)}" loading="lazy"></div>` : '') +
  '<div class="pad">' +
  `<span class="tag">${[a.category, fmtDate(a.createdAt), a.published ? '' : '草稿'].filter(Boolean).map(esc).join(' · ')}</span>` +
  `<h3>${esc(a.title)}</h3>` +
  (a.summary ? `<p class="muted small">${esc(a.summary)}</p>` : '') +
  (a.url && !a.text ? `<p class="muted small">${ICON.fileText} 來源：${esc(hostOf(a.url))}</p>` : '') +
  '</div></a>';

pages.articles = async (app) => {
  app.innerHTML = '<div class="container"><p class="muted">載入文章中…</p></div>';
  const list = await loadBlog();
  if (!document.body.contains(app)) return;
  const cats = categoriesOf(list);
  let cat = '', q = '';
  app.innerHTML = '<div class="container"><div class="row-between"><h1>文章</h1>' +
    (isAdmin() ? '<a class="btn btn-sm" href="#/admin/article/new">＋ 新增文章</a>' : '') + '</div>' +
    '<input class="input" id="aq" type="search" placeholder="搜尋文章…" autocomplete="off"/>' +
    (cats.length ? '<div class="chips" id="achips"><button class="chip" data-cat="">全部</button>' +
      cats.map((c) => `<button class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('') + '</div>' : '') +
    '<div class="blog-grid" id="alist"></div></div>';
  const draw = () => {
    app.querySelectorAll('[data-cat]').forEach((b) => b.classList.toggle('active', b.dataset.cat === cat));
    const words = q.split(/\s+/).filter(Boolean);
    const shown = list.filter((a) => (!cat || a.category === cat) &&
      words.every((w) => [a.title, a.summary, a.category, a.text].join(' ').toLowerCase().includes(w)));
    app.querySelector('#alist').innerHTML = !list.length ? '<p class="muted">文章準備中，敬請期待。</p>'
      : shown.length ? shown.map(blogCard).join('') : '<p class="muted">找不到符合的文章。</p>';
  };
  app.querySelector('#aq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  const chips = app.querySelector('#achips');
  if (chips) chips.onclick = (e) => { if (e.target.dataset.cat != null) { cat = e.target.dataset.cat; draw(); } };
  draw();
};

pages.article = async (app, id) => {
  app.innerHTML = '<div class="container"><p class="muted">載入文章中…</p></div>';
  await loadBlog();
  let a = findPost(id);
  if (!a) { // 可能是剛發布或還沒載入的文章
    try { const snap = await fb.getDoc(fb.doc(db, COL.blog, id)); if (snap.exists()) a = { ...snap.data(), id }; } catch (e) { /* 草稿或不存在 */ }
  }
  if (!document.body.contains(app)) return;
  if (!a || (!a.published && !isAdmin())) return notFound(app);
  app.innerHTML = '<div class="container narrow blog-page">' +
    '<a href="#/articles" class="muted small">← 全部文章</a>' +
    (isAdmin() ? ` · <a href="#/admin/article/${a.id}" class="link small">✎ 編輯此文章</a>` + (a.published ? '' : ' <span class="tag">（草稿）</span>') : '') +
    `<p class="tag">${[a.category, fmtDate(a.createdAt)].filter(Boolean).map(esc).join(' · ')}</p>` +
    `<h1 dir="auto">${esc(a.title)}</h1>` +
    (a.summary ? `<p class="lead muted" dir="auto">${esc(a.summary)}</p>` : '') +
    (a.cover ? `<img class="blog-cover" src="${esc(a.cover)}" alt="${esc(a.title)}">` : '') +
    `<div class="lesson-article">${articleHtml({ text: a.text, url: a.url })}</div>` +
    '<p class="center"><a class="btn btn-ghost btn-sm" href="#/articles">← 回到全部文章</a></p></div>';
};

/* ---------------- 行事曆（課程與活動） ----------------
 * islam_events/{活動id} = { title, type, start: 'YYYY-MM-DD', end, allDay, startTime: 'HH:MM', endTime, location, url, courseId, description, published, createdAt, updatedAt }
 * 已發布的活動任何人都看得到；草稿只有管理者看得到 */
const EVENT_TYPES = ['課程', '講座', '活動', '節日', '其他'];
const typeClass = (t) => 'ev-' + Math.max(0, EVENT_TYPES.indexOf(t));
let eventCache = null, eventFor = null;
async function loadEvents(force = false) {
  const who = isAdmin() ? 'admin' : 'public';
  if (!force && eventCache && eventFor === who) return eventCache;
  try {
    const col = fb.collection(db, COL.events);
    const snap = await fb.getDocs(isAdmin() ? col : fb.query(col, fb.where('published', '==', true)));
    eventCache = snap.docs.map((d) => ({ ...d.data(), id: d.id }))
      .filter((e) => (e.published || isAdmin()) && /^\d{4}-\d{2}-\d{2}$/.test(e.start || ''))
      .sort((x, y) => (x.start + (x.allDay ? '' : x.startTime || '')).localeCompare(y.start + (y.allDay ? '' : y.startTime || '')));
    eventFor = who;
  } catch (e) {
    console.error(e);
    eventCache = eventCache || [];
  }
  return eventCache;
}
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());
const endOf = (e) => (e.end && e.end >= e.start ? e.end : e.start);
const eventsOn = (list, day) => list.filter((e) => e.start <= day && endOf(e) >= day);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const dateLabel = (s) => { const [y, m, d] = s.split('-').map(Number); const w = new Date(y, m - 1, d).getDay(); return `${m}/${d}（${WEEK[w]}）`; };
const parseDay = (s) => s.split('-').map(Number);
const addDays = (s, n) => { const [y, m, d] = parseDay(s); return ymd(new Date(y, m - 1, d + n)); };
const dayDiff = (a, b) => { const [y1, m1, d1] = parseDay(a), [y2, m2, d2] = parseDay(b); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5); };

// 規律活動：每日、每週、每兩週、每月（每月同一天；沒有那一天的月份跳過，例如 31 日）
const REPEATS = { '': '不重複', daily: '每日', weekly: '每週', biweekly: '每兩週', monthly: '每月' };
// 縣市（地點篩選用）
const CITIES = ['台北市', '新北市', '基隆市', '桃園市', '新竹市', '新竹縣', '苗栗縣', '台中市', '彰化縣', '南投縣', '雲林縣', '嘉義市', '嘉義縣',
  '台南市', '高雄市', '屏東縣', '宜蘭縣', '花蓮縣', '台東縣', '澎湖縣', '金門縣', '連江縣', '線上', '海外'];
const untilOf = (e) => (e.repeat && e.repeatUntil && e.repeatUntil >= e.start ? e.repeatUntil : '');
// 活動在 [from, to] 期間的每一次（每次是一個帶有該次日期的活動複本）
function occurrences(e, from, to) {
  const dur = dayDiff(e.start, endOf(e));
  if (!e.repeat || !REPEATS[e.repeat]) return endOf(e) >= from && e.start <= to ? [e] : [];
  const until = untilOf(e) || '9999-12-31';
  const out = [];
  const push = (s) => { const en = addDays(s, dur); if (en >= from && s <= to && s <= until) out.push({ ...e, start: s, end: dur ? en : '', series: e.start }); };
  if (e.repeat === 'monthly') {
    const [y0, m0, d0] = parseDay(e.start);
    const [fy, fm] = parseDay(from);
    let i = Math.max(0, (fy - y0) * 12 + (fm - m0) - 1);
    for (let n = 0; n < 400; n++, i++) {
      const dt = new Date(y0, m0 - 1 + i, d0);
      if (dt.getDate() !== d0) continue; // 這個月沒有這一天
      const s = ymd(dt);
      if (s > to || s > until) break;
      push(s);
    }
  } else {
    const step = { daily: 1, weekly: 7, biweekly: 14 }[e.repeat];
    let i = Math.max(0, Math.floor((dayDiff(e.start, from) - dur) / step));
    for (let n = 0; n < 1000; n++, i++) {
      const s = addDays(e.start, i * step);
      if (s > to || s > until) break;
      push(s);
    }
  }
  return out;
}
const nextOccurrence = (e, from = todayStr()) => occurrences(e, from, addDays(from, 800))[0] || null;
const seriesEnd = (e) => (e.repeat && REPEATS[e.repeat] ? untilOf(e) || '9999-12-31' : endOf(e));
// 即將舉行：每個活動取下一次，依日期排序
const upcomingEvents = (list) => list.filter((e) => e.published).map((e) => nextOccurrence(e)).filter(Boolean)
  .sort((a, b) => (a.start + (a.startTime || '')).localeCompare(b.start + (b.startTime || '')));
function repeatText(e) {
  if (!e.repeat || !REPEATS[e.repeat]) return '';
  const base = e.series || e.start;
  const [, , d] = parseDay(base);
  const w = WEEK[new Date(...(([y, m, dd]) => [y, m - 1, dd])(parseDay(base))).getDay()];
  const label = { daily: '每天', weekly: `每週${w}`, biweekly: `每兩週的週${w}`, monthly: `每月 ${d} 日` }[e.repeat];
  const until = untilOf(e);
  return label + (until ? `（到 ${until.replace(/-/g, '/')}）` : '');
}
const placeText = (e) => [e.city, e.location].filter(Boolean).join(' ');
function whenText(e) {
  const span = endOf(e) !== e.start ? `${dateLabel(e.start)} – ${dateLabel(endOf(e))}` : dateLabel(e.start);
  const time = e.allDay || !e.startTime ? '' : ` ${e.startTime}${e.endTime ? '–' + e.endTime : ''}`;
  return span + time;
}
const eventRow = (e) => {
  const [, m, d] = parseDay(e.start);
  const c = e.courseId ? findCourse(e.courseId) : null;
  return `<a class="card event-row" href="#/event/${e.id}"><span class="ev-date ${typeClass(e.type)}"><b>${d}</b><small>${m} 月</small></span>` +
    `<span class="ev-main"><span class="tag">${[e.type, e.repeat && REPEATS[e.repeat] ? '🔁 ' + REPEATS[e.repeat] : '', e.city, e.published ? '' : '草稿'].filter(Boolean).map(esc).join(' · ')}</span>` +
    `<strong dir="auto">${esc(e.title)}</strong>` +
    `<span class="muted small">${esc(whenText(e))}${e.location ? ' · ' + esc(e.location) : ''}${c ? ' · 課程：' + esc(c.title) : ''}</span></span></a>`;
};
// 加入 Google 日曆、下載 .ics（Apple／Outlook）；規律活動加上 RRULE
const compact = (s) => s.replace(/-/g, '');
const plusDay = (s) => addDays(s, 1);
function rrule(e) {
  if (!e.repeat || !REPEATS[e.repeat]) return '';
  const freq = { daily: 'FREQ=DAILY', weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', monthly: 'FREQ=MONTHLY' }[e.repeat];
  const until = untilOf(e);
  return 'RRULE:' + freq + (until ? ';UNTIL=' + (e.allDay || !e.startTime ? compact(until) : utcStamp(until, '23:59')) : '');
}
function googleCalUrl(e) {
  const dates = e.allDay || !e.startTime
    ? `${compact(e.start)}/${compact(plusDay(endOf(e)))}`
    : `${compact(e.start)}T${e.startTime.replace(':', '')}00/${compact(endOf(e))}T${(e.endTime || e.startTime).replace(':', '')}00`;
  const details = [plainText(e.description).slice(0, 1200), e.url, location.origin + location.pathname + '#/event/' + e.id].filter(Boolean).join('\n\n');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&ctz=Asia%2FTaipei' +
    `&text=${encodeURIComponent(e.title)}&dates=${dates}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(placeText(e) || e.url || '')}` +
    (rrule(e) ? `&recur=${encodeURIComponent(rrule(e))}` : '');
}
// 台灣時間（UTC+8，沒有日光節約）轉成 UTC，日曆 App 都能正確顯示
const utcStamp = (day, time) => { const [y, m, d] = day.split('-').map(Number); const [hh, mm] = time.split(':').map(Number); return new Date(Date.UTC(y, m - 1, d, hh - 8, mm)).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; };
// 說明文字去掉格式符號（給 Google 日曆、.ics 用）
const plainText = (t) => String(t || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,3}\s+|^>\s?/gm, '').replace(/\n{3,}/g, '\n\n').trim();
function downloadIcs(e) {
  const escIcs = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/[,;]/g, (m) => '\\' + m).replace(/\r?\n/g, '\\n');
  const when = e.allDay || !e.startTime
    ? [`DTSTART;VALUE=DATE:${compact(e.start)}`, `DTEND;VALUE=DATE:${compact(plusDay(endOf(e)))}`]
    : [`DTSTART:${utcStamp(e.start, e.startTime)}`, `DTEND:${utcStamp(endOf(e), e.endTime || e.startTime)}`];
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//islam.onepointzeroone.org//calendar//ZH', 'BEGIN:VEVENT',
    `UID:${e.id}@islam.onepointzeroone.org`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, ...when, rrule(e),
    `SUMMARY:${escIcs(e.title)}`, placeText(e) ? `LOCATION:${escIcs(placeText(e))}` : '',
    `DESCRIPTION:${escIcs([plainText(e.description), e.url].filter(Boolean).join('\n\n'))}`,
    `URL:${location.origin + location.pathname}#/event/${e.id}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  downloadFile(`event-${e.start}.ics`, ics, 'text/calendar');
}

pages.calendar = async (app, ym) => {
  app.innerHTML = '<div class="container"><p class="muted">載入行事曆中…</p></div>';
  const list = await loadEvents();
  if (!document.body.contains(app)) return;
  const now = new Date();
  let [y, m] = /^\d{4}-\d{2}$/.test(ym || '') ? ym.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  let picked = '', type = '', city = '';
  const types = EVENT_TYPES.filter((t) => list.some((e) => e.type === t));
  const cities = CITIES.filter((c) => list.some((e) => e.city === c));
  function draw() {
    const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
    const from = `${y}-${pad2(m)}-01`, to = `${y}-${pad2(m)}-${pad2(days)}`;
    const shownList = list.filter((e) => (!type || e.type === type) && (!city || e.city === city));
    const occ = shownList.flatMap((e) => occurrences(e, from, to))
      .sort((a, b) => (a.start + (a.allDay ? '' : a.startTime || '')).localeCompare(b.start + (b.allDay ? '' : b.startTime || '')));
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<div class="cal-cell blank"></div>');
    for (let d = 1; d <= days; d++) {
      const day = `${y}-${pad2(m)}-${pad2(d)}`;
      const evs = eventsOn(occ, day);
      cells.push(`<button type="button" class="cal-cell${day === todayStr() ? ' today' : ''}${day === picked ? ' picked' : ''}${evs.length ? ' has' : ''}" data-day="${day}">` +
        `<span class="cal-d">${d}</span>` +
        evs.slice(0, 3).map((e) => `<span class="cal-ev ${typeClass(e.type)}" title="${esc(e.title)}">${e.allDay || !e.startTime || e.start !== day ? '' : esc(e.startTime) + ' '}${esc(e.title)}</span>`).join('') +
        (evs.length > 3 ? `<span class="cal-more">還有 ${evs.length - 3} 個</span>` : '') +
        `<span class="cal-dots">${evs.slice(0, 4).map((e) => `<i class="${typeClass(e.type)}"></i>`).join('')}</span></button>`);
    }
    // 這個月的活動：規律活動只列一次（這個月的第一次）
    const seen = new Set();
    const monthEvents = occ.filter((e) => !seen.has(e.id) && seen.add(e.id));
    const dayEvents = picked ? eventsOn(occ, picked) : null;
    const filters = (types.length > 1 ? `<select class="input" data-filter="type" aria-label="活動類型"><option value="">全部類型</option>${types.map((t) => `<option ${t === type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : '') +
      (cities.length ? `<select class="input" data-filter="city" aria-label="縣市"><option value="">全部縣市</option>${cities.map((c) => `<option ${c === city ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : '');
    app.innerHTML = '<div class="container calendar">' +
      '<div class="row-between"><h1>行事曆</h1>' + (isAdmin() ? '<a class="btn btn-sm" href="#/admin/event/new">＋ 新增活動</a>' : '') + '</div>' +
      '<div class="cal-head"><button type="button" class="btn btn-ghost btn-sm" data-nav="-1" aria-label="上個月">‹</button>' +
      `<h2>${y} 年 ${m} 月</h2><button type="button" class="btn btn-ghost btn-sm" data-nav="1" aria-label="下個月">›</button>` +
      '<button type="button" class="btn btn-ghost btn-sm" data-nav="0">今天</button>' +
      (filters ? `<span class="cal-filters">${filters}</span>` : '') + '</div>' +
      (types.length > 1 ? '<p class="cal-legend">' + types.map((t) => `<span><i class="dot-sw ${typeClass(t)}"></i>${esc(t)}</span>`).join('') + '</p>' : '') +
      '<div class="cal-grid">' + WEEK.map((w) => `<div class="cal-w">${w}</div>`).join('') + cells.join('') + '</div>' +
      (dayEvents
        ? `<h3>${esc(dateLabel(picked))}</h3>` + (dayEvents.length ? '<div class="event-list">' + dayEvents.map(eventRow).join('') + '</div>' : '<p class="muted">這一天沒有活動。</p>')
        : `<h3>${m} 月的活動</h3>` + (monthEvents.length ? '<div class="event-list">' + monthEvents.map(eventRow).join('') + '</div>'
          : `<p class="muted">${type || city ? '這個月沒有符合條件的活動。' : '這個月還沒有活動。'}</p>`)) +
      '</div>';
  }
  app.onclick = (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const n = +nav.dataset.nav;
      if (n === 0) { y = now.getFullYear(); m = now.getMonth() + 1; }
      else { m += n; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } }
      picked = '';
      history.replaceState(null, '', `#/calendar/${y}-${pad2(m)}`);
      return draw();
    }
    const cell = e.target.closest('[data-day]');
    if (cell) { picked = picked === cell.dataset.day ? '' : cell.dataset.day; draw(); }
  };
  app.onchange = (e) => {
    const f = e.target.dataset.filter;
    if (f === 'type') type = e.target.value;
    if (f === 'city') city = e.target.value;
    if (f) draw();
  };
  draw();
};

pages.event = async (app, id) => {
  app.innerHTML = '<div class="container"><p class="muted">載入中…</p></div>';
  await loadEvents();
  let e = (eventCache || []).find((x) => x.id === id);
  if (!e) { try { const snap = await fb.getDoc(fb.doc(db, COL.events, id)); if (snap.exists()) e = { ...snap.data(), id }; } catch (err) { /* 草稿或不存在 */ } }
  if (!document.body.contains(app)) return;
  if (!e || (!e.published && !isAdmin())) return notFound(app);
  const c = e.courseId ? findCourse(e.courseId) : null;
  const repeating = e.repeat && REPEATS[e.repeat];
  const next = repeating ? occurrences(e, todayStr(), addDays(todayStr(), 800)).slice(0, 6) : [];
  const shown = next[0] || e;
  app.innerHTML = '<div class="container narrow blog-page event-page">' +
    `<a href="#/calendar/${shown.start.slice(0, 7)}" class="muted small">← 行事曆</a>` +
    (isAdmin() ? ` · <a href="#/admin/event/${e.id}" class="link small">✎ 編輯此活動</a>` + (e.published ? '' : ' <span class="tag">（草稿）</span>') : '') +
    `<p class="tag"><i class="dot-sw ${typeClass(e.type)}"></i>${esc(e.type || '活動')}</p><h1 dir="auto">${esc(e.title)}</h1>` +
    '<div class="card pad event-facts">' +
    (repeating
      ? `<p><strong>時間</strong><span>🔁 ${esc(repeatText(e))}${e.allDay || !e.startTime ? '（全天）' : ` ${esc(e.startTime)}${e.endTime ? '–' + esc(e.endTime) : ''}`}</span></p>` +
        `<p><strong>日期</strong><span>${next.length ? '接下來：' + next.map((o) => esc(dateLabel(o.start))).join('、') : '已經全部結束'}</span></p>`
      : `<p><strong>時間</strong><span>${esc(whenText(e))}${e.allDay || !e.startTime ? '（全天）' : ''}</span></p>`) +
    (placeText(e) ? `<p><strong>地點</strong><span dir="auto">${esc(placeText(e))}</span></p>` : '') +
    (e.url ? `<p><strong>連結</strong><span><a class="link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a></span></p>` : '') +
    (c ? `<p><strong>課程</strong><span><a class="link" href="#/course/${c.id}">${esc(c.title)} →</a></span></p>` : '') +
    `<div class="lesson-nav"><a class="btn btn-sm" href="${esc(googleCalUrl(e))}" target="_blank" rel="noopener">＋ 加入 Google 日曆</a>` +
    '<button type="button" class="btn btn-ghost btn-sm" id="ics">⬇ 下載行事曆檔（Apple／Outlook）</button></div></div>' +
    (e.description ? `<div class="article">${renderArticle(e.description)}</div>` : '') + '</div>';
  app.querySelector('#ics').onclick = () => downloadIcs(e);
};

// 行事曆管理（管理者）
pages.eventAdmin = async (app) => {
  app.innerHTML = '<div class="container"><p class="muted">載入中…</p></div>';
  const list = await loadEvents(true);
  if (!document.body.contains(app)) return;
  const today = todayStr();
  // 即將舉行：顯示下一次的日期；已結束：依開始日期倒序
  const future = list.filter((e) => seriesEnd(e) >= today).map((e) => ({ ...(nextOccurrence(e) || e), published: e.published }))
    .sort((a, b) => a.start.localeCompare(b.start));
  const past = list.filter((e) => seriesEnd(e) < today).reverse();
  app.innerHTML = '<div class="container">' + adminTabs('events') +
    '<div class="row-between"><h1>行事曆</h1><span class="lesson-nav"><a class="btn btn-ghost btn-sm" href="#/calendar">查看行事曆</a><a class="btn btn-sm" href="#/admin/event/new">＋ 新增活動</a></span></div>' +
    '<p class="muted small">課程開課、講座、活動、節日都可以加到行事曆，也可以設定每日、每週、每兩週、每月重複。已發布的活動顯示在網站上方的「行事曆」頁，首頁也會列出最近 3 個。</p>' +
    '<h3>即將舉行</h3>' + (future.length ? '<div class="event-list">' + future.map(eventRow).join('') + '</div>' : '<p class="muted">沒有即將舉行的活動，按「＋ 新增活動」新增。</p>') +
    (past.length ? '<h3>已結束</h3><div class="event-list past">' + past.map(eventRow).join('') + '</div>' : '') + '</div>';
  // 管理頁點活動直接進編輯
  app.querySelectorAll('.event-row').forEach((a) => { a.href = a.getAttribute('href').replace('#/event/', '#/admin/event/'); });
};

pages.eventEdit = async (app, id, query = {}) => {
  const isNew = !id || id === 'new';
  await loadEvents(true);
  const src = isNew ? null : eventCache.find((x) => x.id === id);
  if (!isNew && !src) return notFound(app);
  if (!document.body.contains(app)) return;
  const blank = { title: '', type: query.course ? '課程' : '活動', start: query.date || todayStr(), end: '', allDay: false, startTime: '', endTime: '', city: '', location: '', url: '', courseId: query.course || '', description: '', repeat: '', repeatUntil: '', published: false };
  const e = isNew ? { ...blank, id: newId('e'), createdAt: Date.now() } : { ...blank, ...src };
  const field = (label, name, val, attrs = '') => `<label>${label}<input class="input" name="${name}" value="${esc(val)}" ${attrs}/></label>`;
  function draw() {
    app.innerHTML = `<div class="container editor"><a href="#/admin/events" class="muted small">← 行事曆管理</a><h1>${isNew ? '新增活動' : '編輯活動'}</h1>` +
      '<form id="ee" novalidate><div class="card pad">' +
      field('標題', 'title', e.title, 'required maxlength="200" placeholder="例如：開齋節聚會、新課程開課"') +
      `<label>類型<select class="input" name="type">${EVENT_TYPES.map((t) => `<option ${t === e.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>` +
      `<label>相關課程 <span class="muted small">可留空；選了之後活動頁會連到這門課</span><select class="input" name="courseId"><option value="">（無）</option>` +
      courses.map((c) => `<option value="${esc(c.id)}" ${c.id === e.courseId ? 'selected' : ''}>${esc(c.title)}</option>`).join('') + '</select></label>' +
      '<div class="two">' + field('開始日期', 'start', e.start, 'type="date" required') + field('結束日期 <span class="muted small">一天的活動可留空</span>', 'end', e.end, 'type="date"') + '</div>' +
      `<label class="check"><input type="checkbox" name="allDay" ${e.allDay ? 'checked' : ''}/> 全天活動</label>` +
      `<div class="two" id="times" ${e.allDay ? 'hidden' : ''}>` + field('開始時間', 'startTime', e.startTime, 'type="time"') + field('結束時間', 'endTime', e.endTime, 'type="time"') + '</div>' +
      '<div class="two">' + `<label>重複<select class="input" name="repeat">${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${k === (e.repeat || '') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` +
      `<span id="until" ${e.repeat ? '' : 'hidden'}>` + field('重複到 <span class="muted small">可留空＝一直重複</span>', 'repeatUntil', e.repeatUntil, 'type="date"') + '</span></div>' +
      `<p class="muted small" id="repeat-hint">${e.repeat ? esc(repeatText(e)) : ''}</p>` +
      '<div class="two">' + `<label>縣市 <span class="muted small">用來篩選地點</span><select class="input" name="city"><option value="">（未指定）</option>${CITIES.map((c) => `<option ${c === e.city ? 'selected' : ''}>${c}</option>`).join('')}</select></label>` +
      field('地點 <span class="muted small">可留空，例如：台北清真寺</span>', 'location', e.location, 'maxlength="200"') + '</div>' +
      field('連結 <span class="muted small">可留空，例如報名表、直播網址</span>', 'url', e.url, 'placeholder="https://…"') +
      `<label class="check"><input type="checkbox" name="published" ${e.published ? 'checked' : ''}/> 發布（取消勾選則是草稿，只有管理者看得到）</label></div>` +
      '<div class="card pad"><h3>活動說明 <span class="muted small">可留空</span></h3>' + mediaButton('description') +
      `<textarea class="input textarea" name="description" rows="8" placeholder="活動內容、注意事項…">${esc(e.description)}</textarea>` +
      `<details class="article-preview" id="epv" ${e.description ? '' : 'hidden'} open><summary class="small">預覽</summary><div class="article">${renderArticle(e.description)}</div></details></div>` +
      '<div class="editor-actions"><span class="autosave muted small" id="autosave">修改後會自動儲存</span>' +
      '<button class="btn" id="save">完成，查看活動 →</button>' +
      '<button type="button" class="btn btn-ghost" id="del">刪除活動</button></div></form></div>';
  }
  function collect() {
    const f = app.querySelector('#ee');
    if (!f) return;
    ['title', 'type', 'courseId', 'start', 'end', 'startTime', 'endTime', 'city', 'location', 'url', 'repeat', 'repeatUntil'].forEach((k) => { e[k] = f[k].value.trim(); });
    e.allDay = f.allDay.checked;
    e.published = f.published.checked;
    e.description = f.description.value.replace(/\s+$/, '');
  }
  let timer = 0, chain = Promise.resolve(), created = !isNew;
  const setStatus = (t, warn = false) => { const el = app.querySelector('#autosave'); if (el) { el.textContent = t; el.classList.toggle('expired', warn); } };
  function autosave(delay) { clearTimeout(timer); setStatus('編輯中…'); timer = setTimeout(() => { saveNow(); }, delay); }
  function saveNow() {
    clearTimeout(timer); timer = 0;
    collect();
    const problem = !e.title ? '請輸入標題，才會自動儲存'
      : !/^\d{4}-\d{2}-\d{2}$/.test(e.start) ? '請選擇開始日期'
      : e.end && e.end < e.start ? '結束日期不能早於開始日期'
      : !e.allDay && e.startTime && e.endTime && e.endTime < e.startTime && (!e.end || e.end === e.start) ? '結束時間不能早於開始時間'
      : e.repeat && e.repeatUntil && e.repeatUntil < e.start ? '「重複到」不能早於開始日期'
      : e.url && !/^https?:\/\/\S+$/i.test(e.url) ? '連結要以 https:// 開頭' : '';
    if (problem) { setStatus('⚠ ' + problem, true); return Promise.resolve(false); }
    const data = { title: e.title, type: e.type, start: e.start, end: e.end && e.end !== e.start ? e.end : '', allDay: e.allDay, startTime: e.allDay ? '' : e.startTime, endTime: e.allDay ? '' : e.endTime,
      city: e.city, location: e.location, url: e.url, courseId: e.courseId, repeat: e.repeat || '', repeatUntil: e.repeat ? e.repeatUntil : '', description: e.description, published: e.published, createdAt: e.createdAt || Date.now(), updatedAt: Date.now() };
    setStatus('儲存中…');
    chain = chain.then(async () => {
      await fb.setDoc(fb.doc(db, COL.events, e.id), data);
      if (eventCache) { const i = eventCache.findIndex((x) => x.id === e.id); if (i > -1) eventCache[i] = { ...data, id: e.id }; else eventCache.push({ ...data, id: e.id }); }
      if (!created) { created = true; history.replaceState(null, '', '#/admin/event/' + e.id); }
      setStatus(`✓ 已自動儲存（${fmtTime(Date.now()).slice(-5)}）`);
      return true;
    }).catch((err) => { console.error(err); setStatus('⚠ 儲存失敗：' + (err.code || err.message), true); return false; });
    return chain;
  }
  function bind() {
    const f = app.querySelector('#ee');
    f.addEventListener('input', (ev) => {
      if (ev.target.name === 'description') {
        const pv = app.querySelector('#epv');
        pv.hidden = !ev.target.value.trim();
        pv.querySelector('.article').innerHTML = renderArticle(ev.target.value);
      }
      autosave(1000);
    });
    f.addEventListener('change', (ev) => {
      if (ev.target.name === 'allDay') app.querySelector('#times').hidden = ev.target.checked;
      if (['repeat', 'start', 'repeatUntil'].includes(ev.target.name)) {
        collect();
        app.querySelector('#until').hidden = !e.repeat;
        app.querySelector('#repeat-hint').textContent = e.repeat && /^\d{4}-\d{2}-\d{2}$/.test(e.start) ? repeatText(e) : '';
      }
      // 選了課程而標題還空著：用課程名稱當標題
      if (ev.target.name === 'courseId' && ev.target.value && !f.title.value.trim()) { const c = findCourse(ev.target.value); if (c) f.title.value = c.title; }
      autosave(300);
    });
    bindMediaButtons(app);
    app.querySelector('#del').onclick = async () => {
      if (!confirm(`確定刪除「${e.title || '這個活動'}」？此動作無法復原。`)) return;
      clearTimeout(timer); timer = 0;
      try {
        await chain;
        await fb.deleteDoc(fb.doc(db, COL.events, e.id));
        if (eventCache) eventCache = eventCache.filter((x) => x.id !== e.id);
        toast('活動已刪除');
        go('/admin/events');
      } catch (err) { toast('刪除失敗：' + (err.code || err.message)); }
    };
    f.onsubmit = async (ev) => { ev.preventDefault(); if (await saveNow()) go('/event/' + e.id); };
  }
  window.addEventListener('hashchange', () => { if (timer) saveNow(); }, { once: true });
  draw();
  bind();
};

// 文章管理（管理者）
pages.blogAdmin = async (app) => {
  app.innerHTML = '<div class="container"><p class="muted">載入中…</p></div>';
  const list = await loadBlog(true);
  if (!document.body.contains(app)) return;
  app.innerHTML = '<div class="container">' + adminTabs('articles') +
    '<div class="row-between"><h1>文章管理</h1><a class="btn btn-sm" href="#/admin/article/new">＋ 新增文章</a></div>' +
    '<p class="muted small">文章獨立於課程，顯示在網站上方的「文章」頁，首頁也會列出最新 3 篇。已發布的文章不用登入就能閱讀。</p>' +
    (list.length ? '<div class="admin-list">' + list.map((a) =>
      `<div class="card admin-row blog-row"><div class="pad"><strong>${esc(a.title)}</strong>` +
      `<p class="muted small">${[a.category, fmtDate(a.createdAt), a.published ? '已發布' : '草稿'].filter(Boolean).map(esc).join(' · ')}</p>` +
      `<div class="lesson-nav"><a class="btn btn-sm" href="#/admin/article/${a.id}">編輯</a><a class="btn btn-ghost btn-sm" href="#/article/${a.id}">查看</a></div></div></div>`).join('') + '</div>'
      : '<p class="muted">還沒有文章，按「＋ 新增文章」開始寫第一篇。</p>') + '</div>';
};

pages.blogEdit = async (app, id) => {
  const isNew = !id || id === 'new';
  await loadBlog(true);
  const src = isNew ? null : findPost(id);
  if (!isNew && !src) return notFound(app);
  if (!document.body.contains(app)) return;
  const a = isNew
    ? { id: newId('a'), title: '', summary: '', category: '', cover: '', url: '', text: '', published: false, createdAt: Date.now() }
    : { summary: '', category: '', cover: '', url: '', text: '', ...src };
  const field = (label, name, val, attrs = '') => `<label>${label}<input class="input" name="${name}" value="${esc(val)}" ${attrs}/></label>`;
  function draw() {
    app.innerHTML = `<div class="container editor"><a href="#/admin/articles" class="muted small">← 文章管理</a><h1>${isNew ? '新增文章' : '編輯文章'}</h1>` +
      '<form id="ae" novalidate><div class="card pad">' +
      field('文章連結 <span class="muted small">貼上外部文章網址，會自動填好標題、摘要、封面；可留空</span>', 'url', a.url, 'placeholder="https://…"') +
      '<div class="media-tools"><button type="button" class="btn btn-ghost btn-sm" id="fill">↻ 從連結重新填寫標題、摘要、封面</button><span class="muted small" id="fill-state"></span></div>' +
      field('標題', 'title', a.title, 'required maxlength="200"') +
      field('摘要 <span class="muted small">顯示在文章列表，可留空</span>', 'summary', a.summary, 'maxlength="300"') +
      field('分類 <span class="muted small">可留空，例如：信仰、生活、節日</span>', 'category', a.category) +
      `<label class="check"><input type="checkbox" name="published" ${a.published ? 'checked' : ''}/> 發布（取消勾選則是草稿，只有管理者看得到）</label></div>` +
      '<div class="card pad"><h3>封面照片 <span class="muted small">可留空</span></h3>' +
      (a.cover ? `<img class="blog-cover" src="${esc(a.cover)}" alt=""><button type="button" class="btn btn-ghost btn-sm" id="cover-remove">移除封面照片</button>` : '') +
      '<label>上傳封面照片 <span class="muted small">建議 16:9 橫向圖片，會自動裁切成 960×540</span><input class="input" type="file" accept="image/*" id="cover-file"/></label></div>' +
      '<div class="card pad"><h3>內容</h3><p class="muted small">有文章連結時，讀者會在網站上直接看到那篇文章；也可以在這裡自己寫內容（顯示在連結文章下方），或只寫內容不放連結。</p>' +
      `<label>文章內容 <span class="muted small">可留空。支援 # 標題、**粗體**、- 清單、&gt; 引用、[文字](網址)、![說明](圖片網址)</span>` +
      `</label>` + mediaButton('text') +
      `<textarea class="input textarea" name="text" rows="14" placeholder="在這裡寫文章內容…">${esc(a.text)}</textarea>` +
      `<details class="article-preview" id="apv" ${a.text ? '' : 'hidden'} open><summary class="small">預覽</summary><div class="article">${renderArticle(a.text)}</div></details></div>` +
      '<div class="editor-actions"><span class="autosave muted small" id="autosave">修改後會自動儲存</span>' +
      '<button class="btn" id="save">完成，查看文章 →</button>' +
      '<button type="button" class="btn btn-ghost" id="del">刪除文章</button></div></form></div>';
  }
  function collect() {
    const f = app.querySelector('#ae');
    if (!f) return;
    a.title = f.title.value.trim();
    a.summary = f.summary.value.trim();
    a.category = f.category.value.trim();
    a.published = f.published.checked;
    a.url = f.url.value.trim();
    a.text = f.text.value.replace(/\s+$/, '');
  }
  let timer = 0, chain = Promise.resolve(), created = !isNew;
  const setStatus = (t, warn = false) => { const el = app.querySelector('#autosave'); if (el) { el.textContent = t; el.classList.toggle('expired', warn); } };
  function autosave(delay) { clearTimeout(timer); setStatus('編輯中…'); timer = setTimeout(() => { saveNow(); }, delay); }
  function saveNow() {
    clearTimeout(timer); timer = 0;
    collect();
    const problem = !a.title ? '請輸入標題，才會自動儲存'
      : a.url && !/^https?:\/\/\S+$/i.test(a.url) ? '文章連結要以 https:// 開頭'
      : !a.url && !a.text ? '請貼上文章連結或寫文章內容' : '';
    if (problem) { setStatus('⚠ ' + problem, true); return Promise.resolve(false); }
    const data = { title: a.title, summary: a.summary, category: a.category, cover: a.cover || '', url: a.url, text: a.text, published: a.published, createdAt: a.createdAt || Date.now(), updatedAt: Date.now() };
    setStatus('儲存中…');
    chain = chain.then(async () => {
      await fb.setDoc(fb.doc(db, COL.blog, a.id), data);
      if (blogCache) { const i = blogCache.findIndex((x) => x.id === a.id); if (i > -1) blogCache[i] = { ...data, id: a.id }; else blogCache.unshift({ ...data, id: a.id }); }
      if (!created) { created = true; history.replaceState(null, '', '#/admin/article/' + a.id); }
      setStatus(`✓ 已自動儲存（${fmtTime(Date.now()).slice(-5)}）`);
      return true;
    }).catch((err) => { console.error(err); setStatus('⚠ 儲存失敗：' + (err.code || err.message), true); return false; });
    return chain;
  }
  // 貼上文章連結：由 Cloud Function 讀取網頁的標題、摘要、封面圖片
  // overwrite = false：只填空白的欄位（貼上時自動）；true：全部換成連結的資料（按按鈕）
  let lastFilled = '';
  async function fillFromLink(overwrite) {
    collect();
    const st = app.querySelector('#fill-state');
    if (!/^https?:\/\/\S+$/i.test(a.url)) { if (overwrite) toast('請先貼上以 https:// 開頭的文章連結'); return; }
    if (!overwrite && (lastFilled === a.url || (a.title && a.summary && a.cover))) return;
    lastFilled = a.url;
    st.textContent = '讀取文章資料中…';
    try {
      const fn = await import(FIREBASE + 'firebase-functions.js');
      const r = (await fn.httpsCallable(fn.getFunctions(fbApp, 'asia-east1'), 'islamLinkPreview')({ url: a.url })).data;
      collect(); // 讀取期間可能又打了字
      const filled = [];
      if (r.title && (overwrite || !a.title)) { a.title = r.title; filled.push('標題'); }
      if (r.summary && (overwrite || !a.summary)) { a.summary = r.summary; filled.push('摘要'); }
      if (r.image && (overwrite || !a.cover)) {
        try {
          const blob = await (await fetch(`data:${r.image.type};base64,${r.image.data}`)).blob();
          a.cover = await resizeCover(blob);
          filled.push('封面');
        } catch (e) { console.warn('封面圖片無法使用', e); }
      }
      draw(); bind();
      app.querySelector('#fill-state').textContent = filled.length ? `✓ 已自動填入${filled.join('、')}，請檢查後再發布` : '這個網頁沒有可以自動填入的資料';
      if (filled.length) autosave(0);
    } catch (e) {
      console.error(e);
      st.textContent = '';
      toast('無法讀取這個連結：' + (e.message && !/internal/i.test(e.code || '') ? e.message : '請稍後再試，或手動填寫'));
    }
  }

  function bind() {
    const f = app.querySelector('#ae');
    f.url.addEventListener('change', () => fillFromLink(false));
    f.url.addEventListener('paste', () => setTimeout(() => fillFromLink(false), 0));
    app.querySelector('#fill').onclick = () => fillFromLink(true);
    f.addEventListener('input', (e) => {
      if (e.target.name === 'text') {
        const pv = app.querySelector('#apv');
        pv.hidden = !e.target.value.trim();
        pv.querySelector('.article').innerHTML = renderArticle(e.target.value);
      }
      autosave(1000);
    });
    f.addEventListener('change', (e) => { if (e.target.id !== 'cover-file') autosave(300); });
    const fileInput = app.querySelector('#cover-file');
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try { collect(); a.cover = await resizeCover(file); draw(); bind(); autosave(0); toast('封面已更新'); }
      catch (e) { toast('無法讀取這張圖片'); }
    };
    const rm = app.querySelector('#cover-remove');
    if (rm) rm.onclick = () => { collect(); a.cover = ''; draw(); bind(); autosave(0); };
    bindMediaButtons(app);
    app.querySelector('#del').onclick = async () => {
      if (!confirm(`確定刪除「${a.title || '這篇文章'}」？此動作無法復原。`)) return;
      clearTimeout(timer); timer = 0;
      try {
        await chain;
        await fb.deleteDoc(fb.doc(db, COL.blog, a.id));
        if (blogCache) blogCache = blogCache.filter((x) => x.id !== a.id);
        toast('文章已刪除');
        go('/admin/articles');
      } catch (err) { toast('刪除失敗：' + (err.code || err.message)); }
    };
    f.onsubmit = async (e) => { e.preventDefault(); if (await saveNow()) go('/article/' + a.id); };
  }
  window.addEventListener('hashchange', () => { if (timer) saveNow(); }, { once: true });
  draw();
  bind();
};

// 課程介紹頁（公開）
pages.course = (app, id) => {
  const c = findCourse(id);
  if (!c || (c.published === false && !isAdmin())) return notFound(app);
  const mine = owns(c.id);
  const n = c.unlisted ? 0 : stepOf(c);
  const prev = n > 1 ? listedCourses().filter((x) => !x.unlisted)[n - 2] : null;
  let box;
  if (mine) {
    box = `<p class="owned">✓ ${isAdmin() && !hasJoined(c.id) ? '管理者' : '已加入'}（進度 ${progress(c)}%）</p>` +
      `<a class="btn btn-block" href="#/learn/${c.id}">${progress(c) ? '繼續學習' : '開始上課'}</a>`;
  } else if (!user) {
    box = '<p><span class="price free">免費</span></p>' +
      `<a class="btn btn-block" href="#/login?next=/course/${c.id}">登入後免費學習</a>` +
      '<p class="muted small">登入後按「加入課程」即可觀看。</p>';
  } else if (!isVerified()) {
    box = '<p><span class="price free">免費</span></p><a class="btn btn-block" href="#/verify">請先驗證 Email</a>' +
      '<p class="muted small">完成 Email 驗證後即可加入課程。</p>';
  } else {
    box = '<p><span class="price free">免費</span></p><button class="btn btn-block" id="join">＋ 加入課程</button>' +
      '<p class="muted small">加入後這門課會出現在「我的學習區」，可以隨時觀看。</p>';
  }
  // 循序漸進：前一階段還沒完成時，溫和提醒（不強制）
  const hint = prev && !(owns(prev.id) && progress(prev) === 100)
    ? `<div class="notice small">建議先完成第 ${n - 1} 階段：<a class="link" href="#/course/${prev.id}">${esc(prev.title)}</a></div>` : '';

  app.innerHTML = '<div class="container course-page">' +
    `<div><a href="#/" class="muted small">← 學習地圖</a>` +
    (isAdmin() ? ` · <a href="#/admin/${c.id}" class="link small">✎ 編輯此課程</a>` + (c.published === false ? ' <span class="tag">（未上架）</span>' : '') : '') +
    (n ? `<p class="step-label">第 ${n} 階段</p>` : '') +
    `<h1>${esc(c.title)}</h1><p class="lead muted">${esc(c.subtitle)}</p>` +
    `<p class="muted small">${[c.instructor ? '講師 ' + esc(c.instructor) : '', esc(c.level), lessonsOf(c).length + ' 個單元'].filter(Boolean).join(' · ')}${minutesText(c)}</p>` + hint +
    (c.trailer ? '<h2>課程預告</h2>' + youtubeEmbed(c.trailer) : '') +
    `<h2>課程介紹</h2><div class="article course-intro">${renderArticle(c.description)}</div>` +
    ((c.outcomes || []).length ? `<h2>你將學到</h2><ul class="checks">${c.outcomes.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : '') +
    '<h2>課程內容</h2>' + c.chapters.map((ch) =>
      `<div class="card chapter"><strong>${esc(ch.title)}</strong>` +
      ch.lessons.map((l) => `<div class="lesson"><span>${mine ? (l.kind === 'article' ? ICON.fileText : '▶') : '🔒'} ${esc(l.title)}</span><span class="muted small">${lessonTime(l)}</span></div>`).join('') +
      '</div>').join('') +
    '<h2 id="talk">💬 心得分享與交流</h2><div class="talk" id="posts"></div>' +
    '</div>' +
    `<aside class="card buy">${thumb(c)}<div class="pad">${box}${countText(c) ? `<p class="muted small center">${countText(c)}</p>` : ''}</div></aside></div>`;
  const joinBtn = app.querySelector('#join');
  if (joinBtn) joinBtn.onclick = () => joinCourse(c, joinBtn);
  renderPosts(app.querySelector('#posts'), c);
};

/* ---------------- 心得分享與交流 ----------------
 * islam_posts/{課程id}/posts/{留言id} = { uid, name, text, createdAt, replyTo, admin }
 * 登入的人都看得到；加入課程的學生和管理者可以發言、回覆；作者可修改、刪除自己的留言，管理者可刪除任何留言 */
const postName = () => (user.displayName || '').trim().slice(0, 40) || (user.email.split('@')[0].slice(0, 3) + '***');
async function renderPosts(el, c) {
  if (!el) return;
  if (!user) {
    el.innerHTML = `<div class="card pad muted small">登入後就能看到大家的學習心得，加入課程後也可以一起分享交流。<a class="link" href="#/login?next=/course/${c.id}">登入 →</a></div>`;
    return;
  }
  if (!isVerified()) {
    el.innerHTML = '<div class="card pad muted small">完成 Email 驗證後就能看到交流區。<a class="link" href="#/verify">前往驗證 →</a></div>';
    return;
  }
  const canPost = isAdmin() || hasJoined(c.id);
  const col = fb.collection(db, COL.posts, c.id, 'posts');
  let posts = [], replying = '', editing = '';
  el.innerHTML = '<p class="muted small">載入交流區…</p>';
  try {
    const snap = await fb.getDocs(col);
    posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error(e);
    el.innerHTML = '<p class="muted small">交流區暫時無法載入，請稍後再試。</p>';
    return;
  }
  const mineOf = (p) => p.uid === user.uid;
  const box = (id, ph, val = '', btn = '發表') =>
    `<form class="post-form" data-form="${id}"><textarea class="input textarea" rows="${id === 'new' ? 4 : 3}" maxlength="2000" placeholder="${ph}">${esc(val)}</textarea>` +
    `<div class="post-actions">${id !== 'new' ? '<button type="button" class="btn btn-ghost btn-sm" data-act="cancel">取消</button>' : ''}<button class="btn btn-sm">${btn}</button></div></form>`;
  const item = (p, isReply) => {
    const acts = [];
    if (!isReply && canPost) acts.push(`<button type="button" class="link small" data-act="reply" data-id="${p.id}">回覆</button>`);
    if (mineOf(p)) acts.push(`<button type="button" class="link small" data-act="edit" data-id="${p.id}">編輯</button>`);
    if (mineOf(p) || isAdmin()) acts.push(`<button type="button" class="link small" data-act="del" data-id="${p.id}">刪除</button>`);
    return `<div class="post${isReply ? ' reply' : ''}${mineOf(p) ? ' mine' : ''}">` +
      `<div class="post-meta"><strong>${esc(p.name || '學員')}</strong>${p.admin ? ' <span class="tag">管理者</span>' : ''}` +
      `<span class="muted small">${fmtTime(p.createdAt)}${p.editedAt ? '（已編輯）' : ''}</span></div>` +
      (editing === p.id ? box('edit:' + p.id, '', p.text, '儲存') : `<div class="post-text">${linkify(esc(p.text))}</div>`) +
      (acts.length && editing !== p.id ? `<div class="post-acts">${acts.join('')}</div>` : '') + '</div>';
  };
  const draw = () => {
    const tops = posts.filter((p) => !p.replyTo).sort((a, b) => b.createdAt - a.createdAt);
    const repliesOf = (id) => posts.filter((p) => p.replyTo === id).sort((a, b) => a.createdAt - b.createdAt);
    el.innerHTML =
      (canPost ? box('new', '分享你的學習心得、感想或問題…（大家都看得到）')
        : '<div class="card pad muted small">加入這門課程後，就可以分享心得、參與交流。</div>') +
      (tops.length ? tops.map((p) => '<div class="card thread">' + item(p, false) +
        repliesOf(p.id).map((r) => item(r, true)).join('') +
        (replying === p.id ? '<div class="post reply">' + box('reply:' + p.id, '寫下你的回覆…', '', '回覆') + '</div>' : '') + '</div>').join('')
        : '<p class="muted small">還沒有人分享，成為第一個分享心得的人吧！</p>');
    const ta = replying ? el.querySelector(`[data-form="reply:${replying}"] textarea`) : editing ? el.querySelector(`[data-form="edit:${editing}"] textarea`) : null;
    if (ta) ta.focus();
  };
  el.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'reply') { replying = replying === id ? '' : id; editing = ''; draw(); }
    if (act === 'edit') { editing = id; replying = ''; draw(); }
    if (act === 'cancel') { replying = editing = ''; draw(); }
    if (act === 'del') {
      if (!confirm('確定刪除這則留言？')) return;
      // 管理者刪除主留言時，一併刪除底下的回覆
      const ids = [id, ...(isAdmin() ? posts.filter((p) => p.replyTo === id).map((p) => p.id) : [])];
      try {
        for (const x of ids) await fb.deleteDoc(fb.doc(db, COL.posts, c.id, 'posts', x));
        posts = posts.filter((p) => !ids.includes(p.id));
        draw(); toast('已刪除');
      } catch (err) { toast('刪除失敗：' + (err.code || err.message)); }
    }
  };
  el.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target, kind = form.dataset.form, text = form.querySelector('textarea').value.trim();
    if (!text) return toast('請輸入內容');
    const btn = form.querySelector('button:not([type=button])');
    btn.disabled = true;
    try {
      if (kind.startsWith('edit:')) {
        const id = kind.slice(5), editedAt = Date.now();
        await fb.setDoc(fb.doc(db, COL.posts, c.id, 'posts', id), { text, editedAt }, { merge: true });
        Object.assign(posts.find((p) => p.id === id), { text, editedAt });
        editing = '';
      } else {
        const p = { uid: user.uid, name: postName(), text, createdAt: Date.now(), replyTo: kind.startsWith('reply:') ? kind.slice(6) : '', admin: isAdmin() };
        const id = newId('p');
        await fb.setDoc(fb.doc(db, COL.posts, c.id, 'posts', id), p);
        posts.push({ id, ...p });
        replying = '';
        toast(p.replyTo ? '已回覆' : '已發表');
      }
      draw();
    } catch (err) {
      btn.disabled = false;
      toast('送出失敗：' + (err.code || err.message));
    }
  };
  draw();
}

// 登入 / 註冊
pages.login = (app, _, query) => {
  const next = /^\/[^/]/.test(query.next || '') ? query.next : '/my';
  if (!configured) return setupNotice(app);
  if (!fb) {
    app.innerHTML = '<div class="container narrow"><h1>無法連線</h1><div class="card pad"><p>登入服務目前無法連線，請檢查網路後重新整理頁面。</p><button class="btn btn-sm" onclick="location.reload()">重新整理</button></div></div>';
    return;
  }
  if (user && isVerified()) return go(next);
  if (user) return pages.verify(app);

  let mode = 'login';
  function draw() {
    const reg = mode === 'register';
    app.innerHTML = `<div class="container narrow"><h1>${reg ? '建立帳號' : '登入'}</h1>` +
      '<div class="card pad">' +
      '<button class="btn btn-google btn-block" id="google"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>使用 Google 帳號登入</button>' +
      '<div class="divider">或使用 Email</div>' +
      '<form id="auth" novalidate>' +
      (reg ? '<label>姓名<input class="input" name="fullname" autocomplete="name" required /></label>' : '') +
      '<label>Email<input class="input" name="email" type="email" autocomplete="email" required /></label>' +
      `<label>密碼<input class="input" name="pw" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required /></label>` +
      `<button class="btn btn-block">${reg ? '註冊' : '登入'}</button></form>` +
      `<p class="center small">${reg ? '已經有帳號？' : '還沒有帳號？'} <button type="button" class="link" id="switch">${reg ? '登入' : '用 Email 註冊'}</button>` +
      (reg ? '' : ' · <button type="button" class="link" id="forgot">忘記密碼</button>') + '</p>' +
      '</div></div>';

    const f = app.querySelector('#auth');
    app.querySelector('#switch').onclick = () => { mode = reg ? 'login' : 'register'; draw(); };
    app.querySelector('#google').onclick = async () => {
      try {
        await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
        toast('登入成功'); // 登入狀態改變時會自動重新整理畫面並前往下一頁
      } catch (e) { toast(authError(e)); }
    };
    const forgot = app.querySelector('#forgot');
    if (forgot) forgot.onclick = async () => {
      const email = f.email.value.trim();
      if (!email) return toast('請先在上方輸入你的 Email');
      try { await fb.sendPasswordResetEmail(auth, email); } catch (e) { /* 不透露帳號是否存在 */ }
      toast('若此 Email 已註冊，重設密碼信已寄出（請一併檢查垃圾郵件）');
    };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const email = f.email.value.trim(), pw = f.pw.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Email 格式不正確');
      if (pw.length < 6) return toast('密碼至少 6 個字元');
      const btn = f.querySelector('button');
      btn.disabled = true;
      try {
        if (reg) {
          if (!f.fullname.value.trim()) { btn.disabled = false; return toast('請輸入姓名'); }
          const cred = await fb.createUserWithEmailAndPassword(auth, email, pw);
          await fb.updateProfile(cred.user, { displayName: f.fullname.value.trim() });
          await fb.sendEmailVerification(cred.user);
          render(); // 顯示「請驗證 Email」頁
        } else {
          await fb.signInWithEmailAndPassword(auth, email, pw);
        }
      } catch (err) {
        btn.disabled = false;
        toast(authError(err));
      }
    };
  }
  draw();
};

// Email 註冊者需先驗證信箱（避免有人冒用別人的 Email 取得課程）
pages.verify = (app) => {
  if (!user) return go('/login');
  if (isVerified()) return go('/my');
  app.innerHTML = '<div class="container narrow"><h1>請驗證你的 Email</h1><div class="card pad">' +
    `<p>我們已寄送驗證信到 <strong>${esc(user.email)}</strong>，請點信中的連結完成驗證，再回到這裡。</p>` +
    '<div class="notice">📬 沒收到信嗎？請檢查<strong>垃圾郵件</strong>或<strong>促銷內容</strong>資料夾。寄件者通常是 noreply@…firebaseapp.com，找到後可標記為「不是垃圾郵件」。</div>' +
    '<button class="btn btn-block" id="check">我已完成驗證</button>' +
    '<p class="center small"><button class="link" id="resend">重新寄送驗證信</button></p></div></div>';
  app.querySelector('#check').onclick = async () => {
    await user.reload();
    if (!auth.currentUser.emailVerified) return toast('尚未完成驗證，請檢查信箱（包含垃圾郵件）');
    user = auth.currentUser;
    await user.getIdToken(true); // 取得含驗證狀態的新權杖
    accessReady = loadAccess();
    await accessReady;
    toast('驗證完成！');
    go('/my');
  };
  app.querySelector('#resend').onclick = async () => {
    try { await fb.sendEmailVerification(user); toast('驗證信已重新寄出，請一併檢查垃圾郵件'); } catch (e) { toast(authError(e)); }
  };
};

// 我的學習區：學生加入的課程，可以拖曳調整擺放順序
pages.my = (app) => {
  if (!user) return go('/login?next=/my');
  if (!isVerified()) return pages.verify(app);
  const all = myCourses();
  const has = (id) => all.some((c) => c.id === id);
  // 資料夾裡只留還在學習區的課程；同一門課只放一個地方
  const filed = new Set();
  const folders = myFolders.map((f) => ({ ...f, courses: (f.courses || []).filter((id) => has(id) && !filed.has(id) && filed.add(id)) }));
  const unfiled = all.filter((c) => !filed.has(c.id));
  const collapsedKey = 'isl_folds_' + user.uid;
  let collapsed = [];
  try { collapsed = JSON.parse(localStorage.getItem(collapsedKey)) || []; } catch (e) {}

  const card = (c, fid) => {
    const p = progress(c), n = c.unlisted ? 0 : stepOf(c);
    const hay = [c.title, c.subtitle, c.category, c.level, c.instructor, ...lessonsOf(c).map((l) => l.title)].join(' ').toLowerCase();
    return `<div class="card step my-card" data-id="${esc(c.id)}" data-q="${esc(hay)}">` +
      '<div class="my-tools"><span class="drag-handle" title="拖曳調整順序或移到資料夾" aria-label="拖曳">⠿</span>' +
      '<button type="button" class="icon-btn" data-move="-1" aria-label="往上移" title="往上移">↑</button>' +
      '<button type="button" class="icon-btn" data-move="1" aria-label="往下移" title="往下移">↓</button></div>' +
      `<a href="#/learn/${c.id}" draggable="false">${thumb(c)}</a><div class="step-body">` +
      `<span class="tag">${[n ? `第 ${n} 階段` : '', c.category, c.level].filter(Boolean).map(esc).join(' · ')}</span>` +
      `<h3><a href="#/learn/${c.id}" draggable="false">${esc(c.title)}</a></h3>` +
      `<p class="muted small">${esc(c.subtitle || '')}</p><p class="muted small">${lessonsOf(c).length} 個單元${minutesText(c)}</p>` +
      `<div class="bar"><i style="width:${p}%"></i></div><p class="small owned">${p === 100 ? '✓ 已完成' : `進度 ${p}%`}</p>` +
      `<label class="small muted move-folder">📁 <select data-folder-pick aria-label="移到資料夾"><option value="">未分類</option>` +
      folders.map((f) => `<option value="${esc(f.id)}"${f.id === fid ? ' selected' : ''}>${esc(f.name)}</option>`).join('') + '</select></label></div>' +
      '<button type="button" class="icon-btn my-leave" data-leave aria-label="移出學習區" title="移出學習區">✕</button></div>';
  };
  const folderBox = (f) => {
    const list = f.courses.map((id) => all.find((c) => c.id === id));
    return `<section class="folder${collapsed.includes(f.id) ? ' closed' : ''}" data-fid="${esc(f.id)}">` +
      `<div class="folder-head"><button type="button" class="folder-toggle" data-toggle aria-label="展開或收合">▾</button>` +
      `<strong class="folder-name">📁 ${esc(f.name)}</strong><span class="muted small">${list.length} 門課</span>` +
      '<span class="folder-actions"><button type="button" class="btn btn-ghost btn-sm" data-rename>重新命名</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-delfolder>刪除資料夾</button></span></div>' +
      `<div class="path my-list" data-list="${esc(f.id)}">${list.map((c) => card(c, f.id)).join('')}` +
      '<p class="folder-empty muted small">把課程拖到這裡，或在課程的「📁」選擇這個資料夾。</p></div></section>';
  };

  app.innerHTML = '<div class="container"><div class="row-between"><h1>我的學習區</h1>' +
    '<span class="lesson-nav">' + exportMenu('export-all', '匯出全部筆記') +
    '<button type="button" class="btn btn-ghost btn-sm" id="newfolder">＋ 新增資料夾</button>' +
    '<a class="btn btn-ghost btn-sm" href="#/">＋ 加入更多課程</a>' +
    '<a class="btn btn-ghost btn-sm" href="#/account">⚙ 帳號設定</a></span></div>' +
    (all.length
      ? '<input class="input my-search" id="myq" type="search" placeholder="搜尋我的課程…" aria-label="搜尋我的課程" autocomplete="off"/>' +
        '<p class="muted small" id="myhint">按住 ⠿ 拖曳可調整順序、移進或移出資料夾；也可以按 ↑ ↓，或在課程的「📁」選擇資料夾。會自動儲存。</p>' +
        '<p class="muted" id="mynone" hidden>找不到符合的課程。</p>' +
        '<div id="area">' + folders.map(folderBox).join('') +
        (folders.length ? '<h3 class="unfiled-title">未分類</h3>' : '') +
        `<div class="path my-list" data-list="">${unfiled.map((c) => card(c, '')).join('')}</div></div>`
      : '<div class="card pad"><p>你的學習區還沒有課程。</p>' +
        '<p class="muted small">在學習地圖的課程卡片按「＋ 加入學習區」，或到課程頁按「加入課程」。建議從第 1 階段開始。</p>' +
        '<a href="#/" class="btn btn-sm">查看學習地圖</a></div>') + '</div>';

  const area = app.querySelector('#area');
  // 從畫面讀出目前的排列並儲存
  let saving = Promise.resolve();
  const snapshot = () => {
    const ids = (list) => [...list.querySelectorAll(':scope > .my-card')].map((el) => el.dataset.id);
    const order = area ? ids(area.querySelector('.my-list[data-list=""]')) : [];
    const fs = [...(area ? area.querySelectorAll('.folder') : [])].map((sec) => {
      const f = folders.find((x) => x.id === sec.dataset.fid);
      return { id: f.id, name: f.name, courses: ids(sec.querySelector('.my-list')) };
    });
    return { order, folders: fs };
  };
  const persist = (redraw = false) => {
    const { order, folders: fs } = area ? snapshot() : { order: myOrder, folders };
    fs.forEach((f) => { const o = folders.find((x) => x.id === f.id); if (o) o.courses = f.courses; });
    saving = saving.then(() => saveArea(order, fs)).then(() => { if (redraw) pages.my(app); })
      .catch((err) => toast('儲存失敗：' + (err.code || err.message) + '（請確認已部署最新的 Firestore 規則）'));
  };
  const saveFolders = (fs, order) => {
    saving = saving.then(() => saveArea(order, fs)).then(() => pages.my(app))
      .catch((err) => toast('儲存失敗：' + (err.code || err.message) + '（請確認已部署最新的 Firestore 規則）'));
  };

  bindExportMenu(app.querySelector('#export-all'), (fmt) => exportNotes(all, `my-notes-${fmtTime(Date.now()).slice(0, 10).replace(/\//g, '')}`, fmt));
  app.querySelector('#newfolder').onclick = () => {
    const name = (prompt('資料夾名稱') || '').trim().slice(0, 40);
    if (!name) return;
    if (folders.length >= 30) return toast('資料夾最多 30 個');
    const cur = area ? snapshot() : { order: unfiled.map((c) => c.id), folders: [] };
    saveFolders([...cur.folders, { id: newId('f'), name, courses: [] }], cur.order);
  };
  if (!area) return;

  // 搜尋：只顯示符合的課程；搜尋時暫停排序
  const hint = app.querySelector('#myhint'), none = app.querySelector('#mynone');
  const hintText = hint.textContent;
  app.querySelector('#myq').oninput = (e) => {
    const words = e.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    area.querySelectorAll('.my-card').forEach((cardEl) => {
      const ok = words.every((w) => cardEl.dataset.q.includes(w));
      cardEl.hidden = !ok;
      if (ok) shown++;
    });
    area.querySelectorAll('.folder').forEach((sec) => {
      const any = !!sec.querySelector('.my-card:not([hidden])');
      sec.hidden = words.length > 0 && !any;
      sec.classList.toggle('searching', words.length > 0);
    });
    area.classList.toggle('filtering', words.length > 0);
    none.hidden = shown > 0;
    hint.textContent = words.length ? '搜尋中無法調整順序，清除搜尋後就能拖曳或按 ↑ ↓。' : hintText;
  };

  area.onclick = async (e) => {
    const sec = e.target.closest('.folder');
    if (sec && e.target.closest('[data-toggle], .folder-name')) {
      sec.classList.toggle('closed');
      collapsed = [...area.querySelectorAll('.folder.closed')].map((x) => x.dataset.fid);
      try { localStorage.setItem(collapsedKey, JSON.stringify(collapsed)); } catch (err) {}
      return;
    }
    if (sec && e.target.closest('[data-rename]')) {
      const f = folders.find((x) => x.id === sec.dataset.fid);
      const name = (prompt('資料夾名稱', f.name) || '').trim().slice(0, 40);
      if (!name || name === f.name) return;
      const cur = snapshot();
      saveFolders(cur.folders.map((x) => (x.id === f.id ? { ...x, name } : x)), cur.order);
      return;
    }
    if (sec && e.target.closest('[data-delfolder]')) {
      const f = folders.find((x) => x.id === sec.dataset.fid);
      if (!confirm(`刪除資料夾「${f.name}」？裡面的課程會移回「未分類」，不會移出學習區。`)) return;
      const cur = snapshot();
      const moved = (cur.folders.find((x) => x.id === f.id) || {}).courses || [];
      saveFolders(cur.folders.filter((x) => x.id !== f.id), [...cur.order, ...moved]);
      return;
    }
    const cardEl = e.target.closest('.my-card');
    if (!cardEl) return;
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const step = mv.dataset.move === '-1' ? 'previousElementSibling' : 'nextElementSibling';
      let sib = cardEl[step];
      while (sib && !sib.classList.contains('my-card')) sib = sib[step];
      if (!sib) return;
      if (mv.dataset.move === '-1') sib.before(cardEl); else sib.after(cardEl);
      persist();
      return;
    }
    if (e.target.closest('[data-leave]')) {
      const c = findCourse(cardEl.dataset.id);
      if (!confirm(`把「${c.title}」移出學習區？（之後可以再加入，學習進度會保留）`)) return;
      try { await leaveCourse(c); cardEl.remove(); persist(true); toast('已移出學習區'); }
      catch (err) { toast('移出失敗：' + (err.code || err.message) + '（請確認已部署最新的 Firestore 規則）'); }
    }
  };
  // 「📁」選擇資料夾
  area.onchange = (e) => {
    const sel = e.target.closest('[data-folder-pick]');
    if (!sel) return;
    const cardEl = sel.closest('.my-card');
    const list = area.querySelector(`.my-list[data-list="${CSS.escape(sel.value)}"]`);
    const empty = list.querySelector(':scope > .folder-empty');
    if (empty) empty.before(cardEl); else list.appendChild(cardEl);
    persist(true);
  };
  // 拖曳（滑鼠與觸控）：按住 ⠿ 移動，可以在資料夾之間搬移；拖到收合的資料夾標題上就放進該資料夾
  let dragging = null;
  area.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.drag-handle');
    if (!h) return;
    e.preventDefault();
    dragging = h.closest('.my-card');
    dragging.classList.add('dragging');
    h.setPointerCapture(e.pointerId);
  });
  area.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (!over) return;
    area.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const target = over.closest('.my-card');
    if (target && target !== dragging && area.contains(target)) {
      const r = target.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) target.after(dragging); else target.before(dragging);
      return;
    }
    const head = over.closest('.folder-head');
    if (head) { head.parentNode.classList.add('drop-target'); return; }
    const list = over.closest('.my-list');
    if (list && area.contains(list) && !list.contains(dragging)) {
      const empty = list.querySelector(':scope > .folder-empty');
      if (empty) empty.before(dragging); else list.appendChild(dragging);
    }
  });
  const end = (e) => {
    if (!dragging) return;
    const drop = area.querySelector('.folder.drop-target');
    if (drop) {
      const list = drop.querySelector('.my-list');
      list.querySelector(':scope > .folder-empty').before(dragging);
      drop.classList.remove('drop-target');
    }
    dragging.classList.remove('dragging');
    dragging = null;
    persist(true);
  };
  area.addEventListener('pointerup', end);
  area.addEventListener('pointercancel', end);
};

/* ---------------- 我的筆記 ----------------
 * islam_notes/{Email}/courses/{課程id} = { lessons: { 單元id: { text, updatedAt } }, updatedAt }
 * 只有自己讀寫得到；換裝置登入也看得到 */
const noteCache = {}; // 課程 id → { 單元id: { text, updatedAt } }
async function loadNotes(courseId) {
  if (noteCache[courseId]) return noteCache[courseId];
  const snap = await fb.getDoc(fb.doc(db, COL.notes, user.email.toLowerCase(), 'courses', courseId));
  noteCache[courseId] = snap.exists() ? (snap.data().lessons || {}) : {};
  return noteCache[courseId];
}
// 打字停下 0.8 秒後自動儲存；換頁或關閉前把還沒存的內容存起來
let pendingNote = null, noteTimer = 0;
function queueNote(courseId, lessonId, text, onState) {
  pendingNote = { courseId, lessonId, text, onState };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(flushNote, 800);
  onState('編輯中…');
}
async function flushNote() {
  clearTimeout(noteTimer);
  const n = pendingNote;
  if (!n) return;
  pendingNote = null;
  const entry = { text: n.text, updatedAt: Date.now() };
  (noteCache[n.courseId] = noteCache[n.courseId] || {})[n.lessonId] = entry;
  try {
    await fb.setDoc(fb.doc(db, COL.notes, user.email.toLowerCase(), 'courses', n.courseId),
      { lessons: { [n.lessonId]: entry }, updatedAt: entry.updatedAt }, { merge: true });
    n.onState('✓ 已儲存');
  } catch (e) {
    console.error(e);
    n.onState('⚠ 儲存失敗');
    toast('筆記儲存失敗：' + (e.code || e.message) + '（請確認已部署最新的 Firestore 規則）');
  }
}
window.addEventListener('hashchange', flushNote);
window.addEventListener('pagehide', flushNote);

// 匯出筆記：一門課，或全部有筆記的課程；可選 Markdown、純文字、Word、PDF、網頁
// （檔名用英數字，避免部分瀏覽器把中文檔名換成 download）
const EXPORT_FORMATS = [
  ['md', 'Markdown（.md）'], ['txt', '純文字（.txt）'], ['doc', 'Word（.doc）'], ['pdf', 'PDF（列印另存）'], ['html', '網頁（.html）']
];
// 整理成「課程 → 章節 → 單元 → 筆記」，只留有寫筆記的部分
function notesTree(list) {
  return list.map(({ course, lessons }) => ({
    title: course.title,
    multi: course.chapters.length > 1,
    chapters: course.chapters.map((ch) => ({
      title: ch.title,
      lessons: ch.lessons.filter((l) => (lessons[l.id] || {}).text).map((l) => ({ title: l.title, text: lessons[l.id].text.trim(), at: lessons[l.id].updatedAt }))
    })).filter((ch) => ch.lessons.length)
  })).filter((c) => c.chapters.length);
}
const docTitle = () => `我的筆記｜${CONFIG.siteName || '循序漸進學伊斯蘭'}`;
function notesMarkdown(tree) {
  const out = [`# ${docTitle()}`, '', `匯出時間：${fmtTime(Date.now())}`, ''];
  tree.forEach((c) => {
    out.push(`## ${c.title}`, '');
    c.chapters.forEach((ch) => {
      if (c.multi) out.push(`### ${ch.title}`, '');
      ch.lessons.forEach((l) => out.push(`${c.multi ? '####' : '###'} ${l.title}`, '', l.text, '', `<sub>最後更新：${fmtTime(l.at || Date.now())}</sub>`, ''));
    });
  });
  return out.join('\n');
}
function notesText(tree) {
  const out = [docTitle(), `匯出時間：${fmtTime(Date.now())}`, ''];
  tree.forEach((c) => {
    out.push('='.repeat(30), c.title, '='.repeat(30), '');
    c.chapters.forEach((ch) => {
      if (c.multi) out.push(`【${ch.title}】`, '');
      ch.lessons.forEach((l) => out.push(`■ ${l.title}`, l.text, `（最後更新：${fmtTime(l.at || Date.now())}）`, ''));
    });
  });
  return out.join('\r\n');
}
function notesHtml(tree, forPrint = false) {
  const body = tree.map((c) => `<h2>${esc(c.title)}</h2>` + c.chapters.map((ch) =>
    (c.multi ? `<h3>${esc(ch.title)}</h3>` : '') + ch.lessons.map((l) =>
      `<${c.multi ? 'h4' : 'h3'}>${esc(l.title)}</${c.multi ? 'h4' : 'h3'}><p>${esc(l.text).replace(/\n/g, '<br>')}</p>` +
      `<p class="meta">最後更新：${fmtTime(l.at || Date.now())}</p>`).join('')).join('')).join('');
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>' + esc(docTitle()) + '</title>' +
    '<style>body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;line-height:1.8;max-width:760px;margin:32px auto;padding:0 20px;color:#0f172a}' +
    'h1{font-size:24px}h2{font-size:20px;border-bottom:2px solid #0ea5e9;padding-bottom:4px;margin-top:32px}h3,h4{font-size:16px;margin:20px 0 4px}' +
    '.meta{color:#64748b;font-size:12px;margin-top:0}' + (forPrint ? '@media print{body{margin:0}h2{break-after:avoid}}' : '') + '</style></head><body>' +
    `<h1>${esc(docTitle())}</h1><p class="meta">匯出時間：${fmtTime(Date.now())}</p>` + body + '</body></html>';
}
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.setAttribute('download', name);
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const safeName = (t) => String(t).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'notes';
// base：不含副檔名的檔名
async function exportNotes(courses, base, fmt = 'md') {
  // PDF：先開新視窗（要在按下按鈕的當下開，才不會被擋），再填入內容並開啟列印
  const win = fmt === 'pdf' ? window.open('', '_blank') : null;
  await flushNote();
  const list = [];
  for (const course of courses) list.push({ course, lessons: await loadNotes(course.id).catch(() => ({})) });
  const tree = notesTree(list);
  if (!tree.length) { if (win) win.close(); return toast('還沒有任何筆記可以匯出'); }
  if (fmt === 'md') downloadFile(base + '.md', notesMarkdown(tree), 'text/markdown;charset=utf-8');
  if (fmt === 'txt') downloadFile(base + '.txt', '﻿' + notesText(tree), 'text/plain;charset=utf-8');
  if (fmt === 'html') downloadFile(base + '.html', notesHtml(tree), 'text/html;charset=utf-8');
  // Word 可以直接開啟 HTML 格式的 .doc
  if (fmt === 'doc') downloadFile(base + '.doc', '﻿' + notesHtml(tree), 'application/msword;charset=utf-8');
  if (fmt === 'pdf') {
    if (!win) return toast('瀏覽器擋住了新視窗，請允許彈出式視窗後再試一次');
    win.document.open(); win.document.write(notesHtml(tree, true)); win.document.close();
    win.focus();
    setTimeout(() => win.print(), 300);
    toast('在列印視窗選擇「另存為 PDF」即可');
  }
}
// 匯出選單：按「⬇ 匯出筆記」展開，選擇格式
const exportMenu = (id, label) => `<details class="export-menu" id="${id}"><summary class="btn btn-ghost btn-sm">⬇ ${label}</summary><div class="export-list">` +
  EXPORT_FORMATS.map(([k, t]) => `<button type="button" data-fmt="${k}">${t}</button>`).join('') + '</div></details>';
function bindExportMenu(menu, run) {
  menu.querySelectorAll('[data-fmt]').forEach((b) => { b.onclick = () => { menu.open = false; run(b.dataset.fmt); }; });
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
}

// 上課頁：從 Firestore 讀取不公開的 YouTube 影片 ID
pages.learn = async (app, id, query, lessonId) => {
  const c = findCourse(id);
  if (!c) return notFound(app);
  if (!user) return go(`/login?next=/learn/${id}`);
  if (!isVerified()) return pages.verify(app);
  if (!owns(c.id)) {
    app.innerHTML = `<div class="container narrow"><h1>尚未加入</h1><div class="card pad"><p>請先到課程頁按「加入課程」，就能開始觀看（免費）。</p><a class="btn btn-sm" href="#/course/${c.id}">前往課程頁</a></div></div>`;
    return;
  }
  app.innerHTML = '<div class="container"><p class="muted">載入課程中…</p></div>';
  let videos, myNotes = {};
  try {
    [videos, myNotes] = await Promise.all([loadVideos(c.id), loadNotes(c.id).catch((e) => { console.error(e); return {}; })]);
  } catch (e) {
    console.error(e);
    app.innerHTML = '<div class="container narrow"><h1>無法載入課程</h1><div class="card pad"><p>你可能沒有觀看權限，或網路連線有問題。請重新整理，若仍無法觀看請聯繫我們。</p></div></div>';
    return;
  }
  if (!document.body.contains(app)) return; // 載入期間已換頁

  const all = lessonsOf(c);
  const done = doneList(c.id);
  const cur = all.find((l) => l.id === lessonId) || all.find((l) => !done.includes(l.id)) || all[0];
  const i = all.indexOf(cur);
  const isDone = done.includes(cur.id);
  let article = null;
  if (cur.kind === 'article' || !videos[cur.id]) article = await loadArticle(c.id, cur.id);
  else loadArticle(c.id, cur.id).then((a) => { // 影片單元也可能附文章
    const box = app.querySelector('#article');
    if (a && box) { box.innerHTML = articleHtml(a); box.hidden = false; }
  });
  if (!document.body.contains(app)) return;
  const onlyArticle = !videos[cur.id] && article;

  app.innerHTML = '<div class="player">' +
    '<div>' +
    // 單元資訊與按鈕在影片上方
    `<div class="pad lesson-head"><div><p class="muted small">單元 ${i + 1} / ${all.length}</p><h2>${esc(cur.title)}</h2></div>` +
    '<div class="lesson-nav">' +
    (i > 0 ? `<a class="btn btn-ghost btn-sm" href="#/learn/${c.id}/${all[i - 1].id}">← 上一單元</a>` : '') +
    `<button class="btn btn-sm ${isDone ? 'btn-ghost' : ''}" id="done">${isDone ? '✓ 已完成' : '標記完成'}</button>` +
    (i < all.length - 1 ? `<a class="btn btn-ghost btn-sm" href="#/learn/${c.id}/${all[i + 1].id}">下一單元 →</a>` : '') +
    '</div></div>' +
    (onlyArticle ? '' : youtubeEmbed(videos[cur.id])) +
    `<div class="pad lesson-article" id="article" ${article ? '' : 'hidden'}>${articleHtml(article)}</div>` +
    '<div class="pad share-warning">🔗 本課程為公開課程，<strong>歡迎分享</strong>給親友一起學習。</div>' +
    // 單元說明（在 data.js 每個單元的第 4 個欄位填寫）
    (cur.note ? `<div class="pad lesson-note"><h3>單元說明</h3><div>${linkify(esc(cur.note)).replace(/\n/g, '<br>')}</div></div>` : '') +
    // 我的筆記（自動儲存，只有自己看得到）
    '<div class="pad my-notes"><div class="row-between"><h3>📝 我的筆記</h3>' +
    '<span class="lesson-nav"><span class="muted small" id="note-state"></span>' +
    exportMenu('note-export', '匯出筆記') + '</span></div>' +
    `<textarea class="input textarea" id="note" rows="7" placeholder="在這裡記下這個單元的重點…（自動儲存，只有你看得到）">${esc((myNotes[cur.id] || {}).text || '')}</textarea></div>` +
    '<div class="pad"><h3>💬 心得分享與交流</h3><div class="talk" id="posts"></div></div>' +
    '</div>' +
    `<aside class="side"><div class="pad"><strong>${esc(c.title)}</strong><div class="bar"><i style="width:${progress(c)}%"></i></div>` +
    `<span class="muted small">進度 ${progress(c)}%</span>` +
    (progress(c) === 100 && nextCourse(c) ? `<a class="btn btn-sm btn-block next-step" href="#/course/${nextCourse(c).id}">下一階段：${esc(nextCourse(c).title)} →</a>` : '') + '</div>' +
    c.chapters.map((ch) => `<div class="side-ch">${esc(ch.title)}</div>` + ch.lessons.map((l) => {
      const d = done.includes(l.id);
      return `<a class="side-l${l === cur ? ' active' : ''}" href="#/learn/${c.id}/${l.id}">` +
        `<span class="dot${d ? ' done' : ''}">${d ? '✓' : ''}</span>${esc(l.title)}` +
        ((myNotes[l.id] || {}).text ? '<span class="note-dot" title="有筆記">📝</span>' : '') + `<span class="muted small">${lessonTime(l)}</span></a>`;
    }).join('')).join('') + '</aside></div>';

  const noteEl = app.querySelector('#note'), noteState = app.querySelector('#note-state');
  const setState = (t) => { if (noteState.isConnected) noteState.textContent = t; };
  noteEl.oninput = () => {
    if (noteEl.value.length > 20000) { noteEl.value = noteEl.value.slice(0, 20000); toast('每個單元的筆記最多 20,000 字'); }
    queueNote(c.id, cur.id, noteEl.value, setState);
  };
  noteEl.onblur = flushNote;
  bindExportMenu(app.querySelector('#note-export'), (fmt) => exportNotes([c], `notes-${safeName(c.id)}`, fmt));
  renderPosts(app.querySelector('#posts'), c);

  app.querySelector('#done').onclick = () => {
    setDone(c.id, cur.id, !isDone);
    if (!isDone && progress(c) === 100) toast(nextCourse(c) ? '🎉 恭喜完成這個階段！可以繼續下一階段了' : '🎉 恭喜完成整門課程！');
    if (!isDone && i < all.length - 1) go(`/learn/${c.id}/${all[i + 1].id}`);
    else pages.learn(app, id, query, cur.id);
  };
};

/* ---------------- 管理者：編輯課程 ---------------- */
// 毫秒 ↔ <input type="datetime-local"> 的本地時間字串
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function adminGuard(app) {
  if (!user) { go('/login?next=/admin'); return false; }
  if (!isAdmin()) { notFound(app); return false; }
  return true;
}

// 把圖片縮成 960×540（16:9 裁切）的 JPEG，存成文字放進資料庫
async function resizeCover(file) {
  const img = await createImageBitmap(file);
  const W = 960, H = 540;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  canvas.getContext('2d').drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  let q = 0.85, url = canvas.toDataURL('image/jpeg', q);
  while (url.length > 600000 && q > 0.4) { q -= 0.15; url = canvas.toDataURL('image/jpeg', q); }
  return url;
}

// 課程列表
pages.admin = async (app, id, query, sub) => {
  if (!adminGuard(app)) return;
  if (id === 'students') return pages.students(app);
  if (id === 'playlist') return pages.playlist(app);
  if (id === 'articles') return pages.blogAdmin(app);
  if (id === 'events') return pages.eventAdmin(app);
  if (id === 'event') return pages.eventEdit(app, sub, query);
  if (id === 'article') return pages.blogEdit(app, sub);
  if (id) return pages.edit(app, id);
  app.innerHTML = '<div class="container">' + adminTabs('courses') + '<div class="row-between"><h1>課程管理</h1><span class="lesson-nav">' +
    '<a class="btn btn-ghost btn-sm" href="#/admin/playlist">▶ 從播放清單建立</a><a class="btn btn-sm" href="#/admin/new">＋ 新增課程</a><a class="btn btn-sm" href="#/admin/article/new">＋ 新增文章</a><a class="btn btn-sm" href="#/admin/event/new">＋ 新增活動</a></span></div>' +
    (coursesFromDb ? '' :
      '<div class="card pad notice-card"><strong>第一次使用：請先匯入課程</strong><p class="muted small">目前的課程資料來自網站內建檔案。按下面的按鈕把課程匯入資料庫後，就能在網站上直接編輯。</p>' +
      '<button class="btn btn-sm" id="import">匯入現有課程到資料庫</button></div>') +
    '<div class="admin-list">' + courses.map((c, i) =>
      `<div class="card admin-row">${thumb(c)}<div class="pad"><strong>${esc(c.title)}</strong>` +
      `<p class="muted small">${esc(c.category || '')} · ${lessonsOf(c).length} 個單元 · ${c.published === false ? '<span class="tag">未上架</span>' : '已上架'}` +
      (c.unlisted ? ' · <span class="tag">不公開</span>' : '') +
      '</p>' +
      `<div class="lesson-nav">${coursesFromDb ? `<a class="btn btn-sm" href="#/admin/${c.id}">編輯</a>` : ''}` +
      `<a class="btn btn-ghost btn-sm" href="#/course/${c.id}">查看</a>` +
      (coursesFromDb && i > 0 ? `<button class="btn btn-ghost btn-sm" data-up="${i}">↑ 往前</button>` : '') +
      '</div></div></div>').join('') + '</div></div>';

  const imp = app.querySelector('#import');
  if (imp) imp.onclick = async () => {
    imp.disabled = true; imp.textContent = '匯入中…';
    try {
      for (const [i, c] of courses.entries()) {
        await fb.setDoc(fb.doc(db, COL.courses, c.id), { ...c, published: c.published !== false, order: i, updatedAt: Date.now() });
      }
      await loadCourses();
      toast('匯入完成，現在可以編輯課程了');
      pages.admin(app);
    } catch (e) { console.error(e); imp.disabled = false; imp.textContent = '匯入現有課程到資料庫'; toast('匯入失敗：' + (e.code || e.message) + '（請確認已更新 Firestore 規則）'); }
  };
  app.onclick = async (e) => {
    const up = e.target.dataset && e.target.dataset.up;
    if (up == null) return;
    const i = +up;
    [courses[i - 1], courses[i]] = [courses[i], courses[i - 1]];
    try {
      await Promise.all(courses.map((c, k) => fb.setDoc(fb.doc(db, COL.courses, c.id), { order: k }, { merge: true })));
      pages.admin(app);
    } catch (err) { toast('排序失敗：' + (err.code || err.message)); }
  };
};

const adminTabs = (cur) => '<div class="chips admin-tabs">' +
  `<a class="chip${cur === 'courses' ? ' active' : ''}" href="#/admin">課程管理（順序 = 學習地圖的階段）</a>` +
  `<a class="chip${cur === 'articles' ? ' active' : ''}" href="#/admin/articles">文章管理</a>` +
  `<a class="chip${cur === 'events' ? ' active' : ''}" href="#/admin/events">行事曆</a>` +
  `<a class="chip${cur === 'students' ? ' active' : ''}" href="#/admin/students">學生名單</a></div>`;

/* ---------------- 從 YouTube 播放清單建立課程（管理者） ----------------
 * 用 YouTube Data API v3 讀取播放清單與影片資料（需要 API 金鑰，設定在 config.js 的 youtubeApiKey，
 * 或在頁面上貼上、只存在這台電腦的瀏覽器）。建立後是「未上架」的草稿，會打開編輯頁讓你檢查。 */
const YT_API = 'https://www.googleapis.com/youtube/v3/';
const playlistIdOf = (v) => { v = String(v || '').trim(); const m = /[?&]list=([\w-]+)/.exec(v); return m ? m[1] : (/^(PL|UU|OL|FL|LL)[\w-]{10,}$/.test(v) ? v : null); };
// ISO 8601 長度（PT1H2M3S）→ 秒
const isoSeconds = (d) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || '') || []; return ((+m[1] || 0) * 24 + (+m[2] || 0)) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0); };
const bestThumb = (t) => { t = t || {}; return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || ''; };
async function ytGet(path, params, key) {
  const url = YT_API + path + '?' + new URLSearchParams({ ...params, key });
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = (((j.error || {}).errors || [])[0] || {}).reason || '';
    const msg = { keyInvalid: 'API 金鑰無效', accessNotConfigured: '這個 API 金鑰還沒啟用 YouTube Data API v3', quotaExceeded: '今天的 API 使用量已用完，請明天再試',
      playlistNotFound: '找不到這個播放清單，請確認網址正確，而且播放清單是「公開」或「不公開」（私人的讀不到）', forbidden: '沒有權限讀取這個播放清單' }[reason];
    throw new Error(msg || (j.error && j.error.message) || ('HTTP ' + r.status));
  }
  return j;
}
async function fetchPlaylist(pid, key, onProgress) {
  const meta = await ytGet('playlists', { part: 'snippet,status', id: pid }, key);
  if (!meta.items || !meta.items.length) throw new Error('找不到這個播放清單，請確認網址正確，而且播放清單是「公開」或「不公開」（私人的讀不到）');
  // 公開、不公開都可以；私人的不行
  if ((meta.items[0].status || {}).privacyStatus === 'private') throw new Error('這是「私人」播放清單，請到 YouTube 把瀏覽權限改成「公開」或「不公開」後再試一次');
  const sn = meta.items[0].snippet;
  const items = [];
  let pageToken = '';
  do {
    const r = await ytGet('playlistItems', { part: 'snippet,contentDetails', playlistId: pid, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, key);
    (r.items || []).forEach((it) => items.push({ id: it.contentDetails.videoId, title: it.snippet.title, description: it.snippet.description || '' }));
    pageToken = r.nextPageToken || '';
    onProgress(`已讀取 ${items.length} 部影片…`);
  } while (pageToken && items.length < 500);
  // 刪除或私人的影片讀不到內容，略過
  const ok = items.filter((v) => v.id && !/^(Private|Deleted) video$/.test(v.title));
  const dur = {};
  for (let i = 0; i < ok.length; i += 50) {
    const r = await ytGet('videos', { part: 'contentDetails', id: ok.slice(i, i + 50).map((v) => v.id).join(',') }, key);
    (r.items || []).forEach((v) => { dur[v.id] = isoSeconds(v.contentDetails.duration); });
  }
  return { title: sn.title, description: sn.description || '', cover: bestThumb(sn.thumbnails), videos: ok.map((v) => ({ ...v, duration: dur[v.id] || 0 })), skipped: items.length - ok.length };
}
pages.playlist = (app) => {
  if (!adminGuard(app)) return;
  let savedKey = '';
  try { savedKey = localStorage.getItem('isl_yt_key') || ''; } catch (e) {}
  const cfgKey = CONFIG.youtubeApiKey || '';
  app.innerHTML = '<div class="container editor"><a href="#/admin" class="muted small">← 課程管理</a><h1>從 YouTube 播放清單建立課程</h1>' +
    '<form class="card pad" id="pl" novalidate>' +
    '<label>播放清單網址<input class="input" name="url" placeholder="https://www.youtube.com/playlist?list=PL…" required/></label>' +
    (cfgKey ? '' : `<label>YouTube API 金鑰 <span class="muted small">只會存在這台電腦的瀏覽器；也可以請工程師設定在 config.js 的 youtubeApiKey</span><input class="input" name="key" value="${esc(savedKey)}" placeholder="AIza…"/></label>`) +
    '<label class="check"><input type="checkbox" name="desc" checked/> 把每部影片的說明放進「單元說明」</label>' +
    '<button class="btn btn-sm" id="go">讀取並建立課程</button><p class="small muted" id="plmsg"></p>' +
    '<p class="muted small">會用播放清單的名稱、說明、封面建立一門<strong>未上架</strong>的課程，每部影片一個單元（標題、長度、影片網址都會自動設定），建立後打開編輯頁讓你檢查、補充，再勾選「上架」。<strong>播放清單要是「公開」或「不公開」</strong>（私人的讀不到）；清單裡私人或已刪除的影片會自動略過。</p></form></div>';
  const f = app.querySelector('#pl'), msg = app.querySelector('#plmsg');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const pid = playlistIdOf(f.elements.url.value);
    if (!pid) return toast('請貼上播放清單網址（網址裡要有 list=…）');
    const key = cfgKey || (f.elements.key.value || '').trim();
    if (!key) return toast('請填入 YouTube API 金鑰');
    if (!cfgKey) { try { localStorage.setItem('isl_yt_key', key); } catch (err) {} }
    const btn = app.querySelector('#go'); btn.disabled = true;
    msg.className = 'small muted'; msg.textContent = '讀取播放清單中…';
    try {
      const p = await fetchPlaylist(pid, key, (t) => { msg.textContent = t; });
      if (!p.videos.length) throw new Error('這個播放清單沒有可以讀取的影片');
      msg.textContent = `讀到 ${p.videos.length} 部影片，建立課程中…`;
      const lessons = p.videos.map((v, i) => ({ id: 'l' + (i + 1), title: v.title, duration: v.duration, note: f.elements.desc.checked ? v.description.trim().slice(0, 3000) : '' }));
      const c = {
        id: newId('c'), title: p.title.slice(0, 120), subtitle: '', category: '', level: '入門', price: 0, instructor: '',
        thumb: ['#0ea5e9', '#7dd3fc', p.title.slice(0, 4)], cover: p.cover, trailer: '',
        description: p.description.trim().slice(0, 5000), outcomes: [],
        chapters: [{ title: '課程內容', lessons }], published: false, order: courses.length, playlistId: pid, updatedAt: Date.now()
      };
      const videos = {};
      p.videos.forEach((v, i) => { videos['l' + (i + 1)] = 'https://youtu.be/' + v.id; });
      const data = { ...c }; delete data.id;
      await fb.setDoc(fb.doc(db, COL.courses, c.id), data);
      await fb.setDoc(fb.doc(db, COL.videos, c.id), videos);
      videoCache[c.id] = { ...videos };
      courses.push(c);
      coursesFromDb = true;
      toast(`已建立「${c.title}」（${lessons.length} 個單元${p.skipped ? `，略過 ${p.skipped} 部私人或已刪除的影片` : ''}），請檢查後上架`);
      go('/admin/' + c.id);
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      msg.className = 'small expired'; msg.textContent = '⚠ ' + (err.code ? err.code + '：' : '') + err.message;
    }
  };
};

// 學生名單：加入過伊斯蘭網站課程的學生（islam_students），可搜尋、匯出 CSV
const fmtDate = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`; };
// 依學生名單校正每門課的學習人數（管理者打開學生名單時自動補上這個功能上線前就加入的學生；人數是累計的，只會往上補）
async function syncCounts(list) {
  await loadCounts(); // 以資料庫目前的數字為準
  const real = {};
  list.forEach((s) => s.items.forEach((x) => { real[x.id] = (real[x.id] || 0) + 1; }));
  if (list.length > learners) {
    try { await fb.setDoc(fb.doc(db, COL.stats, 'learners'), { n: list.length }); learners = list.length; }
    catch (e) { console.error('全站人數校正失敗', e); }
  }
  const ids = new Set([...Object.keys(real), ...Object.keys(joinCount)]);
  for (const id of ids) {
    const n = real[id] || 0;
    if ((joinCount[id] || 0) >= n) continue;
    try {
      await fb.setDoc(fb.doc(db, COL.counts, id), { n });
      joinCount[id] = n;
    } catch (e) { console.error('人數校正失敗', id, e); }
  }
}

pages.students = async (app) => {
  if (!adminGuard(app)) return;
  app.innerHTML = '<div class="container"><p class="muted">載入中…</p></div>';
  let list = [];
  try {
    const snap = await fb.getDocs(fb.collection(db, COL.students));
    list = snap.docs.map((d) => ({ email: d.id, ...d.data() }))
      .map((s) => ({ ...s, items: Object.entries(s.courses || {}).map(([id, at]) => ({ id, at: Number(at) || 0 })).sort((a, b) => a.at - b.at) }))
      .filter((s) => s.items.length)
      .sort((a, b) => Math.max(0, ...b.items.map((x) => x.at)) - Math.max(0, ...a.items.map((x) => x.at)));
  } catch (e) {
    console.error(e);
    app.innerHTML = '<div class="container">' + adminTabs('students') + '<h1>學生名單</h1><div class="card pad"><p>無法讀取學生名單：' + esc(e.code || e.message) + '</p><p class="muted small">請確認已部署最新的 Firestore 規則。</p></div></div>';
    return;
  }
  if (!document.body.contains(app)) return;
  syncCounts(list);
  const title = (id) => (findCourse(id) || {}).title || id + '（已刪除的課程）';
  let q = '';
  app.innerHTML = '<div class="container editor">' + adminTabs('students') +
    '<div class="row-between"><h1>學生名單</h1><button type="button" class="btn btn-ghost btn-sm" id="csv">⬇ 匯出 CSV</button></div>' +
    `<p class="muted small">共 ${list.length} 位學生、${list.reduce((n, s) => n + s.items.length, 0)} 筆加入紀錄。依最近加入時間排列。` +
    '學生加入或移出課程時會自動更新，課程顯示的「加入學習人數」（累計）也會依這份名單補齊；更新這個功能之前就加入的學生，會在他下次登入網站時出現。</p>' +
    '<input class="input" id="sq" type="search" placeholder="搜尋 Email 或姓名" autocomplete="off"/>' +
    '<div id="slist"></div></div>';
  const shown = () => list.filter((s) => !q || (s.email + ' ' + (s.name || '')).toLowerCase().includes(q));
  function draw() {
    const rows = shown();
    app.querySelector('#slist').innerHTML = rows.length
      ? '<div class="card table-wrap"><table class="orders"><thead><tr><th>Email</th><th>姓名</th><th>加入的課程（加入日期）</th></tr></thead><tbody>' +
        rows.map((s) => `<tr><td class="small">${esc(s.email)}</td><td class="small">${esc(s.name || '')}</td><td class="small">` +
          s.items.map((x) => `${esc(title(x.id))}（${fmtDate(x.at)}）`).join('<br>') + '</td></tr>').join('') +
        '</tbody></table></div>'
      : `<p class="muted">${list.length ? '找不到符合的學生。' : '還沒有學生加入課程。'}</p>`;
  }
  app.querySelector('#sq').oninput = (e) => { q = e.target.value.trim().toLowerCase(); draw(); };
  app.querySelector('#csv').onclick = () => {
    const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [['Email', '姓名', '課程', '加入日期'].map(cell).join(',')];
    shown().forEach((s) => s.items.forEach((x) => lines.push([s.email, s.name || '', title(x.id), fmtDate(x.at)].map(cell).join(','))));
    // 開頭加 BOM，Excel 開啟中文才不會亂碼
    const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.setAttribute('download', `students-${fmtDate(Date.now()).replace(/\//g, '')}.csv`);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  draw();
};

// 編輯單一課程
pages.edit = async (app, id) => {
  const isNew = id === 'new';
  const src = isNew ? null : findCourse(id);
  if (!isNew && !src) return notFound(app);
  if (!coursesFromDb) { toast('請先匯入課程到資料庫'); return go('/admin'); }
  app.innerHTML = '<div class="container"><p class="muted">載入中…</p></div>';

  // 工作副本
  const c = isNew ? {
    id: newId('c'), title: '', subtitle: '', category: '', level: '入門', price: 0, instructor: '',
    thumb: ['#0ea5e9', '#7dd3fc', '伊斯蘭'], cover: '', trailer: '', description: '', outcomes: [],
    chapters: [{ title: '課程內容', lessons: [{ id: newId('l'), title: '', duration: 0, note: '' }] }],
    published: false, order: courses.length
  } : JSON.parse(JSON.stringify(src));
  c.thumb = c.thumb || ['#0ea5e9', '#7dd3fc', '伊斯蘭'];
  let videos = {};
  const articles = {}; // 單元 id → 文章內容（islam_articles/{課程id}/lessons/{單元id}.text）
  const links = {};    // 單元 id → 外部文章連結（同一份文件的 url）
  if (!isNew) {
    try { videos = { ...(await fb.getDoc(fb.doc(db, COL.videos, c.id))).data() }; } catch (e) { console.error(e); }
    try {
      const snap = await fb.getDocs(fb.collection(db, COL.articles, c.id, 'lessons'));
      snap.docs.forEach((d) => {
        if (d.data().text) articles[d.id] = d.data().text;
        if (d.data().url) links[d.id] = d.data().url;
      });
    } catch (e) { console.error(e); }
  }
  // 資料庫裡目前的文章，只寫入有修改的單元
  const artKey = (id) => JSON.stringify([articles[id] || '', links[id] || '']);
  const savedArticles = {};
  new Set([...Object.keys(articles), ...Object.keys(links)]).forEach((id) => { savedArticles[id] = artKey(id); });
  if (!document.body.contains(app)) return;

  const field = (label, name, val, attrs = '') => `<label>${label}<input class="input" name="${name}" value="${esc(val)}" ${attrs}/></label>`;
  const area = (label, name, val, rows = 4, hint = '') => `<label>${label}${hint ? ` <span class="muted small">${hint}</span>` : ''}<textarea class="input textarea" name="${name}" rows="${rows}">${esc(val)}</textarea></label>`;

  function draw() {
    app.innerHTML = `<div class="container editor"><a href="#/admin" class="muted small">← 課程管理</a><h1>${isNew ? '新增課程' : '編輯課程'}</h1>` +
      '<form id="ed" novalidate>' +
      '<div class="card pad"><h3>基本資訊</h3>' +
      field('課程名稱', 'title', c.title, 'required') +
      field('副標題', 'subtitle', c.subtitle) +
      '<div class="two">' + field('分類 <span class="muted small">學生可以在首頁依分類篩選，例如：信仰、功修、生活</span>', 'category', c.category || '') + field('程度', 'level', c.level) + '</div>' +
      '<div class="two">' + field('講師', 'instructor', c.instructor) + '<span></span></div>' +
      '<p class="muted small">學習地圖的順序在「課程管理」用「↑ 往前」調整。</p>' +
      `<label class="check"><input type="checkbox" name="published" ${c.published !== false ? 'checked' : ''}/> 上架（取消勾選則只有管理者看得到）</label>` +
      `<label class="check"><input type="checkbox" name="unlisted" ${c.unlisted ? 'checked' : ''}/> 不公開：不列在學習地圖，只有拿到課程連結的人才能進入</label>` +
      `<p class="muted small">課程連結：<code id="course-link">${esc(courseLink(c.id))}</code> <button type="button" class="btn btn-ghost btn-sm" id="copy-link">複製</button></p></div>` +

      '<div class="card pad"><h3>封面</h3><div class="cover-edit">' +
      `<div class="cover-preview" id="cover-prev">${thumb(c)}</div><div>` +
      '<label>上傳封面照片 <span class="muted small">建議 16:9 橫向圖片，會自動裁切成 960×540</span><input class="input" type="file" accept="image/*" id="cover-file"/></label>' +
      (c.cover ? '<button type="button" class="btn btn-ghost btn-sm" id="cover-remove">移除封面照片</button>' : '') +
      '<p class="muted small">沒有封面照片時，會顯示下面的漸層色和文字：</p>' +
      `<div class="two"><label>顏色 1<input class="input" type="color" name="c1" value="${esc(c.thumb[0])}"/></label><label>顏色 2<input class="input" type="color" name="c2" value="${esc(c.thumb[1])}"/></label></div>` +
      field('封面文字', 'mark', c.thumb[2], 'maxlength="6"') +
      '</div></div></div>' +

      '<div class="card pad"><h3>課程介紹</h3>' +
      `<label>課程介紹 <span class="muted small">可以插入圖片或 GIF；支援 # 標題、**粗體**、- 清單、&gt; 引用</span></label>` +
      mediaButton('description') +
      `<textarea class="input textarea" name="description" rows="${c.description && c.description.length > 300 ? 14 : 6}">${esc(c.description)}</textarea>` +
      `<details class="article-preview" id="desc-pv" ${c.description ? '' : 'hidden'}><summary class="small">預覽課程介紹</summary><div class="article">${renderArticle(c.description)}</div></details>` +
      area('你將學到', 'outcomes', (c.outcomes || []).join('\n'), 4, '每行一項') +
      field('公開預告片 YouTube 網址（可留空，任何人都看得到）', 'trailer', c.trailer || '') +
      '</div>' +

      '<div class="card pad"><div class="row-between"><h3>章節與單元</h3><button type="button" class="btn btn-ghost btn-sm" data-act="add-ch">＋ 新增章節</button></div>' +
      '<p class="muted small">每個單元可以放影片、文章，或兩者都放（文章顯示在影片下方）。影片網址和文章內容只有加入課程的學生和管理者看得到。</p>' +
      c.chapters.map((ch, ci) =>
        `<div class="ed-chapter"><div class="row-between"><input class="input" data-ch="${ci}" value="${esc(ch.title)}" placeholder="章節名稱"/>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-act="del-ch" data-ci="${ci}">刪除章節</button></div>` +
        ch.lessons.map((l, li) =>
          `<div class="ed-lesson"><div class="row-between"><strong class="small">單元 ${li + 1}</strong><span class="lesson-nav">` +
          (li > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-act="up" data-ci="${ci}" data-li="${li}">↑</button>` : '') +
          (li < ch.lessons.length - 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-act="down" data-ci="${ci}" data-li="${li}">↓</button>` : '') +
          `<button type="button" class="btn btn-ghost btn-sm" data-act="del-l" data-ci="${ci}" data-li="${li}">刪除</button></span></div>` +
          `<label>單元標題<input class="input" data-l="title" data-ci="${ci}" data-li="${li}" value="${esc(l.title)}"/></label>` +
          `<label>影片 <span class="muted small">貼上 YouTube 影片網址；純文章單元請留空</span><input class="input" data-l="video" data-ci="${ci}" data-li="${li}" value="${esc(videos[l.id] || '')}" placeholder="https://youtu.be/…"/></label>` +
          `<label>文章連結 <span class="muted small">可留空。貼上外部文章網址，學生會在單元裡直接看到這篇文章</span><input class="input" data-l="link" data-ci="${ci}" data-li="${li}" value="${esc(links[l.id] || '')}" placeholder="https://…"/></label>` +
          `<label>文章內容 <span class="muted small">可留空。支援 # 標題、**粗體**、- 清單、&gt; 引用、[文字](網址)、![說明](圖片網址)</span>` +
          `<textarea class="input textarea article-input" rows="${articles[l.id] ? 10 : 3}" data-l="article" data-ci="${ci}" data-li="${li}" placeholder="在這裡寫文章內容…">${esc(articles[l.id] || '')}</textarea></label>` +
          `<details class="article-preview" data-preview="${l.id}" ${articles[l.id] ? '' : 'hidden'}><summary class="small">預覽文章</summary><div class="article">${renderArticle(articles[l.id] || '')}</div></details>` +
          `<label>單元說明 <span class="muted small">顯示在影片下方，網址會變成連結</span><textarea class="input textarea" rows="3" data-l="note" data-ci="${ci}" data-li="${li}">${esc(l.note || '')}</textarea></label></div>`
        ).join('') +
        `<button type="button" class="btn btn-ghost btn-sm" data-act="add-l" data-ci="${ci}">＋ 新增單元</button></div>`
      ).join('') + '</div>' +

      // 自動儲存：不需要按儲存
      '<div class="editor-actions"><span class="autosave muted small" id="autosave">修改後會自動儲存</span>' +
      '<button class="btn" id="save">完成，查看課程 →</button>' +
      '<button type="button" class="btn btn-ghost" data-act="delete">刪除課程</button>' +
      '</div></form></div>';
  }

  // 把表單內容寫回工作副本（重畫前呼叫，避免輸入內容遺失）
  function collect() {
    const f = app.querySelector('#ed');
    if (!f) return;
    c.title = f.title.value.trim();
    c.subtitle = f.subtitle.value.trim();
    c.category = f.category.value.trim();
    c.level = f.level.value.trim();
    c.instructor = f.instructor.value.trim();
    c.price = 0; // 所有課程免費
    c.published = f.published.checked;
    c.unlisted = f.unlisted.checked;
    c.thumb = [f.c1.value, f.c2.value, f.mark.value.trim()];
    c.description = f.description.value.trim();
    c.outcomes = f.outcomes.value.split('\n').map((t) => t.trim()).filter(Boolean);
    c.trailer = f.trailer.value.trim();
    f.querySelectorAll('[data-ch]').forEach((el) => { c.chapters[+el.dataset.ch].title = el.value.trim(); });
    f.querySelectorAll('[data-l]').forEach((el) => {
      const l = c.chapters[+el.dataset.ci].lessons[+el.dataset.li];
      if (el.dataset.l === 'video') { if (el.value.trim()) videos[l.id] = el.value.trim(); else delete videos[l.id]; }
      else if (el.dataset.l === 'link') { if (el.value.trim()) links[l.id] = el.value.trim(); else delete links[l.id]; }
      else if (el.dataset.l === 'article') { if (el.value.trim()) articles[l.id] = el.value.replace(/\s+$/, ''); else delete articles[l.id]; }
      else l[el.dataset.l] = el.dataset.l === 'note' ? el.value.trim() : el.value.trim();
    });
  }

  function bind() {
    const f = app.querySelector('#ed');
    app.querySelector('#copy-link').onclick = async () => {
      try { await navigator.clipboard.writeText(courseLink(c.id)); toast('已複製課程連結'); }
      catch (e) { toast('無法複製，請手動選取連結'); }
    };
    const fileInput = app.querySelector('#cover-file');
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try { collect(); c.cover = await resizeCover(file); draw(); bind(); autosave(0); toast('封面已更新'); }
      catch (e) { toast('無法讀取這張圖片'); }
    };
    const rm = app.querySelector('#cover-remove');
    if (rm) rm.onclick = () => { collect(); c.cover = ''; draw(); bind(); autosave(0); };
    bindMediaButtons(app);
    ['c1', 'c2', 'mark'].forEach((n) => { f[n].oninput = () => { if (!c.cover) { collect(); app.querySelector('#cover-prev').innerHTML = thumb(c); } }; });

    f.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act, ci = +b.dataset.ci, li = +b.dataset.li;
      collect();
      if (act === 'add-ch') c.chapters.push({ title: '新章節', lessons: [] });
      if (act === 'del-ch') { if (!confirm('確定刪除這個章節和裡面的所有單元？')) return; c.chapters.splice(ci, 1); }
      if (act === 'add-l') c.chapters[ci].lessons.push({ id: newId('l'), title: '', duration: 0, note: '' });
      if (act === 'del-l') { if (!confirm('確定刪除這個單元？')) return; c.chapters[ci].lessons.splice(li, 1); }
      if (act === 'up' || act === 'down') {
        const ls = c.chapters[ci].lessons, j = act === 'up' ? li - 1 : li + 1;
        [ls[li], ls[j]] = [ls[j], ls[li]];
      }
      if (act === 'delete') {
        if (!confirm(`確定刪除「${c.title || '這門課程'}」？此動作無法復原。`)) return;
        clearTimeout(timer); timer = 0;
        try {
          await chain;
          await fb.deleteDoc(fb.doc(db, COL.courses, c.id));
          await fb.deleteDoc(fb.doc(db, COL.videos, c.id));
          for (const lid of Object.keys(savedArticles)) await fb.deleteDoc(fb.doc(db, COL.articles, c.id, 'lessons', lid));
          courses = courses.filter((x) => x.id !== c.id);
          toast('課程已刪除');
          return go('/admin');
        } catch (err) { return toast('刪除失敗：' + (err.code || err.message)); }
      }
      draw(); bind();
      autosave(0);
    };
    // 打字停下 1 秒、勾選或換顏色後自動儲存
    f.addEventListener('input', (e) => {
      // 文章預覽跟著打字更新
      if (e.target.name === 'description') {
        const pv = app.querySelector('#desc-pv');
        pv.hidden = !e.target.value.trim();
        pv.querySelector('.article').innerHTML = renderArticle(e.target.value);
      }
      if (e.target.dataset.l === 'article') {
        const l = c.chapters[+e.target.dataset.ci].lessons[+e.target.dataset.li];
        const pv = app.querySelector(`[data-preview="${l.id}"]`);
        if (pv) { pv.hidden = !e.target.value.trim(); pv.querySelector('.article').innerHTML = renderArticle(e.target.value); }
      }
      autosave(1000);
    });
    f.addEventListener('change', (e) => { if (e.target.id !== 'cover-file') autosave(300); });

    // 「完成，查看課程」：先存好再前往課程頁
    f.onsubmit = async (e) => {
      e.preventDefault();
      const ok = await saveNow();
      if (ok) go('/course/' + c.id);
    };
  }

  // ---------- 自動儲存 ----------
  let timer = 0, chain = Promise.resolve(), created = !isNew;
  const setStatus = (t, warn = false) => { const el = app.querySelector('#autosave'); if (el) { el.textContent = t; el.classList.toggle('expired', warn); } };
  function autosave(delay) {
    clearTimeout(timer);
    setStatus('編輯中…');
    timer = setTimeout(() => { saveNow(); }, delay);
  }
  // 存檔；有問題時顯示原因、不存（回傳是否成功）
  function saveNow() {
    clearTimeout(timer); timer = 0;
    if (app.querySelector('#ed')) collect();
    const problem = !c.title ? '請輸入課程名稱，才會自動儲存'
      : !lessonsOf(c).length ? '至少需要一個單元'
      : lessonsOf(c).some((l) => !l.title) ? '請填寫所有單元的標題，才會自動儲存'
      : (() => { const bad = lessonsOf(c).find((l) => videos[l.id] && !youtubeId(videos[l.id])); return bad ? `「${bad.title}」的影片網址格式不正確` : ''; })()
      || (() => { const bad = lessonsOf(c).find((l) => links[l.id] && !/^https?:\/\/\S+$/i.test(links[l.id])); return bad ? `「${bad.title}」的文章連結要以 https:// 開頭` : ''; })();
    if (problem) { setStatus('⚠ ' + problem, true); return Promise.resolve(false); }
    // 只保留還存在的單元的影片
    const ids = lessonsOf(c).map((l) => l.id);
    Object.keys(videos).forEach((k) => { if (!ids.includes(k)) delete videos[k]; });
    Object.keys(articles).forEach((k) => { if (!ids.includes(k)) delete articles[k]; });
    Object.keys(links).forEach((k) => { if (!ids.includes(k)) delete links[k]; });
    // 課程頁要知道哪些是文章單元（顯示圖示）；純文章單元依字數估計閱讀時間（每分鐘約 400 字）
    lessonsOf(c).forEach((l) => {
      const art = articles[l.id];
      if ((art || links[l.id]) && !videos[l.id]) { l.kind = 'article'; l.duration = art ? Math.max(1, Math.round(art.length / 400)) * 60 : 0; }
      else { if (l.kind === 'article') l.duration = 0; delete l.kind; }
    });
    const artChanges = [...new Set([...Object.keys(articles), ...Object.keys(links), ...Object.keys(savedArticles)])]
      .filter((k) => artKey(k) !== (savedArticles[k] || JSON.stringify(['', ''])))
      .map((k) => [k, articles[k] || '', links[k] || '']);
    const data = { ...JSON.parse(JSON.stringify(c)), updatedAt: Date.now() };
    delete data.id;
    const vids = { ...videos };
    setStatus('儲存中…');
    chain = chain.then(async () => {
      await fb.setDoc(fb.doc(db, COL.courses, c.id), data);
      await fb.setDoc(fb.doc(db, COL.videos, c.id), vids);
      videoCache[c.id] = vids;
      for (const [lid, text, url] of artChanges) {
        const ref = fb.doc(db, COL.articles, c.id, 'lessons', lid);
        if (text || url) await fb.setDoc(ref, { text, url, updatedAt: Date.now() }); else await fb.deleteDoc(ref);
        if (text || url) savedArticles[lid] = JSON.stringify([text, url]); else delete savedArticles[lid];
        delete articleCache[c.id + '/' + lid];
      }
      const i = courses.findIndex((x) => x.id === c.id);
      if (i > -1) courses[i] = { ...c }; else courses.push({ ...c });
      if (!created) { created = true; history.replaceState(null, '', '#/admin/' + c.id); } // 新課程：網址改成這門課的編輯頁
      setStatus(`✓ 已自動儲存（${fmtTime(Date.now()).slice(-5)}）`);
      return true;
    }).catch((err) => {
      console.error(err);
      setStatus('⚠ 儲存失敗：' + (err.code || err.message), true);
      return false;
    });
    return chain;
  }
  // 離開編輯頁前，把還沒存的修改存起來
  const flushOnLeave = () => { if (timer) saveNow(); };
  window.addEventListener('hashchange', flushOnLeave, { once: true });

  draw();
  bind();
};

/* ---------------- 說明頁：常見問題、隱私權政策、服務條款 ---------------- */
const paragraphs = (t) => linkify(esc(t)).replace(/\n/g, '<br>');
function faqList(items) {
  return '<div class="faq">' + items.map(([q, a]) =>
    `<details class="card"><summary>${esc(q)}</summary><div class="faq-a">${paragraphs(a)}</div></details>`).join('') + '</div>';
}
function infoPage(app, title, body) {
  app.innerHTML = `<div class="container info-page"><a href="#/" class="muted small">← 回到首頁</a><h1>${title}</h1>${body}` +
    `<p class="muted small">最後更新：${esc(SITE_PAGES.updated)} · 聯絡我們：<a class="link" href="mailto:${esc(SITE_PAGES.email)}">${esc(SITE_PAGES.email)}</a></p></div>`;
}
const sections = (list) => list.map(([h, t]) => `<h2>${esc(h)}</h2><p>${paragraphs(t)}</p>`).join('');
// 帳號設定：修改顯示名稱（交流區留言、學生名單會用這個名稱）
pages.account = (app) => {
  if (!user) return go('/login?next=/account');
  app.innerHTML = '<div class="container narrow"><h1>帳號設定</h1><form class="card pad" id="acct">' +
    `<label>Email<input class="input" value="${esc(user.email)}" disabled/></label>` +
    `<label>名稱<input class="input" name="name" maxlength="40" required value="${esc(user.displayName || '')}" placeholder="例如：小明"/></label>` +
    '<p class="muted small">名稱會顯示在網站右上角、心得分享與交流區的留言上（不會顯示 Email）。修改後，你以前的留言也會一起換成新名稱。</p>' +
    '<button class="btn btn-block" id="save-name">儲存</button></form></div>';
  const f = app.querySelector('#acct');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const name = f.name.value.trim().slice(0, 40);
    if (!name) return toast('請輸入名稱');
    const btn = f.querySelector('#save-name');
    btn.disabled = true;
    try {
      await fb.updateProfile(auth.currentUser, { displayName: name });
      user = auth.currentUser;
      renderHeader();
      if (isVerified()) {
        syncStudent(true);
        renamePosts(name);
      }
      toast('名稱已更新');
    } catch (err) {
      toast('更新失敗：' + (err.code || err.message));
    } finally { btn.disabled = false; }
  };
};
// 把自己以前在交流區的留言換成新名稱
async function renamePosts(name) {
  for (const c of courses) {
    try {
      const col = fb.collection(db, COL.posts, c.id, 'posts');
      const snap = await fb.getDocs(fb.query(col, fb.where('uid', '==', user.uid)));
      for (const d of snap.docs) {
        if (d.data().uid === user.uid && d.data().name !== name) await fb.setDoc(fb.doc(db, COL.posts, c.id, 'posts', d.id), { name }, { merge: true });
      }
    } catch (e) { console.warn('留言名稱未更新', c.id, e); }
  }
}

pages.faq = (app) => infoPage(app, '常見問題', faqList(SITE_PAGES.faq));
pages.privacy = (app) => infoPage(app, '隱私權政策', sections(SITE_PAGES.privacy));
pages.terms = (app) => infoPage(app, '服務條款', sections(SITE_PAGES.terms));

function notFound(app) {
  app.innerHTML = '<div class="container"><h1>找不到頁面</h1><p><a class="link" href="#/">回到首頁</a></p></div>';
}

function setupNotice(app) {
  app.innerHTML = '<div class="container narrow"><h1>尚未設定登入</h1><div class="card pad">' +
    '<p>網站管理者還沒填寫 Firebase 設定，所以目前無法登入。</p>' +
    '<p class="muted small">請依照 README.md 的步驟建立 Firebase 專案，並把設定填入 <code>js/config.js</code>。</p></div></div>';
}

/* ---------------- 路由 ---------------- */
let renderId = 0;
async function render() {
  const id = ++renderId;
  await accessReady; // 等開通資料載入完，避免畫面閃一下「尚未開通」
  if (id !== renderId) return; // 期間又換頁了
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const seg = path.split('/').filter(Boolean); // 例如 ['learn', 'react', 'l3']

  renderHeader();
  const main = document.getElementById('app');
  const app = document.createElement('div'); // 每頁一個新容器
  main.replaceChildren(app);
  window.scrollTo(0, 0);

  const page = pages[seg[0] || 'home'];
  if (page) page(app, seg[1], query, seg[2]);
  else notFound(app);
}

window.addEventListener('hashchange', render);

if (configured) {
  document.getElementById('app').innerHTML = '<div class="container"><p class="muted" style="padding:48px 0">載入中…</p></div>';
  initFirebase().catch((e) => {
    console.error(e);
    toast('無法連線到登入服務，請稍後再試');
    render();
  });
} else {
  render();
}
