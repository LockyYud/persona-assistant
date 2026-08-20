import { describe, expect, it } from "vitest";
import { parseTitle } from "./conversation-title.js";

describe("parseTitle", () => {
  it("takes the title out of a well-formed reply", () => {
    expect(parseTitle('{"title":"Notion sync bug"}')).toBe("Notion sync bug");
  });

  it("strips the quotes and trailing period models add despite being told not to", () => {
    expect(parseTitle('{"title":"\\"Sửa lỗi đồng bộ\\""}')).toBe("Sửa lỗi đồng bộ");
    expect(parseTitle('{"title":"Kế hoạch tuần này."}')).toBe("Kế hoạch tuần này");
    expect(parseTitle('{"title":"“Chia nhỏ task”"}')).toBe("Chia nhỏ task");
  });

  it("returns null for anything unusable rather than storing junk", () => {
    // A null title is fine — the sidebar falls back to a placeholder.
    expect(parseTitle("not json")).toBeNull();
    expect(parseTitle("")).toBeNull();
    expect(parseTitle('{"title":""}')).toBeNull();
    expect(parseTitle('{"title":"   "}')).toBeNull();
    expect(parseTitle('{"title":42}')).toBeNull();
    expect(parseTitle('{"other":"x"}')).toBeNull();
  });

  it("caps an over-long title so it can't blow out the sidebar", () => {
    const title = parseTitle(JSON.stringify({ title: "chữ ".repeat(80) }));
    expect(title!.length).toBeLessThanOrEqual(60);
  });
});
