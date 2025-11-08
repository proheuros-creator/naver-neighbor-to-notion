/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 * 
 * ✅ 주요 특징
 *  - 150페이지 → 1페이지까지 역순 스크랩 (최신 글부터)
 *  - 각 페이지의 글도 아래 → 위 순서(즉, 최신 순)로 저장
 *  - 중복 체크: blogId + postId (UniqueID)
 *  - 가져오는 필드: title, link, nickname, pubdate, category, description, blogId
 *  - pubdate는 ISO 변환 후 Notion date로 저장
 * 
 * ⚙️ 필요한 환경변수 (.env 또는 GitHub Secrets)
 *  - NAVER_COOKIE : 로그인 세션 쿠키 (JSESSIONID 포함)
 *  - NAVER_NEIGHBOR_API_URL : BuddyPostList API 기본 URL (예: https://section.blog.naver.com/ajax/BuddyPostList.naver?page=1&groupId=0)
 *  - NOTION_API_KEY : 노션 API 키
 *  - NOTION_DATABASE_ID : 노션 데이터베이스 ID
 *  - MAX_PAGE : 스크랩할 마지막 페이지 번호 (예: 150)
 */

import axios from 'axios';
import { upsertPost } from './notion.js';

// ✅ 환경변수 로드
const NAVER_COOKIE = process.env.NAVER_COOKIE;
const NAVER_NEIGHBOR_API_URL = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = parseInt(process.env.MAX_PAGE || '150', 10);

// 기본 검증
if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다.');
  process.exit(1);
}
if (!NAVER_NEIGHBOR_API_URL) {
  console.error('❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.');
  process.exit(1);
}

// ✅ 페이지 순서 설정
const START_PAGE = MAX_PAGE; // ex: 150
const END_PAGE = 1;          // ex: 1
const DESCENDING = true;     // true → 최신(150→1), false → 오래된(1→150)

console.log(
  `🚀 BuddyPostList API → Notion 스크랩 시작\n📄 대상 페이지: ${START_PAGE} → ${END_PAGE} (내림차순, 각 페이지는 역순 수집)`
);

// ✅ Naver API 요청 함수
async function fetchNeighborPosts(page) {
  try {
    const url = `${NAVER_NEIGHBOR_API_URL.split('?')[0]}?page=${page}&groupId=0`;
    const res = await axios.get(url, {
      headers: {
        Cookie: NAVER_COOKIE,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.5993.90 Safari/537.36',
        Referer: 'https://section.blog.naver.com/BlogHome.naver',
        Accept: 'application/json, text/plain, */*',
      },
    });

    // 응답 앞의 보안 문자열 제거 “)]}',”
    let text = res.data;
    if (typeof text === 'string' && text.startsWith(')]}\',')) {
      text = text.slice(5);
    }

    const json = typeof text === 'string' ? JSON.parse(text) : text;

    if (!json?.result?.buddyPostList) return [];

    const posts = json.result.buddyPostList.map((item) => ({
      title: item.title || '',
      link: item.blogPostUrl || '',
      nickname: item.nickName || '',
      pubdate: item.addDate || '',
      category: item.categoryName || '',
      description: item.summary || '',
      blogId: item.blogId || '',
      postId: item.logNo || '',
    }));

    // 하단 → 상단(최신 순)으로 뒤집기
    return posts.reverse();
  } catch (err) {
    console.error(`❌ ${page}페이지 JSON 파싱 실패: ${err.message}`);
    return [];
  }
}

// ✅ 메인 실행 루프
async function main() {
  for (
    let page = START_PAGE;
    DESCENDING ? page >= END_PAGE : page <= END_PAGE;
    DESCENDING ? page-- : page++
  ) {
    const posts = await fetchNeighborPosts(page);
    console.log(`📥 ${page}페이지에서 가져온 글 수: ${posts.length}`);

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error(`❌ Notion 저장 오류: ${err.message}`);
      }

      // API 부하 완화
      await new Promise((r) => setTimeout(r, 300));
    }

    // 페이지 간 대기 (1초)
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log('✅ 전체 스크랩 완료');
}

main();
