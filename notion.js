import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// 네이버 pubdate 값을 Notion이 이해할 수 있는 문자열로 변환
function normalizeNaverDate(raw) {
  if (!raw) return null;

  if (typeof raw === 'number') {
    return new Date(raw).toISOString();
  }

  const s = String(raw).trim();

  if (/^\d{13}$/.test(s)) {
    return new Date(Number(s)).toISOString();
  }

  if (/^\d{10}$/.test(s)) {
    return new Date(Number(s) * 1000).toISOString();
  }

  const replaced = s
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace('년', '-')
    .replace('월', '-')
    .replace('일', '')
    .trim();

  const d = new Date(replaced);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }

  return null;
}

export async function upsertPost(post) {
  const uniqueId = post.postId ? String(post.postId) : null;
  const blogId = post.blogId ? String(post.blogId) : '';

  // UniqueID 기준 중복 체크
  let existing;
  if (uniqueId) {
    const query = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'UniqueID',
        rich_text: {
          equals: uniqueId,
        },
      },
    });

    existing = query.results?.[0];
  }

  const originalDate = normalizeNaverDate(post.pubdate);
  const createdAt = new Date().toISOString();

  const properties = {
    Title: {
      title: [
        {
          text: {
            content: post.title || '(제목 없음)',
          },
        },
      ],
    },
    URL: {
      url: post.link || null,
    },
    Nickname: {
      rich_text: [{ text: { content: post.nickname || '' } }],
    },
    ...(originalDate
      ? {
          '원본 날짜': {
            date: { start: originalDate },
          },
        }
      : {}),
    '생성 일시': {
      date: { start: createdAt },
    },
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
    UniqueID: {
      rich_text: [{ text: { content: uniqueId || '' } }],
    },
    // ✅ blogId를 id 열(text)에 기록
    id: {
      rich_text: [{ text: { content: blogId } }],
    },
  };

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
