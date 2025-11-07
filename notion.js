import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// postId 기준 중복 체크 후 업데이트 or 새로 생성
export async function upsertPost(post) {
  const postId = post.postId ? String(post.postId) : null; // ✅ 숫자를 문자열로 변환

  // 1️⃣ 중복 여부 확인
  let existing;
  if (postId) {
    const query = await notion.databases.query({
      database_id: databaseId,
      filter: {
        property: 'postId',
        rich_text: {
          equals: postId, // ✅ 문자열로 비교
        },
      },
    });

    existing = query.results?.[0];
  }

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
    Link: {
      url: post.link || null,
    },
    Blogger: {
      rich_text: [{ text: { content: post.nickname || '' } }],
    },
    PubDate: post.pubdate
      ? { date: { start: post.pubdate } }
      : undefined,
    Description: {
      rich_text: [{ text: { content: post.description || '' } }],
    },
    Category: {
      rich_text: [{ text: { content: post.category || '' } }],
    },
    postId: {
      rich_text: [{ text: { content: postId || '' } }],
    },
  };

  // 2️⃣ 존재하면 업데이트
  if (existing) {
    await notion.pages.update({
      page_id: existing.id,
      properties,
    });
    console.log(`🔄 업데이트: ${post.title}`);
  } else {
    // 3️⃣ 없으면 새로 추가
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties,
    });
    console.log(`🆕 새 글 추가: ${post.title}`);
  }
}
