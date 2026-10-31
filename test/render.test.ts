import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import { render } from "../src/render.js";

describe("render", () => {
  it("encodes string data as decodable TOON", () => {
    const output = render("line, with data\nnext line");

    expect(decode(output)).toEqual({ output: "line, with data\nnext line" });
  });

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
