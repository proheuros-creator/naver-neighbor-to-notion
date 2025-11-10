/**
 * index.js
 * ───────────────────────────────────────────────
 * 🧭 네이버 블로그 이웃새글 → Notion 자동 스크랩 메인 실행 파일
 * 
 * ✅ 주요 기능:
 *  - NAVER_NEIGHBOR_API_URL 기반으로 BuddyPostList를 반복 요청하여 글 목록 수집
 *  - 150페이지 → 1페이지까지 역순(최신 페이지 우선) 스크랩
 *  - 각 페이지 내 글은 “아래 → 위” 순서로 처리 (오래된 글 → 최신 글)
 *  - postId + blogId 조합으로 Notion 중복 등록 방지
 *  - Notion 데이터베이스에 글 정보를 자동 저장
 *  - groups.js에 정의된 groupId별로 자동 순회하며 스크랩
 */

import 'dotenv/config';
import fetch from 'node-fetch';
import { upsertPost } from './notion.js';
import { GROUPS } from './groups.js'; // ✅ 그룹 목록 불러오기

// 환경변수 로드
const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

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
 * 특정 페이지 번호와 그룹 ID로 API URL 생성
 *  - 예: page=1 → page=2 로 바꿔줌
 *  - URL 객체 생성 실패 시 문자열 치환 fallback
 */
function buildPageUrl(page, groupId) {
  try {
    const url = new URL(API_TEMPLATE);
    url.searchParams.set('currentPage', String(page));
    url.searchParams.set('groupId', String(groupId));
    return url.toString();
  } catch (e) {
    // 혹시 URL 생성 실패 시 단순 문자열 치환으로 대체
    return API_TEMPLATE
      .replace(/currentPage=\d+/, `currentPage=${page}`)
      .replace(/groupId=\d+/, `groupId=${groupId}`);
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
 *  - 긴 응답 전체를 콘솔에 찍지 않기 위한 조치
 */
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || '');
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? '...' : '');
}

/**
 * 네이버 BuddyPostList API에서 특정 페이지의 글 목록을 가져옴
 */
async function fetchPagePosts(page, groupId) {
  const url = buildPageUrl(page, groupId);

  // 쿠키 인증 헤더 포함 (로그인 기반 접근용)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverNeighborScraper)',
      Cookie: NAVER_COOKIE,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://section.blog.naver.com/BlogHome.naver',
    },
  });

  // 요청 실패 처리
  if (!res.ok) {
    console.error(`❌ groupId=${groupId} | ${page}페이지 API 요청 실패:`, res.status, res.statusText);
    return { posts: [] };
  }

  // 응답 텍스트 읽기
  const raw = await res.text();

  // JSON 파싱 (보안 prefix 제거 포함)
  let data;
  try {
    const cleaned = stripNaverPrefix(raw);
    data = JSON.parse(cleaned);
  } catch (e) {
    console.error(`❌ groupId=${groupId} | ${page}페이지 JSON 파싱 실패:`, e.message);
    console.error(cleanedPreview(raw));
    return { posts: [] };
  }

  // BuddyPostList 구조 추출 (서버 버전에 따라 key 이름이 다를 수 있음)
  const result = data.result || data;
  const list =
    result.buddyPostList ||
    result.postList ||
    result.list ||
    result.items ||
    [];

  // 필요한 필드만 추출
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

      // 블로그 URL (없으면 blogId/logNo 조합으로 생성)
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

      // 필수 항목(title, link, postId)이 없으면 제외
      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        blogId,
        postId,
      };
    })
    .filter(Boolean);

  /**
   * ✅ 순서 조정:
   *   - 네이버 응답은 보통 “최신글 → 오래된 글” 순으로 정렬됨.
   *   - 우리가 원하는 것은 “아래 → 위” 즉, “오래된 글 → 최신글” 순서이므로 reverse().
   */
  posts = posts.reverse();

  return { posts };
}

/**
 * 전체 실행 프로세스
 *  - groups.js의 모든 groupId를 순회하며 스크랩
 *  - 각 그룹 내 150페이지 → 1페이지까지 역순 수집
 *  - 각 글을 순차적으로 Notion에 upsert
 */
async function main() {
  console.log('🚀 BuddyPostList API → Notion 스크랩 시작 (모든 그룹)');

  for (const group of GROUPS) {
    console.log(`\n📂 그룹 [${group.name}] (ID=${group.id}) 처리 시작`);
    let total = 0;

    for (let page = MAX_PAGE; page >= 1; page--) {
      const { posts } = await fetchPagePosts(page, group.id);
      console.log(`📥 ${page}페이지 (${group.name}) 글 수: ${posts.length}`);
      total += posts.length;

      // 오래된 글부터 최신 글 순으로 업서트
      for (const post of posts) {
        try {
          await upsertPost({ ...post, group: group.name }); // ✅ 그룹 이름 전달
        } catch (err) {
          console.error(`❌ Notion 저장 오류 (${group.name}):`, err.message);
        }

        // 요청 간 약간의 딜레이 추가 (API 부하 완화)
        await new Promise((r) => setTimeout(r, 300));
      }

      // 페이지 간 간격 (1초)
      await new Promise((r) => setTimeout(r, 1000));
    }

    console.log(`✅ 그룹 [${group.name}] 처리 완료 (총 ${total}건)`);
  }

  console.log('🎉 전체 그룹 스크랩 완료!');
}

// 메인 실행
main().catch((err) => {
  console.error('❌ 스크립트 전체 오류:', err);
  process.exit(1);
});
