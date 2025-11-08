/**
 * notion.js
 * ──────────────────────────────────────
 * 네이버 이웃새글 스크랩 데이터를 Notion DB에 저장/업데이트하는 모듈
 * 
 * ✅ 주요 기능:
 *  - blogId + postId 조합으로 중복 체크
 *  - 없으면 새 페이지 생성 / 있으면 업데이트
 *  - 원본 날짜 → 연도, 연월, 분기 자동 계산
 *  - description, category, nickname 등 포함
 * 
 * ⚙️ 필요한 환경변수:
 *  - NOTION_API_KEY
 *  - NOTION_DATABASE_ID
 */

import { Client } from '@notionhq/client';

// Notion API 클라이언트 초기화
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

/**
 * 📅 pubDate(예: 2025-11-09 07:30:00) → ISO 8601 형식으로 변환
 */
function normalizeNaverDate(pubDate) {
  if (!pubDate) return null;
  try {
    const date = new Date(pubDate);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
  } catch {
    return null;
  }
}

/**
 * 🧭 연도/연월/분기 추출 함수
 */
function extractYearMonthQuarter(isoString) {
  if (!isoString) return {};
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return {};

  const year = String(d.getFullYear());
  const month = d.getMonth() + 1;
  const mm = String(month).padStart(2, '0');
  const yearMonth = `${year}-${mm}`;

  const quarter =
    month <= 3 ? `${year}-Q1`
      : month <= 6 ? `${year}-Q2`
      : month <= 9 ? `${year}-Q3`
      : `${year}-Q4`;

  return { year, yearMonth, quarter };
}

/**
 * 🔁 기존 글 중복 체크용: blogId + postId 조합
 */
async function findExistingPage(blogId, postId) {
  if (!blogId || !postId) return null;

  const compositeId = `${blogId}_${postId}`;

  const query = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: 'UniqueID',
      rich_text: { equals: compositeId },
    },
  });

  return query.results?.[0] || null;
}

/**
 * 🧱 Notion에 글 생성/업데이트
 */
export async function upsertPost(post) {
  // 고유 식별자 조합
  const blogId = post.blogId ? String(post.blogId) : '';
  const postId = post.postId ? String(post.postId) : '';
  const uniqueKey = `${blogId}_${postId}`;

  // 중복 확인
  const existing = await findExistingPage(blogId, postId);

  // 날짜 변환
  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  // ✅ Notion property 매핑
  const properties = {
    Title: {
      title: [{ text: { content: post.title || '(제목 없음)' } }],
    },
    URL: { url: post.link || null },
    Nickname: {
      rich_text: [{ text: { content: post.nickname || '' } }],
    },
    ...(originalDate && { '원본 날짜': { date: { start: originalDate } } }),
    '생성 일시': { date: { start: createdAt } },
    Category: {
      rich_text: [{ text: { content: post.category || '' } }],
    },
    Description: {
      rich_text: [
        {
          text: {
            content: (post.description || '').slice(0, 1800),
          },
        },
      ],
    },
    // ✅ UniqueID: blogId + postId 조합
    UniqueID: {
      rich_text: [{ text: { content: uniqueKey } }],
    },
    // ✅ Blog ID (텍스트)
    ID: {
      rich_text: [{ text: { content: blogId } }],
    },
    ...(year && { 연도: { rich_text: [{ text: { content: year } }] } }),
    ...(yearMonth && {
      연월: { rich_text: [{ text: { content: yearMonth } }] },
    }),
    ...(quarter && {
      분기: { rich_text: [{ text: { content: quarter } }] },
    }),
  };

  // 🔄 업데이트 or 🆕 새로 생성
  if (existing) {
    await notion.pages.update({
      page_id: existing.id,
      properties,
    });
    console.log(`🔄 업데이트: ${post.title}`);
  } else {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
