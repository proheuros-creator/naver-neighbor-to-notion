/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 * 
 * ✅ 주요 기능:
 *  - NAVER_NEIGHBOR_API_URL 기반으로 BuddyPostList를 반복 요청하여 글 목록 수집
 *  - MAX_PAGE → 1페이지까지 역순(최신 페이지 우선) 스크랩
 *  - 각 페이지 내 글은 “아래 → 위” 순서로 처리 (오래된 글 → 최신 글)
 *  - postId + blogId 조합으로 Notion 중복 등록 방지 (UniqueID)
 *  - Notion 데이터베이스에 글 정보를 자동 저장
 *  - (옵션) NAVER_NEIGHBOR_GROUP / 응답 값으로 이웃그룹(Group) 태깅
 */

import 'dotenv/config';
import fetch from 'node-fetch';
import { upsertPost } from './notion.js';

// ───────────────────────────────────────────────
// 🔧 환경변수 로드
// ───────────────────────────────────────────────
const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

// 이 워크플로우가 특정 이웃 그룹용이면 여기서 라벨링
// 예: NAVER_NEIGHBOR_GROUP="전체", "직장", "VIP", ...
const NEIGHBOR_GROUP_LABEL = process.env.NAVER_NEIGHBOR_GROUP || '';

// 필수 환경변수 확인
if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다.');
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error('❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.');
  process.exit(1);
}

/**
 * 특정 페이지 번호로 API URL 생성
 *  - 예: page=1 → page=2 로 바꿔줌
 *  - URL 객체 생성 실패 시 문자열 치환 fallback
 */
function buildPageUrl(page) {
  try {
    const url = new URL(API_TEMPLATE);
    url.searchParams.set('page', String(page));
    return url.toString();
  } catch (e) {
    return API_TEMPLATE.replace(/page=\d+/, `page=${page}`);
  }
}

/**
 * 네이버 JSON 응답 앞부분의 보안 문자열 제거
 *  - 예: “)]}',” 같은 프리픽스를 제거해야 JSON 파싱 가능
 */
function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, '');
}

/**
 * JSON 파싱 실패 시 일부만 미리보기용으로 출력
 */
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || '');
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? '...' : '');
}

/**
 * 네이버 BuddyPostList API에서 특정 페이지의 글 목록을 가져옴
 */
async function fetchPagePosts(page) {
  const url = buildPageUrl(page);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverNeighborScraper)',
      Cookie: NAVER_COOKIE,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://section.blog.naver.com/BlogHome.naver',
    },
  });

  if (!res.ok) {
    console.error(`❌ ${page}페이지 API 요청 실패:`, res.status, res.statusText);
    return { posts: [] };
  }

  const raw = await res.text();

  let data;
  try {
    const cleaned = stripNaverPrefix(raw);
    data = JSON.parse(cleaned);
  } catch (e) {
    console.error(`❌ ${page}페이지 JSON 파싱 실패:`, e.message);
    console.error(cleanedPreview(raw));
    return { posts: [] };
  }

  const result = data.result || data;
  const list =
    result.buddyPostList ||
    result.postList ||
    result.list ||
    result.items ||
    [];

  let posts = list
    .map((item) => {
      const title = item.title || item.postTitle || '';
      const blogId =
        item.blogId ||
        item.blogNo ||
        item.bloggerId ||
        '';
      const logNo =
        item.logNo ||
        item.postId ||
        item.articleId ||
        null;

      const link =
        item.url ||
        item.postUrl ||
        item.blogPostUrl ||
        (blogId && logNo
          ? `https://blog.naver.com/${blogId}/${logNo}`
          : '');

      const nickname =
        item.nickName ||
        item.bloggerName ||
        item.userName ||
        '';

      const pubdate =
        item.addDate ||
        item.postDate ||
        item.writeDate ||
        item.regDate ||
        item.createdAt ||
        null;

      const description =
        item.briefContents ||
        item.summary ||
        item.contentsPreview ||
        item.previewText ||
        '';

      const postId = logNo || null;

      // 🔹 이웃 그룹 (있으면 응답값 우선, 없으면 워크플로우 라벨)
      const group =
        item.groupName ||
        item.buddyGroupName ||
        NEIGHBOR_GROUP_LABEL ||
        '';

      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
        group, // 👉 notion.js로 전달
      };
    })
    .filter(Boolean);

  // 오래된 글 → 최신 글 순서로 처리하기 위해 reverse()
  posts = posts.reverse();

  return { posts };
}

/**
 * 전체 실행 프로세스
 */
async function main() {
  console.log('🚀 BuddyPostList API → Notion 스크랩 시작');
  console.log(`📄 대상 페이지: ${MAX_PAGE} → 1 (내림차순, 각 페이지는 아래→위 순서)`);

  let total = 0;

  for (let page = MAX_PAGE; page >= 1; page--) {
    const { posts } = await fetchPagePosts(page);
    console.log(`📥 ${page}페이지에서 가져온 글 수: ${posts.length}`);
    total += posts.length;

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error('❌ Notion 저장 오류:', err.message);
      }

      await new Promise((r) => setTimeout(r, 300)); // 글 간 딜레이
    }

    await new Promise((r) => setTimeout(r, 1000)); // 페이지 간 딜레이
  }

  console.log(`✅ 전체 스크랩 완료. 총 ${total}건 처리 시도.`);
}

main().catch((err) => {
  console.error('❌ 스크립트 전체 오류:', err);
  process.exit(1);
});
