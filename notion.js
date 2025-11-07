import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// postId 기준 중복 체크 후 업데이트 or 새로 생성
export async function upsertPost(post) {
  const uniqueId = post.postId ? String(post.postId) : null;

  // 1️⃣ 중복 여부 확인 (UniqueID로 검색)
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

  // 2️⃣ 속성 매핑 (노션 DB 컬럼명과 동일하게 설정)
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
    '원본 날짜': post.pubdate
      ? { date: { start: post.pubdate } }
      : undefined,
    '생성 일시': { date: { start: new Date().toISOString() } },
    Category: {
      rich_text: [{ text: { content: post.category || '' } }],
    },
    Description: {
      rich_text: [{ text: { content: post.description || '' } }],
    },
    UniqueID: {
      rich_text: [{ text: { content: uniqueId || '' } }],
    },
  };

  // 3️⃣ 존재하면 업데이트, 없으면 새로 추가
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
