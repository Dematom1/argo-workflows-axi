import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { render } from "../src/render.js";

describe("render", () => {
  it("renders help hints as decodable TOON lists", () => {
    const output = render({
      error: "Not found",
      help: ["try wf list", "read the docs"],
    });

    expect(decode(output)).toEqual({
      error: "Not found",
      help: ["try wf list", "read the docs"],
    });
  });
});
