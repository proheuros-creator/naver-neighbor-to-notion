import 'dotenv/config';
import fetch from 'node-fetch';
import { upsertPost } from './notion.js';

const NAVER_COOKIE = process.env.NAVER_COOKIE;
const API_TEMPLATE = process.env.NAVER_NEIGHBOR_API_URL;
const MAX_PAGE = Number(process.env.MAX_PAGE || 150);

if (!NAVER_COOKIE) {
  console.error('❌ NAVER_COOKIE 가 설정되어 있지 않습니다.');
  process.exit(1);
}

if (!API_TEMPLATE) {
  console.error('❌ NAVER_NEIGHBOR_API_URL 이 설정되어 있지 않습니다.');
  process.exit(1);
}

// page=1 이 들어있는 BuddyPostList URL을 기반으로 page만 바꿔서 사용
function buildPageUrl(page) {
  try {
    const url = new URL(API_TEMPLATE);
    url.searchParams.set('page', String(page));
    return url.toString();
  } catch (e) {
    // 혹시 URL 생성 실패 시 대체 (단순 치환)
    return API_TEMPLATE.replace(/page=\d+/, `page=${page}`);
  }
}

// 네이버가 응답 앞에 붙이는 ")]}'," 같은 prefix 제거
function stripNaverPrefix(raw) {
  return raw.replace(/^\)\]\}',?\s*/, '');
}

// 디버깅용: JSON 파싱 실패 시 raw 앞부분만 출력
function cleanedPreview(raw) {
  const cleaned = stripNaverPrefix(raw || '');
  return cleaned.slice(0, 120) + (cleaned.length > 120 ? '...' : '');
}

async function fetchPagePosts(page) {
  const url = buildPageUrl(page);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (NaverNeighborScraper)',
      'Cookie': NAVER_COOKIE,
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://section.blog.naver.com/BlogHome.naver',
    },
  });

  if (!res.ok) {
    console.error(`❌ ${page}페이지 API 요청 실패:`, res.status, res.statusText);
    return [];
  }

  const raw = await res.text();

  let data;
  try {
    const cleaned = stripNaverPrefix(raw);
    data = JSON.parse(cleaned);
  } catch (e) {
    console.error(`❌ ${page}페이지 JSON 파싱 실패:`, e.message);
    console.error(cleanedPreview(raw));
    return [];
  }

  // BuddyPostList 구조 대응
  const result = data.result || data;
  const list =
    result.buddyPostList ||
    result.postList ||
    result.list ||
    result.items ||
    [];

  const posts = list
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
        '';

      // ✅ URL: 응답 필드 사용 + blogId/logNo 조합 fallback
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

      // ✅ Description: 어제 코드와 동일하게 여러 후보 사용
      const description =
        item.briefContents ||
        item.summary ||
        item.contentsPreview ||
        item.previewText ||
        item.contents ||
        '';

      const category =
        item.categoryName ||
        item.directoryName ||
        item.category ||
        '';

      const postId = logNo || '';

      // URL 또는 postId 없으면 스킵 (UniqueID 위해)
      if (!title || !link || !postId) return null;

      return {
        title,
        link,
        nickname,
        pubdate,
        description,
        category,
        blogId,
        postId,
      };
    })
    .filter(Boolean);

  // ✅ 페이지 내: "맨 아래 글 → 맨 위 글" 순서로 (최신 순으로 맞추기)
  return posts.reverse();
}

async function main() {
  console.log('🚀 BuddyPostList API → Notion 스크랩 시작');
  console.log(`📄 대상 페이지: ${MAX_PAGE} → 1 (내림차순, 각 페이지는 역순 수집)`);

  let total = 0;

  // 🔽 MAX_PAGE부터 1까지 역순 스크랩
  for (let page = MAX_PAGE; page >= 1; page--) {
    const posts = await fetchPagePosts(page);
    console.log(`📥 ${page}페이지에서 가져온 글 수: ${posts.length}`);
    total += posts.length;

    for (const post of posts) {
      try {
        await upsertPost(post);
      } catch (err) {
        console.error('❌ Notion 저장 오류:', err.message);
      }

      // Notion API 부하 완화 (글당 0.3s)
      await new Promise((r) => setTimeout(r, 300));
    }

    // 페이지 간 1초 대기
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`✅ 전체 스크랩 완료. 총 ${total}건 처리 시도.`);
}

main().catch((err) => {
  console.error('❌ 스크립트 전체 오류:', err);
  process.exit(1);
});
