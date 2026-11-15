import { describe, expect, it } from "vitest";
import { teammateAddressedRefusal, teammateNamedIn } from "./user-chat-send-gate.js";

const teammates = [
  { id: "cm3xk9bot0001servo", name: "Servo" },
  { id: "cm3xk9bot0002ops", name: "运维值班" },
  { id: "cm3xk9bot0003long", name: "Ops Bot" },
  { id: "cm3xk9bot0004one", name: "艾" },
];

describe("teammateNamedIn", () => {
  it("finds a teammate named anywhere in the text, whatever its width or spacing", () => {
    for (const text of [
      "Servo：清理一下日志",
      "[to Servo] run the migration",
      "@servo 请把 staging 重跑一遍",
      "请 S e r v o 处理这条",
      "让运维值班看一下",
      "交给运 维 值 班",
    ]) {
      expect(teammateNamedIn(text, teammates)?.name).toBeTruthy();
    }
    expect(teammateNamedIn("请 SERVO 处理这条", teammates)?.id).toBe("cm3xk9bot0001servo");
  });

  it("finds a teammate by the id a message carries", () => {
    expect(teammateNamedIn("send to cm3xk9bot0002ops please", teammates)).toEqual({
      id: "cm3xk9bot0002ops",
      name: "运维值班",
    });
  });

  it("prefers the longest matching name", () => {
    expect(teammateNamedIn("Ops Bot takes this", teammates)?.id).toBe("cm3xk9bot0003long");
  });

  it("leaves ordinary progress alone", () => {
    for (const text of [
      "Reading march.csv",
      "CI is green, deploying the staging build",
      "还在跑测试，稍等",
      "",
    ]) {
      expect(teammateNamedIn(text, teammates)).toBeUndefined();
    }
  });

  it("does not match on a name too short to mean a bot", () => {
    expect(teammateNamedIn("艾特一下", teammates)).toBeUndefined();
    expect(teammateNamedIn("nothing here", [])).toBeUndefined();
  });
});

describe("teammateAddressedRefusal", () => {
  const error = teammateAddressedRefusal({ id: "cm3xk9bot0001servo", name: "Servo" });

  it("says nothing was sent and names the route that reaches the bot", () => {
    expect(error).toContain("Nothing was sent");
    expect(error).toContain("Servo");
    expect(error).toContain("cm3xk9bot0001servo");
    expect(error).toContain("message_bot");
    expect(error).toContain("relay_to_bots");
    // The same turn, not a later one.
    expect(error).toContain("now");
    expect(error).toContain("do not leave it for a later turn");
  });

  it("offers no route through the user", () => {
    // The old receipt said "put the content in your final reply"; that sentence is how a
    // teammate's instruction ended up in the user's chat.
    expect(error).not.toMatch(/final reply/i);
    expect(error).not.toMatch(/next turn/i);
    expect(error).toContain("Do not reword it for the user");
  });
});
