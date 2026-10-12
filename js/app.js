/* 循序漸進學伊斯蘭 — GitHub Pages + Firebase 登入版（所有課程免費）
 *
 * 流程：瀏覽學習路線（公開）→ 登入 → 在課程頁按「加入課程」→ 觀看不公開的 YouTube 影片
 *
 * 和 1.01 Academy 共用同一個 Firebase 專案（同一套學生帳號），資料放在 islam_ 開頭的集合：
 *   islam_courses/{課程id}、islam_courseVideos/{課程id}、islam_enroll/{Email}/courses/{課程id}
 * 安全規則在 1.01academy repo 的 firestore.rules。
 */
// 這個網站的 Firestore 集合名稱
const COL = { courses: 'islam_courses', videos: 'islam_courseVideos', enroll: 'islam_enroll' };
const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
const CONFIG = window.SITE_CONFIG || {};
const configured = !!(CONFIG.firebaseConfig && CONFIG.firebaseConfig.apiKey);

let fb = null;           // Firebase 函式
let auth = null, db = null, fbApp = null;
let user = null;         // 目前登入的 Firebase 使用者
let joined = [];         // 已加入的課程 id（從課程頁按「加入課程」）
let accessReady = Promise.resolve();
const videoCache = {};   // 課程 id → { 單元 id: YouTube ID }
let courses = COURSES;   // 課程目錄：優先讀 Firestore 的 courses 集合，讀不到時用 data.js
let coursesFromDb = false;

/* ---------------- 小工具 ---------------- */
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const clock = (s) => !s ? '' : Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
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

const isVerified = () => !!(user && user.emailVerified);
const isAdmin = () => isVerified() && (CONFIG.admins || []).some((e) => e.toLowerCase() === user.email.toLowerCase());
const hasJoined = (id) => joined.includes(id);
// 所有課程免費：登入（並驗證 Email）後在課程頁按「加入課程」就能看，每門課分開加入
const owns = (courseId) => isVerified() && (isAdmin() || hasJoined(courseId));
// 學習路線：首頁列出的課程依序是第 1、2、3… 階段
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
  if (!isVerified()) return;
  try {
    const snap = await fb.getDocs(fb.collection(db, COL.enroll, user.email.toLowerCase(), 'courses'));
    joined = snap.docs.map((d) => d.id);
  } catch (e) {
    console.error(e);
  }
}

// 加入課程（每門課分開加入）
async function joinCourse(c, btn) {
  btn.disabled = true;
  try {
    await fb.setDoc(fb.doc(db, COL.enroll, user.email.toLowerCase(), 'courses', c.id), { joinedAt: Date.now() });
    if (!joined.includes(c.id)) joined.push(c.id);
    toast('已加入課程');
    go('/learn/' + c.id);
  } catch (err) {
    btn.disabled = false;
    toast('加入失敗：' + (err.code || err.message) + '（請確認已部署最新的 Firestore 規則）');
  }
}

// 從 Firestore 讀取課程目錄；資料庫還沒有課程時，沿用 data.js
async function loadCourses() {
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
    '<a href="#/">學習路線</a>' +
    (user
      ? `<a href="#/my">我的課程</a>${isAdmin() ? '<a href="#/admin">管理</a>' : ''}<span class="muted small user-name" title="${esc(user.email)}">${esc(name)}</span><button class="link" id="logout">登出</button>`
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

// 課程狀態（學習路線、我的課程共用）
function statusOf(c) {
  if (!isVerified() || !owns(c.id)) return '';
  const p = progress(c);
  return p === 100 ? '<span class="owned">✓ 已完成</span>' : `<span class="owned">✓ 已加入 · 進度 ${p}%</span>`;
}

// 首頁：學習路線（公開）
pages.home = (app) => {
  const path = listedCourses().filter((c) => !c.unlisted);
  const hidden = listedCourses().filter((c) => c.unlisted); // 管理者才看得到
  const row = (c, n) =>
    `<a class="card step" href="#/course/${c.id}">` +
    `<span class="step-no">${n ? n : '–'}</span>${thumb(c)}<div class="step-body">` +
    `<span class="tag">${[n ? `第 ${n} 階段` : '', c.level, c.unlisted ? '不公開' : '', c.published === false ? '未上架' : ''].filter(Boolean).map(esc).join(' · ')}</span>` +
    `<h3>${esc(c.title)}</h3><p class="muted small">${esc(c.subtitle || '')}</p>` +
    `<p class="muted small">${lessonsOf(c).length} 個單元${minutesText(c)}</p><div>${statusOf(c) || '<span class="price free">免費</span>'}</div></div></a>`;
  app.innerHTML =
    '<section class="hero"><div class="container">' +
    `<h1>${esc(CONFIG.tagline || '一步一步，認識伊斯蘭')}</h1>` +
    `<p class="lead muted">${esc(CONFIG.intro || '從最基礎開始，依照學習路線循序漸進。所有課程免費，登入後加入課程即可觀看。')}</p>` +
    '</div></section>' +
    '<section class="container"><h2>學習路線</h2>' +
    (path.length ? '<div class="path">' + path.map((c, i) => row(c, i + 1)).join('') + '</div>' : '<p class="muted">課程準備中，敬請期待。</p>') +
    (hidden.length ? '<h3 class="muted">不公開的課程（只有管理者看得到這個列表）</h3><div class="path">' + hidden.map((c) => row(c, 0)).join('') + '</div>' : '') +
    '</section>' +
    '<section class="container home-faq"><h2>常見問題</h2>' + faqList(SITE_PAGES.faq.slice(0, 5)) +
    '<p><a class="link" href="#/faq">查看全部常見問題 →</a></p></section>';
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
      '<p class="muted small">加入後這門課會出現在「我的課程」，可以隨時觀看。</p>';
  }
  // 循序漸進：前一階段還沒完成時，溫和提醒（不強制）
  const hint = prev && !(owns(prev.id) && progress(prev) === 100)
    ? `<div class="notice small">建議先完成第 ${n - 1} 階段：<a class="link" href="#/course/${prev.id}">${esc(prev.title)}</a></div>` : '';

  app.innerHTML = '<div class="container course-page">' +
    `<div><a href="#/" class="muted small">← 學習路線</a>` +
    (isAdmin() ? ` · <a href="#/admin/${c.id}" class="link small">✎ 編輯此課程</a>` + (c.published === false ? ' <span class="tag">（未上架）</span>' : '') : '') +
    (n ? `<p class="step-label">第 ${n} 階段</p>` : '') +
    `<h1>${esc(c.title)}</h1><p class="lead muted">${esc(c.subtitle)}</p>` +
    `<p class="muted small">${[c.instructor ? '講師 ' + esc(c.instructor) : '', esc(c.level), lessonsOf(c).length + ' 個單元'].filter(Boolean).join(' · ')}${minutesText(c)}</p>` + hint +
    (c.trailer ? '<h2>課程預告</h2>' + youtubeEmbed(c.trailer) : '') +
    `<h2>課程介紹</h2><p>${esc(c.description)}</p>` +
    ((c.outcomes || []).length ? `<h2>你將學到</h2><ul class="checks">${c.outcomes.map((o) => `<li>${esc(o)}</li>`).join('')}</ul>` : '') +
    '<h2>課程內容</h2>' + c.chapters.map((ch) =>
      `<div class="card chapter"><strong>${esc(ch.title)}</strong>` +
      ch.lessons.map((l) => `<div class="lesson"><span>${mine ? '▶' : '🔒'} ${esc(l.title)}</span><span class="muted small">${clock(l.duration)}</span></div>`).join('') +
      '</div>').join('') +
    '</div>' +
    `<aside class="card buy">${thumb(c)}<div class="pad">${box}</div></aside></div>`;
  const joinBtn = app.querySelector('#join');
  if (joinBtn) joinBtn.onclick = () => joinCourse(c, joinBtn);
};

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

// 我的課程
pages.my = (app) => {
  if (!user) return go('/login?next=/my');
  if (!isVerified()) return pages.verify(app);
  const list = visibleCourses().filter((c) => hasJoined(c.id) || isAdmin());
  app.innerHTML = '<div class="container"><h1>我的課程</h1>' + (list.length
    ? '<div class="grid">' + list.map((c) => {
        const p = progress(c), n = c.unlisted ? 0 : stepOf(c);
        return `<a class="card course" href="#/learn/${c.id}">${thumb(c)}<div class="pad">` +
          (n ? `<span class="tag">第 ${n} 階段</span>` : '') + `<h3>${esc(c.title)}</h3>` +
          `<div class="bar"><i style="width:${p}%"></i></div><p class="muted small">已完成 ${p}%</p></div></a>`;
      }).join('') + '</div>'
    : '<div class="card pad"><p>你還沒有加入任何課程。</p>' +
      '<p class="muted small">到學習路線選擇課程，在課程頁按「加入課程」就能開始學習，建議從第 1 階段開始。</p>' +
      '<a href="#/" class="btn btn-sm">查看學習路線</a></div>') + '</div>';
};

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
  let videos;
  try {
    videos = await loadVideos(c.id);
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

  app.innerHTML = '<div class="player">' +
    '<div>' +
    // 單元資訊與按鈕在影片上方
    `<div class="pad lesson-head"><div><p class="muted small">單元 ${i + 1} / ${all.length}</p><h2>${esc(cur.title)}</h2></div>` +
    '<div class="lesson-nav">' +
    (i > 0 ? `<a class="btn btn-ghost btn-sm" href="#/learn/${c.id}/${all[i - 1].id}">← 上一單元</a>` : '') +
    `<button class="btn btn-sm ${isDone ? 'btn-ghost' : ''}" id="done">${isDone ? '✓ 已完成' : '標記完成'}</button>` +
    (i < all.length - 1 ? `<a class="btn btn-ghost btn-sm" href="#/learn/${c.id}/${all[i + 1].id}">下一單元 →</a>` : '') +
    '</div></div>' +
    youtubeEmbed(videos[cur.id]) +
    '<div class="pad share-warning">🔒 本課程影片為不公開影片，影片連結僅供你本人觀看學習，<strong>請勿分享給其他人</strong>。</div>' +
    // 單元說明（在 data.js 每個單元的第 4 個欄位填寫）
    (cur.note ? `<div class="pad lesson-note"><h3>單元說明</h3><div>${linkify(esc(cur.note)).replace(/\n/g, '<br>')}</div></div>` : '') +
    '</div>' +
    `<aside class="side"><div class="pad"><strong>${esc(c.title)}</strong><div class="bar"><i style="width:${progress(c)}%"></i></div>` +
    `<span class="muted small">進度 ${progress(c)}%</span>` +
    (progress(c) === 100 && nextCourse(c) ? `<a class="btn btn-sm btn-block next-step" href="#/course/${nextCourse(c).id}">下一階段：${esc(nextCourse(c).title)} →</a>` : '') + '</div>' +
    c.chapters.map((ch) => `<div class="side-ch">${esc(ch.title)}</div>` + ch.lessons.map((l) => {
      const d = done.includes(l.id);
      return `<a class="side-l${l === cur ? ' active' : ''}" href="#/learn/${c.id}/${l.id}">` +
        `<span class="dot${d ? ' done' : ''}">${d ? '✓' : ''}</span>${esc(l.title)}<span class="muted small">${clock(l.duration)}</span></a>`;
    }).join('')).join('') + '</aside></div>';

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
  if (id) return pages.edit(app, id);
  app.innerHTML = '<div class="container">' + adminTabs('courses') + '<div class="row-between"><h1>課程管理</h1><a class="btn btn-sm" href="#/admin/new">＋ 新增課程</a></div>' +
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
  `<a class="chip${cur === 'courses' ? ' active' : ''}" href="#/admin">課程管理（順序 = 學習路線的階段）</a></div>`;

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
  if (!isNew) {
    try { videos = { ...(await fb.getDoc(fb.doc(db, COL.videos, c.id))).data() }; } catch (e) { console.error(e); }
  }
  if (!document.body.contains(app)) return;

  const field = (label, name, val, attrs = '') => `<label>${label}<input class="input" name="${name}" value="${esc(val)}" ${attrs}/></label>`;
  const area = (label, name, val, rows = 4, hint = '') => `<label>${label}${hint ? ` <span class="muted small">${hint}</span>` : ''}<textarea class="input textarea" name="${name}" rows="${rows}">${esc(val)}</textarea></label>`;

  function draw() {
    app.innerHTML = `<div class="container editor"><a href="#/admin" class="muted small">← 課程管理</a><h1>${isNew ? '新增課程' : '編輯課程'}</h1>` +
      '<form id="ed" novalidate>' +
      '<div class="card pad"><h3>基本資訊</h3>' +
      field('課程名稱', 'title', c.title, 'required') +
      field('副標題', 'subtitle', c.subtitle) +
      '<div class="two">' + field('程度', 'level', c.level) + field('講師', 'instructor', c.instructor) + '</div>' +
      '<p class="muted small">學習路線的順序在「課程管理」用「↑ 往前」調整。</p>' +
      `<label class="check"><input type="checkbox" name="published" ${c.published !== false ? 'checked' : ''}/> 上架（取消勾選則只有管理者看得到）</label>` +
      `<label class="check"><input type="checkbox" name="unlisted" ${c.unlisted ? 'checked' : ''}/> 不公開：不列在學習路線，只有拿到課程連結的人才能進入</label>` +
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
      area('課程介紹', 'description', c.description, 5) +
      area('你將學到', 'outcomes', (c.outcomes || []).join('\n'), 4, '每行一項') +
      field('公開預告片 YouTube 網址（可留空，任何人都看得到）', 'trailer', c.trailer || '') +
      '</div>' +

      '<div class="card pad"><div class="row-between"><h3>章節與單元</h3><button type="button" class="btn btn-ghost btn-sm" data-act="add-ch">＋ 新增章節</button></div>' +
      '<p class="muted small">單元影片網址只有加入課程的學生和管理者看得到。</p>' +
      c.chapters.map((ch, ci) =>
        `<div class="ed-chapter"><div class="row-between"><input class="input" data-ch="${ci}" value="${esc(ch.title)}" placeholder="章節名稱"/>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-act="del-ch" data-ci="${ci}">刪除章節</button></div>` +
        ch.lessons.map((l, li) =>
          `<div class="ed-lesson"><div class="row-between"><strong class="small">單元 ${li + 1}</strong><span class="lesson-nav">` +
          (li > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-act="up" data-ci="${ci}" data-li="${li}">↑</button>` : '') +
          (li < ch.lessons.length - 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-act="down" data-ci="${ci}" data-li="${li}">↓</button>` : '') +
          `<button type="button" class="btn btn-ghost btn-sm" data-act="del-l" data-ci="${ci}" data-li="${li}">刪除</button></span></div>` +
          `<label>單元標題<input class="input" data-l="title" data-ci="${ci}" data-li="${li}" value="${esc(l.title)}"/></label>` +
          `<label>影片 <span class="muted small">貼上「不公開」YouTube 影片網址</span><input class="input" data-l="video" data-ci="${ci}" data-li="${li}" value="${esc(videos[l.id] || '')}" placeholder="https://youtu.be/…"/></label>` +
          `<label>單元說明 <span class="muted small">顯示在影片下方，網址會變成連結</span><textarea class="input textarea" rows="3" data-l="note" data-ci="${ci}" data-li="${li}">${esc(l.note || '')}</textarea></label></div>`
        ).join('') +
        `<button type="button" class="btn btn-ghost btn-sm" data-act="add-l" data-ci="${ci}">＋ 新增單元</button></div>`
      ).join('') + '</div>' +

      '<div class="editor-actions"><button class="btn" id="save">儲存</button>' +
      (isNew ? '' : '<button type="button" class="btn btn-ghost" data-act="delete">刪除課程</button>') +
      '</div></form></div>';
  }

  // 把表單內容寫回工作副本（重畫前呼叫，避免輸入內容遺失）
  function collect() {
    const f = app.querySelector('#ed');
    if (!f) return;
    c.title = f.title.value.trim();
    c.subtitle = f.subtitle.value.trim();
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
      try { collect(); c.cover = await resizeCover(file); draw(); bind(); toast('封面已更新，記得按「儲存」'); }
      catch (e) { toast('無法讀取這張圖片'); }
    };
    const rm = app.querySelector('#cover-remove');
    if (rm) rm.onclick = () => { collect(); c.cover = ''; draw(); bind(); };
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
        if (!confirm(`確定刪除「${src.title}」？此動作無法復原。`)) return;
        try {
          await fb.deleteDoc(fb.doc(db, COL.courses, c.id));
          await fb.deleteDoc(fb.doc(db, COL.videos, c.id));
          courses = courses.filter((x) => x.id !== c.id);
          toast('課程已刪除');
          return go('/admin');
        } catch (err) { return toast('刪除失敗：' + (err.code || err.message)); }
      }
      draw(); bind();
    };

    f.onsubmit = async (e) => {
      e.preventDefault();
      collect();
      if (!c.title) return toast('請輸入課程名稱');
      if (!lessonsOf(c).length) return toast('至少需要一個單元');
      if (lessonsOf(c).some((l) => !l.title)) return toast('請填寫所有單元的標題');
      const bad = lessonsOf(c).find((l) => videos[l.id] && !youtubeId(videos[l.id]));
      if (bad) return toast(`「${bad.title}」的影片網址格式不正確`);
      // 只保留還存在的單元的影片
      const ids = lessonsOf(c).map((l) => l.id);
      Object.keys(videos).forEach((k) => { if (!ids.includes(k)) delete videos[k]; });
      const btn = app.querySelector('#save');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        const data = { ...c, updatedAt: Date.now() };
        delete data.id;
        await fb.setDoc(fb.doc(db, COL.courses, c.id), data);
        await fb.setDoc(fb.doc(db, COL.videos, c.id), videos);
        videoCache[c.id] = { ...videos };
        const i = courses.findIndex((x) => x.id === c.id);
        if (i > -1) courses[i] = { ...c }; else courses.push({ ...c });
        toast('已儲存');
        go('/course/' + c.id);
      } catch (err) {
        console.error(err);
        btn.disabled = false; btn.textContent = '儲存';
        toast('儲存失敗：' + (err.code || err.message));
      }
    };
  }

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
