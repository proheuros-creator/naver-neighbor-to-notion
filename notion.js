export async function upsertPost(post) {
  const uniqueId = post.postId ? String(post.postId) : null;
  const blogId = post.blogId ? String(post.blogId) : '';

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
  const { year, yearMonth, quarter } = extractYearMonthQuarter(originalDate);

  const properties = {
    Title: {
      title: [{ text: { content: post.title || '(제목 없음)' } }],
    },
    URL: {
      url: post.link || null,
    },
    Nickname: {
      rich_text: [{ text: { content: post.nickname || '' } }],
    },
    ...(originalDate
      ? { '원본 날짜': { date: { start: originalDate } } }
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
    // ✅ blogId -> ID 컬럼
    ID: {
      rich_text: [{ text: { content: blogId } }],
    },
    ...(year && {
      연도: { rich_text: [{ text: { content: year } }] },
    }),
    ...(yearMonth && {
      연월: { rich_text: [{ text: { content: yearMonth } }] },
    }),
    ...(quarter && {
      분기: { rich_text: [{ text: { content: quarter } }] },
    }),
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
