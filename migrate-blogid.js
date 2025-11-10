// ... (위쪽 코드는 지금 쓰는 버전 그대로 두고)

// 🚀 메인 마이그레이션
async function migrate() {
  console.log(
    `🚀 BlogID → ID + 연도/연월/분기 마이그레이션 시작` +
      (MIGRATE_LIMIT
        ? ` (이번 실행 최대 ${MIGRATE_LIMIT}건 업데이트)`
        : " (업데이트 건수 제한 없음)")
  );

  let cursor = undefined;
  let scanned = 0;
  let updatedPages = 0;
  let updatedBlogId = 0;
  let updatedYear = 0;
  let updatedYearMonth = 0;
  let updatedQuarter = 0;

  // 👉 첫 호출 전에 로그 추가 (여기서 멈추는지 확인용)
  console.log("🔍 첫 batch 조회 시작 (databases.query)...");

  mainLoop: while (true) {
    const resp = await safeQuery(
      {
        database_id: databaseId,
        start_cursor: cursor,
        page_size: 50,
      },
      "databases.query"
    );

    if (!resp) {
      console.error(
        "⏹ 연속 쿼리 오류로 인해 마이그레이션을 종료합니다. (safeQuery에서 null 반환)"
      );
      break;
    }

    console.log(
      `📥 batch 수신: ${resp.results.length}개, has_more=${resp.has_more}`
    );

    if (resp.results.length === 0 && !resp.has_more) {
      break;
    }

    for (const page of resp.results) {
      scanned++;
      const props = page.properties;
      const updates = {};

      // 1) BlogID formula → ID text
      if (props[FORMULA_PROP_NAME] && props[TEXT_PROP_NAME]) {
        const formulaValue = extractFormulaValue(props[FORMULA_PROP_NAME]);
        const textProp = props[TEXT_PROP_NAME];
        const hasText =
          textProp.type === "rich_text" &&
          textProp.rich_text.length > 0;

        if (formulaValue && !hasText) {
          updates[TEXT_PROP_NAME] = {
            rich_text: [{ text: { content: formulaValue } }],
          };
          updatedBlogId++;
        }
      }

      // 2) 원본 날짜 → 연도/연월/분기
      const { year, yearMonth, quarter } = extractYyYmQ(props[DATE_PROP_NAME]);

      if (year && props[YEAR_PROP_NAME]) {
        const p = props[YEAR_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[YEAR_PROP_NAME] = {
            rich_text: [{ text: { content: year } }],
          };
          updatedYear++;
        }
      }

      if (yearMonth && props[YEARMONTH_PROP_NAME]) {
        const p = props[YEARMONTH_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[YEARMONTH_PROP_NAME] = {
            rich_text: [{ text: { content: yearMonth } }],
          };
          updatedYearMonth++;
        }
      }

      if (quarter && props[QUARTER_PROP_NAME]) {
        const p = props[QUARTER_PROP_NAME];
        const has =
          p.type === "rich_text" && p.rich_text.length > 0;
        if (!has) {
          updates[QUARTER_PROP_NAME] = {
            rich_text: [{ text: { content: quarter } }],
          };
          updatedQuarter++;
        }
      }

      // 업데이트할 내용 없으면 skip
      if (Object.keys(updates).length === 0) {
        continue;
      }

      // MIGRATE_LIMIT 체크
      if (MIGRATE_LIMIT && updatedPages >= MIGRATE_LIMIT) {
        console.log(
          `
