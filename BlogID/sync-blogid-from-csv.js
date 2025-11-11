// 🔁 blogId 기준으로 페이지 생성/갱신
async function upsertBlogIdRow(row) {
  const blogId = (row.blogId || "").trim();
  if (!blogId) return;

  // 🚫 특정 blogId 제외
  if (blogId === "GoRepresentBlog") {
    console.log(`⏭️ Skip: ${blogId}`);
    return;
  }

  const blogUrl = (row.blogUrl || "").trim();
  const nickname = (row.nickname || "").trim();
  const groupNames = (row.groupNames || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const isInfluencer =
    (row.isInfluencer || "").trim().toUpperCase() === "Y";
  const influencerId = (row.influencerId || "").trim();
  const influencerUrl = (row.influencerUrl || "").trim();

  const titleText = nickname || blogId;

  // 1️⃣ 이미 존재하는 blogId인지 확인
  const existing = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: "blogId",
      rich_text: { equals: blogId }
    }
  });

  const properties = {
    Name: {
      title: [{ text: { content: titleText } }]
    },
    blogId: {
      rich_text: [{ text: { content: blogId } }]
    },
    isInfluencer: { checkbox: isInfluencer }
  };

  if (blogUrl) properties.blogUrl = { url: blogUrl };
  if (nickname)
    properties.nickname = {
      rich_text: [{ text: { content: nickname } }]
    };
  if (groupNames.length > 0)
    properties.groupNames = {
      multi_select: groupNames.map((name) => ({ name }))
    };
  if (influencerId)
    properties.influencerId = {
      rich_text: [{ text: { content: influencerId } }]
    };
  if (influencerUrl) properties.influencerUrl = { url: influencerUrl };

  // 2️⃣ 업데이트 또는 새로 생성
  if (existing.results.length > 0) {
    const pageId = existing.results[0].id;
    console.log(`🔄 Update: ${blogId} (${titleText})`);
    await notion.pages.update({ page_id: pageId, properties });
  } else {
    console.log(`🆕 Create: ${blogId} (${titleText})`);
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties
    });
  }
}
