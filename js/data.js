/* 預設的學習路線（第一次使用時，到「管理」按「匯入現有課程到資料庫」，之後都在網站上編輯）
 *
 * ⚠️ 這裡不要放課程影片的 YouTube 連結！這個檔案任何人都看得到。
 *    影片網址請在網站的「管理 → 編輯課程」貼上（存在 Firebase，只有加入課程的學生讀得到）。
 *
 * 陣列順序 = 學習路線的階段順序。
 * 單元格式：['單元id', '單元標題', 秒數, '單元說明（可省略）']
 * 以下是範本大綱，請依你的教學內容修改。
 */
var CATEGORIES = ['全部'];

var COURSES = [
  {
    id: 'stage1', title: '認識伊斯蘭', subtitle: '什麼是伊斯蘭？從基本概念開始',
    category: '', level: '入門', price: 0, instructor: '',
    thumb: ['#0f766e', '#14b8a6', '入門'], trailer: '',
    description: '認識伊斯蘭的基本概念：伊斯蘭與穆斯林的意義、古蘭經與聖訓，以及穆斯林日常生活的樣貌。適合第一次接觸伊斯蘭的人。',
    outcomes: ['了解「伊斯蘭」與「穆斯林」的意思', '認識古蘭經與聖訓', '對穆斯林的生活有基本的認識'],
    chapters: [{ title: '課程內容', lessons: [
      ['l1', '什麼是伊斯蘭', 0], ['l2', '古蘭經與聖訓', 0], ['l3', '穆斯林的日常生活', 0]
    ] }]
  },
  {
    id: 'stage2', title: '信仰的基礎', subtitle: '六大信仰',
    category: '', level: '入門', price: 0, instructor: '',
    thumb: ['#115e59', '#0d9488', '信仰'], trailer: '',
    description: '介紹伊斯蘭的六大信仰：信真主、信天使、信經典、信使者、信後世、信前定。',
    outcomes: ['認識六大信仰的內容', '理解信仰在穆斯林生活中的角色'],
    chapters: [{ title: '課程內容', lessons: [
      ['l1', '信真主', 0], ['l2', '信天使', 0], ['l3', '信經典', 0],
      ['l4', '信使者', 0], ['l5', '信後世', 0], ['l6', '信前定', 0]
    ] }]
  },
  {
    id: 'stage3', title: '五功', subtitle: '伊斯蘭的五項功修',
    category: '', level: '基礎', price: 0, instructor: '',
    thumb: ['#134e4a', '#0f766e', '五功'], trailer: '',
    description: '介紹伊斯蘭的五項功修：唸（作證詞）、禮（禮拜）、齋（齋戒）、課（天課）、朝（朝覲）。',
    outcomes: ['認識五功的意義', '了解五功在生活中如何實踐'],
    chapters: [{ title: '課程內容', lessons: [
      ['l1', '唸：作證詞', 0], ['l2', '禮：禮拜', 0], ['l3', '齋：齋戒', 0],
      ['l4', '課：天課', 0], ['l5', '朝：朝覲', 0]
    ] }]
  },
  {
    id: 'stage4', title: '禮拜入門', subtitle: '從淨身到完成一次禮拜',
    category: '', level: '基礎', price: 0, instructor: '',
    thumb: ['#065f46', '#059669', '禮拜'], trailer: '',
    description: '一步一步學習禮拜：淨身、禮拜的時間與方向、禮拜的動作與唸詞。',
    outcomes: ['學會淨身的步驟', '了解每日禮拜的時間', '能完成一次完整的禮拜'],
    chapters: [{ title: '課程內容', lessons: [
      ['l1', '淨身', 0], ['l2', '禮拜的時間與方向', 0], ['l3', '禮拜的動作與唸詞', 0]
    ] }]
  },
  {
    id: 'stage5', title: '生活中的伊斯蘭', subtitle: '品德、飲食與人際',
    category: '', level: '進階', price: 0, instructor: '',
    thumb: ['#164e63', '#0891b2', '生活'], trailer: '',
    description: '把所學帶進日常生活：品德與待人處事、清真飲食、家庭與社會中的伊斯蘭。',
    outcomes: ['了解伊斯蘭重視的品德', '認識清真（Halal）飲食', '把所學應用在日常生活中'],
    chapters: [{ title: '課程內容', lessons: [
      ['l1', '品德與待人處事', 0], ['l2', '清真飲食', 0], ['l3', '家庭與社會', 0]
    ] }]
  }
];

COURSES.forEach(function (c) {
  c.chapters.forEach(function (ch) {
    ch.lessons = ch.lessons.map(function (l) { return { id: l[0], title: l[1], duration: l[2], note: l[3] || '' }; });
  });
});
