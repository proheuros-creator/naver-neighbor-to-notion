// neighbor-activity/config.js

module.exports = {
  // 네이버 블로그 이웃 관리 화면 기본 URL
  adminBuddyUrl:
    "https://admin.blog.naver.com/AdminMain.naver?blogId=proheuros&Redirect=Buddyinfo",

  // 페이지 최대 탐색 수 (실제보다 넉넉히, 중간에 자동 종료함)
  maxPages: 30,

  // 블로그 하나 긁고 다음으로 넘어가기 전 대기(ms)
  delayMs: 1500
};
