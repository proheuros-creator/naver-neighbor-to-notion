// BlogID/sync-blogid-from-csv.js
const fs = require("fs");
const path = require("path");
const { Client } = require("@notionhq/client");
const { parse } = require("csv-parse/sync");

// CSV 경로 처리
const csvPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../neighbor-followings-result.csv");

if (!fs.existsSync(csvPath)) {
  console.error(`❌ CSV not found at ${csvPath}`);
  process.exit(1);
}

console.log(`✅ CSV found at ${csvPath}`);

// ✅ 환경 변수
const notionToken = process.env.NOTION_API_KEY;
const databaseId = process.env.NOTION_DATABASE_ID_BLOGID;

if (!notionToken) {
  console.error("❌ NOTION_API_KEY is not set");
  process.exit(1);
}
if (!databaseId) {
  console.error("❌ NOTION_DATABASE_ID_BLOGID is not set");
  process.exit(1);
}

const notion = new Client({ auth: notionToken });

// 🔁 blogId 기준으로 페이지 생성/갱신
async function upsertBlogIdRow(row) {
  const blogId = (row.blogId || "").trim();
  if (!blogId) return;

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

// 🔰 실행
async function main() {
  const csvText = fs.readFileSync(csvPath, "utf8");
  const records = parse(csvText, { columns: true, skip_empty_lines: true });

  console.log(`📄 ${records.length} rows loaded from CSV`);

  for (const row of records) {
    try {
      await upsertBlogIdRow(row);
    } catch (e) {
      console.error(`⚠️ Failed to sync ${row.blogId}: ${e.message}`);
    }
  }

  console.log("✅ BlogID DB sync complete");
}

main().catch((e) => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
