import { modeById } from "./modes/index.js";

export const BOARD_SIZE = 9;
export const MAX_PLAYERS = 8;

export const weapons = [
  { id: "pulse", name: "Pulso", damage: 22, range: 5, label: "PULSO" },
  { id: "scatter", name: "Dispersor", damage: 34, range: 2, label: "DISPERSOR" },
  { id: "rail", name: "Riel", damage: 16, range: 8, label: "RIEL" },
];

const spawns = [
  { x: 1, y: 1 },
  { x: 7, y: 7 },
  { x: 7, y: 1 },
  { x: 1, y: 7 },
  { x: 4, y: 1 },
  { x: 4, y: 7 },
  { x: 1, y: 4 },
  { x: 7, y: 4 },
];

export function makePlayer(uid, name, index, modeId = "classic") {
  const spawn = spawns[index % spawns.length];
  const teamsMode = modeById[modeId]?.teamPlay;

  return {
    uid,
    name,
    x: spawn.x,
    y: spawn.y,
    hp: 100,
    score: 0,
    alive: true,
    ready: false,
    team: teamsMode ? (index % 2 === 0 ? "A" : "B") : null,
    admiral: modeId === "admiral" && index < 2,
  };
}

export function createRoomState({ host, modeId }) {
  return {
    status: "lobby",
    modeId,
    hostId: host.uid,
    round: 1,
    players: { [host.uid]: makePlayer(host.uid, host.name, 0, modeId) },
    plans: {},
    logs: [`Sala creada por ${host.name}.`],
    stormRadius: 4,
    stormWarningRadius: null,
    bossHp: modeId === "boss" ? 280 : null,
    chaosEffect: null,
    winner: null,
    createdAt: Date.now(),
  };
}

export function canJoinRoom(room, uid) {
  if (!room || room.status !== "lobby" || room.players?.[uid]) return false;
  return Object.keys(room.players ?? {}).length < MAX_PLAYERS;
}

export function nextPlayer(room, uid, name) {
  if (!canJoinRoom(room, uid)) return room;
  const index = Object.keys(room.players ?? {}).length;
  room.players ??= {};
  room.players[uid] = makePlayer(uid, name, index, room.modeId);
  room.logs = [...(room.logs ?? []), `${name} se unió a la sala.`].slice(-30);
  return room;
}

export function canStart(room, uid) {
  const players = Object.values(room?.players ?? {});
  return (
    room?.status === "lobby" &&
    room.hostId === uid &&
    players.length >= 2 &&
    players.every((player) => player.uid === uid || player.ready)
  );
}

export function startGame(room) {
  room.status = "playing";
  room.round = 1;
  room.plans = {};
  room.logs = [...(room.logs ?? []), "La partida comenzó. ¡A la arena!"].slice(-30);
  return room;
}

export function validPlan(plan, player) {
  if (!plan || !player || !player.alive) return false;
  const moved = plan.move;
  if (
    !moved ||
    !Number.isInteger(moved.x) ||
    !Number.isInteger(moved.y) ||
    moved.x < 0 ||
    moved.y < 0 ||
    moved.x >= BOARD_SIZE ||
    moved.y >= BOARD_SIZE ||
    Math.abs(moved.x - player.x) + Math.abs(moved.y - player.y) > 1
  ) return false;
  return weapons.some((weapon) => weapon.id === plan.weaponId);
}

export function resolveRound(room) {
  if (room.status !== "playing") return room;

  const mode = modeById[room.modeId] ?? modeById.classic;
  const players = room.players ?? {};
  const alive = Object.values(players).filter((player) => player.alive);
  const submittedPlans = room.plans ?? {};

  for (const player of alive) {
    const plan = submittedPlans[player.uid];
    if (validPlan(plan, player)) {
      player.x = plan.move.x;
      player.y = plan.move.y;
    }
  }

  const damage = {};
  const events = [];
  for (const player of alive) {
    const plan = submittedPlans[player.uid];
    const weapon = weapons.find((item) => item.id === plan?.weaponId);
    if (!weapon || !validPlan(plan, player)) continue;

    if (mode.boss) {
      if (distance(player, { x: 4, y: 4 }) <= weapon.range) {
        room.bossHp = Math.max(0, room.bossHp - weapon.damage);
        player.score += weapon.damage;
        events.push(`${player.name} golpeó al jefe (${weapon.damage}).`);
      } else {
        events.push(`${player.name} falló el ataque al jefe.`);
      }
      continue;
    }

    const target = players[plan.targetId];
    if (
      !target ||
      !target.alive ||
      target.uid === player.uid ||
      (mode.teamPlay && target.team === player.team) ||
      distance(player, target) > weapon.range
    ) {
      events.push(`${player.name} no encontró un objetivo válido.`);
      continue;
    }

    const bonus = mode.chaos && room.chaosEffect === "potencia" ? 10 : 0;
    damage[target.uid] = (damage[target.uid] ?? 0) + weapon.damage + bonus;
    events.push(`${player.name} alcanzó a ${target.name}.`);
    player.score += mode.points || mode.treasure ? 10 : 0;
  }

  for (const [uid, amount] of Object.entries(damage)) {
    const player = players[uid];
    player.hp = Math.max(0, player.hp - amount);
    if (player.hp === 0) {
      player.alive = false;
      events.push(`${player.name} quedó fuera.`);
      if (mode.revenge) {
        const attackers = alive.filter((attacker) => submittedPlans[attacker.uid]?.targetId === uid);
        for (const attacker of attackers) attacker.score += 25;
      }
    }
  }

  if (mode.treasure && room.treasure) {
    for (const player of alive) {
      if (player.alive && player.x === room.treasure.x && player.y === room.treasure.y) {
        player.score += 30;
        room.treasure = randomTreasure();
        events.push(`${player.name} encontró un alijo.`);
        break;
      }
    }
  }

  room.round += 1;
  room.plans = {};
  if (mode.storm && room.round % 3 === 0 && room.stormRadius > 1) {
    room.stormWarningRadius = room.stormRadius - 1;
    events.push("La tormenta se acerca: el anillo exterior está en alerta.");
  } else if (mode.storm && room.stormWarningRadius !== null) {
    room.stormRadius = room.stormWarningRadius;
    room.stormWarningRadius = null;
    events.push("La zona segura se ha reducido.");
  }

  if (mode.storm && room.stormRadius < 4) {
    for (const player of Object.values(players)) {
      if (player.alive && outsideStorm(player, room.stormRadius)) {
        player.hp = Math.max(0, player.hp - 18);
        events.push(`La tormenta alcanzó a ${player.name}.`);
        if (player.hp === 0) player.alive = false;
      }
    }
  }

  if (mode.chaos) {
    room.chaosEffect = ["potencia", "niebla", "calma"][room.round % 3];
  }
  if (mode.treasure && !room.treasure) room.treasure = randomTreasure();

  room.logs = [...(room.logs ?? []), ...events].slice(-30);
  const winner = findWinner(room, mode);
  if (winner) {
    room.status = "finished";
    room.winner = winner;
    room.logs = [...room.logs, winner === "draw" ? "La partida terminó en empate." : `${players[winner]?.name ?? "El equipo"} ganó la partida.`].slice(-30);
  }
  return room;
}

export function distance(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function outsideStorm(player, radius) {
  return Math.max(Math.abs(player.x - 4), Math.abs(player.y - 4)) > radius;
}

function findWinner(room, mode) {
  const alive = Object.values(room.players).filter((player) => player.alive);
  if (mode.boss && room.bossHp === 0) return room.hostId;
  if (mode.boss && room.round > mode.roundLimit && room.bossHp > 0) return "draw";
  if (mode.points || mode.roundLimit && room.round > mode.roundLimit) {
    if (alive.length <= 1 || room.round > (mode.roundLimit ?? 10)) {
      return Object.values(room.players)
        .sort((a, b) => b.score - a.score)[0]?.uid ?? "draw";
    }
    return null;
  }
  if (mode.teamPlay && alive.length) {
    const teams = new Set(alive.map((player) => player.team));
    if (teams.size === 1) return alive[0].team;
  }
  if (!mode.teamPlay && alive.length === 1) return alive[0].uid;
  if (alive.length === 0) return "draw";
  return null;
}

function randomTreasure() {
  return { x: Math.floor(Math.random() * BOARD_SIZE), y: Math.floor(Math.random() * BOARD_SIZE) };
}
