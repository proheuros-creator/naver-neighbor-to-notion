// BlogID/sync-blogid-from-csv.js
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");
const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const databaseId = process.env.NOTION_DATABASE_ID_BLOGID;

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
      // 👉 blogId 속성이 rich_text가 아니라 title이면 여기 title로 바꿔야 함
      rich_text: { equals: blogId }
      // title: { equals: blogId }
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

async function main() {
  const csvPathArg = process.argv[2];
  const csvPath = csvPathArg
    ? csvPathArg
    : path.join(__dirname, "..", "neighbor-followings-result.csv");

  console.log(`📄 CSV Path: ${csvPath}`);

  if (!fs.existsSync(csvPath)) {
    console.error("❌ CSV 파일을 찾을 수 없습니다.");
    process.exit(1);
  }

  const rows = [];

  await new Promise((resolve, reject) => {
    fs.createReadStream(csvPath)
      .pipe(
        parse({
          columns: true, // 첫 줄을 header로 사용
          skip_empty_lines: true
        })
      )
      .on("data", (row) => {
        rows.push(row);
      })
      .on("end", resolve)
      .on("error", reject);
  });

  console.log(`📥 Total rows from CSV: ${rows.length}`);

  let success = 0;
  let fail = 0;

  for (const row of rows) {
    try {
      await upsertBlogIdRow(row);
      success++;
    } catch (err) {
      fail++;
      console.error(
        `⚠️ Error on blogId=${row.blogId}:`,
        err.body || err.message || err
      );
    }
  }

  console.log(`✅ Done. Success: ${success}, Failed: ${fail}`);
}

main().catch((err) => {
  console.error("🚨 Fatal error:", err);
  process.exit(1);
});
