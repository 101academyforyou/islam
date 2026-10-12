/* 網站設定（和 1.01 Academy 共用同一個 Firebase 專案）
 *
 * firebaseConfig：到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式 → SDK 設定，
 * 複製「const firebaseConfig = {...}」裡的內容貼到下面。
 * 這些值本來就會公開在網頁上，放在 GitHub 是安全的；真正的保護靠 firestore.rules。
 */
window.SITE_CONFIG = {
  firebaseConfig: {
    apiKey: 'AIzaSyAYqxTZVjg4XZhsXMsmHhFv8ASAmv8RfRU',
    authDomain: 'academy-213ba.firebaseapp.com',
    projectId: 'academy-213ba',
    storageBucket: 'academy-213ba.firebasestorage.app',
    messagingSenderId: '678711804375',
    appId: '1:678711804375:web:fb897bd9b526426e018b92'
  },

  // 網站名稱與首頁文字
  siteName: '循序漸進學伊斯蘭',
  tagline: '一步一步，認識伊斯蘭',
  intro: '從最基礎開始，依照學習路線循序漸進。所有課程免費，登入後加入課程即可觀看。',

  // 管理者 Email：登入後可在網站上編輯課程（右上角「管理」）
  // ⚠️ 只改這裡不夠，也要同步修改 1.01academy repo 的 firestore.rules 裡的 isAdmin()，那裡才是真正的權限控管
  admins: ['salimachchang@gmail.com']
};
