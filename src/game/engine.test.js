import test from "node:test";
import assert from "node:assert/strict";
import {
  createRoomState,
  makePlayer,
  resolveRound,
} from "./engine.js";

function twoPlayerRoom(modeId = "classic") {
  const room = createRoomState({
    host: { uid: "pilot-a", name: "A" },
    modeId,
  });
  room.players["pilot-b"] = makePlayer("pilot-b", "B", 1, modeId);
  room.players["pilot-a"].x = 2;
  room.players["pilot-a"].y = 1;
  room.players["pilot-b"].x = 3;
  room.players["pilot-b"].y = 1;
  room.status = "playing";
  room.plans = {
    "pilot-a": { move: { x: 2, y: 1 }, targetId: "pilot-b", weaponId: "pulse" },
    "pilot-b": { move: { x: 3, y: 1 }, targetId: "pilot-a", weaponId: "pulse" },
  };
  return room;
}

test("resolves both attacks in the same round", () => {
  const room = resolveRound(twoPlayerRoom());

  assert.equal(room.players["pilot-a"].hp, 78);
  assert.equal(room.players["pilot-b"].hp, 78);
  assert.equal(room.round, 2);
  assert.deepEqual(room.plans, {});
});

test("storm warns one round before shrinking and damages exposed pilots", () => {
  const room = twoPlayerRoom("storm");
  room.round = 2;
  room.players["pilot-a"].x = 0;
  room.players["pilot-a"].y = 0;
  room.players["pilot-b"].x = 3;
  room.players["pilot-b"].y = 1;
  room.plans = {
    "pilot-a": { move: { x: 0, y: 0 }, targetId: "pilot-b", weaponId: "pulse" },
    "pilot-b": { move: { x: 3, y: 1 }, targetId: "pilot-a", weaponId: "pulse" },
  };

  resolveRound(room);
  assert.equal(room.stormWarningRadius, 3);

  room.plans = {
    "pilot-a": { move: { x: 0, y: 0 }, targetId: "pilot-b", weaponId: "pulse" },
    "pilot-b": { move: { x: 3, y: 1 }, targetId: "pilot-a", weaponId: "pulse" },
  };
  resolveRound(room);

  assert.equal(room.stormRadius, 3);
  assert.equal(room.stormWarningRadius, null);
  assert.equal(room.players["pilot-a"].hp, 38);
});

test("team mode prevents friendly fire", () => {
  const room = twoPlayerRoom("teams");
  room.players["pilot-b"].team = room.players["pilot-a"].team;
  resolveRound(room);

  assert.equal(room.players["pilot-a"].hp, 100);
  assert.equal(room.players["pilot-b"].hp, 100);
});
